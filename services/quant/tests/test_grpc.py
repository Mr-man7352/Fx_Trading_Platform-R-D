"""QN-001/QN-004 — gRPC health RPC serves; QuantService RPCs are UNIMPLEMENTED."""

from __future__ import annotations

from collections.abc import Iterator

import grpc
import pytest
from fastapi.testclient import TestClient
from grpc_health.v1 import health_pb2, health_pb2_grpc

from app.grpc.server import QUANT_SERVICE_NAME
from app.proto_gen import quant_pb2, quant_pb2_grpc


@pytest.fixture
def channel(client: TestClient) -> Iterator[grpc.Channel]:
    port = client.app.state.grpc_port  # type: ignore[attr-defined]
    with grpc.insecure_channel(f"127.0.0.1:{port}") as ch:
        yield ch


def test_health_check_serving(channel: grpc.Channel) -> None:
    stub = health_pb2_grpc.HealthStub(channel)
    for service in ("", QUANT_SERVICE_NAME):
        response = stub.Check(health_pb2.HealthCheckRequest(service=service), timeout=5)
        assert response.status == health_pb2.HealthCheckResponse.SERVING


def test_quant_rpcs_are_unimplemented(channel: grpc.Channel) -> None:
    stub = quant_pb2_grpc.QuantServiceStub(channel)
    calls = [
        (stub.RunPipeline, quant_pb2.RunPipelineRequest(instrument="EUR_USD")),
        (stub.SizePosition, quant_pb2.SizePositionRequest(instrument="EUR_USD")),
        (stub.Predict, quant_pb2.PredictRequest(instrument="EUR_USD")),
    ]
    for method, request in calls:
        with pytest.raises(grpc.RpcError) as excinfo:
            method(request, timeout=5)
        assert excinfo.value.code() == grpc.StatusCode.UNIMPLEMENTED
        assert "Phase 2" in excinfo.value.details()
