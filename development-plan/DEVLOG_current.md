# DEVLOG — Phase 3 (Intelligence)

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

## Current state (updated 2026-07-09)

- **Phase 2 is code-complete and (per user) tested** — Step 2.1 (QN-030…034),
  Step 2.2 (BE-050…053, audited + fixed 2026-07-07), Step 2.3 (QN-040…048).
  Full record in [`DEVLOG_phase2.md`](DEVLOG_phase2.md); pre-Phase-3 checklist
  in [`PHASE2_TESTING_GUIDE.md`](PHASE2_TESTING_GUIDE.md). QuantService gRPC
  RPCs (RunPipeline/SizePosition/Predict) are REAL; shadow baseline runs every
  bar; train-on-demand policy holds (no champion ⇒ deterministic HOLD).
- **Phase 3 not started** — nothing below built yet. First work is **Step 3.1**
  (LLM plumbing: BE-060/061/068/069), then **Step 3.2** (agent graph), then
  **Step 3.3** (risk gate & kill-switch).
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
- **Next:** Step 3.1 — BE-069 (agent context contracts in `@fx/types`) first
  (everything downstream validates against these), then BE-060 (LLM provider
  factory + one-shot failover, 10 s cap), BE-061 (prompt registry + model
  snapshot pinning), BE-068 (gRPC circuit breaker Node → Python; UNIMPLEMENTED /
  breaker-open ⇒ HOLD, the seam already assumed since Phase 1).

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

---

*Template for new entries:*

```
### YYYY-MM-DD — Step X.Y: <name> (story IDs)

- <what was added/changed, file paths>
- <decisions made + why, if any>
- Verified: <what was actually run/tested; note anything NOT verified>
```
