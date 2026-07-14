"""REST surface for Step 6.3 — QN-062 quant-leg decision replay.

  POST /replay/quant
      Re-run the deterministic pipeline point-in-time at the stored bar
      (side-effect-free: `persist=False` — no baseline row, no features
      upsert, no cluster refresh) and compare against the values the Node
      side stored on the signal at decision time. Called by the Node
      `GET /signals/:id/replay` endpoint, which owns the agent-leg replay
      (agent_runs outputs + retrieved_memory_ids ARE the LLM cache).

Shares the lazily built QuantRuntime with routes_backtest — one process,
one set of connections.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.grpc.servicer import UnavailableError
from app.quant.pipeline import InsufficientDataError
from app.quant.replay import StoredCandidate, build_replay_report
from app.routes_backtest import get_runtime

router = APIRouter()


class ReplayCandidateIn(BaseModel):
    side: str
    probability: float | None = None
    entryPrice: float | None = None
    stopLossPrice: float | None = None
    takeProfitPrice: float | None = None
    modelVersion: str | None = None


class ReplayQuantRequest(BaseModel):
    instrument: str = Field(min_length=1)
    timeframe: str = Field(min_length=1)
    barTs: str  # ISO-8601; parsed below so the error is a clean 422
    features: dict[str, Any] | None = None
    candidate: ReplayCandidateIn | None = None


@router.post("/replay/quant")
async def replay_quant(req: ReplayQuantRequest) -> dict[str, Any]:
    from datetime import datetime

    try:
        bar_ts = datetime.fromisoformat(req.barTs.replace("Z", "+00:00"))
    except ValueError as err:
        raise HTTPException(status_code=422, detail=f"invalid barTs: {req.barTs}") from err

    runtime = get_runtime()
    try:
        pipeline = await runtime.pipeline()
    except UnavailableError as err:
        raise HTTPException(status_code=503, detail=str(err)) from err

    try:
        result = await pipeline.run(req.instrument, req.timeframe, bar_ts, persist=False)
    except InsufficientDataError as err:
        raise HTTPException(status_code=422, detail=str(err)) from err

    stored_candidate = (
        StoredCandidate(
            side=req.candidate.side,
            probability=req.candidate.probability,
            entry_price=req.candidate.entryPrice,
            stop_loss_price=req.candidate.stopLossPrice,
            take_profit_price=req.candidate.takeProfitPrice,
            model_version=req.candidate.modelVersion,
        )
        if req.candidate is not None
        else None
    )
    report = build_replay_report(
        stored_features=req.features,
        stored_candidate=stored_candidate,
        result=result,
    )
    return {
        **report.as_dict(),
        "replayed": {
            "instrument": result.instrument,
            "timeframe": result.timeframe,
            "barTs": result.bar_ts.isoformat(),
            "sessionLabel": result.session_label,
            "liquidityRegime": str(result.liquidity_regime),
            "trendRegime": str(result.regime.label),
            "regimeEntropy": result.regime.entropy,
            "hasCandidate": result.candidate is not None,
        },
    }
