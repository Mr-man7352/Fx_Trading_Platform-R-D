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

## Current state (updated 2026-07-05)

- **Done (Phase 2):** nothing yet — Phase 1 is code-complete (see DEVLOG.md;
  pending human actions there: `pnpm install`, `uv lock`, test suites, plus the
  Step-1.7 visual check).
- **Next:** Step 2.1 — Broker abstraction & execution adapters:
  - QN-030 — typed `BrokerAdapter` interface
  - QN-032 — OANDA v20 adapter (primary execution venue, ADR-005)
  - QN-033 — symbol mapping table (seeded by the BE-045 instrument registry)
  - QN-034 — cross-currency pip/lot/margin module
  - QN-031 — MT5 adapter (optional, off critical path; mock conformance in CI)
- **Then:** Step 2.2 — order lifecycle & reconciliation (BE-050…054), Step 2.3
  — deterministic quant core (QN-040…048).
- Cross-cutting still open from Phase 1: BE-140…142 (OTel, dashboards/alerts,
  restic backups).

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

*(none yet)*

---

*Template for new entries:*

```
### YYYY-MM-DD — Step X.Y: <name> (story IDs)

- <what was added/changed, file paths>
- <decisions made + why, if any>
- Verified: <what was actually run/tested; note anything NOT verified>
```
