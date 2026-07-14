"""QN-051 — point-in-time leakage tests: `published_at <= bar_ts` everywhere."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import numpy as np
import pandas as pd
import pytest

from app.backtest.pit import LookAheadError, assert_frame_point_in_time, sentiment_leakage_check
from app.quant.features import compute_features


def bars(n: int, start: datetime | None = None) -> pd.Series:
    start = start or datetime(2026, 7, 6, 0, 0, tzinfo=UTC)
    return pd.Series([start + timedelta(hours=k) for k in range(n)])


def test_clean_sentiment_passes():
    ts = bars(48)
    sentiment = pd.DataFrame(
        {
            "published_at": [ts.iloc[0] + timedelta(hours=3), ts.iloc[0] + timedelta(hours=20)],
            "score": [0.4, -0.2],
        }
    )
    report = sentiment_leakage_check(sentiment, ts)
    assert report["leakage"] is False
    assert report["sentiment_rows"] == 2


def test_empty_sentiment_is_a_pass_not_an_error():
    report = sentiment_leakage_check(None, bars(10))
    assert report["leakage"] is False
    assert report["sentiment_rows"] == 0


def test_causal_feature_join_never_sees_future_headlines():
    """The QN-040 sentiment join itself: a FUTURE headline must not change any
    bar at or before its publish time (the actual leakage vector)."""
    n = 100
    start = datetime(2026, 7, 6, 0, 0, tzinfo=UTC)
    rng = np.random.default_rng(3)
    close = 1.1 + np.cumsum(rng.normal(0, 0.0005, n))
    candles = pd.DataFrame(
        {
            "ts": [start + timedelta(hours=k) for k in range(n)],
            "open": close,
            "high": close + 0.0004,
            "low": close - 0.0004,
            "close": close,
            "volume": 100.0,
        }
    )
    early = pd.DataFrame({"published_at": [start + timedelta(hours=10)], "score": [0.5]})
    with_future = pd.concat(
        [early, pd.DataFrame({"published_at": [start + timedelta(hours=80)], "score": [-0.9]})],
        ignore_index=True,
    )
    f1 = compute_features(candles, sentiment=early)
    f2 = compute_features(candles, sentiment=with_future)
    # Bars up to hour 80 are bit-identical; only later bars may differ.
    cutoff = 80
    cols = [c for c in f1.columns if c.startswith("sent_")]
    pd.testing.assert_frame_equal(f1[cols].iloc[:cutoff], f2[cols].iloc[:cutoff])


def test_assert_frame_point_in_time_raises_on_late_rows():
    frame = pd.DataFrame({"release_ts": [datetime(2026, 7, 10, tzinfo=UTC)], "value": [1.0]})
    with pytest.raises(LookAheadError):
        assert_frame_point_in_time(frame, "release_ts", pd.Timestamp("2026-07-08", tz="UTC"))
    # In-bounds rows pass silently.
    assert_frame_point_in_time(frame, "release_ts", pd.Timestamp("2026-07-11", tz="UTC"))
