"""Shared fixtures (QN-001)."""

from __future__ import annotations

import os
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

# Ephemeral gRPC port so parallel test runs never collide; set before app import.
os.environ.setdefault("QUANT_GRPC_PORT", "0")

from app.config import get_settings
from app.main import create_app


@pytest.fixture(autouse=True)
def _fresh_settings() -> Iterator[None]:
    """Settings are lru_cached; clear around each test so env monkeypatching works."""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def client() -> Iterator[TestClient]:
    """TestClient with lifespan running → gRPC server is live on app.state.grpc_port."""
    app = create_app()
    with TestClient(app) as test_client:
        yield test_client
