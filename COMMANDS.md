# COMMANDS

Quick reference for running the FX platform. All commands run from the repo root.

Ports: dashboard `:3000` · API `:4000` · quant `:5001` · Postgres `:5432` · Redis `:6379` · Dozzle logs `:8888`

> Quant runs on **5001**, not 5000 — macOS AirPlay Receiver squats on 5000.

---

## ⚠️ Commands that DELETE data — know these first

| Command | What it destroys |
|---|---|
| `docker compose -f infra/docker-compose.local.yml down -v` | **Wipes the DB + Redis volumes.** All Postgres/TimescaleDB and Redis data gone. |
| `pnpm debug:down -- -v` | Same as above for the debug stack (the `-v` is what deletes volumes). |
| `pnpm --filter @fx/node-api exec prisma migrate reset` | **Drops and recreates the DB**, replays all migrations, re-seeds. Full DB wipe. |
| `docker system prune -a` | Deletes all unused images/build cache (this is the one that reclaimed 11.94 GB). Does **not** touch DB volumes, but forces a full rebuild next start. |
| `docker volume rm <name>` | Deletes a specific named volume manually. |

Everything else below is safe — it keeps your data.

- `pnpm stack:down` / `pnpm debug:down` → stops containers, **keeps** volumes.
- `pnpm stack:remove` → removes containers + networks, **keeps** volumes.
- Only `-v` (or `migrate reset`) removes data.

---

## 1. One-time setup (run once per machine)

```bash
corepack enable            # activate the pinned pnpm 9
pnpm install               # install all workspace dependencies
cp .env.example .env       # create env file — then fill in the values
open -a Docker             # start Docker Desktop
```

First-time database setup (after Docker is up):

```bash
pnpm stack:up && pnpm db:deploy && pnpm db:timescale && pnpm seed:dev && pnpm seed:creds
```

- `seed:dev` loads synthetic dev fixtures (user, invite, 2 days of EUR/USD candles).
- `seed:creds` seals your **real OANDA credentials** from `.env` into the DB — it must
  run after `seed:dev` (needs the user) and requires `OANDA_API_TOKEN` +
  `OANDA_ACCOUNT_ID` (+ `CREDENTIALS_ENCRYPTION_KEY`). Skip it if you have no creds yet.

Re-run that line any time you've wiped the database (see the danger table above).

Optional — replace synthetic candles with real market history (needs OANDA creds in `.env`):

```bash
cd services/quant && uv run python -m app.market backfill   # last ~6 months → candles hypertable
cd ../.. && pnpm db:timescale -- --refresh                  # materialize backfilled candles into M5…D1 aggregates
```

Run the `--refresh` after the backfill — it's needed for the new history to show up
in the higher-timeframe continuous aggregates (the raw `candles` table already has it).

---

## 2. Daily development (fastest loop, no Docker)

Runs the apps directly on your machine with hot reload. Best for writing code.

```bash
pnpm dev        # START dashboard :3000 + API :4000 + quant stub :5001  (Ctrl+C to STOP)
```

Run a single service instead:

```bash
pnpm --filter @fx/dashboard dev    # dashboard only  :3000
pnpm --filter @fx/node-api dev     # API only        :4000
pnpm --filter @fx/quant dev        # quant stub only :5001
```

---

## 3. Debugging (hot-reload apps + backing services in Docker with logs)

Dashboard + API run locally (instant hot reload); db, redis, quant, worker run in
Docker; logs stream in **Dozzle** at http://localhost:8888. Docker Desktop must be running.

```bash
pnpm debug        # START everything: Docker backing services + Dozzle + local app/API
pnpm debug:logs   # open Dozzle log viewer at :8888
pnpm debug:down   # STOP (keeps data — add `-- -v` only if you want to wipe it)
```

If the DB is fresh or was wiped, seed it once before `pnpm debug`:

```bash
pnpm db:deploy && pnpm db:timescale && pnpm seed:dev
```

```bash
docker compose -f infra/docker-compose.local.yml stop quant worker-execution worker api  # stop backing services (keep DB + Redis)
```

Notes:

- Local API/dashboard logs appear in **your terminal**, not Dozzle. Dozzle shows db, redis, quant, worker.
- OANDA ingest is opt-in and needs creds:
  `docker compose -f infra/docker-compose.local.yml --profile ingest up -d quant-stream`.

---

## 4. Run everything together (full Docker stack)

Everything in containers, including Postgres/TimescaleDB and Redis. Use this to
test the prod-like setup. Docker Desktop must be running.

```bash
pnpm stack:up       # START all services (reuses built images — fast)
pnpm stack:build    # REBUILD + start (after code or Dockerfile changes)
pnpm stack:ps       # STATUS (every service should read "healthy")
pnpm stack:down     # STOP all containers incl. Dozzle + quant-stream (keeps data — next stack:up is instant)
pnpm stack:remove   # remove containers + networks incl. profiled ones (keeps data volumes)
```

Health checks once running:

```bash
curl localhost:4000/healthz     # API
curl localhost:5001/healthz     # quant stub
open http://localhost:3000      # dashboard
```

Per-service control (same compose file):

```bash
docker compose -f infra/docker-compose.local.yml logs -f api          # follow one service's logs
docker compose -f infra/docker-compose.local.yml restart api          # restart one service
docker compose -f infra/docker-compose.local.yml up -d --build api     # rebuild + restart one service
docker compose -f infra/docker-compose.local.yml exec db psql -U fx -d fx   # open a DB shell
```

---

## 5. Database

DB must be running first (`pnpm stack:up`, or just `docker compose -f infra/docker-compose.local.yml up -d db`).

```bash
pnpm db:migrate     # DEV: create + apply a new migration from schema changes
pnpm db:deploy      # apply committed migrations (what CI/prod runs)
pnpm db:timescale   # apply hypertables/CAGGs/compression/retention (idempotent)
pnpm db:generate    # regenerate the Prisma client
pnpm seed:dev       # load dev fixtures (dev@fx.local, EUR/USD candles, a signal)
pnpm seed:creds     # seal real OANDA creds from env — run AFTER seed:dev (needs the user)
pnpm check-migrations                    # destructive-SQL guard (CI runs this)
pnpm --filter @fx/node-api db:studio     # Prisma Studio UI
```

Migrations are generated, never hand-written — run `pnpm db:migrate`, don't edit
migration files by hand.

---

## 6. Quality checks (what CI runs)

```bash
pnpm lint          # Biome lint + format check
pnpm typecheck     # tsc --noEmit
pnpm test          # Vitest
pnpm build         # turbo build
pnpm format        # Biome auto-fix formatting (writes files)
pnpm check-env     # verify .env has every key from .env.example
```

Run the full CI gate before pushing:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

---

## 7. Deploy

CI runs automatically — no command needed:

- **Every PR:** lint, typecheck, test, build + Docker image builds.
- **Merge to main:** publishes images to GHCR tagged with the commit SHA.

Production deploy (full runbook in `infra/DEPLOY.md`):

```bash
TAG=<git-sha> bash infra/deploy/deploy.sh        # zero-downtime rollout
TAG=<previous-sha> bash infra/deploy/deploy.sh   # ROLLBACK: redeploy previous SHA
docker service rollback fx_api                    # rollback a single service
docker stack services fx                          # prod status (replicas 1/1 = good)
```

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `failed to connect to the docker API … docker.sock` | Docker Desktop isn't running: `open -a Docker`, wait for "running", retry |
| `❌ No .env file found` | `cp .env.example .env` |
| `❌ .env is missing required keys` | copy the listed keys from `.env.example` into `.env` |
| Port already in use (3000/4000/5001/5432/6379) | `lsof -i :<port>`, stop the process, or `pnpm stack:down` |
| Quant won't bind / `:5000` conflict | macOS AirPlay Receiver uses 5000 — the quant service already uses 5001. Disable AirPlay Receiver in System Settings → General → AirDrop & Handoff if needed |
| A compose service never turns healthy | `docker compose -f infra/docker-compose.local.yml logs <service>` |
| Weird dependency/build errors | `rm -rf node_modules && pnpm install && pnpm build` |
| Disk full / stale images | `docker system prune -a` (safe — keeps DB volumes, forces rebuild) |
| DB in a broken state, want a clean slate | `docker compose -f infra/docker-compose.local.yml down -v` then re-run the one-time DB setup (**wipes data**) |
