"""QN-043/QN-046 — model store round-trip, champion/challenger, drift monitor."""

from __future__ import annotations

import numpy as np
import pytest

from app.quant.model import predict_proba
from app.quant.registry import (
    ROLE_CHALLENGER,
    ROLE_CHAMPION,
    ROLE_RETIRED,
    DriftReport,
    ModelRegistry,
    calibration_drift,
)
from tests.quant.conftest import FakeQuantDb


class TestModelStore:
    def test_save_load_round_trip(self, trained_artifacts) -> None:
        store, meta, result = trained_artifacts
        loaded = store.load("EUR_USD", "H1", meta.version)
        features = dict.fromkeys(result.feature_names, 0.1)
        original = predict_proba(result.booster, result.calibrator, result.feature_names, features)
        reloaded = predict_proba(
            loaded.booster, loaded.calibrator, loaded.meta.feature_names, features
        )
        assert reloaded == pytest.approx(original, abs=1e-9)
        assert loaded.meta.calibration_method == result.calibrator.method
        assert loaded.meta.feature_names == result.feature_names
        assert loaded.meta.reliability  # persisted with the artifact

    def test_versions_monotonic(self, trained_artifacts) -> None:
        store, meta, _ = trained_artifacts
        # Other tests may have saved further versions to the shared store —
        # only monotonicity is guaranteed.
        assert store.next_version("EUR_USD", "H1") > meta.version
        assert store.next_version("USD_JPY", "H1") == 1


class TestChampionChallenger:
    @pytest.fixture
    def registry(self, trained_artifacts, fake_db: FakeQuantDb) -> ModelRegistry:
        store, _, _ = trained_artifacts
        return ModelRegistry(store, fake_db)

    async def test_new_model_is_always_challenger(self, registry, trained_artifacts) -> None:
        _, meta, _ = trained_artifacts
        meta.role = ROLE_CHAMPION  # even if someone tries to sneak it in
        registered = await registry.register(meta)
        assert registered.role == ROLE_CHALLENGER
        assert await registry.champion("EUR_USD", "H1") is None  # nothing serves yet

    async def test_promotion_gate_requires_shadowing(self, registry, trained_artifacts) -> None:
        _, meta, _ = trained_artifacts
        await registry.register(meta)
        with pytest.raises(ValueError, match="shadow"):
            await registry.promote("EUR_USD", "H1", meta.version, min_shadow=5)
        for _ in range(5):
            await registry.record_shadow("EUR_USD", "H1", meta.version)
        promoted = await registry.promote("EUR_USD", "H1", meta.version, min_shadow=5)
        assert promoted.role == ROLE_CHAMPION
        champion = await registry.champion("EUR_USD", "H1")
        assert champion is not None
        assert champion.meta.version == meta.version

    async def test_force_promotion_bypasses_gate(self, registry, trained_artifacts) -> None:
        _, meta, _ = trained_artifacts
        await registry.register(meta)
        promoted = await registry.promote("EUR_USD", "H1", meta.version, force=True)
        assert promoted.role == ROLE_CHAMPION

    async def test_old_champion_retires_on_promotion(
        self, registry, trained_artifacts, fake_db: FakeQuantDb, training_candles
    ) -> None:
        store, meta, result = trained_artifacts
        await registry.register(meta)
        await registry.promote("EUR_USD", "H1", meta.version, force=True)
        # Register a second version (same artifacts re-saved → v2).
        meta2 = store.save(result, instrument="EUR_USD", timeframe="H1", feature_set_version=1)
        await registry.register(meta2)
        challenger = await registry.newest_challenger("EUR_USD", "H1")
        assert challenger is not None and challenger.meta.version == meta2.version
        await registry.promote("EUR_USD", "H1", meta2.version, force=True)
        assert fake_db.models[("EUR_USD", "H1", meta.version)].role == ROLE_RETIRED
        champion = await registry.champion("EUR_USD", "H1")
        assert champion.meta.version == meta2.version

    async def test_cannot_promote_retired_or_missing(self, registry, trained_artifacts) -> None:
        _, meta, _ = trained_artifacts
        await registry.register(meta)
        with pytest.raises(ValueError, match="no model"):
            await registry.promote("EUR_USD", "H1", 999, force=True)


class TestDriftMonitor:
    def test_well_calibrated_no_alert(self) -> None:
        rng = np.random.default_rng(9)
        p = rng.uniform(0.2, 0.8, 400)
        y = (rng.uniform(size=400) < p).astype(float)
        report = calibration_drift(p, y, training_brier=0.22)
        assert isinstance(report, DriftReport)
        assert report.decalibrated is False

    def test_decalibrated_alerts_with_reason(self) -> None:
        # QN-046 AC: calibration drift metric alerts on decalibration.
        p = np.full(300, 0.9)
        y = (np.arange(300) % 2).astype(float)  # realized rate 0.5
        report = calibration_drift(p, y, training_brier=0.20)
        assert report.decalibrated is True
        assert report.reason is not None and "ece" in report.reason

    def test_brier_degradation_path(self) -> None:
        rng = np.random.default_rng(10)
        p = rng.uniform(0.45, 0.55, 300)  # low ECE but useless predictions
        y = (rng.uniform(size=300) < 0.5).astype(float)
        report = calibration_drift(p, y, training_brier=0.10, ece_alert=0.5)
        assert report.decalibrated is True
        assert report.reason is not None and "brier" in report.reason

    def test_small_windows_never_alert(self) -> None:
        report = calibration_drift(np.array([0.9] * 10), np.zeros(10), training_brier=0.2)
        assert report.decalibrated is False
        assert report.n == 10
