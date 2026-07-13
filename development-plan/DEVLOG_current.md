# DEVLOG — Phase 5 (Surface)

Continuation of [`DEVLOG_phase4.md`](DEVLOG_phase4.md) (the Phase-4 record —
Lifecycle; per-step build history lives there) and, before it,
[`DEVLOG_phase3.md`](DEVLOG_phase3.md), [`DEVLOG_phase2.md`](DEVLOG_phase2.md)
and [`DEVLOG-phase1.md`](DEVLOG-phase1.md). The **Standing decisions** and
**Conventions** carried through Phases 1 → 4 are carried forward in full below
and remain the *current* single source of truth — no need to cross-read the
earlier logs for them. Same rules: **append a new entry per step; keep "Current
state" at the top updated.** Plan: [`FX_PRD.md`](FX_PRD.md) §9 Phase 5, stories
in `FX_Stories_*.md`, architecture in `system-design/FX_System_Design.md`.

**Phase 5 outcome:** full auth, dashboard, settings, and notifications — the
operator can run the platform without touching a terminal.
**Exit criteria:** operator completes the full workflow (sign-in → arm paper →
observe debate → kill-switch) from the dashboard, with alerts firing.

---

## Current state (updated 2026-07-13)

- **Phase 5 Step 5.2 (Dashboard) is CODE-COMPLETE, runtime-UNPROVEN,
  uncommitted, and NOT installed.** All FE-041/040/042/050/060/070/080/090/100/
  101/102 shipped in source on a new shared api-client/query/WS layer (see the
  Step-5.2 entry below). Fully wired to real endpoints: `/audit` (BE-130),
  `/backtests` (BE-090), `/signals` (BE-067), `/market/*` (BE-045),
  `/settings/kill-switch` (BE-072/073). Remaining seams surfaced honestly (not
  faked): broker-equity tiles, gRPC-breaker + session/liquidity health pills,
  trades REST (BE-054), quant calibration proxy (QN-055), settings persistence
  (BE-100), economic calendar (BE-110), per-signal agent-run provenance replay.
  **Operator gate before it renders: `pnpm install` (new deps) → build
  `@fx/types` + `@fx/api-client` → dashboard `typecheck`/`build` → `biome check
  --write`.** No new migration, no new env keys. **Next: Step 5.3 (settings +
  notifications backend) unblocks the FE-100/101 seams; Step 5.4 adds realtime
  toasts polish + a11y + Playwright E2E (DoD).**

- **Phase 5 Step 5.1 (Auth backend + 2FA) is CODE-COMPLETE, runtime-UNPROVEN,
  uncommitted, and NOT installed/migrated.** BE-030…037 + FE-030…036 all shipped
  in source (see the Step-5.1 entry below). It needs three operator-run steps
  before anything works: (1) `pnpm install` (new deps: `@node-rs/argon2`,
  `otpauth`, `jose`, `resend` in node-api; `jose` in the dashboard); (2)
  `pnpm --filter @fx/types build` (new auth contracts) then, in `apis/node-api`,
  `npx prisma migrate dev --name step_5_1_auth` (**new migration IS pending** —
  `RecoveryCode`, `InviteRedemption`, `User.twoFactorEnabledAt`,
  `InviteCode.revokedAt`; ask the operator to run it — generated, never
  hand-written); (3) `pnpm --filter @fx/node-api test` + dashboard `build`.
  New required env keys (`NEXTAUTH_SECRET`, `INTERNAL_SYNC_TOKEN`) are already
  in `.env` / `.env.example` with dev values — **the API and every worker now
  refuse to boot without them.**
- **Rest of Phase 5 (Steps 5.2–5.4) NOT STARTED.** Scope + suggested build order
  are in the next section (PRD §9). Beyond the Step-5.1 auth pages + a minimal
  header UserMenu, `apps/dashboard` is still the Phase-1 scaffold.
- **Phase 4 (Lifecycle) is CODE-COMPLETE but runtime-UNPROVEN and uncommitted.**
  Supervision (BE-080/081), the vectorbt quant engine + validation/ablation
  (QN-050…054), calibration/regime endpoints (QN-055), the event-driven agentic
  runner + three modes (QN-056/052), and the backtest API (BE-090) all shipped
  in source and were source-audited, but nothing has been `pnpm install`ed,
  migrated, built, unit-tested, or drilled on a real machine, and no live
  gRPC/LLM/broker round-trip has run. Full record + per-step history in
  [`DEVLOG_phase4.md`](DEVLOG_phase4.md); ordered proof plan in
  [`PHASE4_TESTING_GUIDE.md`](PHASE4_TESTING_GUIDE.md). **FE-080 (backtest
  config + results UI) was deliberately deferred to Phase 5** — it lands here
  with the rest of the dashboard, hung on the new AppShell (BE-090 already
  surfaces results over REST/WS, so the API is the interface until then).
- **Carried-forward runtime gate (Phases 3 + 4 — a hard prerequisite for the
  Phase-5 dashboard to show anything real):**
  1. `pnpm install` (links the workspace; picks up `@fx/risk-gate` +
     Phase-4 backtest/supervision modules).
  2. `npx prisma generate` then `npx prisma migrate dev` in `apis/node-api`.
     **No new migration is pending** — the Phase-3 `kill_switch_state` table and
     the Phase-4 `supervisions` / `backtest_runs` tables are already in the
     committed chain (`20260704000000_init` carries the Phase-4 tables; expect
     "No changes"). Just apply the chain and confirm the tables exist
     ([`PHASE4_TESTING_GUIDE.md`](PHASE4_TESTING_GUIDE.md) §B).
  3. `pnpm --filter @fx/types build && pnpm --filter @fx/risk-gate build`
     (+ `@fx/llm` build) — node-api resolves these via dist at runtime.
  4. Root `pnpm typecheck / test / lint` — the Phase-3 red-team suite and all
     Phase-4 vitest suites (supervision gate/exits, agentic-runner determinism +
     reconciliation, llm-cache, backtests worker) are unrun in the sandbox.
  5. Runtime drills: Phase-3 risk-gate E2E + kill-switch <2s timed activate
     ([`PHASE3_TESTING_GUIDE.md`](PHASE3_TESTING_GUIDE.md)); Phase-4 supervision
     drill (gate_skip zero-cost + a layered exit) and one backtest/agentic run
     against real cached candles + a **retrained** champion
     ([`PHASE4_TESTING_GUIDE.md`](PHASE4_TESTING_GUIDE.md) §D–§G).
  6. **Commit Phase 4** once its gate passes — suggested:
     `feat(lifecycle): Step 4.1 supervision + Step 4.2 backtest harness (BE-080/081, QN-050..056, BE-090)`.
     Phases 1–3 are already committed (Step 3.3 = `c3b0051`, 3.1/3.2 =
     `8ef34fe` / `975c2c8`); Phase 4 is the only uncommitted work in the tree.
- **Carried-forward known issue (from Phase 2 — blocks meaningful dashboard
  numbers):** the only trained model `XAU_USD/H1 v1` has **no predictive edge**
  (OOF AUC 0.51, ~6 months / 2,121 candidates) — a plumbing/smoke artifact
  only. **Retrain on ≥18 months H1** (train→promote flow,
  [`PHASE2_TESTING_GUIDE.md`](PHASE2_TESTING_GUIDE.md) §E) before the quant
  dashboard (FE-090), calibration curves, or backtest results (FE-080) show
  anything worth trusting. A champion with `has_candidate=true` is also what
  makes the live agent debate viewer (FE-060) actually fire.
- **Next:** close the carried-forward runtime gate above (it is a hard
  prerequisite — the dashboard renders live state, so the live path must work
  first), then open Phase 5 with Step 5.1 (auth backend + 2FA) since every
  user-facing surface hangs off it (BE-030 replaces the Phase-1 internal-token
  stand-in behind the same `RequestContext`).

## Phase 5 scope (from `FX_PRD.md` §9 — build order)

**Step 5.1 — Auth backend + 2FA**
- BE-030 — NextAuth JWT verification middleware (replaces the Phase-1 stand-in
  behind the same `RequestContext`).
- BE-031 — User upsert on sign-in.
- BE-032 / BE-033 — Email/password registration + login.
- BE-034 — Email verification + password-reset tokens.
- BE-035 — Invite-code validation + CRUD.
- BE-036 — TOTP 2FA enroll/verify + step-up flag + recovery codes (finally
  verifies the `twoFactorCode` accepted-but-unchecked seam from Phase 3).
- BE-037 — Account linking (Google ↔ credentials).
- FE-030 — Google OAuth sign-in (NextAuth v5).
- FE-031 — Email/password registration with invite code.
- FE-032 — Email/password sign-in.
- FE-033 — Forgot-password + reset flow.
- FE-034 — Email-verification pending UX.
- FE-035 — TOTP 2FA enrollment + step-up modal (+ recovery codes).
- FE-036 — Account settings (link Google, change password).

**Step 5.2 — Dashboard**
- FE-041 — AppShell navigation (the surface FE-080 and every operator page hang
  off).
- FE-040 — Operator home (`/dashboard`).
- FE-042 — System health strip (circuit breaker, liquidity regime, session
  labels, `model_downgraded`, gap-flatten arming — v2.2 machinery).
- FE-050 — Charts page (Lightweight Charts).
- FE-060 — Live agent debate viewer (incl. debate depth + memory inspection).
- FE-070 — Trades history with provenance.
- FE-080 — Backtest config + results UI (**deferred in from Phase 4**; consumes
  BE-090's REST/WS surface).
- FE-090 — Quant dashboard (calibration, regimes — consumes the QN-055
  `/models/{…}/calibration` + `/regime/{instrument}` endpoints already built in
  Phase 4).
- FE-100 — Settings page (risk params, clustering, session multipliers,
  per-instrument limits).
- FE-101 — Economic calendar.
- FE-102 — Audit-log viewer.

**Step 5.3 — Settings & notifications backend**
- BE-100 — Settings CRUD API.
- BE-101 — Live-promotion gate (enforces the QN-053 `NOT VALIDATED` block on
  promoting a model to live — the Phase-4 validation verdict finally becomes a
  gate here).
- BE-110 — Economic calendar service (wires the `CalendarProvider` seam left
  open since Phase 3; unblocks `pre_news_flatten` and the supervision
  news-blackout signal, which currently record `calendar_unavailable` and pass).
- BE-115 — Telegram bot for trade events.
- BE-116 — Resend email digests.
- BE-117 — WS event-emitter helper.
- BE-118 — Twilio SMS for critical alerts.

**Step 5.4 — Realtime, polish, accessibility**
- FE-120 — WebSocket subscription + toasts (incl. partial-fill notifications).
- FE-121 — Graceful error states.
- FE-130 — Mobile-first safety controls (kill-switch reachable on phone).
- FE-131 — WCAG 2.2 AA on core flows.

**Suggested build order:** Step 5.1 first — auth is the root dependency for
every user-facing surface (BE-030 → BE-031 → registration/login → 2FA → OAuth
linking, with the matching FE pages). Then Step 5.2 opens with FE-041 (AppShell)
since every page hangs off it, then the read-only pages (FE-040/042/050/070)
before the interactive ones (FE-060/080/090/100). Step 5.3 backend can proceed
in parallel with 5.2 (settings CRUD + notifications + the calendar service that
unblocks the news seams). Step 5.4 (realtime/polish/a11y) lands last across the
finished surfaces. BE-101 (live-promotion gate) should land before any live
promotion is attempted.

## Phase-5 specific context (seams already built in earlier phases)

- **Auth stand-in to replace, not rebuild:** Phase 1 shipped an internal
  service-token auth stand-in behind a `RequestContext` (BE-013) + audit
  middleware. BE-030 swaps in real NextAuth JWT verification *behind the same
  `RequestContext`* — downstream handlers should not need to change. Broker
  creds are seeded via env/CLI until the settings write path (BE-100) arrives.
- **2FA seam is half-built:** the kill-switch activate path already accepts +
  audits a `twoFactorCode` but never verifies it (unchecked until BE-036).
  Phase 5 makes it real; activation must still never be *blocked* on 2FA until
  the enroll/verify flow exists.
- **Kill-switch button is a visible no-op today:** the dashboard kill-switch
  (FE-033-era) is a UI placeholder until auth lands — the REST/gRPC kill-switch
  is the operator interface for now. FE-130 makes it reachable on mobile once
  auth + AppShell exist.
- **Backtest results already have an API (BE-090):** `POST /backtests`,
  `GET /backtests`, `GET /backtests/:id` (metrics, OOS verdict, ablation,
  trades) + the `backtests` WS channel (`backtest:finished` / `backtest:failed`)
  are live from Phase 4. FE-080 is a pure consumer — no new backend needed.
- **Quant analytics endpoints already exist (QN-055):**
  `GET /models/{instrument}/{tf}/{version}/calibration` and
  `GET /regime/{instrument}` were built in Phase 4; FE-090 consumes them
  directly (404 if no such model version, 422 if too few bars).
- **Economic calendar is the notable open backend:** no vendor is wired — the
  blackout rule + `pre_news_flatten` record `calendar_unavailable` and pass. The
  NFP fixture defines expected behaviour; BE-110 is where a real
  `CalendarProvider` lands and FE-101 surfaces it.
- **Validation verdict becomes a gate here:** QN-053's `VALIDATED |
  NOT VALIDATED` is computed in Phase 4 but only *reported*; BE-101 turns it into
  an enforced live-promotion gate.
- **WS event plumbing is partly in place:** `publishWsEvent(…)` already emits
  `backtests` and supervision/agent-run events; BE-117 generalises the emitter
  and FE-120 subscribes with toasts.
- **Broker equity sync still a seam:** account equity =
  `ACCOUNT_BASELINE_EQUITY` + realized P&L (Phases 2–4). Fine for paper/backtest
  and for the dashboard's equity strip; revisit before live (Phase 6).

## Standing decisions (carried from Phases 1–4 — don't re-litigate without cause)

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
- **Auth:** Phase 1 shipped an internal service-token stand-in; **all
  user-facing auth (UI + API) lands in THIS phase** (Step 5.1). BE-030 replaces
  the stand-in behind the same `RequestContext`; broker creds are seeded via
  env/CLI until the settings write path (BE-100).
- **DB schema:** Prisma migrations = relational DDL only; every
  Timescale/pgvector-index object goes in `apis/node-api/prisma/timescale.sql`
  (idempotent, applied by `pnpm db:timescale` after `db:deploy`) — NEVER in a
  migration, or the CI drift check breaks. Destructive migration SQL needs a
  `-- destructive-ok: <reason>` marker. Credential envelope format is
  `v1:base64(iv‖tag‖ct)` AES-256-GCM — Python quant matches it. **Migration
  files are generated, never hand-written** (project CLAUDE.md): run
  `prisma migrate dev`; ask the operator to run it if the sandbox can't. The
  Phase-5 auth tables (users, sessions, verification/reset tokens, invite codes,
  2FA/recovery, account links) will be the next real migration.
- **FinBERT (`uv sync --group ml`):** first real consumer is the BE-062
  sentiment-analyst node; sentiment *accuracy* is first exercised by the Phase-4
  backtests (QN-051/QN-054). Still mock until a node actually reads real scores.
- **Deterministic quant core stays LLM-free (§10):** no LLM ever touches
  `app/quant/` — agents *refine/confirm/veto* the quant candidate, they don't
  generate the numbers. The graph fires only on quant candidates (ADR-010) and
  the risk gate (BE-070) is the final deterministic authority.

## Conventions (carried from Phases 1–4)

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

<!-- Append Phase 5 step entries below, newest first. -->

### 2026-07-13 — Step 5.2: Dashboard (FE-041, FE-040/042, FE-050, FE-060, FE-070, FE-080, FE-090, FE-100, FE-101, FE-102)

Full operator surface built on a new shared data/realtime layer. **Uncommitted,
runtime-UNPROVEN, and NOT installed** — new dashboard deps must be `pnpm
install`ed first (see operator gate below).

**Shared infra (new):**
- `packages/api-client/src/index.ts` — extended the typed client (was
  health+trades only) with `market.{instruments,candles,news}` (BE-045/042),
  `signals.list` (BE-067), `backtests.{list,get,create}` (BE-090),
  `audit.list` (BE-130), and `killSwitch.{get,set}` (BE-072/073). GET queries
  take partials (server fills zod defaults); every response Zod-validated. Kept
  the strict `verbatimModuleSyntax` split (type-only imports separated).
- `apps/dashboard/src/lib/api.ts` — browser client factory: bearer minted at
  `/api/token`, 401 → `/sign-in`, 403 `STEP_UP_2FA_REQUIRED` → step-up store.
- `lib/hooks.ts` — TanStack Query hooks (signals, candles, instruments,
  backtests, audit, kill-switch, trades) with cache keys + invalidation.
- `lib/use-ws.ts` — WS subscription hook (`/ws?token=`), reconnect w/ backoff,
  handles the `TOKEN_EXPIRED` close (BE-014). Flat `{type,channel}` client
  frames (matches `WsClientMessageSchema`; the signals.ts doc-comment showing a
  `data`-wrapped shape is stale).
- `stores/step-up.ts` (zustand) + `components/step-up-gate.tsx` — global 403
  step-up gate, mounted once in the dashboard layout.
- `app/providers.tsx` — added `QueryClientProvider` + Sonner `<Toaster>`
  (FE-120 toast sink).
- `components/{kill-switch,states,page-header,app-nav}.tsx` — the kill-switch is
  now API-wired (replaces the Phase-3 visible no-op): activate carries a reason
  + step-up code when 2FA is enrolled; already-halted flips to a deactivate
  affordance reading the PG source-of-truth state. `states.tsx` = FE-121
  Empty/Error/Loading (a `DB_UNAVAILABLE`/`KILL_SWITCH_UNAVAILABLE` code renders
  a calm "not available yet" seam notice).

**Pages (all under a new `(dashboard)/layout.tsx` = FE-041 AppShell: sidebar nav
with active highlight, ModeBadge, kill-switch, UserMenu, disclaimer, mobile
sticky footer with the kill-switch one tap away, FE-130 groundwork):**
- FE-040 `/dashboard` + FE-042 health strip — tiles + system-health pills
  (kill-switch state + `model_downgraded` are real; gRPC breaker + session/
  liquidity regime are labelled seams, not faked). Live WS bridge invalidates
  queries + toasts on `signals`/`risk.*`.
- FE-050 `/charts` — Lightweight Charts v5 candles (`/market/candles`),
  EMA(20/50), instrument selector, H1/D1 toggle, past-signal markers.
- FE-060 `/agents` — signals list + selected-cycle detail (quant candidate,
  P, roles, cost, debate turns), live `signals` stream, explicit `gate_skip`
  zero-cost card. Full per-role transcript + retrieved memories = the remaining
  per-signal provenance seam (BE-067 exposes summaries only).
- FE-070 `/trades` — expandable provenance rows + CSV export (BE-054 seam;
  graceful empty/unavailable).
- FE-080 `/backtest` — config form validated against `BacktestConfigSchema`,
  run list, detail (OOS metrics picked from the free-form engine report,
  validation verdict, reproducible/non-reproducible label), WS `backtests`
  progress. **Fully wired to BE-090** (deferred in from Phase 4).
- FE-090 `/quant` — recharts reliability diagram scaffold + champion/regime
  panels; QN-055 reads need a Node proxy (seam) + a retrained champion.
- FE-100 `/settings` — v2.2 risk knobs (clustering, session multipliers,
  gap-flatten, per-instrument loss, debate-regime mapping, entry-gate
  pre-filter) range-validated client-side; persistence = BE-100 seam; live
  promotion gated (step-up + BE-101).
- FE-101 `/calendar` — events + ±30 min blackout UX; BE-110 vendor seam.
- FE-102 `/audit` — `GET /audit` with method/actor filters + pagination.
  **Fully wired to BE-130.**
- `middleware.ts` — gated-prefix list extended to every operator route (the
  `(dashboard)` group resolves to top-level paths).

**Deps added to `apps/dashboard/package.json`** (operator installs):
`@tanstack/react-query`, `zustand`, `sonner`, `lightweight-charts`, `recharts`,
`react-hook-form`, `@hookform/resolvers`.

- Decisions: reused/extended `@fx/api-client` rather than a dashboard-local
  fetcher, so 401/step-up handling + runtime Zod validation live in one place.
  Kept `zod` out of the dashboard's own deps (settings uses plain range checks;
  the authoritative settings schema lands in `@fx/types` with BE-100). Seam
  pages render honest "awaiting feed / BE-xxx" states rather than fabricated
  numbers, matching the repo's convention.
- Verified: symbol-existence checked against `@fx/types` source; type/import
  correctness reviewed by hand. **NOT verified in-sandbox:** `tsc`/`biome`/
  `vitest` can't run here — the workspace bundler (tsup→rollup) and biome are
  missing arm64 native bindings (same limitation Phase 4/Step 5.1 documented),
  and the new dashboard deps aren't installed. **Operator gate:** `pnpm install`
  → `pnpm --filter @fx/types build` → `pnpm --filter @fx/api-client build` →
  `pnpm --filter @fx/dashboard typecheck && pnpm --filter @fx/dashboard build`
  → `biome check --write` (import-sort/`useImportType`). No new migration or env
  keys. E2E (Playwright) + a11y (axe) per the DoD still to add in Step 5.4.

### 2026-07-12 — Step 5.1: Auth backend + 2FA (BE-030…037, FE-030…036)

**Contracts (`packages/types/src/auth.ts`)** — added `UserRoleSchema`,
`PasswordSchema` (≥12, letter+digit), `AUTH_ERROR` codes, `ApiTokenClaims`
(the HS256 Bearer shape), and request/response schemas for sign-in-sync,
register, login, verify, reset, invite CRUD, TOTP enroll/verify/step-up/status,
account + change-password. **Deliberately did NOT add `role` to `FXSessionSchema`
(it's in `contractSchemas` → would churn the QN-003 Python drift check);** role
travels via `ApiTokenClaims` (not registered) + the NextAuth session
augmentation instead. `@fx/types` typechecks clean.

**Schema (`apis/node-api/prisma/schema.prisma`)** — `User.twoFactorEnabledAt`;
new `RecoveryCode` (argon2-hashed, single-use) and `InviteRedemption` (per-use
audit) models; `InviteCode.revokedAt`. **A migration is pending — operator must
run `npx prisma migrate dev --name step_5_1_auth`** (generated, not
hand-written, per CLAUDE.md). The Phase-1 `users`/`invite_codes`/
`email_verification_tokens` tables already existed; this fills the 2FA/linking
gaps.

**BE-030 (`src/context.ts` + `src/auth/jwt.ts`)** — replaced the internal-token
stand-in *behind the same `RequestContext`*: `Authorization: Bearer <jwt>` is
verified with `jose` HS256 against `NEXTAUTH_SECRET`; claims populate
`user/role/stepUp2FAAt`; suspended users 403 even with a valid token; the
`x-internal-token` path stays for server-to-server callers (workers,
dead-man's switch). Downstream Phase 1–4 handlers unchanged. Covered by
`src/context.test.ts` (valid/invalid/expired/internal/anonymous via `app.inject`).

**BE-031…037 (`src/auth/*`, `src/routes/auth.ts`)** — `AuthService` owns all DB
access; routes are a thin schema-validated shell. Endpoints: `POST
/auth/sign-in-sync` (server-to-server via `x-internal-sync-token`, upserts +
links Google↔credentials, invite-gates first-time Google users), `/auth/register`
(invite-gated, argon2, verification email), `/auth/login` (NextAuth authorize
target, in-memory failed-login limiter), `/auth/verify` + `/auth/request-
password-reset` + `/auth/reset-password` (SHA-256-hashed single-use tokens,
Resend or console mock), `/admin/invites` CRUD (`requireRole('admin')`),
`/auth/2fa/{enroll,enroll/verify,verify,status}` (TOTP via `otpauth`, secret
sealed with the credentials key under `fx-totp-secret:v1` AAD, 10 single-use
recovery codes shown once), `/auth/account` + `/auth/account/change-password`
(`requireStepUp` — 15-min TOTP window). Pure-logic unit tests for seal, tokens,
invites, guards, jwt, totp, recovery-codes.

**BE-036 kill-switch wiring** — the `twoFactorCode` seam is now real: a wired
`TwoFactorVerifier` (via `AuthService.verifyTwoFactor`, consuming recovery codes)
verifies a supplied code against the acting user. A wrong code blocks; no code
does not (activation is never blocked on 2FA infra — fail-safe direction).
`server.ts` constructs and passes the verifier.

**BE-014** — the `/ws` gateway now also accepts a user JWT via `?token=` and
closes the socket with a `TOKEN_EXPIRED` re-auth hint at the token's `exp`.

**FE-030…036 (`apps/dashboard`)** — NextAuth v5 config (`src/auth.ts`: Google +
Credentials, JWT strategy, sign-in-sync in the signIn callback, `stepUp2FAAt`
refreshed via `session.update()`), `[...nextauth]` + `/api/token` (mints the
short-lived API Bearer server-side) route handlers, `middleware.ts` gating
`/dashboard`+`/settings`, `SessionProvider`. Pages: sign-in (Google + email/pw),
register (invite), forgot-/reset-password, verify + verify-pending, account
settings (profile, Google-link, 2FA enroll + recovery codes, step-up modal,
change/set password). A header `UserMenu` (account link + sign-out) makes the
surface reachable end-to-end.

**Env** — `NEXTAUTH_SECRET` + `INTERNAL_SYNC_TOKEN` are now **required** (min 16;
API + workers won't boot without them); added `APP_BASE_URL`, `RESEND_API_KEY`
(optional → console mock), `EMAIL_FROM`, `AUTH_TOKEN_TTL_MIN`,
`AUTH_LOGIN_MAX_ATTEMPTS`, `TOTP_ISSUER`, `STEP_UP_2FA_TTL_MS`. All in `env.ts`,
`.env`, `.env.example`; the four in-repo test env builders updated so existing
suites still parse.

- Decisions: HS256 signed JWT (per BE-030 note) rather than NextAuth's default
  JWE, so the API verifies with plain `jose.jwtVerify`; the dashboard mints the
  Bearer from the session at `/api/token`. Password change requires 2FA enrolled
  (step-up can't otherwise be satisfied) — surfaced in the UI.
- Verified: `@fx/types` `tsc --noEmit` clean (twice). **NOT verified in-sandbox:**
  `vitest` (missing native `rolldown` arm64 binding) and `biome` (missing arm64
  binary) can't run here, and node-api `tsc` needs the new deps + regenerated
  Prisma client + `@fx/types` dist first. Operator gate: `pnpm install` →
  `pnpm --filter @fx/types build` → `npx prisma generate && npx prisma migrate
  dev --name step_5_1_auth` (in `apis/node-api`) → `pnpm build && pnpm test &&
  pnpm lint` (run `biome check --write` for import-sort/format) → dashboard
  `pnpm --filter @fx/dashboard build`.

---

*Template for new entries:*

```
### YYYY-MM-DD — Step X.Y: <name> (story IDs)

- <what was added/changed, file paths>
- <decisions made + why, if any>
- Verified: <what was actually run/tested; note anything NOT verified>
```
