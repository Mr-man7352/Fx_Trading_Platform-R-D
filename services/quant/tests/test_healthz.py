"""QN-001 — /healthz matches the @fx/types HealthResponse contract."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.contracts.HealthResponse import HealthResponse


def test_healthz_returns_200(client: TestClient) -> None:
    response = client.get("/healthz")
    assert response.status_code == 200


def test_healthz_matches_contract(client: TestClient) -> None:
    body = client.get("/healthz").json()
    # Exact contract shape — additionalProperties is false in the schema.
    assert set(body) == {"status", "commit", "uptime", "tradingMode"}
    parsed = HealthResponse.model_validate(body)
    assert parsed.status == "ok"
    assert parsed.trading_mode == "paper"
    assert parsed.uptime >= 0


def test_unknown_route_is_404(client: TestClient) -> None:
    assert client.get("/nope").status_code == 404
