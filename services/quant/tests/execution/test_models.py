"""QN-030 — runtime model invariants (mirror of @fx/types broker.ts)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.execution.models import OrderRequest, OrderResult


def test_order_request_defaults_and_signed_units() -> None:
    order = OrderRequest(instrument="EUR_USD", side="buy", units=100)
    assert order.client_order_id  # auto-minted UUID
    assert order.type == "market"
    assert order.signed_units == 100
    sell = OrderRequest(instrument="EUR_USD", side="sell", units=100)
    assert sell.signed_units == -100


@pytest.mark.parametrize("units", [0, -50])
def test_order_request_units_must_be_positive(units: float) -> None:
    with pytest.raises(ValidationError):
        OrderRequest(instrument="EUR_USD", side="buy", units=units)


def test_order_result_filled_cannot_carry_remainder() -> None:
    with pytest.raises(ValidationError, match="remainder"):
        OrderResult(
            client_order_id="x",
            status="filled",
            broker="oanda",
            requested_units=100,
            filled_units=60,
            remainder_units=40,
        )


def test_order_result_partial_requires_remainder() -> None:
    with pytest.raises(ValidationError, match="remainder"):
        OrderResult(
            client_order_id="x",
            status="partial",
            broker="oanda",
            requested_units=100,
            filled_units=100,
            remainder_units=0,
        )


def test_order_result_partial_ok() -> None:
    result = OrderResult(
        client_order_id="x",
        status="partial",
        broker="oanda",
        requested_units=100,
        filled_units=60,
        remainder_units=40,
        price=1.1,
    )
    assert result.remainder_units == 40
