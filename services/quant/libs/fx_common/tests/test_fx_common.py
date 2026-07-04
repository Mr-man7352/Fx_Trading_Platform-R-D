"""QN-002 — fx_common: RequestContext, FXError, JSON logging, load_contract."""

from __future__ import annotations

import json
import logging
from pathlib import Path

import pytest
from fx_common import (
    FXError,
    RequestContext,
    bind_context,
    current_context,
    load_contract,
    new_request_id,
    setup_logging,
)

SCHEMAS_DIR = Path(__file__).resolve().parents[3] / "app" / "contracts" / "schemas"


def test_request_context_binding() -> None:
    assert current_context() is None
    ctx = RequestContext(request_id=new_request_id(), trading_mode="paper")
    with bind_context(ctx):
        assert current_context() is ctx
    assert current_context() is None


def test_fx_error_matches_api_error_contract() -> None:
    err = FXError("BAD_INPUT", "nope", details=[{"field": "x", "message": "required"}])
    payload = err.to_dict()
    assert payload == {
        "error": {
            "code": "BAD_INPUT",
            "message": "nope",
            "details": [{"field": "x", "message": "required"}],
        }
    }
    # Shape is valid against the vendored ApiError schema's required keys.
    schema = load_contract("ApiError", SCHEMAS_DIR)
    error_obj = payload["error"]
    assert isinstance(error_obj, dict)
    for key in schema["properties"]["error"]["required"]:
        assert key in error_obj


def test_load_contract_known_schema() -> None:
    schema = load_contract("HealthResponse", SCHEMAS_DIR)
    assert schema["title"] == "HealthResponse"
    assert set(schema["required"]) == {"status", "commit", "uptime", "tradingMode"}


def test_load_contract_missing_schema() -> None:
    with pytest.raises(FXError) as excinfo:
        load_contract("NotAContract", SCHEMAS_DIR)
    assert excinfo.value.code == "CONTRACT_NOT_FOUND"


def test_load_contract_no_dir_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FX_CONTRACTS_DIR", raising=False)
    with pytest.raises(FXError) as excinfo:
        load_contract("HealthResponse")
    assert excinfo.value.code == "CONTRACTS_DIR_UNSET"


def test_json_logging_includes_context(capsys: pytest.CaptureFixture[str]) -> None:
    setup_logging("quant", "backtest", "INFO")
    ctx = RequestContext(request_id="req-123", trading_mode="backtest", user_id="u1")
    with bind_context(ctx):
        logging.getLogger("test").info("hello %s", "world")
    line = capsys.readouterr().out.strip().splitlines()[-1]
    record = json.loads(line)
    assert record["msg"] == "hello world"
    assert record["service"] == "quant"
    assert record["trading_mode"] == "backtest"
    assert record["request_id"] == "req-123"
    assert record["user_id"] == "u1"
    assert record["level"] == "info"
