"""QN-021 — OANDA backfill: idempotency + Twelve Data cross-check."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import cast

import pytest

from app.market.backfill import InMemoryCandleWriter, backfill_candles
from app.market.oanda_client import Candle, OandaClient
from app.market.twelvedata import TwelveDataClient

START = datetime(2026, 3, 10, 14, 0, tzinfo=UTC)
END = datetime(2026, 3, 10, 18, 0, tzinfo=UTC)


def _bars(n: int) -> list[Candle]:
    return [
        Candle(
            instrument="EUR_USD",
            granularity="M1",
            time=START + timedelta(minutes=i),
            open=1.08,
            high=1.081,
            low=1.079,
            close=1.08 + i * 0.0001,
            volume=5,
            complete=True,
        )
        for i in range(n)
    ]


class FakeOanda:
    """Serves candles from a master list, paginated by from_time/count."""

    def __init__(self, bars: list[Candle]) -> None:
        self._bars = bars

    async def fetch_candles(
        self,
        _instrument: str,
        _granularity: str,
        *,
        from_time: datetime,
        count: int,
        include_first: bool = True,
    ) -> list[Candle]:
        ahead = [b for b in self._bars if b.time >= from_time]
        return ahead[:count]


class FakeTwelveData:
    def __init__(self, offset: float) -> None:
        self._offset = offset

    async def sample_mid(self, _symbol: str, _granularity: str, at: datetime) -> float | None:
        bar = next((b for b in _bars(5) if b.time == at), None)
        return bar.close + self._offset if bar else None


@pytest.mark.asyncio
async def test_backfill_loads_all_bars_in_range() -> None:
    writer = InMemoryCandleWriter()
    result = await backfill_candles(
        client=cast(OandaClient, FakeOanda(_bars(5))),
        writer=writer,
        instrument="EUR_USD",
        granularity="M1",
        start=START,
        end=END,
        page_size=2,
    )
    assert result.candles_written == 5
    assert result.pages == 3  # 2 + 2 + 1
    assert len(writer.store) == 5


@pytest.mark.asyncio
async def test_backfill_is_idempotent() -> None:
    writer = InMemoryCandleWriter()
    kwargs = {
        "client": cast(OandaClient, FakeOanda(_bars(5))),
        "writer": writer,
        "instrument": "EUR_USD",
        "granularity": "M1",
        "start": START,
        "end": END,
        "page_size": 2,
    }
    await backfill_candles(**kwargs)  # type: ignore[arg-type]
    await backfill_candles(**kwargs)  # type: ignore[arg-type]
    assert len(writer.store) == 5  # upsert — no duplicates on re-run


@pytest.mark.asyncio
async def test_cross_check_reports_discrepancies() -> None:
    reported: list[tuple[str, datetime, float, float]] = []
    result = await backfill_candles(
        client=cast(OandaClient, FakeOanda(_bars(5))),
        writer=InMemoryCandleWriter(),
        instrument="EUR_USD",
        granularity="M1",
        start=START,
        end=END,
        page_size=5,
        cross_check=cast(TwelveDataClient, FakeTwelveData(offset=0.0005)),  # 5 pips
        cross_check_symbol="EUR/USD",
        tolerance_pips=2.0,
        sample_every=1,
        on_discrepancy=lambda inst, ts, d, tol: reported.append((inst, ts, d, tol)),
    )
    assert result.cross_checks_sampled == 5
    assert result.discrepancies == 5
    assert len(reported) == 5


@pytest.mark.asyncio
async def test_cross_check_within_tolerance_is_silent() -> None:
    result = await backfill_candles(
        client=cast(OandaClient, FakeOanda(_bars(5))),
        writer=InMemoryCandleWriter(),
        instrument="EUR_USD",
        granularity="M1",
        start=START,
        end=END,
        page_size=5,
        cross_check=cast(TwelveDataClient, FakeTwelveData(offset=0.00005)),  # 0.5 pip
        cross_check_symbol="EUR/USD",
        tolerance_pips=2.0,
        sample_every=1,
    )
    assert result.cross_checks_sampled == 5
    assert result.discrepancies == 0
