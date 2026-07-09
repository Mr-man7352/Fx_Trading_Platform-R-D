# DEVLOG — session context for future development

Purpose: give any future dev session (human or AI) the current state, decisions,
and gotchas without re-reading the whole plan. **Append a new entry per step;
keep "Current state" at the top updated.** Authoritative plan:
[`development-plan/FX_PRD.md`](development-plan/FX_PRD.md) §8 (chronological steps),
stories in `development-plan/FX_Stories_*.md`, architecture in
`development-plan/system-design/FX_System_Design.md`.

---

## Current state (updated 2026-07-05)

- **Done:** Phase 1 → Step 1.1 (monorepo & shared packages), Step 1.2 (local stack, CI/CD, deploy), Step 1.3 (Fastify bootstrap, BE-010…015), Step 1.4 (DB schema: BE-020…023, BE-130, BE-131), Step 1.5 (quant scaffold: QN-001…005; `uv.lock` now committed in c909a00), Step 1.6 (market data ingestion: QN-020…022, BE-040…045), Step 1.7 (design system: FE-010, FE-011 + FE-110 banner — see entry).
- **Phase 1 is code-complete** (cross-cutting BE-140…142 obs/backup epics still open, deliberately deferred). **Phase 2 entries go in [`DEVLOG_phase2.md`](DEVLOG_phase2.md)** — this file stays as the Phase-1 record; keep this Current state block updated only until the Phase-2 log takes over.
- **⚠️ Steps 1.6 + 1.7 need human actions (sandbox could not run installers/tests):**
  1. `pnpm install` — Step 1.6 added `bullmq` + `ioredis` to `@fx/node-api`;
     Step 1.7 added the new `packages/ui` workspace (radix, cva, clsx,
     tailwind-merge) and `tailwindcss` + `@tailwindcss/postcss` to the
     dashboard (the mount blocks `unlink`, so pnpm can't install here). Then
     run `pnpm --filter @fx/ui test` + `pnpm --filter @fx/dashboard typecheck`
     + `pnpm dev` and eyeball `/dashboard` (theme, ModeBadge, kill-switch dialog).
  2. `cd services/quant && uv lock` — `httpx` moved to runtime deps and a new
     optional `ml` group (`transformers`, `torch`) was added for FinBERT
     (QN-022). Re-lock (no 3.13 in sandbox). FinBERT itself: `uv sync --group ml`.
  3. Run the suites: `pnpm --filter @fx/node-api test` (vitest can't run in the
     sandbox — the committed node_modules holds macOS-arm64 natives) and
     `cd services/quant && uv run pytest` (needs 3.13). What WAS verified here:
     full `tsc --noEmit` clean across node-api + @fx/types (only the two
     not-yet-installed `bullmq`/`ioredis` imports error); every new Python file
     `py_compile`s; and 9 acceptance-critical pure-logic assertions executed
     green (candle rollover/gap, DQ gap+stale, COT release-time, news dedupe,
     H1 signal enqueue).
  4. Optional, to exercise live venues: set `OANDA_API_TOKEN`/`OANDA_ACCOUNT_ID`
     (practice), `TWELVE_DATA_API_KEY`, `FRED_API_KEY`, `EIA_API_KEY`.
- **Next:** Phase 2 → Step 2.1 — Broker abstraction & execution adapters
  (QN-030, QN-032…034; QN-031 optional). Log it in `DEVLOG_phase2.md`.
  Cross-cutting obs/backup epics (BE-140…142) still open.
- **First CI run after Step 1.4:** watch the new `migrations` job — the init
  migration was hand-authored (see entry below); the drift check will flag any
  naming mismatch vs `schema.prisma`. Fix by adjusting the migration SQL, not
  the schema.
- **Repo:** `Mr-man7352/Fx_Trading_Platform-R-D` → GHCR images
  `ghcr.io/mr-man7352/fx-{node-api,dashboard,quant}` (SHA + latest tags on main).
- **No production server yet** — BE-006 delivered as scripts + runbook only
  (`infra/DEPLOY.md`); nothing is deployed.

## Standing decisions (don't re-litigate without cause)

> **These have moved.** As of Phase 2, the *current* Standing decisions +
> Conventions live in [`DEVLOG_phase2.md`](DEVLOG_phase2.md) as the single
> source of truth. The copy below is the Phase-1 historical snapshot — read the
> Phase-2 log for the live version.

- **DB image:** `timescale/timescaledb-ha:pg18-ts2.28` — community TimescaleDB
  (CAGGs/compression/retention) + pgvector. Identical image dev and prod; prod
  runs OUTSIDE the Swarm stack on a dedicated Hetzner volume (ADR-006 rev.).
- **Quant service:** `services/quant` is a uv-managed Python 3.13 FastAPI +
  gRPC service (Step 1.5). One process serves both planes: REST `:5001`
  (`/healthz`; moved off 5000 — see Conventions), gRPC `:50051` (std `grpc.health.v1` + QN-004
  stubs). Its `package.json` exists only so turbo `dev` boots it (`uv run
  python -m app`) — Python deps are never managed by pnpm; lint/type/test run
  via uv in the CI `quant` job, not turbo. Generated code (`app/contracts/`,
  `app/proto_gen/`) is committed and drift-checked; regenerate via
  `scripts/gen_contracts.py` + `scripts/gen_proto.py`, never hand-edit.
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
- **DB schema (Step 1.4):** Prisma migrations = relational DDL only; every
  Timescale/pgvector-index object goes in `apis/node-api/prisma/timescale.sql`
  (idempotent, applied by `pnpm db:timescale` after `db:deploy`) — NEVER in a
  migration, or the CI drift check breaks. Destructive migration SQL needs a
  `-- destructive-ok: <reason>` marker. Credential envelope format is
  `v1:base64(iv‖tag‖ct)` AES-256-GCM — Python quant must match it (QN-0xx).
- **Real FinBERT (`uv sync --group ml`) is deferred, not needed yet.** QN-022
  stores signed sentiment scores but nothing downstream reads them yet — the
  sentiment-analyst node in the multi-agent debate pipeline (Phase 2+) is the
  first real consumer, and score *accuracy* only gets exercised at
  QN-051/QN-054 (point-in-time backtests / quant-only-vs-+sentiment ablation,
  Phase 4). Until then, keep running in mock mode (`run_sentiment` no-ops
  cleanly without the `ml` group; tests use a fake `SentimentModel`) — installing
  torch now is a large, unneeded download. Revisit when wiring the sentiment
  analyst or backtesting.

## Conventions

- pnpm 9 (corepack) + Turborepo; Node 22 (`.nvmrc`); Biome for lint/format; Vitest.
- Workspaces: `apps/*`, `apis/*`, `packages/*`, `workers/*`, `services/*`.
- Story IDs (FE-/BE-/QN-###) referenced in code comments and commits — keep doing this.
- Root scripts: `pnpm dev` (env-check then all services), `pnpm stack:up|down|ps`
  (compose), `pnpm build|test|lint|typecheck|check-env`.
- **Quant HTTP port is 5001** (moved from 5000 on 2026-07-04): macOS AirPlay
  Receiver squats on 5000 (`ControlCenter` in `lsof -i :5000`) and broke
  `pnpm dev`. Changed everywhere (config default, Dockerfile healthcheck,
  compose, stack, `.env.example`) so dev = prod. Local `.env` files need
  `QUANT_PORT=5001` + `QUANT_URL=http://localhost:5001`.

## Entries

### 2026-07-05 — Step 1.7: Design system (FE-010, FE-011, FE-110 banner)

- **New `packages/ui` workspace (`@fx/ui`)** — consumed as TS source (exports
  point at `src/`, no build script) via Next `transpilePackages`, matching how
  the dashboard already consumes the other packages. Internal imports are
  extensionless (`moduleResolution: Bundler`) — NOT `.js`-suffixed NodeNext
  style like the node packages, or webpack won't resolve them.
- **FE-010 theme:** `packages/ui/src/styles/theme.css` — Tailwind v4 CSS-first
  config. `:root` variables (oklch, dark-first, `color-scheme: dark`; no light
  theme in Phase 1) + `@theme inline` mapping to Tailwind color tokens. shadcn
  naming (background/card/primary/destructive/…) plus trading tokens:
  `--color-profit/loss`, `--color-mode-{backtest,paper,live}`, `--color-warning`.
  Apps consume via `@import 'tailwindcss'; @import '@fx/ui/theme.css';` and a
  `@source '../../../../packages/ui/src'` line so Tailwind scans the ui source
  for class names (it's outside the app root).
- **FE-010 primitives (hand-vendored shadcn — deliberate, the CLI can't run in
  the sandbox and the code is meant to be owned):** Button (+Slot `asChild`),
  Badge, Card family, Dialog (radix), Input, Label, Separator, Skeleton, Alert.
  No icon library — the two icons needed (dialog X, kill-switch octagon) are
  inline SVGs; add lucide-react only when a real need appears.
- **FE-011 compositions (`src/trading/`):** `<AppShell>` (slot-based, RSC-safe:
  header brand/right, banner strip, desktop sidebar, mobile sticky footer —
  the FE-130 one-tap seam), `<ModeBadge mode>` (typed from `@fx/types`
  `TradingMode`; live pulses red, paper amber, backtest blue),
  `<PnLTile>` (sign-aware `formatSigned` with U+2212 minus, profit/loss
  colouring, `stale` flag for FE-120), `<AgentVoteCard>` (buy/sell/hold/veto +
  confidence meter + pinned model id; debate payload contract is Phase 3),
  `<KillSwitchButton>` (destructive trigger → radix confirm dialog; **2FA seam:
  `requireTwoFactorCode` prop + `twoFactorCode` arg to `onConfirm` — Phase 5
  flips the flag, contract unchanged**; `compact` icon variant for mobile).
- **FE-110 (Phase-1 part):** `<DisclaimerBanner>` + exported `DISCLAIMER_TEXT`
  (research/educational, not financial advice, CFD risk). Acknowledgement flow
  (`users.disclaimer_accepted_at`) waits for Phase-5 auth.
- **Dashboard wiring:** `@tailwindcss/postcss` + `postcss.config.mjs`,
  `globals.css` reduced to the two imports + `@source`, `@fx/ui` added to
  deps + `transpilePackages`. `/dashboard` page now composes
  AppShell/ModeBadge/PnLTiles/AgentVoteCards/KillSwitch with fixture data
  (mode read from `TRADING_MODE`, `.catch('paper')`); kill-switch `onConfirm`
  is a client-wrapper no-op until BE-072 (Phase 3).
- Tests: `packages/ui/src/index.test.tsx` — SSR markup smoke tests via
  `react-dom/server` (no jsdom): cn merge, every TradingMode has a badge style,
  formatSigned/pnlDirection, stale indicator, confidence clamping, kill-switch
  trigger a11y label + closed-dialog SSR, disclaimer wording, AppShell slots.
- Verified (sandbox): JSON/tsconfig parse; theme.css braces + every `@theme`
  var reference resolves to a `:root` definition; `formatSigned` expectations
  cross-checked against Node Intl; `tsc --noEmit` on packages/ui shows ONLY
  missing-module cascades (deps not installed here) — no syntax errors.
  **NOT verified:** `pnpm install`, vitest run, dashboard typecheck/build,
  visual render (see ⚠️ above — biome also can't run here: macOS-arm64 native).

### 2026-07-05 — Step 1.6 follow-up: ingestion runners + worker service + stack:up fix

- **Wired the QN-020…022 library modules to CLI entrypoints.** New
  `services/quant/app/market/`: `publishers.py` (`RedisTickPublisher` adds
  `tick` jobs to the BullMQ `market-ticks` queue in the exact Node `TickJob`
  shape — `tick_to_job()`; logging fallback in mock mode), `dbio.py`
  (asyncpg `PgCandleWriter` + news read/write; lazy import), `instruments.py`
  (py mirror of the Node registry: Twelve Data symbol + pip), `runners.py`
  (`run_stream`/`run_backfill`/`run_sentiment`, each a clean no-op when creds/
  URLs are missing), `__main__.py` (`python -m app.market <stream|backfill|
  sentiment>`; also a `fx-market` console script). Full loop: Python stream →
  `market-ticks` → Node BE-040 worker → M1 in TimescaleDB → `/market/candles`.
- **Deps (need `uv lock`):** `bullmq` (py) + `asyncpg` added to quant runtime;
  mypy overrides for both (+ the earlier `transformers`/`torch`). Config gained
  `redis_url`, `database_url`, `market_instruments`, `backfill_months`, etc.
- **Compose:** added a `worker` service (Node BE-040, same image as `api`,
  `command: node dist/workers/main.js`) that starts by default, and an opt-in
  `quant-stream` service under the `ingest` profile (QN-020, needs OANDA creds).
- **Fixed** the `stack:uep` → `stack:up` typo in root `package.json`.
- Verified: `py_compile` all new files; compose YAML + package.json parse;
  `stack:up` script present. New `tests/test_runners.py` covers the Node-compat
  tick-job shape + the no-op guards (fakes; no bullmq/asyncpg needed). Commit
  `e1b44b8` is the base Step 1.6; this follow-up is a separate commit.

### 2026-07-05 — Step 1.6: Market data ingestion (QN-020…022, BE-040…045)

- **No new migration** — every table Step 1.6 writes (candles, ticks,
  spreads_hist, news_archive, macro_features, features) already exists from
  Step 1.4. Nothing touched `schema.prisma`.
- **Decision — market modules + worker live inside `@fx/node-api`**
  (`src/market/*`, `src/workers/*`) rather than a new `workers/market-data`
  package: cohesion with the Prisma client + `@fx/types`, unit-testable without
  a new workspace/CI/Docker scaffold. Revisit if/when a second worker lands.
- **`@fx/types` (`market.ts`):** Timeframe, Candle, market REST (candles query +
  paginated response, instruments), point-in-time news (query + page), macro
  feature, and data-quality flag contracts. Deliberately **not** added to
  `contractSchemas` (QN-003 codegen) — Node consumes them directly in TS and the
  Python side uses its own candle dataclass, so no Pydantic regen / no CI drift.
- **BE-045:** `GET /market/instruments` (static registry in
  `src/market/instruments.ts` — ~8 instruments: FX majors + XAU + WTI/Brent,
  with OANDA/Twelve Data symbol maps + pipLocation; seeds QN-033), `GET
  /market/candles` (typed OHLCV, `from/to/limit`, `nextFrom` cursor), and the
  BE-042 `GET /market/news` PIT read. All DB-backed routes 503 without a Prisma
  client, mirroring `/audit`. Registered in `app.ts`.
- **BE-040:** `MarketDataProcessor` (pure: ticks → M1 candles via
  `CandleAggregator`, persist on close, enqueue one `signals` job per H1 close)
  + `startMarketDataWorker` BullMQ wiring (`market-ticks` in, `signals` out,
  Redis pub/sub DQ fan-out, 10 s stale sweep). Only M1 is written; M5…D1 come
  from the CAGGs. Worker process entry: `src/workers/main.ts`
  (`pnpm --filter @fx/node-api worker:market-data`).
- **BE-041:** pluggable `CandleSource`/`CrossCheckSource` seam
  (`src/market/vendors/`) with OANDA (primary) + Twelve Data (cross-check)
  adapters over an injectable `HttpClient`; `backfillCandles` orchestrator —
  idempotent upsert + sampled cross-check → DQ monitor. New vendors need no job
  change.
- **BE-042:** archive lives in `MarketRepo` — dedup on {source, externalId|
  headline}, immutable `published_at`, PIT read enforces `published_at <= asOf`.
  Provider-swappable `NewsSource` (stub live source for now).
- **BE-043:** release-time-aware macro (`src/market/macro.ts`) — `cotReleaseTs`
  maps a Tuesday COT reference to the following Friday 19:30 UTC print (the
  no-look-ahead pivot); FRED/EIA adapters gated on keys (no-op without),
  idempotent upsert on series×release×revision.
- **BE-044:** `DataQualityMonitor` — gap / stale (>30 s) / spread-anomaly /
  cross-check flags; a critical flag marks the instrument `degraded`
  (`degradedInstruments()` is what the Phase-3 risk gate will read). Weekend
  heuristic suppresses false gap alerts (DST-exact refinement = QN-047).
- **QN-020 (Python):** minimal OANDA v20 client (`app/market/oanda_client.py` —
  auth + pricing stream + candles only, no orders) + `TickStreamAdapter`
  (publishes ticks via a `TickPublisher` Protocol → prod pushes `market-ticks`;
  raises degraded on a >30 s quiet feed). httpx injectable for tests.
- **QN-021:** `backfill_candles` (paginated 5,000/req, idempotent via a
  `CandleWriter` Protocol) + `TwelveDataClient` sampled cross-check.
- **QN-022:** FinBERT scoring behind a `SentimentModel` Protocol (lazy
  transformers import; `ml` group) with signed [-1,1] scores kept bound to
  `published_at`; `point_in_time()` is the no-look-ahead filter. Tests inject a
  fake model — no torch needed.
- **Env:** `REDIS_URL` added to `env.ts` (defaulted so tests/boot don't break) +
  optional `OANDA_*`/`TWELVE_DATA_API_KEY`/`FRED_API_KEY`/`EIA_API_KEY`
  (commented in `.env.example` so check-env keeps them optional). Quant
  `Settings` gained the OANDA/Twelve Data/FinBERT fields + host helpers.
- Verified (sandbox limits — see Current state ⚠️): `tsc --noEmit` clean across
  node-api + @fx/types (only the un-installed `bullmq`/`ioredis` worker imports
  error); all new Python files `py_compile`; 9 pure-logic runtime assertions
  green (candles/DQ/macro/news/processor). **NOT run here:** `pnpm install`,
  vitest (macOS-arm64 natives in the committed node_modules), `uv lock`/pytest
  (no 3.13), Docker, live OANDA/vendor calls.

### 2026-07-04 — Step 1.5: Quant service scaffold (QN-001…005)

- **QN-001:** stdlib stub replaced by uv-managed Python 3.13 project.
  `app/main.py` — FastAPI factory; lifespan owns the gRPC server (`grpc.aio`,
  `app/grpc/server.py`) so one process serves REST `:5001` + gRPC `:50051`.
  (HTTP port moved 5000 → 5001 post-verification: macOS AirPlay conflict —
  see Conventions.)
  `/healthz` now returns the `@fx/types` `HealthResponse` contract shape
  (`status/commit/uptime/tradingMode`) validated by the generated Pydantic
  model. `app/config.py` — pydantic-settings, fail-fast `TRADING_MODE`
  validation (mirrors Node's Zod env). `python -m app` honours `QUANT_PORT`.
  ruff (format+lint) & mypy `strict` configured in `pyproject.toml`.
- **QN-002:** `libs/fx_common` (uv workspace member): `RequestContext`
  (contextvars, mirrors BE-013 `req.context`), `FXError` (`to_dict()` matches
  `ApiError` envelope), JSON logging (one line per record with
  `service/trading_mode/request_id`, uvicorn loggers routed through it),
  `load_contract(name)` reading vendored schemas.
- **QN-003:** `scripts/gen_contracts.py` vendors
  `packages/types/dist/schemas/*.json` → `app/contracts/schemas/` and
  generates Pydantic v2 models → `app/contracts/` (datamodel-codegen,
  snake_case fields + camelCase aliases, `--disable-timestamp` + explicit
  `--formatters black isort` for deterministic output). Committed; CI
  regenerates and fails on drift (`scripts/check_codegen.sh`).
- **QN-004:** `proto/quant.proto` — `fx.quant.v1.QuantService`: `RunPipeline`,
  `SizePosition`, `Predict` (+ `Timeframe`/`TradeSide` enums aligned with
  `@fx/types`); shapes provisional until Phase 2. `scripts/gen_proto.py` →
  `app/proto_gen/` (+ `.pyi`, package-absolute import fix). Servicers abort
  UNIMPLEMENTED with the owning story id (QN-042/043/046) — Node's breaker
  (BE-068) treats that as failure → HOLD. Health = std `grpc.health.v1`,
  SERVING for `""` and the service name; NOT_SERVING during drain.
- **QN-005:** 3-stage Dockerfile (TA-Lib C 0.6.4 built from source →
  `uv sync --frozen --no-dev` → slim runtime with venv + `libta-lib`;
  `EXPOSE 5000 50051`; healthcheck/CMD contract unchanged). Compose/stack:
  same service name/port/healthz; added `TRADING_MODE`, `QUANT_GRPC_PORT`,
  `LOG_LEVEL` env (+ `127.0.0.1:50051` publish in compose for grpcurl
  debugging; never published in prod stack). New CI `quant` job: uv sync
  --frozen → ruff → mypy → codegen drift check → pytest.
- Env: `QUANT_GRPC_PORT=50051` added to `.env.example` (check-env passes, 16 keys).
- Verified (sandbox, **Python 3.10 venv with a StrEnum/`datetime.UTC` shim** —
  3.13 uninstallable there): 16 pytest tests green (healthz contract, gRPC
  health SERVING, all 3 RPCs UNIMPLEMENTED, config fail-fast, fx_common),
  ruff + mypy strict clean (32 files), live smoke: uvicorn boot → `/healthz`
  200 with contract shape + gRPC health SERVING on 50051 + JSON logs, YAML
  valid. **NOT verified:** `uv lock`/`uv sync` (see Current state ⚠️ — no
  3.13 in sandbox; uv.lock NOT committed yet), Docker build (TA-Lib URL +
  uv sync inside image), `pnpm dev` boot via turbo, codegen byte-stability
  under the finally-locked tool versions.

### 2026-07-04 — Step 1.4: Database schema (BE-020…023, BE-130, BE-131)

- **Prisma 7.8** (driver-adapter era): `apis/node-api/prisma/schema.prisma` —
  all 20 tables from system design §7 (6 time-series, 10 trading/audit, 4
  auth/compliance), snake_case mapping, timestamptz(6) everywhere,
  `agent_memory.embedding vector(1536)` (`Unsupported`; write via
  `$executeRaw`). Client generated to `src/generated/prisma` (gitignored;
  `prisma generate` runs via pre-scripts on dev/build/typecheck/test).
  `prisma.config.ts` holds datasource/seed config; placeholder URL fallback so
  `generate` works without a `.env` (CI checks job).
- **BE-020 split design:** relational DDL lives in Prisma migrations; ALL
  Timescale objects (hypertable conversion, hierarchical CAGGs
  `candles_m5→m15→h1→h4→d1` off M1 base, refresh/compression/retention
  policies) + the pgvector HNSW index live in `prisma/timescale.sql`, applied
  statement-by-statement OUTSIDE a transaction by `pnpm db:timescale`
  (`scripts/apply-timescale.ts`, idempotent, `--refresh` flag materializes
  CAGGs). Why: CAGG creation can't run in Prisma's per-migration transaction,
  and keeping custom objects out of migrations keeps the CI drift check clean.
  D1 buckets close at 00:00 UTC (not NY 17:00) — noted in the SQL for later.
  Retention: ticks 90 d, spreads_hist 180 d; candles/features kept forever.
- **Init migration `20260704000000_init` was HAND-AUTHORED** (sandbox couldn't
  reach binaries.prisma.sh — see quirks) following Prisma naming conventions;
  validated with libpg_query (parses, 75 stmts). CI's new `migrations` job
  (timescaledb-ha service container) runs: destructive guard → `migrate
  deploy` → `migrate diff --exit-code` drift check → `db:timescale` → seeds →
  idempotency re-run. Any hand-authoring mistake surfaces there.
- **BE-022:** `scripts/check-migrations.mjs` — destructive SQL (DROP
  TABLE/COLUMN, statement-anchored TRUNCATE, DELETE FROM, ALTER…TYPE, …) fails
  CI unless the file carries `-- destructive-ok: <reason>`. Verified both paths.
- **BE-023:** `prisma/seed.ts` (`pnpm seed:dev` → `prisma db seed`):
  dev@fx.local (admin), invite `FX-DEV-0001`, 2 880 deterministic M1 EUR/USD
  candles (seeded LCG), fixture signal + baseline row, sealed practice cred.
- **BE-131:** `src/crypto/credentials.ts` — AES-256-GCM envelope
  `v1:base64(iv‖tag‖ct)`, AAD `fx-broker-credentials:v1`, key =
  `CREDENTIALS_ENCRYPTION_KEY` (base64 32 B); format documented for Python
  decrypt. 8 unit tests (round-trip/tamper/wrong-key/redaction).
  `pnpm seed:creds` seals real OANDA creds from env (Phase-5 settings path
  replaces this).
- **BE-130:** `DbAuditSink` behind the existing `AuditSink` interface (swap is
  invisible to callers; failed appends log at error, never 500). Append-only
  enforced in-DB: triggers block UPDATE/DELETE/TRUNCATE on `audit_log`.
  `GET /audit` (paginated/filterable, contracts `AuditLog*` in `@fx/types`,
  now in openapi.json) — 503 when built without a DB client; `buildApp(env,
  { prisma })` optional param keeps unit tests DB-free; `server.ts` always
  passes a client (lazy connect).
- Env: `DATABASE_URL` + `CREDENTIALS_ENCRYPTION_KEY` now REQUIRED by
  `env.ts` — **existing `.env` files need the new key or boot fails (by
  design)**; `.env.example` has a dev-only value. Compose api service gained
  the missing `INTERNAL_API_TOKEN`/`CORS_ALLOWED_ORIGINS` + new key;
  docker-stack.yml requires all three (`:?` guards).
- Verified (sandbox): workspace-wide lint/typecheck/test/build green (26 tests
  in node-api incl. new crypto + sink tests), openapi emit includes `/audit`,
  both SQL files parse via libpg_query, destructive guard pass+fail paths,
  YAML valid. **NOT verified (no Docker/root in sandbox):** live `migrate
  deploy`/drift check/CAGGs/seeds against a real DB (CI `migrations` job +
  `pnpm stack:up && pnpm db:deploy && pnpm db:timescale && pnpm seed:dev`
  locally), `prisma generate` output (typechecked against a stub of the
  documented client surface), Docker image rebuilds.

### 2026-07-03 — Step 1.3: Fastify bootstrap (BE-010…015)

- `apis/node-api/src/app.ts` — `buildApp(env)` factory (testable via `inject`,
  no listen): Pino JSON logs (requestId/method/url/statusCode/responseTime/userId
  on every completion line), helmet (CSP off — JSON API + Swagger UI), CORS
  allowlist, rate-limit (429 mapped in the central error handler — the plugin's
  `errorResponseBuilder` result is *thrown* into `setErrorHandler`, not sent),
  Zod validator/serializer (`fastify-type-provider-zod` v7), consistent
  `ApiError` shape incl. 404/429/500, OpenAPI 3.1 + Swagger UI at `/docs`
  (non-prod only).
- `src/context.ts` (BE-013) — `req.context = { user, role, stepUp2FAAt, requestId }`;
  auth = `x-internal-token` header vs `INTERNAL_API_TOKEN` (timing-safe), routes
  opt out via `config: { public: true }`. Audit hook on POST/PUT/PATCH/DELETE →
  `app.auditSink` (`src/audit.ts`, log-based `LogAuditSink`; DB sink is BE-130 in Step 1.4).
- `src/routes/ws.ts` (BE-014, Phase-1 variant) — `/ws` gateway: token via header
  or `?token=`, subscribe/unsubscribe/ping per `@fx/types` `Ws*` contracts,
  30 s heartbeat, fed by in-process `EventBus` (`src/events.ts`; Redis fan-out later).
  JWT auth/expiry-close arrives with BE-030 (Phase 5) behind the same contract.
- `packages/types` — `ws.ts` (WsClientMessage/WsServerMessage), `ApiError` gained
  optional `details[]` (field-level 400s); both registered in `contractSchemas`.
- `scripts/openapi.ts` + root `pnpm openapi` → emits `apis/node-api/openapi.json`
  (biome-ignored as a generated artifact — see `biome.json`).
- Env: `INTERNAL_API_TOKEN` (≥16 chars, required), `CORS_ALLOWED_ORIGINS`,
  `RATE_LIMIT_MAX` added to `env.ts` + `.env.example` — **existing `.env` files
  need `INTERNAL_API_TOKEN` or boot fails fast (by design)**.
- Verified (fresh Linux install): build/typecheck/lint/test green (19 tests, incl.
  WS integration over a real socket), `pnpm openapi` emits, live boot smoke-tested
  (healthz 200, 401 without token, /docs 200), SIGTERM handler exits 0 with drain log.
  NOT verified: Docker image rebuild, dashboard against the new API.

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
