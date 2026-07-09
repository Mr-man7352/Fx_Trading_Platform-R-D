"""QN-045 — shadow quant baseline (trend + vol-breakout), always on.

Evaluated on EVERY processed bar in EVERY mode and persisted to
`baseline_signals`, so agents-vs-baseline is always measurable (story goal).
In Phase 2 the baseline rules double as the deterministic CANDIDATE GENERATOR
for the pipeline (ADR-010 entry gate): the meta-model scores exactly these
candidates. The agent layer (Phase 3) refines them — and is then compared
back against this baseline.

Rules (indicator names from app.quant.features.indicator_frame):
  trend     — EMA20 above/below EMA50 with ADX ≥ 20 (strength-scaled score)
  breakout  — close breaks the PRIOR 20-bar Donchian channel with range
              expansion (bar range ≥ 1.2×ATR)
Conflicting directions ⇒ no trade (would_trade=False, conflict recorded).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

import numpy as np
import pandas as pd

from app.quant.labels import LabelParams, label_outcomes

BASELINE_VERSION = "qn045-v1"
_ADX_FLOOR = 20.0
_ADX_SCALE = 50.0
_RANGE_EXPANSION = 1.2


@dataclass(frozen=True, slots=True)
class BaselineSignalRow:
    bar_ts: datetime
    instrument: str
    timeframe: str
    side: str | None  # "long" | "short" | None
    quant_score: float  # 0..1 rule strength (0 when no trade)
    would_trade: bool
    meta: dict[str, Any]


def _trend_rule(row: pd.Series) -> tuple[float, float]:
    """(direction, score): EMA20 vs EMA50 spread with ADX strength filter."""
    spread = row.get("ema_20_50_spread_atr", np.nan)
    adx = row.get("adx_14", np.nan)
    if not np.isfinite(spread) or not np.isfinite(adx) or adx < _ADX_FLOOR:
        return 0.0, 0.0
    direction = float(np.sign(spread))
    score = min(adx / _ADX_SCALE, 1.0) * min(abs(spread), 1.0)
    return direction, float(score)


def _breakout_rule(row: pd.Series) -> tuple[float, float]:
    """(direction, score): prior-Donchian break with range expansion."""
    up = row.get("dist_dc_high_20_atr", np.nan)  # (prior high − close)/ATR
    down = row.get("dist_dc_low_20_atr", np.nan)  # (close − prior low)/ATR
    rng = row.get("range_atr", np.nan)
    if not np.isfinite(rng) or rng < _RANGE_EXPANSION:
        return 0.0, 0.0
    if np.isfinite(up) and up < 0:  # closed above the prior 20-bar high
        return 1.0, float(min(-up, 1.0))
    if np.isfinite(down) and down < 0:  # closed below the prior 20-bar low
        return -1.0, float(min(-down, 1.0))
    return 0.0, 0.0


def evaluate_baseline(
    features_row: pd.Series,
    *,
    instrument: str,
    timeframe: str,
) -> BaselineSignalRow:
    """Baseline decision for ONE bar (the last pipeline bar, typically)."""
    t_dir, t_score = _trend_rule(features_row)
    b_dir, b_score = _breakout_rule(features_row)
    meta: dict[str, Any] = {
        "baseline_version": BASELINE_VERSION,
        "trend": {"direction": t_dir, "score": t_score},
        "breakout": {"direction": b_dir, "score": b_score},
    }
    directions = {d for d in (t_dir, b_dir) if d != 0.0}
    if len(directions) == 2:  # rules disagree — stand down
        meta["conflict"] = True
        side_str, score, would = None, 0.0, False
    elif directions:
        d = directions.pop()
        side_str = "long" if d > 0 else "short"
        score = max(t_score, b_score)
        would = True
    else:
        side_str, score, would = None, 0.0, False
    ts = features_row["ts"]
    bar_ts = ts.to_pydatetime() if isinstance(ts, pd.Timestamp) else ts
    return BaselineSignalRow(
        bar_ts=bar_ts,
        instrument=instrument,
        timeframe=timeframe,
        side=side_str,
        quant_score=float(score),
        would_trade=would,
        meta=meta,
    )


def baseline_sides(features: pd.DataFrame) -> pd.Series:
    """Vectorised candidate sides over a whole feature frame (+1/−1/0) — the
    training-set generator for QN-043 (model trains on baseline candidates)."""
    sides = np.zeros(len(features))
    for i in range(len(features)):
        row = features.iloc[i]
        t_dir, _ = _trend_rule(row)
        b_dir, _ = _breakout_rule(row)
        dirs = {d for d in (t_dir, b_dir) if d != 0.0}
        sides[i] = dirs.pop() if len(dirs) == 1 else 0.0
    return pd.Series(sides, index=features.index, name="side")


def resolve_baseline_outcomes(
    candles: pd.DataFrame,
    features: pd.DataFrame,
    params: LabelParams | None = None,
) -> pd.Series:
    """Hypothetical outcomes of baseline candidates (same bracket sim as
    QN-043 labels) — the continuous comparison input."""
    return label_outcomes(candles, baseline_sides(features), features["atr_14"], params)


def comparison_metric(
    baseline_outcomes: pd.Series,
    *,
    rr: float = 1.8,
    agent_trade_r: list[float] | None = None,
) -> dict[str, float]:
    """Agents-vs-baseline comparison (QN-045 AC: computed continuously).

    Baseline expectancy in R-multiples from resolved hypothetical outcomes
    (win ⇒ +rr·R, loss ⇒ −1R) vs realized agent-trade R-multiples when
    provided (none yet in Phase 2 — the metric still reports the baseline leg).
    """
    resolved = baseline_outcomes.dropna()
    resolved = resolved[baseline_outcomes.notna()]
    out: dict[str, float] = {"baseline_n": float(len(resolved))}
    if len(resolved):
        wins = float(resolved.mean())
        out["baseline_hit_rate"] = wins
        out["baseline_expectancy_r"] = wins * rr - (1.0 - wins)
    if agent_trade_r:
        arr = np.asarray(agent_trade_r, dtype=np.float64)
        out["agent_n"] = float(len(arr))
        out["agent_expectancy_r"] = float(arr.mean())
        if "baseline_expectancy_r" in out:
            out["agent_minus_baseline_r"] = out["agent_expectancy_r"] - out["baseline_expectancy_r"]
    return out
