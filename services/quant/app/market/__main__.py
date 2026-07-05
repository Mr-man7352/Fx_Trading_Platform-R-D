"""CLI entrypoint for the market-data ingestion runners (QN-020/021/022).

Usage:
    uv run python -m app.market stream      # OANDA prices → market-ticks queue
    uv run python -m app.market backfill    # 6-month candle backfill → TimescaleDB
    uv run python -m app.market sentiment   # FinBERT-score unscored news

Each command no-ops with a clear log line when its config/creds are missing, so
it is safe to run in mock-first mode.
"""

from __future__ import annotations

import argparse
import asyncio
from collections.abc import Callable, Coroutine
from typing import Any

from fx_common import setup_logging

from app.config import Settings, get_settings
from app.market.runners import run_backfill, run_sentiment, run_stream

_COMMANDS: dict[str, Callable[[Settings], Coroutine[Any, Any, None]]] = {
    "stream": run_stream,
    "backfill": run_backfill,
    "sentiment": run_sentiment,
}


def main() -> None:
    parser = argparse.ArgumentParser(prog="app.market", description="Market-data ingestion runners")
    parser.add_argument("command", choices=sorted(_COMMANDS), help="which runner to execute")
    args = parser.parse_args()

    settings = get_settings()
    setup_logging("quant", settings.trading_mode, settings.log_level)
    asyncio.run(_COMMANDS[args.command](settings))


if __name__ == "__main__":
    main()
