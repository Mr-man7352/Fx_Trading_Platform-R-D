"""BE-140 — OpenTelemetry tracing for the quant service.

Completes the trace path Fastify → BullMQ → gRPC → Python: the Node side
(apis/node-api/src/otel.ts) propagates W3C traceparent over gRPC/HTTP; here we
instrument the FastAPI app, the grpc.aio server, and outbound httpx (OANDA
calls) so spans land in the same Tempo trace.

No-op (and dependency-free) unless OTEL_EXPORTER_OTLP_ENDPOINT is set — mirrors
the mock-first pattern used for FinBERT: the opentelemetry packages are regular
deps, but a missing install degrades to a logged warning, never a crash.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from fastapi import FastAPI

    from app.config import Settings

logger = logging.getLogger(__name__)

_TELEMETRY_ON = False


def telemetry_enabled() -> bool:
    return _TELEMETRY_ON


def setup_telemetry(app: FastAPI, settings: Settings) -> bool:
    """Install tracer provider + FastAPI/gRPC-server/httpx instrumentation.

    MUST run before the grpc.aio server is constructed (the aio server
    instrumentor patches the constructor). Returns True when tracing is live.
    """
    global _TELEMETRY_ON
    endpoint = settings.otel_exporter_otlp_endpoint
    if not endpoint:
        return False
    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.instrumentation.grpc import GrpcAioInstrumentorServer
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError:  # pragma: no cover - exercised only in a stale env
        logger.warning(
            "OTEL_EXPORTER_OTLP_ENDPOINT set but opentelemetry packages missing — "
            "run `uv sync` to install them; tracing disabled"
        )
        return False

    provider = TracerProvider(
        resource=Resource.create(
            {
                "service.name": "fx-quant",
                "service.version": settings.git_commit,
                "deployment.environment": settings.trading_mode,
            }
        )
    )
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)

    GrpcAioInstrumentorServer().instrument()
    HTTPXClientInstrumentor().instrument()
    FastAPIInstrumentor.instrument_app(app, excluded_urls="healthz")

    _TELEMETRY_ON = True
    logger.info("OTel tracing enabled → %s", endpoint)
    return True
