"""BE-050 — ExecutionService unit tests (no network; servicer called directly)."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch
from uuid import uuid4

import grpc
import pytest

from app.execution.oanda_adapter import OandaAdapter
from app.grpc.execution_servicer import ExecutionServicer
from app.proto_gen import quant_pb2
from tests.execution.fake_oanda import FakeOanda


async def _adapter(fake: FakeOanda) -> OandaAdapter:
    adapter = OandaAdapter(api_token="test", account_id=fake.account_id, client=fake.client())
    await adapter.connect()
    return adapter


@pytest.fixture
def servicer() -> ExecutionServicer:
    return ExecutionServicer()


async def test_place_order_fills(servicer: ExecutionServicer) -> None:
    fake = FakeOanda()
    adapter = await _adapter(fake)
    ctx = AsyncMock(spec=grpc.aio.ServicerContext)
    with patch("app.grpc.execution_servicer.load_adapter", new=AsyncMock(return_value=adapter)):
        resp = await servicer.PlaceOrder(
            quant_pb2.PlaceOrderRequest(
                client_order_id=str(uuid4()),
                instrument="EUR_USD",
                side=quant_pb2.TRADE_SIDE_LONG,
                units=10_000,
                stop_loss_price=1.09,
            ),
            ctx,
        )
    assert resp.status == quant_pb2.EXECUTION_STATUS_FILLED
    assert resp.broker_trade_id


async def test_place_order_rejected(servicer: ExecutionServicer) -> None:
    fake = FakeOanda(reject_reason="INSUFFICIENT_MARGIN")
    adapter = await _adapter(fake)
    ctx = AsyncMock(spec=grpc.aio.ServicerContext)
    with patch("app.grpc.execution_servicer.load_adapter", new=AsyncMock(return_value=adapter)):
        resp = await servicer.PlaceOrder(
            quant_pb2.PlaceOrderRequest(
                client_order_id=str(uuid4()),
                instrument="EUR_USD",
                side=quant_pb2.TRADE_SIDE_LONG,
                units=10_000,
            ),
            ctx,
        )
    assert resp.status == quant_pb2.EXECUTION_STATUS_REJECTED
    assert resp.reason_code == "INSUFFICIENT_MARGIN"


async def test_get_transactions(servicer: ExecutionServicer) -> None:
    fake = FakeOanda()
    adapter = await _adapter(fake)
    ctx = AsyncMock(spec=grpc.aio.ServicerContext)
    client_id = str(uuid4())
    with patch("app.grpc.execution_servicer.load_adapter", new=AsyncMock(return_value=adapter)):
        await servicer.PlaceOrder(
            quant_pb2.PlaceOrderRequest(
                client_order_id=client_id,
                instrument="EUR_USD",
                side=quant_pb2.TRADE_SIDE_LONG,
                units=1_000,
            ),
            ctx,
        )
        resp = await servicer.GetTransactions(quant_pb2.GetTransactionsRequest(), ctx)
    assert len(resp.transactions) >= 1
    assert resp.last_txn_id
