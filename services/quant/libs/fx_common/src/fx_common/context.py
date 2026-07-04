"""Request context propagated via contextvars (QN-002).

Mirrors the Node API's `req.context` (BE-013): every log line and downstream
call inside one request/RPC carries the same `request_id`.
"""

from __future__ import annotations

import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterator


@dataclass(frozen=True, slots=True)
class RequestContext:
    """Immutable per-request metadata."""

    request_id: str
    trading_mode: str
    user_id: str | None = None


_current: ContextVar[RequestContext | None] = ContextVar("fx_request_context", default=None)


def new_request_id() -> str:
    """Generate a request id (uuid4 hex, no dashes — matches Node requestId style)."""
    return uuid.uuid4().hex


def current_context() -> RequestContext | None:
    """Return the context bound to the current task/thread, if any."""
    return _current.get()


@contextmanager
def bind_context(ctx: RequestContext) -> Iterator[RequestContext]:
    """Bind `ctx` for the duration of the `with` block."""
    token = _current.set(ctx)
    try:
        yield ctx
    finally:
        _current.reset(token)
