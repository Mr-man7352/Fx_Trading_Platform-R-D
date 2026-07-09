"""QuantService servicer — Step 2.3 (QN-040…048), replacing the QN-004 stubs.

RunPipeline: features → regime → baseline (persisted) → candidate + calibrated
P(profitable). SizePosition: QN-042/044 deterministic sizing. Predict:
champion meta-model scoring (QN-043).

Error mapping (the Node circuit breaker BE-068 treats ANY non-OK as HOLD):
  FAILED_PRECONDITION — no DATABASE_URL, not enough history, no champion model
  INVALID_ARGUMENT    — malformed request fields
  INTERNAL            — unexpected faults (logged, never silent)
"""

from __future__ import annotations

import logging
import math
from datetime import UTC, datetime
from typing import Any

import grpc
from google.protobuf import timestamp_pb2

from app.config import get_settings
from app.proto_gen import quant_pb2, quant_pb2_grpc
from app.quant.clusters import ClusterParams
from app.quant.features import FEATURE_SET_VERSION
from app.quant.labels import LabelParams
from app.quant.model import predict_proba
from app.quant.pipeline import InsufficientDataError, QuantPipeline
from app.quant.registry import ModelRegistry, ModelStore
from app.quant.sizing import SizingConfig, size_position

log = logging.getLogger("fx.quant.grpc")

_TIMEFRAMES = {
    quant_pb2.TIMEFRAME_M1: "M1",
    quant_pb2.TIMEFRAME_M5: "M5",
    quant_pb2.TIMEFRAME_M15: "M15",
    quant_pb2.TIMEFRAME_M30: "M30",
    quant_pb2.TIMEFRAME_H1: "H1",
    quant_pb2.TIMEFRAME_H4: "H4",
    quant_pb2.TIMEFRAME_D1: "D1",
}

_SIDE_TO_PROTO = {"long": quant_pb2.TRADE_SIDE_LONG, "short": quant_pb2.TRADE_SIDE_SHORT}


class UnavailableError(Exception):
    """Service not configured for this RPC (→ FAILED_PRECONDITION)."""


def _bar_ts(ts: timestamp_pb2.Timestamp) -> datetime:
    return ts.ToDatetime(tzinfo=UTC)


class QuantRuntime:
    """Lazily built, cached DB/registry/pipeline (process lifetime — mirrors
    the execution factory's adapter caching). Tests inject fakes via `db`."""

    def __init__(self, db: Any = None) -> None:
        self._db = db
        self._pool: Any = None
        self._registry: ModelRegistry | None = None
        self._pipeline: QuantPipeline | None = None

    async def db(self) -> Any:
        if self._db is None:
            from app.market.dbio import create_pool
            from app.quant.dbio import QuantDb

            settings = get_settings()
            if not settings.database_url:
                raise UnavailableError("DATABASE_URL not configured on the quant service")
            self._pool = await create_pool(settings.database_url)
            self._db = QuantDb(self._pool)
        return self._db

    async def registry(self) -> ModelRegistry:
        if self._registry is None:
            settings = get_settings()
            self._registry = ModelRegistry(ModelStore(settings.model_dir), await self.db())
        return self._registry

    async def pipeline(self) -> QuantPipeline:
        if self._pipeline is None:
            settings = get_settings()
            self._pipeline = QuantPipeline(
                await self.db(),
                await self.registry(),
                lookback_bars=settings.pipeline_lookback_bars,
                label_params=LabelParams(
                    horizon=settings.label_horizon_bars, rr=settings.min_rr
                ),
                cluster_params=ClusterParams(
                    lookback_days=settings.corr_lookback_days,
                    threshold=settings.corr_threshold,
                    refresh_days=settings.corr_refresh_days,
                    event_lookback_days=settings.corr_event_lookback_days,
                    vol_spike_mult=settings.corr_vol_spike_mult,
                ),
                cluster_instruments=settings.instruments,
            )
        return self._pipeline


class QuantServicer(quant_pb2_grpc.QuantServiceServicer):
    """Step 2.3 deterministic quant core behind the QN-004 seam."""

    def __init__(self, runtime: QuantRuntime | None = None) -> None:
        self._runtime = runtime or QuantRuntime()

    async def RunPipeline(
        self,
        request: quant_pb2.RunPipelineRequest,
        context: grpc.aio.ServicerContext,
    ) -> quant_pb2.RunPipelineResponse:
        timeframe = _TIMEFRAMES.get(request.timeframe)
        if not request.instrument or timeframe is None:
            await context.abort(
                grpc.StatusCode.INVALID_ARGUMENT, "instrument and timeframe are required"
            )
        assert timeframe is not None  # abort() raised — narrowing for mypy
        try:
            pipeline = await self._runtime.pipeline()
            result = await pipeline.run(request.instrument, timeframe, _bar_ts(request.bar_ts))
        except (UnavailableError, InsufficientDataError) as exc:
            await context.abort(grpc.StatusCode.FAILED_PRECONDITION, str(exc))
        except grpc.aio.AbortError:
            raise
        except Exception:
            log.exception("RunPipeline failed instrument=%s", request.instrument)
            await context.abort(grpc.StatusCode.INTERNAL, "pipeline failure")

        response = quant_pb2.RunPipelineResponse(
            features=result.features,
            has_candidate=result.candidate is not None,
            session_label=result.session_label,
            liquidity_regime=str(result.liquidity_regime),
            trend_regime=str(result.regime.label),
            regime_entropy=result.regime.entropy,
            debate_rounds=result.regime.debate_rounds,
            feature_set_version=FEATURE_SET_VERSION,
        )
        if result.challenger_probability is not None:
            response.challenger_probability = result.challenger_probability
        if result.candidate is not None:
            c = result.candidate
            response.candidate.CopyFrom(
                quant_pb2.Candidate(
                    instrument=c.instrument,
                    side=_SIDE_TO_PROTO[c.side],
                    probability=c.probability,
                    regime=f"{result.regime.label}/{result.liquidity_regime}",
                    model_version=c.model_version,
                    entry_price=c.entry_price,
                    stop_loss_price=c.stop_loss_price,
                    take_profit_price=c.take_profit_price,
                )
            )
        return response

    async def SizePosition(
        self,
        request: quant_pb2.SizePositionRequest,
        context: grpc.aio.ServicerContext,
    ) -> quant_pb2.SizePositionResponse:
        settings = get_settings()
        if request.account_equity <= 0 or request.entry_price <= 0:
            await context.abort(
                grpc.StatusCode.INVALID_ARGUMENT, "account_equity and entry_price must be > 0"
            )
        if request.stop_loss_price == request.entry_price:
            await context.abort(
                grpc.StatusCode.INVALID_ARGUMENT, "stop_loss_price must differ from entry_price"
            )
        try:
            db = await self._runtime.db()
            closes = await db.latest_closes()
            atr = await self._latest_atr(db, request.instrument)
        except UnavailableError as exc:
            await context.abort(grpc.StatusCode.FAILED_PRECONDITION, str(exc))
        except grpc.aio.AbortError:
            raise
        except Exception:
            log.exception("SizePosition failed instrument=%s", request.instrument)
            await context.abort(grpc.StatusCode.INTERNAL, "sizing failure")

        from app.execution.sizing import FixedRates

        config = SizingConfig(
            account_currency=settings.account_currency,
            risk_per_trade_pct=settings.risk_per_trade_pct,
            vol_risk_pct=settings.vol_risk_pct,
            kelly_fraction=settings.kelly_fraction,
            prob_sizing_enabled=settings.prob_sizing_enabled,
            min_rr=settings.min_rr,
        )
        try:
            decision = size_position(
                instrument=request.instrument,
                entry_price=request.entry_price,
                stop_loss_price=request.stop_loss_price,
                account_equity=request.account_equity,
                rates=FixedRates(closes),
                config=config,
                atr=atr,
                probability=request.probability if 0 < request.probability < 1 else None,
            )
        except (KeyError, ValueError) as exc:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(exc))
        return quant_pb2.SizePositionResponse(
            units=decision.units,
            calibrated_probability=request.probability,
            target_volatility=decision.target_vol_pct,
            sizing_model_version=decision.model_version,
            risk_amount=decision.risk_amount,
            caps_applied=decision.caps_applied,
            prob_scale=decision.prob_scale,
        )

    async def Predict(
        self,
        request: quant_pb2.PredictRequest,
        context: grpc.aio.ServicerContext,
    ) -> quant_pb2.PredictResponse:
        timeframe = _TIMEFRAMES.get(request.timeframe)
        if not request.instrument or timeframe is None:
            await context.abort(
                grpc.StatusCode.INVALID_ARGUMENT, "instrument and timeframe are required"
            )
        if not request.features:
            await context.abort(
                grpc.StatusCode.INVALID_ARGUMENT,
                "Predict requires a precomputed feature map (RunPipeline computes one)",
            )
        assert timeframe is not None  # abort() raised — narrowing for mypy
        try:
            registry = await self._runtime.registry()
            champion = await registry.champion(request.instrument, timeframe)
        except UnavailableError as exc:
            await context.abort(grpc.StatusCode.FAILED_PRECONDITION, str(exc))
        except grpc.aio.AbortError:
            raise
        except Exception:
            log.exception("Predict failed instrument=%s", request.instrument)
            await context.abort(grpc.StatusCode.INTERNAL, "predict failure")
        if champion is None:
            await context.abort(
                grpc.StatusCode.FAILED_PRECONDITION,
                f"no champion model for {request.instrument}/{timeframe} — "
                "train + promote first (python -m app.quant train / promote)",
            )
        assert champion is not None  # abort() raised — narrowing for mypy
        p = predict_proba(
            champion.booster,
            champion.calibrator,
            champion.meta.feature_names,
            dict(request.features),
        )
        trained = timestamp_pb2.Timestamp()
        trained.FromDatetime(champion.meta.trained_at.astimezone(UTC))
        return quant_pb2.PredictResponse(
            probability=p,
            calibration_method=champion.meta.calibration_method,
            model_version=f"v{champion.meta.version}",
            trained_at=trained,
        )

    @staticmethod
    async def _latest_atr(db: Any, instrument: str) -> float | None:
        """ATR(14) from the latest H1 candles — the vol-target input (QN-042)."""
        import talib

        candles = await db.fetch_candles(instrument, "H1", datetime.now(UTC), 100)
        if len(candles) < 20:
            return None
        atr = talib.ATR(
            candles["high"].to_numpy(dtype="float64"),
            candles["low"].to_numpy(dtype="float64"),
            candles["close"].to_numpy(dtype="float64"),
            timeperiod=14,
        )
        last = float(atr[-1])
        return last if math.isfinite(last) and last > 0 else None
