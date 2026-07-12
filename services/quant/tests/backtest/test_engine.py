"""QN-050/051 — backtest engine tests: bracket fills, gap/flash/swap costs,
threshold sweep, PIT report, deterministic replay."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import numpy as np
import pandas as pd
import pytest

from app.backtest.costs import CostParams
from app.backtest.engine import BacktestEngine, BacktestParams
from app.quant.labels import LabelParams


def make_candles(prices: list[tuple[float, float, float, float]], start: datetime | None = None):
    """(open, high, low, close) rows on an H1 grid."""
    start = start or datetime(2026, 7, 6, 0, 0, tzinfo=UTC)  # Monday
    rows = []
    for k, (o, h, lo, c) in enumerate(prices):
        rows.append(
            {"ts": start + timedelta(hours=k), "open": o, "high": h, "low": lo, "close": c,
             "volume": 100.0}
        )
    return pd.DataFrame(rows)


def make_features(candles: pd.DataFrame, atr: float = 0.0010, **cols):
    f = pd.DataFrame({"ts": pd.to_datetime(candles["ts"], utc=True)})
    f["atr_14"] = atr
    f["session_label"] = "LONDON"
    for name, values in cols.items():
        f[name] = values
    return f


def params(**overrides):
    defaults = dict(
        instrument="EUR_USD",
        timeframe="H1",
        probability_threshold=0.60,
        label_params=LabelParams(horizon=6, atr_stop_mult=1.0, rr=1.8, cost_pips=0.0),
        cost_params=CostParams(financing_pips_per_day=0.0, stop_slippage_frac=0.5),
        risk_pct=0.01,
        initial_equity=10_000.0,
    )
    defaults.update(overrides)
    return BacktestParams(**defaults)


def build(candles, p):
    return BacktestEngine(candles, params=p, proba_fn=lambda f, s: np.full(len(f), 0.65))


FLAT = (1.1000, 1.1005, 1.0995, 1.1000)


def test_tp_exit_and_costs_reduce_pnl():
    # Long candidate at bar 0 (close 1.1000, ATR 10 pips ⇒ SL 1.0990, TP 1.1018).
    candles = make_candles([FLAT, (1.1000, 1.1020, 1.0999, 1.1015), FLAT, FLAT])
    features = make_features(candles)
    sides = pd.Series([1.0, 0.0, 0.0, 0.0])
    proba = np.array([0.9, np.nan, np.nan, np.nan])
    engine = build(candles, params())
    trades, _ = engine._simulate(features, sides, proba, 0.6)
    assert len(trades) == 1
    t = trades[0]
    assert t.exit_reason == "TP"
    assert t.gross_pips == pytest.approx(18.0)
    assert t.costs.spread_pips > 0  # round-trip spread charged
    assert t.net_pips < t.gross_pips
    assert t.r_multiple < 1.8  # costs shave the theoretical R:R


def test_sl_first_conservative_tie_break():
    # Bar 1 spans BOTH the stop and the target ⇒ SL fills first (labels.py rule).
    candles = make_candles([FLAT, (1.1000, 1.1020, 1.0989, 1.1000), FLAT, FLAT])
    features = make_features(candles)
    sides = pd.Series([1.0, 0.0, 0.0, 0.0])
    proba = np.array([0.9, np.nan, np.nan, np.nan])
    trades, _ = build(candles, params())._simulate(features, sides, proba, 0.6)
    assert trades[0].exit_reason == "SL"
    assert trades[0].costs.slippage_pips > 0  # stop exits slip


def test_weekend_gap_fills_beyond_stop():
    """AC: gap through the stop fills at the OPEN — loss beyond stop in tail risk."""
    candles = make_candles([FLAT, (1.0970, 1.0975, 1.0960, 1.0965), FLAT, FLAT])
    features = make_features(candles)
    sides = pd.Series([1.0, 0.0, 0.0, 0.0])
    proba = np.array([0.9, np.nan, np.nan, np.nan])
    trades, _ = build(candles, params())._simulate(features, sides, proba, 0.6)
    t = trades[0]
    assert t.exit_reason == "GAP_SL"
    assert t.exit_price == pytest.approx(1.0970)  # the open, NOT the 1.0990 stop
    assert t.costs.gap_excess_pips == pytest.approx(20.0)
    assert t.r_multiple < -1.0  # loss beyond 1R — the tail-risk signature


def test_flash_crash_slippage_10x_documented():
    """AC: SNB-style spread spike ⇒ 10× slippage on the stop fill."""
    candles = make_candles([FLAT, (1.1000, 1.1001, 1.0985, 1.0990), FLAT, FLAT])
    spread_pctile = [0.5, 0.999, 0.5, 0.5]
    spread_pips = [1.0, 1.0, 1.0, 1.0]
    features = make_features(
        candles, spread_pctile=spread_pctile, spread_pips=spread_pips
    )
    sides = pd.Series([1.0, 0.0, 0.0, 0.0])
    proba = np.array([0.9, np.nan, np.nan, np.nan])
    trades, _ = build(candles, params())._simulate(features, sides, proba, 0.6)
    t = trades[0]
    assert t.exit_reason == "SL"
    assert t.costs.flash_event is True
    assert t.costs.slippage_pips == pytest.approx(1.0 * 0.5 * 10.0)
    assert any("flash" in note for note in t.costs.notes)


def test_wednesday_triple_swap_on_multi_day_hold():
    """AC: Wednesday triple swap on a multi-day hold lands in P&L."""
    # Entry Monday 00:00; nothing touches the bracket for 80 bars (flat inside
    # the 10-pip bracket), horizon expiry Thursday+ ⇒ crosses Wed 17:00 NY.
    bars = [FLAT] * 81
    candles = make_candles(bars)
    features = make_features(candles)
    sides = pd.Series([1.0] + [0.0] * 80)
    proba = np.array([0.9] + [np.nan] * 80)
    p = params(
        label_params=LabelParams(horizon=80, atr_stop_mult=1.0, rr=1.8, cost_pips=0.0),
        cost_params=CostParams(financing_pips_per_day=0.6),
    )
    trades, _ = build(candles, p)._simulate(features, sides, proba, 0.6)
    t = trades[0]
    assert t.exit_reason == "EXPIRY"
    assert t.costs.swap_pips > 0
    assert any("triple-swap" in note for note in t.costs.notes)


def test_threshold_filters_and_sequential_non_overlap():
    candles = make_candles([FLAT] * 10)
    features = make_features(candles)
    sides = pd.Series([1.0] * 10)
    proba = np.array([0.59, 0.61] + [0.61] * 8)
    p = params(label_params=LabelParams(horizon=3, atr_stop_mult=1.0, rr=1.8, cost_pips=0.0))
    trades, _ = build(candles, p)._simulate(features, sides, proba, 0.60)
    # Bar 0 below threshold; bar 1 enters and holds to bar 4; next entry bar 5.
    assert [t.entry_ts.hour for t in trades] == [1, 5]


def test_full_run_report_shape_and_determinism():
    """End-to-end run() on synthetic trending data (real compute_features)."""
    rng = np.random.default_rng(7)
    n = 400
    drift = np.cumsum(rng.normal(0.0004, 0.0008, n))
    close = 1.1 + drift
    high = close + np.abs(rng.normal(0.0006, 0.0002, n))
    low = close - np.abs(rng.normal(0.0006, 0.0002, n))
    open_ = np.concatenate(([close[0]], close[:-1]))
    start = datetime(2026, 3, 2, 0, 0, tzinfo=UTC)
    candles = pd.DataFrame(
        {
            "ts": [start + timedelta(hours=k) for k in range(n)],
            "open": open_,
            "high": np.maximum(high, np.maximum(open_, close)),
            "low": np.minimum(low, np.minimum(open_, close)),
            "close": close,
            "volume": 100.0,
        }
    )
    p = params()
    engine = BacktestEngine(candles, params=p, proba_fn=lambda f, s: np.full(len(f), 0.65))
    report = engine.run()

    assert report["engine"] == "qn050-v1"
    assert report["point_in_time"]["leakage"] is False
    assert "0.600" in report["threshold_sweep"]
    assert set(report["threshold_sweep"].keys()) >= {"0.550", "0.600", "0.700"}
    assert report["optimal_threshold"]["threshold"] in [
        float(k) for k in report["threshold_sweep"]
    ]
    m = report["metrics"]
    for key in ("n_trades", "hit_rate", "expectancy_r", "sharpe", "max_drawdown_pct", "costs"):
        assert key in m
    # Deterministic replay: same inputs ⇒ identical report (design §1).
    report2 = BacktestEngine(
        candles, params=p, proba_fn=lambda f, s: np.full(len(f), 0.65)
    ).run()
    assert report == report2
