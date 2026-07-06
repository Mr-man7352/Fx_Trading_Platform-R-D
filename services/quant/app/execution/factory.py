"""BE-050 — adapter factory for the ExecutionService gRPC plane.

The loaded adapter is CACHED for the process lifetime: `connect()` + the
credential DB round-trip must not run per RPC (the reconciler + trade manager
alone would reconnect 4×/min). `reset_adapter_cache()` drops it after a
transport failure so the next call reconnects fresh.
"""

from __future__ import annotations

import asyncio
import os
from typing import TYPE_CHECKING

import asyncpg

from app.config import get_settings
from app.execution.adapter import BrokerAdapter, BrokerError
from app.execution.credentials import CredentialError, load_broker_credentials, parse_encryption_key
from app.execution.oanda_adapter import OandaAdapter

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    AdapterFactory = Callable[[], Awaitable[BrokerAdapter]]

ADAPTER_FACTORIES: dict[str, object] = {}


async def _oanda_factory() -> BrokerAdapter:
    settings = get_settings()
    key_b64 = settings.credentials_encryption_key or os.environ.get("CREDENTIALS_ENCRYPTION_KEY")
    if not key_b64:
        raise BrokerError("CREDENTIALS_ENCRYPTION_KEY is not set")
    db_url = settings.database_url or os.environ.get("DATABASE_URL")
    if not db_url:
        raise BrokerError("DATABASE_URL is not set")
    key = parse_encryption_key(key_b64)
    conn = await asyncpg.connect(db_url)
    try:
        creds = await load_broker_credentials(
            conn,
            key=key,
            broker="oanda",
            environment=settings.oanda_environment,
        )
    finally:
        await conn.close()
    adapter = OandaAdapter.from_credentials(creds, rest_host=settings.oanda_rest_host)
    await adapter.connect()
    return adapter


ADAPTER_FACTORIES["oanda"] = _oanda_factory

_cached_adapter: BrokerAdapter | None = None
_cache_lock = asyncio.Lock()


async def load_adapter() -> BrokerAdapter:
    """Load (and cache) the sole production adapter (OANDA)."""
    global _cached_adapter  # noqa: PLW0603
    async with _cache_lock:
        if _cached_adapter is None:
            factory = ADAPTER_FACTORIES["oanda"]
            _cached_adapter = await factory()  # type: ignore[operator]
        return _cached_adapter


def reset_adapter_cache() -> None:
    """Drop the cached adapter (call after BrokerError → next RPC reconnects)."""
    global _cached_adapter  # noqa: PLW0603
    _cached_adapter = None
