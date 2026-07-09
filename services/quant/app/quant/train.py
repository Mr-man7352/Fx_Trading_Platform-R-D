"""QN-043/QN-046/QN-048 — operator CLI: train / promote / clusters / stability.

    uv run python -m app.quant train    --instrument EUR_USD --timeframe H1
    uv run python -m app.quant promote  --instrument EUR_USD --timeframe H1 --version 2
    uv run python -m app.quant clusters [--trigger manual]

`train` builds the point-in-time dataset from DB candles (baseline candidates
labelled with the QN-042 bracket sim), walk-forward trains + calibrates,
saves the artifact, and registers it as a CHALLENGER — it never serves until
promoted (QN-046). Requires DATABASE_URL and real backfilled history; there is
deliberately no synthetic-data path here (scope decision, Step 2.3).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from dataclasses import asdict
from datetime import UTC, datetime
from typing import Any

from app.config import get_settings
from app.quant.baseline import baseline_sides
from app.quant.clusters import TRIGGER_MANUAL, ClusterParams, build_cluster_set
from app.quant.features import FEATURE_SET_VERSION, compute_features
from app.quant.labels import LabelParams, label_outcomes
from app.quant.model import walk_forward_train
from app.quant.regime import fold_stability
from app.quant.registry import ModelRegistry, ModelStore

log = logging.getLogger("fx.quant.train")

_TRAIN_FETCH_BARS = 20_000  # ≈ 3+ years of H1


async def _open_db() -> tuple[Any, Any]:  # (QuantDb, pool)
    from app.market.dbio import create_pool
    from app.quant.dbio import QuantDb

    settings = get_settings()
    if not settings.database_url:
        raise SystemExit("DATABASE_URL is required for quant CLI commands")
    pool = await create_pool(settings.database_url)
    return QuantDb(pool), pool


async def cmd_train(instrument: str, timeframe: str) -> int:
    settings = get_settings()
    db, pool = await _open_db()
    try:
        now = datetime.now(UTC)
        candles = await db.fetch_candles(instrument, timeframe, now, _TRAIN_FETCH_BARS)
        if len(candles) < 1000:
            raise SystemExit(
                f"only {len(candles)} candles for {instrument}/{timeframe}; "
                "backfill more history before training (QN-021 backfill CLI)"
            )
        spreads = await db.fetch_spreads(instrument, now, limit=50_000)
        macro = await db.fetch_macro(now)
        sentiment = await db.fetch_sentiment(instrument, now, lookback_hours=24 * 365)
        feats = compute_features(candles, macro=macro, sentiment=sentiment, spreads=spreads)

        lp = LabelParams(horizon=settings.label_horizon_bars, rr=settings.min_rr)
        sides = baseline_sides(feats)
        labels = label_outcomes(candles, sides, feats["atr_14"], lp)
        mask = (sides != 0) & labels.notna()
        n_candidates = int(mask.sum())
        if n_candidates < 400:
            raise SystemExit(
                f"only {n_candidates} labelled baseline candidates; not enough to "
                "walk-forward train — backfill more history"
            )
        feature_cols = [c for c in feats.columns if c not in ("ts", "session_label")]
        x = feats.loc[mask, feature_cols].reset_index(drop=True)
        x["cand_side"] = sides[mask].reset_index(drop=True)
        y = labels[mask].reset_index(drop=True)

        result = walk_forward_train(x, y, embargo=lp.horizon)
        # QN-041 AC — out-of-sample regime stability tracked with each train.
        try:
            result.metrics["regime_fold_stability"] = fold_stability(feats["ret_1"])
        except ValueError:
            result.metrics["regime_fold_stability"] = float("nan")

        store = ModelStore(settings.model_dir)
        meta = store.save(
            result,
            instrument=instrument,
            timeframe=timeframe,
            feature_set_version=FEATURE_SET_VERSION,
            label_params=asdict(lp),
        )
        registry = ModelRegistry(store, db)
        await registry.register(meta)
        print(json.dumps({"registered": meta.to_json()["metrics"] | {
            "instrument": instrument, "timeframe": timeframe,
            "version": meta.version, "role": meta.role,
            "artifact": meta.artifact_path,
        }}, indent=2, default=str))
        print(
            f"\nv{meta.version} registered as CHALLENGER — it shadows the champion "
            f"and serves nothing until `promote` (QN-046)."
        )
        return 0
    finally:
        await pool.close()


async def cmd_promote(instrument: str, timeframe: str, version: int, force: bool) -> int:
    settings = get_settings()
    db, pool = await _open_db()
    try:
        registry = ModelRegistry(ModelStore(settings.model_dir), db)
        meta = await registry.promote(instrument, timeframe, version, force=force)
        print(f"promoted {instrument}/{timeframe} v{meta.version} to champion"
              + (" (FORCED)" if force else ""))
        return 0
    finally:
        await pool.close()


async def cmd_clusters(trigger: str) -> int:
    settings = get_settings()
    db, pool = await _open_db()
    try:
        import numpy as np
        import pandas as pd

        params = ClusterParams(
            lookback_days=settings.corr_lookback_days,
            threshold=settings.corr_threshold,
            refresh_days=settings.corr_refresh_days,
            event_lookback_days=settings.corr_event_lookback_days,
            vol_spike_mult=settings.corr_vol_spike_mult,
        )
        now = datetime.now(UTC)
        frames: dict[str, pd.Series] = {}
        for inst in settings.instruments:
            candles = await db.fetch_candles(inst, "D1", now, params.lookback_days + 10)
            if len(candles) >= 5:
                frames[inst] = np.log(candles.set_index("ts")["close"]).diff()
        if len(frames) < 2:
            raise SystemExit("need daily candles for >= 2 instruments to cluster")
        last = await db.latest_cluster_set()
        cs = build_cluster_set(
            pd.DataFrame(frames).dropna(how="all"),
            version=(last.version + 1) if last else 1,
            trigger=trigger,
            params=params,
            now=now,
        )
        await db.insert_cluster_set(cs)
        print(json.dumps({"version": cs.version, "trigger": cs.trigger,
                          "clusters": cs.clusters}, indent=2))
        return 0
    finally:
        await pool.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="app.quant", description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_train = sub.add_parser("train", help="walk-forward train + register challenger")
    p_train.add_argument("--instrument", required=True)
    p_train.add_argument("--timeframe", default="H1")

    p_promote = sub.add_parser("promote", help="challenger → champion (QN-046 gate)")
    p_promote.add_argument("--instrument", required=True)
    p_promote.add_argument("--timeframe", default="H1")
    p_promote.add_argument("--version", type=int, required=True)
    p_promote.add_argument("--force", action="store_true",
                           help="override the min-shadow gate (audited operator action)")

    p_clusters = sub.add_parser("clusters", help="recompute correlation clusters")
    p_clusters.add_argument("--trigger", default=TRIGGER_MANUAL)

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    if args.cmd == "train":
        return asyncio.run(cmd_train(args.instrument, args.timeframe))
    if args.cmd == "promote":
        return asyncio.run(cmd_promote(args.instrument, args.timeframe, args.version, args.force))
    if args.cmd == "clusters":
        return asyncio.run(cmd_clusters(args.trigger))
    return 2  # pragma: no cover


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
