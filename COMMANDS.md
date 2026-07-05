# COMMANDS — daily driver reference

All commands run from the repo root unless noted. Ports: dashboard `:3000`,
API `:4000`, quant `:5000`, Postgres `:5432`, Redis `:6379`.

## One-time setup

```bash
corepack enable            # activates pnpm 9 (pinned in package.json)
pnpm install               # install all workspace dependencies
cp .env.example .env       # create local env file, then fill in values
open -a Docker             # start Docker Desktop (needed for the stack)
```

## Start / stop — local dev (fastest loop, no Docker)

Runs processes directly on your machine with hot reload. Use this while coding.

```bash
pnpm dev                   # START: dashboard :3000 + api :4000 + quant stub :5000
                           #   (checks .env first; lists missing keys if any)
# STOP: Ctrl+C in the same terminal
```

Run a single service instead:

```bash
pnpm --filter @fx/dashboard dev    # dashboard only (:3000)
pnpm --filter @fx/node-api dev     # API only (:4000)
pnpm --filter @fx/quant dev        # quant stub only (:5000)
```

## Start / stop — full Docker stack (BE-004)

Runs everything in containers, including Postgres/TimescaleDB and Redis.
Use this to work against a real database or to test the prod-like setup.
Docker Desktop must be running first.

```bash
pnpm stack:up              # START: build images + start db, redis, quant, api, web (detached)
pnpm stack:ps              # STATUS: all services should show "healthy"
pnpm stack:down            # STOP: stop and remove containers (data volumes are KEPT)
```

More control (same compose file):

```bash
docker compose -f infra/docker-compose.local.yml logs -f api      # follow logs (api|web|quant|db|redis)
docker compose -f infra/docker-compose.local.yml restart api      # restart one service
docker compose -f infra/docker-compose.local.yml up -d --build api  # rebuild + restart one service
docker compose -f infra/docker-compose.local.yml down -v          # STOP + DELETE volumes (wipes DB/Redis data!)
docker system prune -a # delete all unused images
```

Quick health checks once running:

```bash
curl localhost:4000/healthz     # API  → {"status":"ok",...}
curl localhost:5000/healthz     # quant stub
open http://localhost:3000      # dashboard
```

Connect to the database:

```bash
docker compose -f infra/docker-compose.local.yml exec db psql -U fx -d fx
```

## Database (Step 1.4 — BE-020…023)

The DB must be running first (`pnpm stack:up`, or just the db service:
`docker compose -f infra/docker-compose.local.yml up -d db`).

```bash
pnpm db:migrate            # DEV: create + apply a new migration from schema changes
pnpm db:deploy             # apply committed migrations (what CI/prod runs)
pnpm db:timescale          # apply hypertables/CAGGs/compression/retention (idempotent; run after deploy)
pnpm db:timescale -- --refresh   # …and materialize all candle CAGGs (after seeds/backfills)
pnpm db:generate           # regenerate the Prisma client (also runs via pre-scripts)
pnpm seed:dev              # deterministic fixtures: dev@fx.local, invite FX-DEV-0001, EUR/USD candles, signal
pnpm seed:creds            # seal real OANDA creds from env (OANDA_API_TOKEN, OANDA_ACCOUNT_ID)
pnpm check-migrations      # destructive-SQL guard (CI runs this on every PR)
pnpm --filter @fx/node-api db:studio   # Prisma Studio UI
```

Typical first-time DB setup: `pnpm stack:up && pnpm db:deploy && pnpm db:timescale && pnpm seed:dev`.

## Quality checks (what CI runs)

```bash
pnpm lint          # Biome — lint + format check, all workspaces
pnpm typecheck     # tsc --noEmit, all workspaces
pnpm test          # Vitest, all workspaces
pnpm build         # turbo build, all workspaces
pnpm format        # Biome — auto-fix formatting (writes files)
pnpm check-env     # verify .env has every key from .env.example
```

Run everything CI checks before pushing:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## CI / deploy

CI runs automatically — no command needed:

- **Every PR:** lint, typecheck, test, build + Docker image builds.
- **Merge to main:** publishes images to GHCR tagged with the commit SHA.

Production deploy (once a server exists — full runbook in `infra/DEPLOY.md`):

```bash
# From GitHub: Actions → Deploy → Run workflow (optionally pin a SHA), or on the server:
TAG=<git-sha> bash infra/deploy/deploy.sh      # zero-downtime rollout
TAG=<previous-sha> bash infra/deploy/deploy.sh # ROLLBACK: redeploy previous SHA
docker service rollback fx_api                 # rollback a single service
docker stack services fx                       # prod status (replicas 1/1 = good)
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `failed to connect to the docker API ... docker.sock` | Docker Desktop isn't running: `open -a Docker`, wait for "running", retry |
| `❌ No .env file found` | `cp .env.example .env` |
| `❌ .env is missing required keys` | copy the listed keys from `.env.example` into `.env` |
| Port already in use (3000/4000/5000/5432/6379) | `lsof -i :<port>` to find the process; stop it or `pnpm stack:down` |
| A compose service never turns healthy | `docker compose -f infra/docker-compose.local.yml logs <service>` |
| Weird dependency/build errors | `rm -rf node_modules && pnpm install`, then `pnpm build` |
| DB in a broken state locally | `docker compose -f infra/docker-compose.local.yml down -v && pnpm stack:up` (wipes local data) |
