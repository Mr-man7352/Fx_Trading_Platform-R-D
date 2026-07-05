"""QN-020 — tick-stream adapter: publishing + stale-feed degradation."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

import pytest

from app.market.stream import InMemoryTickPublisher, TickStreamAdapter

if TYPE_CHECKING:
    from collections.abc import AsyncIterator


class FakeSource:
    """Yields prepared OANDA stream objects, like OandaClient.stream_prices."""

    def __init__(self, messages: list[dict[str, object]]) -> None:
        self._messages = messages

    async def stream_prices(self, _instruments: list[str]) -> AsyncIterator[dict[str, object]]:
        for msg in self._messages:
            yield msg


def _price(ts: str, bid: str, ask: str) -> dict[str, object]:
    return {
        "type": "PRICE",
        "instrument": "EUR_USD",
        "time": ts,
        "bids": [{"price": bid}],
        "asks": [{"price": ask}],
    }


@pytest.mark.asyncio
async def test_run_publishes_ticks_and_skips_heartbeats() -> None:
    source = FakeSource(
        [
            _price("2026-03-10T14:00:00Z", "1.0850", "1.0852"),
            {"type": "HEARTBEAT", "time": "2026-03-10T14:00:05Z"},
            _price("2026-03-10T14:00:10Z", "1.0851", "1.0853"),
        ]
    )
    publisher = InMemoryTickPublisher()
    adapter = TickStreamAdapter(source, publisher, clock=lambda: datetime(2026, 3, 10, tzinfo=UTC))
    await adapter.run(["EUR_USD"])
    assert len(publisher.ticks) == 2
    assert publisher.ticks[0].instrument == "EUR_USD"


@pytest.mark.asyncio
async def test_check_stale_flags_degraded_after_30s() -> None:
    t0 = datetime(2026, 3, 10, 14, 0, 0, tzinfo=UTC)
    flags: list[tuple[str, bool]] = []
    adapter = TickStreamAdapter(
        FakeSource([_price("2026-03-10T14:00:00Z", "1.0850", "1.0852")]),
        InMemoryTickPublisher(),
        on_degraded=lambda inst, deg: flags.append((inst, deg)),
        clock=lambda: t0,
    )
    await adapter.run(["EUR_USD"])
    assert adapter.degraded is False

    assert adapter.check_stale(t0 + timedelta(seconds=31)) is True
    assert adapter.degraded is True
    assert ("EUR_USD", True) not in flags  # stale sweep flags with "*"
    assert flags[-1] == ("*", True)


@pytest.mark.asyncio
async def test_no_stale_before_threshold() -> None:
    t0 = datetime(2026, 3, 10, 14, 0, 0, tzinfo=UTC)
    adapter = TickStreamAdapter(
        FakeSource([_price("2026-03-10T14:00:00Z", "1.0850", "1.0852")]),
        InMemoryTickPublisher(),
        clock=lambda: t0,
    )
    await adapter.run(["EUR_USD"])
    assert adapter.check_stale(t0 + timedelta(seconds=20)) is False
    assert adapter.degraded is False
