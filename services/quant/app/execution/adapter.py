"""QN-030 — typed BrokerAdapter contract.

Every execution venue implements this protocol so venues are swappable behind
one seam. OANDA (QN-032) is the sole production venue (ADR-005; the optional
MT5 adapter, QN-031, was dropped 2026-07-06 — OANDA's v20 API covers both data
and trade execution). The conformance suite
(`tests/execution/test_conformance.py`) runs the same behavioral assertions
against every adapter — any future venue must pass it unchanged: connect,
get_positions, place_order (idempotent retry), close_order, get_history.

Semantics adapters must honor:
- `place_order` is idempotent on `OrderRequest.client_order_id`: a retry with
  the same id returns the ORIGINAL fill — never a second execution.
- Partial fills return status "partial" with `remainder_units > 0`; the caller
  (Phase-2.2 execution worker) owns the remainder.
- Broker rejects return status "rejected" with `reason` set — adapters raise
  only for transport/auth failures (`BrokerError`), not business rejects.
- All instruments are CANONICAL names (EUR_USD, XAU_USD…); mapping to venue
  symbols happens inside the adapter via `app.execution.symbols` (QN-033).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:
    from datetime import datetime

    from app.execution.models import (
        Broker,
        BrokerPosition,
        BrokerTradeRecord,
        BrokerTransaction,
        ModifyTradeResult,
        OrderRequest,
        OrderResult,
    )


class BrokerError(RuntimeError):
    """Transport/auth failure talking to the venue (retryable by the caller)."""


class OrderRejectedError(BrokerError):
    """Raised only by strict callers that upgrade a `rejected` result; adapters
    themselves return the rejected `OrderResult` rather than raising."""


@runtime_checkable
class BrokerAdapter(Protocol):
    """The QN-030 contract. Implementation: OandaAdapter (sole venue, ADR-005)."""

    broker: Broker
    # High-water transaction id, seeded by connect() and advanced by
    # get_transactions — the BE-052 reconciler's bootstrap when it has no
    # persisted since-id yet.
    last_transaction_id: str | None

    async def connect(self) -> None:
        """Authenticate + verify the account; raise BrokerError on failure."""
        ...

    async def disconnect(self) -> None:
        """Release transports. Safe to call twice; adapters reconnect on demand."""
        ...

    async def get_positions(self) -> list[BrokerPosition]:
        """Open positions, canonical instrument names."""
        ...

    async def place_order(self, order: OrderRequest) -> OrderResult:
        """Execute a market order; idempotent on client_order_id."""
        ...

    async def close_order(self, broker_trade_id: str, units: float | None = None) -> OrderResult:
        """Close an open trade (fully, or `units` of it)."""
        ...

    async def modify_trade(
        self,
        broker_trade_id: str,
        *,
        stop_loss_price: float | None = None,
        take_profit_price: float | None = None,
    ) -> ModifyTradeResult:
        """Amend SL/TP on an open broker trade."""
        ...

    async def get_transactions(self, since_txn_id: str | None = None) -> list[BrokerTransaction]:
        """Account transactions since `since_txn_id` (exclusive), oldest first.

        With no since-id, bootstraps from `last_transaction_id` (recorded at
        connect) — implementations must NOT fall back to unbounded endpoints.
        """
        ...

    async def get_history(self, since: datetime) -> list[BrokerTradeRecord]:
        """Closed trades since `since` (inclusive), oldest first."""
        ...
