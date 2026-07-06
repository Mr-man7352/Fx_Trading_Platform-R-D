# BE-142 — Backups & restore drill (restic)

Off-platform backups of the self-hosted TimescaleDB instance (which runs on a
dedicated Hetzner volume, OUTSIDE the application Swarm stack — ADR-006 rev.),
plus a weekly automated restore drill that proves RPO/RTO.

**SLA (verified by the drill, logged to `drill-log.md`):**

| Objective | Target | How it is met |
|---|---|---|
| RPO | < 1 h | hourly `backup.sh` runs during trading hours (restic dedup makes them cheap) |
| RTO | < 4 h | weekly drill restores latest snapshot into a scratch container and times it |

## Components

- `backup.sh` — `pg_dump -Fc` streamed into `restic backup --stdin` → S3-compatible
  storage; applies retention (`--keep-hourly 48 --keep-daily 14 --keep-weekly 8
  --keep-monthly 6`) and runs `restic check --read-data-subset=5%` nightly.
- `restore-drill.sh` — restores `latest` into a throwaway
  `timescale/timescaledb-ha:pg18-ts2.28` container, verifies **hypertables,
  continuous aggregates, and pgvector**, measures RPO/RTO, appends to
  `drill-log.md`.

## Host setup (DB host)

```sh
apt-get install -y restic postgresql-client   # pg_dump 18 client
install -m 0600 /dev/null /etc/fx/backup.env  # then fill in:
```

`/etc/fx/backup.env`:

```sh
DATABASE_URL=postgresql://fx:<password>@127.0.0.1:5432/fx
RESTIC_REPOSITORY=s3:https://<endpoint>/<bucket>/fx-db
RESTIC_PASSWORD=<generate: openssl rand -base64 32 — store in password manager;
                 losing it makes ALL snapshots unrecoverable>
AWS_ACCESS_KEY_ID=<s3 key>
AWS_SECRET_ACCESS_KEY=<s3 secret>
# HEALTHCHECK_URL=https://hc-ping.com/<uuid>   # optional dead-man switch
```

Cron (`crontab -u postgres -e` or a root crontab):

```cron
# nightly full (02:15 UTC) — also prunes + integrity-checks
15 2 * * *  . /etc/fx/backup.env && BACKUP_TAG=nightly /opt/fx/infra/backup/backup.sh >> /var/log/fx-backup.log 2>&1
# hourly during the FX week (Sun 21:00 UTC – Fri 22:00 UTC) → RPO <1h
0 * * * 1-5 . /etc/fx/backup.env && BACKUP_TAG=hourly  /opt/fx/infra/backup/backup.sh >> /var/log/fx-backup.log 2>&1
0 21-23 * * 0 . /etc/fx/backup.env && BACKUP_TAG=hourly /opt/fx/infra/backup/backup.sh >> /var/log/fx-backup.log 2>&1
# weekly restore drill (Sat 03:00 UTC — market closed)
0 3 * * 6   . /etc/fx/backup.env && /opt/fx/infra/backup/restore-drill.sh >> /var/log/fx-drill.log 2>&1
```

## Manual restore (disaster recovery)

```sh
. /etc/fx/backup.env
restic snapshots                        # pick a snapshot (default: latest)
restic restore latest --target /tmp/restore --include /fx-db/fx.dump
pg_restore --dbname="$DATABASE_URL" --clean --if-exists --no-owner /tmp/restore/fx-db/fx.dump
psql "$DATABASE_URL" -f /opt/fx/apis/node-api/prisma/timescale.sql   # idempotent re-apply
```

Note: `pg_dump` captures hypertable data and CAGG definitions; re-applying
`timescale.sql` afterwards is safe (idempotent) and restores any policy jobs
(compression/retention/refresh) the dump could not carry.

## Drill log

`drill-log.md` is append-only; each run adds
`| timestamp | status | rpo_seconds | rto_seconds | detail |`. Review it in the
weekly ops check; two consecutive `FAIL`/`WARN-RPO` rows are an incident.
