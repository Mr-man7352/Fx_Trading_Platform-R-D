# Phase 3 — Completion Summary & Test Plan

Companion to [`PHASE2_TESTING_GUIDE.md`](PHASE2_TESTING_GUIDE.md) (same
philosophy: everything below was tsc-verified in the sandbox but the runtime
proofs need your machine). Phase-3 build record lives in
[`DEVLOG_phase3.md`](DEVLOG_phase3.md); plan in [`FX_PRD.md`](FX_PRD.md) §8.

**Phase 3 exit criteria (PRD):** end-to-end paper cycle bar-close → entry
gate → agents → risk gate → order; kill-switch flattens broker-confirmed in
< 2 s; red-team suite green.

---

## 1. What's built and code-complete

| Step | Stories | What it is |
|---|---|---|
| 3.1 | BE-069/060/061/068 | Agent contracts, LLM provider factory + failover, prompt registry, gRPC circuit breaker — committed `8ef34fe` |
| 3.2 | BE-074/062/064/063/065/066/067 | Context assembler, LangGraph debate graph, agent memory, red-team suite (28 fixtures), disagreement cohort, signals worker, REST+WS — committed `975c2c8` |
| 3.3 | BE-070/071/072/073 | `packages/risk-gate` deterministic rule engine (final authority), correlation cap, kill-switch API, Postgres-source-of-truth state — **uncommitted, this diff** |

Key Step-3.3 facts for testing:

- The signals worker's risk gate is now the REAL engine
  (`DeterministicRiskGate`) — an agent APPROVE can reach the execution queue
  for the first time, but only if every §10 rule passes.
- `POST /settings/kill-switch` cancels pending intents, closes open
  positions over gRPC, and reports `closing`/`flat`/`failed` — **never flat
  without a broker re-list confirming it** (ADR-012).
- Kill-switch state: Postgres row = source of truth; Redis
  `kill-switch:active` = cache only; workers re-hydrate on boot and on
  every cache miss.
- New env keys (all defaulted, see `.env.example`): `RISK_MAX_CONCURRENT_TRADES`,
  `RISK_MAX_PER_CLUSTER`, `RISK_CLUSTER_EXEMPTIONS`, `RISK_DAILY_DD_HALT_PCT`,
  `RISK_WEEKLY_DD_HALT_PCT`, `RISK_INSTRUMENT_DAILY_LOSS_PCT`, `RISK_MIN_RR`,
  `RISK_WEEKEND_FLATTEN_ENABLED`, `RISK_ROLLOVER_AUTOFLATTEN_XAU`.

## 2. The gap: what "code complete" hasn't proven yet

- Vitest never ran in the sandbox (macOS-only native binding) — the ~46 new
  Step-3.3 test cases (risk-gate engine + kill-switch store/close-out) and
  all Step-3.2 suites (incl. the 28-fixture red-team suite) are unrun.
- `pnpm install` / prisma generate / migrate for the new `@fx/risk-gate`
  package and `kill_switch_state` table never ran.
- No live LLM call has ever crossed the graph (keys were never configured).
- The kill-switch has never touched a real broker; the <2s number is only
  proven against fakes.
- No end-to-end bar-close → order cycle has run with the real gate.

## 3. Test plan, in order

### A. Static checks + install (fast, no infra)

```sh
# repo root
pnpm install                    # lockfile picks up @fx/risk-gate
pnpm --filter @fx/types build   # dist + JSON schemas (killswitch.ts added)
pnpm --filter @fx/llm build
pnpm --filter @fx/risk-gate build
pnpm typecheck                  # turbo — all workspaces
pnpm lint                       # Biome (unrun in sandbox — expect format nits at worst)
pnpm test                       # Vitest — NEW: packages/risk-gate engine.test.ts (~35 cases),
                                #        apis/node-api execution/kill-switch.test.ts (~11 cases)
node scripts/check-env.mjs --ci # 53 keys
```

### B. Database migration (additive — one new table)

```sh
cd apis/node-api
pnpm exec prisma generate
pnpm exec prisma migrate dev --name step_3_3_kill_switch
pnpm exec prisma migrate status   # "Database schema is up to date"
psql $DATABASE_URL -c '\d kill_switch_state'
```

No `migrate reset` needed this time — `KillSwitchState` is purely additive.

### C. Risk gate end-to-end (keyless first — zero LLM cost)

Boot the stack the same way as Phase 2 §C (db + redis + quant), then:

```sh
pnpm --filter @fx/node-api worker:signals     # boot log: no "NO LLM PROVIDER KEYS" crash,
                                              # kill-switch boot hydration silent = OK
pnpm --filter @fx/node-api trip-signals       # fire a bar-close job
```

Expected with no champion model: `gate_skip` / `NO_CHAMPION` HOLDs, zero LLM
cost, jobs completing — same as the Step-3.2 smoke. The gate itself only
fires after a PM APPROVE, so to exercise it deterministically:

```sh
pnpm --filter @fx/node-api test -- signals-worker   # unit path: approve-gate → intent
pnpm --filter @fx/risk-gate test                    # every §10 rule + combinations
```

Rule-engine spot checks worth eyeballing in the test output (they encode the
story ACs): P=0.58 ⇒ `PROB_BELOW_THRESHOLD`; 3rd trade in a cluster ⇒
`CORRELATION_CAP`; instrument down >2% today ⇒ `INSTRUMENT_DAILY_LOSS`;
spread 15 pips ⇒ `FLASH_SPREAD` + critical alert; summer AND winter DST
fixtures both resolve; Saturday bar ⇒ `MARKET_CLOSED`.

### D. Kill-switch drill (THE Phase-3 safety test)

Needs: api + quant running, OANDA practice creds seeded (Phase 2 §D), and at
least one small open paper position (open one via
`pnpm --filter @fx/node-api enqueue-intent -- EUR_USD long 1000 <entry> <sl> <tp>`).

```sh
TOKEN=$(grep ^INTERNAL_API_TOKEN .env | cut -d= -f2)

# 1. state before
curl -s -H "x-internal-token: $TOKEN" localhost:4000/settings/kill-switch | jq

# 2. ACTIVATE — timed (the <2s AC)
time curl -s -H "x-internal-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"action":"activate","reason":"phase-3 drill"}' \
  localhost:4000/settings/kill-switch | jq
```

Check in the response: `elapsedMs < 2000`; `closeOut.pendingIntentsCancelled`
matches what you had queued; every close attempt `status: "closed"`;
`closeOut.brokerConfirmedFlat: true` and `state.closeOutStatus: "flat"`.
If the broker rejects a close you should instead see `closing`/`failed`,
escalating Telegram alerts, and the 60s reconciler as backstop — that's
correct behaviour, not a bug.

```sh
# 3. workers actually paused? fire a job while active:
pnpm --filter @fx/node-api trip-signals
# worker log: signal_cycle_skipped_halt — zero LLM spend

# 4. CHAOS CHECK (the ADR-012 property): flush Redis while active
docker compose -f infra/docker-compose.local.yml exec redis redis-cli FLUSHALL
pnpm --filter @fx/node-api trip-signals
# worker log: STILL signal_cycle_skipped_halt (re-hydrated from Postgres).
# `redis-cli GET kill-switch:active` → "1" again (cache repopulated).

# 5. verify on the broker side (OANDA practice UI): no open trades.

# 6. audit trail
curl -s -H "x-internal-token: $TOKEN" 'localhost:4000/audit?limit=20' | jq \
  '.entries[] | select(.details.action | startswith("kill_switch"))'

# 7. DEACTIVATE
curl -s -H "x-internal-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"action":"deactivate"}' localhost:4000/settings/kill-switch | jq
# then confirm trading resumes: trip-signals → normal gate_skip/HOLD cycle,
# NOT skipped_halt.
```

Edge assertions (quick curls): activate twice ⇒ 409 `ALREADY_ACTIVE`;
activate without `reason` ⇒ 400; deactivate when inactive ⇒ 409 `NOT_ACTIVE`.

### E. Agent graph live (needs LLM keys — first real spend)

```sh
# .env: ANTHROPIC_API_KEY (and/or others), EMBEDDING_PROVIDER=openai + OPENAI_API_KEY
# for any run you intend to keep as paper evidence (§9.5 — spaces never mix).
pnpm --filter @fx/node-api worker:signals
```

To make the graph actually fire you need a champion model
(`RunPipeline has_candidate=true`) — follow Phase 2 §E (train → promote) if
you haven't, remembering the carried-forward warning: the existing
`XAU_USD/H1 v1` artifact has NO edge (OOF AUC 0.51) — plumbing only, retrain
on ≥18 months before treating any output as meaningful.

On a real candidate expect, in order: `Signal` row → `agent_runs` rows (one
per role, provider/tier/cost filled) → `agent_debates` transcript →
`disagreement_cohort` row when quant and PM conflict → risk-gate checks
jsonb on the `trade_intents.risk_gate` column (APPROVE path) or
`signal_cycle_risk_gate_veto` audit (veto path) → order in the execution
queue. WS: subscribe to channel `signals`, expect
`signal:hold|debate|risk_gate_veto|approved` events live.

### F. Red-team suite (exit criterion #3)

```sh
pnpm --filter @fx/node-api test -- red-team
```

28 fixtures across 10 categories must be green. This suite is the regression
harness; live-model behavioural red-teaming happens during the paper phase —
add any new pattern you find to `red-team.fixtures.ts`.

### G. Observability while it runs

Phase 2 §G stack still applies. New things worth watching: `signals` queue
depth (>10 = warning per §12.1), gRPC circuit state, per-cycle LLM cost in
`agent_runs`, and the `risk.halt` / `risk.resume` WS events during the §D
drill. The Grafana kill-switch/SMS alert wiring is Phase 6 (BE-120 chaos
tests will also re-run the §D.4 Redis-flush check formally).

## 4. Mapping to the Phase-3 exit criteria

| Exit criterion | Proven by |
|---|---|
| E2E paper cycle bar-close → gate → agents → risk gate → order | §C (keyless plumbing) + §E (live, needs champion + keys) |
| Kill-switch flattens broker-confirmed < 2 s | §D.2 timed activate + broker check §D.5 |
| Kill-switch survives Redis restart (ADR-012) | §D.4 chaos check |
| Red-team suite green | §F in CI |
| Deterministic authority never delegates (§10) | §C rule tests + `trade_intents.risk_gate` checks jsonb |

## 5. Known-open seams (fine for Phase 4, don't re-discover them)

- **Economic calendar:** no vendor wired — the blackout rule records
  `'no calendar vendor wired'` and passes. Wire a `CalendarProvider` before
  live trading; the NFP fixture test defines the expected behaviour.
- **Dashboard kill-switch button:** visible no-op until Phase-5 auth
  (FE-033) — the API is the operator interface for now (§D).
- **2FA:** `twoFactorCode` is accepted and audited but unverified until
  BE-036 lands (Phase 5). Activation will never be blocked on 2FA.
- **Broker equity sync:** account state = `ACCOUNT_BASELINE_EQUITY` +
  realized P&L. Fine for paper; revisit before live.
- **Carried from Phase 2:** `uv run pytest/mypy/ruff` on real 3.13; off-host
  watchdog deploy; `/dashboard` visual check (Phase-2 guide §3 still the
  reference if any of these are still open on your side).

## 6. Before starting Phase 4

1. Everything in §A green; migration §B applied.
2. §D drill passed end-to-end at least once, including the Redis-flush check.
3. Commit Step 3.3 (this diff) — suggested message:
   `feat(risk): Step 3.3 deterministic risk gate & kill-switch (BE-070..073)`.
4. Phase 4 opens with the backtest harness (QN-050…) + trade supervision
   (BE-080/081) — the vectorbt engine needs the §E champion-model flow
   working, so close that loop first.
