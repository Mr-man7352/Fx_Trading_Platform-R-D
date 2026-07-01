# FX Platform — Frontend User Stories

*Companion to [`system-design/FX_System_Design.md`](system-design/FX_System_Design.md)*  
*Version 2.2 · 2026-07-01*  
*Scope: All phases — Foundation (Phase 1) through Go-live (Phase 6)*

---

## How to use this document

Each story is tracker-ready: import into Linear/Jira/Notion as one ticket per story. Story IDs use prefix `FE-`. Story points use a Fibonacci-style scale (1, 2, 3, 5, 8, 13). Acceptance criteria are Given/When/Then.

**Story shape:**

```
### FE-XXX — Title
**As a** <role> **I want** <capability> **so that** <outcome>.

**Acceptance criteria**
- Given … When … Then …

**Technical notes**
- Implementation hints, file paths, library calls, gotchas.

**Dependencies**
- Other stories that must merge first.

**Points:** N  ·  **Phase:** N  ·  **Epic:** EP-FE-X
```

---

## Pinned package versions (verified 2026-06-28)

| Package | Version | Notes |
|---|---|---|
| `next` | `16.2.9` | App Router; Turbopack default; React 19 |
| `react` / `react-dom` | `19.2.x` | Required by Next 16 |
| `typescript` | `5.9.x` | Match Node API; TS 6 when ecosystem stable |
| `tailwindcss` | `4.x` | CSS-native `@theme`; no `tailwind.config.js` |
| `@tailwindcss/postcss` | `4.x` | v4 PostCSS pipeline |
| `shadcn` (CLI) | latest | Pin primitives in `packages/ui` |
| `next-auth` | `5.0.x` | Auth.js v5 — Google + Credentials providers |
| `zod` | `4.x` | Shared via `@fx/types` |
| `@tanstack/react-query` | `5.x` | Server state |
| `zustand` | `5.x` | UI state (kill-switch arm, WS reconnect) |
| `lightweight-charts` | `5.x` | TradingView candles + overlays |
| `recharts` | `3.x` | Equity curve, P&L, vote distributions |
| `react-hook-form` | `7.x` | Auth forms + settings |
| `@hookform/resolvers` | `3.x` | Zod resolver |
| `lucide-react` | latest | Icons |
| `pnpm` | `9.x` | Workspace |
| `turbo` | `2.x` | Monorepo pipelines |
| `vitest` | `4.x` | Unit tests |
| `@playwright/test` | latest | E2E |
| `@biomejs/biome` | latest | Lint + format |
| Node | `22.x LTS` | Active LTS |

---

## Table of contents

- **EP-FE-1** — Monorepo foundations & shared packages *(Phase 1)*
- **EP-FE-2** — Design system (`packages/ui`) *(Phase 1)*
- **EP-FE-3** — Authentication (Google OAuth + email/password + 2FA) *(Phase 5)*
- **EP-FE-4** — Dashboard shell & navigation *(Phase 5)*
- **EP-FE-5** — Charts & market views *(Phase 5)*
- **EP-FE-6** — Agent debate viewer *(Phase 5)*
- **EP-FE-7** — Trades & history *(Phase 5)*
- **EP-FE-8** — Backtest UI *(Phase 4)*
- **EP-FE-9** — Quant analytics *(Phase 5)*
- **EP-FE-10** — Settings, calendar & audit *(Phase 5)*
- **EP-FE-11** — Compliance & disclaimers *(Phase 1, cross-cutting)*
- **EP-FE-12** — Realtime, toasts & error UX *(Phase 5)*
- **EP-FE-13** — Mobile layout & accessibility *(Phase 5)*

---

## EP-FE-1 — Monorepo foundations & shared packages

### FE-001 — Bootstrap Turborepo + pnpm workspace
**As a** developer **I want** a working Turborepo monorepo with pnpm workspaces **so that** the dashboard app and shared packages integrate without friction.

**Acceptance criteria**
- Given a fresh clone, when `corepack enable && pnpm install` runs, then all workspaces resolve without errors.
- Given the monorepo, when `pnpm turbo run build` runs, then placeholder workspaces build and remote cache hits on the second run.
- Given the root, when opened in VS Code, then recommended extensions suggest Biome and Tailwind IntelliSense.

**Technical notes**
- Workspaces: `apps/*`, `packages/*`, `apis/*`, `workers/*`.
- `turbo.json` pipelines: `lint`, `test`, `build`, `dev`.

**Dependencies** — none. **Points:** 3 · **Phase:** 1 · **Epic:** EP-FE-1

---

### FE-002 — Scaffold Next.js 16 dashboard app
**As a** developer **I want** the dashboard app scaffolded with App Router and Turbopack **so that** feature work can start immediately.

**Acceptance criteria**
- Given a clean repo, when `pnpm --filter @fx/dashboard dev` runs, then the app starts on `:3000` with a placeholder home.
- Given the app, when production build runs, then no unused Next.js boilerplate ships.

**Technical notes**
- `apps/dashboard/next.config.ts`; React Compiler enabled.
- Route groups: `(auth)`, `(dashboard)`.

**Dependencies** — FE-001. **Points:** 3 · **Phase:** 1 · **Epic:** EP-FE-1

---

### FE-003 — Shared `packages/tsconfig` and Biome config
**As a** developer **I want** shared TypeScript and lint configs **so that** all workspaces apply identical rules.

**Acceptance criteria**
- Given any workspace extending `@fx/tsconfig`, when `tsc --noEmit` runs, then it succeeds.
- Given a lint violation, when CI runs `pnpm turbo run lint`, then the build fails.

**Dependencies** — FE-001. **Points:** 2 · **Phase:** 1 · **Epic:** EP-FE-1

---

### FE-004 — Shared `packages/types` with Zod 4
**As a** developer **I want** API contracts defined once as Zod schemas **so that** frontend, Fastify, and Python share validation.

**Acceptance criteria**
- Given a schema in `packages/types`, when built, then TS types and JSON Schema emit to `dist/schemas/`.
- Given a breaking schema change without marker, when CI runs contract check, then it fails.

**Technical notes**
- JSON Schema → Pydantic via `datamodel-code-generator` in Python CI.

**Dependencies** — FE-003. **Points:** 5 · **Phase:** 1 · **Epic:** EP-FE-1

---

### FE-005 — Shared `packages/api-client`
**As a** developer **I want** a typed fetch client for the Fastify API **so that** every call is type-safe with uniform auth and error handling.

**Acceptance criteria**
- Given `apiClient.trades.list()`, when called, then response is typed and Zod-validated at runtime.
- Given a 401, when received, then redirect to `/sign-in`.
- Given a 403 with `STEP_UP_2FA_REQUIRED`, when received, then the step-up modal opens.

**Dependencies** — FE-004. **Points:** 5 · **Phase:** 1 · **Epic:** EP-FE-1

---

### FE-006 — Shared `packages/auth-client`
**As a** developer **I want** auth hooks (`useSession`, `useStepUp2FA`, `requireAuth`) **so that** auth checks are consistent.

**Acceptance criteria**
- Given `useSession()`, when wrapped, then result is typed as `FXSession` from `@fx/types`.
- Given `useStepUp2FA()`, when `stepUp2FAAt` is stale (>15 min), then `needsStepUp` is true for sensitive actions.

**Technical notes**
- Wraps `next-auth/react`; server-side `auth()` from `next-auth`.

**Dependencies** — FE-004. **Points:** 3 · **Phase:** 1 · **Epic:** EP-FE-1

---

### FE-007 — Local dev: `pnpm dev` all services
**As a** developer **I want** `pnpm dev` to bring up dashboard + API + quant **so that** I can work end-to-end locally.

**Acceptance criteria**
- Given the repo, when `pnpm dev` runs, then dashboard `:3000`, API `:4000`, quant `:5000` are healthy in <30s.
- Given missing `.env`, when starting, then a clear error lists missing keys.

**Dependencies** — FE-002, BE-001. **Points:** 3 · **Phase:** 1 · **Epic:** EP-FE-1

---

## EP-FE-2 — Design system (`packages/ui`)

### FE-010 — Tailwind v4 + shadcn in `packages/ui`
**As a** developer **I want** shadcn primitives in a shared package **so that** the dashboard uses consistent styling.

**Acceptance criteria**
- Given Tailwind 4, when theme tokens are defined in `packages/ui/src/styles/theme.css`, then all apps inherit them via `@theme`.
- Given `<Button>` from `@fx/ui`, when imported in dashboard, then styles work without per-app duplication.

**Dependencies** — FE-002. **Points:** 5 · **Phase:** 1 · **Epic:** EP-FE-2

---

### FE-011 — Trading-specific compositions
**As a** product developer **I want** `<AppShell>`, `<KillSwitchButton>`, `<ModeBadge>`, `<PnLTile>`, `<AgentVoteCard>` **so that** trading UI is consistent.

**Acceptance criteria**
- `<KillSwitchButton>` — red, requires step-up 2FA confirmation dialog; one-tap from mobile nav.
- `<ModeBadge>` — shows `backtest | paper | live` with colour coding.
- `<AgentVoteCard>` — shows analyst/PM vote with confidence and model id.

**Dependencies** — FE-010. **Points:** 8 · **Phase:** 5 · **Epic:** EP-FE-2

---

## EP-FE-3 — Authentication (Google OAuth + email/password + 2FA)

### FE-030 — Google OAuth sign-in (NextAuth v5)
**As an** operator **I want** to sign in with Google **so that** I can access the platform quickly.

**Acceptance criteria**
- Given `/sign-in`, when "Continue with Google" is clicked, then OAuth flow completes and redirects to `/dashboard`.
- Given first-time Google sign-in without invite, when no valid invite code in session, then redirect to `/register/invite-required`.
- Given successful sign-in, when `POST /auth/sign-in-sync` runs server-side, then user is upserted in Postgres.
- Given sign-out, when triggered, then session clears and user lands on `/sign-in`.

**Technical notes**
- `next-auth@5` with Google provider; JWT session strategy.
- Middleware protects all `(dashboard)` routes.

**Dependencies** — FE-006, BE-031. **Points:** 5 · **Phase:** 5 · **Epic:** EP-FE-3

---

### FE-031 — Email/password registration with invite code
**As an** invited operator **I want** to register with email and password **so that** I can access the platform without Google.

**Acceptance criteria**
- Given `/register`, when email + password + invite code are submitted, then Fastify creates the user and sends verification email.
- Given weak password (<12 chars, no mixed case), when submitted, then inline validation errors show.
- Given invalid invite code, when submitted, then a clear error is shown without revealing code validity details.
- Given success, when complete, then user sees "Check your email to verify" page.

**Technical notes**
- `react-hook-form` + Zod schema from `@fx/types`.
- Server action or API route proxies to `POST /auth/register`.

**Dependencies** — FE-006, BE-032. **Points:** 5 · **Phase:** 5 · **Epic:** EP-FE-3

---

### FE-032 — Email/password sign-in (Credentials provider)
**As a** registered operator **I want** to sign in with email and password **so that** I can use the platform without Google.

**Acceptance criteria**
- Given `/sign-in`, when credentials are submitted and email is verified, then NextAuth Credentials provider issues a session.
- Given unverified email, when sign-in attempted, then error shows with link to resend verification.
- Given wrong password, when submitted, then generic "Invalid credentials" (no email enumeration).

**Dependencies** — FE-031, BE-033. **Points:** 3 · **Phase:** 5 · **Epic:** EP-FE-3

---

### FE-033 — Forgot password + reset flow
**As an** operator **I want** to reset my password **so that** I can recover access.

**Acceptance criteria**
- Given `/forgot-password`, when email submitted, then reset email sent (always shows success message).
- Given valid reset token, when new password submitted on `/reset-password`, then password updates and user can sign in.
- Given expired token, when used, then friendly error with link to request new reset.

**Dependencies** — BE-034. **Points:** 3 · **Phase:** 5 · **Epic:** EP-FE-3

---

### FE-034 — Email verification pending UX
**As a** new operator **I want** clear verification status **so that** I know why I cannot sign in yet.

**Acceptance criteria**
- Given unverified user, when they visit `/verify-email`, then resend button is available (rate-limited to 1/5 min).
- Given verification link clicked, when token valid, then success page and redirect to sign-in.

**Dependencies** — BE-034. **Points:** 2 · **Phase:** 5 · **Epic:** EP-FE-3

---

### FE-035 — TOTP 2FA enrollment + step-up modal
**As an** operator **I want** to enroll TOTP 2FA and confirm sensitive actions **so that** kill-switch and live mode are protected.

**Acceptance criteria**
- Given `/settings/security`, when "Enable 2FA" clicked, then QR code + manual secret shown; verification required to activate.
- Given kill-switch tapped with stale step-up, when modal opens, then 6-digit TOTP input validates via API.
- Given valid step-up, when confirmed, then action proceeds and session `stepUp2FAAt` refreshes (15 min window).
- Given 2FA activation completes, when successful, then **10 recovery codes** are displayed exactly once with copy/download; UI requires confirmation of safe storage.
- Given TOTP unavailable, when step-up modal is open, then "use a recovery code" path accepts a single-use code.

**Dependencies** — FE-030, BE-036. **Points:** 5 · **Phase:** 5 · **Epic:** EP-FE-3

---

### FE-036 — Account settings (link Google, change password)
**As an** operator **I want** to manage linked auth methods **so that** I can use Google and password interchangeably.

**Acceptance criteria**
- Given `/settings/account`, when Google not linked, then "Link Google account" starts OAuth link flow.
- Given password set, when "Change password" used, then current password required.
- Given Google-only account, when "Set password" used, then password can be added for credentials login.

**Dependencies** — FE-030, BE-037. **Points:** 3 · **Phase:** 5 · **Epic:** EP-FE-3

---

## EP-FE-4 — Dashboard shell & navigation

### FE-040 — Operator home (`/dashboard`)
**As an** operator **I want** a home dashboard with equity, P&L, positions, mode indicator, and kill-switch **so that** I see platform state at a glance.

**Acceptance criteria**
- Given `/dashboard`, when loaded, then tiles show: equity, daily P&L, open positions count, mode/broker badge, agents-vs-baseline comparison, kill-switch.
- Given live WebSocket events, when P&L updates, then tiles refresh without full page reload.
- Given mobile viewport, when loaded, then kill-switch and positions appear above the fold.

**Dependencies** — FE-005, FE-011, BE-054, BE-014. **Points:** 8 · **Phase:** 5 · **Epic:** EP-FE-4

---

### FE-042 — System health strip (v2.2 machinery surfaced)
**As an** operator **I want** the new resilience machinery visible on the dashboard **so that** I can verify — not assume — that safety systems are armed.

**Acceptance criteria**
- Given the dashboard, when loaded, then a health strip shows: gRPC circuit state (CLOSED/OPEN/HALF-OPEN), current session label + liquidity regime per instrument, and kill-switch state **read from the Postgres source of truth**.
- Given a `model_downgraded` agent run, when it occurs, then a downgrade badge appears with the affected agents and window.
- Given a partial fill or order rejection, when it occurs, then a persistent notice shows remainder/reason until acknowledged.
- Given rollover (triple-swap) or weekend-gap flatten armed for any open position, when active, then a flag is visible on that position row.

**Dependencies** — FE-040, BE-014, BE-141. **Points:** 5 · **Phase:** 5 · **Epic:** EP-FE-4

---

### FE-041 — AppShell navigation
**As an** operator **I want** sidebar navigation to all major views **so that** I can move quickly between features.

**Acceptance criteria**
- Given authenticated session, when AppShell renders, then nav links cover: Dashboard, Charts, Agents, Trades, Backtest, Quant, Calendar, Audit, Settings.
- Given current route, when nav renders, then active item is highlighted.

**Dependencies** — FE-010. **Points:** 3 · **Phase:** 5 · **Epic:** EP-FE-4

---

## EP-FE-5 — Charts & market views

### FE-050 — Charts page with Lightweight Charts
**As a** trader **I want** `/charts` with candles, indicators, regime shading, and signal markers **so that** I can visually inspect the market and system decisions.

**Acceptance criteria**
- Given `/charts`, when instrument selected, then Lightweight Charts renders OHLC candles with EMAs, RSI/MACD sub-panes.
- Given regime data, when loaded, then background shading reflects detected regime per bar.
- Given past signals, when shown, then entry markers, SL/TP lines, and supervisor annotations overlay correctly.
- Given H1/D1 toggle, when switched, then chart reloads from API without memory leak.

**Dependencies** — FE-005, BE-045. **Points:** 13 · **Phase:** 5 · **Epic:** EP-FE-5

---

## EP-FE-6 — Agent debate viewer

### FE-060 — Live agent debate viewer (`/agents`)
**As an** operator **I want** to see quant candidates, analyst outputs, debate transcripts, and PM votes **so that** I understand why the system took or skipped a trade.

**Acceptance criteria**
- Given `/agents`, when a signal is active, then panels show: quant candidate, meta-model probability, each analyst JSON output, debate transcript, risk team votes, PM decision.
- Given WebSocket `agent.debate` events, when received, then debate streams progressively.
- Given historical signal selected, when loaded, then full provenance replays from stored `agent_runs`.
- Given a decision expanded, when memory was used, then the **retrieved memories** (ids, summaries, outcomes) each agent saw are shown alongside its output — memory-informed decisions must be auditable, not opaque.
- Given a `gate_skip` bar, when viewed, then the gate reason (no candidate / P below pre-filter) displays with zero-cost confirmation.

**Dependencies** — FE-005, BE-067. **Points:** 13 · **Phase:** 5 · **Epic:** EP-FE-6

---

## EP-FE-7 — Trades & history

### FE-070 — Trades history with provenance (`/trades`)
**As an** auditor **I want** expandable trade rows showing agent runs, supervision, and swap **so that** every trade is fully explainable.

**Acceptance criteria**
- Given `/trades`, when a row is expanded, then agent runs, supervisor decisions, and swap P&L are shown.
- Given "Export CSV", when clicked, then trades download with P&L and provenance ids.
- Given open trade, when shown, then current R-multiple, SL/TP, and trailing status display live.

**Dependencies** — BE-054. **Points:** 8 · **Phase:** 5 · **Epic:** EP-FE-7

---

## EP-FE-8 — Backtest UI

### FE-080 — Backtest config + results (`/backtest`)
**As a** researcher **I want** to configure and view backtests with OOS metrics and ablation **so that** I can validate the strategy before live.

**Acceptance criteria**
- Given `/backtest`, when config submitted, then run starts and progress shows via WebSocket/polling.
- Given results, when complete, then panels show in/out OOS metrics, baseline comparison, validation verdict, ablation breakdown.
- Given cached-LLM mode, when selected, then UI labels run as "reproducible"; live-LLM labeled "non-reproducible".

**Dependencies** — BE-090, QN-050. **Points:** 13 · **Phase:** 4 · **Epic:** EP-FE-8

---

## EP-FE-9 — Quant analytics

### FE-090 — Quant dashboard (`/quant`)
**As a** researcher **I want** meta-model status, calibration curve, regime timeline, and baseline comparison **so that** I trust the quant backbone.

**Acceptance criteria**
- Given `/quant`, when loaded, then calibration curve, regime timeline, champion/challenger status, and drift alerts render.
- Given decalibrated model, when detected, then warning banner shows with retrain status.

**Dependencies** — QN-055. **Points:** 8 · **Phase:** 5 · **Epic:** EP-FE-9

---

## EP-FE-10 — Settings, calendar & audit

### FE-100 — Settings page (`/settings`)
**As an** operator **I want** to configure mode, broker creds, risk params, LLM models, and agent weights **so that** the system behaves to my preferences.

**Acceptance criteria**
- Given `/settings`, when mode toggled to `live`, then step-up 2FA required and live-promotion gate checked server-side.
- Given broker credentials saved, when submitted, then step-up 2FA required; creds never re-displayed in full.
- Given per-instrument risk overrides, when saved, then they persist and reflect in next signal cycle.
- Given v2.2 risk settings — correlation clustering params (lookback/threshold/cadence), session spread multipliers, weekend-gap flatten toggle, per-instrument daily loss limits, debate-regime mapping, entry-gate pre-filter — when edited, then Zod-validated and persisted; effective values shown next to defaults.

**Dependencies** — FE-035, BE-100. **Points:** 8 · **Phase:** 5 · **Epic:** EP-FE-10

---

### FE-101 — Economic calendar (`/calendar`)
**As an** operator **I want** upcoming high-impact events and active blackout windows **so that** I know when entries are blocked.

**Acceptance criteria**
- Given `/calendar`, when loaded, then events show with ±30 min blackout shading.
- Given active blackout, when viewing dashboard, then banner indicates entries paused for affected pairs.

**Dependencies** — BE-110. **Points:** 5 · **Phase:** 5 · **Epic:** EP-FE-10

---

### FE-102 — Audit log viewer (`/audit`)
**As an** auditor **I want** to query the append-only audit log **so that** every state change is traceable.

**Acceptance criteria**
- Given `/audit`, when filtered by action type or date, then paginated immutable entries show actor, timestamp, payload hash.
- Given LLM call audit, when expanded, then model, prompt_hash, and cost display.

**Dependencies** — BE-130. **Points:** 5 · **Phase:** 5 · **Epic:** EP-FE-10

---

## EP-FE-11 — Compliance & disclaimers

### FE-110 — In-app CFD disclaimers and risk warnings
**As a** compliance owner **I want** persistent disclaimers on trading views **so that** users understand this is not financial advice.

**Acceptance criteria**
- Given any trading view, when rendered, then disclaimer banner states: research/educational tool, not financial advice, CFD high-risk.
- Given first login after register, when dashboard loads, then user must acknowledge disclaimer once (stored in `users.disclaimer_accepted_at`).

**Technical notes**
- Banner component ships in Phase 1 in `packages/ui`; it attaches to the dashboard shell when FE-040 lands in Phase 5 — no hard dependency on the shell.

**Dependencies** — FE-010. **Points:** 3 · **Phase:** 1 · **Epic:** EP-FE-11

---

### FE-111 — Invite-only registration messaging
**As a** prospective user without invite **I want** clear messaging **so that** I understand access is controlled.

**Acceptance criteria**
- Given `/register` without invite code, when page loads, then copy explains invite-only access.
- Given `/register/invite-required` after Google OAuth, when shown, then user can enter invite code to complete registration.

**Dependencies** — FE-031. **Points:** 2 · **Phase:** 5 · **Epic:** EP-FE-11

---

## EP-FE-12 — Realtime, toasts & error UX

### FE-120 — WebSocket subscription + toasts
**As an** operator **I want** in-app toasts for signals, debates, fills, and errors **so that** I stay informed without polling.

**Acceptance criteria**
- Given WebSocket connected, when `signal.candidate`, `trade.fill`, or `risk.halt` events arrive, then Sonner toast appears with actionable link.
- Given disconnect, when detected, then reconnect banner shows; stale data indicator on tiles.

**Dependencies** — BE-014, BE-117, FE-040. **Points:** 5 · **Phase:** 5 · **Epic:** EP-FE-12

---

### FE-121 — Graceful error states
**As an** operator **I want** calm error UI with request IDs **so that** failures are debuggable without panic.

**Acceptance criteria**
- Given API 5xx, when displayed, then error component shows request id and support copy.
- Given empty lists, when shown, then `<EmptyState>` with CTA — never blank screens.

**Dependencies** — FE-010. **Points:** 3 · **Phase:** 5 · **Epic:** EP-FE-12

---

## EP-FE-13 — Mobile layout & accessibility

### FE-130 — Mobile-first safety controls
**As a** mobile operator **I want** kill-switch, positions, and P&L prioritized **so that** I can act quickly away from desk.

**Acceptance criteria**
- Given viewport <768px, when dashboard loads, then kill-switch is reachable in one tap from any page via sticky footer.
- Given mobile, when positions list shown, then SL/TP and unrealized P&L visible without horizontal scroll.

**Dependencies** — FE-040, FE-011. **Points:** 5 · **Phase:** 5 · **Epic:** EP-FE-13

---

### FE-131 — WCAG 2.2 AA on core flows
**As a** product owner **I want** accessible auth, dashboard, and kill-switch flows **so that** the platform is usable by all operators.

**Acceptance criteria**
- Given axe-core audit on sign-in, dashboard, kill-switch, when run, then no critical issues.
- Given keyboard navigation, when tested, then all actions reachable with visible focus rings.

**Dependencies** — FE-030, FE-040. **Points:** 5 · **Phase:** 5 · **Epic:** EP-FE-13

---

## Definition of Done (applies to every story)

A story is **Done** when all the following are true:

1. Acceptance criteria pass in staging.
2. Unit tests added/updated (Vitest); coverage on new code ≥80%.
3. E2E test added for any new user flow (Playwright).
4. Zod validation covers all inputs/outputs crossing app boundaries.
5. A11y pass on new screens (axe-core CI green).
6. WebSocket events wired for any live data surfaces.
7. PR reviewed; no unresolved comments.
8. No `TODO` or `FIXME` left in code.
