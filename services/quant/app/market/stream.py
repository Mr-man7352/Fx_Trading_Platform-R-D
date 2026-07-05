"""OANDA tick-stream adapter (QN-020).

Consumes the pricing stream, publishes ticks to the market-data ingest path, and
raises a `degraded` flag when the feed goes quiet (>30 s without a price or
heartbeat) — the same staleness contract the Node data-quality monitor enforces
(BE-044). The publisher is a Protocol: in production it pushes onto the
`market-ticks` BullMQ queue that the Node worker (BE-040) consumes; tests use the
in-memory collector below.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Protocol

from app.market.oanda_client import OandaClient, Tick

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Callable

logger = logging.getLogger(__name__)

STALE_AFTER_SECONDS = 30.0


class TickPublisher(Protocol):
    """Sink for parsed ticks (Redis/BullMQ in prod, in-memory in tests)."""

    async def publish(self, tick: Tick) -> None: ...


class PriceStreamSource(Protocol):
    """Anything that yields OANDA stream objects — `OandaClient` satisfies it."""

    def stream_prices(self, instruments: list[str]) -> AsyncIterator[dict[str, object]]: ...


class InMemoryTickPublisher:
    """Collects ticks in a list; for tests and local dev."""

    def __init__(self) -> None:
        self.ticks: list[Tick] = []

    async def publish(self, tick: Tick) -> None:
        self.ticks.append(tick)


class TickStreamAdapter:
    """Drives a price stream into a publisher, tracking feed liveness."""

    def __init__(
        self,
        source: PriceStreamSource,
        publisher: TickPublisher,
        *,
        stale_after_s: float = STALE_AFTER_SECONDS,
        on_degraded: Callable[[str, bool], None] | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._source = source
        self._publisher = publisher
        self._stale_after_s = stale_after_s
        self._on_degraded = on_degraded
        self._clock = clock or (lambda: datetime.now(UTC))
        self._last_event_at: datetime | None = None
        self._degraded = False

    @property
    def degraded(self) -> bool:
        return self._degraded

    @property
    def last_event_at(self) -> datetime | None:
        return self._last_event_at

    async def run(self, instruments: list[str]) -> None:
        """Stream until the source ends (a real stream is effectively infinite)."""
        async for msg in self._source.stream_prices(instruments):
            self._last_event_at = self._clock()
            self._set_degraded(instruments, False)
            tick = OandaClient.to_tick(msg)
            if tick is not None:
                await self._publisher.publish(tick)

    def check_stale(self, now: datetime | None = None) -> bool:
        """Return True (and flag degraded) if no event has arrived recently."""
        moment = now or self._clock()
        if self._last_event_at is None:
            return False
        age = (moment - self._last_event_at).total_seconds()
        stale = age > self._stale_after_s
        if stale and not self._degraded:
            logger.warning("feed stale: %.0fs since last event", age)
            self._set_degraded(None, True)
        return stale

    def _set_degraded(self, instruments: list[str] | None, value: bool) -> None:
        if value == self._degraded:
            return
        self._degraded = value
        if self._on_degraded is not None:
            for inst in instruments or ["*"]:
                self._on_degraded(inst, value)
