"""QN-041 — HMM trend regime, entropy → debate rounds, liquidity regime."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.quant.regime import (
    LiquidityRegime,
    TrendRegime,
    debate_rounds,
    detect_trend_regime,
    fold_stability,
    liquidity_regime,
    volume_pctile,
)


def _returns(segments: list[tuple[int, float]], vol: float = 0.0008, seed: int = 1) -> pd.Series:
    rng = np.random.default_rng(seed)
    parts = [drift + vol * rng.standard_normal(n) for n, drift in segments]
    return pd.Series(np.concatenate(parts))


class TestTrendRegime:
    def test_labels_directional_segments(self) -> None:
        # Up-drift then down-drift: the last bar must label TREND_DOWN and the
        # timeline must contain both trends (QN-041: trend timeline produced).
        rets = _returns([(200, 0.003), (200, -0.003)])
        result = detect_trend_regime(rets)
        assert result.label == TrendRegime.TREND_DOWN
        assert TrendRegime.TREND_UP in result.timeline
        assert len(result.timeline) == len(rets)

    def test_deterministic_per_seed(self) -> None:
        rets = _returns([(150, 0.002), (150, -0.001)])
        a = detect_trend_regime(rets, seed=7)
        b = detect_trend_regime(rets, seed=7)
        assert a.label == b.label
        assert a.entropy == b.entropy
        assert a.timeline == b.timeline

    def test_entropy_in_unit_interval_and_rounds_exported(self) -> None:
        rets = _returns([(300, 0.001)])
        result = detect_trend_regime(rets)
        assert 0.0 <= result.entropy <= 1.0
        assert result.debate_rounds in (0, 1, 2)  # usable by the signal worker

    def test_requires_enough_data(self) -> None:
        with pytest.raises(ValueError, match="50"):
            detect_trend_regime(pd.Series(np.zeros(30)))

    def test_debate_rounds_mapping(self) -> None:
        assert debate_rounds(0.1) == 0
        assert debate_rounds(0.5) == 1
        assert debate_rounds(0.9) == 2


class TestFoldStability:
    def test_stability_metric_tracked_across_folds(self) -> None:
        rets = _returns([(300, 0.003), (300, -0.003)], seed=2)
        score = fold_stability(rets, n_folds=3)
        assert -1.0 <= score <= 1.0

    def test_needs_enough_history(self) -> None:
        with pytest.raises(ValueError):
            fold_stability(pd.Series(np.zeros(100)))


class TestLiquidityRegime:
    def test_low_on_wide_spread(self) -> None:
        # Christmas week / Asian-session-for-EUR case: spread blows out.
        assert liquidity_regime(0.9, 0.5) == LiquidityRegime.LOW

    def test_low_on_thin_volume(self) -> None:
        assert liquidity_regime(0.5, 0.1) == LiquidityRegime.LOW

    def test_high_on_tight_spread_strong_volume(self) -> None:
        assert liquidity_regime(0.2, 0.8) == LiquidityRegime.HIGH

    def test_normal_otherwise_and_on_missing_data(self) -> None:
        assert liquidity_regime(0.5, 0.5) == LiquidityRegime.NORMAL
        assert liquidity_regime(None, 0.9) == LiquidityRegime.NORMAL
        assert liquidity_regime(0.1, None) == LiquidityRegime.NORMAL

    def test_percentile_bounds_validated(self) -> None:
        with pytest.raises(ValueError):
            liquidity_regime(1.5, 0.5)

    def test_volume_pctile_trailing(self) -> None:
        vol = pd.Series(np.concatenate([np.full(100, 1000.0), [10_000.0]]))
        assert volume_pctile(vol) == 1.0
        assert volume_pctile(pd.Series([1.0] * 5)) is None  # below min_periods
