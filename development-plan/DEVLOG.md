# DEVLOG — session context for future development

Purpose: give any future dev session (human or AI) the current state, decisions,
and gotchas without re-reading the whole plan. **Append a new entry per step;
keep "Current state" at the top updated.** Authoritative plan:
[`development-plan/FX_PRD.md`](development-plan/FX_PRD.md) §8 (chronological steps),
stories in `development-plan/FX_Stories_*.md`, architecture in
`development-plan/system-design/FX_System_Design.md`.

---

## Current state (updated 2026-07-03)

- **Done:** Phase 1 → Step 1.1 (monorepo & shared packages), Step 1.2 (local stack, CI/CD, deploy).
- **Next:** Step 1.3 — Fastify bootstrap (BE-010…015): replace `apis/node-api/src/server.ts`
  (deliberately plain `node:http`) with production Fastify — Pino, helmet, CORS,
  rate-limit, Zod routes, request context + audit middleware (internal-token
  stand-in), WS gateway, OpenAPI/Swagger.
- **Repo:** `Mr-man7352/Fx_Trading_Platform-R-D` → GHCR images
  `ghcr.io/mr-man7352/fx-{node-api,dashboard,quant}` (SHA + latest tags on main).
- **No production server yet** — BE-006 delivered as scripts + runbook only
  (`infra/DEPLOY.md`); nothing is deployed.

## Standing decisions (don't re-litigate without cause)

- **DB image:** `timescale/timescaledb-ha:pg18-ts2.28` — community TimescaleDB
  (CAGGs/compression/retention) + pgvector. Identical image dev and prod; prod
  runs OUTSIDE the Swarm stack on a dedicated Hetzner volume (ADR-006 rev.).
- **Quant service:** `services/quant` is a stdlib-only Python healthcheck stub
  (Step 1.2). QN-001/QN-005 (Step 1.5) replace internals; compose/stack wiring
  (name `quant`, port 5000, `/healthz`) must stay identical. Its `package.json`
  exists only so turbo `dev` boots it — Python deps are never managed by pnpm.
- **`TRADING_MODE`** (`backtest|paper|live`): one env flag, one identical code
  path everywhere (BE-003). Env validation is fail-fast Zod in
  `apis/node-api/src/env.ts`; every new key MUST also go into `.env.example`
  (CI checks it via `scripts/check-env.mjs --ci`).
- **Redis:** AOF `everysec` always (BullMQ durability) — set in both compose and stack.
- **Zero-downtime deploys:** Swarm `start-first` + `failure_action: rollback`;
  `infra/deploy/deploy.sh` gates on convergence and smoke-checks
  `https://api.<domain>/healthz`.
- **Docker builds:** all Dockerfiles expect the REPO ROOT as build context
  (`docker build -f apps/dashboard/Dockerfile .`). Dashboard uses Next.js
  `output: 'standalone'`; server entry is `apps/dashboard/server.js` inside the
  standalone dir.
- **Phase 1 auth:** internal service token stand-in; all user-facing auth (UI +
  API) lands in Phase 5. Broker creds seeded via env/CLI until then.

## Conventions

- pnpm 9 (corepack) + Turborepo; Node 22 (`.nvmrc`); Biome for lint/format; Vitest.
- Workspaces: `apps/*`, `apis/*`, `packages/*`, `workers/*`, `services/*`.
- Story IDs (FE-/BE-/QN-###) referenced in code comments and commits — keep doing this.
- Root scripts: `pnpm dev` (env-check then all services), `pnpm stack:up|down|ps`
  (compose), `pnpm build|test|lint|typecheck|check-env`.

## Entries

### 2026-07-03 — Step 1.2: Local stack, CI/CD, deploy (BE-004, FE-007, BE-005, BE-006)

- `infra/docker-compose.local.yml` — db/redis/quant/api/web, all healthchecked;
  db init SQL enables `timescaledb` + `vector` (`infra/db/init/`).
- `services/quant/` — Python stub (main.py, Dockerfile, stub package.json);
  `services/*` added to `pnpm-workspace.yaml`.
- `apps/dashboard/Dockerfile` + `output: 'standalone'` in next.config.ts.
- `scripts/check-env.mjs` — FE-007 fail-fast; wired into root `dev` script.
- `.github/workflows/ci.yml` — checks job (Biome/tsc/Vitest/build) + docker
  matrix job (build PRs, push on main w/ GHA cache).
- `.github/workflows/deploy.yml` — manual SSH deploy; needs secrets
  `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`.
- `infra/docker-stack.yml`, `infra/Caddyfile`, `infra/deploy/deploy.sh`,
  `infra/DEPLOY.md` — prod Swarm + Caddy auto-TLS + runbook (DB outside stack).
- `.dockerignore` added; `.env.example` gained DB/Redis/quant keys.
- Verified: fresh Linux install → build/typecheck/test/lint all green; quant
  stub + env-check behavior tested; YAML validated. Compose stack itself not
  yet booted (needs Docker on the dev machine): run `pnpm stack:up` and check
  `pnpm stack:ps` shows everything healthy.

### (earlier) — Step 1.1: Monorepo & shared packages (FE-001…006, BE-001…003)

- Turborepo + pnpm workspace; `@fx/tsconfig`, Biome, `@fx/types` (Zod 4 source
  of truth), Next.js 16 dashboard (React Compiler on), `@fx/api-client`,
  `@fx/auth-client`, `apis/node-api` minimal boot (plain node:http `/healthz`),
  Zod env loader, `TRADING_MODE` flag.

---

*Template for new entries:*

```
### YYYY-MM-DD — Step X.Y: <name> (story IDs)

- <what was added/changed, file paths>
- <decisions made + why, if any>
- Verified: <what was actually run/tested; note anything NOT verified>
```
