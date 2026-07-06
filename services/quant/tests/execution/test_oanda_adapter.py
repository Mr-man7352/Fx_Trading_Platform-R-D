"""QN-032 — OANDA adapter edge cases beyond the conformance suite:
partial fills, venue rejects, duplicate-id recovery path, symbol coverage,
connect metadata, transport errors."""

from __future__ import annotations

import json

import httpx
import pytest

from app.execution.adapter import BrokerError
from app.execution.models import OrderRequest
from app.execution.oanda_adapter import OandaAdapter
from app.execution.symbols import SymbolMappingError, mapped_instruments
from tests.execution.fake_oanda import PRICES, FakeOanda

ACCOUNT = "101-004-1-001"


def _adapter(fake: FakeOanda) -> OandaAdapter:
    return OandaAdapter(api_token="test", account_id=fake.account_id, client=fake.client())


def _order(instrument: str = "EUR_USD", units: float = 100) -> OrderRequest:
    return OrderRequest(instrument=instrument, side="buy", units=units)


async def test_connect_records_account_currency_and_margin_rate() -> None:
    adapter = _adapter(FakeOanda(currency="GBP", margin_rate=0.05))
    await adapter.connect()
    assert adapter.account_currency == "GBP"
    assert adapter.margin_rate == pytest.approx(0.05)


async def test_connect_auth_failure_raises_broker_error() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"errorMessage": "Insufficient authorization"})

    client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="https://api-fxpractice.oanda.com"
    )
    adapter = OandaAdapter(api_token="bad", account_id=ACCOUNT, client=client)
    with pytest.raises(BrokerError, match="401"):
        await adapter.connect()


async def test_partial_fill_returns_remainder() -> None:
    """QN-032 AC: fill_qty < requested_qty → partial + remainder for the worker."""
    fake = FakeOanda(fill_fraction={"EUR_USD": 0.6})
    result = await _adapter(fake).place_order(_order(units=100))
    assert result.status == "partial"
    assert result.filled_units == pytest.approx(60)
    assert result.remainder_units == pytest.approx(40)


async def test_venue_reject_returns_rejected_result() -> None:
    fake = FakeOanda(reject_reason="MARKET_HALTED")
    result = await _adapter(fake).place_order(_order())
    assert result.status == "rejected"
    assert result.reason == "MARKET_HALTED"
    assert result.filled_units == 0


async def test_duplicate_client_id_recovers_original_fill() -> None:
    """QN-032 AC: idempotency via clientExtensions.id — the duplicate reject
    path resolves the original order and returns its fill."""
    fake = FakeOanda()
    adapter = _adapter(fake)
    order = _order()
    first = await adapter.place_order(order)
    retry = await adapter.place_order(order)
    assert fake.order_posts == 2  # second POST happened…
    assert retry.broker_trade_id == first.broker_trade_id  # …but same execution
    assert retry.filled_units == pytest.approx(first.filled_units)
    assert retry.price == pytest.approx(first.price or 0.0)


async def test_symbol_mapping_resolves_for_all_configured_instruments() -> None:
    """QN-032/QN-033 AC: FX majors + XAU + oil all place with correct symbols."""
    fake = FakeOanda()
    adapter = _adapter(fake)
    for instrument in sorted(mapped_instruments()):
        result = await adapter.place_order(_order(instrument, units=10))
        assert result.status == "filled", instrument
        assert result.price == pytest.approx(PRICES[instrument])


async def test_unmapped_instrument_fails_before_hitting_the_wire() -> None:
    fake = FakeOanda()
    adapter = _adapter(fake)
    with pytest.raises(SymbolMappingError):
        await adapter.place_order(_order("DOGE_USD"))
    assert fake.order_posts == 0


async def test_order_body_carries_client_extensions_and_protections() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(
            201,
            json={
                "orderFillTransaction": {
                    "id": "1",
                    "units": "100",
                    "price": "1.1",
                    "tradeOpened": {"tradeID": "42"},
                }
            },
        )

    client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="https://api-fxpractice.oanda.com"
    )
    adapter = OandaAdapter(api_token="t", account_id=ACCOUNT, client=client)
    order = OrderRequest(
        client_order_id="fx-abc-1",
        instrument="EUR_USD",
        side="sell",
        units=100,
        stop_loss_price=1.2,
        take_profit_price=1.0,
    )
    result = await adapter.place_order(order)
    body = captured["order"]
    assert isinstance(body, dict)
    assert body["clientExtensions"] == {"id": "fx-abc-1"}
    assert body["units"] == "-100"  # sell → negative units
    assert body["stopLossOnFill"] == {"price": "1.2"}
    assert body["takeProfitOnFill"] == {"price": "1"}
    assert result.broker_trade_id == "42"


async def test_transport_5xx_raises_broker_error() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"errorMessage": "unavailable"})

    client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="https://api-fxpractice.oanda.com"
    )
    adapter = OandaAdapter(api_token="t", account_id=ACCOUNT, client=client)
    with pytest.raises(BrokerError):
        await adapter.place_order(_order())
