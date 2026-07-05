"""Tick publishers (QN-020 → BE-040).

`RedisTickPublisher` puts ticks onto the BullMQ `market-ticks` queue that the
Node market-data worker consumes — job name `tick`, payload matching the Node
`TickJob` shape ({instrument, ts, bid, ask}). `bullmq` is imported lazily so this
module (and the unit tests) load without it installed; a logging fallback keeps
the stream runnable in mock mode.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from app.market.stream import TickPublisher

if TYPE_CHECKING:
    from app.market.oanda_client import Tick

logger = logging.getLogger(__name__)


def tick_to_job(tick: Tick) -> dict[str, object]:
    """Node `TickJob` shape — the contract the BE-040 worker deserializes."""
    return {
        "instrument": tick.instrument,
        "ts": tick.time.isoformat(),
        "bid": tick.bid,
        "ask": tick.ask,
    }


class LoggingTickPublisher(TickPublisher):
    """No-queue fallback (mock mode) — logs one line per tick, counts them."""

    def __init__(self) -> None:
        self.count = 0

    async def publish(self, tick: Tick) -> None:
        self.count += 1
        logger.debug(
            "tick %s %s bid=%s ask=%s", tick.instrument, tick.time.isoformat(), tick.bid, tick.ask
        )

    async def close(self) -> None:  # symmetry with RedisTickPublisher
        return None


class RedisTickPublisher(TickPublisher):
    """Adds ticks to the BullMQ `market-ticks` queue (Node BE-040 consumes)."""

    def __init__(self, redis_url: str, queue_name: str = "market-ticks") -> None:
        # Lazy import: bullmq is an optional runtime dep (see pyproject).
        from bullmq import Queue

        self._queue = Queue(queue_name, {"connection": redis_url})

    async def publish(self, tick: Tick) -> None:
        await self._queue.add(
            "tick", tick_to_job(tick), {"removeOnComplete": True, "removeOnFail": 1000}
        )

    async def close(self) -> None:
        await self._queue.close()


def build_tick_publisher(redis_url: str | None, queue_name: str = "market-ticks") -> TickPublisher:
    """Redis-backed publisher when a URL is given, else the logging fallback."""
    if not redis_url:
        logger.warning("no REDIS_URL — ticks will be logged, not queued (mock mode)")
        return LoggingTickPublisher()
    try:
        return RedisTickPublisher(redis_url, queue_name)
    except ImportError:
        logger.warning("bullmq not installed — falling back to logging publisher (uv sync)")
        return LoggingTickPublisher()
