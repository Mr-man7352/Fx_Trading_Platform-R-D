"""Twelve Data free-tier cross-check client (QN-021).

Used only to sample-verify OANDA candles during backfill — never as a primary
feed (the free tier is rate-limited to a handful of requests per minute). httpx
is injectable for tests.
"""

from __future__ import annotations

from datetime import UTC, datetime

import httpx

_INTERVAL = {
    "M1": "1min",
    "M5": "5min",
    "M15": "15min",
    "M30": "30min",
    "H1": "1h",
    "H4": "4h",
    "D": "1day",
    "W": "1week",
}


class TwelveDataClient:
    def __init__(
        self,
        *,
        api_key: str,
        client: httpx.AsyncClient | None = None,
        host: str = "https://api.twelvedata.com",
    ) -> None:
        self._key = api_key
        self._client = client or httpx.AsyncClient(base_url=host, timeout=30.0)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def sample_mid(self, symbol: str, granularity: str, at: datetime) -> float | None:
        """Closing mid for `symbol` at/just before `at`; None if unavailable."""
        interval = _INTERVAL.get(granularity)
        if interval is None:
            return None
        params = {
            "symbol": symbol,
            "interval": interval,
            "outputsize": "1",
            "end_date": at.astimezone(UTC).isoformat().replace("+00:00", "Z"),
            "format": "JSON",
            "apikey": self._key,
        }
        resp = await self._client.get("/time_series", params=params)
        if resp.status_code != 200:
            return None
        values = resp.json().get("values")
        if not values:
            return None
        return float(values[0]["close"])
