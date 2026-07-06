# DEVLOG — Phase 2 (Execution & Quant)

Continuation of [`DEVLOG-phase1.md`](DEVLOG-phase1.md) (the Phase-1 record —
per-step build history lives there). The Phase-1 **Standing decisions** and
**Conventions** are carried forward in full below as the *current* standing
decisions — they all still apply, and this file is now the single source of
truth for them; no need to cross-read the Phase-1 log for them. Same rules:
**append a new entry per step; keep "Current state" at the top updated.** Plan:
[`FX_PRD.md`](FX_PRD.md) §8 Phase 2, stories in `FX_Stories_*.md`, architecture
in `system-design/FX_System_Design.md`.

**Phase 2 outcome:** orders execute on OANDA (paper); deterministic quant core
produces sized candidates; shadow baseline running.
**Exit criteria:** paper orders round-trip on OANDA with reconciler clean;
quant pipeline emits calibrated, sized candidates; baseline logging P&L.

---

## Current state (updated 2026-07-06)

- **Done (Phase 2):** Step 2.1 code-complete — QN-030 (BrokerAdapter protocol +
  conformance suite), QN-032 (OANDA v20 execution adapter), QN-033 (symbol
  table), QN-034 (pip/lot/margin). **QN-031 (MT5) DROPPED by product decision
  2026-07-06** — OANDA v20 covers both data and execution; stories/PRD updated.
- **Done (Phase-1 cross-cutting):** BE-140 (OTel traces Node+Python → Tempo),
  BE-141 (Grafana dashboards + provisioned alert rules + `/metrics` endpoint),
  BE-142 (restic backup/restore-drill scripts + runbook).
- **Pending human actions (build/tooling — sandbox can't run these):**
  1. `pnpm install` (new deps: @opentelemetry/*, @prisma/instrumentation,
     bullmq-otel — version ranges are best-guess, bump if resolution fails)
  2. `pnpm --filter @fx/types build` then in `services/quant`:
     `uv run python scripts/gen_contracts.py` (new broker.ts contracts →
     regenerate `app/contracts/`, else CI drift check fails)
  3. in `services/quant`: `uv lock && uv sync` (new deps: cryptography,
     opentelemetry-*) then `uv run pytest` (execution suite verified on 3.10
     shim in sandbox — see entry; re-verify on 3.13)
  4. `pnpm test` / `pnpm typecheck` / `pnpm lint` at root
  5. carried over from Phase 1: `/dashboard` visual check; `git push
     --force-with-lease` after the 2026-07-05 history rewrite
- **Next:** Step 2.2 — order lifecycle & reconciliation (BE-050…054), then
  Step 2.3 — deterministic quant core (QN-040…048).

## Standing decisions (carried from Phase 1 — don't re-litigate without cause)

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

## Conventions (carried from Phase 1)

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

## Phase-2 specific context (seams already built for this phase)

- **Execution lives Python-side:** QN-020 (`app/market/oanda_client.py`) is
  auth + pricing + candles ONLY — the execution adapter (orders) is new code
  behind QN-030's interface, not an extension hack of the stream client.
- **Signals queue:** BE-040 already enqueues one `signals` job per H1 candle
  close (BullMQ, `apis/node-api/src/workers/`) — Step 2.3's pipeline consumes
  these; Node's gRPC `RunPipeline`/`SizePosition`/`Predict` stubs abort
  UNIMPLEMENTED (owning stories QN-042/043/046) and the future breaker
  (BE-068) treats that as HOLD.
- **Risk gate input:** `DataQualityMonitor.degradedInstruments()` (BE-044) is
  what blocks execution on degraded feeds.
- **Broker credentials:** sealed AES-256-GCM envelopes (`v1:base64(iv‖tag‖ct)`,
  AAD `fx-broker-credentials:v1`) in the DB via `pnpm seed:creds`; Python must
  implement the documented decrypt (first real consumer is the OANDA execution
  adapter).
- **Instrument registry:** `apis/node-api/src/market/instruments.ts` + Python
  mirror `services/quant/app/market/instruments.py` — QN-033's symbol mapping
  seeds from this; keep the two in sync or better, single-source it now.
- **Sentiment scores** (QN-022) are stored but unread — first consumer is the
  Phase-3 sentiment analyst, not Phase 2. FinBERT stays mock (`ml` group
  uninstalled) through Phase 2.

## Entries

### 2026-07-06 — Phase-1 cross-cutting: BE-140/141/142 (OTel, dashboards+alerts, backups)

- **BE-142 restic backups:** `infra/backup/backup.sh` (pg_dump -Fc → `restic
  backup --stdin` → S3-compatible; retention 48h/14d/8w/6m + nightly
  `restic check --read-data-subset=5%`), `restore-drill.sh` (restores `latest`
  into a throwaway timescaledb-ha container, verifies hypertables/CAGGs/
  pgvector, measures RPO/RTO, appends to `drill-log.md`), runbook `BACKUP.md`
  (cron: nightly full + hourly during FX week ⇒ RPO <1h; weekly Sat drill).
- **BE-140 OTel:** Node — `apis/node-api/src/otel.ts` (NodeSDK +
  auto-instrumentations + @prisma/instrumentation; OTLP/HTTP), loaded via
  `node --import ./dist/otel.js` in the `start*` scripts (ESM patching needs
  pre-import, NOT an in-module import; dev via tsx runs untraced — acceptable,
  compose runs dist). BullMQ jobs use BullMQ's native `telemetry` hook
  (`bullmq-otel`) in `workers/market-data.ts`. Python —
  `services/quant/app/telemetry.py` (FastAPI + grpc.aio server + httpx),
  called in the lifespan BEFORE `GrpcServer()` (the instrumentor patches the
  constructor). Everything no-ops when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset
  (new optional env key in env.ts/config.py/.env.example/compose).
- **BE-141 dashboards/alerts:** compose `observability` profile (Tempo 2.7,
  Prometheus v3, Grafana 12 on :3001) + provisioning under
  `infra/observability/` (datasources, `fx-operations` dashboard, 6 alert
  rules with the AC thresholds, Telegram/SMS contact points + severity
  routing). New public `GET /metrics` on node-api (hand-rolled Prometheus
  text; live `fx_queue_jobs{queue,state}` from BullMQ) — reserved metric names
  for Phase-2/3 emitters contracted in `infra/observability/README.md`;
  rules on not-yet-emitted metrics sit silent in NoData.
- Verified: bash -n on backup scripts; YAML/JSON parse checks on all configs.
  Post-install fix: pnpm resolved the OTel 1.x/0.5x line, whose resources API
  is `new Resource(...)` not `resourceFromAttributes` (2.x) — otel.ts updated;
  `tsc --noEmit` for @fx/node-api now passes against the real lockfile.
  NOT verified: an actual trace round-trip, Grafana provisioning boot.

### 2026-07-06 — Step 2.1: Broker abstraction & execution adapters (QN-030, QN-032, QN-033, QN-034; QN-031 dropped)

- **QN-031 (MT5) DROPPED by product decision** (user, 2026-07-06): OANDA v20
  provides both market data and trade execution; a second venue added
  maintenance cost with no capability gain, and `MetaTrader5` is Windows-only
  anyway. Stories doc + PRD updated in place. Venue-agnosticism is preserved
  structurally: adapter protocol + conformance suite + per-broker symbol table
  + `Broker` enum all stay extensible; a future venue = new factory in
  `ADAPTER_FACTORIES` + one symbol-table column + one enum value.
- **Contract (QN-030):** `packages/types/src/broker.ts` — Broker, OrderSide,
  OrderStatus, OrderRequest, OrderResult, BrokerPosition, BrokerTradeRecord;
  registered in `contractSchemas` (⇒ regen needed, see pending actions).
  Python runtime models in `app/execution/models.py` mirror the fields
  (hand-written pydantic, NOT the QN-003 codegen output — adapters need
  behavior: signed-units, fill-consistency validators).
- **`services/quant/app/execution/`:** `adapter.py` (runtime-checkable
  `BrokerAdapter` protocol: connect/get_positions/place_order/close_order/
  get_history; rejects are RESULTS not exceptions, only transport raises
  `BrokerError`), `oanda_adapter.py` (QN-032: FOK market orders with
  `clientExtensions.id` idempotency — duplicate reject recovers the ORIGINAL
  fill via `orders/@{clientId}` + fill transaction; partial fills return
  remainder; openPositions/trades mapping; connect() records account currency
  + marginRate), `symbols.py` (QN-033: per-broker table, identity for OANDA,
  registry-coverage invariant CI-enforced), `sizing.py` (QN-034: RateProvider
  protocol + FixedRates w/ USD pivot; pip_value/margin_required/
  units_for_risk — QN-043's building block), `credentials.py` (BE-131 Python
  decrypt: v1 AES-256-GCM envelope, AAD `fx-broker-credentials:v1`,
  tag-reorder for the `cryptography` API + asyncpg row loader).
- **Tests:** `tests/execution/` — 56 tests: conformance suite (parametrized
  over adapter factories, runs against a stateful `FakeOanda` MockTransport),
  OANDA edge cases (partial/reject/duplicate/symbol coverage/protections),
  sizing GBP-account fixtures (QN-034 AC), credentials incl. an envelope
  sealed by the REAL Node implementation (cross-language parity pin).
- Deps added to quant pyproject: `cryptography`, `opentelemetry-*` (BE-140).
- Verified: **56/56 pass** — run in the sandbox on Python 3.10 with a
  `datetime.UTC` shim (sandbox has no 3.13; only stdlib-level difference).
  NOT verified: pytest on 3.13, mypy/ruff, contracts regen, a real
  practice-account round-trip (needs OANDA creds — recommend before Step 2.2).

---

*Template for new entries:*

```
### YYYY-MM-DD — Step X.Y: <name> (story IDs)

- <what was added/changed, file paths>
- <decisions made + why, if any>
- Verified: <what was actually run/tested; note anything NOT verified>
```
