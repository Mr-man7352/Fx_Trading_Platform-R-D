"""Step 2.3 — end-to-end pipeline over faithful fakes (no DB, no gRPC).

Covers: HOLD path without a champion, candidate path with a promoted model,
challenger shadow scoring, persistence of features + baseline on every run,
insufficient-data handling, and the cluster-refresh hook.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from app.quant.pipeline import InsufficientDataError, QuantPipeline
from app.quant.registry import ModelRegistry
from tests.quant.conftest import FakeQuantDb, make_candles

INSTRUMENT = "EUR_USD"


def _pipeline(fake_db: FakeQuantDb, store, **kwargs) -> QuantPipeline:
    return QuantPipeline(fake_db, ModelRegistry(store, fake_db), **kwargs)


@pytest.fixture
def trending_db(fake_db: FakeQuantDb) -> FakeQuantDb:
    # Strong uptrend so the baseline candidate gate fires on the last bar.
    fake_db.candles[(INSTRUMENT, "H1")] = make_candles(600, drift=0.003, vol=0.001, seed=23)
    return fake_db


def _last_bar(db: FakeQuantDb):
    return db.candles[(INSTRUMENT, "H1")]["ts"].iloc[-1].to_pydatetime()


class TestHoldPath:
    async def test_no_champion_means_no_candidate_but_everything_persists(
        self, trending_db: FakeQuantDb, trained_artifacts
    ) -> None:
        store, _, _ = trained_artifacts
        pipeline = _pipeline(trending_db, store)
        result = await pipeline.run(INSTRUMENT, "H1", _last_bar(trending_db))
        assert result.candidate is None  # ADR-010: deterministic HOLD
        assert len(trending_db.baselines) == 1  # QN-045: always logged
        assert trending_db.baselines[0].would_trade is True
        assert len(trending_db.features_rows) == 1
        row = trending_db.features_rows[0]
        assert row["session_label"] in {"TOKYO", "LONDON", "NEW_YORK", "OVERLAP", "OFF_HOURS"}
        assert row["liquidity_regime"] in {"HIGH", "NORMAL", "LOW"}
        assert "rsi_14" in row["features"]
        assert result.regime.debate_rounds in (0, 1, 2)

    async def test_insufficient_history_raises(
        self, fake_db: FakeQuantDb, trained_artifacts
    ) -> None:
        store, _, _ = trained_artifacts
        fake_db.candles[(INSTRUMENT, "H1")] = make_candles(50, seed=1)
        pipeline = _pipeline(fake_db, store)
        with pytest.raises(InsufficientDataError):
            await pipeline.run(INSTRUMENT, "H1", _last_bar(fake_db))


class TestCandidatePath:
    @pytest.fixture
    async def with_champion(self, trending_db: FakeQuantDb, trained_artifacts):
        store, meta, _ = trained_artifacts
        registry = ModelRegistry(store, trending_db)
        await registry.register(meta)
        await registry.promote(INSTRUMENT, "H1", meta.version, force=True)
        return _pipeline(trending_db, store), trending_db

    async def test_candidate_with_calibrated_probability_and_zones(self, with_champion) -> None:
        pipeline, db = with_champion
        result = await pipeline.run(INSTRUMENT, "H1", _last_bar(db))
        assert result.candidate is not None
        c = result.candidate
        assert c.side == "long"
        assert 0.0 < c.probability < 1.0
        assert c.model_version == "v1"
        # Bracket = the exact geometry the labels trained on (1×ATR / rr×ATR).
        atr = result.features["atr_14"]
        assert c.stop_loss_price == pytest.approx(c.entry_price - atr, rel=1e-9)
        assert c.take_profit_price == pytest.approx(c.entry_price + 1.8 * atr, rel=1e-6)

    async def test_challenger_shadow_scored_and_counted(
        self, trending_db: FakeQuantDb, trained_artifacts
    ) -> None:
        store, meta, result_art = trained_artifacts
        registry = ModelRegistry(store, trending_db)
        await registry.register(meta)
        await registry.promote(INSTRUMENT, "H1", meta.version, force=True)
        meta2 = store.save(  # second version → newest challenger
            result_art, instrument=INSTRUMENT, timeframe="H1", feature_set_version=1
        )
        await registry.register(meta2)
        pipeline = _pipeline(trending_db, store)
        result = await pipeline.run(INSTRUMENT, "H1", _last_bar(trending_db))
        assert result.candidate is not None  # champion still serves
        assert result.challenger_probability is not None  # QN-046 shadow
        assert trending_db.models[(INSTRUMENT, "H1", meta2.version)].shadow_count == 1
        assert trending_db.models[(INSTRUMENT, "H1", meta.version)].shadow_count == 0


class TestClusterHook:
    async def test_bootstrap_refresh_on_first_run(
        self, trending_db: FakeQuantDb, trained_artifacts
    ) -> None:
        store, _, _ = trained_artifacts
        for inst, seed in (("EUR_USD", 31), ("GBP_USD", 32), ("USD_JPY", 33)):
            trending_db.candles[(inst, "D1")] = make_candles(
                80, drift=0.0, vol=0.006, seed=seed, freq_hours=24
            )
        pipeline = _pipeline(
            trending_db, store, cluster_instruments=["EUR_USD", "GBP_USD", "USD_JPY"]
        )
        result = await pipeline.run(INSTRUMENT, "H1", _last_bar(trending_db))
        assert result.meta.get("clusters_refreshed") == "bootstrap"
        assert len(trending_db.cluster_sets) == 1
        assert trending_db.cluster_sets[0].version == 1

    async def test_no_refresh_when_fresh_and_quiet(
        self, trending_db: FakeQuantDb, trained_artifacts
    ) -> None:
        store, _, _ = trained_artifacts
        for inst, seed in (("EUR_USD", 31), ("GBP_USD", 32)):
            trending_db.candles[(inst, "D1")] = make_candles(
                80, vol=0.006, seed=seed, freq_hours=24
            )
        pipeline = _pipeline(trending_db, store, cluster_instruments=["EUR_USD", "GBP_USD"])
        bar = _last_bar(trending_db)
        await pipeline.run(INSTRUMENT, "H1", bar)
        assert len(trending_db.cluster_sets) == 1
        # An hour later, same liquidity, no spike, weekly not due → no new set.
        trending_db.candles[(INSTRUMENT, "H1")] = make_candles(
            601, drift=0.003, vol=0.001, seed=23
        )
        await pipeline.run(INSTRUMENT, "H1", bar + timedelta(hours=1))
        assert len(trending_db.cluster_sets) == 1
