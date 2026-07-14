"""Step 2.3 — QuantService servicer over the fake DB (behavioural coverage).

The scaffold-level error mapping (no DATABASE_URL etc.) lives in
tests/test_grpc.py against a real running server; here the servicer methods
are driven directly with an injected runtime + fake context.
"""

from __future__ import annotations

from datetime import UTC, datetime

import grpc
import pytest
from google.protobuf import timestamp_pb2

from app.grpc.servicer import QuantRuntime, QuantServicer
from app.proto_gen import quant_pb2
from app.quant.registry import ModelRegistry
from tests.quant.conftest import FakeQuantDb, make_candles

INSTRUMENT = "EUR_USD"


class FakeContext:
    """Records the abort code/details; raises like the real aio context."""

    def __init__(self) -> None:
        self.code: grpc.StatusCode | None = None
        self.details: str | None = None

    async def abort(self, code: grpc.StatusCode, details: str = "") -> None:
        self.code = code
        self.details = details
        raise grpc.aio.AbortError()


def _ts(dt: datetime) -> timestamp_pb2.Timestamp:
    t = timestamp_pb2.Timestamp()
    t.FromDatetime(dt.astimezone(UTC))
    return t


@pytest.fixture
def trending_db(fake_db: FakeQuantDb) -> FakeQuantDb:
    fake_db.candles[(INSTRUMENT, "H1")] = make_candles(600, drift=0.003, vol=0.001, seed=23)
    return fake_db


@pytest.fixture
def servicer(trending_db: FakeQuantDb, trained_artifacts, monkeypatch: pytest.MonkeyPatch):
    store, _, _ = trained_artifacts
    monkeypatch.setenv("MODEL_DIR", str(store._dir))
    from app.config import get_settings

    get_settings.cache_clear()
    return QuantServicer(QuantRuntime(db=trending_db))


def _last_bar(db: FakeQuantDb) -> datetime:
    return db.candles[(INSTRUMENT, "H1")]["ts"].iloc[-1].to_pydatetime()


class TestRunPipeline:
    async def test_hold_without_champion_still_returns_context(
        self, servicer: QuantServicer, trending_db: FakeQuantDb
    ) -> None:
        request = quant_pb2.RunPipelineRequest(
            instrument=INSTRUMENT,
            timeframe=quant_pb2.TIMEFRAME_H1,
            bar_ts=_ts(_last_bar(trending_db)),
        )
        response = await servicer.RunPipeline(request, FakeContext())
        assert response.has_candidate is False
        assert response.session_label in {"TOKYO", "LONDON", "NEW_YORK", "OVERLAP", "OFF_HOURS"}
        assert response.liquidity_regime in {"HIGH", "NORMAL", "LOW"}
        assert response.trend_regime in {"TREND_UP", "TREND_DOWN", "RANGE"}
        assert response.debate_rounds in (0, 1, 2)
        assert response.feature_set_version == 1
        assert "rsi_14" in response.features
        assert len(trending_db.baselines) == 1  # persisted through the RPC

    async def test_candidate_with_champion(
        self, servicer: QuantServicer, trending_db: FakeQuantDb, trained_artifacts
    ) -> None:
        store, meta, _ = trained_artifacts
        registry = ModelRegistry(store, trending_db)
        await registry.register(meta)
        await registry.promote(INSTRUMENT, "H1", meta.version, force=True)
        request = quant_pb2.RunPipelineRequest(
            instrument=INSTRUMENT,
            timeframe=quant_pb2.TIMEFRAME_H1,
            bar_ts=_ts(_last_bar(trending_db)),
        )
        response = await servicer.RunPipeline(request, FakeContext())
        assert response.has_candidate is True
        c = response.candidate
        assert c.side == quant_pb2.TRADE_SIDE_LONG
        assert 0.0 < c.probability < 1.0
        assert c.stop_loss_price < c.entry_price < c.take_profit_price
        assert c.model_version == "v1"
        assert "/" in c.regime  # "TREND_X/LIQUIDITY" combined label

    async def test_invalid_arguments(self, servicer: QuantServicer) -> None:
        ctx = FakeContext()
        with pytest.raises(grpc.aio.AbortError):
            await servicer.RunPipeline(quant_pb2.RunPipelineRequest(), ctx)
        assert ctx.code == grpc.StatusCode.INVALID_ARGUMENT

    async def test_insufficient_history_maps_to_failed_precondition(
        self, servicer: QuantServicer, trending_db: FakeQuantDb
    ) -> None:
        trending_db.candles[(INSTRUMENT, "H1")] = make_candles(40, seed=2)
        ctx = FakeContext()
        request = quant_pb2.RunPipelineRequest(
            instrument=INSTRUMENT,
            timeframe=quant_pb2.TIMEFRAME_H1,
            bar_ts=_ts(_last_bar(trending_db)),
        )
        with pytest.raises(grpc.aio.AbortError):
            await servicer.RunPipeline(request, ctx)
        assert ctx.code == grpc.StatusCode.FAILED_PRECONDITION


class TestSizePosition:
    async def test_sizes_with_db_rates_and_atr(
        self, servicer: QuantServicer, trending_db: FakeQuantDb
    ) -> None:
        trending_db.candles[("GBP_USD", "M1")] = make_candles(10, seed=3, price0=1.25, freq_hours=1)
        trending_db.candles[(INSTRUMENT, "M1")] = make_candles(10, seed=4, price0=1.10)
        request = quant_pb2.SizePositionRequest(
            instrument=INSTRUMENT,
            side=quant_pb2.TRADE_SIDE_LONG,
            probability=0.65,
            account_equity=10_000.0,
            entry_price=1.10,
            stop_loss_price=1.0950,
        )
        response = await servicer.SizePosition(request, FakeContext())
        assert response.units > 0
        assert response.units == int(response.units)  # whole units
        assert response.risk_amount > 0
        assert response.sizing_model_version == "qn042-v1"
        assert response.prob_scale == 1.0  # flag defaults off

    async def test_rejects_zero_equity(self, servicer: QuantServicer) -> None:
        ctx = FakeContext()
        with pytest.raises(grpc.aio.AbortError):
            await servicer.SizePosition(quant_pb2.SizePositionRequest(instrument=INSTRUMENT), ctx)
        assert ctx.code == grpc.StatusCode.INVALID_ARGUMENT


class TestPredict:
    async def test_no_champion_is_failed_precondition(self, servicer: QuantServicer) -> None:
        ctx = FakeContext()
        request = quant_pb2.PredictRequest(
            instrument=INSTRUMENT,
            timeframe=quant_pb2.TIMEFRAME_H1,
            features={"rsi_14": 55.0},
        )
        with pytest.raises(grpc.aio.AbortError):
            await servicer.Predict(request, ctx)
        assert ctx.code == grpc.StatusCode.FAILED_PRECONDITION
        assert "champion" in (ctx.details or "")

    async def test_scores_with_champion(
        self, servicer: QuantServicer, trending_db: FakeQuantDb, trained_artifacts
    ) -> None:
        store, meta, _ = trained_artifacts
        registry = ModelRegistry(store, trending_db)
        await registry.register(meta)
        await registry.promote(INSTRUMENT, "H1", meta.version, force=True)
        request = quant_pb2.PredictRequest(
            instrument=INSTRUMENT,
            timeframe=quant_pb2.TIMEFRAME_H1,
            features={"ret_1": 0.001, "cand_side": 1.0},
        )
        response = await servicer.Predict(request, FakeContext())
        assert 0.0 < response.probability < 1.0
        assert response.calibration_method in ("isotonic", "platt")
        assert response.model_version == "v1"
        assert response.trained_at.seconds > 0
