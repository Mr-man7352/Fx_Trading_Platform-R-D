"""QN-053 — purged/embargoed OOS validation suite.

Four independent statistical guards over a backtest's trade ledger; ANY
failure yields verdict `NOT VALIDATED`, which blocks live promotion (the
BE-101 gate consumes this verdict — story AC).

  1. Purged & embargoed OOS split — the last `oos_fraction` of trades is the
     out-of-sample cohort, separated from in-sample by an embargo of
     `embargo_trades`; OOS expectancy must not collapse vs in-sample
     (`oos_degradation_max`). Purged K-fold indices are also exported for
     model-level CV (train-time reuse).
  2. Deflated Sharpe ratio (Bailey & López de Prado) — probability that the
     observed Sharpe exceeds zero after correcting for multiple testing
     (`n_trials` = thresholds swept), non-normality (skew/kurtosis) and
     track length.
  3. Monte-Carlo drawdown — seeded bootstrap resampling of trade R-multiples;
     p95 of max drawdown (in R) must stay inside `mc_dd_p95_max_r`.
  4. Bootstrap p-value — seeded bootstrap of mean trade R; P(mean <= 0) must
     be below `bootstrap_p_max`.

Everything is deterministic under a fixed seed (replayable — design §1).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy import stats

# ─── Purged / embargoed splits ───────────────────────────────────────────────


def purged_kfold_indices(
    n: int,
    *,
    n_folds: int = 5,
    embargo: int = 24,
) -> list[dict[str, Any]]:
    """K contiguous test folds; training rows within `embargo` of a test fold
    boundary are PURGED (no label straddle, matches QN-043's trainer)."""
    if n < n_folds * 2:
        raise ValueError(f"not enough rows ({n}) for {n_folds} folds")
    edges = np.linspace(0, n, n_folds + 1, dtype=int)
    folds: list[dict[str, Any]] = []
    for k in range(n_folds):
        start, end = int(edges[k]), int(edges[k + 1])
        train = [i for i in range(n) if i < start - embargo or i >= end + embargo]
        folds.append({"fold": k, "test_start": start, "test_end": end, "train_indices": train})
    return folds


# ─── Deflated Sharpe ratio ───────────────────────────────────────────────────


def deflated_sharpe_ratio(
    sharpe: float,
    *,
    n_trials: int,
    n_obs: int,
    skew: float = 0.0,
    kurtosis: float = 3.0,
) -> float:
    """P(true Sharpe > 0) after multiple-testing + non-normality deflation.

    Bailey & López de Prado (2014). `sharpe` is per-period (NOT annualised);
    `n_obs` is the number of return observations behind it.
    """
    if not math.isfinite(sharpe) or n_obs < 3:
        return math.nan
    trials = max(int(n_trials), 1)
    # Expected max Sharpe under H0 across `trials` independent tries.
    if trials > 1:
        e = 0.5772156649015329  # Euler–Mascheroni
        z1 = stats.norm.ppf(1.0 - 1.0 / trials)
        z2 = stats.norm.ppf(1.0 - 1.0 / (trials * math.e))
        sr0 = math.sqrt(max(1.0 / n_obs, 1e-12)) * ((1.0 - e) * z1 + e * z2)
    else:
        sr0 = 0.0
    denom = math.sqrt(
        max(1.0 - skew * sharpe + ((kurtosis - 1.0) / 4.0) * sharpe**2, 1e-12) / (n_obs - 1)
    )
    return float(stats.norm.cdf((sharpe - sr0) / denom))


# ─── Monte-Carlo / bootstrap ─────────────────────────────────────────────────


def monte_carlo_drawdown(
    trade_rs: np.ndarray,
    *,
    n_paths: int = 2000,
    seed: int = 7,
) -> dict[str, float]:
    """Bootstrap-resampled max drawdown distribution, in R units."""
    rs = np.asarray(trade_rs, dtype=np.float64)
    if len(rs) == 0:
        return {"p50_r": math.nan, "p95_r": math.nan, "p99_r": math.nan}
    rng = np.random.default_rng(seed)
    maxdd = np.empty(n_paths)
    for k in range(n_paths):
        path = rng.choice(rs, size=len(rs), replace=True)
        equity = np.cumsum(path)
        peak = np.maximum.accumulate(np.concatenate(([0.0], equity)))[1:]
        maxdd[k] = float(np.max(peak - equity))
    return {
        "p50_r": float(np.percentile(maxdd, 50)),
        "p95_r": float(np.percentile(maxdd, 95)),
        "p99_r": float(np.percentile(maxdd, 99)),
    }


def bootstrap_pvalue(
    trade_rs: np.ndarray,
    *,
    n_boot: int = 5000,
    seed: int = 7,
) -> float:
    """P(mean trade R <= 0) via seeded bootstrap of the ledger."""
    rs = np.asarray(trade_rs, dtype=np.float64)
    if len(rs) == 0:
        return math.nan
    rng = np.random.default_rng(seed)
    means = np.array([rng.choice(rs, size=len(rs), replace=True).mean() for _ in range(n_boot)])
    return float((means <= 0.0).mean())


# ─── The verdict ─────────────────────────────────────────────────────────────

VERDICT_VALIDATED = "VALIDATED"
VERDICT_NOT_VALIDATED = "NOT VALIDATED"


@dataclass(frozen=True, slots=True)
class ValidationCriteria:
    min_trades: int = 100
    oos_fraction: float = 0.3
    embargo_trades: int = 5
    # OOS expectancy may not drop below this fraction of in-sample expectancy
    # (and must stay positive when IS is positive).
    oos_degradation_max: float = 0.5
    dsr_min: float = 0.90
    mc_dd_p95_max_r: float = 15.0
    bootstrap_p_max: float = 0.05
    seed: int = 7


def validate_backtest(
    trade_rs: list[float] | np.ndarray,
    *,
    n_trials: int = 7,
    criteria: ValidationCriteria | None = None,
) -> dict[str, Any]:
    """Full QN-053 suite over a trade ledger's R-multiples → verdict dict."""
    c = criteria or ValidationCriteria()
    rs = np.asarray(trade_rs, dtype=np.float64)
    reasons: list[str] = []

    if len(rs) < c.min_trades:
        reasons.append(f"n_trades {len(rs)} < min {c.min_trades} (underpowered)")

    # 1 — purged/embargoed OOS split (chronological trade order assumed).
    oos_n = max(int(len(rs) * c.oos_fraction), 1)
    is_end = max(len(rs) - oos_n - c.embargo_trades, 0)
    is_rs, oos_rs = rs[:is_end], rs[len(rs) - oos_n :]
    is_exp = float(is_rs.mean()) if len(is_rs) else math.nan
    oos_exp = float(oos_rs.mean()) if len(oos_rs) else math.nan
    if len(is_rs) and len(oos_rs) and math.isfinite(is_exp) and is_exp > 0:
        if oos_exp <= 0:
            reasons.append(f"OOS expectancy {oos_exp:.3f}R <= 0 while IS {is_exp:.3f}R > 0")
        elif oos_exp < c.oos_degradation_max * is_exp:
            reasons.append(
                f"OOS expectancy {oos_exp:.3f}R < {c.oos_degradation_max}x IS {is_exp:.3f}R"
            )

    # 2 — deflated Sharpe over per-trade returns.
    std = float(rs.std(ddof=1)) if len(rs) > 1 else 0.0
    trade_sharpe = float(rs.mean() / std) if std > 0 else math.nan
    dsr = deflated_sharpe_ratio(
        trade_sharpe,
        n_trials=n_trials,
        n_obs=len(rs),
        skew=float(stats.skew(rs)) if len(rs) > 2 else 0.0,
        kurtosis=float(stats.kurtosis(rs, fisher=False)) if len(rs) > 3 else 3.0,
    )
    if math.isfinite(dsr) and dsr < c.dsr_min:
        reasons.append(f"deflated Sharpe prob {dsr:.3f} < {c.dsr_min}")
    if not math.isfinite(dsr):
        reasons.append("deflated Sharpe undefined (degenerate ledger)")

    # 3 — Monte-Carlo drawdown.
    mc = monte_carlo_drawdown(rs, seed=c.seed)
    if math.isfinite(mc["p95_r"]) and mc["p95_r"] > c.mc_dd_p95_max_r:
        reasons.append(f"MC drawdown p95 {mc['p95_r']:.1f}R > {c.mc_dd_p95_max_r}R")

    # 4 — bootstrap p-value.
    p = bootstrap_pvalue(rs, seed=c.seed)
    if math.isfinite(p) and p > c.bootstrap_p_max:
        reasons.append(f"bootstrap P(mean<=0) {p:.3f} > {c.bootstrap_p_max}")

    verdict = VERDICT_VALIDATED if not reasons else VERDICT_NOT_VALIDATED
    return {
        "verdict": verdict,
        "blocks_live_promotion": verdict != VERDICT_VALIDATED,
        "reasons": reasons,
        "checks": {
            "n_trades": len(rs),
            "in_sample_expectancy_r": is_exp,
            "oos_expectancy_r": oos_exp,
            "oos_trades": len(oos_rs),
            "embargo_trades": c.embargo_trades,
            "trade_sharpe": trade_sharpe,
            "deflated_sharpe_prob": dsr,
            "n_trials": n_trials,
            "mc_drawdown": mc,
            "bootstrap_p_mean_le_0": p,
            "seed": c.seed,
        },
    }
