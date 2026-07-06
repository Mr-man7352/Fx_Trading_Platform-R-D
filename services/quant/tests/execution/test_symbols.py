"""QN-033 — symbol mapping: registry coverage invariant + round-trips."""

from __future__ import annotations

import pytest

from app.execution.symbols import (
    SymbolMappingError,
    from_broker_symbol,
    mapped_instruments,
    registry_instruments,
    to_broker_symbol,
)


def test_every_registry_instrument_is_mapped() -> None:
    """The invariant that makes QN-033 a table, not a convention: adding an
    instrument to the registry without a mapping row fails CI here."""
    assert registry_instruments() <= mapped_instruments()


def test_oanda_mapping_is_identity() -> None:
    for instrument in mapped_instruments():
        assert to_broker_symbol(instrument, "oanda") == instrument


def test_round_trip_all_instruments() -> None:
    for instrument in mapped_instruments():
        symbol = to_broker_symbol(instrument, "oanda")
        assert from_broker_symbol(symbol, "oanda") == instrument


def test_unknown_instrument_raises() -> None:
    with pytest.raises(SymbolMappingError):
        to_broker_symbol("DOGE_USD", "oanda")


def test_unknown_symbol_raises() -> None:
    with pytest.raises(SymbolMappingError):
        from_broker_symbol("DOGEUSD", "oanda")
