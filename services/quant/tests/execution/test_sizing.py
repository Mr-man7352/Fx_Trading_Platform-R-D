"""QN-034 AC — pip value + margin per instrument × GBP account at a fixed
rates fixture. Rates chosen so expected values are hand-checkable."""

from __future__ import annotations

import pytest

from app.execution.sizing import (
    FixedRates,
    lot_pip_value,
    margin_required,
    pip_size,
    pip_value,
    split_instrument,
    units_for_risk,
    units_per_lot,
)

# "Live rates" fixture (QN-034 AC): GBP account, USD pivot available.
RATES = FixedRates(
    {
        "EUR_USD": 1.1000,
        "GBP_USD": 1.2500,  # → rate(USD, GBP) = 0.8
        "USD_JPY": 150.00,
        "USD_CHF": 0.9000,
        "AUD_USD": 0.6500,
        "USD_CAD": 1.3500,
        "NZD_USD": 0.6000,
        "XAU_USD": 2400.0,
    }
)


def test_split_instrument() -> None:
    assert split_instrument("EUR_USD") == ("EUR", "USD")
    with pytest.raises(ValueError, match="canonical"):
        split_instrument("EURUSD")


def test_pip_sizes_from_registry() -> None:
    assert pip_size("EUR_USD") == pytest.approx(0.0001)
    assert pip_size("USD_JPY") == pytest.approx(0.01)
    assert pip_size("XAU_USD") == pytest.approx(0.01)


def test_units_per_lot_by_kind() -> None:
    assert units_per_lot("EUR_USD") == 100_000
    assert units_per_lot("XAU_USD") == 100
    assert units_per_lot("WTICO_USD") == 1_000


# ── pip value, GBP account (the story's acceptance fixture) ────────────────


def test_pip_value_usd_quoted_pair_gbp_account() -> None:
    # 10k EUR_USD: 0.0001 × 10_000 = 1 USD/pip → × 0.8 = 0.80 GBP
    assert pip_value("EUR_USD", 10_000, "GBP", RATES) == pytest.approx(0.80)


def test_pip_value_jpy_quoted_pair_gbp_account() -> None:
    # 10k USD_JPY: 0.01 × 10_000 = 100 JPY/pip → /150 = 2/3 USD → × 0.8 GBP
    expected = 100 / 150 * 0.8
    assert pip_value("USD_JPY", 10_000, "GBP", RATES) == pytest.approx(expected)


def test_pip_value_chf_quoted_pair_gbp_account() -> None:
    # 10k USD_CHF: 0.0001 × 10_000 = 1 CHF/pip → /0.9 USD → × 0.8 GBP
    expected = 1 / 0.9 * 0.8
    assert pip_value("USD_CHF", 10_000, "GBP", RATES) == pytest.approx(expected)


def test_pip_value_gold_gbp_account() -> None:
    # 100 oz XAU_USD: 0.01 × 100 = 1 USD/pip → 0.80 GBP
    assert pip_value("XAU_USD", 100, "GBP", RATES) == pytest.approx(0.80)


def test_pip_value_identity_when_account_is_quote_ccy() -> None:
    assert pip_value("EUR_USD", 10_000, "USD", RATES) == pytest.approx(1.0)


def test_lot_pip_value_standard_lot() -> None:
    # 100k EUR_USD = 10 USD/pip → 8 GBP
    assert lot_pip_value("EUR_USD", "GBP", RATES) == pytest.approx(8.0)


# ── margin, GBP account ─────────────────────────────────────────────────────


def test_margin_eur_usd_gbp_account() -> None:
    # 10k × 1.10 = 11_000 USD notional × 0.0333 → × 0.8 = 293.04 GBP
    expected = 10_000 * 1.10 * 0.0333 * 0.8
    assert margin_required("EUR_USD", 10_000, 1.10, 0.0333, "GBP", RATES) == pytest.approx(expected)


def test_margin_usd_jpy_gbp_account() -> None:
    # 10k × 150 = 1.5m JPY notional × 0.0333 → /150 USD → × 0.8 GBP
    expected = 10_000 * 150 * 0.0333 / 150 * 0.8
    assert margin_required("USD_JPY", 10_000, 150.0, 0.0333, "GBP", RATES) == pytest.approx(
        expected
    )


def test_margin_uses_abs_units() -> None:
    long_m = margin_required("EUR_USD", 10_000, 1.10, 0.05, "GBP", RATES)
    short_m = margin_required("EUR_USD", -10_000, 1.10, 0.05, "GBP", RATES)
    assert long_m == pytest.approx(short_m)


def test_margin_rate_validation() -> None:
    with pytest.raises(ValueError, match="margin_rate"):
        margin_required("EUR_USD", 10_000, 1.10, 0.0, "GBP", RATES)


# ── risk-based sizing helper ────────────────────────────────────────────────


def test_units_for_risk_round_trips_pip_value() -> None:
    # Risk 100 GBP over a 25-pip stop on EUR_USD.
    units = units_for_risk("EUR_USD", 100.0, 25.0, "GBP", RATES)
    assert pip_value("EUR_USD", units, "GBP", RATES) * 25 == pytest.approx(100.0)


def test_units_for_risk_validation() -> None:
    with pytest.raises(ValueError, match="positive"):
        units_for_risk("EUR_USD", -1.0, 25.0, "GBP", RATES)


# ── FixedRates provider ─────────────────────────────────────────────────────


def test_fixed_rates_direct_inverse_identity_pivot() -> None:
    assert RATES.rate("GBP", "USD") == pytest.approx(1.25)
    assert RATES.rate("USD", "GBP") == pytest.approx(0.8)
    assert RATES.rate("GBP", "GBP") == 1.0
    # GBP → JPY pivots through USD: 1.25 × 150
    assert RATES.rate("GBP", "JPY") == pytest.approx(187.5)
    with pytest.raises(KeyError):
        RATES.rate("SEK", "NOK")
