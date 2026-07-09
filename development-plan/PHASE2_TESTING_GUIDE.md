# Phase 2 — Completion Summary & Pre-Phase-3 Test Plan

**Status as of 2026-07-08.** Companion to [`DEVLOG_phase2.md`](DEVLOG_phase2.md) —
that file is the append-only build log; this file is a point-in-time checklist
for closing Phase 2 out before Phase 3 (Intelligence, `FX_PRD.md` §8) starts.
`uv run mypy .` on the real Python 3.13 env is now clean (7 errors fixed
2026-07-08: an HMM mask typed as float instead of bool, two test fixtures
inferred as `dict[str, str]`, `OandaAdapter.broker` not matching the
`BrokerAdapter` protocol's `Literal["oanda"]`, an untyped OTel instrumentor
call, and a missing param annotation in the gRPC servicer).

## 1. What's built and code-complete

**Step 2.1 — Broker abstraction (QN-030, 032, 033, 034).** `services/quant/app/execution/`:
a `runtime_checkable` `BrokerAdapter` protocol, the OANDA v20 adapter (FOK market
orders, `clientExtensions.id` idempotency, partial-fill remainder), the
per-broker symbol table, and cross-currency pip/lot/margin sizing. QN-031 (MT5)
was dropped by product decision — OANDA covers both data and execution.

**Step 2.2 — Order lifecycle & reconciliation (BE-050…053).** BullMQ execution
worker with halt flag, WS fan-out, and audit rows; trade manager (+1R partial,
breakeven, trailing stop, never-widens-SL); reconciler (60 s broker↔DB sync,
since-id bootstrap, mismatch → halt/flatten); off-host watchdog with a
separately-scoped OANDA token. A 2026-07-07 audit found and fixed three
blocking bugs, all rooted in the original `FakeOanda` test double not matching
the real v20 API shape (reconciler close-sync was keying on a field the real
API never populates; the transactions bootstrap page-vs-body bug meant the
high-water mark never advanced; the watchdog had an undeclared `zod` import
that would break its isolated Docker build). BE-054 (trades REST) is deferred
to Phase 5.

**Step 2.3 — Deterministic quant core (QN-040…048).** New `services/quant/app/quant/`:
point-in-time feature pipeline + DST-aware sessions/rollover/gap flags
(QN-040/047), 3-state Gaussian HMM trend regime + separate liquidity regime
(QN-041), vol-target/fractional-Kelly/FCA-leverage sizing ladder (QN-042/044),
walk-forward LightGBM meta-model with OOF calibration and a champion/challenger
model registry with drift monitoring (QN-043/046), an always-on shadow
baseline that doubles as the Phase-2 candidate generator (QN-045), and
correlation clustering with weekly + event-triggered refresh (QN-048). The
QuantService gRPC RPCs (`RunPipeline`/`SizePosition`/`Predict`) are real now —
the Phase-1 `UNIMPLEMENTED` stubs are gone. **Train-on-demand policy:** no
model ships committed; until an operator trains and promotes one, `RunPipeline`
deterministically returns `has_candidate=false` (HOLD) rather than trading on
an untrained model.

**Cross-cutting (BE-140/141/142).** OTel tracing (Node + Python, no-ops unless
`OTEL_EXPORTER_OTLP_ENDPOINT` is set), Grafana dashboard + 6 alert rules with
Telegram/SMS routing, and restic backups with a documented restore drill.

**Automated coverage already exercised in the sandbox (Python 3.10 + shims —
not the real 3.13 env):** 56 tests (Step 2.1) → 101 tests (Step 2.2 + audit) →
230 tests (Step 2.3, +129 new). `ruff check` clean. `mypy` clean as of today.
None of this has run against the *real* 3.13 venv, a real Postgres/Timescale
instance, or a real OANDA practice account yet — that's the point of this
document.

## 2. The gap: what "code complete" hasn't proven yet

Everything below is untested against real infrastructure. Some of it (the
Prisma migration files) already exists in the working tree as **untracked**
files — `git status` currently shows
`apis/node-api/prisma/migrations/20260707235526_step_2_3_quant_core/` and
`services/quant/app/quant/` / `services/quant/tests/quant/` as untracked, plus
a long list of modified-but-uncommitted files. None of Step 2.3 is committed
yet, and this session's mypy fixes add to that pile. Commit this before
starting Phase 3 (see §5) — an agent-driven Phase 3 will be much harder to
debug against a dirty, half-committed Phase 2.

## 3. Test plan, in order

Run these roughly in sequence — later steps assume earlier ones passed.

### A. Real-environment static checks (fast, no infra needed)

```sh
cd services/quant
uv lock && uv sync --dev        # installs numpy/pandas/scipy/sklearn/lightgbm/
                                 # hmmlearn/ta-lib for real on 3.13 — ta-lib 0.6+
                                 # wheels bundle the C lib; `brew install ta-lib`
                                 # first if no wheel matches your platform
uv run ruff check .
uv run mypy .                   # just fixed — should be clean; re-run to confirm
uv run pytest                   # expect 230 passed
```

If `uv sync` can't resolve or a wheel is missing, don't hand-fix `uv.lock` —
that's exactly the kind of generated file the project's CLAUDE.md flags as
something to run through the real tool, not hand-edit.

```sh
# repo root
pnpm install
pnpm typecheck   # turbo run typecheck — @fx/node-api, @fx/dashboard, @fx/watchdog, packages/*
pnpm lint        # Biome
pnpm test        # Vitest — expect 74 (@fx/node-api) + 3 (@fx/watchdog) passing,
                 # unverified since Step 2.2 (sandbox can't run Vitest's native deps)
```

### B. Database migration

```sh
cd apis/node-api
pnpm exec prisma migrate reset          # dev-only, destructive — drops + recreates
pnpm exec prisma migrate dev --name step_2_3_quant_core
pnpm db:timescale                       # re-applies timescale.sql (hypertables/CAGGs/pgvector)
```

Since the `20260707235526_step_2_3_quant_core` migration folder already exists
untracked in the tree, `migrate dev` may just detect it's already applied — if
so, confirm with `pnpm exec prisma migrate status` (expect "Database schema is
up to date"). Then eyeball the two new tables:

```sh
pnpm exec prisma studio   # or: psql $DATABASE_URL -c '\d model_registry' -c '\d correlation_clusters'
```

### C. Local stack boot

```sh
docker compose -f infra/docker-compose.local.yml stop quant worker-execution worker api

# 1. infra only — TimescaleDB + Redis (published on 127.0.0.1:5432 / :6379)
docker compose -f infra/docker-compose.local.yml up -d db redis

# 1b. one-time: seed OANDA practice creds into the DB
#     needs OANDA_API_TOKEN + OANDA_ACCOUNT_ID + CREDENTIALS_ENCRYPTION_KEY in root .env
pnpm seed:creds

# 2. quant gRPC service on the host (FastAPI lifespan binds :50051)
cd services/quant && uv run python -m app
#    reads root .env → DATABASE_URL, CREDENTIALS_ENCRYPTION_KEY, OANDA_*

# 3. execution worker on the host (new terminal) — has the [exec] logs
pnpm --filter @fx/node-api worker:execution
#    expect: [exec] worker ready — listening on 'execution'

# 4. fire (new terminal)
pnpm --filter @fx/node-api enqueue-intent -- EUR_USD long 1000 1.1432 1.1420 1.1450
```

## To run fully in docker:

```sh
pnpm stack:build          # rebuild images so the [exec] logging is in the worker's dist/ too
pnpm seed:creds           # one-time — seeds the docker DB (skip if the volume already has creds)
pnpm stack:up
pnpm stack:ps             # quant, worker-execution, db, redis all Up
curl -sf localhost:5001/healthz
pnpm --filter @fx/node-api enqueue-intent -- EUR_USD long 1000 1.1432 1.1420 1.1450
docker compose -f infra/docker-compose.local.yml logs -f worker-execution   # watch the [exec] lines
```

### D. Paper broker round-trip (needs a real OANDA practice account)

This is the Phase-2 exit criterion ("paper orders round-trip on OANDA with
reconciler clean") — nothing above actually proves it since all prior test
runs used `FakeOanda`.

1. Seed real practice creds: `OANDA_API_TOKEN` / `OANDA_ACCOUNT_ID` in `.env`
   (practice environment), then `pnpm seed:creds`.
2. Start the workers: `pnpm --filter @fx/node-api worker:execution` (and
   `worker:market-data` if not already running via `pnpm dev`).
3. Fire a trade: `pnpm --filter @fx/node-api enqueue-intent -- EUR_USD long 1000 <entry> <stopLoss> <takeProfit>`
   (small size — this hits your real practice account). Confirm: a fill row
   appears in `trade_intents`/executions, a supervision job is enqueued, and
   the position shows up in the OANDA practice UI.
4. Let the **reconciler** run a cycle (60 s) — check logs for a clean tick, no
   `missing_at_broker` or mismatch halt.
5. Let the **trade manager** run — verify breakeven/trailing behavior if the
   trade moves, and confirm SL is never widened.
6. Close the trade (manually via OANDA UI or a close script) and confirm the
   reconciler picks up `tradesClosed` and records realized P&L correctly (this
   was the specific bug fixed in the 2026-07-07 audit — worth deliberately
   checking).

### E. Quant pipeline end-to-end (train → shadow → promote → trade)

Until a champion model is promoted, `RunPipeline` always returns HOLD — this
step proves the ML path, not just the deterministic scaffolding.

```sh
cd services/quant
uv run python -m app.market backfill                 # QN-021: 6-month H1 candle backfill → Timescale
uv run python -m app.quant train --instrument EUR_USD --timeframe H1
# registers a challenger; verify metadata.json / calibrator.json / model.txt
# under var/models/EUR_USD/H1/v1/, and a row in model_registry (role=challenger)
```

Let the pipeline shadow-score the challenger for ≥100 bars (each `RunPipeline`
call on a new bar bumps `shadow_count`), then:

```sh
uv run python -m app.quant promote --instrument EUR_USD --timeframe H1 --version 1
```

`promote` refuses below `min_shadow=100` without `--force` — don't force it in
anything but a deliberate smoke test, the gate exists to keep untested models
off the champion slot. After promotion, call `RunPipeline` again (via the
gRPC client or a Node-side smoke script) and confirm `has_candidate=true` with
a real `challenger_probability`, sizing (`risk_amount`, `caps_applied`), and
bracket zones — this is the "calibrated, sized candidates" half of the Phase-2
exit criterion.

### F. Correlation clusters

```sh
uv run python -m app.quant clusters --trigger manual
```

Confirm a versioned row lands in `correlation_clusters` with plausible
`|Pearson|` groupings (majors should cluster; verify against known FX
correlations you'd expect, e.g. EUR/GBP).

### G. Observability

- Bring up the `observability` compose profile, confirm Tempo/Prometheus/Grafana
  boot, open the `fx-operations` Grafana dashboard (:3001) and confirm panels
  populate (not just NoData) once the workers are running.
- Trigger one of the 6 alert rules deliberately (e.g. pause a worker to trip a
  queue-backlog alert) and confirm Telegram/SMS delivery — this was flagged
  NOT verified in the devlog.
- Set `OTEL_EXPORTER_OTLP_ENDPOINT` and confirm a trace spanning Node → gRPC →
  Python shows up in Tempo (proves the BE-140 propagation actually links, not
  just that each side no-ops cleanly).

### H. Backups

```sh
infra/backup/backup.sh          # manual run; check restic snapshot created
infra/backup/restore-drill.sh   # restores into a throwaway container, verifies
                                 # hypertables/CAGGs/pgvector, appends drill-log.md
```

Confirm the drill log shows an RPO/RTO within the targets in `BACKUP.md`.

### I. Watchdog off-host deploy

Deploy `workers/watchdog` on infrastructure separate from the main Swarm host
per its README (`cp .env.example .env`, fill `WATCHDOG_OANDA_TOKEN` +
`PLATFORM_HEARTBEAT_URL`, `pnpm build && pnpm start` or the Docker image).
Then deliberately kill the main stack's execution worker and confirm: the
watchdog logs `degraded` and sends one Telegram/SMS alert without flattening;
killing the whole host (or blocking heartbeat entirely) past
`WATCHDOG_TIMEOUT_MISSES` consecutive misses triggers a real flatten against
the practice account, confirmed broker-side.

```sh
# full stack + observability on one network so api:4000 is scrapeable
pnpm stack:up
docker compose -f infra/docker-compose.local.yml --profile observability up -d
# Grafana http://localhost:3001  (admin / admin — GRAFANA_ADMIN_PASSWORD is empty → default)
# Prometheus http://localhost:9090/targets  → fx-node-api must be UP before panels fill
```

set OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318 (compose services) or http://localhost:4318 (bare pnpm dev), restart api + worker + quant, then trigger a signal evaluation. The gRPC call links Node→quant even though RunPipeline returns HOLD on an untrained model (the traceparent propagates regardless of the HOLD result), so the trace still appears — query it in Grafana → Explore → Tempo.
 
```sh
pnpm --filter @fx/node-api trip-signals            # 30 jobs → warning (>10) + critical (>25)
pnpm --filter @fx/node-api trip-signals -- 15      # warning only
pnpm --filter @fx/node-api trip-signals -- --clean # drain, alert resolves
```

Two things to get right when you run it: point REDIS_URL at the same Redis the scraped api reads (for the dockerised stack that's the published redis://127.0.0.1:6379), and remember the alert only actually delivers once you've filled the Telegram/SMS secrets in .env and recreated the Grafana container — otherwise it fires in the UI but sends nothing. Wait ~1 min after tripping for the critical rule, ~2 min for the warning.

I added a matching trip-signals entry to apis/node-api/package.json. Want me to also jot the two non-obvious findings (no signals consumer; notification secrets empty) into the testing guide so section G reflects them?

### J. Dashboard visual check (carried over from Phase 1, still open)

```sh
pnpm --filter @fx/ui test
pnpm --filter @fx/dashboard typecheck
pnpm dev
```

Open `/dashboard` and eyeball theme, `ModeBadge`, kill-switch dialog — this
has never been visually confirmed, only typechecked.

### K. Git hygiene

`git status` currently shows the entire Step 2.3 diff uncommitted (plus this
session's mypy fixes) and the local branch reports "up to date with
origin/main" with no ahead/behind marker — suggesting the 2026-07-05 history
rewrite's `git push --force-with-lease` already landed. Confirm on GitHub
directly (branch protection, commit SHA match) rather than trusting local
state alone, then commit and push the Step 2.3 work as its own step, referencing
QN-040…048 in the message per this repo's convention.

## 4. Mapping back to the Phase-2 exit criteria (`FX_PRD.md` §8)

| Exit criterion | Proven by |
|---|---|
| Paper orders round-trip on OANDA with reconciler clean | §3.D (not yet run — needs real practice creds) |
| Quant pipeline emits calibrated, sized candidates | §3.E (not yet run — needs a trained + promoted model) |
| Baseline logging P&L | Already true structurally (`baseline_signals` written every bar in every mode, §Step 2.3) — confirm rows are actually accumulating during §3.D/E and that `comparison_metric` (baseline expectancy vs agent-trade R) looks sane once Phase 3 exists to compare against |

Until §3.D and §3.E have actually been run once against real OANDA + a real
DB, Phase 2's exit criteria are implemented but not demonstrated.

## 5. Before starting Phase 3

Two corrections to the "Next" line in `DEVLOG_phase2.md`'s current-state
block: BE-068 (gRPC circuit breaker) and BE-070…073 (risk gate, correlation
cap, kill-switch) are **Phase 3** stories per `FX_PRD.md` §8 (Step 3.1 and
3.3), not Phase-2 remainder — they depend on the agent graph existing, so
there's no way to build them before Phase 3 starts anyway. Phase 3 itself
opens with Step 3.1 (BE-060 LLM provider factory, BE-061 prompt registry,
BE-069 agent context contracts) before the breaker/risk-gate work.

Recommended order: finish §3.A–§3.C here (cheap, no external creds), commit/push
per §3.K, then decide how much of §3.D–§3.J you want done before or in
parallel with starting Phase 3 — none of them technically block writing
Phase-3 code, but §3.D and §3.E are the only things that actually prove Phase
2 works end-to-end rather than just "the tests pass against fakes."
