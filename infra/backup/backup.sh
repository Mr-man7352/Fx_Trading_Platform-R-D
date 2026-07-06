#!/usr/bin/env bash
# BE-142 — Postgres → restic → S3-compatible storage.
#
# Dumps the self-hosted TimescaleDB instance (pg_dump custom format — includes
# hypertables, CAGG definitions, and pgvector data) and streams it into a
# restic repository. Designed to run from cron/systemd on the DB host (the DB
# runs OUTSIDE the Swarm stack on its own volume — ADR-006 rev.).
#
# Schedule (see BACKUP.md): nightly full at 02:15 UTC + hourly runs during
# trading hours. restic dedups at the chunk level, so hourly runs are cheap and
# give the RPO <1h the restore drill verifies.
#
# Required env (typically /etc/fx/backup.env, mode 0600):
#   DATABASE_URL            postgresql://user:pass@host:5432/fx
#   RESTIC_REPOSITORY       e.g. s3:https://<endpoint>/<bucket>/fx-db
#   RESTIC_PASSWORD         repository encryption password (NOT the DB password)
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   S3-compatible credentials
# Optional:
#   BACKUP_TAG              extra snapshot tag (default: nightly)
#   HEALTHCHECK_URL         ping URL (healthchecks.io) hit on success/failure
#   KEEP_HOURLY/DAILY/WEEKLY/MONTHLY   retention overrides (see defaults below)
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD is required}"

TAG="${BACKUP_TAG:-nightly}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
HOST_TAG="$(hostname -s)"

fail() {
  echo "[backup] FAILED: $1" >&2
  [[ -n "${HEALTHCHECK_URL:-}" ]] && curl -fsS -m 10 "${HEALTHCHECK_URL}/fail" >/dev/null || true
  exit 1
}

# Init the repo on first run (no-op if it exists).
restic snapshots >/dev/null 2>&1 || restic init || fail "restic init"

echo "[backup] ${STAMP} — pg_dump → restic (${TAG})"
# Custom-format dump via stdin: restic stores it as fx-${STAMP}.dump.
# --no-password: creds come from DATABASE_URL. Compression handled by pg_dump -Z.
pg_dump --dbname="${DATABASE_URL}" --format=custom --compress=6 --no-password \
  | restic backup --stdin --stdin-filename "fx-db/fx.dump" \
      --tag "${TAG}" --tag "pg" --tag "${HOST_TAG}" \
  || fail "pg_dump | restic backup"

# Retention (BE-142): hourly ring for RPO, nightly ring for history.
restic forget --prune \
  --keep-hourly "${KEEP_HOURLY:-48}" \
  --keep-daily "${KEEP_DAILY:-14}" \
  --keep-weekly "${KEEP_WEEKLY:-8}" \
  --keep-monthly "${KEEP_MONTHLY:-6}" \
  || fail "restic forget --prune"

# Verify repo integrity on the nightly run only (cheap metadata check).
if [[ "${TAG}" == "nightly" ]]; then
  restic check --read-data-subset=5% || fail "restic check"
fi

echo "[backup] OK — snapshot stored, retention applied"
[[ -n "${HEALTHCHECK_URL:-}" ]] && curl -fsS -m 10 "${HEALTHCHECK_URL}" >/dev/null || true
