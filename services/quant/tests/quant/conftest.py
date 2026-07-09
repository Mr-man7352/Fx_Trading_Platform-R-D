"""Step 2.3 shared fixtures: synthetic candles, fake QuantDb, trained model.

Everything is seeded — the whole quant core is deterministic and so are its
tests. The fake DB implements the exact `QuantDb` surface the pipeline and
registry use (same convention as tests/execution/fake_oanda.py: faithful
fakes, no DB required).
"""

from __future__ import annotations

from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from typing import Any

import numpy as np
import pandas as pd
import pytest

from app.quant.baseline import BaselineSignalRow
from app.quant.clusters import ClusterSet
from app.quant.features import FEATURE_SET_VERSION, compute_features
from app.quant.labels import LabelParams, label_outcomes
from app.quant.model import walk_forward_train
from app.quant.registry import ModelMetadata, ModelStore

START = datetime(2025, 1, 6, 0, 0, tzinfo=UTC)  # a Monday

FAST_LGBM = {"num_boost_round": 40, "min_data_in_leaf": 10}


def make_candles(
    n: int,
    *,
    drift: float = 0.0,
    vol: float = 0.001,
    seed: int = 42,
    start: datetime = START,
    price0: float = 1.10,
    freq_hours: int = 1,
) -> pd.DataFrame:
    """Seeded random-walk H1 candles with plausible OHLC geometry."""
    rng = np.random.default_rng(seed)
    rets = drift + vol * rng.standard_normal(n)
    closes = price0 * np.exp(np.cumsum(rets))
    opens = np.concatenate([[price0], closes[:-1]])
    spread = vol * price0 * np.abs(rng.standard_normal(n)) * 0.8
    highs = np.maximum(opens, closes) + spread
    lows = np.minimum(opens, closes) - spread
    ts = [start + timedelta(hours=freq_hours * i) for i in range(n)]
    return pd.DataFrame(
        {
            "ts": pd.to_datetime(ts, utc=True),
            "open": opens,
            "high": highs,
            "low": lows,
            "close": closes,
            "volume": rng.uniform(500, 1500, n),
        }
    )


class FakeQuantDb:
    """In-memory QuantDb + RegistryDb double (the full seam the core uses)."""

    def __init__(self) -> None:
        self.candles: dict[tuple[str, str], pd.DataFrame] = {}
        self.spreads: dict[str, pd.DataFrame] = {}
        self.macro = pd.DataFrame(columns=["series", "release_ts", "value"])
        self.sentiment = pd.DataFrame(columns=["published_at", "score"])
        self.features_rows: list[dict[str, Any]] = []
        self.baselines: list[BaselineSignalRow] = []
        self.cluster_sets: list[ClusterSet] = []
        self.models: dict[tuple[str, str, int], ModelMetadata] = {}

    # ── reads ────────────────────────────────────────────────────────────────

    async def fetch_candles(
        self, instrument: str, timeframe: str, end: datetime, limit: int
    ) -> pd.DataFrame:
        df = self.candles.get((instrument, timeframe))
        if df is None:
            return pd.DataFrame(columns=["ts", "open", "high", "low", "close", "volume"])
        out = df[df["ts"] <= pd.Timestamp(end)]
        return out.tail(limit).reset_index(drop=True)

    async def fetch_spreads(
        self, instrument: str, end: datetime, limit: int = 2000
    ) -> pd.DataFrame:
        df = self.spreads.get(instrument)
        if df is None:
            return pd.DataFrame(columns=["ts", "spread_pips"])
        return df[df["ts"] <= pd.Timestamp(end)].tail(limit).reset_index(drop=True)

    async def fetch_macro(self, end: datetime, per_series: int = 200) -> pd.DataFrame:
        return self.macro[self.macro["release_ts"] <= pd.Timestamp(end)].reset_index(drop=True) \
            if len(self.macro) else self.macro

    async def fetch_sentiment(
        self, instrument: str | None, end: datetime, lookback_hours: int = 96
    ) -> pd.DataFrame:
        if not len(self.sentiment):
            return self.sentiment
        return self.sentiment[
            self.sentiment["published_at"] <= pd.Timestamp(end)
        ].reset_index(drop=True)

    async def latest_closes(self) -> dict[str, float]:
        out: dict[str, float] = {}
        for (inst, _tf), df in self.candles.items():
            if len(df):
                out[inst] = float(df["close"].iloc[-1])
        return out

    # ── writes ───────────────────────────────────────────────────────────────

    async def upsert_features(self, **kwargs: Any) -> None:
        self.features_rows.append(kwargs)

    async def insert_baseline_signal(self, row: BaselineSignalRow) -> None:
        self.baselines.append(row)

    async def insert_cluster_set(self, cs: ClusterSet) -> None:
        self.cluster_sets.append(cs)

    async def latest_cluster_set(self) -> ClusterSet | None:
        return max(self.cluster_sets, key=lambda c: c.version) if self.cluster_sets else None

    # ── RegistryDb protocol ──────────────────────────────────────────────────

    async def upsert_model(self, meta: ModelMetadata) -> None:
        self.models[(meta.instrument, meta.timeframe, meta.version)] = meta

    async def list_models(self, instrument: str, timeframe: str) -> list[ModelMetadata]:
        return sorted(
            (m for (i, t, _v), m in self.models.items() if i == instrument and t == timeframe),
            key=lambda m: m.version,
        )

    async def set_role(
        self,
        instrument: str,
        timeframe: str,
        version: int,
        role: str,
        promoted_at: datetime | None = None,
    ) -> None:
        self.models[(instrument, timeframe, version)].role = role

    async def bump_shadow_count(self, instrument: str, timeframe: str, version: int) -> int:
        meta = self.models[(instrument, timeframe, version)]
        meta.shadow_count += 1
        return meta.shadow_count


@pytest.fixture
def fake_db() -> FakeQuantDb:
    return FakeQuantDb()


@pytest.fixture(scope="session")
def training_candles() -> pd.DataFrame:
    """Mild-drift walk — produces both winning and losing bracket outcomes."""
    return make_candles(1500, drift=0.0004, vol=0.002, seed=11)


@pytest.fixture(scope="session")
def trained_artifacts(tmp_path_factory: pytest.TempPathFactory, training_candles: pd.DataFrame):
    """(store, meta, train_result): a real walk-forward-trained model whose
    feature names match what the pipeline feeds predict_proba."""
    feats = compute_features(training_candles)
    lp = LabelParams()
    rng = np.random.default_rng(3)
    sides = pd.Series(rng.choice([1.0, -1.0], size=len(feats)), index=feats.index)
    labels = label_outcomes(training_candles, sides, feats["atr_14"], lp)
    mask = labels.notna() & feats["atr_14"].notna()
    feature_cols = [c for c in feats.columns if c not in ("ts", "session_label")]
    x = feats.loc[mask, feature_cols].reset_index(drop=True)
    x["cand_side"] = sides[mask].reset_index(drop=True)
    y = labels[mask].reset_index(drop=True)

    result = walk_forward_train(x, y, embargo=lp.horizon, lgbm_params=FAST_LGBM)
    store = ModelStore(tmp_path_factory.mktemp("models"))
    meta = store.save(
        result,
        instrument="EUR_USD",
        timeframe="H1",
        feature_set_version=FEATURE_SET_VERSION,
        label_params=asdict(lp),
        trained_at=datetime(2025, 3, 1, tzinfo=UTC),
    )
    return store, meta, result
