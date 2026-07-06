"""QN-030 — runtime models for the BrokerAdapter contract.

Field-for-field mirror of `packages/types/src/broker.ts` (the Zod source of
truth; emitted to JSON Schema via `contractSchemas`). Kept as hand-written
Pydantic models — not the QN-003 generated contracts — because adapters need
behavior (validators, signed-units helpers) the codegen output can't carry;
`tests/execution/test_models.py` pins the field parity instead.
"""

from __future__ import annotations

from datetime import datetime  # noqa: TC003 — pydantic needs the runtime type
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator

Broker = Literal["oanda"]  # sole venue (ADR-005; MT5/QN-031 dropped 2026-07-06)
OrderSide = Literal["buy", "sell"]
OrderStatus = Literal["filled", "partial", "rejected"]


class OrderRequest(BaseModel):
    """Market order. `client_order_id` is the cross-broker idempotency key:
    retries MUST reuse it (OANDA: clientExtensions.id)."""

    model_config = ConfigDict(frozen=True)

    client_order_id: str = Field(default_factory=lambda: str(uuid4()), min_length=1)
    instrument: str
    side: OrderSide
    units: float = Field(gt=0)  # always positive — side carries direction
    type: Literal["market"] = "market"
    stop_loss_price: float | None = Field(default=None, gt=0)
    take_profit_price: float | None = Field(default=None, gt=0)

    @property
    def signed_units(self) -> float:
        """OANDA convention: buy > 0, sell < 0."""
        return self.units if self.side == "buy" else -self.units


class OrderResult(BaseModel):
    """Outcome of place/close. `partial` carries the unfilled remainder
    for the execution worker to handle (QN-032 AC)."""

    model_config = ConfigDict(frozen=True)

    client_order_id: str
    status: OrderStatus
    broker: Broker
    broker_order_id: str | None = None
    broker_trade_id: str | None = None
    requested_units: float
    filled_units: float = 0.0
    remainder_units: float = 0.0
    price: float | None = None
    reason: str | None = None

    @model_validator(mode="after")
    def _consistent(self) -> OrderResult:
        if self.status == "filled" and self.remainder_units != 0:
            raise ValueError("filled orders cannot carry a remainder")
        if self.status == "partial" and self.remainder_units <= 0:
            raise ValueError("partial fills must carry a positive remainder")
        return self


class BrokerPosition(BaseModel):
    model_config = ConfigDict(frozen=True)

    instrument: str
    side: OrderSide
    units: float = Field(gt=0)
    avg_price: float
    unrealized_pl: float = 0.0
    broker_trade_ids: tuple[str, ...] = ()


class BrokerTradeRecord(BaseModel):
    """A closed trade returned by get_history."""

    model_config = ConfigDict(frozen=True)

    broker_trade_id: str
    instrument: str
    side: OrderSide
    units: float = Field(gt=0)
    open_price: float
    close_price: float | None = None
    realized_pl: float = 0.0
    opened_at: datetime
    closed_at: datetime | None = None
