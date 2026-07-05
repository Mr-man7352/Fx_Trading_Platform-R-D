"""QN-020/021/022 — ingestion runner wiring: publisher shape + no-op guards."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.config import Settings
from app.market.oanda_client import Tick
from app.market.publishers import LoggingTickPublisher, build_tick_publisher, tick_to_job
from app.market.runners import run_backfill, run_sentiment, run_stream

TICK = Tick(
    instrument="EUR_USD", time=datetime(2026, 3, 10, 14, 0, tzinfo=UTC), bid=1.085, ask=1.0852
)


def test_tick_to_job_matches_node_tickjob_shape() -> None:
    job = tick_to_job(TICK)
    assert job == {
        "instrument": "EUR_USD",
        "ts": "2026-03-10T14:00:00+00:00",
        "bid": 1.085,
        "ask": 1.0852,
    }


def test_build_tick_publisher_falls_back_without_redis() -> None:
    pub = build_tick_publisher(None)
    assert isinstance(pub, LoggingTickPublisher)


@pytest.mark.asyncio
async def test_logging_publisher_counts() -> None:
    pub = LoggingTickPublisher()
    await pub.publish(TICK)
    await pub.publish(TICK)
    assert pub.count == 2
    await pub.close()


@pytest.mark.asyncio
async def test_run_stream_is_noop_without_oanda_creds() -> None:
    # No OANDA token/account → returns immediately, no network, no raise.
    await run_stream(Settings(oanda_api_token=None, oanda_account_id=None))


@pytest.mark.asyncio
async def test_run_backfill_is_noop_without_creds_or_db() -> None:
    await run_backfill(Settings(oanda_api_token="t", oanda_account_id="a", database_url=None))
    await run_backfill(Settings(oanda_api_token=None, oanda_account_id=None))


@pytest.mark.asyncio
async def test_run_sentiment_is_noop_without_db() -> None:
    await run_sentiment(Settings(database_url=None))
