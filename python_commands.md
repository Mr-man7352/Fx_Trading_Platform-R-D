# Python Commands — Quant Service

All commands run from `services/quant/` unless noted. The service is uv-managed (Python 3.13).

## Environment setup

| Command | Description |
|---|---|
| `uv lock` | Resolve and pin dependencies into `uv.lock`. |
| `uv sync` | Install dependencies from the lockfile into `.venv` (lean default — no ML deps). |
| `uv sync --group ml` | Also install the heavy ML group (`torch`, `transformers`) — required for real FinBERT sentiment scoring. |

## Market-data ingestion runners (QN-020/021/022)

Each command no-ops with a clear log line when its config/creds are missing, so all are safe in mock-first mode.

| Command | Description |
|---|---|
| `uv run python -m app.market stream` | Stream live OANDA prices → `market-ticks` BullMQ queue (Node BE-040 consumes). |
| `uv run python -m app.market backfill` | Backfill ~6 months of candles → TimescaleDB `candles` hypertable. Needs OANDA creds in `.env`. Afterwards run `pnpm db:timescale -- --refresh` from repo root to materialize M5…D1 aggregates. |
| `uv run python -m app.market sentiment` | FinBERT-score unscored news rows (needs `uv sync --group ml` for real scoring). |
| `uv run fx-market <stream\|backfill\|sentiment>` | Console-script alias for the same three runners. |

## Run the service

| Command | Description |
|---|---|
| `uv run python -m app` | Start the quant service — FastAPI REST on `:5001` (`/healthz`) + gRPC on `:50051` in one process. (Port 5001 because macOS AirPlay squats on 5000.) |
| `uv run uvicorn app.main:app --port 5001` | Alternative direct uvicorn launch. |

## Code generation

Generated output is committed; CI regenerates and fails on drift. Never edit generated files by hand.

| Command | Description |
|---|---|
| `uv run python scripts/gen_contracts.py` | QN-003 — generate Pydantic v2 models from `@fx/types` JSON Schemas into `app/contracts/`. Requires `pnpm --filter @fx/types build` to have emitted the schemas first. |
| `uv run python scripts/gen_proto.py` | QN-004 — generate Python gRPC stubs from `proto/quant.proto` into `app/proto_gen/`. |
| `bash scripts/check_codegen.sh` | CI drift check — regenerates both and fails if committed output differs. |

## Testing & quality

| Command | Description |
|---|---|
| `uv run pytest` | Run the quant test suite (`tests/` + `libs/fx_common/tests/`). |
| `uv run pytest --cov` | Run tests with coverage. |
| `uv run ruff check .` | Lint. |
| `uv run ruff format .` | Format. |
| `uv run mypy .` | Static type checking. |
