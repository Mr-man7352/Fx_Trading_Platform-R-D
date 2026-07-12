# DEVLOG — Phase 2 (Execution & Quant)

> **ARCHIVE (Phase 2 complete, 2026-07-09).** This file is now the frozen
> Phase-2 record; live development continues in
> [`DEVLOG_phase3.md`](DEVLOG_phase3.md) (Phase 3 — Intelligence). The
> Standing decisions + Conventions below are carried forward into the Phase-3
> log as the single live source of truth. Pre-Phase-3 test plan:
> [`PHASE2_TESTING_GUIDE.md`](PHASE2_TESTING_GUIDE.md).

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

## Current state (updated 2026-07-08)

- **Done (Phase 2):** Step 2.1 (QN-030…034), **Step 2.2** (BE-050…053, audited
  + fixed 2026-07-07), and **Step 2.3** (QN-040…048): deterministic quant core —
  point-in-time features + DST-aware sessions/rollover/gap flags, HMM trend +
  liquidity regime, LightGBM meta-model with walk-forward calibration +
  model registry (champion/challenger + drift monitor), vol-target/Kelly/FCA
  sizing (+ QN-044 flag), shadow baseline, correlation clustering with
  event-triggered refresh. QuantService gRPC RPCs (RunPipeline/SizePosition/
  Predict) are now REAL — the QN-004 UNIMPLEMENTED stubs are gone.
  BE-054 (trades REST) deferred to Phase 5.
- **Done (Phase-1 cross-cutting):** BE-140/141/142 (OTel, Grafana, backups).
- **Known issue / TODO (2026-07-09, defer):** first trained model
  `XAU_USD/H1 v1` has **no predictive edge** — OOF AUC 0.51 (coin flip),
  brier_cal 0.23, trained on only ~6 months / 2,121 candidates. It is a
  plumbing/smoke-test artifact only; do NOT treat as tradeable. **Fix later:
  retrain on more history** (`BACKFILL_MONTHS` ≥ 18, H1) once Section E flow is
  validated. Also the regime HMM logged non-convergence on this small sample,
  so `regime_fold_stability` (0.52) is unreliable here.
- **Pending human actions:**
  1. **Prisma migration** — schema adds `model_registry` + `correlation_clusters`
     (Step 2.3) ON TOP of the still-unapplied Step-2.2 changes
     (`trade_intents.reason_code`, `intent_status.executed`). Local DB has
     migration drift (timescale indexes); run:
     `pnpm --filter @fx/node-api exec prisma migrate reset` then
     `pnpm --filter @fx/node-api exec prisma migrate dev --name step_2_3_quant_core`
     (dev-only; destructive).
  2. **Quant deps:** `cd services/quant && uv lock && uv sync --dev` — Step 2.3
     added numpy/pandas/scipy/scikit-learn/lightgbm/hmmlearn/ta-lib (ta-lib
     0.6+ wheels bundle the C library; if a wheel is missing for macOS/py3.13,
     `brew install ta-lib` first). Then `uv run pytest` (expect 230),
     `uv run mypy .`, `uv run ruff check .` on 3.13.
  3. `pnpm test` / `pnpm typecheck` / `pnpm lint` at root — Vitest still not
     executable in the sandbox (carried from 2.2; no Node code changed in 2.3).
  4. Paper round-trip smoke against real OANDA practice account (carried).
  5. Deploy watchdog off-host per `workers/watchdog/README.md` (carried).
  6. Carried over: `/dashboard` visual check; `git push --force-with-lease`
     after 2026-07-05 history rewrite.
  7. **When ready to trade on the model:** backfill history (QN-021 CLI), then
     `uv run python -m app.quant train --instrument EUR_USD --timeframe H1`,
     let it shadow ≥100 bars, then `… promote --version N`. Until a champion is
     promoted, RunPipeline deterministically returns has_candidate=false (HOLD).
- **Next:** Phase-2 remainder — Node risk gate + breaker (BE-068, BE-070…073,
  consuming QN-048 clusters + P≥0.60 gate), then Phase 3 agents.

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

### 2026-07-06 — Step 2.2: Order lifecycle & reconciliation (BE-050, BE-051, BE-052, BE-053)

- **Execution seam:** `ExecutionService` in `services/quant/proto/quant.proto` +
  `app/grpc/execution_servicer.py` (delegates to QN-030 adapter via
  `app/execution/factory.py`). Adapter extended: `modify_trade`, `get_transactions`.
  Node: `apis/node-api/src/execution/quant-client.ts` (@grpc/grpc-js, 10s/5s timeouts).
- **BE-050:** `workers/execution.ts` + `execution-main.ts` (BullMQ `execution` queue),
  halt flag (`execution:halt`), notifications worker, `scripts/enqueue-intent.ts`,
  WS fan-out via Redis (`ws:fanout` → `ws-bridge.ts`), audit rows, `supervision` producer.
  Schema: `trade_intents.reason_code`, `intent_status.executed`.
- **BE-051:** `trade-manager.ts` (30s repeatable), `manager-config.ts` (+1R partial,
  breakeven, trail; never-widen-SL unit-tested).
- **BE-052:** `reconciler.ts` (60s), txn high-water in Redis, mismatch → halt/flatten,
  `fx_reconciliation_mismatches_total` metric, integration-style Vitest for mismatch detect.
- **BE-053:** `workers/watchdog/` — fate-isolated PAT flatten, Telegram/SMS, Dockerfile +
  README (off-host deploy runbook), `GET /healthz/heartbeat` on node-api.
- Verified: **61/61** pytest (execution + servicer unit tests), **74/74** node-api
  Vitest, **3/3** watchdog Vitest, `tsc --noEmit` clean. NOT verified: prisma
  migrate (DB drift — needs operator reset), live OANDA paper round-trip.
- Paper smoke (FakeOanda / stub path): start quant + `pnpm --filter @fx/node-api
  worker:execution`, then `pnpm --filter @fx/node-api enqueue-intent -- EUR_USD long
  10000 1.10 1.09 1.12` — expects fill row + supervision job enqueued.

### 2026-07-07 — Step 2.2 audit + fix pass (BE-050…053)

Audit of the Step-2.2 build found three blocking bugs (all rooted in FakeOanda
being unfaithful to the real v20 API, so the suites passed while the code was
broken against the real venue) plus coverage/robustness gaps. All fixed:

- **Reconciler close-sync rebuilt on `tradesClosed`/`tradeReduced` (blocking).**
  Real ORDER_FILL transactions carry trade ids only in `tradeOpened` /
  `tradesClosed` / `tradeReduced` — never top-level `tradeID`. The old code
  keyed close-sync on top-level tradeID: vs real OANDA every SL/TP hit became a
  `missing_at_broker` halt; vs the (wrong) fake it closed freshly-OPENED trades.
  Now: proto `TradeReduceMsg` + `reason`/`trade_opened_id`/`trades_closed`/
  `trade_reduced` on `BrokerTransactionMsg` (proto_gen regenerated with pinned
  grpcio-tools 1.81.1); Python `TradeReduceInfo` model; reconciler closes DB
  trades only from `tradesClosed` (P&L/financing per-trade, commission
  apportioned by units), accumulates partial-close P&L from `tradeReduced`
  WITHOUT touching units (manager owns units; broker-initiated partials surface
  via size_drift). This also fixes "partial-close P&L never recorded".
- **since-id bootstrap (blocking).** Plain `GET /transactions` returns PAGE
  URLS, not bodies — first-ever reconcile got `[]` and the high-water mark
  never advanced (txn sync no-oped forever). Adapter now records
  `lastTransactionID` at `connect()`, `get_transactions` ALWAYS uses
  `/transactions/sinceid` (bootstraps from connect when no since-id), servicer
  returns the adapter's high-water mark even on empty polls, reconciler
  persists it every tick.
- **Watchdog de-zodded (blocking).** `workers/watchdog` imported zod without
  declaring it — monorepo hoisting hid it; the isolated Docker build would
  fail. Env parsing is now hand-rolled; the package is genuinely
  dependency-free (documented in its README). Also: heartbeat `degraded`
  (execution worker silent >120s) now alerts once via Telegram/SMS (still no
  flatten — broker-side SL/TP stand; flatten stays reserved for full host
  loss), and the trigger re-arms after recovery so a second outage still
  flattens. Core extracted to `src/watchdog.ts` (injectable deps) for tests.
- **FakeOanda made faithful:** ORDER_FILL shape (tradeOpened/tradesClosed/
  tradeReduced, top-level `clientOrderID`, reason), partial closes keep the
  trade open with reduced units, `/transactions` returns pages (like the real
  API), `/transactions/sinceid` routed correctly (was 404 before —
  another latent bug), summary carries `lastTransactionID`.
- **Adapter caching:** `load_adapter()` cached for process lifetime
  (was: fresh asyncpg conn + OANDA connect per RPC, 4+/min from the
  reconciler+manager alone); `reset_adapter_cache()` on BrokerError.
- **Trade manager:** rejected breakeven modify now retried each tick until it
  sticks (was: silently never set, trailing never activated). Fill handler no
  longer derives risk from a missing fill price (falls back to intent entry;
  omits `originalRiskDistance` if unknown so the manager skips the trade).
- **Deploy:** `worker-execution` service added to compose AND
  `infra/docker-stack.yml` (the stack also gained the missing market-data
  `worker` service — it was compose-only; prod would have run neither worker).
- **Tests added:** Node — `execution-worker.test.ts` (fill/idempotent retry/
  halt/reject/partial/unknown-outcome), reconciler tick suites (bootstrap,
  SL-close sync, partial accumulate, lost-fill recovery, halt +
  flatten_and_halt ACs, clean-state), trade-manager tick suites (+1R once,
  breakeven retry, trail never-widens, halt/backtest no-op) over shared
  in-memory fakes (`test-fakes.ts`); watchdog trigger-timing/re-arm/
  retry-until-flat/degraded + env-parsing tests. Python — conformance additions
  (bootstrap advances on empty polls, full-close→trades_closed,
  partial→trade_reduced + position stays open with reduced units).
- Verified: **101/101 quant pytest in sandbox** (py3.10 + UTC shim venv;
  the 1 failure without proxy-env stripped is a sandbox SOCKS artifact),
  `tsc --noEmit` clean for @fx/node-api and @fx/watchdog (fixed watchdog
  tsconfig rootDir clash), proto_gen regenerated via the real
  `scripts/gen_proto.py`. NOT verified: Vitest execution (darwin natives —
  run `pnpm test` on the Mac), pytest on 3.13, biome, prisma migrate, real
  OANDA round-trip.

### 2026-07-08 — Step 2.3: Deterministic quant core (QN-040…048)

New package `services/quant/app/quant/` — everything deterministic (fixed
seeds, trailing-window-only computations, point-in-time joins); no LLM ever
touches it (§10).

- **QN-040/047 `features.py` + `sessions.py`:** `indicator_frame` is THE single
  TA-Lib implementation (pipeline + validation scripts call the same function —
  parity AC unit-tested); returns/vol, EMA/RSI/ATR/NATR/ADX/MACD/BBands/ROC,
  prior-Donchian S/R distances in ATR units, candle anatomy, volume z-score;
  macro join via `merge_asof(release_ts <= bar_ts)`, sentiment via
  `published_at <= bar_ts` windows, spread as-of join + causal trailing
  percentile. Sessions defined EXCHANGE-LOCAL via IANA tz (Tokyo 09–18 JST,
  London 08–16:30 local, NY 08–17 local; OVERLAP = London∩NY); rollover +
  Friday close anchored 17:00 America/New_York; `triple_swap_day`,
  `weekend_gap_window`, spread multipliers (OFF_HOURS/Tokyo 1.5×). DST
  regression tests cover summer/winter for label, rollover (21:00/22:00 UTC)
  and gap window. **No-look-ahead test:** prefix-computed features must equal
  full-series rows exactly. `partition_features` → technical/macro/sentiment
  by prefix (exactly-once AC tested). `FEATURE_SET_VERSION = 1`.
- **QN-041 `regime.py`:** 3-state GaussianHMM over [ret, rolling vol], refit
  per run on the trailing window (seeded ⇒ deterministic); states → labels by
  scale-relative mean sign (HMM may split one drift phase across states — a
  plain argsort mapping mislabels; found by test). Posterior entropy at last
  bar (causal: smoothing == filtering at the final step) → debate rounds
  0/1/2. `fold_stability` (adjusted Rand on overlapping folds) recorded into
  model metrics at each train. Liquidity regime SEPARATE: spread pctile ≥0.8
  or volume pctile ≤0.2 ⇒ LOW; ≤0.3 & ≥0.6 ⇒ HIGH; missing data ⇒ NORMAL.
- **QN-042/044 `sizing.py`:** ladder (each rung only shrinks): 1% hard risk
  ceiling → fractional-Kelly cap (f*=p−(1−p)/b, b=min R:R 1.8; ≤0 ⇒ 0 units)
  → ATR vol-target (1×ATR ≈ `vol_risk_pct` equity, default 0.5%) → QN-044
  prob scaling (flag off by default; 0.5× @P=0.60 → 1× @P≥0.75) → FCA leverage
  (30:1 majors / 20:1 minors+XAU / 10:1 oil; broker margin_rate may only
  tighten) → unit-step floor. Builds on QN-034 primitives; GBP-account
  fixtures; caps recorded in `caps_applied` for audit.
- **QN-043 `labels.py`/`model.py`/`registry.py` + train CLI:** labels = bracket
  sim of the platform's own geometry (1×ATR stop, rr×ATR target, SL-first on
  same-bar touch, cost haircut, NaN tails). Walk-forward LightGBM (expanding
  folds, embargo = horizon; fold bounds recorded and unit-tested — no future
  data in any training fold), calibration on OOF only (isotonic ≥300 rows,
  else Platt), reliability curve + ECE/Brier/AUC persisted. Calibrators are
  JSON (no pickle). Artifacts: `var/models/<inst>/<tf>/vN/{model.txt,
  calibrator.json,metadata.json}` (gitignored); roles live in the new
  `model_registry` table. **Train-on-demand policy (user decision):** no
  committed model; no champion ⇒ RunPipeline emits features/regime/baseline
  but `has_candidate=false` (deterministic HOLD, ADR-010).
  CLI: `python -m app.quant train|promote|clusters`.
- **QN-046:** new models ALWAYS register as challenger; pipeline shadow-scores
  the newest challenger each bar (`shadow_count` bumped); `promote` refuses
  below `min_shadow=100` without `--force`; old champion → retired.
  `calibration_drift` (recent ECE > 0.08 or Brier > 1.2× training) → alert.
- **QN-045 `baseline.py`:** trend (EMA20/50 spread + ADX≥20) + vol-breakout
  (prior-Donchian break + range ≥1.2×ATR); conflict ⇒ stand down. Row written
  to `baseline_signals` on EVERY pipeline bar in EVERY mode. In Phase 2 the
  baseline doubles as THE candidate generator — the meta-model is trained on
  and scores exactly these candidates (agents refine in Phase 3).
  `comparison_metric` = baseline expectancy (R) vs agent-trade R.
- **QN-048 `clusters.py`:** |Pearson|, average-linkage, cut at 1−0.7; weekly
  refresh + event triggers (liquidity-regime transition, realized-vol spike
  >2× trailing median). Event recomputes use a SHORT window (20d vs 60d) so
  fresh convergence isn't averaged away — the risk-off fixture proves the
  event path clusters EUR/GBP while the 60d weekly window still wouldn't.
  Versioned rows in new `correlation_clusters` table (BE-071 consumes latest).
- **Seams:** `pipeline.py` orchestrates per-bar; `dbio.py` (QuantDb) owns all
  SQL; `app/grpc/servicer.py` implements RunPipeline/SizePosition/Predict with
  cached runtime (mirrors execution factory). Proto: Candidate gained bracket
  zones; RunPipelineResponse gained session/liquidity/trend labels, entropy,
  debate_rounds, challenger_probability; SizePositionResponse gained
  risk_amount/caps_applied/prob_scale (additive — Node loads the proto
  dynamically, no Node change needed). Errors: FAILED_PRECONDITION (no DB /
  short history / no champion) | INVALID_ARGUMENT | INTERNAL — breaker ⇒ HOLD.
- **Schema:** `model_registry` + `correlation_clusters` in schema.prisma
  (relational only — no timescale objects, so no timescale.sql change).
- **Config/env:** ACCOUNT_CURRENCY, RISK_PER_TRADE_PCT (code-clamped to 1%),
  VOL_RISK_PCT, KELLY_FRACTION, PROB_SIZING_ENABLED, MIN_RR,
  PIPELINE_LOOKBACK_BARS, LABEL_HORIZON_BARS, MODEL_DIR, CORR_* — all in
  `.env.example` (commented, defaults in code). pyproject: quant stack deps
  added (ta-lib wheels bundle the C lib since 0.6); ruff
  `allowed-confusables` for the house typography; mypy overrides for the
  untyped numeric stack.
- Verified: **230/230 pytest in the sandbox** (py3.10 venv + StrEnum/UTC
  shims; includes 129 new Step-2.3 tests), `ruff check` clean, `mypy` clean
  (app/quant, servicer, tests/quant), proto_gen regenerated with pinned
  grpcio-tools 1.81.1. NOT verified: pytest/mypy on real 3.13, `uv lock`
  (sandbox has no uv/pypi-full), prisma migrate, training on real backfilled
  data, RunPipeline against a real DB.

---

*Template for new entries:*

```
### YYYY-MM-DD — Step X.Y: <name> (story IDs)

- <what was added/changed, file paths>
- <decisions made + why, if any>
- Verified: <what was actually run/tested; note anything NOT verified>
```
