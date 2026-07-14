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
    adapter = OandaAdapter(api_token="test", account_id=fake.account_id, client=fake.client())
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


async def test_modify_trade_updates_stop(rig: tuple[BrokerAdapter, Any]) -> None:
    adapter, fake = rig
    await adapter.connect()
    placed = await adapter.place_order(_order())
    assert placed.broker_trade_id
    result = await adapter.modify_trade(placed.broker_trade_id, stop_loss_price=1.095)
    assert result.status == "filled"
    if isinstance(fake, FakeOanda):
        assert fake._stop_loss[placed.broker_trade_id] == pytest.approx(1.095)


async def test_get_transactions_after_fill(rig: tuple[BrokerAdapter, Any]) -> None:
    adapter, _ = rig
    await adapter.connect()
    order = _order()
    await adapter.place_order(order)
    # No explicit since-id → bootstrap from the connect()-time high-water mark.
    txs = await adapter.get_transactions()
    assert len(txs) >= 1
    fill = next(tx for tx in txs if tx.client_order_id == order.client_order_id)
    # ORDER_FILL carries the opened trade ONLY in trade_opened_id — a faithful
    # venue never sets a top-level trade id on fills (BE-052 relies on this).
    assert fill.trade_opened_id
    assert fill.trades_closed == ()


async def test_get_transactions_bootstrap_advances_without_activity(
    rig: tuple[BrokerAdapter, Any],
) -> None:
    adapter, _ = rig
    await adapter.connect()
    assert adapter.last_transaction_id  # seeded at connect
    txs = await adapter.get_transactions()
    assert txs == []  # nothing happened since connect
    assert adapter.last_transaction_id  # high-water survives an empty poll


async def test_full_close_reports_trades_closed(rig: tuple[BrokerAdapter, Any]) -> None:
    adapter, _ = rig
    await adapter.connect()
    placed = await adapter.place_order(_order())
    assert placed.broker_trade_id
    since = adapter.last_transaction_id
    await adapter.close_order(placed.broker_trade_id)
    txs = await adapter.get_transactions(since)
    close_fills = [tx for tx in txs if tx.trades_closed]
    assert len(close_fills) == 1
    (tc,) = close_fills[0].trades_closed
    assert tc.trade_id == placed.broker_trade_id
    assert tc.units == pytest.approx(10_000)
    assert close_fills[0].trade_reduced is None


async def test_partial_close_reports_trade_reduced_and_stays_open(
    rig: tuple[BrokerAdapter, Any],
) -> None:
    adapter, _ = rig
    await adapter.connect()
    placed = await adapter.place_order(_order())
    assert placed.broker_trade_id
    since = adapter.last_transaction_id
    result = await adapter.close_order(placed.broker_trade_id, 4_000)
    assert result.status == "filled"
    txs = await adapter.get_transactions(since)
    reduced = [tx for tx in txs if tx.trade_reduced]
    assert len(reduced) == 1
    assert reduced[0].trade_reduced is not None
    assert reduced[0].trade_reduced.trade_id == placed.broker_trade_id
    assert reduced[0].trade_reduced.units == pytest.approx(4_000)
    assert reduced[0].trades_closed == ()
    # Trade must remain open at the venue with the remaining units.
    positions = [p for p in await adapter.get_positions() if p.instrument == "EUR_USD"]
    assert len(positions) == 1
    assert positions[0].units == pytest.approx(6_000)
    assert placed.broker_trade_id in positions[0].broker_trade_ids
