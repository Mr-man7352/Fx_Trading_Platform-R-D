"""Service settings (QN-001) — env-driven, fail-fast at boot.

Mirrors the Node side's Zod env validation (`apis/node-api/src/env.ts`):
an invalid TRADING_MODE raises at startup instead of defaulting silently.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

# Same single flag, same values as BE-003 — one identical code path everywhere.
TradingMode = Literal["backtest", "paper", "live"]

_DEFAULT_CONTRACTS_DIR = Path(__file__).resolve().parent / "contracts" / "schemas"


class Settings(BaseSettings):
    """Env-backed settings; field names map to UPPER_SNAKE env vars."""

    model_config = SettingsConfigDict(frozen=True)

    trading_mode: TradingMode = "paper"
    # 5001, not 5000 — macOS AirPlay Receiver squats on 5000 (DEVLOG conventions).
    quant_port: int = 5001
    quant_grpc_port: int = 50051
    git_commit: str = "dev"
    log_level: str = "INFO"
    # Vendored @fx/types JSON Schemas (QN-003); consumed via fx_common.load_contract.
    fx_contracts_dir: Path = _DEFAULT_CONTRACTS_DIR


@lru_cache
def get_settings() -> Settings:
    """Cached settings accessor (tests clear the cache after mutating env)."""
    return Settings()
