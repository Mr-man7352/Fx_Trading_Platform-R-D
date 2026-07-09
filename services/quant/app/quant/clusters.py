"""QN-048 — correlation clustering + event-triggered refresh (Python owns the maths).

Publishes a versioned cluster table the Node risk gate (BE-071) consumes for
the max-correlated-exposure cap ("Node never does maths", §3.1). Defaults per
design §10: rolling 60-day Pearson correlation, hierarchical (average-linkage)
clustering at a 0.7 correlation threshold, weekly refresh.

Weekly alone is TOO SLOW in risk-off — correlations between majors converge
within hours — so two event triggers force an immediate recompute:
  • liquidity-regime transition (QN-041 label changed since the last set)
  • realized-vol spike (short-window vol > mult × trailing-median vol)
Event-triggered recomputes use a SHORTER lookback (`event_lookback_days`) so
the fresh convergence dominates the estimate instead of being averaged away
by 60 calm days — that is what lets the event path catch a 2020-03-style
EUR/USD–GBP/USD convergence before the weekly refresh would (AC fixture).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import numpy as np
import pandas as pd
from scipy.cluster.hierarchy import fcluster, linkage
from scipy.spatial.distance import squareform

TRIGGER_WEEKLY = "weekly"
TRIGGER_LIQUIDITY = "liquidity_transition"
TRIGGER_VOL_SPIKE = "vol_spike"
TRIGGER_MANUAL = "manual"
TRIGGER_BOOTSTRAP = "bootstrap"


@dataclass(frozen=True, slots=True)
class ClusterParams:
    """Defaults match system design §10; configurable via settings (AC)."""

    lookback_days: int = 60
    threshold: float = 0.7  # cluster together at |corr| >= 0.7
    refresh_days: int = 7  # weekly schedule
    event_lookback_days: int = 20  # short window for event-triggered recomputes
    vol_spike_window: int = 5
    vol_spike_baseline: int = 60
    vol_spike_mult: float = 2.0
    min_overlap: int = 15  # min shared observations per pair


@dataclass(frozen=True, slots=True)
class ClusterSet:
    version: int
    computed_at: datetime
    trigger: str
    lookback_days: int
    threshold: float
    clusters: list[list[str]]  # sorted members, singletons included
    params: dict[str, Any] = field(default_factory=dict)


def compute_clusters(
    returns: pd.DataFrame,
    *,
    threshold: float = 0.7,
    min_overlap: int = 15,
) -> list[list[str]]:
    """Hierarchical clustering of instruments by |Pearson correlation|.

    `returns`: wide frame (index = date/bar, columns = instruments). Distance
    is 1 − |corr| with average linkage, cut at 1 − threshold. Pairs with fewer
    than `min_overlap` shared observations are treated as uncorrelated.
    """
    cols = [c for c in returns.columns if returns[c].notna().sum() >= min_overlap]
    if len(cols) == 0:
        return []
    if len(cols) == 1:
        return [[cols[0]]]
    corr = returns[cols].corr(method="pearson", min_periods=min_overlap)
    dist = 1.0 - corr.abs().to_numpy()
    np.fill_diagonal(dist, 0.0)
    dist = np.nan_to_num(dist, nan=1.0)  # insufficient overlap ⇒ uncorrelated
    dist = (dist + dist.T) / 2.0  # exact symmetry for squareform
    z = linkage(squareform(dist, checks=False), method="average")
    labels = fcluster(z, t=1.0 - threshold, criterion="distance")
    grouped: dict[int, list[str]] = {}
    for col, lab in zip(cols, labels, strict=True):
        grouped.setdefault(int(lab), []).append(col)
    return sorted((sorted(members) for members in grouped.values()), key=lambda g: g[0])


def realized_vol_spike(
    returns: pd.Series,
    *,
    window: int = 5,
    baseline: int = 60,
    mult: float = 2.0,
) -> bool:
    """True when short-window realized vol exceeds `mult` × the trailing-median
    rolling vol — the risk-off tripwire for the event-triggered recompute."""
    r = returns.dropna()
    if len(r) < baseline + window:
        return False
    rolling = r.rolling(window).std()
    recent = rolling.iloc[-1]
    med = rolling.iloc[:-window].tail(baseline).median()
    if not np.isfinite(recent) or not np.isfinite(med) or med <= 0:
        return False
    return bool(recent > mult * med)


def refresh_reason(
    now: datetime,
    last: ClusterSet | None,
    *,
    params: ClusterParams,
    liquidity_changed: bool = False,
    vol_spike: bool = False,
) -> str | None:
    """Why (if at all) clusters should be recomputed right now.

    Event triggers beat the schedule; the weekly cadence is the floor.
    """
    if last is None:
        return TRIGGER_BOOTSTRAP
    if vol_spike:
        return TRIGGER_VOL_SPIKE
    if liquidity_changed:
        return TRIGGER_LIQUIDITY
    if now.astimezone(UTC) - last.computed_at.astimezone(UTC) >= timedelta(
        days=params.refresh_days
    ):
        return TRIGGER_WEEKLY
    return None


def build_cluster_set(
    returns: pd.DataFrame,
    *,
    version: int,
    trigger: str,
    params: ClusterParams,
    now: datetime | None = None,
) -> ClusterSet:
    """Compute + wrap a versioned cluster set. Event triggers slice the SHORT
    window; scheduled/bootstrap runs use the full design lookback."""
    now = now or datetime.now(UTC)
    event = trigger in (TRIGGER_LIQUIDITY, TRIGGER_VOL_SPIKE)
    lookback = params.event_lookback_days if event else params.lookback_days
    window = returns.tail(lookback) if len(returns) > lookback else returns
    overlap = min(params.min_overlap, max(len(window) - 1, 2))
    clusters = compute_clusters(window, threshold=params.threshold, min_overlap=overlap)
    return ClusterSet(
        version=version,
        computed_at=now,
        trigger=trigger,
        lookback_days=lookback,
        threshold=params.threshold,
        clusters=clusters,
        params={
            "refresh_days": params.refresh_days,
            "event_lookback_days": params.event_lookback_days,
            "vol_spike_window": params.vol_spike_window,
            "vol_spike_baseline": params.vol_spike_baseline,
            "vol_spike_mult": params.vol_spike_mult,
            "min_overlap": params.min_overlap,
        },
    )
