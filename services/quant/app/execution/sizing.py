"""QN-034 — cross-currency pip / lot / margin module.

Sizing math for any instrument × any account currency (the platform runs GBP
accounts against USD-quoted instruments — the story's acceptance fixture).
Pure functions over an injectable `RateProvider`, so backtests use historical
rates and live sizing uses current mid prices; nothing here talks to a venue.

Conventions:
- `units` are venue base units (OANDA convention): 1 unit EUR_USD = 1 EUR,
  1 unit XAU_USD = 1 oz, 1 unit WTICO_USD/BCO_USD = 1 barrel.
- pip sizes come from the instrument registry (0.0001 fx / 0.01 JPY-metal-energy).
- `rate(base, quote)` = units of `quote` per 1 `base`.
"""

from __future__ import annotations

from typing import Protocol

from app.market.instruments import get_instrument

# Standard lot sizes per instrument kind (MT5 parlance; OANDA is unit-based).
_LOT_FX = 100_000.0
_LOT_METAL = 100.0  # XAU: 100 oz
_LOT_ENERGY = 1_000.0  # oil CFDs: 1,000 barrels

_METALS = {"XAU_USD"}
_ENERGY = {"WTICO_USD", "BCO_USD"}


class RateProvider(Protocol):
    """`rate(base, quote)` → units of quote per 1 base. Raise KeyError if unknown."""

    def rate(self, base: str, quote: str) -> float: ...


class FixedRates:
    """Dict-backed RateProvider (test fixtures / point-in-time backtests).

    Resolves direct pairs, inverses, and one-hop pivots through USD:
    GBP→JPY works from {"GBP_USD": …, "USD_JPY": …}.
    """

    def __init__(self, pairs: dict[str, float]) -> None:
        self._pairs = dict(pairs)

    def rate(self, base: str, quote: str) -> float:
        if base == quote:
            return 1.0
        direct = self._pairs.get(f"{base}_{quote}")
        if direct:
            return direct
        inverse = self._pairs.get(f"{quote}_{base}")
        if inverse:
            return 1.0 / inverse
        if base != "USD" and quote != "USD":  # one-hop USD pivot
            return self.rate(base, "USD") * self.rate("USD", quote)
        raise KeyError(f"no rate for {base}->{quote}")


def split_instrument(instrument: str) -> tuple[str, str]:
    """EUR_USD → ("EUR", "USD"). Raises ValueError for non-canonical names."""
    base, sep, quote = instrument.partition("_")
    if not sep or not base or not quote:
        raise ValueError(f"not a canonical instrument name: {instrument!r}")
    return base, quote


def pip_size(instrument: str) -> float:
    return get_instrument(instrument).pip


def units_per_lot(instrument: str) -> float:
    if instrument in _METALS:
        return _LOT_METAL
    if instrument in _ENERGY:
        return _LOT_ENERGY
    return _LOT_FX


def pip_value(
    instrument: str,
    units: float,
    account_currency: str,
    rates: RateProvider,
) -> float:
    """Value of ONE pip for `units`, in the account currency.

    pip × units is an amount in the QUOTE currency; convert quote → account.
    e.g. 10,000 EUR_USD = 1 USD/pip → ×rate(USD, GBP) for a GBP account.
    """
    _, quote = split_instrument(instrument)
    return pip_size(instrument) * units * rates.rate(quote, account_currency)


def lot_pip_value(instrument: str, account_currency: str, rates: RateProvider) -> float:
    """Pip value of one standard lot — convenience over pip_value."""
    return pip_value(instrument, units_per_lot(instrument), account_currency, rates)


def margin_required(
    instrument: str,
    units: float,
    price: float,
    margin_rate: float,
    account_currency: str,
    rates: RateProvider,
) -> float:
    """Initial margin in the account currency.

    Notional = units × price (quote ccy) → × margin_rate → quote → account.
    `margin_rate` is the venue fraction (0.0333 ≈ 30:1 retail FX; OANDA
    exposes it per-account on /summary — the QN-032 adapter records it).
    """
    if not 0 < margin_rate <= 1:
        raise ValueError(f"margin_rate must be in (0, 1], got {margin_rate}")
    _, quote = split_instrument(instrument)
    notional_quote = abs(units) * price
    return notional_quote * margin_rate * rates.rate(quote, account_currency)


def units_for_risk(
    instrument: str,
    risk_amount: float,
    stop_pips: float,
    account_currency: str,
    rates: RateProvider,
) -> float:
    """Units such that `stop_pips` adverse movement ≈ `risk_amount` (account ccy).

    The QN-043 position sizer builds on this: units = risk / (stop × pip_value_per_unit).
    """
    if stop_pips <= 0 or risk_amount <= 0:
        raise ValueError("risk_amount and stop_pips must be positive")
    per_unit = pip_value(instrument, 1.0, account_currency, rates)
    return risk_amount / (stop_pips * per_unit)
