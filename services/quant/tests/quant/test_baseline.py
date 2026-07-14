"""QN-045 — shadow baseline rules, persistence shape, comparison metric."""

from __future__ import annotations

from datetime import UTC, datetime

import numpy as np
import pandas as pd

from app.quant.baseline import (
    baseline_sides,
    comparison_metric,
    evaluate_baseline,
    resolve_baseline_outcomes,
)
from app.quant.features import compute_features
from tests.quant.conftest import make_candles

TS = pd.Timestamp(datetime(2025, 7, 16, 12, 0, tzinfo=UTC))


def _row(**overrides) -> pd.Series:
    base = {
        "ts": TS,
        "ema_20_50_spread_atr": 0.0,
        "adx_14": 10.0,
        "dist_dc_high_20_atr": 1.0,
        "dist_dc_low_20_atr": 1.0,
        "range_atr": 0.8,
        "atr_14": 0.001,
    }
    base.update(overrides)
    return pd.Series(base)


class TestRules:
    def test_trend_rule_long(self) -> None:
        row = _row(ema_20_50_spread_atr=0.8, adx_14=35.0)
        sig = evaluate_baseline(row, instrument="EUR_USD", timeframe="H1")
        assert sig.would_trade is True
        assert sig.side == "long"
        assert 0 < sig.quant_score <= 1
        assert sig.meta["trend"]["direction"] == 1.0

    def test_trend_rule_needs_adx(self) -> None:
        row = _row(ema_20_50_spread_atr=0.8, adx_14=15.0)
        sig = evaluate_baseline(row, instrument="EUR_USD", timeframe="H1")
        assert sig.would_trade is False
        assert sig.side is None
        assert sig.quant_score == 0.0

    def test_breakout_rule_short(self) -> None:
        row = _row(dist_dc_low_20_atr=-0.5, range_atr=1.5)
        sig = evaluate_baseline(row, instrument="EUR_USD", timeframe="H1")
        assert sig.side == "short"
        assert sig.meta["breakout"]["direction"] == -1.0

    def test_breakout_needs_range_expansion(self) -> None:
        row = _row(dist_dc_high_20_atr=-0.5, range_atr=0.9)
        sig = evaluate_baseline(row, instrument="EUR_USD", timeframe="H1")
        assert sig.would_trade is False

    def test_conflicting_rules_stand_down(self) -> None:
        row = _row(
            ema_20_50_spread_atr=0.8,
            adx_14=35.0,  # trend long
            dist_dc_low_20_atr=-0.5,
            range_atr=1.5,  # breakout short
        )
        sig = evaluate_baseline(row, instrument="EUR_USD", timeframe="H1")
        assert sig.would_trade is False
        assert sig.meta.get("conflict") is True

    def test_row_always_produced_even_flat(self) -> None:
        # QN-045 AC: baseline_signals populated on ANY processed bar.
        sig = evaluate_baseline(_row(), instrument="EUR_USD", timeframe="H1")
        assert sig.bar_ts is not None
        assert sig.quant_score == 0.0
        assert sig.would_trade is False


class TestVectorAndOutcomes:
    def test_baseline_sides_on_trending_market(self) -> None:
        candles = make_candles(400, drift=0.002, vol=0.001, seed=13)
        feats = compute_features(candles)
        sides = baseline_sides(feats)
        assert (sides == 1.0).sum() > 0  # uptrend produces long candidates
        assert set(np.unique(sides)) <= {-1.0, 0.0, 1.0}

    def test_resolve_outcomes_and_comparison(self) -> None:
        candles = make_candles(400, drift=0.002, vol=0.001, seed=13)
        feats = compute_features(candles)
        outcomes = resolve_baseline_outcomes(candles, feats)
        resolved = outcomes.dropna()
        assert len(resolved) > 0
        metric = comparison_metric(outcomes, rr=1.8)
        assert metric["baseline_n"] == float(len(resolved))
        assert 0.0 <= metric["baseline_hit_rate"] <= 1.0
        assert "baseline_expectancy_r" in metric

    def test_comparison_with_agent_leg(self) -> None:
        outcomes = pd.Series([1.0, 0.0, 1.0, np.nan])
        metric = comparison_metric(outcomes, rr=2.0, agent_trade_r=[0.5, -1.0, 2.0])
        assert metric["agent_n"] == 3.0
        assert "agent_minus_baseline_r" in metric
