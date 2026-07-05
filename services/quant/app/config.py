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

    # ── Step 1.6 market data (QN-020…022) — all optional in mock-first mode ──
    # Supply the practice-account values to stream/backfill against OANDA v20.
    oanda_api_token: str | None = None
    oanda_account_id: str | None = None
    oanda_environment: Literal["practice", "live"] = "practice"
    # Twelve Data free-tier key for the backfill cross-check (QN-021).
    twelve_data_api_key: str | None = None
    # FinBERT model id (QN-022); the `ml` dependency-group must be installed to
    # load it. Kept configurable so a fine-tuned checkpoint can be swapped in.
    finbert_model: str = "ProsusAI/finbert"
    # Ingestion runners (app.market CLI): where ticks/candles/news go.
    redis_url: str = "redis://localhost:6379"
    database_url: str | None = None
    market_ticks_queue: str = "market-ticks"
    # Instruments to stream/backfill (OANDA names). Comma-separated in env.
    market_instruments: str = "EUR_USD,GBP_USD,USD_JPY,XAU_USD,WTICO_USD,BCO_USD"
    # Backfill window + base granularity (QN-021).
    backfill_months: int = 6
    backfill_granularity: str = "M1"

    @property
    def instruments(self) -> list[str]:
        return [s.strip() for s in self.market_instruments.split(",") if s.strip()]

    @property
    def oanda_rest_host(self) -> str:
        return (
            "https://api-fxtrade.oanda.com"
            if self.oanda_environment == "live"
            else "https://api-fxpractice.oanda.com"
        )

    @property
    def oanda_stream_host(self) -> str:
        return (
            "https://stream-fxtrade.oanda.com"
            if self.oanda_environment == "live"
            else "https://stream-fxpractice.oanda.com"
        )


@lru_cache
def get_settings() -> Settings:
    """Cached settings accessor (tests clear the cache after mutating env)."""
    return Settings()
