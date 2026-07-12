"""QN-050 — cost-model unit tests (swap/rollover/gap/flash, DST-aware)."""

from __future__ import annotations

from datetime import UTC, datetime

from app.backtest.costs import (
    CostParams,
    effective_spread_pips,
    pip_size,
    stop_exit_slippage_pips,
    swap_pips,
)


def test_pip_size_conventions():
    assert pip_size("EUR_USD") == 0.0001
    assert pip_size("USD_JPY") == 0.01
    assert pip_size("XAU_USD") == 0.01
    assert pip_size("BCO_USD") == 0.01


def test_effective_spread_prefers_observation():
    assert effective_spread_pips("EUR_USD", 1.7, "LONDON") == 1.7


def test_effective_spread_session_multiplier_off_hours():
    london = effective_spread_pips("EUR_USD", None, "LONDON")
    off = effective_spread_pips("EUR_USD", None, "OFF_HOURS")
    assert off == london * 1.5


def test_swap_zero_when_no_rollover_crossed():
    p = CostParams()
    # A few hours inside one NY trading day (17:00-NY never crossed).
    total, crossings, triples = swap_pips(
        datetime(2026, 7, 6, 10, 0, tzinfo=UTC), datetime(2026, 7, 6, 15, 0, tzinfo=UTC), p
    )
    assert (total, crossings, triples) == (0.0, 0, 0)


def test_wednesday_triple_swap_books_three_days():
    """AC: Wednesday triple-swap on a multi-day XAU hold hits the P&L."""
    p = CostParams(financing_pips_per_day=1.0)
    # Monday 2026-07-06 12:00 UTC → Thursday 2026-07-09 12:00 UTC crosses
    # Mon/Tue/Wed 17:00-NY rollovers; the Wednesday one books 3 days ⇒ 5 total.
    total, crossings, triples = swap_pips(
        datetime(2026, 7, 6, 12, 0, tzinfo=UTC), datetime(2026, 7, 9, 12, 0, tzinfo=UTC), p
    )
    assert crossings == 3
    assert triples == 1
    assert total == 5.0


def test_stop_slippage_normal_vs_flash():
    p = CostParams(stop_slippage_frac=0.5, flash_pctile=0.99, flash_slippage_mult=10.0)
    normal, flash = stop_exit_slippage_pips(2.0, 0.5, p)
    assert (normal, flash) == (1.0, False)
    spiked, is_flash = stop_exit_slippage_pips(2.0, 0.995, p)
    assert is_flash is True
    assert spiked == 10.0  # 2.0 × 0.5 × 10 — documented in tail-risk report
