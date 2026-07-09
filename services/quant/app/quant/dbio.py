"""Step 2.3 — TimescaleDB I/O for the quant core (asyncpg, schema owned by Prisma).

Read side: candles / spreads / macro / scored news, all point-in-time bounded
(`ts <= bar_ts`). Write side: `features`, `baseline_signals`,
`correlation_clusters`, `model_registry`. asyncpg is imported lazily (same
convention as app.market.dbio); unit tests inject fakes behind the small
`QuantDb` surface.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any

import pandas as pd

from app.quant.baseline import BaselineSignalRow
from app.quant.clusters import ClusterSet
from app.quant.registry import ModelMetadata

_FETCH_CANDLES = """
SELECT ts, open, high, low, close, volume
FROM candles
WHERE instrument = $1 AND timeframe = $2::timeframe AND ts <= $3 AND complete
ORDER BY ts DESC
LIMIT $4
"""

_FETCH_SPREADS = """
SELECT ts, spread_pips
FROM spreads_hist
WHERE instrument = $1 AND ts <= $2
ORDER BY ts DESC
LIMIT $3
"""

_FETCH_MACRO = """
SELECT series, release_ts, value FROM (
  SELECT series, release_ts, value,
         row_number() OVER (PARTITION BY series ORDER BY release_ts DESC) AS rn
  FROM macro_features
  WHERE release_ts <= $1
) t
WHERE rn <= $2
ORDER BY series, release_ts
"""

_FETCH_SENTIMENT = """
SELECT published_at, sentiment AS score
FROM news_archive
WHERE sentiment IS NOT NULL
  AND published_at <= $1
  AND published_at > $1 - $2::interval
  AND ($3::text IS NULL OR $3 = ANY(instruments))
ORDER BY published_at
"""

_UPSERT_FEATURES = """
INSERT INTO features (instrument, timeframe, bar_ts, version, session_label,
                      liquidity_regime, features)
VALUES ($1, $2::timeframe, $3, $4, $5, $6, $7::jsonb)
ON CONFLICT (instrument, timeframe, bar_ts, version) DO UPDATE SET
  session_label = EXCLUDED.session_label,
  liquidity_regime = EXCLUDED.liquidity_regime,
  features = EXCLUDED.features
"""

_INSERT_BASELINE = """
INSERT INTO baseline_signals (id, bar_ts, instrument, timeframe, side, quant_score,
                              would_trade, meta)
VALUES (gen_random_uuid(), $1, $2, $3::timeframe, $4::trade_side, $5, $6, $7::jsonb)
"""

_LATEST_CLOSES = """
SELECT DISTINCT ON (instrument) instrument, close
FROM candles
WHERE timeframe = 'M1'::timeframe AND ts > now() - interval '7 days'
ORDER BY instrument, ts DESC
"""

_INSERT_CLUSTERS = """
INSERT INTO correlation_clusters (id, version, computed_at, trigger, lookback_days,
                                  threshold, clusters, params)
VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
"""

_LATEST_CLUSTERS = """
SELECT version, computed_at, trigger, lookback_days, threshold, clusters, params
FROM correlation_clusters
ORDER BY version DESC
LIMIT 1
"""

_UPSERT_MODEL = """
INSERT INTO model_registry (id, instrument, timeframe, version, role,
                            calibration_method, feature_set_version, trained_at,
                            metrics, artifact_path, shadow_count)
VALUES (gen_random_uuid(), $1, $2::timeframe, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
ON CONFLICT (instrument, timeframe, version) DO UPDATE SET
  role = EXCLUDED.role,
  metrics = EXCLUDED.metrics,
  artifact_path = EXCLUDED.artifact_path
"""

_LIST_MODELS = """
SELECT instrument, timeframe, version, role, calibration_method,
       feature_set_version, trained_at, metrics, artifact_path, shadow_count
FROM model_registry
WHERE instrument = $1 AND timeframe = $2::timeframe
ORDER BY version
"""

_SET_ROLE = """
UPDATE model_registry
SET role = $4, promoted_at = COALESCE($5, promoted_at)
WHERE instrument = $1 AND timeframe = $2::timeframe AND version = $3
"""

_BUMP_SHADOW = """
UPDATE model_registry
SET shadow_count = shadow_count + 1, last_shadow_at = now()
WHERE instrument = $1 AND timeframe = $2::timeframe AND version = $3
RETURNING shadow_count
"""


def _df(records: list[Any], columns: list[str]) -> pd.DataFrame:
    return pd.DataFrame([dict(r) for r in records], columns=columns)


class QuantDb:
    """All quant-core DB access behind one seam (fakeable in tests)."""

    def __init__(self, pool: Any) -> None:
        self._pool = pool

    # ── reads (all point-in-time bounded) ───────────────────────────────────

    async def fetch_candles(
        self, instrument: str, timeframe: str, end: datetime, limit: int
    ) -> pd.DataFrame:
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(_FETCH_CANDLES, instrument, timeframe, end, limit)
        df = _df(rows, ["ts", "open", "high", "low", "close", "volume"])
        return df.sort_values("ts").reset_index(drop=True)

    async def fetch_spreads(
        self, instrument: str, end: datetime, limit: int = 2000
    ) -> pd.DataFrame:
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(_FETCH_SPREADS, instrument, end, limit)
        df = _df(rows, ["ts", "spread_pips"])
        return df.sort_values("ts").reset_index(drop=True)

    async def fetch_macro(self, end: datetime, per_series: int = 200) -> pd.DataFrame:
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(_FETCH_MACRO, end, per_series)
        return _df(rows, ["series", "release_ts", "value"])

    async def fetch_sentiment(
        self, instrument: str | None, end: datetime, lookback_hours: int = 96
    ) -> pd.DataFrame:
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                _FETCH_SENTIMENT, end, timedelta(hours=lookback_hours), instrument
            )
        return _df(rows, ["published_at", "score"])

    async def latest_closes(self) -> dict[str, float]:
        """Latest M1 close per instrument — the live RateProvider input."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(_LATEST_CLOSES)
        return {r["instrument"]: float(r["close"]) for r in rows}

    # ── writes ───────────────────────────────────────────────────────────────

    async def upsert_features(
        self,
        *,
        instrument: str,
        timeframe: str,
        bar_ts: datetime,
        version: int,
        session_label: str,
        liquidity_regime: str,
        features: dict[str, float],
    ) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                _UPSERT_FEATURES,
                instrument,
                timeframe,
                bar_ts,
                version,
                session_label,
                liquidity_regime,
                json.dumps(features),
            )

    async def insert_baseline_signal(self, row: BaselineSignalRow) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                _INSERT_BASELINE,
                row.bar_ts,
                row.instrument,
                row.timeframe,
                row.side,
                row.quant_score,
                row.would_trade,
                json.dumps(row.meta),
            )

    async def insert_cluster_set(self, cs: ClusterSet) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                _INSERT_CLUSTERS,
                cs.version,
                cs.computed_at,
                cs.trigger,
                cs.lookback_days,
                cs.threshold,
                json.dumps(cs.clusters),
                json.dumps(cs.params),
            )

    async def latest_cluster_set(self) -> ClusterSet | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(_LATEST_CLUSTERS)
        if row is None:
            return None
        return ClusterSet(
            version=row["version"],
            computed_at=row["computed_at"],
            trigger=row["trigger"],
            lookback_days=row["lookback_days"],
            threshold=row["threshold"],
            clusters=json.loads(row["clusters"]),
            params=json.loads(row["params"]),
        )

    # ── model registry (RegistryDb protocol) ────────────────────────────────

    async def upsert_model(self, meta: ModelMetadata) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                _UPSERT_MODEL,
                meta.instrument,
                meta.timeframe,
                meta.version,
                meta.role,
                meta.calibration_method,
                meta.feature_set_version,
                meta.trained_at,
                json.dumps(meta.metrics),
                meta.artifact_path,
                meta.shadow_count,
            )

    async def list_models(self, instrument: str, timeframe: str) -> list[ModelMetadata]:
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(_LIST_MODELS, instrument, timeframe)
        return [
            ModelMetadata(
                instrument=r["instrument"],
                timeframe=r["timeframe"],
                version=r["version"],
                role=r["role"],
                trained_at=r["trained_at"],
                calibration_method=r["calibration_method"],
                feature_set_version=r["feature_set_version"],
                feature_names=[],  # full list lives in the artifact metadata.json
                metrics=json.loads(r["metrics"]) if r["metrics"] else {},
                artifact_path=r["artifact_path"],
                shadow_count=r["shadow_count"],
            )
            for r in rows
        ]

    async def set_role(
        self,
        instrument: str,
        timeframe: str,
        version: int,
        role: str,
        promoted_at: datetime | None = None,
    ) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(_SET_ROLE, instrument, timeframe, version, role, promoted_at)

    async def bump_shadow_count(self, instrument: str, timeframe: str, version: int) -> int:
        async with self._pool.acquire() as conn:
            value = await conn.fetchval(_BUMP_SHADOW, instrument, timeframe, version)
        return int(value or 0)
