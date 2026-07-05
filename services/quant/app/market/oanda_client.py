"""Minimal OANDA v20 client — auth + pricing stream + candles only (QN-020).

Deliberately narrow: this Phase-1 client does NOT place orders, so QN-020 has no
dependency on the Phase-2 execution adapter (QN-032 builds the full order
lifecycle on this same core). The httpx client is injectable so unit tests use
`httpx.MockTransport` with no network.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING

import httpx

if TYPE_CHECKING:
    from collections.abc import AsyncIterator


def _parse_time(raw: str) -> datetime:
    """OANDA RFC3339 with nanoseconds → aware UTC datetime (ns truncated to µs)."""
    text = raw.replace("Z", "+00:00")
    if "." in text:
        head, tail = text.split(".", 1)
        frac, _, tz = tail.partition("+")
        frac = frac[:6]  # datetime handles at most microseconds
        text = f"{head}.{frac}+{tz}" if tz else f"{head}.{frac}"
    return datetime.fromisoformat(text).astimezone(UTC)


@dataclass(frozen=True, slots=True)
class Tick:
    """A streamed price: mid is the (bid + ask) / 2 convenience midpoint."""

    instrument: str
    time: datetime
    bid: float
    ask: float

    @property
    def mid(self) -> float:
        return (self.bid + self.ask) / 2


@dataclass(frozen=True, slots=True)
class Candle:
    instrument: str
    granularity: str
    time: datetime
    open: float
    high: float
    low: float
    close: float
    volume: int
    complete: bool


class OandaError(RuntimeError):
    """Non-2xx response from OANDA."""


class OandaClient:
    """Auth + pricing-stream + candles over OANDA v20 REST."""

    def __init__(
        self,
        *,
        api_token: str,
        account_id: str,
        rest_host: str = "https://api-fxpractice.oanda.com",
        stream_host: str = "https://stream-fxpractice.oanda.com",
        client: httpx.AsyncClient | None = None,
        stream_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._account_id = account_id
        headers = {"Authorization": f"Bearer {api_token}"}
        self._client = client or httpx.AsyncClient(
            base_url=rest_host, headers=headers, timeout=30.0
        )
        # Streaming has no read timeout (long-lived); heartbeats keep it alive.
        self._stream = stream_client or httpx.AsyncClient(
            base_url=stream_host, headers=headers, timeout=httpx.Timeout(30.0, read=None)
        )

    async def aclose(self) -> None:
        await self._client.aclose()
        await self._stream.aclose()

    async def stream_prices(self, instruments: list[str]) -> AsyncIterator[dict[str, object]]:
        """Yield raw OANDA stream objects (PRICE and HEARTBEAT) as they arrive.

        Callers (the tick-stream adapter) turn PRICE objects into `Tick`s and use
        HEARTBEATs to detect a stalled feed.
        """
        url = f"/v3/accounts/{self._account_id}/pricing/stream"
        params = {"instruments": ",".join(instruments)}
        async with self._stream.stream("GET", url, params=params) as response:
            if response.status_code != 200:
                await response.aread()
                raise OandaError(f"pricing stream failed: HTTP {response.status_code}")
            async for line in response.aiter_lines():
                if line.strip():
                    yield json.loads(line)

    @staticmethod
    def to_tick(msg: dict[str, object]) -> Tick | None:
        """Convert a stream object to a Tick, or None if it is not a price."""
        if msg.get("type") != "PRICE":
            return None
        bids = msg.get("bids") or []
        asks = msg.get("asks") or []
        if not bids or not asks:
            return None
        return Tick(
            instrument=str(msg["instrument"]),
            time=_parse_time(str(msg["time"])),
            bid=float(bids[0]["price"]),  # type: ignore[index]
            ask=float(asks[0]["price"]),  # type: ignore[index]
        )

    async def fetch_candles(
        self,
        instrument: str,
        granularity: str,
        *,
        from_time: datetime,
        count: int = 5000,
        include_first: bool = True,
    ) -> list[Candle]:
        """One page of mid candles from `from_time` forward (≤ 5,000, OANDA cap)."""
        params = {
            "price": "M",
            "granularity": granularity,
            "from": from_time.astimezone(UTC).isoformat().replace("+00:00", "Z"),
            "count": str(min(count, 5000)),
            "includeFirst": str(include_first).lower(),
        }
        resp = await self._client.get(
            f"/v3/instruments/{instrument}/candles", params=params
        )
        if resp.status_code != 200:
            raise OandaError(f"candles {instrument} {granularity} failed: HTTP {resp.status_code}")
        out: list[Candle] = []
        for c in resp.json().get("candles", []):
            mid = c.get("mid")
            if not mid:
                continue
            out.append(
                Candle(
                    instrument=instrument,
                    granularity=granularity,
                    time=_parse_time(c["time"]),
                    open=float(mid["o"]),
                    high=float(mid["h"]),
                    low=float(mid["l"]),
                    close=float(mid["c"]),
                    volume=int(c.get("volume", 0)),
                    complete=bool(c.get("complete", False)),
                )
            )
        return out
