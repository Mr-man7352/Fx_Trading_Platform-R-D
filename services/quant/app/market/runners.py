"""Ingestion runners (QN-020/021/022) — the executable glue over the library
modules. Each is safe to call with missing config: it logs why it's a no-op and
returns, so `python -m app.market <cmd>` never crashes in mock-first mode.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from app.market.backfill import backfill_candles
from app.market.instruments import get_instrument
from app.market.oanda_client import OandaClient
from app.market.publishers import build_tick_publisher
from app.market.stream import TickStreamAdapter

if TYPE_CHECKING:
    from app.config import Settings

logger = logging.getLogger(__name__)


def _oanda(settings: Settings) -> OandaClient | None:
    if not settings.oanda_api_token or not settings.oanda_account_id:
        logger.warning("OANDA_API_TOKEN/OANDA_ACCOUNT_ID not set — skipping (mock mode)")
        return None
    return OandaClient(
        api_token=settings.oanda_api_token,
        account_id=settings.oanda_account_id,
        rest_host=settings.oanda_rest_host,
        stream_host=settings.oanda_stream_host,
    )


async def run_stream(settings: Settings) -> None:
    """QN-020 — stream OANDA prices → `market-ticks` queue (Node BE-040 consumes)."""
    client = _oanda(settings)
    if client is None:
        return
    publisher = build_tick_publisher(settings.redis_url, settings.market_ticks_queue)
    adapter = TickStreamAdapter(client, publisher)
    instruments = settings.instruments
    logger.info("streaming %d instruments → %s", len(instruments), settings.market_ticks_queue)

    async def _stale_sweep() -> None:
        while True:
            await asyncio.sleep(10)
            adapter.check_stale()

    sweeper = asyncio.create_task(_stale_sweep())
    try:
        await adapter.run(instruments)
    finally:
        sweeper.cancel()
        await getattr(publisher, "close", _noop)()
        await client.aclose()


async def run_backfill(settings: Settings) -> None:
    """QN-021 — backfill the last N months of candles into TimescaleDB."""
    client = _oanda(settings)
    if client is None:
        return
    if not settings.database_url:
        logger.warning("DATABASE_URL not set — cannot write candles; skipping")
        await client.aclose()
        return

    from app.market.dbio import PgCandleWriter, create_pool
    from app.market.twelvedata import TwelveDataClient

    pool = await create_pool(settings.database_url)
    writer = PgCandleWriter(pool)
    cross = (
        TwelveDataClient(api_key=settings.twelve_data_api_key)
        if settings.twelve_data_api_key
        else None
    )
    end = datetime.now(UTC)
    start = end - timedelta(days=settings.backfill_months * 30)
    gran = settings.backfill_granularity
    try:
        for name in settings.instruments:
            info = get_instrument(name)
            result = await backfill_candles(
                client=client,
                writer=writer,
                instrument=name,
                granularity=gran,
                start=start,
                end=end,
                cross_check=cross,
                cross_check_symbol=info.twelve_data_symbol,
                pip=info.pip,
                on_discrepancy=lambda i, ts, d, tol: logger.warning(
                    "cross-check %s %s off by %.1fp (>%.1fp)", i, ts.isoformat(), d, tol
                ),
            )
            logger.info(
                "backfilled %s: %d candles, %d pages, %d discrepancies",
                name,
                result.candles_written,
                result.pages,
                result.discrepancies,
            )
    finally:
        if cross is not None:
            await cross.aclose()
        await client.aclose()
        await pool.close()


async def run_sentiment(settings: Settings) -> None:
    """QN-022 — score unscored news with FinBERT and persist sentiment."""
    if not settings.database_url:
        logger.warning("DATABASE_URL not set — cannot read/write news; skipping")
        return

    from app.market.dbio import create_pool, fetch_unscored_news, store_sentiment
    from app.market.sentiment import FinBertModel, score_headlines

    pool = await create_pool(settings.database_url)
    try:
        headlines = await fetch_unscored_news(pool)
        if not headlines:
            logger.info("no unscored news")
            return
        try:
            scored = score_headlines(FinBertModel(settings.finbert_model), headlines)
        except RuntimeError as exc:  # ml group not installed
            logger.error("%s", exc)
            return
        for item in scored:
            await store_sentiment(pool, item.id, item.sentiment)
        logger.info("scored %d headlines", len(scored))
    finally:
        await pool.close()


async def _noop() -> None:
    return None
