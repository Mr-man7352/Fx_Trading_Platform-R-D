# Phase 4 — Completion Summary & Test Plan

Companion to [`PHASE3_TESTING_GUIDE.md`](PHASE3_TESTING_GUIDE.md) (same
philosophy: everything below was source-reviewed and unit-tested in the
sandbox, but the runtime proofs need your machine — real Python 3.13, a
`pnpm install`ed workspace, Postgres/Redis, and a promoted champion model).
Phase-4 build record lives in [`DEVLOG_phase5.md`](DEVLOG_phase5.md); plan in
[`FX_PRD.md`](FX_PRD.md) §8.

**Phase 4 exit criteria (PRD):** a backtest replays deterministically; the
agentic runner matches the quant core on the quant-only path; ablations
runnable. Plus the Step-4.1 outcome: open trades supervised.

---

## 1. What's built and code-complete

| Step | Stories | What it is |
|---|---|---|
| 4.1 | BE-080 | Supervision queue + **deterministic material-change gate** — LLM supervisor runs only on material change; "nothing changed ⇒ HOLD, zero LLM cost" audited as `supervision_gate_skip`. |
| 4.1 | BE-081 | **Layered exit system** — 5 independent deterministic layers (`hard_sl_tp`, `dd_halt`, `pre_news_flatten`, `time_stop`, `atr_trail`), fixed priority, first-to-fire wins. |
| 4.2 | QN-050 | **vectorbt quant-core backtest engine** — bracket fills identical to `app.quant.labels`; spread/slippage/swap/Wednesday-triple-swap/weekend-gap/flash-crash modelled; P-threshold sweep 0.55–0.70 (default 0.60); vectorbt optional with numpy fallback. |
| 4.2 | QN-051 | **Point-in-time news/sentiment** — `published_at <= bar_ts` leakage check embedded in every run; `LookAheadError` on violation. |
| 4.2 | QN-053 | **Purged/embargoed OOS validation** — purged k-fold, deflated Sharpe, seeded MC drawdown, seeded bootstrap p-value → verdict `VALIDATED | NOT VALIDATED`. |
| 4.2 | QN-054 | **Ablation harness** — quant-only vs +sentiment vs +full; debate-round (0/1/2) × regime-uncertainty sweep. |
| 4.2 | QN-055 | **Calibration & regime REST** — `GET /models/{instrument}/{tf}/{version}/calibration`, `GET /regime/{instrument}` (PRD tags Phase 5; built here). |
| 4.2 | QN-056 | **Event-driven agentic runner** — strictly sequential bars, same LangGraph code path via `TRADING_MODE=backtest`, incremental deterministic memory, reconciles quant-only vs QN-050. |
| 4.2 | QN-052 | **Three execution modes** — quant-only / cached-LLM / live-LLM; cache keyed on (prompt template version + full input bundle incl. `retrieved_memory_ids`). |
| 4.2 | BE-090 | **Backtest trigger + results API** — `POST /backtests`, `GET /backtests`, `GET /backtests/:id`; BullMQ worker runs quant engine or agentic runner. |

**Deferred on purpose:** **FE-080 (backtest config + results UI)** moves to
Phase 5 with the rest of the dashboard — there is no AppShell / design surface
to hang it on yet, and BE-090 fully surfaces results over REST + WS. Not a gap;
a sequencing choice (see DEVLOG Current state).

**Final-check fix (2026-07-12):** the `worker-supervision` and `worker-backtests`
processes had `package.json` scripts + tsup build entries but were missing from
both compose files, so `pnpm stack:up` never supervised open trades or drained
the `backtests` queue. Both are now wired into
`infra/docker-compose.local.yml` and `infra/docker-stack.yml` (mirroring
`worker-signals`). This is what makes the §D / §G drills runnable against the
full stack rather than only via the standalone `pnpm worker:*` commands.

## 2. The gap: what "code complete" hasn't proven yet

- **No Phase-4 migration is needed** — the `supervisions` and `backtest_runs`
  tables (+ the `supervision_action` / `backtest_status` enums and the `Trade`
  FK) are already created by the committed `20260704000000_init` migration and
  match `schema.prisma` column-for-column. Both the models and the DDL landed
  together in `911d697`, so `prisma migrate dev` reports "No changes." Just
  confirm the tables exist after a normal `migrate deploy` / `migrate reset`
  (§B). *(Earlier drafts of this guide wrongly listed a pending
  `step_4_lifecycle` migration — corrected.)*
- **The workspace was never `pnpm install`ed here**, so `@fx/types`,
  `@fx/risk-gate`, and `@fx/llm` aren't linked/built and **no Vitest suite ran**
  — the supervision gate/exit tests, the agentic-runner determinism +
  reconciliation tests, the llm-cache tests, and the backtests-worker tests are
  all unrun on a real machine.
- **The quant backtest tests only partly ran here.** `test_costs.py` +
  `test_validation.py` pass **14/14** (numpy/scipy), but they were run under a
  Python-3.10 shim (`datetime.UTC` + `StrEnum`) because the sandbox can't fetch
  3.13. `test_engine.py` / `test_ablation.py` / `test_pit.py` need TA-Lib
  (`compute_features`) and did **not** run at all here.
- **No backtest has touched the real quant service.** The engine has never run
  end-to-end against cached EUR/USD candles + a champion model; the reconciliation
  cross-check (QN-056 AC) has never fired against the live QN-050 report.
- **No live LLM has crossed the agentic runner.** cached-LLM/live-LLM modes,
  and the bit-identical replay proof, have only been exercised against fakes.
- **Supervision has never supervised a real open trade** — the layered close
  path and the LLM supervisor round-trip are unproven against a broker.
- **Carried forward from Phase 3:** that whole runtime gate (install/migrate/
  build/vitest, kill-switch <2s drill, first live LLM call) is still open and
  is a hard prerequisite for anything in §E–§G that needs the live path. And
  the only trained model `XAU_USD/H1 v1` has **no edge** (OOF AUC 0.51) —
  retrain on ≥18 months before any backtest number is treated as meaningful.

## 3. Test plan, in order

### A. Static checks + install (fast, no infra)

```sh
# repo root
pnpm install                       # lockfile picks up nothing new for Node, but
                                   # links the workspace so @fx/* resolve
pnpm --filter @fx/types build      # dist + JSON schemas (backtest.ts + supervisor added)
pnpm --filter @fx/llm build
pnpm --filter @fx/risk-gate build
pnpm typecheck                     # turbo — all workspaces
pnpm lint                          # Biome
node scripts/check-env.mjs --ci    # new keys: SUPERVISION_*, BACKTEST_RISK_PCT,
                                   # QUANT_BACKTEST_TIMEOUT_MS, LLM_CACHE_DIR, ACCOUNT_BASELINE_EQUITY

# compose wiring for the two Phase-4 workers (added in the final check) — both
# should resolve with no interpolation warnings and appear in the service list.
docker compose -f infra/docker-compose.local.yml config >/dev/null && echo "compose OK"
docker compose -f infra/docker-compose.local.yml config --services | grep -E 'worker-supervision|worker-backtests'
```

### B. Database — no new migration (already in the init migration)

The `supervisions` and `backtest_runs` tables were part of the schema baseline
from the start (`20260704000000_init`), so there is **nothing to generate** for
Phase 4. Just apply the existing chain and confirm the tables are present:

```sh
cd apis/node-api
npx prisma generate                # client only — schema unchanged
npx prisma migrate dev             # applies the chain; expect "No pending migrations"
                                   # and "Already in sync, no schema change" — do NOT
                                   # pass --name; there is nothing new to name
npx prisma migrate status          # "Database schema is up to date"
psql "$DATABASE_URL" -c '\d supervisions'
psql "$DATABASE_URL" -c '\d backtest_runs'
```

If `migrate dev` ever *does* offer to create a migration here, stop — that
means someone edited a Phase-4 model after `911d697`; regenerate it (never
hand-write, per project CLAUDE.md) and reconcile against the init DDL. Nothing
goes in `timescale.sql`; both are plain relational tables.

### C. Unit tests — the deterministic proofs (no broker, no LLM keys)

Node (Vitest):

```sh
pnpm --filter @fx/node-api test -- supervision   # material-change.test.ts, layered-exits.test.ts,
                                                 # supervision-worker.test.ts
pnpm --filter @fx/node-api test -- backtest      # agentic-runner.test.ts (determinism + reconcile),
                                                 # backtest-memory.test.ts, llm-cache.test.ts,
                                                 # simulated-execution.test.ts
pnpm --filter @fx/node-api test -- backtests     # workers/backtests.test.ts (BE-090 worker)
```

Quant (pytest, real Python 3.13 via uv):

```sh
cd services/quant
uv run pytest tests/backtest -q                  # test_costs, test_validation, test_engine,
                                                 # test_ablation, test_pit
```

Spot checks worth eyeballing (they encode the story ACs):
- **BE-080:** identical snapshots ⇒ `material:false` (gate_skip); a 0.5R bucket
  crossing / adverse excursion / session flip / news-blackout onset ⇒ `material:true`.
- **BE-081:** each layer fires in isolation; when two would fire, the
  higher-priority one wins (e.g. `hard_sl_tp` before `atr_trail`);
  `pre_news_flatten` with calendar unavailable ⇒ note, **no** exit.
- **QN-050 costs:** Wednesday multi-day hold shows triple-swap; gap-through-stop
  fills at the open with `gap_excess_pips`; spread spike ⇒ 10× flash slippage.
- **QN-053:** a degenerate/negative ledger returns `NOT VALIDATED` with reasons.
- **QN-056:** same config + cached-LLM + same start ⇒ **bit-identical** result
  twice; `gate_skip` bars leave `cache.stats.calls == 0` for those bars.

### D. Supervision drill (BE-080 / BE-081 — keyless first)

Needs api + quant + db + redis up (Phase 2 §C), and at least one small open
paper position:

```sh
pnpm --filter @fx/node-api enqueue-intent -- EUR_USD long 1000 <entry> <sl> <tp>
pnpm --filter @fx/node-api worker:supervision   # boot log: "supervision worker up
                                                # (mode=paper, interval=60000ms, llm=on|off)"
```

> The supervision worker is now also a compose service (`worker-supervision`,
> added in the final check), so the full stack supervises open trades without
> the manual command: `pnpm stack:up` boots it alongside the other workers —
> `docker compose -f infra/docker-compose.local.yml logs -f worker-supervision`
> shows the same scan-tick output.

Watch the worker log over a couple of scan ticks:
- Unchanged trade ⇒ `trade=… → gate_skip`, and an audit row
  `supervision_gate_skip` with `llmCost:0`. **This is the BE-080 AC.**
- Move the mark price beyond the stop (or set `meta.lastTrailSl` past price) ⇒
  `trade=… → layer_exit (hard_sl_tp)` / `(atr_trail)`; the trade is closed over
  the same gRPC channel the kill-switch uses. **BE-081 AC (first-to-fire).**
- Force a daily-loss ≥ 5% (seed a closed losing trade today) ⇒
  `layer_exit (dd_halt)` with scope `flatten_all` — every open trade closes.
- With `llm=on` and a material change but no matching layer ⇒ one
  `supervision_llm_decision`; confirm TIGHTEN_STOP never widens the stop and a
  schema-invalid reply degrades to HOLD (audit `supervision_input_invalid` or a
  `SCHEMA_INVALID` supervision row).

Confirm it is inert where it must be: with `TRADING_MODE=backtest` the job
returns `skipped_mode`; while the kill-switch is active it returns `skipped_halt`.

### E. Quant backtest engine (QN-050 / QN-051 / QN-053 / QN-054)

Needs the quant service up with cached candles (QN-021 backfill) and a promoted
champion. Drive it through the REST surface the worker uses:

```sh
curl -s localhost:5001/backtest/run -H 'content-type: application/json' -d '{
  "instrument":"EUR_USD","timeframe":"H1",
  "from":"2023-01-01T00:00:00Z","to":"2023-12-31T23:00:00Z",
  "probability_threshold":0.60,"risk_pct":0.01,"initial_equity":10000,
  "run_validation":true,"run_ablations":true
}' | jq '{backend:.metrics_backend, sweep:.threshold_sweep|keys,
          optimal:.optimal_threshold, pit:.point_in_time,
          tail:.metrics.tail_risk, verdict:.validation.verdict}'
```

Expect: completes with full metrics net of costs; `point_in_time.ok == true`
(QN-051); the 0.55–0.70 sweep present with an `optimal_threshold` (QN-050);
`tail_risk` counting gap/flash events; and a `validation.verdict` of
`VALIDATED` or `NOT VALIDATED` (QN-053). `metrics_backend` will say `vectorbt …`
if installed, else `numpy-fallback` — both are valid. `ablation` attributes
performance across components (QN-054). Re-run with a 2023 EUR/USD window that
includes a weekend gap / an XAU multi-day hold to see those cost lines populate.

### F. Agentic runner (QN-056 / QN-052 — the Phase-4 headline)

```sh
# quant-only: no LLM, reconciles against the engine
pnpm --filter @fx/node-api backtest:agentic -- \
  --instrument EUR_USD --from 2023-01-02 --to 2023-03-31 \
  --mode quant-only --memory off --threshold 0.6 | jq '{
    gate:.gate, llm:.llm, metrics:.metrics}'

# cached-llm twice with the same warm cache: results must be identical
pnpm --filter @fx/node-api backtest:agentic -- --instrument EUR_USD \
  --from 2023-01-02 --to 2023-03-31 --mode cached-llm --memory on --threshold 0.6 > run1.json
pnpm --filter @fx/node-api backtest:agentic -- --instrument EUR_USD \
  --from 2023-01-02 --to 2023-03-31 --mode cached-llm --memory on --threshold 0.6 > run2.json
diff <(jq -S . run1.json) <(jq -S . run2.json) && echo "BIT-IDENTICAL ✓"
```

Assert:
- **Single code path:** the runner throws unless `TRADING_MODE=backtest`; the
  graph it invokes is the same BE-062 code as paper/live.
- **Gate-skip zero cost:** `gate.gateSkipRate > 0` and, for those bars,
  `llm.calls`/`llm.cacheMisses` do not increase (structural — the graph is
  never invoked below the gate).
- **Determinism:** the `diff` above is empty (bit-identical) — deterministic
  memory rebuild + deterministic ids, no clocks/randomness (QN-056 AC).
- **Reproducibility labels (QN-052):** cached-llm with 0 misses ⇒
  `llm.reproducible:true`; live-llm ⇒ `reproducible:false` with the explicit
  non-reproducible note.
- **Reconciliation:** run a quant-only backtest via the API (§G) and confirm
  `metrics.reconciliation.withinTolerance:true` — the runner's quant-only path
  agrees with the QN-050 engine on entry overlap + expectancy. Drift flips the
  verdict to `NOT VALIDATED`.

### G. Backtest API (BE-090)

The `backtests` queue consumer is now also a compose service
(`worker-backtests`, pinned `TRADING_MODE=backtest`) — `pnpm stack:up` runs it,
or start it standalone as below.

```sh
TOKEN=$(grep ^INTERNAL_API_TOKEN .env | cut -d= -f2)
pnpm --filter @fx/node-api worker:backtests    # consumer (TRADING_MODE=backtest)

# quant engine run
ID=$(curl -s -H "x-internal-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"kind":"quant","instrument":"EUR_USD","from":"2023-01-01T00:00:00Z",
       "to":"2023-06-30T23:00:00Z","runValidation":true}' \
  localhost:4000/backtests | jq -r .id)              # → 202 {id,status:"queued"}

curl -s -H "x-internal-token: $TOKEN" localhost:4000/backtests/$ID | jq \
  '{status, verdict:.validationVerdict, metrics:(.metrics|keys)}'  # poll → finished

# agentic quant-only run → attaches engine + reconciliation
curl -s -H "x-internal-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"kind":"agentic","mode":"quant-only","instrument":"EUR_USD",
       "from":"2023-01-01T00:00:00Z","to":"2023-03-31T23:00:00Z"}' \
  localhost:4000/backtests | jq
```

Expect: `POST` returns 202 + a queued row; the worker flips it
`running → finished`; `GET /backtests/:id` returns metrics, OOS split +
`validationVerdict`, ablation, and the trade ledger; `GET /backtests` lists
recent runs with the ledger stripped. WS channel `backtests` emits
`backtest:finished` / `backtest:failed`.

### H. QN-055 analytics endpoints

```sh
curl -s localhost:5001/models/EUR_USD/H1/1/calibration | jq '{method:.calibration_method, points:(.curve|length)}'
curl -s "localhost:5001/regime/EUR_USD?timeframe=H1&bars=500" | jq '{current, points:(.timeline|length)}'
```

Calibration curve points + a regime timeline should come back (404 if no such
model version / 422 if too few bars).

### Observability while it runs

`backtests` and `supervision` queue depths; per-run LLM cost in `llm.liveCostUsd`
(agentic live mode) and in `agent_runs`; the `backtest:*` and supervision audit
events. A backtest is CPU-heavy on the quant side — watch the
`QUANT_BACKTEST_TIMEOUT_MS` (default 600s) budget.

## 4. Mapping to the Phase-4 exit criteria

| Exit criterion | Proven by |
|---|---|
| A backtest replays deterministically | §F cached-llm bit-identical `diff` + §C determinism test |
| Agentic runner matches quant core on the quant-only path | §F reconciliation + §G agentic quant-only run (`reconciliation.withinTolerance`) |
| Ablations runnable | §E `run_ablations:true` + §C `test_ablation` |
| Open trades supervised (Step 4.1 outcome) | §D drill (gate_skip zero-cost + layered exits + LLM on material change) |
| Look-ahead is a build-breaking defect (PRD §2.5) | §E `point_in_time.ok` + §C `test_pit` `published_at <= bar_ts` |
| Failing validation blocks live (QN-053) | §E `validation.verdict == NOT VALIDATED` gating (enforced at promotion, Phase 6/BE-101) |

## 5. Known-open seams (fine for Phase 5, don't re-discover them)

- **Economic calendar:** still no vendor wired — `pre_news_flatten` and the
  supervision news-blackout signal record `calendar_unavailable` and pass. Wire
  a `CalendarProvider` before live; the NFP fixture defines expected behaviour.
- **FE-080 backtest UI:** deferred to Phase 5 (§1). The API is the interface
  for now (§G).
- **vectorbt optional:** if you don't `uv sync` vectorbt, the engine uses the
  numpy fallback with identical stat definitions (`metrics_backend` says which).
  Fine for CI; install vectorbt for the equity-curve stats you'll cite in a
  report.
- **Broker equity sync:** account equity in supervision = `ACCOUNT_BASELINE_EQUITY`
  + realized P&L (same seam as Phase 3). Fine for paper/backtest; revisit before live.
- **FinBERT sentiment accuracy:** QN-051/QN-054 are the first real consumers of
  sentiment scores — `uv sync --group ml` for real FinBERT if you want the
  +sentiment ablation to mean something rather than mock scores.
- **Champion edge:** `XAU_USD/H1 v1` is a plumbing artifact (AUC 0.51). Retrain
  on ≥18 months H1 before trusting any backtest/ablation output (Phase-2 guide §E).

## 6. Before starting Phase 5

1. Everything in §A green; §B tables confirmed present (no new migration —
   already in the init migration); §C unit suites green
   (Node + `uv run pytest tests/backtest`).
2. §D supervision drill passed once (gate_skip zero-cost + at least one layered
   exit observed).
3. §E/§F/§G run once against real cached candles + a **retrained** champion —
   in particular the §F reconciliation `withinTolerance:true`.
4. Commit Phase 4 — suggested:
   `feat(lifecycle): Step 4.1 supervision + Step 4.2 backtest harness (BE-080/081, QN-050..056, BE-090)`.
5. Phase 5 (Surface) opens with auth + dashboard — FE-080 lands there alongside
   the other operator pages.
