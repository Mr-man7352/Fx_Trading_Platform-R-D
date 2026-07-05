"""Postgres/TimescaleDB I/O for the ingestion runners (QN-021/QN-022).

Writes candles and reads/writes news sentiment via asyncpg. The DB schema is
owned by Node/Prisma (Step 1.4); this is a thin, idempotent loader. asyncpg is
imported lazily so the module loads without it (unit tests inject fakes).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from app.market.backfill import CandleWriter

if TYPE_CHECKING:
    from app.market.oanda_client import Candle
    from app.market.sentiment import Headline

_UPSERT_CANDLES = """
INSERT INTO candles (instrument, timeframe, ts, open, high, low, close, volume, complete, source)
VALUES ($1, $2::timeframe, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (instrument, timeframe, ts) DO UPDATE SET
  open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
  close = EXCLUDED.close, volume = EXCLUDED.volume,
  complete = EXCLUDED.complete, source = EXCLUDED.source
"""


async def create_pool(database_url: str) -> Any:
    """Open an asyncpg pool (lazy import — asyncpg is an optional runtime dep)."""
    import asyncpg

    return await asyncpg.create_pool(dsn=database_url, min_size=1, max_size=4)


class PgCandleWriter(CandleWriter):
    """Idempotent candle upsert into the `candles` hypertable."""

    def __init__(self, pool: Any) -> None:
        self._pool = pool

    async def upsert(self, candles: list[Candle]) -> int:
        if not candles:
            return 0
        rows = [
            (
                c.instrument,
                c.granularity,
                c.time,
                c.open,
                c.high,
                c.low,
                c.close,
                float(c.volume),
                c.complete,
                "oanda",
            )
            for c in candles
        ]
        async with self._pool.acquire() as conn:
            await conn.executemany(_UPSERT_CANDLES, rows)
        return len(rows)


async def fetch_unscored_news(pool: Any, limit: int = 500) -> list[Headline]:
    """News rows with no sentiment yet, newest first (bounded by `limit`)."""
    from app.market.sentiment import Headline

    sql = """
    SELECT id::text AS id, published_at, headline
    FROM news_archive
    WHERE sentiment IS NULL
    ORDER BY published_at DESC
    LIMIT $1
    """
    async with pool.acquire() as conn:
        records = await conn.fetch(sql, limit)
    return [
        Headline(id=r["id"], published_at=r["published_at"], text=r["headline"]) for r in records
    ]


async def store_sentiment(pool: Any, news_id: str, sentiment: float) -> None:
    """Persist a signed sentiment score back onto its immutable news row."""
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE news_archive SET sentiment = $2 WHERE id = $1::uuid", news_id, sentiment
        )
