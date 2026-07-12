"""QN-053 — validation suite tests: failing metrics ⇒ NOT VALIDATED blocks live."""

from __future__ import annotations

import numpy as np

from app.backtest.validation import (
    VERDICT_NOT_VALIDATED,
    VERDICT_VALIDATED,
    ValidationCriteria,
    bootstrap_pvalue,
    deflated_sharpe_ratio,
    monte_carlo_drawdown,
    purged_kfold_indices,
    validate_backtest,
)


def test_purged_folds_respect_the_embargo():
    folds = purged_kfold_indices(100, n_folds=5, embargo=10)
    assert len(folds) == 5
    for f in folds:
        for i in f["train_indices"]:
            assert i < f["test_start"] - 10 or i >= f["test_end"] + 10


def test_deflated_sharpe_shrinks_with_more_trials():
    one = deflated_sharpe_ratio(0.3, n_trials=1, n_obs=200)
    many = deflated_sharpe_ratio(0.3, n_trials=50, n_obs=200)
    assert many < one


def test_monte_carlo_drawdown_is_seed_deterministic():
    rng = np.random.default_rng(1)
    rs = rng.normal(0.05, 1.0, 300)
    a = monte_carlo_drawdown(rs, seed=7)
    b = monte_carlo_drawdown(rs, seed=7)
    assert a == b
    assert a["p95_r"] >= a["p50_r"]


def test_bootstrap_pvalue_separates_edge_from_noise():
    rng = np.random.default_rng(2)
    edge = rng.normal(0.5, 1.0, 400)  # clear positive expectancy
    noise = rng.normal(0.0, 1.0, 400)
    assert bootstrap_pvalue(edge, seed=7) < 0.05
    assert bootstrap_pvalue(noise, seed=7) > 0.05


def test_good_ledger_validates():
    rng = np.random.default_rng(3)
    rs = rng.normal(0.45, 0.9, 500)
    report = validate_backtest(rs, n_trials=7)
    assert report["verdict"] == VERDICT_VALIDATED
    assert report["blocks_live_promotion"] is False
    assert report["reasons"] == []


def test_edgeless_ledger_is_not_validated_and_blocks_live():
    """Story AC: failing validation ⇒ NOT VALIDATED blocks live promotion."""
    rng = np.random.default_rng(4)
    rs = rng.normal(0.0, 1.0, 500)  # no edge
    report = validate_backtest(rs, n_trials=7)
    assert report["verdict"] == VERDICT_NOT_VALIDATED
    assert report["blocks_live_promotion"] is True
    assert len(report["reasons"]) > 0


def test_underpowered_sample_fails_min_trades():
    report = validate_backtest([0.5, 1.0, -1.0], n_trials=1)
    assert report["verdict"] == VERDICT_NOT_VALIDATED
    assert any("underpowered" in r for r in report["reasons"])


def test_oos_collapse_detected():
    """In-sample edge that disappears out-of-sample must fail the split."""
    is_leg = np.full(300, 0.6)
    oos_leg = np.full(150, -0.4)
    report = validate_backtest(
        np.concatenate([is_leg, oos_leg]),
        n_trials=1,
        criteria=ValidationCriteria(min_trades=100),
    )
    assert report["verdict"] == VERDICT_NOT_VALIDATED
    assert any("OOS" in r for r in report["reasons"])
