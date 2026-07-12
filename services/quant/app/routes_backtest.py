"""REST surface for Step 4.2 — backtests (QN-050 trigger) + analytics (QN-055).

  POST /backtest/run
      Synchronous vectorised backtest (BE-090's worker owns queuing/status —
      this endpoint just computes). Returns the full QN-050 report incl.
      validation verdict (QN-053) and optional ablations (QN-054).

  GET /models/{instrument}/{timeframe}/{version}/calibration   (QN-055)
      Reliability-curve points + training metrics from the model artifact.

  GET /regime/{instrument}?timeframe=H1&bars=500                (QN-055)
      HMM regime timeline over the trailing window (label per bar + entropy).

Shares the lazily built QuantRuntime (DB pool + registry) with the gRPC
servicer — one process, one set of connections.
"""

from __future__ import annotations

import logging
import math
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.backtest.service import BacktestRequest, run_backtest_request
from app.grpc.servicer import QuantRuntime, UnavailableError
from app.quant.pipeline import MIN_BARS
from app.quant.regime import detect_trend_regime

log = logging.getLogger("fx.backtest.routes")

router = APIRouter()

# Shared lazily built runtime (tests swap it via set_runtime).
_runtime: QuantRuntime | None = None


def get_runtime() -> QuantRuntime:
    global _runtime  # noqa: PLW0603 — process-lifetime cache, mirrors servicer
    if _runtime is None:
        _runtime = QuantRuntime()
    return _runtime


def set_runtime(runtime: QuantRuntime | None) -> None:
    """Test seam."""
    global _runtime  # noqa: PLW0603
    _runtime = runtime


@router.post("/backtest/run")
async def run_backtest(req: BacktestRequest) -> dict[str, Any]:
    runtime = get_runtime()
    try:
        db = await runtime.db()
        registry = await runtime.registry()
        return await run_backtest_request(db, registry, req)
    except UnavailableError as err:
        raise HTTPException(status_code=503, detail=str(err)) from err
    except LookupError as err:
        raise HTTPException(status_code=409, detail=str(err)) from err
    except ValueError as err:
        raise HTTPException(status_code=422, detail=str(err)) from err


@router.get("/models/{instrument}/{timeframe}/{version}/calibration")
async def model_calibration(instrument: str, timeframe: str, version: int) -> dict[str, Any]:
    """QN-055 AC: calibration curve points for the model."""
    runtime = get_runtime()
    try:
        registry = await runtime.registry()
    except UnavailableError as err:
        raise HTTPException(status_code=503, detail=str(err)) from err
    models = await (await runtime.db()).list_models(instrument, timeframe)
    target = next((m for m in models if m.version == version), None)
    if target is None:
        raise HTTPException(404, f"no model v{version} for {instrument}/{timeframe}")
    # Reliability curve lives in the artifact metadata (registry store).
    loaded = registry._store.load(instrument, timeframe, version)  # noqa: SLF001 — read-only artifact access
    return {
        "instrument": instrument,
        "timeframe": timeframe,
        "version": version,
        "role": target.role,
        "calibration_method": loaded.meta.calibration_method,
        "curve": loaded.meta.reliability,
        "metrics": loaded.meta.metrics,
        "trained_at": loaded.meta.trained_at.isoformat(),
    }


@router.get("/regime/{instrument}")
async def regime_timeline(
    instrument: str,
    timeframe: str = Query(default="H1"),
    bars: int = Query(default=500, ge=MIN_BARS, le=5000),
) -> dict[str, Any]:
    """QN-055 AC: regime timeline for the instrument."""
    import numpy as np  # noqa: PLC0415
    from datetime import UTC, datetime  # noqa: PLC0415

    runtime = get_runtime()
    try:
        db = await runtime.db()
    except UnavailableError as err:
        raise HTTPException(status_code=503, detail=str(err)) from err
    candles = await db.fetch_candles(instrument, timeframe, datetime.now(UTC), bars)
    if len(candles) < MIN_BARS:
        raise HTTPException(
            422, f"{instrument}/{timeframe}: {len(candles)} bars < {MIN_BARS} required"
        )
    returns = np.log(candles["close"]).diff()
    import pandas as pd  # noqa: PLC0415

    result = detect_trend_regime(pd.Series(returns), seed=7)
    ts = candles["ts"].tolist()
    timeline = [
        {"ts": t.isoformat(), "regime": str(label)}
        for t, label in zip(ts, result.timeline, strict=True)
    ]
    return {
        "instrument": instrument,
        "timeframe": timeframe,
        "current": str(result.label),
        "entropy": result.entropy if math.isfinite(result.entropy) else None,
        "debate_rounds": result.debate_rounds,
        "timeline": timeline,
    }
