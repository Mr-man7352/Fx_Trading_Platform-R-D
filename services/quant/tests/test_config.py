"""QN-001 — TRADING_MODE env is read at boot and validated fail-fast."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.config import Settings


def test_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TRADING_MODE", raising=False)
    settings = Settings()
    assert settings.trading_mode == "paper"
    assert settings.quant_port == 5001
    assert settings.quant_grpc_port in (0, 50051)  # conftest pins 0 for tests


@pytest.mark.parametrize("mode", ["backtest", "paper", "live"])
def test_trading_mode_from_env(monkeypatch: pytest.MonkeyPatch, mode: str) -> None:
    monkeypatch.setenv("TRADING_MODE", mode)
    assert Settings().trading_mode == mode


def test_invalid_trading_mode_fails_fast(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TRADING_MODE", "yolo")
    with pytest.raises(ValidationError):
        Settings()
