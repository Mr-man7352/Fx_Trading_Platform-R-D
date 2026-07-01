# FX Platform — Python Quant Service User Stories

*Companion to [`system-design/FX_System_Design.md`](system-design/FX_System_Design.md)*  
*Version 2.2 · 2026-07-01*  
*Scope: Python quant service — feature pipeline, regime detection, session/liquidity features, meta-model, gRPC, broker adapters (OANDA primary), backtesting, shadow baseline, validation.*

---

## How to use this document

Each story is tracker-ready. Story IDs use prefix `QN-`. Story points use Fibonacci (1, 2, 3, 5, 8, 13). Acceptance criteria are Given/When/Then.

**Story shape**

```
### QN-XXX — Title
**As a** <role> **I want** <capability> **so that** <outcome>.

**Acceptance criteria**
- Given … When … Then …

**Technical notes**
- Implementation hints, file paths, library calls, gotchas.

**Dependencies**
- Other stories (BE-/FE-/QN-) that must merge first.

**Points:** N  ·  **Phase:** N  ·  **Epic:** EP-QN-X
```

---

## Pinned package versions (verified 2026-06-28)

| Package | Version | Notes |
|---|---|---|
| Python | `3.13.x` | Chosen over 3.14 for vectorbt/LightGBM/hmmlearn compatibility |
| `uv` | latest | Package + venv manager |
| `fastapi` | `0.11x` | REST for dashboard/backtest triggers |
| `uvicorn[standard]` | latest | ASGI server |
| `grpcio` + `grpcio-tools` | `1.x` | gRPC server for Node workers |
| `pydantic` | `2.x` | v2 typing style |
| `pydantic-settings` | `>=2.0` | Config |
| `pandas` / `numpy` / `polars` | `2.x` / `2.x` / `1.x` | Feature engineering |
| `pandas-ta` / `TA-Lib` | current / `0.4.x` | Single indicator source of truth |
| `scikit-learn` / `lightgbm` | `1.x` / `4.x` | Meta-model + calibration |
| `statsmodels` / `hmmlearn` | `0.14.x` / `0.3.x` | Regime detection |
| `scipy` | `1.x` | Vol-target sizing, Kelly cap |
| `vectorbt` | `0.27.x` | Vectorised backtesting |
| `transformers` | `4.x` | FinBERT sentiment |
| `MetaTrader5` | current | MT5 broker adapter |
| `httpx` | latest | OANDA REST client |
| `pytest` + `pytest-asyncio` + `pytest-cov` | latest | Tests |
| `ruff` | latest | Lint + format |
| `mypy` | latest (strict) | Type-checking |
| `datamodel-code-generator` | latest | JSON Schema → Pydantic from `@fx/types` |

---

## Table of contents

- **EP-QN-1** — Service template & dev ergonomics *(Phase 1)*
- **EP-QN-2** — Market data ingestion & vendor adapters *(Phase 1)*
- **EP-QN-3** — Broker abstraction & execution adapters *(Phase 2)*
- **EP-QN-4** — Deterministic quant core (features, regime, meta-model) *(Phase 2)*
- **EP-QN-5** — Backtesting & validation harness *(Phase 4)*
- **EP-QN-6** — Model lifecycle & go-live validation *(Phase 6)*

---

## EP-QN-1 — Service template & dev ergonomics

### QN-001 — Quant service scaffold (`services/quant`)
**As a** developer **I want** a FastAPI + gRPC service scaffold **so that** quant work has a canonical home.

**Acceptance criteria**
- Given `services/quant/`, when `uv sync && uv run uvicorn app.main:app --reload` runs, then `GET /healthz` returns 200 on `:5000`.
- Given gRPC server, when started, then listens on `:50051` with health check RPC.
- Given `pytest`, when run, then starter tests pass.

**Technical notes**
- Python 3.13, `uv`, ruff + mypy preconfigured.
- `TRADING_MODE` env read at boot.

**Dependencies** — none. **Points:** 5 · **Phase:** 1 · **Epic:** EP-QN-1

---

### QN-002 — Shared `fx_common` library
**As a** quant engineer **I want** shared logging, errors, and contract loaders **so that** modules don't reinvent basics.

**Acceptance criteria**
- Given `libs/fx_common`, when imported, then `RequestContext`, `FXError`, `load_contract(name)` available.
- Given service start, when initialised, then structured JSON logging with `request_id`, `trading_mode`.

**Dependencies** — QN-001. **Points:** 3 · **Phase:** 1 · **Epic:** EP-QN-1

---

### QN-003 — Pydantic codegen from `@fx/types` JSON Schema
**As a** quant engineer **I want** Pydantic models generated from shared contracts **so that** Node and Python stay aligned.

**Acceptance criteria**
- Given CI step, when `datamodel-codegen` runs, then `app/contracts/` regenerated from `packages/types/dist/schemas`.
- Given drift, when CI runs, then fails.

**Dependencies** — QN-001, FE-004. **Points:** 5 · **Phase:** 1 · **Epic:** EP-QN-1

---

### QN-004 — gRPC service definitions (Pipeline, SizePosition, Predict)
**As a** Node worker **I want** typed gRPC RPCs **so that** hot-path calls are low-latency.

**Acceptance criteria**
- Given `RunPipeline`, when called with instrument/timeframe/bar_ts, then features + candidate returned within 30s budget (H1).
- Given `SizePosition`, when called, then vol-targeted lots + calibrated probability returned.
- Given `Predict`, when called, then P(profitable) with calibration metadata.

**Technical notes**
- Proto files in `services/quant/proto/`; generate Python + TS stubs.

**Dependencies** — QN-001, QN-003. **Points:** 8 · **Phase:** 2 · **Epic:** EP-QN-1

---

### QN-005 — Quant Dockerfile + deploy config
**As a** developer **I want** quant service deployable alongside Node **so that** ops is uniform.

**Acceptance criteria**
- Given multi-stage Dockerfile, when built, then image includes TA-Lib C lib and gRPC server.
- Given deploy, when healthchecks pass, then service registered in Swarm stack.

**Dependencies** — QN-001. **Points:** 3 · **Phase:** 1 · **Epic:** EP-QN-1

---

## EP-QN-2 — Market data ingestion & vendor adapters

### QN-020 — Broker feed streaming adapter (OANDA)
**As the** system **I want** ticks streamed from OANDA v20 feed **so that** candles aggregate correctly.

**Acceptance criteria**
- Given OANDA streaming prices connected, when ticks arrive, then they publish to market-data worker ingest endpoint or direct DB write path.
- Given stale feed (>30s no tick), when detected, then degraded flag raised.

**Technical notes**
- Uses a **minimal OANDA v20 client** (auth + pricing stream only) so this Phase 1 story does not depend on the Phase 2 execution adapter; QN-032 builds the full order-lifecycle adapter on the same client core.

**Dependencies** — QN-001. **Points:** 5 · **Phase:** 1 · **Epic:** EP-QN-2

---

### QN-021 — OANDA historical backfill + vendor cross-check
**As a** developer **I want** OANDA-candles backfill (with a Twelve Data cross-check) **so that** the last 6 months of history for traded instruments is loaded and validated.

**Acceptance criteria**
- Given a backfill job for EUR/USD and XAU_USD M1 over the last 6 months, when run, then candles (bid/ask/mid) load via the OANDA v20 candles endpoint (paginated, 5,000/request) into TimescaleDB with no gaps at expected market hours.
- Given loaded candles, when the Twelve Data cross-check runs (free tier, sampled bars), then discrepancies beyond tolerance are logged to the data-quality monitor.
- Given a re-run of the same job, when executed, then it is idempotent (upsert, no duplicates).

**Technical notes**
- Reuses the minimal OANDA client from QN-020 — no separate paid vendor adapter in v1 (see design doc §16, resolved v2.3).

**Dependencies** — QN-020. **Points:** 3 · **Phase:** 1 · **Epic:** EP-QN-2

---

### QN-022 — FinBERT point-in-time sentiment scoring
**As the** quant core **I want** local FinBERT scoring on news archive **so that** sentiment features are reproducible.

**Acceptance criteria**
- Given headline with `published_at`, when scored, then sentiment vector stored; backtest query respects timestamp.

**Dependencies** — BE-042. **Points:** 8 · **Phase:** 1 · **Epic:** EP-QN-2

---

## EP-QN-3 — Broker abstraction & execution adapters

### QN-030 — Typed BrokerAdapter interface
**As a** developer **I want** a shared BrokerAdapter contract **so that** MT5 and OANDA are swappable.

**Acceptance criteria**
- Given Zod/JSON Schema contract, when both adapters implemented, then conformance tests pass for: connect, get_positions, place_order, close_order, get_history.

**Dependencies** — QN-003. **Points:** 5 · **Phase:** 2 · **Epic:** EP-QN-3

---

### QN-031 — MT5 adapter (optional, not on critical path)
**As the** system **I want** MT5 adapter as optional future venue **so that** alternative execution remains possible.

**Acceptance criteria**
- Given demo account, when market order placed, then fill returned with `broker_trade_id`; idempotent retry via magic + UUID comment verified.
- Given headless terminal, when adapter connects, then reconnect on disconnect with safe state.
- Given production deploy, when reviewed, then MT5 is not required for live trading (OANDA is sole venue).

**Technical notes**
- The `MetaTrader5` Python package is **Windows-only** — it cannot run in the Linux service image or CI. Interface conformance tests run against a mocked adapter in CI; live MT5 verification requires a Windows environment and is deferred until/unless the venue is activated.

**Dependencies** — QN-030. **Points:** 8 · **Phase:** 2 · **Epic:** EP-QN-3

---

### QN-032 — OANDA v20 adapter (primary execution venue)
**As the** system **I want** OANDA as sole production execution venue **so that** swing trades execute without terminal dependency.

**Acceptance criteria**
- Given demo account, when order placed, then idempotency via `clientExtensions.id` verified.
- Given streaming prices, when connected, then ticks feed market-data pipeline.
- Given partial fill response, when `fill_qty < requested_qty`, then partial fill returned with remainder qty for execution worker handling.
- Given all configured instruments (FX majors, XAU, oil), when orders placed, then symbol mapping resolves correctly.

**Dependencies** — QN-030. **Points:** 8 · **Phase:** 2 · **Epic:** EP-QN-3

---

### QN-033 — Symbol mapping table
**As a** developer **I want** per-broker symbol resolution **so that** EURUSD.r / XAUUSD / USOIL / UKOIL map correctly.

**Acceptance criteria**
- Given instrument enum, when resolved per broker, then correct broker symbol returned for all configured instruments.

**Dependencies** — QN-030. **Points:** 3 · **Phase:** 2 · **Epic:** EP-QN-3

---

### QN-034 — Cross-currency pip/lot/margin module
**As a** risk core **I want** pip value and margin computed per instrument × account currency **so that** sizing is correct for GBP accounts.

**Acceptance criteria**
- Given test suite per instrument × GBP account, when run at live rates fixture, then pip value and margin assertions pass.

**Dependencies** — QN-030. **Points:** 5 · **Phase:** 2 · **Epic:** EP-QN-3

---

## EP-QN-4 — Deterministic quant core

### QN-040 — Point-in-time feature pipeline
**As the** system **I want** indicators, S/R, candle stats, macro/flow, session labels as single source of truth **so that** features are leak-free.

**Acceptance criteria**
- Given EUR/USD H1 fixture, when pipeline runs, then features logged; no-look-ahead test passes.
- Given TA-Lib indicators, when computed, then same values whether called from pipeline or validation script.
- Given bar at any UTC hour, when pipeline runs, then `session_label` emitted: `TOKYO` | `LONDON` | `NEW_YORK` | `OVERLAP` | `OFF_HOURS` — session boundaries defined in **exchange-local time via IANA tz (DST-aware)**, never fixed UTC hours (London opens 07:00 UTC in summer, 08:00 UTC in winter).
- Given one summer fixture bar and one winter fixture bar at the same wall-clock local session time, when labelled, then both resolve to the same session (DST regression test).
- Given specialist analyst routing, when features returned, then partitioned into `technical`, `macro`, `sentiment` subsets per agent context contract.

**Dependencies** — QN-004, BE-043. **Points:** 13 · **Phase:** 2 · **Epic:** EP-QN-4

---

### QN-041 — Regime detection (HMM/Markov-switching) + liquidity regime
**As the** system **I want** trend regime labels and separate liquidity regime with out-of-sample stability monitoring **so that** regime context informs agents, debate depth, and sizing.

**Acceptance criteria**
- Given historical data, when regime detection runs, then trend timeline produced; stability metric tracked across folds.
- Given HMM entropy computed, when exported, then usable by signal worker to set debate rounds (0/1/2).
- Given spread percentile and volume data, when liquidity regime computed, then separate `liquidity_regime: HIGH | NORMAL | LOW` label emitted (distinct from trend regime).
- Given Christmas week or Asian session for EUR pairs, when liquidity regime = LOW, then flag surfaces to risk gate for spread multiplier tightening.

**Dependencies** — QN-040. **Points:** 8 · **Phase:** 2 · **Epic:** EP-QN-4

---

### QN-042 — Vol-targeted sizing + fractional-Kelly cap
**As a** risk core **I want** vol-target sizing respecting FCA caps and broker min-lot **so that** 1×ATR adverse move ≈ fixed % equity.

**Acceptance criteria**
- Given candidate + account state, when sized, then lots respect FCA leverage caps and min-lot; caps enforced in unit tests.

**Dependencies** — QN-040, QN-034. **Points:** 8 · **Phase:** 2 · **Epic:** EP-QN-4

---

### QN-043 — LightGBM meta-model + calibration
**As the** system **I want** P(profitable) with isotonic/Platt calibration trained walk-forward **so that** probabilities are trustworthy.

**Acceptance criteria**
- Given trained model, when predict called, then calibrated probability emitted; reliability curve produced; no future data in training fold.

**Dependencies** — QN-040. **Points:** 13 · **Phase:** 2 · **Epic:** EP-QN-4

---

### QN-044 — Probability-modulated sizing (optional flag)
**As the** system **I want** size scaled by calibrated probability within vol envelope **so that** high-confidence trades size up slightly.

**Acceptance criteria**
- Given flag enabled, when P=0.60 vs P=0.75, then size scales ~0.5×–1×; LLM never touches sizing.

**Dependencies** — QN-042, QN-043. **Points:** 3 · **Phase:** 2 · **Epic:** EP-QN-4

---

### QN-045 — Shadow quant baseline
**As an** operator **I want** trend + vol-breakout baseline logged alongside agents **so that** agents-vs-baseline is always measurable.

**Acceptance criteria**
- Given any mode, when bar processed, then `baseline_signals` populated; comparison metric computed continuously.

**Dependencies** — QN-040. **Points:** 5 · **Phase:** 2 · **Epic:** EP-QN-4

---

### QN-046 — Champion/challenger promotion + drift monitor
**As an** operator **I want** new models to shadow incumbent before promotion **so that** bad retrains don't reach live.

**Acceptance criteria**
- Given challenger trained, when promoted, then shadows first; calibration drift metric alerts on decalibration.

**Dependencies** — QN-043. **Points:** 8 · **Phase:** 2 · **Epic:** EP-QN-4

---

### QN-047 — Session, rollover, and gap-risk features
**As the** risk core **I want** session-aware spread multipliers, Wednesday rollover flags, and weekend gap exposure signals **so that** risk gate can apply session-specific rules.

**Acceptance criteria**
- Given H1 bar at London open vs 03:00 UTC overnight, when session features computed, then different `session_label` and expected volatility profile emitted.
- Given position held >2 days crossing Wednesday rollover at **17:00 New York time (DST-aware — 21:00/22:00 UTC)**, when rollover check runs, then `triple_swap_day: true` flag set for XAU and FX pairs.
- Given the pre-close window before Friday **17:00 New York time (DST-aware)** and high-vol regime, when gap-risk feature computed, then `weekend_gap_risk: HIGH` flag surfaces to risk gate.
- Given summer and winter fixtures, when rollover and Friday-close windows evaluate, then both resolve correctly (DST regression test).
- Given session spread multiplier config, when OFF_HOURS, then 1.5× multiplier applied in risk gate spread filter.

**Dependencies** — QN-040, QN-041. **Points:** 5 · **Phase:** 2 · **Epic:** EP-QN-4

---

### QN-048 — Correlation clustering computation + event-triggered refresh
**As the** risk core **I want** correlation clusters computed in Python and published for the Node risk gate **so that** correlated-exposure caps rest on owned, tested maths ("Node never does maths", §3.1).

**Acceptance criteria**
- Given rolling 60-day Pearson correlation matrix across configured instruments, when hierarchical clustering runs with 0.7 threshold, then a cluster table is published (DB table consumed by BE-071) with computation timestamp and parameters.
- Given the weekly schedule, when refresh runs, then clusters recomputed and versioned (previous clusters retained for audit).
- Given a **liquidity-regime transition or realized-vol spike** (risk-off event), when detected, then an event-triggered recompute runs immediately — correlations between majors can converge within hours in risk-off; weekly alone is too slow.
- Given parameters (lookback, threshold, refresh cadence, vol-spike trigger), when configured via settings, then defaults match system design §10.
- Given a historical risk-off fixture (e.g. a 2020-03-style window), when clustered, then EUR/USD–GBP/USD convergence is detected by the event trigger before the weekly refresh would have caught it.

**Dependencies** — QN-040, QN-041. **Points:** 5 · **Phase:** 2 · **Epic:** EP-QN-4

---

## EP-QN-5 — Backtesting & validation harness

### QN-050 — vectorbt backtest engine (quant-core path)
**As a** researcher **I want** vectorised backtests with spread, slippage, swap, rollover, and gap modelled **so that** results are cost-accurate.

> **Scope note:** vectorbt covers the **quant-core-only** path. Agent + memory backtests are inherently sequential (bar N's memory depends on bars 1…N−1) and run through the event-driven runner in **QN-056**, which reconciles its quant-core results against this engine as a correctness check.

**Acceptance criteria**
- Given EUR/USD H1 2023 cached candles, when backtest runs, then completes with full metrics including net of costs.
- Given weekend gap scenario, when modelled, then loss beyond stop reflected in tail-risk tests.
- Given Wednesday triple-swap on XAU multi-day hold, when modelled, then swap costs reflected in P&L.
- Given SNB-style flash crash fixture (spread spike 10×), when modelled, then slippage beyond stop documented in tail-risk report.
- Given calibration curve, when P threshold sweeped (0.55–0.70), then optimal default documented (target: 0.60).

**Dependencies** — QN-040, QN-047. **Points:** 13 · **Phase:** 4 · **Epic:** EP-QN-5
*(BE-090 depends on this engine, not the reverse — the API triggers backtests; the engine must not require the API.)*

---

### QN-051 — Point-in-time news/sentiment in backtests
**As a** researcher **I want** news features in backtest **so that** sentiment edge is testable without leakage.

**Acceptance criteria**
- Given backtest run, when leakage test executes, then `published_at <= bar_ts` everywhere.

**Dependencies** — QN-022, QN-050. **Points:** 5 · **Phase:** 4 · **Epic:** EP-QN-5

---

### QN-052 — Three execution modes (quant-only, cached-LLM, live-LLM)
**As a** researcher **I want** ablatable LLM modes **so that** reproducibility is explicit.

**Acceptance criteria**
- Given cached-LLM mode, when every LLM call is cache hit, then run marked reproducible.
- Given live-LLM mode, when run, then explicitly labeled non-reproducible.
- Given memory-enabled runs, when cached, then the cache is keyed on **(prompt template version + full input bundle incl. `retrieved_memory_ids`)** — memory injects per-bar context, so raw prompt-hash caching yields near-zero hits and must not be relied on for cost control.

**Dependencies** — QN-050, QN-056, BE-062. **Points:** 5 · **Phase:** 4 · **Epic:** EP-QN-5

---

### QN-053 — Purged/embargoed OOS validation suite
**As a** researcher **I want** purged CV, deflated Sharpe, MC drawdown, bootstrap p-value **so that** failing runs block live.

**Acceptance criteria**
- Given failing validation metrics, when gate checked, then verdict `NOT VALIDATED` blocks live promotion.

**Dependencies** — QN-050. **Points:** 8 · **Phase:** 4 · **Epic:** EP-QN-5

---

### QN-054 — Ablation harness
**As a** researcher **I want** ablation reports (quant-only vs +sentiment vs +full; debate-round sweep; memory on/off) **so that** edge attribution is clear.

**Acceptance criteria**
- Given ablation config, when run, then report attributes performance to components.
- Given debate-round sweep (0/1/2) × regime uncertainty matrix, when run, then optimal debate-regime linkage documented.

**Dependencies** — QN-052. **Points:** 5 · **Phase:** 4 · **Epic:** EP-QN-5

---

### QN-055 — REST endpoints for calibration & regime
**As the** frontend **I want** REST endpoints for quant analytics **so that** `/quant` page loads data.

**Acceptance criteria**
- Given `GET /models/{id}/calibration`, when called, then calibration curve points returned.
- Given `GET /regime/{instrument}`, when called, then regime timeline returned.

**Dependencies** — QN-041, QN-043. **Points:** 3 · **Phase:** 5 · **Epic:** EP-QN-5

---

### QN-056 — Event-driven agentic backtest runner
**As a** researcher **I want** a sequential bar-by-bar simulation loop for agent + memory backtests **so that** the agent stack is testable historically — vectorbt is vectorised and cannot simulate memory that accumulates across bars.

**Acceptance criteria**
- Given a backtest window, when the runner executes, then bars are processed **strictly sequentially**; agent memory is rebuilt incrementally and deterministically during the run (empty at start, reflections written as the run progresses — never read from live memory).
- Given the same config + cached-LLM mode + same starting state, when run twice, then results are bit-identical (deterministic memory rebuild verified).
- Given the LangGraph code path, when invoked by the runner, then it is the **same graph code** as paper/live (design principle #2 — single code path), driven through `TRADING_MODE=backtest`.
- Given a quant-only configuration, when run through this runner, then results reconcile with the vectorbt engine (QN-050) within tolerance — correctness cross-check.
- Given the entry gate (ADR-010), when simulated, then `gate_skip` bars incur zero LLM/cache calls, and gate-skip rates are reported.

**Dependencies** — QN-050, BE-062, BE-064, BE-066. **Points:** 13 · **Phase:** 4 · **Epic:** EP-QN-5

---

## EP-QN-6 — Model lifecycle & go-live validation

### QN-060 — 90-day paper vs baseline validator
**As an** operator **I want** automated check that agents beat baseline net of LLM cost **so that** live gate is enforceable.

**Acceptance criteria**
- Given 90-day paper data, when validator runs, then comparison includes LLM cost deduction; pre-registered effect size noted.
- Given underpowered sample, when detected, then warning surfaced (necessary-but-not-sufficient guard).

**Dependencies** — QN-045. **Points:** 8 · **Phase:** 6 · **Epic:** EP-QN-6
*(BE-122 and BE-101 consume this validator, not the reverse.)*

---

### QN-061 — Signed risk report generator
**As an** operator **I want** a signed PDF/HTML risk report for live promotion **so that** go-live is documented.

**Acceptance criteria**
- Given validation pass + paper track record, when report generated, then includes metrics, config snapshot, disclaimer; hash stored for audit.

**Dependencies** — QN-060. **Points:** 5 · **Phase:** 6 · **Epic:** EP-QN-6

---

### QN-062 — Decision replay from provenance
**As an** auditor **I want** to replay any past decision from stored data **so that** full reconstructability is proven.

**Acceptance criteria**
- Given past signal id, when replay invoked, then deterministically reproduces quant features + agent outputs from stored provenance (LLM cached mode), **including the exact memory context via `retrieved_memory_ids` stored on each `agent_runs` row (BE-064)**.

**Dependencies** — QN-040, BE-130. **Points:** 8 · **Phase:** 6 · **Epic:** EP-QN-6

---

## Definition of Done (applies to every story)

A story is **Done** when all the following are true:

1. Acceptance criteria pass in staging.
2. Unit tests added/updated (pytest); coverage on new code ≥80%.
3. `mypy --strict` passes; `ruff check` and `ruff format` clean.
4. Pydantic models pinned from generated contracts (`app/contracts/`).
5. gRPC/REST endpoints documented; proto changes regenerate TS stubs in CI.
6. No look-ahead tests pass for any feature touching time-series or news.
7. `TRADING_MODE` behaviour verified for backtest/paper/live code paths.
8. PR reviewed; no unresolved comments.
