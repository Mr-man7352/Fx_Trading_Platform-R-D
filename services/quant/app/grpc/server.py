"""grpc.aio server lifecycle (QN-001) — health RPC on :50051.

Standard `grpc.health.v1` health service (SERVING for "" and the QuantService
name) + the QN-004 QuantService stubs. Owned by the FastAPI lifespan.
"""

from __future__ import annotations

import grpc
from grpc_health.v1 import health, health_pb2, health_pb2_grpc

from app.grpc.servicer import QuantServicer
from app.proto_gen import quant_pb2_grpc

QUANT_SERVICE_NAME = "fx.quant.v1.QuantService"
_GRACE_SECONDS = 5.0


class GrpcServer:
    """Thin wrapper: build, start (health → SERVING), stop (health → NOT_SERVING)."""

    def __init__(self, port: int) -> None:
        self._server = grpc.aio.server()
        self._health = health.aio.HealthServicer()
        quant_pb2_grpc.add_QuantServiceServicer_to_server(QuantServicer(), self._server)
        health_pb2_grpc.add_HealthServicer_to_server(self._health, self._server)
        # port 0 → ephemeral (tests); bound_port carries the real one.
        self.bound_port: int = self._server.add_insecure_port(f"0.0.0.0:{port}")

    async def start(self) -> None:
        await self._server.start()
        for name in ("", QUANT_SERVICE_NAME):
            await self._health.set(name, health_pb2.HealthCheckResponse.SERVING)

    async def stop(self) -> None:
        for name in ("", QUANT_SERVICE_NAME):
            await self._health.set(name, health_pb2.HealthCheckResponse.NOT_SERVING)
        await self._server.stop(grace=_GRACE_SECONDS)
