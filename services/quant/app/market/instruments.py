"""Minimal instrument registry for the ingestion runners (QN-021).

Mirrors the Node BE-045 registry (`apis/node-api/src/market/instruments.ts`) for
the fields the Python side needs: the Twelve Data cross-check symbol and the pip
size. Energy CFDs have no reliable Twelve Data symbol, so their cross-check is
skipped (symbol = None).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class InstrumentInfo:
    name: str
    twelve_data_symbol: str | None
    pip: float


_REGISTRY: dict[str, InstrumentInfo] = {
    "EUR_USD": InstrumentInfo("EUR_USD", "EUR/USD", 0.0001),
    "GBP_USD": InstrumentInfo("GBP_USD", "GBP/USD", 0.0001),
    "USD_JPY": InstrumentInfo("USD_JPY", "USD/JPY", 0.01),
    "USD_CHF": InstrumentInfo("USD_CHF", "USD/CHF", 0.0001),
    "AUD_USD": InstrumentInfo("AUD_USD", "AUD/USD", 0.0001),
    "USD_CAD": InstrumentInfo("USD_CAD", "USD/CAD", 0.0001),
    "NZD_USD": InstrumentInfo("NZD_USD", "NZD/USD", 0.0001),
    "XAU_USD": InstrumentInfo("XAU_USD", "XAU/USD", 0.01),
    "WTICO_USD": InstrumentInfo("WTICO_USD", None, 0.01),
    "BCO_USD": InstrumentInfo("BCO_USD", None, 0.01),
}


def get_instrument(name: str) -> InstrumentInfo:
    """Registry lookup; falls back to a 4-dp pip and no cross-check for unknowns."""
    return _REGISTRY.get(name, InstrumentInfo(name, None, 0.0001))
