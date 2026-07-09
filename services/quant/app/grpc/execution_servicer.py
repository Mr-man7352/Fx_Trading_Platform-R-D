"""BE-050 — ExecutionService gRPC servicer (Step 2.2).

Delegates to the QN-030 BrokerAdapter. Broker rejects map to structured
responses (status=REJECTED, reason_code) — never a gRPC error. Only transport
or config failures produce gRPC errors.
"""

from __future__ import annotations

from datetime import UTC, datetime

import grpc
from google.protobuf import timestamp_pb2

from app.execution.adapter import BrokerError
from app.execution.factory import load_adapter, reset_adapter_cache
from app.execution.models import OrderRequest, OrderResult, TradeReduceInfo
from app.proto_gen import quant_pb2, quant_pb2_grpc

_STATUS_MAP = {
    "filled": quant_pb2.EXECUTION_STATUS_FILLED,
    "partial": quant_pb2.EXECUTION_STATUS_PARTIAL,
    "rejected": quant_pb2.EXECUTION_STATUS_REJECTED,
}

_SIDE_TO_ORDER = {
    quant_pb2.TRADE_SIDE_LONG: "buy",
    quant_pb2.TRADE_SIDE_SHORT: "sell",
}

_SIDE_TO_PROTO = {
    "buy": quant_pb2.TRADE_SIDE_LONG,
    "sell": quant_pb2.TRADE_SIDE_SHORT,
}


def _ts(dt: datetime) -> timestamp_pb2.Timestamp:
    t = timestamp_pb2.Timestamp()
    t.FromDatetime(dt.astimezone(UTC))
    return t


def _trade_reduce_msg(tc: TradeReduceInfo) -> quant_pb2.TradeReduceMsg:
    return quant_pb2.TradeReduceMsg(
        trade_id=tc.trade_id,
        units=tc.units,
        price=tc.price or 0.0,
        realized_pl=tc.realized_pl,
        financing=tc.financing,
    )


def _order_result_response(result: OrderResult, *, broker: str) -> quant_pb2.PlaceOrderResponse:
    return quant_pb2.PlaceOrderResponse(
        status=_STATUS_MAP.get(result.status, quant_pb2.EXECUTION_STATUS_UNSPECIFIED),
        broker=broker,
        broker_order_id=result.broker_order_id or "",
        broker_trade_id=result.broker_trade_id or "",
        requested_units=result.requested_units,
        filled_units=result.filled_units,
        remainder_units=result.remainder_units,
        fill_price=result.price or 0.0,
        reason_code=result.reason or "",
    )


class ExecutionServicer(quant_pb2_grpc.ExecutionServiceServicer):
    """gRPC bridge from Node workers to the Python BrokerAdapter."""

    async def PlaceOrder(
        self,
        request: quant_pb2.PlaceOrderRequest,
        context: grpc.aio.ServicerContext,
    ) -> quant_pb2.PlaceOrderResponse:
        side = _SIDE_TO_ORDER.get(request.side)
        if side is None:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, "side is required")
            raise AssertionError("unreachable")
        order = OrderRequest(
            client_order_id=request.client_order_id,
            instrument=request.instrument,
            side=side,  # type: ignore[arg-type]
            units=request.units,
            stop_loss_price=request.stop_loss_price or None,
            take_profit_price=request.take_profit_price or None,
        )
        try:
            adapter = await load_adapter()
            result = await adapter.place_order(order)
            return _order_result_response(result, broker=adapter.broker)
        except BrokerError as exc:
            reset_adapter_cache()  # transport failure — reconnect on next RPC
            await context.abort(grpc.StatusCode.UNAVAILABLE, str(exc))
            raise AssertionError("unreachable") from exc

    async def CloseTrade(
        self,
        request: quant_pb2.CloseTradeRequest,
        context: grpc.aio.ServicerContext,
    ) -> quant_pb2.CloseTradeResponse:
        units = request.units if request.units > 0 else None
        try:
            adapter = await load_adapter()
            result = await adapter.close_order(request.broker_trade_id, units)
            return quant_pb2.CloseTradeResponse(
                status=_STATUS_MAP.get(result.status, quant_pb2.EXECUTION_STATUS_UNSPECIFIED),
                broker_order_id=result.broker_order_id or "",
                filled_units=result.filled_units,
                fill_price=result.price or 0.0,
                reason_code=result.reason or "",
            )
        except BrokerError as exc:
            reset_adapter_cache()  # transport failure — reconnect on next RPC
            await context.abort(grpc.StatusCode.UNAVAILABLE, str(exc))
            raise AssertionError("unreachable") from exc

    async def ModifyTrade(
        self,
        request: quant_pb2.ModifyTradeRequest,
        context: grpc.aio.ServicerContext,
    ) -> quant_pb2.ModifyTradeResponse:
        try:
            adapter = await load_adapter()
            result = await adapter.modify_trade(
                request.broker_trade_id,
                stop_loss_price=request.stop_loss_price or None,
                take_profit_price=request.take_profit_price or None,
            )
            status = (
                quant_pb2.EXECUTION_STATUS_FILLED
                if result.status == "filled"
                else quant_pb2.EXECUTION_STATUS_REJECTED
            )
            return quant_pb2.ModifyTradeResponse(status=status, reason_code=result.reason or "")
        except BrokerError as exc:
            reset_adapter_cache()  # transport failure — reconnect on next RPC
            await context.abort(grpc.StatusCode.UNAVAILABLE, str(exc))
            raise AssertionError("unreachable") from exc

    async def ListOpenPositions(
        self,
        _request: quant_pb2.ListOpenPositionsRequest,
        context: grpc.aio.ServicerContext,
    ) -> quant_pb2.ListOpenPositionsResponse:
        try:
            adapter = await load_adapter()
            positions = await adapter.get_positions()
            return quant_pb2.ListOpenPositionsResponse(
                positions=[
                    quant_pb2.BrokerPositionMsg(
                        instrument=p.instrument,
                        side=_SIDE_TO_PROTO[p.side],
                        units=p.units,
                        avg_price=p.avg_price,
                        unrealized_pl=p.unrealized_pl,
                        broker_trade_ids=list(p.broker_trade_ids),
                    )
                    for p in positions
                ]
            )
        except BrokerError as exc:
            reset_adapter_cache()  # transport failure — reconnect on next RPC
            await context.abort(grpc.StatusCode.UNAVAILABLE, str(exc))
            raise AssertionError("unreachable") from exc

    async def GetTransactions(
        self,
        request: quant_pb2.GetTransactionsRequest,
        context: grpc.aio.ServicerContext,
    ) -> quant_pb2.GetTransactionsResponse:
        since = request.since_txn_id or None
        try:
            adapter = await load_adapter()
            txs = await adapter.get_transactions(since)
            # Always return a real high-water mark: adapter tracks it even
            # when no transactions arrived (bootstrap-at-connect, BE-052).
            last = adapter.last_transaction_id or (txs[-1].id if txs else (since or ""))
            return quant_pb2.GetTransactionsResponse(
                transactions=[
                    quant_pb2.BrokerTransactionMsg(
                        id=tx.id,
                        type=tx.type,
                        reason=tx.reason,
                        instrument=tx.instrument,
                        trade_id=tx.trade_id or "",
                        units=tx.units or 0.0,
                        price=tx.price or 0.0,
                        pl=tx.pl or 0.0,
                        financing=tx.financing or 0.0,
                        commission=tx.commission or 0.0,
                        client_order_id=tx.client_order_id,
                        trade_opened_id=tx.trade_opened_id or "",
                        trades_closed=[_trade_reduce_msg(tc) for tc in tx.trades_closed],
                        trade_reduced=(
                            _trade_reduce_msg(tx.trade_reduced) if tx.trade_reduced else None
                        ),
                        time=_ts(tx.time),
                    )
                    for tx in txs
                ],
                last_txn_id=last,
            )
        except BrokerError as exc:
            reset_adapter_cache()  # transport failure — reconnect on next RPC
            await context.abort(grpc.StatusCode.UNAVAILABLE, str(exc))
            raise AssertionError("unreachable") from exc
