# DEVLOG — Phase 3 (Intelligence)

> **ARCHIVE (Phase 3 code-complete 2026-07-10 — NOT yet runtime-tested).** This
> file is now the frozen Phase-3 record; its successor Phase 4 is likewise
> frozen in [`DEVLOG_phase4.md`](DEVLOG_phase4.md) (Lifecycle) and live
> development continues in [`DEVLOG_current.md`](DEVLOG_current.md) (Phase 5 —
> Surface). The Standing decisions + Conventions below are carried forward
> through those later logs as the single live source of truth. **Phase-3's runtime proofs and pending human
> actions are still OUTSTANDING** — the code shipped but nothing was installed,
> migrated, built, tested, or drilled (see the Current state section below and
> [`PHASE3_TESTING_GUIDE.md`](PHASE3_TESTING_GUIDE.md)); Step 3.3 is also still
> uncommitted.

Continuation of [`DEVLOG_phase2.md`](DEVLOG_phase2.md) (the Phase-2 record —
Execution & Quant; per-step build history lives there) and, before it,
[`DEVLOG-phase1.md`](DEVLOG-phase1.md). The **Standing decisions** and
**Conventions** carried through Phase 1 → Phase 2 are carried forward in full
below and remain the *current* single source of truth — no need to cross-read
the earlier logs for them. Same rules: **append a new entry per step; keep
"Current state" at the top updated.** Plan: [`FX_PRD.md`](FX_PRD.md) §8 Phase 3,
stories in `FX_Stories_*.md`, architecture in
`system-design/FX_System_Design.md`.

**Phase 3 outcome:** multi-agent stack confirms/vetoes quant candidates;
deterministic risk gate + kill-switch < 2 s.
**Exit criteria:** end-to-end paper cycle bar-close → gate → agents → risk gate
→ order; kill-switch flattens broker-confirmed in < 2 s; red-team suite green.

---

## Current state (updated 2026-07-10)

- **Phase 2 is code-complete and (per user) tested** — Step 2.1 (QN-030…034),
  Step 2.2 (BE-050…053, audited + fixed 2026-07-07), Step 2.3 (QN-040…048).
  Full record in [`DEVLOG_phase2.md`](DEVLOG_phase2.md); pre-Phase-3 checklist
  in [`PHASE2_TESTING_GUIDE.md`](PHASE2_TESTING_GUIDE.md). QuantService gRPC
  RPCs (RunPipeline/SizePosition/Predict) are REAL; shadow baseline runs every
  bar; train-on-demand policy holds (no champion ⇒ deterministic HOLD).
- **Step 3.1 (LLM plumbing) COMPLETE** — committed `8ef34fe`; its pending
  actions (install, @fx/types build, `step_3_1_agent_run_provenance`
  migration) were run by the operator 2026-07-09.
- **Step 3.2 (agent graph) COMPLETE** — committed `975c2c8`; migration
  `step_3_2_agent_graph` exists in `prisma/migrations/` (operator ran it).
- **Step 3.3 (risk gate & kill-switch) code-complete 2026-07-10** — BE-070
  `packages/risk-gate` pure rule engine (all §10 rules, DST-aware via Intl,
  all-rules-always-evaluated audit record), BE-071 correlation cap
  (consumes latest QN-048 row; env-csv exemptions, audited), BE-072
  `POST /settings/kill-switch` (state-first sequence, cancel+close+broker-
  confirm, escalating alerts, 2FA seam for BE-036), BE-073 `KillSwitchStore`
  (Postgres source of truth, Redis cache-only, boot + cache-miss
  re-hydration; new `kill_switch_state` table). The worker's fail-safe
  `NotImplementedRiskGate` is REPLACED by `DeterministicRiskGate` — agent
  APPROVEs can now execute, gated by the deterministic authority.
  tsc-verified clean — **pending human actions in the Step 3.3 entry:
  pnpm install, prisma migrate `step_3_3_kill_switch`, @fx/types +
  @fx/risk-gate builds, root test/typecheck/lint, runtime drill
  (PHASE3_TESTING_GUIDE.md), commit.**
- **Phase 3 exit criteria status:** all code shipped; the three runtime
  proofs (end-to-end paper cycle through gate→agents→risk-gate→order,
  kill-switch broker-confirmed <2s, red-team suite green in CI) are
  operator actions — ordered plan in
  [`PHASE3_TESTING_GUIDE.md`](PHASE3_TESTING_GUIDE.md).
- **Known seams deliberately open (not Phase-3 blockers):** economic
  calendar vendor (blackout rule notes 'unavailable'); dashboard
  kill-switch button stays a no-op until Phase-5 auth (FE-033); live
  broker equity sync (account state = baseline + realized P&L).
- **Carried-forward known issue (from Phase 2, defer):** first trained model
  `XAU_USD/H1 v1` has **no predictive edge** — OOF AUC 0.51, brier_cal 0.23,
  trained on only ~6 months / 2,121 candidates. Plumbing/smoke artifact only;
  do NOT treat as tradeable. Retrain on ≥18 months H1 once the train→promote
  flow (`PHASE2_TESTING_GUIDE.md` §E) is validated end-to-end.
- **Carried-forward pending human actions (unchanged from Phase 2 close):**
  Prisma `migrate reset` + `migrate dev --name step_2_3_quant_core` (dev-only,
  destructive; migration folder exists untracked); `uv lock && uv sync --dev`
  on real 3.13 then `uv run pytest/mypy/ruff`; root `pnpm test/typecheck/lint`
  (Vitest still unverified in sandbox); real-OANDA paper round-trip; off-host
  watchdog deploy; `/dashboard` visual check; commit + push the still-
  uncommitted Step 2.3 diff before growing the Phase-3 pile. See
  `PHASE2_TESTING_GUIDE.md` §3 for the full ordered plan.
- **Next:** run the Step 3.3 pending human actions (install/migrate/build/
  test — listed in the entry below), work through
  `PHASE3_TESTING_GUIDE.md`, commit. Then Phase 4 (backtesting &
  validation: QN-050…, BE-080/081 supervision + layered exits).

## Phase 3 scope (from `FX_PRD.md` §8 — build order)

**Step 3.1 — LLM plumbing**
- BE-069 — Agent context contracts in `@fx/types` (do first; the rest validate against them).
- BE-060 — LLM provider factory + failover (one fallback attempt, 10 s cap).
- BE-061 — Prompt registry + model snapshot pinning.
- BE-068 — gRPC circuit breaker (Node → Python).

**Step 3.2 — Agent graph**
- BE-074 — Context assembler (headlines, memories, feature partitions; validates contracts pre-invocation).
- BE-062 — LangGraph domain specialists (parallel) + debate + consensus; deterministic PM digest (ADR-011).
- BE-064 — Agent memory with vector retrieval; outcome-linked reflection on trade close; hygiene + embedding versioning; `retrieved_memory_ids` stored.
- BE-063 — Prompt-injection hardening + red-team suite (≥ 20 patterns incl. memory-persistence attacks) in CI.
- BE-065 — Disagreement cohort logging.
- BE-066 — Signals worker: deterministic entry gate (graph fires only on quant candidates, ADR-010), per-stage sub-budgets, concurrency cap 3.
- BE-067 — Signals REST + WS fanout.

**Step 3.3 — Risk gate & kill-switch**
- BE-070 — `packages/risk-gate` rule engine (final authority; P ≥ 0.60, daily-loss halts, DST-aware Friday close).
- BE-071 — Correlation clustering cap (consumes QN-048 clusters).
- BE-072 — Master kill-switch API (< 2 s; step-up 2FA activates when BE-036 lands).
- BE-073 — Kill-switch state persistence: Postgres source of truth, Redis cache, close-out partial-failure handling (ADR-012).

## Phase-3 specific context (seams already built in earlier phases)

- **Breaker → HOLD is already contracted:** Node's gRPC path treats
  UNIMPLEMENTED / errors as HOLD (QN-004 stubs did this; the real RPCs now
  return FAILED_PRECONDITION on no-champion). BE-068 formalizes this with a
  circuit breaker — no new HOLD semantics to invent.
- **Entry gate (ADR-010):** the agent graph fires ONLY on quant candidates —
  `RunPipeline` `has_candidate=true`. Until a champion model is promoted this is
  always false, so BE-066 wiring can be built and unit-tested against fixtures
  before a real model exists.
- **Sentiment (QN-022):** signed scores are stored but unread — the Phase-3
  **sentiment analyst** node (BE-062) is the first real consumer. This is where
  FinBERT (`uv sync --group ml`) may finally be needed; keep it mock until the
  node actually reads scores, and note *accuracy* isn't exercised until
  QN-051/QN-054 (Phase 4 backtests).
- **Risk gate inputs already exist:** `DataQualityMonitor.degradedInstruments()`
  (BE-044) blocks execution on degraded feeds; QN-048 `correlation_clusters`
  (latest versioned row) feeds BE-071's correlation cap; the P≥0.60 threshold
  comes from the calibrated `challenger_probability` on the candidate.
- **Kill-switch UI seam (FE-011, Phase 1):** `<KillSwitchButton>` already has
  the `requireTwoFactorCode` prop + `twoFactorCode` onConfirm arg; BE-072 wires
  the API, BE-036 (Phase 5) flips 2FA on — contract unchanged.
- **Agent memory table:** `agent_memory.embedding vector(1536)` exists from Step
  1.4 (pgvector HNSW index in `timescale.sql`); write via `$executeRaw`. BE-064
  is its first real writer/reader.

## Standing decisions (carried from Phases 1–2 — don't re-litigate without cause)

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
- **DB schema:** Prisma migrations = relational DDL only; every
  Timescale/pgvector-index object goes in `apis/node-api/prisma/timescale.sql`
  (idempotent, applied by `pnpm db:timescale` after `db:deploy`) — NEVER in a
  migration, or the CI drift check breaks. Destructive migration SQL needs a
  `-- destructive-ok: <reason>` marker. Credential envelope format is
  `v1:base64(iv‖tag‖ct)` AES-256-GCM — Python quant matches it. **Migration
  files are generated, never hand-written** (project CLAUDE.md): run
  `prisma migrate dev`; ask the operator to run it if the sandbox can't.
- **FinBERT (`uv sync --group ml`):** still mock through the start of Phase 3;
  the BE-062 sentiment-analyst node is the first real consumer. Install torch
  only when that node actually reads scores.
- **Deterministic quant core stays LLM-free (§10):** no LLM ever touches
  `app/quant/` — agents in Phase 3 *refine/confirm/veto* the quant candidate,
  they don't generate the numbers. The graph fires only on quant candidates
  (ADR-010) and the risk gate (BE-070) is the final deterministic authority.

## Conventions (carried from Phases 1–2)

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

<!-- Append Phase 3 step entries below, newest first. -->

### 2026-07-10 — Step 3.3: Risk gate & kill-switch (BE-070, BE-071, BE-072, BE-073)

Phase 3 is now **code-complete**. The worker's fail-safe `NotImplementedRiskGate`
seam is replaced by the real deterministic authority; agent APPROVEs can now
reach the execution queue — but only through the §10 rule engine.

- **BE-070 — rule engine** (new `packages/risk-gate`, dep-light: only
  @fx/types): PURE engine — every fact arrives in `RiskGateContext`, gathered
  by the node-api adapter, so each rule/combination unit-tests with plain
  fixtures. **All rules evaluate on every call** (no short-circuit) so the
  persisted `checks` record is complete for audit; verdict = first failing
  rule in §10 order. Rules: kill-switch/halt, degraded feed (BE-044 Redis
  set), weekend market closure, P ≥ threshold (ADR-008), daily/weekly DD
  halts, per-instrument 2% daily-loss tripwire, max concurrent (5),
  correlation cap, min R:R 1.8 **net of spread**, flash spread (≥5× cap ⇒
  VETO + critical alert + HALT_NEW_ENTRIES flag), session-adjusted max
  spread (1.5× overnight, labels from QN-047), econ blackout (±30min
  high-impact — **CalendarProvider seam, no vendor wired yet**: rule notes
  'unavailable' and passes; wiring a calendar feed is a Phase-4+ item),
  weekend-gap window (flags existing positions WEEKEND_GAP_FLATTEN + vetoes
  new entries when enabled + high-vol), Wednesday rollover (advisory
  TRIPLE_SWAP_WARNING / optional ROLLOVER_AUTOFLATTEN_XAU flags — never
  vetoes). **DST**: `ny-time.ts` uses `Intl` with America/New_York (zero
  deps); summer AND winter fixture tests mirror Python `sessions.py`.
  Missing optional data (spread feed, calendar) is noted-not-vetoed; missing
  MANDATORY inputs fail-safe VETO via `evaluateWithTimeout` (2s budget, §2.2).
- **BE-071 — correlation cap** (`correlationCapRule` in the engine +
  adapter): consumes the LATEST `correlation_clusters` row (QN-048, highest
  version — a refreshed set re-checks open exposure on next evaluation,
  tested); max 2 per cluster incl. candidate; `RISK_CLUSTER_EXEMPTIONS` (csv
  env) = operator override, pass-with-`CLUSTER_EXEMPTION_USED`-flag →
  audited via `signal_cycle_risk_flags`. No cluster set yet ⇒ noted, not
  evaluated (dev bootstraps before QN-048 ever ran).
- **BE-072 — kill-switch API** (`routes/kill-switch.ts` + close-out executor
  in `execution/kill-switch.ts`; schemas in `@fx/types` killswitch.ts):
  `GET|POST /settings/kill-switch`. Activate sequence: Postgres row → Redis
  cache → sticky `execution:halt` (workers pause BEFORE any broker IO) →
  audit → WS `risk.halt` + critical notification → cancel pending intents
  (`pending|approved` → cancelled; **in-flight `submitted` stays** for the
  reconciler — broker outcome unknown) → close all open via gRPC
  `ListOpenPositions`/`CloseTrade`, ≤3 attempts each, **escalating alerts**
  (warning → critical) → re-list to broker-confirm. Report status:
  `closing|flat|failed` — **never flat without broker confirmation**
  (ADR-012). 2FA: request carries `twoFactorCode` (FE-011 contract
  unchanged); `TwoFactorVerifier` seam — BE-036 wires TOTP in Phase 5;
  activation is deliberately NEVER blocked on 2FA infra (fail-safe
  direction). Deactivate: 409 if not active; clears the halt flag only if
  kill-switch set it (reconciler halts survive). server.ts wires a
  command-mode Redis (ws bridge client is subscriber-mode), the
  QuantExecutionClient, and the notifications queue; without deps (unit
  tests / OpenAPI emit) routes answer 503.
- **BE-073 — state persistence** (`execution/kill-switch.ts`
  `KillSwitchStore` + new `kill_switch_state` table): Postgres = SOURCE OF
  TRUTH, Redis `kill-switch:active` = cache ONLY. `isActive()` on cache miss
  re-hydrates from Postgres and repopulates the cache — Redis flush while
  active stays halted (tested). Both workers check the store in their halt
  gates AND hydrate at boot; write order on activate is Postgres → cache →
  halt flag (a Redis death mid-sequence re-hydrates to ACTIVE, never the
  reverse). One row per activation (history retained); close-out progress
  mutates that row (`close_out_status`, `close_report` jsonb).
- **Worker integration** (`signals-worker.ts`, `workers/signals.ts`,
  `workers/execution{,-main}.ts`): `DeterministicRiskGate` (adapter in
  `signals/risk-gate.ts`) gathers clusters/open book/weekly + instrument
  P&L/kill-switch and calls the pure engine; worker passes
  `sessionLabel`/`liquidityRegime`/`features` (spread_pips, spread_pctile,
  weekend_gap_window) from the pipeline result. Gate `alerts` fan out to the
  notifications queue regardless of verdict; `flags` audit as
  `signal_cycle_risk_flags`. `SignalsWorkerDeps` gained `killSwitch`
  (nullable for legacy tests); `RiskGateVerdict` gained optional
  `flags`/`alerts` (seam shape otherwise unchanged — `NotImplementedRiskGate`
  kept as a test stub).
- **Schema** (`schema.prisma`): new `KillSwitchState` model only — additive;
  migration NOT generated (sandbox; see pending).
- **Env** (env.ts + .env.example + both compose files): 9 new keys, all
  defaulted — `RISK_MAX_CONCURRENT_TRADES` (5), `RISK_MAX_PER_CLUSTER` (2),
  `RISK_CLUSTER_EXEMPTIONS` (csv, empty), `RISK_DAILY_DD_HALT_PCT` (0.05),
  `RISK_WEEKLY_DD_HALT_PCT` (0.10), `RISK_INSTRUMENT_DAILY_LOSS_PCT` (0.02),
  `RISK_MIN_RR` (1.8), `RISK_WEEKEND_FLATTEN_ENABLED` (false),
  `RISK_ROLLOVER_AUTOFLATTEN_XAU` (false). `check-env --ci` passes (53
  keys). Compose: `api` service gained `QUANT_GRPC_URL` (close-out runs over
  the execution gRPC channel from the API process).
- **FE note:** dashboard `<KillSwitch>` stays a visible no-op — the
  dashboard has no token source until Phase 5 auth (FE-033); operators use
  the API directly (testing guide §D). FE-011 component contract untouched.
- Decisions: flash-spread detection uses live `spread_pips` vs 5× the
  configured cap (features carry no session-median; revisit if QN-047 ever
  publishes one). "High-vol regime" for the weekend-gap rule =
  `liquidityRegime === 'LOW'` (documented proxy). Weekly P&L window = ISO
  week from Monday 00:00 UTC, realized only (matches the account-state
  daily convention).
- Verified: `tsc --noEmit` CLEAN (zero expected errors this time) for
  `packages/types`, `packages/risk-gate` (own verify config), and
  `apis/node-api` via `tsconfig.verify.json` (now also path-maps
  `@fx/risk-gate` to source; risk-gate's own tests excluded there — no
  node_modules until install). `scripts/check-env.mjs --ci` green.
  **NOT verified in sandbox** (same macOS-only-binary wall as 3.1/3.2):
  Vitest (2 new test files: `packages/risk-gate/src/engine.test.ts` ~35
  cases, `apis/node-api/src/execution/kill-switch.test.ts` ~11 cases),
  Biome, `pnpm install`, prisma generate/migrate, tsup builds, any live
  kill-switch round-trip.
- **Pending human actions (Step 3.3):**
  1. `pnpm install` (lockfile + node_modules for new `@fx/risk-gate`).
  2. `npx prisma generate` then `npx prisma migrate dev --name
     step_3_3_kill_switch` (in `apis/node-api`; additive — one new table).
  3. `pnpm --filter @fx/types build && pnpm --filter @fx/risk-gate build`
     (node-api resolves @fx/risk-gate via dist at runtime).
  4. Root `pnpm typecheck / test / lint`.
  5. Runtime drill: see `PHASE3_TESTING_GUIDE.md` (gate E2E + kill-switch
     <2s timed test + Redis-flush chaos check).
  6. Commit.

### 2026-07-10 — Step 3.2: Agent graph (BE-074, BE-062, BE-064, BE-063, BE-065, BE-066, BE-067)

All new Node code lives in `apis/node-api/src/signals/` beside the Step-3.1
plumbing. **LangGraph.js installed per plan** (`@langchain/langgraph@1.4.7` +
`@langchain/core@1.2.2`, operator ran the pnpm add). New verification seam:
`apis/node-api/tsconfig.verify.json` — path-maps `@fx/types`/`@fx/llm` to
SOURCE so sandbox `tsc` works without dist builds (tsup/rollup native
bindings are macOS-only here); kept committed on purpose.

- **BE-074 — context assembler** (`context-assembler.ts`): the ONE owner of
  bundle construction. Feature partitioning mirrors quant
  `partition_features()` byte-for-byte (`macro_*`/`sent_*`/rest); PIT
  headlines from `news_archive` via `MarketRepo.queryNews` wrapped in the
  `UNTRUSTED_DATA` block; §9.5 memory slot behind `MemoryRetriever`
  (`NULL_MEMORY` for ablation); every bundle validated against
  `AgentContextContract` pre-invocation (fail ⇒ `SCHEMA_INVALID`, never
  throw); `buildDigest()` = the ADR-011 deterministic PM digest;
  `effectiveDebateRounds()` (entropy ≥ 2/3 ⇒ 2, same threshold as quant
  `regime.debate_rounds`); `tiebreakerMode()` (<0.1 split ⇒ QUANT_DEFAULT).
- **BE-062 — graph + prompts** (`agent-graph.ts`, `prompts.ts`): real prompt
  texts v1 for all 8 roles registered in the BE-061 registry (SECURITY block
  everywhere; sentiment prompt carries the untrusted-data contract; the user
  message is always the JSON bundle — no string interpolation surface).
  LangGraph `StateGraph`: 3 specialists parallel (fan-out from START,
  array-source join) → 0/1/2 debate rounds → trader → risk → PM. §2.2
  budgets: 20s/specialist, 15s/debate turn, 15s trader/risk/PM, 120s graph
  (run()-level race), each stage +grace for the contractual 10s single
  fallback. One failed specialist ⇒ NEUTRAL + transcript note; failed turn ⇒
  skipped + noted; failed trader/risk/PM ⇒ deterministic HOLD w/ reason.
  **QUANT_DEFAULT is code-enforced post-hoc** (P ≥ threshold ⇒ candidate
  side, else HOLD; `tiebreakerOverrode` flagged) — never LLM discretion.
  Partial transcript survives graph-budget overruns via a per-run collector.
  `retrievedMemoryIds` added to `@fx/llm` `InvokeParams`/`LlmRunRecord` →
  `agent_runs.retrieved_memory_ids` (QN-062 replay).
- **BE-064 — agent memory** (`agent-memory.ts` + `@fx/llm` `embeddings.ts`):
  embedding seam is **env-configurable** (`EMBEDDING_PROVIDER=openai|fake`,
  `EMBEDDING_MODEL`; default fake = deterministic sha256 unit vectors,
  keyless CI) with a hard 1536-dim runtime assert (column is vector(1536));
  `embedding_model` pinned per row AND filtered at retrieval — vector spaces
  never mix. Retrieval: `bar_ts <=` hard filter, instrument match, HNSW
  cosine (`<=>`), K=5, 18-month read-time decay window, retrieval_count++.
  **Reflection is composed by CODE** (`composeReflection`) not an LLM —
  ADR-011 logic extended: zero cost, reproducible, no second-order injection
  surface (the only LLM text reaching memory is schema-validated output
  fields, red-teamed directly). Near-duplicate (cosine > 0.95) merged at
  WRITE time (existing row wins, inherits new signal_id); `enforceCap` 500/
  instrument (least-retrieved-then-oldest evicted). Outcome linking: new
  `agent_memory.signal_id` column; `sweepTradeOutcomes` (60s timer in the
  worker) attaches R-multiple/exit/holding on trade close.
- **BE-063 — red-team suite** (`red-team.fixtures.ts` + `red-team.test.ts`):
  28 fixtures across 10 categories (incl. the mandated override, role-play,
  delimiter escape, CB mimicry, JSON injection, multi-language ×5, and 3
  memory-persistence patterns). Suite proves: (1) per-pattern byte-identical
  decisions vs clean baseline + injected text confined to the sentiment
  UNTRUSTED_DATA block (never any other bundle or system prompt); (2)
  attack-shaped outputs (smuggled keys, confidence 9.9) rejected by strict
  contracts; (3) memory-persistence: a gullible model quoting the injection
  into its rationale → reflection → retrieval at bar N+k leaves decisions
  identical; (4) prompt-hygiene asserts. Live-model behavioural red-teaming
  is a paper-phase exercise; this suite is its regression harness (new
  production patterns get added to the fixtures file).
- **BE-065 — disagreement cohort** (`disagreement.ts` + new
  `disagreement_cohort` table): "quant approves" ≡ P ≥ ADR-008 threshold;
  kinds `QUANT_YES_PM_VETO|QUANT_YES_PM_HOLD|QUANT_NO_PM_APPROVE`; outcome
  tracking by join (signal → intents → trades; counterfactuals via
  `baseline_signals`). Structural Prisma seam so it typechecks pre-generate.
- **BE-066 — signals worker** (`signals-worker.ts`, `workers/signals.ts` +
  `signals-main.ts`; scripts `worker:signals`/`start:worker:signals`; compose
  + Swarm stack services `worker-signals` added): first consumer of the
  `signals` queue market-data has produced since Phase 2. Cycle: halt check
  → RunPipeline (breaker) → **entry gate** (no candidate or P < 0.50 ⇒
  `gate_skip`, zero LLM, no Signal row) → Signal row → `PrioritySemaphore`
  (cap 3, liquidity-ranked wakeups, **E2E clock starts at acquisition**) →
  assembler → graph → debate persistence (`agent_debates`; notes as `judge`
  rows) → BE-065 log + reflection → **risk-gate seam** → SizePosition (new
  RPC method on `QuantPipelineClient`, never-throw union) → TradeIntent +
  execution queue. Every path completes the BullMQ job. **Risk gate is
  `NotImplementedRiskGate` until BE-070: fail-safe VETO of everything** —
  agent APPROVEs cannot execute until the deterministic authority lands
  (Step 3.3). 2s gate budget → VETO on overrun (§2.2). AccountState =
  `ACCOUNT_BASELINE_EQUITY` + realized P&L from trades (broker equity sync
  comes later); BullMQ concurrency 2× the semaphore so the gate section
  never queues behind the graph section. Zero LLM keys ⇒ loud boot warning +
  deterministic HOLD (PROVIDER_EXHAUSTED) — not a crash.
- **BE-067 — REST + WS** (`routes/signals.ts`, schemas in `@fx/types`
  agents.ts): `GET /signals` (instrument/status/limit filters) returns
  candidates + agent summary (calls, cost, roles, anyDowngraded, debate
  turns). Live side rides the existing ws-publish → ws-bridge → EventBus
  path (channel `signals`, events `signal:hold|debate|risk_gate_veto|
  approved`) — no new transport. Done now despite the story's Phase-5 tag
  (PRD §8 lists it in Step 3.2; operator confirmed).
- **Schema** (`schema.prisma` — migration NOT generated, see pending):
  `agent_runs.retrieved_memory_ids uuid[]`; `agent_memory.{embedding_model,
  retrieval_count, signal_id}` + signal_id index; new `disagreement_cohort`
  model (FK to signals). All additive except nothing — no destructive SQL.
- **Env** (env.ts + .env.example + both compose files): `AGENT_DEBATE_ROUNDS`
  (1), `AGENT_MEMORY_ENABLED` (true), `EMBEDDING_PROVIDER` (fake) /
  `EMBEDDING_MODEL`, `RISK_PROBABILITY_THRESHOLD` (0.6),
  `ACCOUNT_BASELINE_EQUITY` (10000), `SIGNALS_GRAPH_CONCURRENCY` (3),
  `SIGNALS_GRAPH_BUDGET_MS` (120000), `SIGNALS_E2E_BUDGET_MS` (180000).
  `scripts/check-env.mjs --ci` passes (44 keys).
- Verified: `tsc --noEmit` clean for `packages/types` and `packages/llm`
  (standalone) and `apis/node-api` via `tsconfig.verify.json` — exactly ONE
  expected error (`llm-ledger.ts` retrievedMemoryIds) until `prisma
  generate` runs. **NOT verified in sandbox:** Vitest (macOS-only rolldown
  binding — 7 new test files unrun), Biome, prisma generate/migrate, tsup
  builds, any live LLM/pgvector round-trip.
- **Pending human actions (Step 3.2):**
  1. `npx prisma generate` then `npx prisma migrate dev --name
     step_3_2_agent_graph` (in `apis/node-api`; additive).
  2. `pnpm --filter @fx/types build && pnpm --filter @fx/llm build`
     (node-api resolves @fx/llm via dist at runtime — llm has NEVER been
     built; the signals worker won't boot without it).
  3. Root `pnpm typecheck / test / lint` (expect the llm-ledger error to
     clear after step 1; 7 new test files: context-assembler, agent-graph,
     agent-memory, red-team, disagreement, signals-worker, routes/signals).
  4. Provider keys in `.env` when ready to exercise the graph for real;
     `EMBEDDING_PROVIDER=openai` before any paper evidence run.
  5. Smoke: `pnpm --filter @fx/node-api worker:signals` + `trip-signals`
     (expect gate_skip/NO_CHAMPION HOLDs, zero LLM cost, jobs completing).
  6. Commit.

### 2026-07-09 — Step 3.1: LLM plumbing (BE-069, BE-060, BE-061, BE-068)

- **BE-069 — agent context contracts** (`packages/types/src/agents.ts` +
  `agents.test.ts`): Zod input/output schemas for all 8 roles per §9.6
  (3 specialists → bull/bear researchers → trader → risk team → PM), plus
  `QuantCandidateSchema`/`PipelineContextSchema` (mirror proto
  `RunPipelineResponse`), `RetrievedMemorySchema` (§9.5 slot, BE-064 fills),
  `UntrustedNewsBlockSchema` (BE-063 injection boundary),
  `DebateDigestSchema` (ADR-011 deterministic PM digest shape),
  `HoldReasonSchema` (shared reason codes: GATE_SKIP, GRPC_TIMEOUT,
  CIRCUIT_OPEN, NO_CHAMPION, SCHEMA_INVALID …), `AGENT_CONTRACT_VERSION`,
  and `validateAgentOutput()` (returns `ok:false`, never throws → HOLD).
  Outputs are `strictObject` (extra keys rejected); trader `direction`
  required iff `action=ENTER`. **Deliberately NOT in `contractSchemas`** —
  Node-internal; registering would churn the QN-003 Python codegen drift
  check.
- **BE-060 — provider factory** (new `packages/llm`, dep-light: raw fetch,
  no SDKs): adapters for Anthropic/OpenRouter/OpenAI/Gemini (temp 0, JSON
  mode where native, uniform error classification timeout/rate_limit/server/
  fatal); `LlmClient` with §9.4 policy — primary under stage budget, then
  **exactly one fallback (10s cap)**; 429 → capped exponential backoff THEN
  failover; monthly cost cap ≥90% ⇒ non-PM down one capability tier, ≥95% ⇒
  PM too; latency SLA (p95 >15s over 5 min + 2 consecutive slow) ⇒ reroute
  via OpenRouter one tier down. Tiers are provider-agnostic
  (`catalog.ts` maps tier→pinned snapshot; downgrades never name models).
  Persistence seams: `LedgerSink`/`SpendProvider` interfaces — Prisma impls
  in `apis/node-api/src/signals/llm-ledger.ts` (`agent_runs` IS the ledger;
  MTD spend = indexed sum over `created_at`). **Catalog prices checked
  2026-07-09** (Opus 4.8 $5/$25, Sonnet 5 intro $2/$10 → $3/$15 after
  2026-08-31, GPT-5.6 Sol/Terra/Luna, Gemini 3.1/3.5) — review before first
  live month; OpenRouter model IDs unverified.
- **BE-061 — prompt registry** (`packages/llm/src/registry.ts`):
  `promptHash` = sha256(role, prompt version, `AGENT_CONTRACT_VERSION`,
  text) — a BE-069 contract bump changes every hash automatically;
  `PromptRegistry` rejects text changes without a version bump;
  `requiresRevalidation()` flags provider/snapshot/hash drift between runs.
  Real prompt texts arrive with BE-062 (Step 3.2).
- **BE-068 — gRPC circuit breaker** (`apis/node-api/src/signals/` — kept in
  node-api beside the other workers, not a separate `workers/signals` pkg):
  hand-rolled `CircuitBreaker` (§2.2 exact: 3 consecutive failures in 5 min
  → open 60s → half-open single probe; not opossum — policy is contractual
  and ~60 lines) + `QuantPipelineClient.runPipeline()` returning a
  discriminated union, **never throwing**: breaker open ⇒ HOLD
  `CIRCUIT_OPEN` (no connection attempt), DEADLINE_EXCEEDED ⇒ `GRPC_TIMEOUT`
  (counted), transport errors ⇒ `GRPC_UNAVAILABLE` (counted);
  FAILED_PRECONDITION ⇒ `NO_CHAMPION` and UNIMPLEMENTED ⇒ HOLD **without**
  poisoning the breaker (service answered deterministically).
- **Schema (`schema.prisma` `AgentRun`):** added `provider`, `tier`,
  `model_downgraded`, `downgrade_reason`, `failed_over`, `@@index(createdAt)`
  — migration NOT generated (sandbox can't run prisma; see pending).
- **Env:** `QUANT_GRPC_PIPELINE_TIMEOUT_MS` (30s), optional
  `ANTHROPIC/OPENROUTER/OPENAI/GEMINI_API_KEY` (mock-first — keyless
  provider is absent from the chain), `LLM_MONTHLY_COST_CAP_USD` (200);
  `.env.example` updated + fixed pre-existing `ELEGRAM_CHAT_ID` typo.
  node-api gained dep `@fx/llm`.
- Verified: `tsc --noEmit` clean for `packages/types`, `packages/llm`, and
  `apis/node-api` (via path-mapped configs against @fx/types SOURCE — dist
  is stale until rebuilt). **NOT verified in sandbox:** Vitest (rolldown
  native binding is macOS-only here), Biome, pnpm install (mount blocks
  unlink), prisma generate/migrate. One EXPECTED type error in
  `llm-ledger.ts` until `prisma generate` runs (new AgentRun columns).
- **Pending human actions (Step 3.1):** `pnpm install` (lockfile +
  node_modules for @fx/llm); `pnpm --filter @fx/types build` (dist +
  schemas); `npx prisma generate` then `npx prisma migrate dev --name
  step_3_1_agent_run_provenance` (dev DB, additive); add
  `QUANT_GRPC_PIPELINE_TIMEOUT_MS=30000`, `LLM_MONTHLY_COST_CAP_USD=200`,
  `TELEGRAM_CHAT_ID=...` to local `.env` (check-env now requires them);
  `pnpm test / typecheck / lint` at root. Provider API keys optional until
  Step 3.2.

---

*Template for new entries:*

```
### YYYY-MM-DD — Step X.Y: <name> (story IDs)

- <what was added/changed, file paths>
- <decisions made + why, if any>
- Verified: <what was actually run/tested; note anything NOT verified>
```
