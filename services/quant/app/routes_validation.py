"""REST surface for Step 6.1 — QN-060 paper-window validation.

  POST /paper-validation/run
      Judge the trailing paper window against the shadow baseline (net of LLM
      cost, §9.4 downgraded-bar policy) and append the verdict row to
      `paper_validation_runs` — the record BE-101's live-promotion checklist
      and BE-122's gate read. Synchronous (seconds, not minutes): reads are a
      few window-bounded aggregates plus one candle frame per instrument/tf.

  GET /paper-validation/latest
      The authoritative (latest) verdict row, or 404 before any run exists.

Shares the lazily built QuantRuntime with routes_backtest/the gRPC servicer —
one process, one set of connections.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.grpc.servicer import UnavailableError
from app.quant.paper_validation import PaperValidationParams, run_paper_validation
from app.routes_backtest import get_runtime

router = APIRouter()


class PaperValidationRequest(BaseModel):
    """Pre-registered analysis plan — defaults are THE registered plan; only
    override deliberately (the overrides are persisted in the metrics row)."""

    window_days: int = Field(default=90, ge=7, le=365)
    effect_size_r: float = Field(default=0.10, gt=0, le=2.0)
    alpha: float = Field(default=0.05, gt=0, lt=0.5)
    power: float = Field(default=0.80, ge=0.5, lt=1.0)
    downgraded_tolerance: float = Field(default=0.10, ge=0, le=1.0)
    persist: bool = True


@router.post("/paper-validation/run")
async def run_validation(req: PaperValidationRequest) -> dict[str, Any]:
    runtime = get_runtime()
    try:
        db = await runtime.db()
    except UnavailableError as err:
        raise HTTPException(status_code=503, detail=str(err)) from err
    params = PaperValidationParams(
        window_days=req.window_days,
        effect_size_r=req.effect_size_r,
        alpha=req.alpha,
        power=req.power,
        downgraded_tolerance=req.downgraded_tolerance,
    )
    result = await run_paper_validation(db, params=params, persist=req.persist)
    return {
        "windowStart": result.window_start.isoformat(),
        "windowEnd": result.window_end.isoformat(),
        "verdict": result.verdict,
        "underpowered": result.underpowered,
        "downgradedShare": result.downgraded_share,
        "effectSizeR": result.effect_size_r,
        "metrics": result.metrics,
        "warnings": result.warnings,
        "persisted": req.persist,
    }


@router.get("/paper-validation/latest")
async def latest_validation() -> dict[str, Any]:
    runtime = get_runtime()
    try:
        db = await runtime.db()
    except UnavailableError as err:
        raise HTTPException(status_code=503, detail=str(err)) from err
    # runtime.db() is typed Any (lazy seam) — pin the shape for mypy --strict.
    latest: dict[str, Any] | None = await db.latest_paper_validation()
    if latest is None:
        raise HTTPException(status_code=404, detail="no paper-validation run recorded yet")
    return latest
