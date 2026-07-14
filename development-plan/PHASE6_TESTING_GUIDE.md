# Phase 6 — Go-live: operator gate & drills

Companion to [`DEVLOG_current.md`](DEVLOG_current.md) (Phase-6 entries) and
the earlier gates ([`PHASE4_TESTING_GUIDE.md`](PHASE4_TESTING_GUIDE.md),
[`PHASE5_TESTING_GUIDE.md`](PHASE5_TESTING_GUIDE.md)). Everything below runs
on the operator's machine — the build sandbox could not install, migrate, or
boot anything, so **nothing in Phase 6 is runtime-proven until this gate
passes.**

**Hard prerequisites carried from the DEVLOG (do these FIRST):**

1. The combined Phase-4+5 gate (PHASE4 guide + PHASE5 §A, §D–§L) — Phases
   4→6 are all unproven together.
2. **Champion retrain on ≥18 months H1** (PHASE2 guide §E train→promote).
   The only champion (`XAU_USD/H1 v1`, OOF AUC 0.51) has no edge; QN-060's
   90-day window is meaningless against it and cannot start.

---

## A. Install, migrate, build

```bash
pnpm install
cd apis/node-api
npx prisma migrate dev --name step_6_go_live_tables   # paper_validation_runs,
                                                      # risk_reports, gdpr_exports,
                                                      # users.erased_at
npx prisma generate
cd ../..
pnpm --filter @fx/types build        # new replay contracts (Node-internal)
pnpm typecheck && pnpm lint
node scripts/check-env.mjs --ci      # canary + REPORT_SIGNING_KEY keys added
```

New `.env` keys to set locally (see `.env.example`): `CANARY_CONFIRM_FIRST_N`,
`CANARY_MAX_UNITS`, `CANARY_CONFIRM_TTL_MIN`, `REPORT_SIGNING_KEY`
(`openssl rand -hex 32`).

## B. Unit gates

```bash
pnpm --filter @fx/node-api test                 # incl. canary, gdpr, replay-route,
                                                # live-promotion additions
cd services/quant
uv sync && uv run pytest tests/quant/test_paper_validation.py \
                         tests/quant/test_replay.py \
                         tests/quant/test_risk_report.py
uv run pytest            # full suite
uv run mypy && uv run ruff check
```

Already proven in the build sandbox (belt-and-braces, re-run anyway): the
ZIP writer round-trips through Python `zipfile` (CRCs green), the BE-101/122
checklist logic, and report sign/verify/tamper/XSS-escape determinism.

## C. Chaos suite (BE-120)

```bash
pnpm --filter @fx/node-api test -- chaos
```

Covers S1–S8 (kill-switch × Redis flush, broker-disconnect halt, LLM outage
rejecting+hanging, gRPC breaker open/probe/recover, flash spread, DD halt,
weekend-gap flatten, worst-case load) at ms-scale budgets on the production
code paths.

**Staging drill (real budgets — the literal <180 s bound):**

1. `pnpm stack:up && pnpm dev`, arm paper mode.
2. **Worst case:** force candidates on all configured instruments at one bar
   close (backfill a synthetic bar or lower `entryGatePreFilter` in
   settings), set `debateRoundsLowEntropy=2`, and degrade one provider
   (remove its API key). Watch `signal_cycle_executed` audit rows: every
   `e2eMs` ≤ 180 000, no starved instrument.
3. **Kill-switch × Redis flush:** activate kill-switch from the phone →
   `docker restart <redis>` → confirm the next cycles still HOLD `halted`
   and `kill-switch:active` re-hydrates to `1`.
4. **Quant outage:** stop the quant service → expect HOLD `CIRCUIT_OPEN`
   within 3 cycles and a health-strip breaker indication → restart →
   confirm recovery on the next probe (~60 s).
5. **LLM outage:** remove all provider keys → cycles complete with HOLD,
   no hung BullMQ jobs (`pnpm stack:ps`, queue depth returns to 0).

## D. QN-060 — paper validation (after retrain + a real paper window)

```bash
curl -X POST localhost:5001/paper-validation/run \
     -H 'content-type: application/json' -d '{}'   # the pre-registered plan
curl localhost:5001/paper-validation/latest
```

Expect an honest verdict: `UNDERPOWERED` on thin data, `EXTEND` if >10% of
cycles ran downgraded (§9.4), `PASS` only when agent-net-of-LLM-cost beats
baseline by ≥0.10R with adequate power. Then confirm the BE-101 checklist
consumed it: `GET /settings/live-promotion` → `paper_window_90d` shows the
verdict. **The 90-day clock starts when paper trading starts — run the
validator at the end of the window; early runs are practice.**

## E. QN-061 — signed risk report

```bash
curl -X POST localhost:5001/risk-report/generate    # 409 unless latest = PASS
curl 'localhost:5001/risk-report/latest'            # metadata + hash
curl 'localhost:5001/risk-report/latest?includeHtml=true' | jq -r .contentHtml > report.html
```

Verify the hash independently: `python3 -c "import hashlib,sys;
print(hashlib.sha256(open('report.html','rb').read()).hexdigest())"` must
equal the stored `sha256`. Checklist item `signed_risk_report` flips and
shows the hash.

## F. BE-121 — canary drill (do this in PAPER first)

Temporarily boot with `TRADING_MODE=live` against the **practice** account
(one-off drill deploy) with `CANARY_CONFIRM_FIRST_N=1`:

1. Next approved signal → intent parked `pending`, units clamped to
   `CANARY_MAX_UNITS`, CRITICAL alert on Telegram/SMS, WS event on the
   dashboard.
2. From the phone: `POST /api/trades/intents/<id>/confirm` → execution
   enqueued, fill appears. Repeat with `/reject` → no execution.
3. TTL: leave one pending >15 min → confirm answers **410** and the intent
   is cancelled `CANARY_CONFIRM_EXPIRED`.
4. Verify a non-canary pending intent CANNOT be confirmed (409 — no
   force-execute backdoor).

## G. BE-132 — GDPR drill (**before any invited user**)

1. `POST /gdpr/export` as the operator → email arrives (or link in the
   response without a Resend key) → download → `unzip -t` passes → inspect
   `security_metadata.json`: **no hashes/ciphertexts anywhere**.
2. Let a link expire (or edit `expires_at`) → **410** and the row is gone.
3. Erasure on a **scratch invited user, never the operator**: sign in as the
   scratch user, fresh step-up TOTP, `POST /gdpr/erasure` with
   `{"confirmEmail": "<exact email>"}` → user row anonymised
   (`erased+<id>@…`, status suspended), credentials/codes/tokens gone,
   trades + audit rows retained, `gdpr_erasure_completed` audit row written.

## H. Exit-criteria walkthrough (PRD §8)

| Criterion | Evidence |
|---|---|
| Chaos suite green | §C vitest run + staging drill notes |
| Paper run beats baseline net of cost | `paper_validation_runs` latest = PASS (§D) |
| Signed report produced | `risk_reports` row, hash verified (§E) |
| Live via canary ramp + human confirm | §F drill + BE-101 `POST /settings/live-promotion` allowed, then the documented `TRADING_MODE=live` deploy |

Sign-off: append the drill results to `DEVLOG_current.md` (template at the
bottom of the file), then commit per the suggested sequence:

```
feat(quant): QN-060 paper-window validator + paper_validation_runs (Step 6.1)
test(chaos): BE-120 chaos suite (Step 6.2)
feat(replay): QN-062 decision replay + FE-060 transcript endpoint (Step 6.3)
feat(promotion): QN-061 signed report, BE-122 gate, BE-121 canary (Step 6.4)
feat(gdpr): BE-132 export + erasure (Step 6.5)
docs: Phase-6 DEVLOG + testing guide
```
