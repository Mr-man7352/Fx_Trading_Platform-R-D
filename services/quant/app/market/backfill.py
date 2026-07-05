"""OANDA historical backfill + Twelve Data cross-check (QN-021).

Pages the OANDA candles endpoint (5,000/request) from `start` to `end`, writing
via an idempotent `CandleWriter` (re-runs never duplicate), and optionally
sample-cross-checks against Twelve Data, reporting out-of-tolerance mid
discrepancies. The writer Protocol keeps this DB-agnostic: in production it
upserts into TimescaleDB (or hands off to the Node ingest path); tests use the
in-memory writer below.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import TYPE_CHECKING, Protocol

from app.market.oanda_client import Candle, OandaClient

if TYPE_CHECKING:
    from collections.abc import Callable
    from datetime import datetime

    from app.market.twelvedata import TwelveDataClient


class CandleWriter(Protocol):
    async def upsert(self, candles: list[Candle]) -> int: ...


class InMemoryCandleWriter:
    """Idempotent in-memory sink keyed like the candles PK (tests/dev)."""

    def __init__(self) -> None:
        self.store: dict[tuple[str, str, str], Candle] = {}

    async def upsert(self, candles: list[Candle]) -> int:
        for c in candles:
            self.store[(c.instrument, c.granularity, c.time.isoformat())] = c
        return len(candles)


@dataclass(slots=True)
class BackfillResult:
    instrument: str
    granularity: str
    pages: int = 0
    candles_written: int = 0
    cross_checks_sampled: int = 0
    discrepancies: int = 0
    degraded_instruments: set[str] = field(default_factory=set)


async def backfill_candles(
    *,
    client: OandaClient,
    writer: CandleWriter,
    instrument: str,
    granularity: str,
    start: datetime,
    end: datetime,
    page_size: int = 5000,
    cross_check: TwelveDataClient | None = None,
    cross_check_symbol: str | None = None,
    tolerance_pips: float = 2.0,
    sample_every: int = 200,
    pip: float = 0.0001,
    on_discrepancy: Callable[[str, datetime, float, float], None] | None = None,
) -> BackfillResult:
    """Backfill [start, end) for one instrument x granularity; see module docstring."""
    result = BackfillResult(instrument=instrument, granularity=granularity)
    cursor = start
    bar_index = 0
    first = True

    for _ in range(100_000):  # hard stop against a non-advancing cursor
        if cursor >= end:
            break
        page = await client.fetch_candles(
            instrument, granularity, from_time=cursor, count=page_size, include_first=first
        )
        first = False
        in_range = [c for c in page if c.time < end]
        if in_range:
            result.candles_written += await writer.upsert(in_range)
            result.pages += 1

        if cross_check is not None and cross_check_symbol is not None:
            for bar in in_range:
                if bar_index % sample_every == 0:
                    vendor = await cross_check.sample_mid(cross_check_symbol, granularity, bar.time)
                    if vendor is not None:
                        result.cross_checks_sampled += 1
                        disc_pips = (vendor - bar.close) / pip
                        if abs(disc_pips) > tolerance_pips:
                            result.discrepancies += 1
                            if on_discrepancy is not None:
                                on_discrepancy(instrument, bar.time, disc_pips, tolerance_pips)
                bar_index += 1

        if len(page) < page_size:
            break
        last_time = page[-1].time
        next_cursor = last_time + timedelta(microseconds=1)
        if next_cursor <= cursor:
            break
        cursor = next_cursor

    return result
