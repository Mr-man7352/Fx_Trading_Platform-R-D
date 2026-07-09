"""QN-001/QN-004 — gRPC health RPC serves; Step 2.3 error mapping.

QuantService RPCs are implemented since Step 2.3; without a DATABASE_URL (the
scaffold test environment) they fail FAILED_PRECONDITION / INVALID_ARGUMENT —
never UNIMPLEMENTED, and never OK. The Node breaker (BE-068) treats any
non-OK as HOLD. Full behavioural coverage lives in tests/quant/.
"""

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


def test_run_pipeline_without_db_is_failed_precondition(
    channel: grpc.Channel, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.config import get_settings

    monkeypatch.setenv("DATABASE_URL", "")  # a repo .env may set it — force off
    get_settings.cache_clear()
    stub = quant_pb2_grpc.QuantServiceStub(channel)
    request = quant_pb2.RunPipelineRequest(
        instrument="EUR_USD", timeframe=quant_pb2.TIMEFRAME_H1
    )
    with pytest.raises(grpc.RpcError) as excinfo:
        stub.RunPipeline(request, timeout=10)
    assert excinfo.value.code() == grpc.StatusCode.FAILED_PRECONDITION
    assert "DATABASE_URL" in excinfo.value.details()


def test_size_position_rejects_bad_arguments(channel: grpc.Channel) -> None:
    stub = quant_pb2_grpc.QuantServiceStub(channel)
    with pytest.raises(grpc.RpcError) as excinfo:
        stub.SizePosition(quant_pb2.SizePositionRequest(instrument="EUR_USD"), timeout=10)
    assert excinfo.value.code() == grpc.StatusCode.INVALID_ARGUMENT


def test_predict_requires_features(channel: grpc.Channel) -> None:
    stub = quant_pb2_grpc.QuantServiceStub(channel)
    request = quant_pb2.PredictRequest(instrument="EUR_USD", timeframe=quant_pb2.TIMEFRAME_H1)
    with pytest.raises(grpc.RpcError) as excinfo:
        stub.Predict(request, timeout=10)
    assert excinfo.value.code() == grpc.StatusCode.INVALID_ARGUMENT
