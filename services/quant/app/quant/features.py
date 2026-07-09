"""QN-040 — point-in-time feature pipeline (single source of truth).

Computes indicator, S/R, candle-stat, session, macro and sentiment features
from candles. Every computation is CAUSAL: the feature row at bar `t` uses
only bars ≤ `t`, macro values with `release_ts <= bar_ts`, and headlines with
`published_at <= bar_ts`. Look-ahead is a build-breaking defect (design §1);
`tests/quant/test_features.py::test_no_look_ahead` enforces it.

Indicator maths lives in `indicator_frame` and NOWHERE else — the pipeline and
any validation script call the same function, so values can never diverge
(QN-040 AC). Feature names are partitioned into the `technical` / `macro` /
`sentiment` agent subsets by prefix via `partition_features`.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd
import talib

from app.quant.sessions import (
    SessionLabel,
    in_weekend_gap_window,
    is_triple_swap_day,
    session_label,
)

# Bump when the feature set changes; recomputes never clobber history because
# `features.version` is part of the primary key (Step 1.4 schema).
FEATURE_SET_VERSION = 1

# Warmup bars required before the slowest indicator (EMA-200 style windows are
# avoided; Donchian-55 + ADX-14 dominate). Rows before this contain NaNs.
WARMUP_BARS = 60

_SESSION_ONE_HOTS = {
    SessionLabel.TOKYO: "sess_tokyo",
    SessionLabel.LONDON: "sess_london",
    SessionLabel.NEW_YORK: "sess_new_york",
    SessionLabel.OVERLAP: "sess_overlap",
    SessionLabel.OFF_HOURS: "sess_off_hours",
}


def _validate_candles(candles: pd.DataFrame) -> pd.DataFrame:
    required = {"ts", "open", "high", "low", "close", "volume"}
    missing = required - set(candles.columns)
    if missing:
        raise ValueError(f"candles frame missing columns: {sorted(missing)}")
    df = candles.sort_values("ts").drop_duplicates(subset="ts").reset_index(drop=True)
    ts = pd.to_datetime(df["ts"], utc=True)
    df["ts"] = ts
    return df


def indicator_frame(candles: pd.DataFrame) -> pd.DataFrame:
    """TA-Lib indicators + candle stats + S/R distances, indexed like `candles`.

    THE single implementation (QN-040 AC): pipeline and validation scripts both
    call this. All columns are causal — TA-Lib functions only look back.
    """
    df = _validate_candles(candles)
    o = df["open"].to_numpy(dtype=np.float64)
    h = df["high"].to_numpy(dtype=np.float64)
    lo = df["low"].to_numpy(dtype=np.float64)
    c = df["close"].to_numpy(dtype=np.float64)
    v = df["volume"].to_numpy(dtype=np.float64)

    out = pd.DataFrame({"ts": df["ts"]})
    log_c = np.log(c)
    ret_1 = np.diff(log_c, prepend=np.nan)
    out["ret_1"] = ret_1
    out["ret_5"] = pd.Series(log_c).diff(5).to_numpy()
    out["ret_20"] = pd.Series(log_c).diff(20).to_numpy()
    rv_20 = pd.Series(ret_1).rolling(20).std().to_numpy()
    out["rv_20"] = rv_20
    rv_5 = pd.Series(ret_1).rolling(5).std().to_numpy()
    with np.errstate(divide="ignore", invalid="ignore"):
        out["vol_ratio_5_20"] = np.where(rv_20 > 0, rv_5 / rv_20, np.nan)

    ema_20 = talib.EMA(c, timeperiod=20)
    ema_50 = talib.EMA(c, timeperiod=50)
    atr_14 = talib.ATR(h, lo, c, timeperiod=14)
    out["ema_20_dist"] = c / ema_20 - 1.0
    out["ema_50_dist"] = c / ema_50 - 1.0
    with np.errstate(divide="ignore", invalid="ignore"):
        out["ema_20_50_spread_atr"] = np.where(atr_14 > 0, (ema_20 - ema_50) / atr_14, np.nan)
    out["rsi_14"] = talib.RSI(c, timeperiod=14)
    out["atr_14"] = atr_14
    out["natr_14"] = talib.NATR(h, lo, c, timeperiod=14)
    out["adx_14"] = talib.ADX(h, lo, c, timeperiod=14)
    _, _, macd_hist = talib.MACD(c, fastperiod=12, slowperiod=26, signalperiod=9)
    out["macd_hist_norm"] = macd_hist / c
    bb_up, bb_mid, bb_lo = talib.BBANDS(c, timeperiod=20, nbdevup=2, nbdevdn=2)
    width = bb_up - bb_lo
    with np.errstate(divide="ignore", invalid="ignore"):
        out["bb_pos"] = np.where(width > 0, (c - bb_lo) / width, np.nan)
        out["bb_width"] = np.where(bb_mid > 0, width / bb_mid, np.nan)
    out["roc_10"] = talib.ROC(c, timeperiod=10)

    # S/R distances: PRIOR N-bar Donchian channel (shifted 1 → the current bar
    # can break it), expressed in ATR units so instruments are comparable.
    for n in (20, 55):
        dc_high = pd.Series(h).rolling(n).max().shift(1).to_numpy()
        dc_low = pd.Series(lo).rolling(n).min().shift(1).to_numpy()
        with np.errstate(divide="ignore", invalid="ignore"):
            out[f"dist_dc_high_{n}_atr"] = np.where(atr_14 > 0, (dc_high - c) / atr_14, np.nan)
            out[f"dist_dc_low_{n}_atr"] = np.where(atr_14 > 0, (c - dc_low) / atr_14, np.nan)

    # Candle anatomy.
    rng = h - lo
    body = np.abs(c - o)
    with np.errstate(divide="ignore", invalid="ignore"):
        out["body_pct"] = np.where(rng > 0, body / rng, 0.0)
        out["upper_wick_pct"] = np.where(rng > 0, (h - np.maximum(o, c)) / rng, 0.0)
        out["lower_wick_pct"] = np.where(rng > 0, (np.minimum(o, c) - lo) / rng, 0.0)
        out["close_pos"] = np.where(rng > 0, (c - lo) / rng, 0.5)
        out["range_atr"] = np.where(atr_14 > 0, rng / atr_14, np.nan)

    vol_mean = pd.Series(v).rolling(20).mean()
    vol_std = pd.Series(v).rolling(20).std()
    out["volume_z_20"] = ((pd.Series(v) - vol_mean) / vol_std.replace(0.0, np.nan)).to_numpy()
    return out


def _session_features(ts: pd.Series) -> pd.DataFrame:
    labels = [session_label(t.to_pydatetime()) for t in ts]
    out = pd.DataFrame({"ts": ts, "session_label": [str(lb) for lb in labels]})
    for lb, col in _SESSION_ONE_HOTS.items():
        out[col] = [1.0 if x == lb else 0.0 for x in labels]
    out["triple_swap_day"] = [
        1.0 if is_triple_swap_day(t.to_pydatetime()) else 0.0 for t in ts
    ]
    out["weekend_gap_window"] = [
        1.0 if in_weekend_gap_window(t.to_pydatetime()) else 0.0 for t in ts
    ]
    return out


def _macro_features(ts: pd.Series, macro: pd.DataFrame | None) -> pd.DataFrame:
    """Point-in-time join: last value per series with `release_ts <= bar_ts`."""
    out = pd.DataFrame({"ts": ts})
    if macro is None or macro.empty:
        return out
    required = {"series", "release_ts", "value"}
    if missing := required - set(macro.columns):
        raise ValueError(f"macro frame missing columns: {sorted(missing)}")
    m = macro.copy()
    m["release_ts"] = pd.to_datetime(m["release_ts"], utc=True)
    m = m.sort_values("release_ts")
    for series, grp in m.groupby("series", sort=True):
        name = "".join(ch if ch.isalnum() else "_" for ch in str(series).lower())
        joined = pd.merge_asof(
            pd.DataFrame({"ts": ts}),
            grp[["release_ts", "value"]].rename(columns={"release_ts": "ts_m"}),
            left_on="ts",
            right_on="ts_m",
            direction="backward",  # release_ts <= bar_ts — never the future
        )
        out[f"macro_{name}"] = joined["value"].to_numpy()
        age = (joined["ts"] - joined["ts_m"]).dt.total_seconds() / 86400.0
        out[f"macro_{name}_age_days"] = age.to_numpy()
    return out


def _sentiment_features(ts: pd.Series, sentiment: pd.DataFrame | None) -> pd.DataFrame:
    """Rolling signed-sentiment aggregates over headlines with
    `published_at <= bar_ts` (QN-022 scores; empty until the ml group runs)."""
    out = pd.DataFrame({"ts": ts})
    if sentiment is None or sentiment.empty:
        return out
    required = {"published_at", "score"}
    if missing := required - set(sentiment.columns):
        raise ValueError(f"sentiment frame missing columns: {sorted(missing)}")
    s = sentiment.copy()
    s["published_at"] = pd.to_datetime(s["published_at"], utc=True)
    s = s.sort_values("published_at")
    # tz-aware → naive-UTC datetime64 (tz-aware .to_numpy() yields object dtype).
    pub = s["published_at"].dt.tz_localize(None).to_numpy()
    scores = s["score"].to_numpy(dtype=np.float64)
    for hours, suffix in ((24, "24h"), (72, "72h")):
        means: list[float] = []
        counts: list[float] = []
        for t in ts:
            hi = np.searchsorted(pub, np.datetime64(t.tz_convert(None)), side="right")
            lo = np.searchsorted(
                pub, np.datetime64((t - pd.Timedelta(hours=hours)).tz_convert(None)), side="left"
            )
            window = scores[lo:hi]
            means.append(float(window.mean()) if window.size else np.nan)
            counts.append(float(window.size))
        out[f"sent_mean_{suffix}"] = means
        out[f"sent_n_{suffix}"] = counts
    return out


def compute_features(
    candles: pd.DataFrame,
    *,
    macro: pd.DataFrame | None = None,
    sentiment: pd.DataFrame | None = None,
    spreads: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """Full point-in-time feature frame: one row per candle, `ts` + numeric
    feature columns + a `session_label` string column.

    `spreads` (columns: ts, spread_pips) adds `spread_pips` (as-of last known)
    and `spread_pctile` (causal trailing-500-observation percentile rank).
    """
    ind = indicator_frame(candles)
    ts = ind["ts"]
    frames = [
        ind,
        _session_features(ts),
        _macro_features(ts, macro),
        _sentiment_features(ts, sentiment),
    ]
    out = frames[0]
    for f in frames[1:]:
        out = out.merge(f, on="ts", how="left")

    if spreads is not None and not spreads.empty:
        sp = spreads.copy()
        sp["ts"] = pd.to_datetime(sp["ts"], utc=True)
        sp = sp.sort_values("ts")
        joined = pd.merge_asof(
            pd.DataFrame({"ts": ts}),
            sp[["ts", "spread_pips"]],
            on="ts",
            direction="backward",
        )
        out["spread_pips"] = joined["spread_pips"].to_numpy()
        # Causal percentile: rank of each observation within its trailing window.
        out["spread_pctile"] = (
            out["spread_pips"]
            .rolling(500, min_periods=20)
            .rank(pct=True)
            .to_numpy()
        )
    return out


def feature_vector(row: pd.Series) -> dict[str, float]:
    """gRPC/DB-ready numeric map for one feature row: finite floats only."""
    vec: dict[str, float] = {}
    for name, value in row.items():
        if name in ("ts", "session_label"):
            continue
        try:
            f = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(f):
            vec[name] = f
    return vec


def partition_features(names: list[str] | dict[str, Any]) -> dict[str, list[str]]:
    """Partition feature names into the per-agent context subsets (QN-040 AC).

    `macro_*` → macro, `sent_*` → sentiment, everything else → technical.
    Every feature lands in exactly one subset by construction.
    """
    keys = list(names)
    return {
        "technical": [n for n in keys if not n.startswith(("macro_", "sent_"))],
        "macro": [n for n in keys if n.startswith("macro_")],
        "sentiment": [n for n in keys if n.startswith("sent_")],
    }
