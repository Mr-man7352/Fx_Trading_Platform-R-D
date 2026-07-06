"""FastAPI entrypoint (QN-001).

REST on :5001 (`/healthz`; 5001 because macOS AirPlay squats on 5000), gRPC on
:50051 started/stopped by the FastAPI lifespan so one process serves both
planes. Run: `uv run python -m app` (or `uvicorn app.main:app --port 5001`).
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

from fastapi import FastAPI
from fx_common import setup_logging

from app.config import get_settings
from app.contracts.HealthResponse import HealthResponse, TradingMode
from app.grpc.server import GrpcServer
from app.telemetry import setup_telemetry

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

logger = logging.getLogger(__name__)


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    setup_logging("quant", settings.trading_mode, settings.log_level)
    # BE-140 — must precede GrpcServer(): the aio-server instrumentor patches
    # the server constructor. No-op without OTEL_EXPORTER_OTLP_ENDPOINT.
    setup_telemetry(app, settings)

    grpc_server = GrpcServer(port=settings.quant_grpc_port)
    await grpc_server.start()
    app.state.grpc_port = grpc_server.bound_port
    app.state.started_at = time.monotonic()
    logger.info(
        "quant service up: http=:%s grpc=:%s trading_mode=%s commit=%s",
        settings.quant_port,
        grpc_server.bound_port,
        settings.trading_mode,
        settings.git_commit,
    )
    try:
        yield
    finally:
        await grpc_server.stop()
        logger.info("quant service shut down")


def create_app() -> FastAPI:
    """App factory (kept import-time side-effect free for tests)."""
    app = FastAPI(title="fx-quant", lifespan=_lifespan)

    @app.get("/healthz", response_model=HealthResponse)
    def healthz() -> HealthResponse:
        settings = get_settings()
        return HealthResponse(
            status="ok",
            commit=settings.git_commit,
            uptime=time.monotonic() - app.state.started_at,
            tradingMode=TradingMode(settings.trading_mode),
        )

    return app


app = create_app()
