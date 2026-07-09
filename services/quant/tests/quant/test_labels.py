"""QN-043 — bracket-sim outcome labels (deterministic micro-fixtures)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import numpy as np
import pandas as pd

from app.quant.labels import LabelParams, label_outcomes

P = LabelParams(horizon=5, atr_stop_mult=1.0, rr=2.0, cost_pips=0.0, pip=0.0001)


def _candles(closes: list[float], highs: list[float], lows: list[float]) -> pd.DataFrame:
    n = len(closes)
    start = datetime(2025, 1, 6, tzinfo=UTC)
    return pd.DataFrame(
        {
            "ts": [start + timedelta(hours=i) for i in range(n)],
            "open": closes,
            "high": highs,
            "low": lows,
            "close": closes,
            "volume": [1000.0] * n,
        }
    )


def _run(candles: pd.DataFrame, side: float, atr: float = 0.0010) -> pd.Series:
    sides = pd.Series([side] + [0.0] * (len(candles) - 1))
    atrs = pd.Series([atr] * len(candles))
    return label_outcomes(candles, sides, atrs, P)


def test_take_profit_first_is_win() -> None:
    # Long at 1.1000, stop 1.0990, target 1.1020; bar 2 tags the target.
    flat_h = [1.1005] * 8
    flat_l = [1.0995] * 8
    highs = flat_h.copy()
    highs[2] = 1.1021
    labels = _run(_candles([1.1000] * 8, highs, flat_l), side=1.0)
    assert labels.iloc[0] == 1.0


def test_stop_first_is_loss() -> None:
    lows = [1.0995] * 8
    lows[1] = 1.0989
    highs = [1.1005] * 8
    highs[3] = 1.1025  # target hit LATER — stop already took it
    labels = _run(_candles([1.1000] * 8, highs, lows), side=1.0)
    assert labels.iloc[0] == 0.0


def test_same_bar_touch_is_conservative_loss() -> None:
    highs = [1.1005] * 8
    lows = [1.0995] * 8
    highs[2], lows[2] = 1.1025, 1.0985  # one bar spans both levels
    labels = _run(_candles([1.1000] * 8, highs, lows), side=1.0)
    assert labels.iloc[0] == 0.0


def test_horizon_expiry_uses_net_pnl_sign() -> None:
    closes = [1.1000, 1.1002, 1.1003, 1.1004, 1.1005, 1.1006, 1.1006, 1.1006]
    highs = [c + 0.0003 for c in closes]
    lows = [c - 0.0003 for c in closes]
    labels = _run(_candles(closes, highs, lows), side=1.0)
    assert labels.iloc[0] == 1.0  # drifted up, never touched either level


def test_short_side_mirrors() -> None:
    lows = [1.0995] * 8
    lows[2] = 1.0979  # short target 1.0980 (2R below)
    labels = _run(_candles([1.1000] * 8, [1.1005] * 8, lows), side=-1.0)
    assert labels.iloc[0] == 1.0


def test_tail_and_no_candidate_are_nan() -> None:
    candles = _candles([1.1] * 8, [1.1005] * 8, [1.0995] * 8)
    sides = pd.Series([0.0] * 7 + [1.0])  # candidate on the last bar → no future
    labels = label_outcomes(candles, sides, pd.Series([0.001] * 8), P)
    assert np.isnan(labels.iloc[7])  # unresolved tail
    assert np.isnan(labels.iloc[0])  # no candidate
