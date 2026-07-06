"""QN-030 — BrokerAdapter conformance suite.

Behavioral contract every execution adapter must satisfy. Parametrized over
adapter factories: OANDA (sole venue, ADR-005) runs against the stateful
FakeOanda transport. A future venue plugs in by adding a factory to
ADAPTER_FACTORIES — the assertions themselves must not change.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import pytest

from app.execution.adapter import BrokerAdapter
from app.execution.models import OrderRequest
from app.execution.oanda_adapter import OandaAdapter
from tests.execution.fake_oanda import FakeOanda


def _oanda() -> tuple[BrokerAdapter, Any]:
    fake = FakeOanda()
    adapter = OandaAdapter(
        api_token="test", account_id=fake.account_id, client=fake.client()
    )
    return adapter, fake


ADAPTER_FACTORIES = {"oanda": _oanda}


@pytest.fixture(params=sorted(ADAPTER_FACTORIES))
def rig(request: pytest.FixtureRequest) -> tuple[BrokerAdapter, Any]:
    return ADAPTER_FACTORIES[request.param]()


def _order(instrument: str = "EUR_USD", units: float = 10_000) -> OrderRequest:
    return OrderRequest(
        client_order_id=str(uuid4()), instrument=instrument, side="buy", units=units
    )


async def test_satisfies_protocol(rig: tuple[BrokerAdapter, Any]) -> None:
    adapter, _ = rig
    assert isinstance(adapter, BrokerAdapter)


async def test_connect(rig: tuple[BrokerAdapter, Any]) -> None:
    adapter, _ = rig
    await adapter.connect()  # must not raise


async def test_place_order_fills_with_trade_id(rig: tuple[BrokerAdapter, Any]) -> None:
    adapter, _ = rig
    await adapter.connect()
    result = await adapter.place_order(_order())
    assert result.status == "filled"
    assert result.broker_trade_id
    assert result.filled_units == pytest.approx(10_000)
    assert result.remainder_units == 0
    assert result.price and result.price > 0


async def test_place_order_idempotent_retry(rig: tuple[BrokerAdapter, Any]) -> None:
    """A retry with the same client_order_id returns the ORIGINAL fill —
    never a second execution."""
    adapter, _ = rig
    await adapter.connect()
    order = _order()
    first = await adapter.place_order(order)
    retry = await adapter.place_order(order)
    assert retry.status == "filled"
    assert retry.broker_trade_id == first.broker_trade_id
    positions = await adapter.get_positions()
    assert sum(p.units for p in positions if p.instrument == "EUR_USD") == pytest.approx(10_000)


async def test_get_positions_reflects_fill(rig: tuple[BrokerAdapter, Any]) -> None:
    adapter, _ = rig
    await adapter.connect()
    result = await adapter.place_order(_order("XAU_USD", 50))
    positions = await adapter.get_positions()
    match = [p for p in positions if p.instrument == "XAU_USD"]
    assert len(match) == 1
    assert match[0].side == "buy"
    assert match[0].units == pytest.approx(50)
    assert result.broker_trade_id in match[0].broker_trade_ids


async def test_close_order_round_trip(rig: tuple[BrokerAdapter, Any]) -> None:
    adapter, _ = rig
    await adapter.connect()
    placed = await adapter.place_order(_order())
    assert placed.broker_trade_id
    closed = await adapter.close_order(placed.broker_trade_id)
    assert closed.status == "filled"
    assert closed.broker_trade_id == placed.broker_trade_id
    assert all(p.instrument != "EUR_USD" for p in await adapter.get_positions())


async def test_close_unknown_trade_is_rejected_not_raised(
    rig: tuple[BrokerAdapter, Any],
) -> None:
    adapter, _ = rig
    await adapter.connect()
    result = await adapter.close_order("999999")
    assert result.status == "rejected"
    assert result.reason


async def test_get_history_returns_closed_trades(rig: tuple[BrokerAdapter, Any]) -> None:
    adapter, _ = rig
    await adapter.connect()
    placed = await adapter.place_order(_order())
    assert placed.broker_trade_id
    await adapter.close_order(placed.broker_trade_id)
    records = await adapter.get_history(datetime(2026, 1, 1, tzinfo=UTC))
    assert [r.broker_trade_id for r in records] == [placed.broker_trade_id]
    record = records[0]
    assert record.instrument == "EUR_USD"
    assert record.side == "buy"
    assert record.units == pytest.approx(10_000)
    assert record.closed_at is not None
    # since-filter: nothing closed after the cutoff
    assert await adapter.get_history(datetime(2027, 1, 1, tzinfo=UTC)) == []
