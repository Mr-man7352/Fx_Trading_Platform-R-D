# DEVLOG — Phase 6 (Go-live)

Continuation of [`DEVLOG_phase5.md`](DEVLOG_phase5.md) (the Phase-5 record —
Surface; per-step build history lives there) and, before it,
[`DEVLOG_phase4.md`](DEVLOG_phase4.md), [`DEVLOG_phase3.md`](DEVLOG_phase3.md),
[`DEVLOG_phase2.md`](DEVLOG_phase2.md) and [`DEVLOG-phase1.md`](DEVLOG-phase1.md).
The **Standing decisions** and **Conventions** carried through Phases 1 → 5 are
carried forward in full below and remain the *current* single source of truth —
no need to cross-read the earlier logs for them. Same rules: **append a new
entry per step; keep "Current state" at the top updated.** Plan:
[`FX_PRD.md`](FX_PRD.md) §8 Phase 6, stories in `FX_Stories_*.md`, architecture
in `system-design/FX_System_Design.md`.

**Phase 6 outcome:** hardened system passes chaos tests and the 90-day paper
gate; signed promotion to live.
**Exit criteria:** chaos suite green; paper run beats baseline net of cost;
signed report produced; live mode enabled via canary ramp with human
confirmation.

---

## Current state (updated 2026-07-14 — PHASE 6 CODE-COMPLETE)

- **All seven Phase-6 stories are BUILT** (Steps 6.1–6.5 below): QN-060
  paper validator, BE-120 chaos suite, QN-062 decision replay (+ FE-060
  transcript seam closed), QN-061 signed risk report, BE-122 paper gate,
  BE-121 canary ramp + one-tap confirm, BE-132 GDPR export/erasure.
- **UNIT GATE PASSED on the operator machine (2026-07-14, §A–§B of the
  Phase-6 guide):** migration applied + client generated, node typecheck ✅,
  vitest 401/401 (incl. chaos suite), quant pytest 291/291 + mypy strict +
  ruff clean. Still **uncommitted**; still owed: **§C staging drills**, the
  Phase-4+5 runtime drills ([`PHASE4_TESTING_GUIDE.md`](PHASE4_TESTING_GUIDE.md)
  + [`PHASE5_TESTING_GUIDE.md`](PHASE5_TESTING_GUIDE.md) §A, §D–§L), and
  [`PHASE6_TESTING_GUIDE.md`](PHASE6_TESTING_GUIDE.md) §D–§H at
  paper-window end.
- **Champion retrain (≥18 months H1) still OWED** — the 90-day paper window
  (schedule-critical path for go-live) cannot meaningfully start against the
  edgeless `XAU_USD/H1 v1`, and QN-060 will honestly answer UNDERPOWERED/
  FAIL until there is a real window to judge.
- **New env keys** (in `.env.example`, check-env green): canary trio
  (`CANARY_CONFIRM_FIRST_N/MAX_UNITS/CONFIRM_TTL_MIN`) +
  `REPORT_SIGNING_KEY` (QN-061 refuses to generate unsigned).
- **vectorbt moved to optional `vbt` dependency group** (2026-07-14 gate
  finding): llvmlite 0.48 ships no Intel-mac wheels, so default `uv sync`
  broke on the dev Mac trying an sdist build (cmake+LLVM). The QN-050 engine
  already has an identical numpy metrics fallback (`metrics_backend`
  recorded per report); CI keeps the real backend via
  `uv sync --frozen --group vbt` (linux wheels exist). Operator re-locks:
  `uv lock` (generated file — never hand-edited).
- **Verified in the build sandbox** (no install/DB possible there): all
  Python `py_compile`; ZIP writer executed and round-tripped through Python
  `zipfile` (CRCs green); BE-101/122 checklist logic executed (PASS allows,
  FAIL/EXTEND/UNDERPOWERED/no-report block); report sign/verify/tamper/
  wrong-key/XSS-escape executed green. Everything else is §A–§H of the
  Phase-6 guide.
- **Remaining Phase-5 seams NOT in Phase-6 scope** (unchanged): health-strip
  breaker Redis mirror, broker equity sync (must be real before live),
  richer trade record over REST, Python reading `platform_settings` knobs.
- **Next:** operator runs PHASE6 guide §A–§C now (install → migrate → unit +
  chaos gates), retrains the champion, starts the paper window; §D–§H happen
  at window end → live promotion via the canary ramp.
- **Carried-forward known issue (from Phase 2):** the only trained model
  `XAU_USD/H1 v1` has **no predictive edge** (OOF AUC 0.51, ~6 months / 2,121
  candidates) — a plumbing/smoke artifact only. **Retrain on ≥18 months H1**
  (train→promote flow, [`PHASE2_TESTING_GUIDE.md`](PHASE2_TESTING_GUIDE.md) §E)
  before the quant dashboard, calibration curves, backtest results — or any
  QN-060 paper window — mean anything. The 90-day paper gate cannot even start
  against an edgeless champion.
- **Seams deliberately left for THIS phase** (from
  [`PHASE5_TESTING_GUIDE.md`](PHASE5_TESTING_GUIDE.md) §4):
  - Health-strip gRPC-breaker + session/liquidity pills — breaker state is
    in-process (BE-068); needs a Redis mirror to surface.
  - Per-signal full transcript + retrieved-memory replay endpoint (FE-060
    detail beyond BE-067 summaries) — pairs with QN-062 decision replay.
  - Broker equity sync (currently `ACCOUNT_BASELINE_EQUITY` + realized P&L) —
    must be real before live; then home tiles go live.
  - Richer trade record (SL/TP, uP&L, R-multiple over REST) — extends
    `TradeSchema` + `/api/trades`; mobile cards already have the slots.
  - Python reading `platform_settings` cluster/session knobs (QN-048 cadence) —
    table is the contract; quant-side read is a small follow-up.
  - QN-060/061 — until they land, the BE-101 live-promotion checklist
    correctly reports them unmet and blocks live.
- **Next:** operator runs the combined Phase-4+5 gate and drills, commits the
  backlog, retrains the champion — then Phase-6 build order below.

## Phase 6 scope (from `FX_PRD.md` §8)

- BE-120 — Chaos test suite (incl. worst case: all instruments candidate +
  2-round debates + one degraded provider, E2E < 180 s).
- BE-121 — Canary sizing ramp + human confirm.
- QN-060 — 90-day paper vs baseline validator (net of LLM cost;
  downgraded-bar tolerance policy).
- QN-061 — Signed risk report generator.
- QN-062 — Decision replay from provenance.
- BE-122 — 90-day paper validation gate → live.
- BE-132 — GDPR export + erasure endpoints (**complete before any invited
  user**).

**Suggested build order:** the operator gate + champion retrain are hard
prerequisites (nothing here is provable without a running, committed, edged
system). Then QN-060 first — the 90-day paper window is the schedule-critical
path and should start ticking as early as possible. BE-120 (chaos suite) can
proceed in parallel once the stack runs. QN-062 (decision replay) next — it
also closes the FE-060 transcript seam. QN-061 + BE-122 + BE-121 form the
promotion chain and land last; BE-132 (GDPR) is independent but gates any
second invited user.

## Phase-6 specific context (seams already built in earlier phases)

- **BE-101 live-promotion gate is already enforcing:** `POST
  /settings/live-promotion` answers 403 with the checklist — QN-060 paper
  record and QN-061 signed report are honestly-unmet items waiting for this
  phase. Landing them flips the checklist, not new plumbing.
- **`TRADING_MODE` still flips at deploy** (BE-003 one-code-path) — an allowed
  live-promotion POST is an audited approval, not a runtime mode switch;
  BE-121/122 define how the flip is actually executed (canary ramp + human
  confirm).
- **Provenance is already recorded end-to-end** (signals, debate summaries,
  supervision, fills, audit rows) — QN-062 replays from it; the missing piece
  is the full per-role transcript/memory endpoint (BE-067 exposes summaries
  only).
- **Chaos ingredients exist:** supervision drills, kill-switch <2 s,
  reconciliation mismatch events, dead-man's switch (BE-053), provider
  failover chain — BE-120 composes them into one repeatable suite with the
  <180 s worst-case E2E bound.
- **Notifications/alerting (BE-115…118) are live surfaces** for chaos + canary
  observability: critical ⇒ Telegram+SMS, alert-delivery failures surface on
  the `notifications` WS channel.

## Standing decisions (carried from Phases 1–5 — don't re-litigate without cause)

- **DB image:** `timescale/timescaledb-ha:pg18-ts2.28` — community TimescaleDB
  (CAGGs/compression/retention) + pgvector. Identical image dev and prod; prod
  runs OUTSIDE the Swarm stack on a dedicated Hetzner volume (ADR-006 rev.).
- **Quant service:** `services/quant` is a uv-managed Python 3.13 FastAPI +
  gRPC service (Step 1.5). One process serves both planes: REST `:5001`
  (`/healthz`; moved off 5000 — see Conventions), gRPC `:50051` (std
  `grpc.health.v1` + the QuantService RPCs). Its `package.json` exists only so
  turbo `dev` boots it (`uv run python -m app`) — Python deps are never managed
  by pnpm; lint/type/test run via uv in the CI `quant` job, not turbo. Generated
  code (`app/contracts/`, `app/proto_gen/`) is committed and drift-checked;
  regenerate via `scripts/gen_contracts.py` + `scripts/gen_proto.py`, never
  hand-edit.
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
- **Auth is real as of Phase 5 (Step 5.1):** NextAuth JWT (HS256 via `jose`)
  behind the same `RequestContext`; `x-internal-token` stays for
  server-to-server callers. `NEXTAUTH_SECRET` + `INTERNAL_SYNC_TOKEN` are
  required to boot. Step-up TOTP (15-min window) gates broker-credential
  writes and live promotion.
- **DB schema:** Prisma migrations = relational DDL only; every
  Timescale/pgvector-index object goes in `apis/node-api/prisma/timescale.sql`
  (idempotent, applied by `pnpm db:timescale` after `db:deploy`) — NEVER in a
  migration, or the CI drift check breaks. Destructive migration SQL needs a
  `-- destructive-ok: <reason>` marker. Credential envelope format is
  `v1:base64(iv‖tag‖ct)` AES-256-GCM — Python quant matches it. **Migration
  files are generated, never hand-written** (project CLAUDE.md): run
  `prisma migrate dev`; ask the operator to run it if the sandbox can't.
- **Deterministic quant core stays LLM-free (§10):** no LLM ever touches
  `app/quant/` — agents *refine/confirm/veto* the quant candidate, they don't
  generate the numbers. The graph fires only on quant candidates (ADR-010) and
  the risk gate (BE-070) is the final deterministic authority.
- **Settings are append-only versions** (`platform_settings`; latest row
  effective) with authoritative bounds in `@fx/types` `RiskSettingsSchema`;
  workers read via a TTL-cached reader (15 s) — "next cycle uses new values."
- **Honest seams over faked data:** UI/services render explicit
  "awaiting feed / BE-xxx" states rather than fabricated numbers — keep this
  for every Phase-6 surface.

## Conventions (carried from Phases 1–5)

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
- Dashboard E2E: Playwright + axe (`pnpm --filter @fx/dashboard e2e`; authed
  specs need `E2E_EMAIL`/`E2E_PASSWORD`; one-time `e2e:install`).

## Entries

<!-- Append Phase 6 step entries below, newest first. -->

### 2026-07-14 — Phase-6 unit gate PASSED on the operator machine (§A–§B)

- **Results:** node-api `prisma migrate dev` + `generate` ✅, typecheck ✅,
  vitest **401/401** (incl. the 13-case chaos suite); quant `uv sync` ✅,
  pytest **291/291**, `mypy --strict` clean (130 files), `ruff check` clean.
  This is the FIRST full runtime verification of anything since Phase 3.
- **Gate findings fixed along the way (all now green):**
  - `routes/gdpr.ts`: Prisma 7 `Bytes` wants `Uint8Array` (copy out of the
    Buffer); binary download route must declare NO response schemas (JSON
    serializer would eat the ZIP).
  - `gdpr.test.ts`: my over-broad assert — the export README legitimately
    *mentions* "ciphertexts" while excluding them; tightened to the quoted
    JSON-key form.
  - **Pre-existing Phase-4 defects surfaced by the first real run:**
    `app/backtest/costs.py` leaked `np.bool_` into
    `TradeCosts.flash_event` (now a plain bool at the seam);
    `tests/backtest/test_engine.py` `params()` used an untyped dict splat
    (now `dataclasses.replace`); `ablation.py` missing return annotation +
    `report` shadowing; long-line/noqa hygiene in `pit.py`/`service.py`/
    `routes_backtest.py` (pit guard also made readable).
  - Phase-6 strict-mode nits: `TrendRegime` enum in the replay test, two
    `Any` returns pinned in `routes_validation.py`/`routes_report.py`,
    ASCII-fied the power-formula docstring, E501 wraps.
  - **vectorbt → optional `vbt` group** (see Current state) — llvmlite has
    no Intel-mac wheels; numpy metrics fallback is the dev-Mac path, CI
    keeps the real backend.
- Known cosmetic noise: OTel exporter retry spam after pytest when the local
  `.env` sets `OTEL_EXPORTER_OTLP_ENDPOINT` without Tempo running — comment
  the key out locally or ignore; tracing is a no-op when unset.
- **Remaining before go-live:** guide §C staging drills, champion retrain,
  paper window → §D–§H.

### 2026-07-14 — Step 6.5: GDPR export + erasure (BE-132)

- **`src/gdpr/zip.ts`** — dependency-free store-only ZIP writer (PKWARE
  subset: local headers + central directory + EOCD, CRC-32, UTF-8 names).
  Byte-deterministic for a given input; readable by every unzip tool. Chosen
  over adding `archiver`/`jszip` — the bundle is a handful of small JSON
  files for one user.
- **`src/gdpr/gdpr-service.ts`** — export scope + retention policy in ONE
  place. Export bundles `user.json`, `trades.json`,
  `security_metadata.json` (**metadata only** — password/recovery hashes,
  sealed TOTP secrets, and broker-credential ciphertexts NEVER leave),
  `invites.json`, `audit_log.json` (actor rows), and a README stating scope
  + retention. Erasure = anonymise-in-place: deletes recovery codes, email
  tokens, broker credentials, pending exports; clears email (tombstone
  `erased+<id>@anonymised.invalid`), name/image/googleId/passwordHash/
  totpSecret; sets status `suspended` + new `User.erasedAt`. **Retained:**
  trades (Art. 17(3)(b) financial records, user FK spine kept) and the
  append-only `audit_log` (BE-130's DB trigger forbids UPDATE/DELETE by
  design — documented, not fought).
- **`src/routes/gdpr.ts`** (+ app.ts `BuildAppOptions.gdpr`) —
  `POST /gdpr/export` (auth): ZIP stored in-row in new `gdpr_exports` behind
  a 256-bit capability token, **7-day link emailed** via the existing
  mock-first Resend seam (link also in the response body so the no-API-key
  dev path stays usable); `GET /gdpr/exports/:token` (public capability
  route, `config.public` like verify/reset): streams the ZIP, **410 Gone +
  row delete after expiry**; `POST /gdpr/erasure` (**step-up 2FA required**
  + `confirmEmail` must repeat the account email verbatim): anonymises and
  audits the full summary before the JWT dies with the old email.
- **Schema:** new `GdprExport` model + `User.erasedAt` — folded into the
  owed Phase-6 migration run.
- Verified: 9 vitest cases (`gdpr/gdpr.test.ts` — ZIP structure/EOCD/CRC
  incl. the IEEE `123456789` vector, byte-determinism, export scope with
  secret-exclusion asserts, erasure retention policy) + 5 route cases
  (`routes/gdpr.test.ts` — export+email+download lifecycle, 401/404/410,
  step-up 403, confirmation 400, erasure 200 + audit). **NOT verified
  (operator):** vitest run, migration, a real emailed link via Resend.

### 2026-07-14 — Step 6.4: Promotion chain — QN-061 + BE-122 + BE-121

- **QN-061 signed risk report (Python):**
  `services/quant/app/quant/risk_report.py` — deterministic, self-contained
  HTML (metrics net of LLM cost, powered-comparison table, champion registry
  provenance, `platform_settings` + quant-config snapshot, verbatim
  disclaimer; all values HTML-escaped). `sign_report` = SHA-256 +
  HMAC-SHA256(`REPORT_SIGNING_KEY`), `verify_report` for the audit side.
  `routes_report.py`: `POST /risk-report/generate` **refuses without a
  signing key (503)** and **refuses unless the latest QN-060 verdict is PASS
  (409)** — a report documents evidence, it never invents it; `GET
  /risk-report/latest[?includeHtml=true]`. New `risk_reports` table stores
  content WITH hash+signature (self-contained audit trail, no filesystem
  dependency). New quant setting `report_signing_key`.
- **BE-122 paper gate (Node):** `live-promotion.ts` facts now carry
  `paperValidation.underpowered` + `signedRiskReport.sha256`;
  `paper_window_90d` detail documents the powered comparison (or the
  UNDERPOWERED guard), `signed_risk_report` detail shows the report hash.
  `routes/settings.ts` `gatherFacts` reads both `paper_validation_runs` and
  `risk_reports` latest rows — the checklist now flips on REAL evidence only.
- **BE-121 canary ramp + human confirm (Node):**
  - `signals-worker.ts` — in live mode, while `count(trades where
    trading_mode='live') < CANARY_CONFIRM_FIRST_N`: units clamped to
    `CANARY_MAX_UNITS`, intent created **`pending`** with a
    `riskGate.canary` block (requested vs clamped units), execution NOT
    enqueued, CRITICAL alert (`canary.confirm_required` ⇒ Telegram+SMS
    path) + `signal:canary_confirm_required` WS event; new cycle outcome
    `canary_pending`. Paper/backtest modes never consult the counter.
  - `routes/trades.ts` — `POST /api/trades/intents/:id/confirm` (one-tap):
    approves + enqueues `execute-intent`; **410 + auto-cancel after
    `CANARY_CONFIRM_TTL_MIN`** (a stale confirm executes into a different
    market); 409 for non-pending or **non-canary intents (no force-execute
    backdoor)**; `/reject` cancels with `CANARY_REJECTED`. Audited via
    `worker-audit`; WS fan-out when Redis wired.
  - `server.ts` now owns an execution-queue producer; `app.ts` gains
    `BuildAppOptions.trades`. New env: `CANARY_CONFIRM_FIRST_N` (10),
    `CANARY_MAX_UNITS` (1000), `CANARY_CONFIRM_TTL_MIN` (15) — in
    `.env.example` (check-env green, 78 keys) alongside
    `REPORT_SIGNING_KEY`.
- **Migration OWED (operator, with 6.1's):** `npx prisma migrate dev --name
  step_6_4_risk_reports && npx prisma generate` (or fold both new tables into
  one migrate run — operator's call).
- Verified: `py_compile` clean; `node scripts/check-env.mjs --ci` ✅; tests
  written — 8 pytest (`test_risk_report.py`: sign/verify roundtrip, tamper +
  wrong-key rejection, byte-identical determinism, content completeness,
  no-champion honesty, XSS escaping), 3 canary worker cases
  (`signals-worker.test.ts`: ramp parks pending+clamped+alerted, ramp ends
  at N, paper mode never engages), 6 route cases (`trades.test.ts`: 503 no
  queue, confirm happy path, TTL 410 + cancel, non-canary 409, decided 409 /
  unknown 404, reject), 3 BE-122/QN-061 checklist cases
  (`live-promotion.test.ts`). **NOT verified (operator):** pytest/vitest/
  typecheck runs (prisma generate owed), live `POST /risk-report/generate`
  against a real PASS row.

### 2026-07-14 — Step 6.3: Decision replay from provenance (QN-062 + FE-060 seam)

- **Two-leg split** (decision): the **agent leg** is pure provenance read on
  the Node side — `agent_runs.output` IS the LLM cache (cached-mode AC), no
  model is ever re-invoked; the **quant leg** is a side-effect-free
  point-in-time pipeline re-run on the Python side. Node composes both.
- **`services/quant/app/quant/pipeline.py`** — `run(..., persist=False)`
  skips ALL writes (baseline row, features upsert, cluster refresh): same
  computation, zero side effects, so a replay can never contaminate the
  provenance it is checking. Default unchanged (`persist=True`).
- **`services/quant/app/quant/replay.py`** — tolerance-based comparison
  (jsonb float round-trip safe), missing/extra feature keys reported
  explicitly, candidate geometry vs stored, and **model-version honesty**:
  a registry change since the original run marks probability "not judged"
  instead of reporting fake drift. Known **schema gap surfaced in the
  report**: `signals` doesn't persist the candidate's `model_version`, so
  the probability comparison is against the CURRENT champion (note emitted).
- **`services/quant/app/routes_replay.py`** (+ `main.py` include) —
  `POST /replay/quant`: re-run + compare; 422 on insufficient point-in-time
  data, 503 without a DB.
- **`apis/node-api/src/routes/signals.ts`** — `GET /signals/:id/replay`
  (closes the FE-060 full-transcript seam): complete bull/bear/judge debate
  transcript, every `agent_runs` row with provider/model/tier/downgrade
  provenance + parsed output, and the **exact §9.5 memory context resolved
  from `retrieved_memory_ids`** (BE-064 — the QN-062 AC); evicted memories
  come back as explicit tombstones, never dropped. Quant leg proxied to
  `POST {QUANT_HTTP_URL}/replay/quant`; unreachable ⇒ `quant.available:
  false` + reason, transcript still serves (honest seam). New
  `BuildAppOptions.signals.fetchImpl` test seam (app.ts).
- **`packages/types/src/agents.ts`** — Replay contracts (Node-internal, NOT
  in `contractSchemas` per the registry convention — no codegen churn).
- Verified: `py_compile` clean; 11 pytest cases
  (`tests/quant/test_replay.py` — tolerance, drift, key diffs, version
  honesty, persist=False writes-nothing with persist=True control) + 3 route
  tests appended to `routes/signals.test.ts` (404, full replay incl.
  tombstone + proxy body, quant-down honesty). **NOT verified (operator):**
  `uv run pytest tests/quant/test_replay.py`, node vitest/typecheck (needs
  `prisma generate` from Step 6.1), and a live replay against real rows.

### 2026-07-14 — Step 6.2: Chaos test suite (BE-120)

- **`apis/node-api/src/chaos/chaos.test.ts`** — one repeatable suite
  (`pnpm --filter @fx/node-api test -- chaos`) composing the REAL components
  (AgentGraph, CircuitBreaker, QuantPipelineClient, KillSwitchStore, the
  `@fx/risk-gate` engine, the full BE-066 cycle) with injected faults.
  Scenarios map 1:1 to the story ACs:
  - **S1** Redis flushed while kill-switch active → `isActive()` re-hydrates
    ACTIVE from Postgres (cache repopulated, never silently cleared), cycle
    HOLDs `halted` with ZERO LLM calls; a second flush after deactivation
    stays released — flush alone never flips the switch either way.
  - **S2** OANDA disconnect (sticky `execution:halt`) → every instrument
    HOLDs, zero LLM spend.
  - **S3** LLM total outage, both flavours (all providers **rejecting** and
    all providers **hanging**) → deterministic `pm_hold` inside the graph
    budget, degradation notes persisted (partial-transcript contract), no
    hung jobs — asserted by wall-clock bound.
  - **S4** quant gRPC outage → 3 transport failures OPEN the §2.2 breaker;
    while open, ALL instruments HOLD `CIRCUIT_OPEN` with **no connection
    attempted** (stub call-count pinned); after 60 s (injected clock) the
    HALF-OPEN probe against a healed service re-closes; a failed probe
    restarts the full cooldown instead of resuming traffic.
  - **S5** flash crash (20 pips ≥ 5× EUR_USD 3-pip cap) → `FLASH_SPREAD`
    veto, `HALT_NEW_ENTRIES` flag audited, **critical alert** on the
    notifications queue (Telegram+SMS fan-out surface); control case shows
    normal spread doesn't trip it.
  - **S6** daily P&L −6% → `DAILY_DD_HALT` veto.
  - **S7** weekend gap: QN-047 `weekend_gap_window` + LOW liquidity + flatten
    armed → `WEEKEND_GAP_WINDOW` veto and `WEEKEND_GAP_FLATTEN` flag naming
    every open position; flatten-disabled control is advisory only.
  - **S8** worst case: ALL 6 instruments candidate at the same bar close +
    forced 2 debate rounds + one degraded provider (every-5th LLM call slow +
    failed-over), semaphore 3 → every job `executed`, per-job `e2eMs`
    (clock at **semaphore acquisition**, §2.2) within budget, wait queue
    served strictly most-liquid-first (probed subclass records grant order)
    — no starved instrument.
- Budgets are ms-scaled; code paths/policies are production. The **<180 s
  wall-clock bound with real budgets is a staging drill**, to be scripted in
  PHASE6_TESTING_GUIDE (end of phase) — the suite deliberately asserts the
  same invariants at test scale rather than faking a 3-minute test.
- Verified: nothing runtime — sandbox has no node_modules/venv. **Operator:**
  `pnpm --filter @fx/node-api test -- chaos` (after `prisma generate`;
  Vitest, no DB/Redis needed — suite is self-contained fakes).

### 2026-07-14 — Step 6.1: 90-day paper vs baseline validator (QN-060)

- **`services/quant/app/quant/paper_validation.py`** — the validator. Pure
  logic (unit-testable, no DB): agent leg = realized R per closed paper trade
  (net P&L / units×|entry−stop|; un-normalisable trades skipped + warned,
  never guessed); LLM window spend converted to R via mean per-trade risk and
  deducted (**net of LLM cost** AC); baseline leg = stored `baseline_signals`
  candidates re-resolved through the QN-043 bracket sim (`label_outcomes`,
  win ⇒ +rr·R, loss ⇒ −1R; unresolved tails dropped). Verdict precedence:
  **EXTEND** (§9.4: downgraded share >10% ⇒ window must extend) →
  **UNDERPOWERED** (two-sample normal-approx power calc vs the
  **pre-registered** `effect_size_r=0.10R`, α=0.05, power=0.8 —
  necessary-but-not-sufficient guard, can never PASS) → **PASS/FAIL**
  (agent net mean R − baseline mean R ≥ effect size).
- **`apis/node-api/prisma/schema.prisma`** — new `PaperValidationRun` model →
  `paper_validation_runs` (append-only; latest row authoritative; verdict
  String PASS|FAIL|EXTEND|UNDERPOWERED, downgraded_share, effect_size_r,
  metrics jsonb). **Migration is OWED (operator):** `cd apis/node-api && npx
  prisma migrate dev --name step_6_1_paper_validation && npx prisma generate`
  — node-api typecheck stays red until generate runs (same as Phase 5).
- **`services/quant/app/quant/dbio.py`** — window-bounded reads (closed paper
  trades joined to intents for stop fallback, `SUM(cost_usd)` over
  `agent_runs`, downgraded share as `BOOL_OR(model_downgraded)` per paper
  signal cycle, `would_trade` baseline rows) + verdict insert +
  `latest_paper_validation` — all behind the QuantDb seam
  (`PaperValidationDb` protocol keeps the validator fakeable).
- **`services/quant/app/routes_validation.py`** (+ `main.py` include) —
  `POST /paper-validation/run` (body = the pre-registered plan; overrides are
  persisted into the metrics row) and `GET /paper-validation/latest` (404
  before first run). Shares QuantRuntime with routes_backtest.
- **`apis/node-api/src/routes/settings.ts`** — `gatherFacts` now reads the
  latest `paper_validation_runs` row; BE-101's `paper_window_90d` checklist
  item flips only on a stored `PASS` (was hard-coded null). `signed_risk_report`
  stays fail-safe null until QN-061 (Step 6.4).
- Decisions: comparison in R-multiples (risk-normalised, instrument-agnostic);
  quote-ccy risk approximation documented in the module docstring; candles
  fetched to `now` so post-window bars resolve late brackets (resolution only,
  no selection); verdict values uppercase to match QN-053's `VALIDATED` style.
- Verified: `py_compile` on all touched Python; 15 pytest cases written
  (`tests/quant/test_paper_validation.py` — R-normalisation incl. swap/
  commission netting, cost-deduction flips PASS→FAIL, §9.4 EXTEND precedence,
  underpowered guard, bracket-sim resolution on a synthetic uptrend, fake-db
  orchestration + persist flag). **NOT verified (operator, sandbox has no
  venv/DB):** `uv run pytest tests/quant/test_paper_validation.py`,
  `uv run mypy`, `uv run ruff check`, the owed migration + `prisma generate`,
  `pnpm --filter @fx/node-api typecheck`, and a live `POST
  /paper-validation/run` against real paper data.

---

*Template for new entries:*

```
### YYYY-MM-DD — Step X.Y: <name> (story IDs)

- <what was added/changed, file paths>
- <decisions made + why, if any>
- Verified: <what was actually run/tested; note anything NOT verified>
```
