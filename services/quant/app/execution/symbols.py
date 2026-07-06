"""QN-033 — per-broker symbol mapping table.

Seeded by the instrument registry (`app.market.instruments`, the Python mirror
of the BE-045 Node registry): every registry instrument MUST have a row here —
`test_symbols.py` enforces the invariant, so adding an instrument without a
mapping fails CI instead of failing at order time.

Canonical names are OANDA-style (EUR_USD), and OANDA is the sole venue
(QN-032 / ADR-005; the optional MT5 venue, QN-031, was dropped 2026-07-06) —
so today's mapping is identity. The table keeps its per-broker shape anyway:
all adapter code resolves through it, so a future venue with its own tickers
(e.g. EURUSD.r / USOIL-style names) is one new column, not a refactor.
"""

from __future__ import annotations

from typing import Literal

from app.market.instruments import _REGISTRY

Broker = Literal["oanda"]

# canonical → per-broker symbol. OANDA symbols are identity by construction.
_TABLE: dict[str, dict[Broker, str]] = {
    "EUR_USD": {"oanda": "EUR_USD"},
    "GBP_USD": {"oanda": "GBP_USD"},
    "USD_JPY": {"oanda": "USD_JPY"},
    "USD_CHF": {"oanda": "USD_CHF"},
    "AUD_USD": {"oanda": "AUD_USD"},
    "USD_CAD": {"oanda": "USD_CAD"},
    "NZD_USD": {"oanda": "NZD_USD"},
    "XAU_USD": {"oanda": "XAU_USD"},
    "WTICO_USD": {"oanda": "WTICO_USD"},
    "BCO_USD": {"oanda": "BCO_USD"},
}


class SymbolMappingError(KeyError):
    """Unknown instrument/symbol for the requested broker."""


def to_broker_symbol(instrument: str, broker: Broker = "oanda") -> str:
    """Canonical instrument → venue symbol; raises on unmapped instruments."""
    row = _TABLE.get(instrument)
    if row is None or broker not in row:
        raise SymbolMappingError(f"no {broker} symbol for instrument {instrument!r}")
    return row[broker]


def from_broker_symbol(symbol: str, broker: Broker = "oanda") -> str:
    """Venue symbol → canonical instrument (inverse of to_broker_symbol)."""
    for instrument, row in _TABLE.items():
        if row.get(broker) == symbol:
            return instrument
    raise SymbolMappingError(f"no instrument for {broker} symbol {symbol!r}")


def mapped_instruments() -> frozenset[str]:
    return frozenset(_TABLE)


def registry_instruments() -> frozenset[str]:
    """Instruments the ingestion registry knows — the seed set (BE-045 mirror)."""
    return frozenset(_REGISTRY)
