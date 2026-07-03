# Production deploy runbook — Hetzner single-node Swarm (BE-006)

Target: one Hetzner Cloud server (Ubuntu 24.04, ≥4 vCPU / 8 GB), Docker Swarm
single-node, Caddy auto-TLS, images from GHCR. Database runs **outside** the
Swarm stack on a dedicated volume (ADR-006 rev.).

## 1. Provision the server

```bash
# As root on a fresh Hetzner instance
curl -fsSL https://get.docker.com | sh
docker swarm init

# Non-root deploy user
adduser --disabled-password deploy
usermod -aG docker deploy
mkdir -p /home/deploy/.ssh && cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh

# Firewall: SSH + HTTP(S) only; DB port never public
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
```

DNS: point `A` records for `<domain>` and `api.<domain>` at the server IP
before first deploy (Caddy needs them to issue certificates).

## 2. Attach the database volume

Create a Hetzner Volume (≥50 GB) in the console, attach it, then:

```bash
mkfs.ext4 /dev/disk/by-id/scsi-0HC_Volume_<id>     # first time only
mkdir -p /mnt/fx-db
echo "/dev/disk/by-id/scsi-0HC_Volume_<id> /mnt/fx-db ext4 discard,nofail,defaults 0 0" >> /etc/fstab
mount -a
```

## 3. Run the database — outside the stack (ADR-006 rev.)

Same image as dev (`infra/docker-compose.local.yml`), own lifecycle, dedicated
volume, published only on the private Docker bridge — never on a public port:

```bash
docker network create --driver bridge fx-db-net 2>/dev/null || true

docker run -d --name fx-db \
  --restart unless-stopped \
  --network fx-db-net \
  -v /mnt/fx-db:/home/postgres/pgdata/data \
  -v ~/fx-deploy/infra/db/init:/docker-entrypoint-initdb.d:ro \
  -e POSTGRES_USER=fx \
  -e POSTGRES_PASSWORD='<strong-password>' \
  -e POSTGRES_DB=fx \
  -p 127.0.0.1:5432:5432 \
  timescale/timescaledb-ha:pg18-ts2.28
```

The stack reaches it via the host gateway: use
`DATABASE_URL=postgresql://fx:<password>@172.17.0.1:5432/fx` (or the
`fx-db-net` gateway IP — check with `docker network inspect fx-db-net`).
Upgrading/restarting the DB never touches the app stack, and vice versa.
Backups (restic, RPO <1h) arrive with BE-142.

## 4. Server-side deploy config

```bash
mkdir -p /etc/fx
cat > /etc/fx/deploy.env <<'EOF'
REGISTRY=ghcr.io/<github-owner-lowercase>
DOMAIN=example.com
ACME_EMAIL=you@example.com
DATABASE_URL=postgresql://fx:<strong-password>@172.17.0.1:5432/fx
TRADING_MODE=paper
LOG_LEVEL=info
EOF
chmod 600 /etc/fx/deploy.env

# GHCR pull auth (PAT with read:packages)
docker login ghcr.io -u <github-user>
```

## 5. GitHub secrets (for `.github/workflows/deploy.yml`)

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | server IP or hostname |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_SSH_KEY` | private key whose public half is in `deploy`'s `authorized_keys` |

Optionally create a `production` GitHub Environment with required reviewers to
gate deploys.

## 6. Deploy

CI (BE-005) publishes `fx-node-api`, `fx-dashboard`, `fx-quant` images tagged
with the commit SHA on every merge to main. Then either:

- **From GitHub:** Actions → Deploy → Run workflow (optionally pin a tag), or
- **On the server:**

```bash
cd ~/fx-deploy && TAG=<git-sha> bash infra/deploy/deploy.sh
```

The script runs `docker stack deploy`, waits for every service update to
converge (start-first ⇒ old task keeps serving until the new one is healthy),
fails the deploy if Swarm rolled back, and smoke-checks
`https://api.<domain>/healthz`.

## 7. Rollback

Automatic: a task that never turns healthy triggers `failure_action: rollback`.
Manual: redeploy the previous SHA — `TAG=<previous-sha> bash infra/deploy/deploy.sh`
— or `docker service rollback fx_api` for a single service.

## 8. Verify

```bash
docker stack services fx          # replicas 1/1 everywhere
docker service ps fx_api          # no restart loops
curl -s https://api.<domain>/healthz | jq   # status ok, commit = deployed SHA
```

TLS is valid automatically via Caddy/Let's Encrypt once DNS resolves.
