"""QN-020 — minimal OANDA client: stream parsing, candles, auth, errors."""

from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest

from app.market.oanda_client import OandaClient, OandaError


def _client(handler, *, stream_handler=None) -> OandaClient:
    rest = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        base_url="https://api-fxpractice.oanda.com",
        headers={"Authorization": "Bearer test"},
    )
    stream = httpx.AsyncClient(
        transport=httpx.MockTransport(stream_handler or handler),
        base_url="https://stream-fxpractice.oanda.com",
        headers={"Authorization": "Bearer test"},
    )
    return OandaClient(
        api_token="test", account_id="101-004-1-001", client=rest, stream_client=stream
    )


def test_to_tick_parses_price_message() -> None:
    msg = {
        "type": "PRICE",
        "instrument": "EUR_USD",
        "time": "2026-03-10T14:00:00.123456789Z",
        "bids": [{"price": "1.08500"}],
        "asks": [{"price": "1.08520"}],
    }
    tick = OandaClient.to_tick(msg)
    assert tick is not None
    assert tick.instrument == "EUR_USD"
    assert tick.bid == pytest.approx(1.085)
    assert tick.ask == pytest.approx(1.0852)
    assert tick.mid == pytest.approx(1.0851)
    assert tick.time == datetime(2026, 3, 10, 14, 0, 0, 123456, tzinfo=UTC)


def test_to_tick_ignores_heartbeats() -> None:
    assert OandaClient.to_tick({"type": "HEARTBEAT", "time": "2026-03-10T14:00:00Z"}) is None


@pytest.mark.asyncio
async def test_fetch_candles_parses_mid() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer test"
        assert "granularity=M1" in str(request.url)
        return httpx.Response(
            200,
            json={
                "candles": [
                    {
                        "time": "2026-03-10T14:00:00.000000000Z",
                        "volume": 12,
                        "complete": True,
                        "mid": {"o": "1.0850", "h": "1.0860", "l": "1.0845", "c": "1.0855"},
                    }
                ]
            },
        )

    client = _client(handler)
    candles = await client.fetch_candles(
        "EUR_USD", "M1", from_time=datetime(2026, 3, 10, 14, 0, tzinfo=UTC)
    )
    await client.aclose()
    assert len(candles) == 1
    assert candles[0].open == pytest.approx(1.085)
    assert candles[0].close == pytest.approx(1.0855)
    assert candles[0].complete is True


@pytest.mark.asyncio
async def test_fetch_candles_raises_on_non_200() -> None:
    client = _client(lambda _req: httpx.Response(401, json={"errorMessage": "no"}))
    with pytest.raises(OandaError, match="HTTP 401"):
        await client.fetch_candles("EUR_USD", "M1", from_time=datetime(2026, 3, 10, tzinfo=UTC))
    await client.aclose()


@pytest.mark.asyncio
async def test_stream_prices_yields_json_objects() -> None:
    body = (
        '{"type":"PRICE","instrument":"EUR_USD","time":"2026-03-10T14:00:00Z",'
        '"bids":[{"price":"1.0850"}],"asks":[{"price":"1.0852"}]}\n'
        '{"type":"HEARTBEAT","time":"2026-03-10T14:00:05Z"}\n'
    )
    client = _client(
        lambda _req: httpx.Response(404),
        stream_handler=lambda _req: httpx.Response(200, text=body),
    )
    seen = [msg async for msg in client.stream_prices(["EUR_USD"])]
    await client.aclose()
    assert [m["type"] for m in seen] == ["PRICE", "HEARTBEAT"]
    assert OandaClient.to_tick(seen[0]) is not None
