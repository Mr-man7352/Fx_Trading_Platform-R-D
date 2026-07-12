"""Step 4.2 — backtest orchestration behind the REST surface (BE-090 calls it).

Loads point-in-time frames from TimescaleDB (QuantDb), loads the champion
meta-model from the registry, runs the QN-050 engine (+ QN-053 validation,
+ optional QN-054 ablations) and returns one JSON-able report. The engine
itself stays I/O-free; everything DB-shaped lives here.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.backtest.ablation import run_ablations
from app.backtest.engine import BacktestEngine, BacktestParams, champion_proba_fn
from app.backtest.validation import ValidationCriteria, validate_backtest
from app.quant.labels import LabelParams
from app.quant.registry import ModelRegistry

log = logging.getLogger("fx.backtest.service")


class BacktestRequest(BaseModel):
    """POST /backtest/run — mirrors @fx/types BacktestConfigSchema."""

    instrument: str = Field(pattern=r"^[A-Z0-9]{3,6}_[A-Z0-9]{3,6}$")
    timeframe: Literal["M5", "M15", "M30", "H1", "H4", "D1"] = "H1"
    from_ts: datetime = Field(alias="from")
    to_ts: datetime = Field(alias="to")
    probability_threshold: float = Field(default=0.60, gt=0, lt=1)
    risk_pct: float = Field(default=0.01, gt=0, lt=1)
    initial_equity: float = Field(default=10_000, gt=0)
    run_validation: bool = True
    run_ablations: bool = False
    # Merged into the QN-054 report when the Node runner already produced them.
    agentic_results: dict[str, Any] | None = None

    model_config = {"populate_by_name": True}


async def run_backtest_request(db: Any, registry: ModelRegistry, req: BacktestRequest) -> dict[str, Any]:
    """Load PIT frames + champion, run engine / validation / ablations."""
    # Enough lookback for warmup (60) + a healthy margin, bounded by window.
    span_hours = max((req.to_ts - req.from_ts).total_seconds() / 3600.0, 1.0)
    approx_bars = int(span_hours) + 500 if req.timeframe == "H1" else int(span_hours * 12) + 500
    candles = await db.fetch_candles(req.instrument, req.timeframe, req.to_ts, approx_bars)
    if candles.empty or len(candles) < 120:
        raise ValueError(
            f"not enough candles for {req.instrument}/{req.timeframe} up to {req.to_ts} "
            f"(got {len(candles)}) — run the QN-021 backfill first"
        )
    candles = candles[candles["ts"] >= req.from_ts.replace(tzinfo=candles["ts"].iloc[0].tzinfo)]
    spreads = await db.fetch_spreads(req.instrument, req.to_ts, limit=50_000)
    macro = await db.fetch_macro(req.to_ts)
    sentiment = await db.fetch_sentiment(req.instrument, req.to_ts, lookback_hours=int(span_hours) + 96)

    champion = await registry.champion(req.instrument, req.timeframe)
    if champion is None:
        raise LookupError(
            f"no champion model for {req.instrument}/{req.timeframe} — train + promote first "
            "(PHASE2_TESTING_GUIDE §E); backtests without a champion are meaningless"
        )
    proba_fn = champion_proba_fn(
        champion.booster, champion.calibrator, champion.meta.feature_names
    )

    lp = champion.meta.label_params or {}
    params = BacktestParams(
        instrument=req.instrument,
        timeframe=req.timeframe,
        probability_threshold=req.probability_threshold,
        label_params=LabelParams(
            horizon=int(lp.get("horizon", 24)),
            atr_stop_mult=float(lp.get("atr_stop_mult", 1.0)),
            rr=float(lp.get("rr", 1.8)),
        ),
        risk_pct=req.risk_pct,
        initial_equity=req.initial_equity,
    )
    engine = BacktestEngine(
        candles, params=params, proba_fn=proba_fn, macro=macro, sentiment=sentiment, spreads=spreads
    )
    report = engine.run()
    report["model"] = {
        "instrument": champion.meta.instrument,
        "timeframe": champion.meta.timeframe,
        "version": champion.meta.version,
        "trained_at": champion.meta.trained_at.isoformat(),
        "metrics": champion.meta.metrics,
    }

    if req.run_validation:
        rs = [t["r_multiple"] for t in report["trades"]]
        report["validation"] = validate_backtest(
            rs, n_trials=len(report["threshold_sweep"]), criteria=ValidationCriteria()
        )

    if req.run_ablations:
        report["ablation"] = run_ablations(
            candles,
            params=params,
            proba_fn=proba_fn,
            macro=macro,
            sentiment=sentiment,
            spreads=spreads,
            agentic_results=req.agentic_results,
        )
    elif req.agentic_results:
        report["ablation"] = {"agentic": req.agentic_results}

    log.info(
        "backtest done instrument=%s trades=%s verdict=%s",
        req.instrument,
        report["metrics"]["n_trades"],
        report.get("validation", {}).get("verdict", "n/a"),
    )
    return report
