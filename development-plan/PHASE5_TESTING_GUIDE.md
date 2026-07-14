# Phase 5 — Completion Summary & Test Plan

Companion to [`PHASE4_TESTING_GUIDE.md`](PHASE4_TESTING_GUIDE.md) (same
philosophy: everything below was source-reviewed and — where the sandbox
allowed — typechecked and unit-tested against source; the runtime proofs need
your machine). Build record in [`DEVLOG_phase5.md`](DEVLOG_phase5.md); plan
in [`FX_PRD.md`](FX_PRD.md) §8.

**Phase 5 exit criteria (PRD):** operator completes the full workflow
(sign-in → arm paper → observe debate → kill-switch) from the dashboard,
with alerts firing.

---

## 1. What's built and code-complete

| Step | Stories | What it is |
|---|---|---|
| 5.1 | BE-030…037, FE-030…036 | Auth backend + 2FA (NextAuth JWT, registration/login, invites, TOTP + recovery codes, account linking) — see the Step-5.1 DEVLOG entry. |
| 5.2 | FE-040…102 | Full dashboard on the shared api-client/query/WS layer — see the Step-5.2 DEVLOG entry. |
| 5.3 | BE-100 | **Settings CRUD** — `GET/PATCH /settings`; append-only `platform_settings` versions; authoritative bounds in `@fx/types` `RiskSettingsSchema`; workers read via a TTL-cached reader so the **next signal cycle uses new values** (entry-gate pre-filter, debate depths, per-instrument tripwire, weekend-gap flatten). `PUT /settings/broker-credentials` (step-up 2FA, AES-256-GCM sealed, token never echoed). |
| 5.3 | BE-101 | **Live-promotion gate** — `GET/POST /settings/live-promotion`; POST answers **403 with the checklist of unmet conditions** (step-up 2FA, champion exists, QN-053 verdict VALIDATED, QN-060 paper record ⟨Phase 6 ⇒ unmet⟩, QN-061 signed report ⟨Phase 6 ⇒ unmet⟩, kill-switch inactive). `TRADING_MODE` still flips at deploy; an allowed POST is an audited approval. |
| 5.3 | BE-110 | **Economic calendar service** — Forex Factory keyless weekly feed (`CALENDAR_PROVIDER=forexfactory`) refreshed hourly by the market-data worker into `calendar_events`; `DbCalendarProvider` closes the Phase-3 `CalendarProvider` seam for the risk-gate econ-blackout rule AND supervision `pre_news_flatten`. Fail-open: stale/absent data ⇒ `calendar_unavailable`, exactly the old behaviour. `GET /calendar` feeds FE-101. |
| 5.3 | BE-115 | **Telegram trade events** — fills (side/units/price/SL/TP/mode), partial fills, rejections with reason codes, trade closes **with P&L + reason**, halts, reconciliation mismatches. |
| 5.3 | BE-116 | **Email digests** — BullMQ crons daily 22:00 UTC + weekly Sun 22:00 UTC; closed trades, W/L, realized P&L, cycle counts, LLM spend, kill-switch activations; Resend when `DIGEST_EMAIL_TO`+`RESEND_API_KEY` set, honest log otherwise. |
| 5.3 | BE-117 | **WS emitter helper** — `createWsEmitter(redis).emit(userId, event, payload)` (`user:{id}:events`) + `broadcast(event, payload)`; same Redis fan-out path all publishers already use. |
| 5.3 | BE-118 | **Twilio SMS escalation** — CRITICAL severity only (kill-switch, reconciliation mismatch, circuit open, dead-man, DD halt); warning/info stay Telegram-only; send failures surface on the dashboard via the `notifications` WS channel (alerting-about-alerting). No SDK — plain REST. |
| 5.4 | FE-120 | **Global realtime layer** — ONE WS connection in the dashboard layout (`RealtimeProvider`): toasts with actionable links for signal cycles, fills (incl. partial), rejections, closes w/ P&L, risk halt/resume, reconciliation, backtest finish/fail, alert-delivery failures; per-channel query invalidation; **reconnect banner + shared stale indicator** (`useConnection`). Page-local sockets removed (agents/backtest/home now read the store). |
| 5.4 | FE-121 | **Graceful error states** — route-segment error boundary (`(dashboard)/error.tsx`, digest id shown), plus the existing Empty/Error/Loading components everywhere. |
| 5.4 | FE-130 | **Mobile safety** — sticky footer kill-switch (already in AppShell) + trades render as stacked cards <640 px (side/units/SL–TP/uP&L slots, no horizontal scroll). |
| 5.4 | FE-131 | **WCAG 2.2 AA** — skip-to-content link (first tabbable), `#main-content` target, global `:focus-visible` ring, reduced-motion support, keyboard-reachable trade expanders with `aria-expanded`, Playwright + axe-core suites (`e2e/a11y.spec.ts`, `e2e/mobile.spec.ts`). |
| seam-close | BE-054 | **Trades REST** — real `GET /api/trades` (the path FE-070 has consumed via the typed client since Phase 1). |
| seam-close | QN-055 proxy | **Quant proxy** — `GET /quant/models` (registry list from Node's DB) + authenticated pass-throughs for `/calibration` and `/regime`; FE-090 now renders real reliability curves + regime timeline (calm 404/422/503 states). |
| seam-close | FE-100/101 | Settings page persists through BE-100 and shows the real BE-101 checklist; calendar page renders BE-110 events with blackout shading + active-blackout banner. |

**New unit tests (Vitest):** `settings-service.test.ts`,
`live-promotion.test.ts`, `forexfactory.test.ts` (NFP fixture),
`calendar-service.test.ts`, `notifications.test.ts` (severity routing +
failure surfacing), `digests.test.ts`, `ws-publish.test.ts`.

**Sandbox verification done:** `@fx/types`, `@fx/api-client`, `@fx/ui`, and
`apps/dashboard` `tsc --noEmit` are **clean** against package source;
`apis/node-api` is clean **except** the expected `platformSettings` /
`economicCalendarEvent` Prisma-client errors that disappear after
`prisma generate` (§A step 3). Two latent Step-5.1 strictness errors
(`noUncheckedIndexedAccess` on Buffer indexing in `auth/invites.ts` /
`auth/recovery-codes.ts`) were found and fixed. Vitest/biome/tsup still cannot
run in the sandbox (native bindings) — §C runs them for real.

## 2. The gap: what "code complete" hasn't proven yet

- **A migration IS pending** — `platform_settings` + `calendar_events`
  (schema.prisma edited; migration must be **generated**, never hand-written).
- **New dashboard devDeps aren't installed** — `@playwright/test`,
  `@axe-core/playwright` (Step-5.4 DoD), plus everything Step 5.2 already
  listed. Nothing has been `pnpm install`ed since Step 5.1.
- **No live vendor call has been made** — the Forex Factory feed mapping is
  fixture-tested only; Telegram/Twilio/Resend paths are mock-first and unhit.
- **No E2E has run** — the Playwright/axe suites have never executed.
- Everything the Phase-3/4 gates still owe (champion retrain ≥18 mo, risk-gate
  E2E, kill-switch <2 s timed drill) still applies — the dashboard renders live
  state, so those must pass for the surfaces to show anything real.

## 3. Env keys (nothing new is REQUIRED)

Added with defaults (already in `.env` / `.env.example`):
`CALENDAR_PROVIDER=forexfactory`, `CALENDAR_REFRESH_INTERVAL_MS=3600000`,
`CALENDAR_STALE_AFTER_MS=172800000`, `SETTINGS_CACHE_TTL_MS=15000`.
Optional (commented in `.env.example`; features inert without them):
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`,
`ALERT_SMS_TO`, `DIGEST_EMAIL_TO`.

---

## §A — Operator gate (order matters)

```bash
# 0. from the repo root
pnpm install                       # links new dashboard devDeps + workspace

# 1. build shared packages (node-api + dashboard resolve dist at runtime)
pnpm --filter @fx/types build
pnpm --filter @fx/api-client build
pnpm --filter @fx/ui build 2>/dev/null || true   # only if ui has a build step

# 2. THE PENDING MIGRATION (generated — never hand-written)
cd apis/node-api
npx prisma generate
npx prisma migrate dev --name step_5_3_settings_calendar
cd ../..

# 3. typecheck + unit tests + lint (fix-forward with --write)
pnpm typecheck
pnpm test
pnpm exec biome check --write .

# 4. dashboard build + E2E tooling
pnpm --filter @fx/dashboard build
pnpm --filter @fx/dashboard e2e:install   # one-time Chromium download
```

Expected: migration creates exactly two tables (`platform_settings`,
`calendar_events`); `pnpm test` runs the 7 new suites green; node-api
typecheck goes fully clean once `prisma generate` has run.

## §B — DB sanity

```sql
\d platform_settings   -- version (identity PK), settings jsonb, updated_by_id, created_at
\d calendar_events     -- unique (source, ts, currency, title); index on ts
SELECT count(*) FROM calendar_events;   -- >0 a minute after the market-data worker boots
SELECT version, settings->'risk'->>'entryGatePreFilter' FROM platform_settings ORDER BY version DESC LIMIT 3;
```

## §C — Unit suites of record

```bash
pnpm --filter @fx/node-api test -- settings-service live-promotion forexfactory calendar-service notifications digests ws-publish
```

Key assertions: bounds rejected server-side; append-only versioning; cached
reader picks up a patch after TTL; NFP `-04:00` row normalizes to 12:30 UTC
high/USD; provider stale ⇒ unavailable (fail-open); **critical ⇒ Telegram+SMS,
warning ⇒ Telegram only**; Twilio failure surfaces on the `notifications` WS
channel; digest crons `0 22 * * *` / `0 22 * * 0`.

## §D — Settings drill (BE-100 "next cycle uses new values")

1. `pnpm dev` (or `pnpm stack:up`), sign in, open **/settings**.
2. Change *Entry-gate pre-filter P* to `0.90`, save → toast shows `v1`.
3. `GET /settings` → `version:1`; audit log has `settings_updated`.
4. Trip a signal cycle (`pnpm --filter @fx/node-api trip-signals` per
   PHASE3 guide). Within `SETTINGS_CACHE_TTL_MS` the cycle audits
   `signal_cycle_gate_skip` with `gateMinProbability: 0.9` — the graph never
   fired (zero LLM cost). Set it back to `0.5`; next cycle proceeds.
5. Bounds check: `PATCH /settings` with `{"risk":{"entryGatePreFilter":0.3}}`
   → 400 VALIDATION.

## §E — Broker credentials write (step-up 2FA)

1. With 2FA **not** enrolled: **/settings → account**, try the credentials
   write → 403 `STEP_UP_2FA_REQUIRED` opens the step-up modal (or enroll at
   /settings/account first).
2. After a fresh step-up: `PUT /settings/broker-credentials` succeeds; response
   carries `tokenPreview` (`abcd…wxyz`) — full token never returned; audit row
   `broker_credentials_written` also holds only the preview.
3. `SELECT ciphertext FROM broker_credentials` → `v1:` envelope.

## §F — Live-promotion gate (BE-101)

1. **/settings** shows the checklist; with today's DB expect UNMET on
   `model_validated` (or `champion_model`), `paper_window_90d`,
   `signed_risk_report`.
2. POST (fresh step-up) → **403 whose body IS the checklist**; audit
   `live_promotion_denied` lists the unmet ids. That is the AC.
3. Activate the kill-switch and re-GET → `kill_switch_inactive` flips UNMET
   (fail-safe). Deactivate.

## §G — Calendar + blackout (BE-110)

1. Start the market-data worker; log shows
   `[calendar] refreshed N events from forexfactory`; `GET /calendar` returns
   `available:true` + events; **/calendar** renders impact badges and shades
   high-impact rows ±30 min (BLACKOUT badge when active).
2. **Risk-gate proof (NFP semantics):** insert a synthetic high-impact USD row
   at now+10 min:
   ```sql
   INSERT INTO calendar_events (id, ts, currency, impact, title, source)
   VALUES (gen_random_uuid(), now() + interval '10 min', 'USD', 'high', 'DRILL NFP', 'forexfactory');
   ```
   Trip a USD-instrument cycle → risk gate vetoes with `econ_blackout`
   (`checks.econ_blackout.pass=false`). Delete the row after.
3. **Fail-open proof:** `UPDATE calendar_events SET fetched_at = now() - interval '3 days';`
   → provider re-hydrates unavailable (≤5 min), gate records
   `no calendar vendor wired — blackout not evaluated` and passes; supervision
   `pre_news_flatten` notes `calendar_unavailable`. Restore with a refresh.
4. `CALENDAR_PROVIDER=none` boots with the seam fully inert (no vendor calls).

## §H — Notifications (BE-115/117/118)

1. **Telegram (real bot is configured in `.env`):** enqueue a paper order
   (PHASE2 guide `enqueue-intent`) → fill message with side/units/price/SL/TP;
   close it → "Trade closed … P&L … (reason)".
2. **SMS routing:** with Twilio keys set, activate the kill-switch → Telegram
   AND SMS. Trigger a warning (partial fill) → Telegram only. AC: SMS stays
   high-signal.
3. **Alerting-about-alerting:** set a bogus `TWILIO_AUTH_TOKEN`, activate the
   kill-switch → worker logs the failure AND the dashboard toasts
   "Alert delivery failed (sms)" (`notifications` WS channel).
4. **BE-117 p95:** `wscat -c "ws://localhost:4000/ws?token=$(curl -s localhost:3000/api/token | jq -r .token)"`,
   subscribe `{"type":"subscribe","channel":"user:<yourUserId>:events"}`, then
   from a node REPL `createWsEmitter(redis).emit('<yourUserId>','ping',{})` —
   frame arrives well under 500 ms.

## §I — Digests (BE-116)

Don't wait for 22:00 UTC — force one:

```bash
cd apis/node-api && npx tsx -e "
import { Queue } from 'bullmq';
const q = new Queue('digests', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379' } });
await q.add('daily', { kind: 'daily' }); await q.close();"
```

With `DIGEST_EMAIL_TO` unset → execution-worker log prints the full digest
(subject + body, honest "No trading activity" when empty). Set it +
`RESEND_API_KEY` → real email. Check Bull repeatables:
`digest-daily` (`0 22 * * *`) and `digest-weekly` (`0 22 * * 0`) exist once.

## §J — Realtime & polish (FE-120/121)

1. Two browser tabs on **/dashboard**: trip a cycle → both toast
   ("Agent cycle decided" with a View→/agents action) without refresh.
2. Kill the API process → after ~2 s the amber "Live connection lost —
   reconnecting…" banner appears (aria-live polite); home's ws indicator flips
   `closed`. Restart API → banner clears, ws `open`, no duplicate toasts
   (single global socket — pages no longer own connections).
3. Partial fill (PHASE2 partial drill) → warning toast "Partial fill …
   remainder N".
4. FE-121: stop Postgres, load **/audit** → calm "Not available yet"/error
   card with request id, never a blank screen. Throw inside a page in dev →
   error boundary with digest id + Try again.

## §K — Mobile + accessibility (FE-130/131)

```bash
# stack running, dashboard on :3000
E2E_EMAIL=you@example.com E2E_PASSWORD=... pnpm --filter @fx/dashboard e2e
```

- `a11y.spec.ts`: axe (wcag2a/aa/22aa) on sign-in, dashboard, and the OPEN
  kill-switch dialog → zero **critical** violations; skip link is the first
  Tab stop and jumps to `#main-content`; focus rings visible.
- `mobile.spec.ts` (Pixel-7 project): kill-switch visible + in-viewport on
  /dashboard, /trades, /agents; /trades has **no horizontal scroll** (stacked
  cards with SL/TP + uP&L slots).
- Manual spot-check: keyboard-only pass sign-in → dashboard → activate/cancel
  kill-switch dialog (Esc closes, focus returns).

## §L — Phase-5 exit-criteria walkthrough (the one that counts)

Sign in (Google or credentials+2FA) → confirm ModeBadge `paper` → /settings
saves a real version → trip a cycle → watch the debate land on /agents with a
toast → open trade appears on /trades (fill Telegram arrives) → from a PHONE
(<768 px) tap the sticky-footer kill-switch, enter the step-up code → broker
flat <2 s, `risk.halt` toast everywhere, Telegram + SMS fire, audit trail
complete. That is the phase done.

## 4. Known remaining seams (deliberate, tracked for Phase 6)

- Health-strip gRPC-breaker + session/liquidity pills — breaker state is
  in-process (BE-068); needs a Redis mirror to surface. Honest seam labels.
- Per-signal full transcript + retrieved-memory replay endpoint (FE-060 detail
  beyond BE-067 summaries) — pairs with QN-062 decision replay in Phase 6.
- Broker equity sync (`ACCOUNT_BASELINE_EQUITY` + realized P&L) — revisit
  before live (Phase 6), then home tiles go live.
- Richer trade record (SL/TP, uP&L, R-multiple over REST) — extends
  `TradeSchema` + `/api/trades`; mobile cards already have the slots.
- Python reading `platform_settings` cluster/session knobs (QN-048 cadence) —
  table is the contract; quant-side read is a small Phase-6 follow-up.
- QN-060 paper validator + QN-061 signed report — Phase 6; until then the
  BE-101 checklist correctly blocks live.

## 5. Suggested commits (after §A–§L pass; you control timing)

```
feat(surface): Step 5.3 settings + notifications backend (BE-100/101/110/115/116/117/118)
feat(surface): Step 5.4 realtime, polish, a11y (FE-120/121/130/131) + Phase-5 seam closes (BE-054, QN-055 proxy, FE-100/101 wiring)
```

(Phase 4 + Steps 5.1/5.2 are still uncommitted too — commit those first or
fold everything into the sequence your history prefers.)
