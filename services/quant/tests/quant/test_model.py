"""QN-043 — walk-forward training, calibration, reliability, no-future-data."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.quant.model import (
    Calibrator,
    expected_calibration_error,
    fit_calibrator,
    predict_proba,
    reliability_curve,
    walk_forward_train,
)
from tests.quant.conftest import FAST_LGBM


@pytest.fixture(scope="module")
def learnable():
    """Synthetic dataset with real signal: y depends on x1 (+ noise)."""
    rng = np.random.default_rng(21)
    n = 1500
    x = pd.DataFrame(
        {
            "x1": rng.standard_normal(n),
            "x2": rng.standard_normal(n),
            "x3": rng.standard_normal(n),
        }
    )
    p_true = 1.0 / (1.0 + np.exp(-2.0 * x["x1"]))
    y = pd.Series((rng.uniform(size=n) < p_true).astype(float))
    return x, y


@pytest.fixture(scope="module")
def trained(learnable):
    x, y = learnable
    return walk_forward_train(x, y, embargo=24, lgbm_params=FAST_LGBM)


class TestWalkForward:
    def test_no_future_data_in_any_training_fold(self, trained) -> None:
        # QN-043 AC: every fold's training window ends a full embargo before
        # the fold starts — no label can straddle the boundary.
        assert trained.folds, "walk-forward must record fold bounds"
        for fold in trained.folds:
            assert fold["train_end"] + 24 <= fold["start"]
            assert fold["start"] < fold["end"]

    def test_oof_predictions_only_from_unseen_rows(self, trained) -> None:
        for fold in trained.folds:
            rows = trained.oof.loc[trained.oof["fold"] == fold["fold"], "row"]
            assert rows.min() >= fold["start"]
            assert rows.max() < fold["end"]

    def test_model_learned_signal(self, trained) -> None:
        assert trained.metrics["auc"] > 0.65

    def test_calibration_improves_or_matches_brier(self, trained) -> None:
        assert trained.metrics["brier_cal"] <= trained.metrics["brier_raw"] + 1e-3

    def test_reliability_curve_produced(self, trained) -> None:
        # QN-043 AC: reliability curve produced with the trained model.
        assert len(trained.reliability) >= 3
        for row in trained.reliability:
            assert {"bin_lo", "bin_hi", "mean_pred", "frac_pos", "n"} <= set(row)

    def test_calibrated_ece_reasonable(self, trained) -> None:
        assert trained.metrics["ece_cal"] < 0.1

    def test_rejects_tiny_datasets(self) -> None:
        x = pd.DataFrame({"a": np.arange(50, dtype=float)})
        y = pd.Series(np.zeros(50))
        with pytest.raises(ValueError, match="not enough"):
            walk_forward_train(x, y)


class TestCalibrator:
    def test_isotonic_json_round_trip(self, trained) -> None:
        cal = trained.calibrator
        clone = Calibrator.from_json(cal.to_json())
        grid = np.linspace(0.01, 0.99, 50).astype(np.float64)
        np.testing.assert_allclose(cal.apply(grid), clone.apply(grid))

    def test_platt_used_below_isotonic_threshold(self) -> None:
        rng = np.random.default_rng(5)
        p_raw = rng.uniform(0.2, 0.8, 100)  # < 300 OOF rows
        y = (rng.uniform(size=100) < p_raw).astype(float)
        cal = fit_calibrator(p_raw, y)
        assert cal.method == "platt"
        out = np.asarray(cal.apply(np.array([0.3, 0.7], dtype=np.float64)))
        assert ((out >= 0) & (out <= 1)).all()

    def test_isotonic_monotone(self, trained) -> None:
        grid = np.linspace(0.01, 0.99, 200).astype(np.float64)
        out = np.asarray(trained.calibrator.apply(grid))
        assert (np.diff(out) >= -1e-12).all()


class TestPredict:
    def test_scalar_calibrated_probability(self, trained) -> None:
        p = predict_proba(
            trained.booster, trained.calibrator, trained.feature_names,
            {"x1": 2.0, "x2": 0.0, "x3": 0.0},
        )
        q = predict_proba(
            trained.booster, trained.calibrator, trained.feature_names,
            {"x1": -2.0, "x2": 0.0, "x3": 0.0},
        )
        assert 0.0 <= q < p <= 1.0  # signal direction preserved

    def test_missing_features_handled_as_nan(self, trained) -> None:
        p = predict_proba(trained.booster, trained.calibrator, trained.feature_names, {})
        assert 0.0 <= p <= 1.0

    def test_deterministic(self, trained) -> None:
        f = {"x1": 0.5, "x2": -1.0, "x3": 0.2}
        args = (trained.booster, trained.calibrator, trained.feature_names)
        assert predict_proba(*args, f) == predict_proba(*args, f)


class TestMetrics:
    def test_perfect_predictions_zero_ece(self) -> None:
        y = np.array([0.0, 0.0, 1.0, 1.0] * 30)
        assert expected_calibration_error(y, y) == pytest.approx(0.0, abs=1e-12)

    def test_reliability_bins_cover_predictions(self) -> None:
        p = np.linspace(0.05, 0.95, 100).astype(np.float64)
        y = (p > 0.5).astype(float)
        rows = reliability_curve(p, y, bins=10)
        assert sum(r["n"] for r in rows) == 100
