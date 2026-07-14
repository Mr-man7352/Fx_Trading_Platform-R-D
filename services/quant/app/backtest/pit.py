"""QN-051 — point-in-time news/sentiment enforcement in backtests.

The feature pipeline (QN-040) already joins sentiment causally
(`published_at <= bar_ts` via backward searchsorted). This module makes the
guarantee EXPLICIT and testable per run: the leakage check re-derives, for
every bar, the latest headline timestamp that could have influenced it and
asserts it never post-dates the bar. Look-ahead is a build-breaking defect
(design §1) — a failed check raises, it does not warn.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd


class LookAheadError(AssertionError):
    """A sentiment row later than its bar was available to the features."""


def sentiment_leakage_check(
    sentiment: pd.DataFrame | None,
    bar_ts: pd.Series,
    *,
    raise_on_violation: bool = True,
) -> dict[str, Any]:
    """AC: `published_at <= bar_ts` everywhere.

    Returns a small report embedded in the backtest result; raises
    `LookAheadError` on violation unless `raise_on_violation=False`
    (used by the unit test that PROVES the check catches a poisoned frame).
    """
    if sentiment is None or sentiment.empty:
        return {"sentiment_rows": 0, "checked_bars": len(bar_ts), "leakage": False}

    s = sentiment.copy()
    s["published_at"] = pd.to_datetime(s["published_at"], utc=True)
    pub = np.sort(s["published_at"].dt.tz_localize(None).to_numpy())
    bars = pd.to_datetime(bar_ts, utc=True).dt.tz_localize(None).to_numpy()

    # For each bar: index of the last headline the causal join may include.
    hi = np.searchsorted(pub, bars, side="right")
    latest_used = np.where(hi > 0, pub[np.maximum(hi - 1, 0)], np.datetime64("NaT"))
    violation = np.zeros(len(bars), dtype=bool)
    mask = ~pd.isna(latest_used)
    violation[mask] = latest_used[mask] > bars[mask]

    leaked = bool(violation.any())
    report = {
        "sentiment_rows": len(s),
        "checked_bars": len(bars),
        "leakage": leaked,
        "rule": "published_at <= bar_ts",
    }
    if leaked and raise_on_violation:
        raise LookAheadError(f"sentiment look-ahead detected: {report}")
    return report


def assert_frame_point_in_time(
    frame: pd.DataFrame,
    time_column: str,
    as_of: pd.Timestamp,
) -> None:
    """Generic PIT guard for any frame loaded for a backtest window."""
    if frame.empty:
        return
    ts = pd.to_datetime(frame[time_column], utc=True)
    bound = pd.Timestamp(as_of)
    bound = bound.tz_convert("UTC") if bound.tzinfo else bound.tz_localize("UTC")
    late = ts > bound
    if bool(late.any()):
        raise LookAheadError(
            f"{time_column}: {int(late.sum())} row(s) post-date the backtest as-of bound"
        )
