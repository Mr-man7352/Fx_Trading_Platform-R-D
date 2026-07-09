"""QN-041 — trend regime (Gaussian HMM) + separate liquidity regime.

Trend regime: a 3-state Gaussian HMM over [return, rolling-vol] observations,
fit on the TRAILING window only (refit per pipeline run — no future data
relative to the bar being scored), fixed seed ⇒ deterministic. States map to
labels by their mean return: lowest → TREND_DOWN, highest → TREND_UP, the
rest → RANGE. Posterior entropy at the last bar drives agent debate depth
(0/1/2 rounds — design §9.4).

Liquidity regime is DISTINCT from trend regime (design §5 note): derived from
the spread percentile and volume percentile of the current bar.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import StrEnum

import numpy as np
import pandas as pd
from hmmlearn.hmm import GaussianHMM
from numpy.typing import NDArray
from sklearn.metrics import adjusted_rand_score

DEFAULT_SEED = 7
_N_STATES = 3


class TrendRegime(StrEnum):
    TREND_UP = "TREND_UP"
    TREND_DOWN = "TREND_DOWN"
    RANGE = "RANGE"


class LiquidityRegime(StrEnum):
    HIGH = "HIGH"
    NORMAL = "NORMAL"
    LOW = "LOW"


@dataclass(frozen=True, slots=True)
class RegimeResult:
    """Trend-regime output for one pipeline run."""

    label: TrendRegime  # regime at the last bar
    timeline: list[TrendRegime]  # per-bar labels over the input window
    entropy: float  # normalized posterior entropy at last bar, 0..1
    debate_rounds: int  # 0 | 1 | 2 (design §9.4 mapping)


def _observations(returns: pd.Series) -> tuple[NDArray[np.float64], NDArray[np.bool_]]:
    ret = returns.to_numpy(dtype=np.float64)
    vol = pd.Series(ret).rolling(20, min_periods=5).std().to_numpy()
    obs = np.column_stack([ret, vol])
    mask = np.isfinite(obs).all(axis=1)
    return obs[mask], mask


def _fit(obs: NDArray[np.float64], seed: int) -> GaussianHMM:
    model = GaussianHMM(
        n_components=_N_STATES,
        covariance_type="diag",
        n_iter=200,
        tol=1e-4,
        random_state=seed,
        min_covar=1e-10,
    )
    model.fit(obs)
    return model


def _state_labels(model: GaussianHMM) -> dict[int, TrendRegime]:
    """Map HMM states to labels by mean return (dim 0), scale-relative.

    Any state whose mean return is directional beyond 0.1× the average state
    volatility is a trend (the HMM may split one drift phase across states);
    near-zero-mean states are RANGE. A symmetric-noise fit labels all RANGE.
    """
    means = model.means_[:, 0]
    scale = float(np.sqrt(model.covars_[:, 0].mean())) or 1.0
    threshold = 0.1 * scale
    mapping: dict[int, TrendRegime] = {}
    for s in range(_N_STATES):
        m = float(means[s])
        if m > threshold:
            mapping[s] = TrendRegime.TREND_UP
        elif m < -threshold:
            mapping[s] = TrendRegime.TREND_DOWN
        else:
            mapping[s] = TrendRegime.RANGE
    return mapping


def debate_rounds(entropy: float) -> int:
    """Design §9.4: low uncertainty → 0 rounds, medium → 1, high → 2."""
    if entropy < 1 / 3:
        return 0
    if entropy < 2 / 3:
        return 1
    return 2


def detect_trend_regime(returns: pd.Series, *, seed: int = DEFAULT_SEED) -> RegimeResult:
    """Fit the HMM on the trailing window and label it (deterministic per seed)."""
    obs, mask = _observations(returns)
    if len(obs) < 50:
        raise ValueError(f"need >= 50 finite observations for regime detection, got {len(obs)}")
    model = _fit(obs, seed)
    mapping = _state_labels(model)
    states = model.predict(obs)
    posterior = model.predict_proba(obs)[-1]
    raw_entropy = -(posterior * np.log(np.clip(posterior, 1e-12, 1.0))).sum()
    entropy = min(max(float(raw_entropy / math.log(_N_STATES)), 0.0), 1.0)

    labels_masked = [mapping[int(s)] for s in states]
    timeline: list[TrendRegime] = []
    it = iter(labels_masked)
    last = TrendRegime.RANGE
    for m in mask:
        if m:
            last = next(it)
        timeline.append(last)  # warmup rows inherit first known label region
    return RegimeResult(
        label=labels_masked[-1],
        timeline=timeline,
        entropy=entropy,
        debate_rounds=debate_rounds(entropy),
    )


def fold_stability(returns: pd.Series, *, n_folds: int = 3, seed: int = DEFAULT_SEED) -> float:
    """Out-of-sample stability metric (QN-041 AC): fit the HMM on overlapping
    folds and score label agreement on the shared segments (adjusted Rand,
    averaged; 1.0 = perfectly stable). Run by the training CLI / monitoring,
    not on the per-bar hot path."""
    obs, _ = _observations(returns)
    n = len(obs)
    if n < 150 or n_folds < 2:
        raise ValueError("need >= 150 observations and >= 2 folds for stability")
    fold_len = n // (n_folds + 1) * 2  # 50% overlap between consecutive folds
    step = fold_len // 2
    scores: list[float] = []
    prev_states: NDArray[np.str_] | None = None
    prev_start = 0
    for k in range(n_folds):
        start = k * step
        end = min(start + fold_len, n)
        seg = obs[start:end]
        model = _fit(seg, seed)
        mapping = _state_labels(model)
        states = np.array([mapping[int(s)].value for s in model.predict(seg)])
        if prev_states is not None:
            lo = start  # overlap = [start, prev_end)
            prev_end = prev_start + len(prev_states)
            hi = min(prev_end, end)
            if hi - lo > 30:
                a = prev_states[lo - prev_start : hi - prev_start]
                b = states[0 : hi - lo]
                scores.append(float(adjusted_rand_score(a, b)))
        prev_states, prev_start = states, start
    if not scores:
        raise ValueError("folds produced no overlapping segments")
    return float(np.mean(scores))


def liquidity_regime(
    spread_pctile: float | None, volume_pctile: float | None
) -> LiquidityRegime:
    """Spread/volume percentiles (0..1, trailing causal window) → liquidity label.

    Wide spreads or thin volume ⇒ LOW (Christmas week, Asian session for EUR
    pairs); tight spreads with strong volume ⇒ HIGH. Missing data ⇒ NORMAL —
    never fake precision. The LOW flag surfaces to the risk gate for spread
    multiplier tightening (QN-041 AC).
    """
    if spread_pctile is None or volume_pctile is None:
        return LiquidityRegime.NORMAL
    if not (0 <= spread_pctile <= 1 and 0 <= volume_pctile <= 1):
        raise ValueError("percentiles must be in [0, 1]")
    if spread_pctile >= 0.8 or volume_pctile <= 0.2:
        return LiquidityRegime.LOW
    if spread_pctile <= 0.3 and volume_pctile >= 0.6:
        return LiquidityRegime.HIGH
    return LiquidityRegime.NORMAL


def volume_pctile(volume: pd.Series, *, window: int = 500, min_periods: int = 20) -> float | None:
    """Causal trailing percentile rank of the LAST bar's volume."""
    ranked = volume.rolling(window, min_periods=min_periods).rank(pct=True)
    val = ranked.iloc[-1]
    return None if pd.isna(val) else float(val)
