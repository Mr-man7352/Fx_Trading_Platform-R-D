"""QN-040 — feature pipeline ACs: no look-ahead, TA-Lib parity, sessions,
point-in-time macro joins, agent-context partition."""

from __future__ import annotations

from datetime import timedelta

import numpy as np
import pandas as pd
import talib

from app.quant.features import (
    compute_features,
    feature_vector,
    indicator_frame,
    partition_features,
)
from tests.quant.conftest import make_candles


def test_no_look_ahead() -> None:
    """Build-breaking AC: features at bar t must be identical whether or not
    the future exists in the input frame."""
    candles = make_candles(500, drift=0.0002, vol=0.002, seed=5)
    full = compute_features(candles)
    for cut in (300, 400, 499):
        prefix = compute_features(candles.iloc[:cut].reset_index(drop=True))
        last = prefix.iloc[-1]
        same_row = full.iloc[cut - 1]
        for col in prefix.columns:
            if col in ("ts", "session_label"):
                assert last[col] == same_row[col]
                continue
            a, b = last[col], same_row[col]
            assert (pd.isna(a) and pd.isna(b)) or a == b, f"look-ahead in {col} @ {cut}"


def test_talib_parity_pipeline_vs_direct() -> None:
    """AC: same values whether called from the pipeline or a validation script."""
    candles = make_candles(300, seed=8)
    ind = indicator_frame(candles)
    closes = candles["close"].to_numpy(dtype=np.float64)
    np.testing.assert_allclose(
        ind["rsi_14"].to_numpy(), talib.RSI(closes, timeperiod=14), equal_nan=True
    )
    np.testing.assert_allclose(
        ind["atr_14"].to_numpy(),
        talib.ATR(
            candles["high"].to_numpy(dtype=np.float64),
            candles["low"].to_numpy(dtype=np.float64),
            closes,
            timeperiod=14,
        ),
        equal_nan=True,
    )


def test_session_labels_emitted_per_bar() -> None:
    candles = make_candles(200, seed=2)
    feats = compute_features(candles)
    valid = {"TOKYO", "LONDON", "NEW_YORK", "OVERLAP", "OFF_HOURS"}
    assert set(feats["session_label"].unique()) <= valid
    assert len(set(feats["session_label"].unique())) >= 3  # hourly walk hits several
    one_hots = feats[["sess_tokyo", "sess_london", "sess_new_york", "sess_overlap",
                      "sess_off_hours"]].sum(axis=1)
    assert (one_hots == 1.0).all()


def test_macro_join_is_point_in_time() -> None:
    """release_ts <= bar_ts — a value released one second after a bar must not
    appear on that bar."""
    candles = make_candles(200, seed=3)
    bar_100 = candles["ts"].iloc[100]
    macro = pd.DataFrame(
        {
            "series": ["cot_eur", "cot_eur"],
            "release_ts": [bar_100 + timedelta(seconds=1), bar_100 + timedelta(hours=50)],
            "value": [1.5, 2.5],
        }
    )
    feats = compute_features(candles, macro=macro)
    assert pd.isna(feats["macro_cot_eur"].iloc[100])  # not yet released
    assert feats["macro_cot_eur"].iloc[101] == 1.5
    assert feats["macro_cot_eur"].iloc[151] == 2.5  # revision picked up on release
    assert feats["macro_cot_eur_age_days"].iloc[101] >= 0


def test_sentiment_window_is_point_in_time() -> None:
    candles = make_candles(100, seed=4)
    bar_50 = candles["ts"].iloc[50]
    sentiment = pd.DataFrame(
        {"published_at": [bar_50 + timedelta(seconds=1)], "score": [0.9]}
    )
    feats = compute_features(candles, sentiment=sentiment)
    assert feats["sent_n_24h"].iloc[50] == 0.0  # published after the bar
    assert feats["sent_n_24h"].iloc[51] == 1.0
    assert feats["sent_mean_24h"].iloc[51] == 0.9


def test_spread_features_causal_percentile() -> None:
    candles = make_candles(300, seed=6)
    spreads = pd.DataFrame(
        {"ts": candles["ts"], "spread_pips": np.linspace(1.0, 3.0, 300)}
    )
    feats = compute_features(candles, spreads=spreads)
    # Monotonically rising spread ⇒ trailing percentile of the last bar ≈ 1.
    assert feats["spread_pctile"].iloc[-1] > 0.95
    assert feats["spread_pips"].iloc[-1] == 3.0


def test_partition_covers_every_feature_exactly_once() -> None:
    """AC: features partition into technical/macro/sentiment per the agent
    context contract."""
    candles = make_candles(120, seed=7)
    macro = pd.DataFrame(
        {"series": ["fred_dxy"], "release_ts": [candles["ts"].iloc[0]], "value": [104.2]}
    )
    sentiment = pd.DataFrame({"published_at": [candles["ts"].iloc[0]], "score": [0.1]})
    feats = compute_features(candles, macro=macro, sentiment=sentiment)
    names = [c for c in feats.columns if c not in ("ts", "session_label")]
    parts = partition_features(names)
    assert set(parts) == {"technical", "macro", "sentiment"}
    combined = parts["technical"] + parts["macro"] + parts["sentiment"]
    assert sorted(combined) == sorted(names)  # exactly once each
    assert "macro_fred_dxy" in parts["macro"]
    assert "sent_mean_24h" in parts["sentiment"]
    assert "rsi_14" in parts["technical"]


def test_feature_vector_finite_floats_only() -> None:
    candles = make_candles(120, seed=9)
    feats = compute_features(candles)
    vec_warmup = feature_vector(feats.iloc[5])  # warmup row → NaNs dropped
    vec_ready = feature_vector(feats.iloc[-1])
    assert all(np.isfinite(v) for v in vec_warmup.values())
    assert "session_label" not in vec_ready and "ts" not in vec_ready
    assert len(vec_ready) > len(vec_warmup)
    assert "rsi_14" in vec_ready
