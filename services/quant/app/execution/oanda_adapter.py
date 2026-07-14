"""QN-032 — OANDA v20 execution adapter (primary production venue, ADR-005).

Order lifecycle on the same httpx client core as the QN-020 stream client —
new code behind the QN-030 interface, not an extension of the pricing client.

Behavior pinned by tests (test_oanda_adapter.py + conformance suite):
- Idempotency: `clientExtensions.id` = OrderRequest.client_order_id. On
  CLIENT_ORDER_ID_ALREADY_EXISTS the adapter fetches the original order
  (`GET …/orders/@{clientOrderId}` + its fill transaction) and returns THAT
  fill — a retry never double-executes.
- Partial fills: fill units < requested → status "partial" + remainder for the
  Phase-2.2 execution worker.
- Business rejects (orderCancelTransaction / orderRejectTransaction) return
  status "rejected" with the venue reason; only transport/auth raises.
- Instruments are canonical names; QN-033 maps them (identity for OANDA, but
  routed through the table so unknown instruments fail loudly pre-flight).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import httpx

from app.execution.adapter import BrokerError
from app.execution.models import (
    Broker,
    BrokerPosition,
    BrokerTradeRecord,
    BrokerTransaction,
    ModifyTradeResult,
    OrderRequest,
    OrderResult,
    OrderSide,
    TradeReduceInfo,
)
from app.execution.symbols import from_broker_symbol, to_broker_symbol
from app.market.oanda_client import _parse_time

if TYPE_CHECKING:
    from datetime import datetime

    from app.execution.credentials import BrokerCredentials

_DUPLICATE_CODES = {"CLIENT_ORDER_ID_ALREADY_EXISTS", "DUPLICATE_CLIENT_ORDER_ID"}


def _num(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


class OandaAdapter:
    """BrokerAdapter implementation for OANDA v20 (see adapter.py contract)."""

    broker: Broker = "oanda"

    def __init__(
        self,
        *,
        api_token: str,
        account_id: str,
        rest_host: str = "https://api-fxpractice.oanda.com",
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._account_id = account_id
        self._client = client or httpx.AsyncClient(
            base_url=rest_host,
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=30.0,
        )
        # Populated by connect(); consumed by QN-034 sizing callers.
        self.account_currency: str | None = None
        self.margin_rate: float | None = None
        # High-water transaction id, seeded at connect() (BE-052 bootstrap:
        # the plain /transactions endpoint returns PAGES, not transactions —
        # get_transactions therefore ALWAYS queries /transactions/sinceid).
        self.last_transaction_id: str | None = None

    @classmethod
    def from_credentials(
        cls, creds: BrokerCredentials, *, rest_host: str = "https://api-fxpractice.oanda.com"
    ) -> OandaAdapter:
        """Build from a decrypted BE-131 envelope (credentials.py)."""
        return cls(api_token=creds.api_token, account_id=creds.account_id, rest_host=rest_host)

    # ── contract ────────────────────────────────────────────────────────────

    async def connect(self) -> None:
        resp = await self._client.get(f"/v3/accounts/{self._account_id}/summary")
        if resp.status_code != 200:
            raise BrokerError(f"OANDA auth/summary failed: HTTP {resp.status_code}")
        payload = resp.json()
        account = payload.get("account", {})
        self.account_currency = account.get("currency")
        self.margin_rate = _num(account.get("marginRate"), 0.0) or None
        last = payload.get("lastTransactionID") or account.get("lastTransactionID")
        if last:
            self.last_transaction_id = str(last)

    async def disconnect(self) -> None:
        await self._client.aclose()

    async def get_positions(self) -> list[BrokerPosition]:
        resp = await self._client.get(f"/v3/accounts/{self._account_id}/openPositions")
        if resp.status_code != 200:
            raise BrokerError(f"openPositions failed: HTTP {resp.status_code}")
        out: list[BrokerPosition] = []
        for pos in resp.json().get("positions", []):
            instrument = from_broker_symbol(str(pos["instrument"]), "oanda")
            for side_key, side in (("long", "buy"), ("short", "sell")):
                leg = pos.get(side_key) or {}
                units = abs(_num(leg.get("units")))
                if units == 0:
                    continue
                out.append(
                    BrokerPosition(
                        instrument=instrument,
                        side=side,  # type: ignore[arg-type]
                        units=units,
                        avg_price=_num(leg.get("averagePrice")),
                        unrealized_pl=_num(leg.get("unrealizedPL")),
                        broker_trade_ids=tuple(str(t) for t in leg.get("tradeIDs", [])),
                    )
                )
        return out

    async def place_order(self, order: OrderRequest) -> OrderResult:
        body: dict[str, Any] = {
            "order": {
                "type": "MARKET",
                "instrument": to_broker_symbol(order.instrument, "oanda"),
                "units": f"{order.signed_units:.10g}",
                "timeInForce": "FOK",
                "positionFill": "DEFAULT",
                "clientExtensions": {"id": order.client_order_id},
            }
        }
        if order.stop_loss_price is not None:
            body["order"]["stopLossOnFill"] = {"price": f"{order.stop_loss_price:.10g}"}
        if order.take_profit_price is not None:
            body["order"]["takeProfitOnFill"] = {"price": f"{order.take_profit_price:.10g}"}

        resp = await self._client.post(f"/v3/accounts/{self._account_id}/orders", json=body)
        data = self._json(resp)

        if resp.status_code in (200, 201):
            if fill := data.get("orderFillTransaction"):
                return self._result_from_fill(order, fill)
            if cancel := data.get("orderCancelTransaction"):
                return self._rejected(order, str(cancel.get("reason", "CANCELLED")), data)
            return self._rejected(order, "NO_FILL_TRANSACTION", data)

        error_code = str(data.get("errorCode", ""))
        if error_code in _DUPLICATE_CODES:
            return await self._lookup_existing(order)  # idempotent retry path
        if reject := data.get("orderRejectTransaction"):
            return self._rejected(order, str(reject.get("rejectReason", "REJECTED")), data)
        raise BrokerError(
            f"order placement failed: HTTP {resp.status_code} "
            f"{error_code or data.get('errorMessage', '')}"
        )

    async def close_order(self, broker_trade_id: str, units: float | None = None) -> OrderResult:
        body = {"units": "ALL" if units is None else f"{units:.10g}"}
        resp = await self._client.put(
            f"/v3/accounts/{self._account_id}/trades/{broker_trade_id}/close", json=body
        )
        data = self._json(resp)
        if resp.status_code == 200 and (fill := data.get("orderFillTransaction")):
            filled = abs(_num(fill.get("units")))
            return OrderResult(
                client_order_id=str(fill.get("id", broker_trade_id)),
                status="filled",
                broker="oanda",
                broker_order_id=str(fill.get("orderID")) if fill.get("orderID") else None,
                broker_trade_id=broker_trade_id,
                requested_units=filled if units is None else abs(units),
                filled_units=filled,
                remainder_units=0.0,
                price=_num(fill.get("price")) or None,
            )
        reject = data.get("orderRejectTransaction") or {}
        reason = str(
            reject.get("rejectReason") or data.get("errorMessage") or f"HTTP {resp.status_code}"
        )
        if resp.status_code in (400, 404):
            return OrderResult(
                client_order_id=broker_trade_id,
                status="rejected",
                broker="oanda",
                broker_order_id=None,
                broker_trade_id=broker_trade_id,
                requested_units=abs(units) if units is not None else 0.0,
                reason=reason,
            )
        raise BrokerError(f"trade close failed: {reason}")

    async def modify_trade(
        self,
        broker_trade_id: str,
        *,
        stop_loss_price: float | None = None,
        take_profit_price: float | None = None,
    ) -> ModifyTradeResult:
        body: dict[str, Any] = {}
        if stop_loss_price is not None:
            body["stopLoss"] = {"price": f"{stop_loss_price:.10g}"}
        if take_profit_price is not None:
            body["takeProfit"] = {"price": f"{take_profit_price:.10g}"}
        resp = await self._client.put(
            f"/v3/accounts/{self._account_id}/trades/{broker_trade_id}/orders",
            json=body,
        )
        data = self._json(resp)
        if resp.status_code == 200:
            return ModifyTradeResult(status="filled")
        reason = str(
            (data.get("orderRejectTransaction") or {}).get("rejectReason")
            or data.get("errorMessage")
            or f"HTTP {resp.status_code}"
        )
        return ModifyTradeResult(status="rejected", reason=reason)

    async def get_transactions(self, since_txn_id: str | None = None) -> list[BrokerTransaction]:
        # NEVER hit the plain /transactions endpoint — it returns page URLs,
        # not transaction bodies. Without an explicit since id, bootstrap from
        # the high-water mark recorded at connect().
        since = since_txn_id or self.last_transaction_id
        if not since:
            raise BrokerError("get_transactions requires connect() first (no since-id)")
        resp = await self._client.get(
            f"/v3/accounts/{self._account_id}/transactions/sinceid",
            params={"id": since},
        )
        if resp.status_code != 200:
            raise BrokerError(f"transactions failed: HTTP {resp.status_code}")
        payload = self._json(resp)
        raw = payload.get("transactions") or []
        out = [self._tx_from_raw(tx) for tx in raw]
        out.sort(key=lambda t: t.time)
        last = payload.get("lastTransactionID")
        self.last_transaction_id = str(last) if last else (out[-1].id if out else since)
        return out

    async def get_history(self, since: datetime) -> list[BrokerTradeRecord]:
        resp = await self._client.get(
            f"/v3/accounts/{self._account_id}/trades",
            params={"state": "CLOSED", "count": "500"},
        )
        if resp.status_code != 200:
            raise BrokerError(f"trade history failed: HTTP {resp.status_code}")
        records: list[BrokerTradeRecord] = []
        for t in resp.json().get("trades", []):
            closed_at = _parse_time(str(t["closeTime"])) if t.get("closeTime") else None
            if closed_at is not None and closed_at < since:
                continue
            initial = _num(t.get("initialUnits"))
            side: OrderSide = "buy" if initial >= 0 else "sell"
            records.append(
                BrokerTradeRecord(
                    broker_trade_id=str(t["id"]),
                    instrument=from_broker_symbol(str(t["instrument"]), "oanda"),
                    side=side,
                    units=abs(initial),
                    open_price=_num(t.get("price")),
                    close_price=_num(t.get("averageClosePrice")) or None,
                    realized_pl=_num(t.get("realizedPL")),
                    opened_at=_parse_time(str(t["openTime"])),
                    closed_at=closed_at,
                )
            )
        records.sort(key=lambda r: r.closed_at or r.opened_at)
        return records

    # ── internals ───────────────────────────────────────────────────────────

    @staticmethod
    def _json(resp: httpx.Response) -> dict[str, Any]:
        try:
            data = resp.json()
        except ValueError:
            return {}
        return data if isinstance(data, dict) else {}

    def _result_from_fill(self, order: OrderRequest, fill: dict[str, Any]) -> OrderResult:
        filled = abs(_num(fill.get("units")))
        trade_id = (fill.get("tradeOpened") or {}).get("tradeID") or (
            (fill.get("tradesClosed") or [{}])[0].get("tradeID")
        )
        remainder = max(order.units - filled, 0.0)
        return OrderResult(
            client_order_id=order.client_order_id,
            status="partial" if remainder > 0 else "filled",
            broker="oanda",
            broker_order_id=str(fill.get("orderID")) if fill.get("orderID") else None,
            broker_trade_id=str(trade_id) if trade_id else None,
            requested_units=order.units,
            filled_units=filled,
            remainder_units=remainder,
            price=_num(fill.get("price")) or None,
        )

    def _rejected(self, order: OrderRequest, reason: str, _raw: dict[str, Any]) -> OrderResult:
        return OrderResult(
            client_order_id=order.client_order_id,
            status="rejected",
            broker="oanda",
            requested_units=order.units,
            reason=reason,
        )

    @staticmethod
    def _trade_reduce(raw: dict[str, Any]) -> TradeReduceInfo:
        return TradeReduceInfo(
            trade_id=str(raw.get("tradeID", "")),
            units=abs(_num(raw.get("units"))),
            price=_num(raw.get("price")) or None,
            realized_pl=_num(raw.get("realizedPL")),
            financing=_num(raw.get("financing")),
        )

    def _tx_from_raw(self, tx: dict[str, Any]) -> BrokerTransaction:
        instrument = str(tx.get("instrument", ""))
        if instrument:
            instrument = from_broker_symbol(instrument, "oanda")
        # ORDER_FILL carries clientOrderID top-level; other txn types use
        # clientExtensions.id.
        client_id = str(tx.get("clientOrderID", ""))
        if not client_id and (ext := tx.get("clientExtensions")):
            client_id = str(ext.get("id", ""))
        trade_opened = tx.get("tradeOpened") or {}
        return BrokerTransaction(
            id=str(tx["id"]),
            type=str(tx.get("type", "")),
            reason=str(tx.get("reason", "")),
            instrument=instrument,
            trade_id=str(tx["tradeID"]) if tx.get("tradeID") else None,
            units=abs(_num(tx["units"])) if tx.get("units") is not None else None,
            price=_num(tx.get("price")) or None,
            pl=_num(tx.get("pl")) if tx.get("pl") is not None else None,
            financing=_num(tx.get("financing")) if tx.get("financing") is not None else None,
            commission=_num(tx.get("commission")) if tx.get("commission") is not None else None,
            client_order_id=client_id,
            trade_opened_id=str(trade_opened["tradeID"]) if trade_opened.get("tradeID") else None,
            trades_closed=tuple(self._trade_reduce(tc) for tc in (tx.get("tradesClosed") or [])),
            trade_reduced=(
                self._trade_reduce(tx["tradeReduced"]) if tx.get("tradeReduced") else None
            ),
            time=_parse_time(str(tx["time"])),
        )

    async def _lookup_existing(self, order: OrderRequest) -> OrderResult:
        """Duplicate client id → return the ORIGINAL execution (idempotency)."""
        resp = await self._client.get(
            f"/v3/accounts/{self._account_id}/orders/@{order.client_order_id}"
        )
        if resp.status_code != 200:
            raise BrokerError(
                f"duplicate client order id {order.client_order_id} but original lookup "
                f"failed: HTTP {resp.status_code}"
            )
        existing = self._json(resp).get("order", {})
        filling_id = existing.get("fillingTransactionID")
        if existing.get("state") == "FILLED" and filling_id:
            tx_resp = await self._client.get(
                f"/v3/accounts/{self._account_id}/transactions/{filling_id}"
            )
            if tx_resp.status_code == 200:
                fill = self._json(tx_resp).get("transaction", {})
                return self._result_from_fill(order, fill)
        return self._rejected(order, f"DUPLICATE_UNRESOLVED_STATE_{existing.get('state')}", {})
