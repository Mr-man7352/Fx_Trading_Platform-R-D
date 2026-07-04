"""Structured JSON logging to stdout (QN-002).

One line per record: ts/level/logger/msg + service/trading_mode, plus
request_id (and user_id) when a RequestContext is bound. Shape mirrors the
Node API's Pino fields so log pipelines treat both planes uniformly.
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import UTC, datetime

from fx_common.context import current_context


class JsonFormatter(logging.Formatter):
    """Render log records as single-line JSON."""

    def __init__(self, service: str, trading_mode: str) -> None:
        super().__init__()
        self._service = service
        self._trading_mode = trading_mode

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "ts": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
            "service": self._service,
            "trading_mode": self._trading_mode,
        }
        ctx = current_context()
        if ctx is not None:
            payload["request_id"] = ctx.request_id
            if ctx.user_id is not None:
                payload["user_id"] = ctx.user_id
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def setup_logging(service: str, trading_mode: str, level: str = "INFO") -> None:
    """Configure root logging with the JSON formatter (idempotent via force=True)."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(service=service, trading_mode=trading_mode))
    logging.basicConfig(level=level.upper(), handlers=[handler], force=True)
    # uvicorn attaches its own handlers; route everything through the root handler.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uv_logger = logging.getLogger(name)
        uv_logger.handlers = []
        uv_logger.propagate = True
