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

## Current state (updated 2026-07-14)

- **Phases 4 AND 5 are CODE-COMPLETE but runtime-UNPROVEN, uncommitted, and
  NOT installed/migrated.** Nothing since Phase 3 (Step 3.3 = `c3b0051`) has
  been committed, `pnpm install`ed, migrated, built, unit-tested, or drilled on
  a real machine. **Before any Phase-6 work starts, the combined operator gate
  must run:** the Phase-3/4 runtime gate ([`PHASE4_TESTING_GUIDE.md`](PHASE4_TESTING_GUIDE.md))
  plus the Phase-5 gate ([`PHASE5_TESTING_GUIDE.md`](PHASE5_TESTING_GUIDE.md)
  §A), then the §D–§L drills, finishing with the §L exit-criteria walkthrough
  (sign-in → arm paper → observe debate → kill-switch from a phone, alerts
  firing).
- **Two migrations are PENDING** (generated, never hand-written; operator runs
  them in `apis/node-api`): `step_5_1_auth` (RecoveryCode, InviteRedemption,
  `User.twoFactorEnabledAt`, `InviteCode.revokedAt`) and
  `step_5_3_settings_calendar` (`platform_settings`, `calendar_events`).
  `npx prisma generate` is also unrun — node-api typecheck stays red until then.
- **Commits owed once gates pass (user controls timing):** Phase 4
  (`feat(lifecycle): …`), then Steps 5.1 → 5.4 + seam-closes per the suggested
  sequence in [`PHASE5_TESTING_GUIDE.md`](PHASE5_TESTING_GUIDE.md) §5.
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

---

*Template for new entries:*

```
### YYYY-MM-DD — Step X.Y: <name> (story IDs)

- <what was added/changed, file paths>
- <decisions made + why, if any>
- Verified: <what was actually run/tested; note anything NOT verified>
```
