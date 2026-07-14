"""Stateful in-memory OANDA v20 fake for the QN-030 conformance suite.

Backs an `httpx.MockTransport`, mimicking the venue semantics the adapter
relies on: fills market orders at a fixed price book, REJECTS duplicate
`clientExtensions.id` with CLIENT_ORDER_ID_ALREADY_EXISTS (and serves the
original via `orders/@{clientId}` + the fill transaction), tracks open trades
/ aggregated positions, and closes trades into history. No network, no time.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import httpx

PRICES: dict[str, float] = {
    "EUR_USD": 1.1000,
    "GBP_USD": 1.2500,
    "USD_JPY": 150.00,
    "USD_CHF": 0.9000,
    "AUD_USD": 0.6500,
    "USD_CAD": 1.3500,
    "NZD_USD": 0.6000,
    "XAU_USD": 2400.0,
    "WTICO_USD": 78.50,
    "BCO_USD": 82.00,
}


@dataclass
class _Trade:
    trade_id: str
    instrument: str
    units: float  # signed
    price: float
    open_time: str = "2026-07-06T08:00:00.000000000Z"
    close_time: str | None = None
    close_price: float | None = None
    realized_pl: float = 0.0


@dataclass
class FakeOanda:
    account_id: str = "101-004-1-001"
    currency: str = "GBP"
    margin_rate: float = 0.0333
    # instrument → fraction of requested units to fill (1.0 = full fill).
    fill_fraction: dict[str, float] = field(default_factory=dict)
    reject_reason: str | None = None  # force orderCancelTransaction

    def __post_init__(self) -> None:
        self._trades: dict[str, _Trade] = {}
        self._orders: dict[str, dict[str, Any]] = {}  # client_id → fill tx
        self._transactions: list[dict[str, Any]] = []
        self._stop_loss: dict[str, float] = {}
        self._next = 1000
        self.order_posts = 0  # observability for idempotency assertions

    # ── helpers ──────────────────────────────────────────────────────────────

    def _next_id(self) -> str:
        self._next += 1
        return str(self._next)

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            transport=self.transport(),
            base_url="https://api-fxpractice.oanda.com",
            headers={"Authorization": "Bearer test"},
        )

    # ── request router ───────────────────────────────────────────────────────

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        base = f"/v3/accounts/{self.account_id}"
        if path == f"{base}/summary":
            return httpx.Response(
                200,
                json={
                    "account": {"currency": self.currency, "marginRate": str(self.margin_rate)},
                    # Real OANDA carries this top-level; adapters bootstrap the
                    # BE-052 since-id from it at connect().
                    "lastTransactionID": str(self._next),
                },
            )
        if path == f"{base}/orders" and request.method == "POST":
            return self._place(json.loads(request.content))
        if path.startswith(f"{base}/orders/@"):
            return self._order_by_client_id(path.rsplit("@", 1)[1])
        if path == f"{base}/transactions/sinceid":
            return self._transactions_list(request)
        if path == f"{base}/transactions":
            # Real OANDA: the plain endpoint returns PAGE URLS, not bodies —
            # keep the fake faithful so adapters can't lean on it by accident.
            return httpx.Response(200, json={"pages": [], "count": len(self._transactions)})
        if path.startswith(f"{base}/transactions/"):
            return self._transaction(path.rsplit("/", 1)[1])
        if path == f"{base}/openPositions":
            return self._open_positions()
        if path.startswith(f"{base}/trades/") and path.endswith("/close"):
            return self._close(path.split("/")[-2], json.loads(request.content))
        if path.startswith(f"{base}/trades/") and path.endswith("/orders"):
            return self._modify(path.split("/")[-2], json.loads(request.content))
        if path == f"{base}/trades":
            return self._closed_trades()
        return httpx.Response(404, json={"errorMessage": f"no route {path}"})

    # ── venue behavior ───────────────────────────────────────────────────────

    def _place(self, body: dict[str, Any]) -> httpx.Response:
        self.order_posts += 1
        order = body["order"]
        client_id = order["clientExtensions"]["id"]
        if client_id in self._orders:
            return httpx.Response(400, json={"errorCode": "CLIENT_ORDER_ID_ALREADY_EXISTS"})
        if self.reject_reason:
            return httpx.Response(
                201,
                json={
                    "orderCreateTransaction": {"id": self._next_id()},
                    "orderCancelTransaction": {"reason": self.reject_reason},
                },
            )
        instrument = order["instrument"]
        requested = float(order["units"])
        fraction = self.fill_fraction.get(instrument, 1.0)
        filled = requested * fraction
        price = PRICES[instrument]
        trade_id = self._next_id()
        self._trades[trade_id] = _Trade(trade_id, instrument, filled, price)
        # Faithful ORDER_FILL shape: trade id lives ONLY in tradeOpened, client
        # id in top-level clientOrderID — never a top-level tradeID.
        fill_tx = {
            "id": self._next_id(),
            "type": "ORDER_FILL",
            "reason": "MARKET_ORDER",
            "orderID": self._next_id(),
            "clientOrderID": client_id,
            "instrument": instrument,
            "units": str(filled),
            "price": str(price),
            "pl": "0.0",
            "financing": "0.0",
            "commission": "0.0",
            "tradeOpened": {"tradeID": trade_id, "units": str(filled), "price": str(price)},
            "time": "2026-07-06T08:00:01.000000000Z",
        }
        self._orders[client_id] = fill_tx
        self._transactions.append(fill_tx)
        return httpx.Response(201, json={"orderFillTransaction": fill_tx})

    def _order_by_client_id(self, client_id: str) -> httpx.Response:
        fill = self._orders.get(client_id)
        if fill is None:
            return httpx.Response(404, json={"errorMessage": "order not found"})
        return httpx.Response(
            200, json={"order": {"state": "FILLED", "fillingTransactionID": fill["id"]}}
        )

    def _transaction(self, tx_id: str) -> httpx.Response:
        for fill in self._orders.values():
            if fill["id"] == tx_id:
                return httpx.Response(200, json={"transaction": fill})
        return httpx.Response(404, json={"errorMessage": "transaction not found"})

    def _open_positions(self) -> httpx.Response:
        by_key: dict[tuple[str, str], list[_Trade]] = {}
        for t in self._trades.values():
            if t.close_time is None:
                by_key.setdefault((t.instrument, "long" if t.units > 0 else "short"), []).append(t)
        positions: dict[str, dict[str, Any]] = {}
        for (instrument, side), trades in by_key.items():
            pos = positions.setdefault(instrument, {"instrument": instrument})
            units = sum(t.units for t in trades)
            pos[side] = {
                "units": str(units),
                "averagePrice": str(trades[0].price),
                "unrealizedPL": "0.0",
                "tradeIDs": [t.trade_id for t in trades],
            }
        return httpx.Response(200, json={"positions": list(positions.values())})

    def _close(self, trade_id: str, body: dict[str, Any]) -> httpx.Response:
        trade = self._trades.get(trade_id)
        if trade is None or trade.close_time is not None:
            return httpx.Response(
                404, json={"orderRejectTransaction": {"rejectReason": "TRADE_DOESNT_EXIST"}}
            )
        requested = abs(trade.units) if body.get("units") == "ALL" else abs(float(body["units"]))
        units = min(requested, abs(trade.units))
        price = PRICES[trade.instrument]
        pl = round((price - trade.price) * (units if trade.units > 0 else -units), 6)
        full_close = units >= abs(trade.units)
        reduce_info: dict[str, Any] = {
            "tradeID": trade_id,
            "units": str(-units if trade.units > 0 else units),
            "price": str(price),
            "realizedPL": str(pl),
            "financing": "0.0",
        }
        # Faithful ORDER_FILL: full close → entry in tradesClosed; partial
        # close → tradeReduced, trade STAYS OPEN with reduced units.
        fill: dict[str, Any] = {
            "id": self._next_id(),
            "type": "ORDER_FILL",
            "reason": "MARKET_ORDER_TRADE_CLOSE",
            "orderID": self._next_id(),
            "instrument": trade.instrument,
            "units": str(-units if trade.units > 0 else units),
            "price": str(price),
            "pl": str(pl),
            "financing": "0.0",
            "commission": "0.0",
            "time": "2026-07-06T09:00:01.000000000Z",
        }
        if full_close:
            trade.close_time = "2026-07-06T09:00:00.000000000Z"
            trade.close_price = price
            trade.realized_pl += pl
            fill["tradesClosed"] = [reduce_info]
        else:
            trade.units = trade.units + units if trade.units < 0 else trade.units - units
            trade.realized_pl += pl
            fill["tradeReduced"] = reduce_info
        self._transactions.append(fill)
        return httpx.Response(200, json={"orderFillTransaction": fill})

    def _modify(self, trade_id: str, body: dict[str, Any]) -> httpx.Response:
        trade = self._trades.get(trade_id)
        if trade is None or trade.close_time is not None:
            return httpx.Response(
                400, json={"orderRejectTransaction": {"rejectReason": "TRADE_DOESNT_EXIST"}}
            )
        if sl := body.get("stopLoss"):
            self._stop_loss[trade_id] = float(sl["price"])
        return httpx.Response(200, json={"stopLossOrderTransaction": {"id": self._next_id()}})

    def _transactions_list(self, request: httpx.Request) -> httpx.Response:
        since = request.url.params.get("id")
        txs = self._transactions
        if since:
            txs = [t for t in txs if int(t["id"]) > int(since)]
        last = txs[-1]["id"] if txs else (since or "")
        return httpx.Response(200, json={"transactions": txs, "lastTransactionID": last})

    def _closed_trades(self) -> httpx.Response:
        closed = [
            {
                "id": t.trade_id,
                "instrument": t.instrument,
                "initialUnits": str(t.units),
                "price": str(t.price),
                "averageClosePrice": str(t.close_price),
                "realizedPL": str(t.realized_pl),
                "openTime": t.open_time,
                "closeTime": t.close_time,
            }
            for t in self._trades.values()
            if t.close_time is not None
        ]
        return httpx.Response(200, json={"trades": closed})
