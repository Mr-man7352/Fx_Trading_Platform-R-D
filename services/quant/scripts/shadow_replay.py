"""Phase-2 Section E helper — shadow-replay driver (QN-046 shadow gate).

Replays `QuantPipeline.run` over recent historical bars so the newest CHALLENGER
accumulates `shadow_count` through the exact production path the live Node worker
drives per H1 close — just fast-forwarded over history instead of waiting for
live bars to close. `record_shadow()` bumps once per would-trade bar (baseline
fires) and runs BEFORE the champion check, so a challenger shadows even with no
champion yet. Stops as soon as shadow_count >= --target.

    uv run python scripts/shadow_replay.py --instrument XAU_USD --timeframe H1 --target 100

Requires DATABASE_URL, backfilled H1 history, and a registered challenger
(run `python -m app.quant train ...` first). Replaying writes baseline_signals
+ features rows for the replayed bars, exactly as the live path would — safe in
dev (the DB can be reset freely).
"""

from __future__ import annotations

import argparse
import asyncio

from app.config import get_settings
from app.quant.clusters import ClusterParams
from app.quant.labels import LabelParams
from app.quant.pipeline import InsufficientDataError, QuantPipeline
from app.quant.registry import ModelRegistry, ModelStore

_RECENT_TS = """
SELECT ts FROM candles
WHERE instrument = $1 AND timeframe = $2::timeframe AND complete
ORDER BY ts DESC
LIMIT $3
"""


async def _run(instrument: str, timeframe: str, target: int, window: int) -> int:
    settings = get_settings()
    if not settings.database_url:
        raise SystemExit("DATABASE_URL is required")

    from app.market.dbio import create_pool
    from app.quant.dbio import QuantDb

    pool = await create_pool(settings.database_url)
    db = QuantDb(pool)
    registry = ModelRegistry(ModelStore(settings.model_dir), db)
    pipeline = QuantPipeline(
        db,
        registry,
        lookback_bars=settings.pipeline_lookback_bars,
        label_params=LabelParams(horizon=settings.label_horizon_bars, rr=settings.min_rr),
        cluster_params=ClusterParams(
            lookback_days=settings.corr_lookback_days,
            threshold=settings.corr_threshold,
            refresh_days=settings.corr_refresh_days,
            event_lookback_days=settings.corr_event_lookback_days,
            vol_spike_mult=settings.corr_vol_spike_mult,
        ),
        cluster_instruments=settings.instruments,
    )

    async def shadow_count() -> int:
        models = await db.list_models(instrument, timeframe)
        m = next((m for m in models if m.version == version), None)
        return int(m.shadow_count) if m else 0

    try:
        challenger = await registry.newest_challenger(instrument, timeframe)
        if challenger is None:
            raise SystemExit(
                f"no challenger for {instrument}/{timeframe}; run `train` first"
            )
        version = challenger.meta.version

        async with pool.acquire() as conn:
            rows = await conn.fetch(_RECENT_TS, instrument, timeframe, window)
        # oldest -> newest so the point-in-time replay moves forward through history
        timestamps = [r["ts"] for r in reversed(rows)]
        if not timestamps:
            raise SystemExit("no candles to replay — backfill H1 history first")

        start = await shadow_count()
        print(
            f"challenger v{version}: start shadow_count={start}; "
            f"replaying {len(timestamps)} bars until >= {target} ..."
        )

        processed = 0
        for ts in timestamps:
            try:
                await pipeline.run(instrument, timeframe, ts)
            except InsufficientDataError:
                continue  # early bars lack the lookback window
            processed += 1
            count = await shadow_count()
            if processed % 25 == 0:
                print(f"  processed={processed} shadow_count={count}")
            if count >= target:
                print(
                    f"DONE: shadow_count={count} at bar {ts.isoformat()} "
                    f"(processed {processed} bars). You can now: "
                    f"promote --instrument {instrument} --timeframe {timeframe} "
                    f"--version {version}"
                )
                return 0

        final = await shadow_count()
        print(
            f"replayed {processed} bars; shadow_count={final} (< {target}). "
            f"Increase --window or backfill more H1 history, then re-run."
        )
        return 1
    finally:
        await pool.close()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Shadow-replay driver (Phase-2 Section E)")
    p.add_argument("--instrument", required=True)
    p.add_argument("--timeframe", default="H1")
    p.add_argument("--target", type=int, default=100)
    p.add_argument(
        "--window",
        type=int,
        default=1200,
        help="how many recent bars to replay (must exceed the pipeline lookback)",
    )
    args = p.parse_args(argv)
    return asyncio.run(_run(args.instrument, args.timeframe, args.target, args.window))


if __name__ == "__main__":
    raise SystemExit(main())
