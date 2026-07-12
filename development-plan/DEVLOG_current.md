# DEVLOG — Phase 4 (Lifecycle)

Continuation of [`DEVLOG_phase3.md`](DEVLOG_phase3.md) (the Phase-3 record —
Intelligence; per-step build history lives there) and, before it,
[`DEVLOG_phase2.md`](DEVLOG_phase2.md) and [`DEVLOG-phase1.md`](DEVLOG-phase1.md).
The **Standing decisions** and **Conventions** carried through Phases 1 → 3 are
carried forward in full below and remain the *current* single source of truth —
no need to cross-read the earlier logs for them. Same rules: **append a new
entry per step; keep "Current state" at the top updated.** Plan:
[`FX_PRD.md`](FX_PRD.md) §8 Phase 4, stories in `FX_Stories_*.md`, architecture
in `system-design/FX_System_Design.md`.

**Phase 4 outcome:** open trades supervised; reproducible backtests including
agentic runs.
**Exit criteria:** a backtest replays deterministically; the agentic runner
matches the quant core on the quant-only path; ablations runnable.

---

## Current state (updated 2026-07-12)

- **Phase 3 is CODE-COMPLETE but NOT runtime-tested.** All Step 3.1/3.2/3.3
  code shipped and is tsc-verified, but nothing has been installed, migrated,
  built, unit-tested, or drilled on a real machine, and no live LLM/broker
  round-trip has ever run. Full record + per-step build history in
  [`DEVLOG_phase3.md`](DEVLOG_phase3.md); ordered runtime plan in
  [`PHASE3_TESTING_GUIDE.md`](PHASE3_TESTING_GUIDE.md). **These proofs are a
  hard prerequisite for the Phase-4 backtest work** (the vectorbt engine and
  the agentic runner both ride the Phase-3 gate→agents→risk-gate path — close
  that loop before trusting any backtest output).
- **Outstanding Phase-3 human actions (carried forward, must clear first):**
  1. `pnpm install` (lockfile + node_modules for new `@fx/risk-gate`).
  2. `npx prisma generate` then `npx prisma migrate dev --name
     step_3_3_kill_switch` in `apis/node-api` (additive — one new
     `kill_switch_state` table). Step 3.1/3.2 migrations were already run by the
     operator (`step_3_1_agent_run_provenance`, `step_3_2_agent_graph`).
  3. `pnpm --filter @fx/types build && pnpm --filter @fx/risk-gate build`
     (+ `@fx/llm` build if not already done — node-api resolves these via dist
     at runtime).
  4. Root `pnpm typecheck / test / lint` (Vitest never ran in the sandbox —
     ~46 new Step-3.3 cases + all Step-3.2 suites incl. the 28-fixture red-team
     suite are unrun).
  5. Runtime drill per [`PHASE3_TESTING_GUIDE.md`](PHASE3_TESTING_GUIDE.md):
     risk-gate E2E, kill-switch <2s timed activate, and the Redis-flush chaos
     check (ADR-012).
  6. **Commit Step 3.3** (still uncommitted) — suggested:
     `feat(risk): Step 3.3 deterministic risk gate & kill-switch (BE-070..073)`.
     Steps 3.1/3.2 are committed (`8ef34fe` / `975c2c8`).
- **Carried-forward known issue (from Phase 2, now blocks Phase-4 evidence):**
  the only trained model `XAU_USD/H1 v1` has **no predictive edge** — OOF AUC
  0.51, brier_cal 0.23, trained on ~6 months / 2,121 candidates. It is a
  plumbing/smoke artifact only. **Retrain on ≥18 months H1** (via the
  train→promote flow, `PHASE2_TESTING_GUIDE.md` §E) before any backtest or
  ablation result is treated as meaningful — a champion with `has_candidate=true`
  is what makes the agent graph (and therefore the agentic backtest runner)
  actually fire.
- **Known seams deliberately open (from Phase 3, several are Phase-4 targets):**
  - **Economic calendar:** no vendor wired — the blackout rule records
    'unavailable' and passes. QN-051 (PIT news/sentiment in backtests) and live
    trading want a real `CalendarProvider`; the NFP fixture defines expected
    behaviour.
  - **Dashboard kill-switch button:** visible no-op until Phase-5 auth (FE-033);
    the API is the operator interface for now.
  - **2FA:** `twoFactorCode` accepted + audited but unverified until BE-036
    (Phase 5); activation is never blocked on it.
  - **Broker equity sync:** account state = `ACCOUNT_BASELINE_EQUITY` + realized
    P&L. Fine for paper/backtest; revisit before live.
- **Next:** clear the Phase-3 runtime gate above, then open Phase 4 with the
  supervision loop (BE-080/081) and the backtest harness (QN-050…). Per the
  PRD build order and PHASE3_TESTING_GUIDE §6, the vectorbt engine needs the
  live champion-model flow working, so validate that first.

## Phase 4 scope (from `FX_PRD.md` §8 — build order)

**Step 4.1 — Supervision**
- BE-080 — Supervision queue + deterministic gate (LLM only on material change).
- BE-081 — Layered exit system.

**Step 4.2 — Backtesting & validation harness**
- QN-050 — vectorbt backtest engine (quant-core path; spread/slippage/swap/
  rollover/gap modelled; P-threshold sweep 0.55–0.70, target 0.60).
- QN-051 — Point-in-time news/sentiment in backtests (`published_at <= bar_ts`
  leakage test).
- QN-056 — Event-driven agentic backtest runner (strictly sequential bars;
  incremental deterministic memory rebuild; **same LangGraph code path** via
  `TRADING_MODE=backtest`; reconciles vs vectorbt on the quant-only path).
- QN-052 — Three execution modes (quant-only, cached-LLM, live-LLM); cache keyed
  on (prompt template version + full input bundle incl. `retrieved_memory_ids`).
- QN-053 — Purged/embargoed OOS validation suite (purged CV, deflated Sharpe, MC
  drawdown, bootstrap p-value → `NOT VALIDATED` blocks live promotion).
- QN-054 — Ablation harness (quant-only vs +sentiment vs +full; debate-round
  sweep 0/1/2 × regime-uncertainty; memory on/off).
- QN-055 — REST endpoints for calibration & regime (`/models/{id}/calibration`,
  `/regime/{instrument}`). *(PRD tags this Phase 5; built here if convenient —
  confirm ordering.)*
- BE-090 — Backtest trigger + results API (`POST /backtests`, `GET
  /backtests/:id` → metrics, OOS split, validation verdict, ablation).
- FE-080 — Backtest config + results UI.

**Suggested build order:** BE-080 → BE-081 (supervision first — smallest, rides
existing paper path), then QN-050 (vectorbt core, the dependency root for the
rest), QN-051, QN-053, then QN-056 (agentic runner, depends on QN-050 +
BE-062/064/066), QN-052/QN-054 (modes + ablation on top of the runner), then
BE-090 + FE-080 to surface results. QN-055 is a small analytics-endpoint add.

## Phase-4 specific context (seams already built in earlier phases)

- **Single code path (design principle #2):** the LangGraph graph that QN-056
  drives in backtest is the SAME code as paper/live — selected by
  `TRADING_MODE=backtest` (BE-003, one env flag everywhere). No forked backtest
  graph. The agentic runner must rebuild memory incrementally (empty at bar 0,
  reflections written as the run progresses) and **never read live memory**.
- **Entry gate (ADR-010) is reused in backtest:** `gate_skip` bars must incur
  zero LLM/cache calls in the runner too; gate-skip rate is a reported metric
  (QN-056 AC). The gate already exists in the signals worker (BE-066) and the
  supervision gate (BE-080) mirrors it — LLM only on material change.
- **Deterministic quant core stays the reconciliation anchor:** QN-050's
  vectorbt engine is the quant-core-only path; QN-056's runner must reconcile
  its quant-only configuration against it within tolerance (correctness
  cross-check). No LLM ever touches `app/quant/` (§10) — agents refine/confirm/
  veto, they don't generate numbers.
- **Cost-model inputs already exist:** DST-aware session/rollover/gap flags and
  spread/liquidity labels (QN-047), correlation clusters (QN-048), and the
  calibrated `challenger_probability` all land in the pipeline result the
  backtest engine consumes. Wednesday triple-swap (XAU) and weekend-gap
  beyond-stop behaviour are already modelled deterministically in the risk gate;
  QN-050 must model them on the P&L side.
- **Risk gate is the final authority in backtest too:** `packages/risk-gate`
  `DeterministicRiskGate` is pure and fixture-driven — the backtest runner feeds
  it a `RiskGateContext` per bar exactly as the live worker does. Kill-switch /
  halt state is not exercised in backtest but the gate's other §10 rules are.
- **Supervision inputs:** open trades live in `trade_intents`/`trades`; the
  layered exit system (BE-081) and supervision gate (BE-080) act on open
  positions and the same gRPC execution channel the kill-switch close-out uses.
- **Memory reproducibility:** `agent_memory` write/merge/cap logic (BE-064) is
  already code-deterministic (reflections composed by CODE, not an LLM;
  embedding provider env-pinned per row). QN-052 cached-LLM reproducibility
  depends on this holding — cache key MUST include `retrieved_memory_ids`.

## Standing decisions (carried from Phases 1–3 — don't re-litigate without cause)

- **DB image:** `timescale/timescaledb-ha:pg18-ts2.28` — community TimescaleDB
  (CAGGs/compression/retention) + pgvector. Identical image dev and prod; prod
  runs OUTSIDE the Swarm stack on a dedicated Hetzner volume (ADR-006 rev.).
- **Quant service:** `services/quant` is a uv-managed Python 3.13 FastAPI +
  gRPC service (Step 1.5). One process serves both planes: REST `:5001`
  (`/healthz`; moved off 5000 — see Conventions), gRPC `:50051` (std
  `grpc.health.v1` + the now-real QuantService RPCs). Its `package.json` exists
  only so turbo `dev` boots it (`uv run python -m app`) — Python deps are never
  managed by pnpm; lint/type/test run via uv in the CI `quant` job, not turbo.
  Generated code (`app/contracts/`, `app/proto_gen/`) is committed and
  drift-checked; regenerate via `scripts/gen_contracts.py` +
  `scripts/gen_proto.py`, never hand-edit.
- **`TRADING_MODE`** (`backtest|paper|live`): one env flag, one identical code
  path everywhere (BE-003) — this is the mechanism QN-056 uses to run the live
  graph in backtest. Env validation is fail-fast Zod in
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
- **DB schema:** Prisma migrations = relational DDL only; every
  Timescale/pgvector-index object goes in `apis/node-api/prisma/timescale.sql`
  (idempotent, applied by `pnpm db:timescale` after `db:deploy`) — NEVER in a
  migration, or the CI drift check breaks. Destructive migration SQL needs a
  `-- destructive-ok: <reason>` marker. Credential envelope format is
  `v1:base64(iv‖tag‖ct)` AES-256-GCM — Python quant matches it. **Migration
  files are generated, never hand-written** (project CLAUDE.md): run
  `prisma migrate dev`; ask the operator to run it if the sandbox can't.
- **FinBERT (`uv sync --group ml`):** the BE-062 sentiment-analyst node is the
  first real consumer; still mock until that node actually reads scores.
  Sentiment *accuracy* is first exercised by the Phase-4 backtests
  (QN-051/QN-054), so this is where real FinBERT may finally be needed.
- **Deterministic quant core stays LLM-free (§10):** no LLM ever touches
  `app/quant/` — agents *refine/confirm/veto* the quant candidate, they don't
  generate the numbers. The graph fires only on quant candidates (ADR-010) and
  the risk gate (BE-070) is the final deterministic authority. This invariant is
  what makes the QN-056 quant-only reconciliation against QN-050 possible.

## Conventions (carried from Phases 1–3)

- pnpm 9 (corepack) + Turborepo; Node 22 (`.nvmrc`); Biome for lint/format; Vitest.
- Workspaces: `apps/*`, `apis/*`, `packages/*`, `workers/*`, `services/*`.
- Story IDs (FE-/BE-/QN-###) referenced in code comments and commits — keep doing this.
- Root scripts: `pnpm dev` (env-check then all services), `pnpm stack:up|down|ps`
  (compose), `pnpm build|test|lint|typecheck|check-env`.
- **Quant HTTP port is 5001** (moved from 5000 on 2026-07-04): macOS AirPlay
  Receiver squats on 5000 and broke `pnpm dev`. Changed everywhere so dev = prod.
  Local `.env` files need `QUANT_PORT=5001` + `QUANT_URL=http://localhost:5001`.
- **Commit only when asked** — never `git commit`/`push` unprompted; the user
  controls commit timing.
- **Don't hand-fabricate generated output** — if the sandbox can't run the real
  tool (`uv lock`, `prisma generate/migrate`, proto/contract codegen), ask the
  user to run it rather than reconstructing the file by hand.

## Entries

<!-- Append Phase 4 step entries below, newest first. -->

---

*Template for new entries:*

```
### YYYY-MM-DD — Step X.Y: <name> (story IDs)

- <what was added/changed, file paths>
- <decisions made + why, if any>
- Verified: <what was actually run/tested; note anything NOT verified>
```
