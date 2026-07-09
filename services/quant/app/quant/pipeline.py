"""Step 2.3 — deterministic pipeline for one closed bar (gRPC `RunPipeline`).

Order of operations per bar (H1 budget 30s — this is all local maths + a few
indexed DB reads):

  candles/spreads/macro/news (point-in-time reads, ts <= bar_ts)
    → features (QN-040/047) → trend + liquidity regime (QN-041)
    → shadow baseline evaluated & persisted (QN-045 — EVERY bar, EVERY mode)
    → features row persisted
    → candidate gate: baseline candidate + champion meta-model ⇒ calibrated
      P(profitable) (QN-043); challenger shadow-scored (QN-046)
    → correlation-cluster refresh check (QN-048 — weekly + event triggers)

No champion model trained yet ⇒ has_candidate=False (deterministic HOLD,
ADR-010) while features/baseline still persist. The bracket geometry attached
to a candidate (1×ATR stop, `rr`×ATR target) is EXACTLY the geometry the
model's labels were trained on — the probability applies to that bracket.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import numpy as np
import pandas as pd

from app.execution.sizing import FixedRates, RateProvider
from app.quant.baseline import BaselineSignalRow, evaluate_baseline
from app.quant.clusters import (
    ClusterParams,
    ClusterSet,
    build_cluster_set,
    realized_vol_spike,
    refresh_reason,
)
from app.quant.features import (
    FEATURE_SET_VERSION,
    WARMUP_BARS,
    compute_features,
    feature_vector,
)
from app.quant.labels import LabelParams
from app.quant.model import predict_proba
from app.quant.regime import (
    LiquidityRegime,
    RegimeResult,
    detect_trend_regime,
    liquidity_regime,
    volume_pctile,
)
from app.quant.registry import ModelRegistry

log = logging.getLogger("fx.quant.pipeline")

MIN_BARS = WARMUP_BARS + 60  # HMM needs ≥ 50 finite observations post-warmup


class InsufficientDataError(Exception):
    """Not enough history to run the pipeline (servicer → FAILED_PRECONDITION)."""


@dataclass(frozen=True, slots=True)
class Candidate:
    instrument: str
    side: str  # "long" | "short"
    probability: float  # calibrated P(profitable)
    model_version: str
    entry_price: float
    stop_loss_price: float
    take_profit_price: float


@dataclass(frozen=True, slots=True)
class PipelineResult:
    instrument: str
    timeframe: str
    bar_ts: datetime
    features: dict[str, float]
    session_label: str
    liquidity_regime: LiquidityRegime
    regime: RegimeResult
    baseline: BaselineSignalRow
    candidate: Candidate | None
    challenger_probability: float | None = None
    meta: dict[str, Any] = field(default_factory=dict)


class QuantPipeline:
    """Deterministic per-bar pipeline over injectable DB + registry seams."""

    def __init__(
        self,
        db: Any,  # QuantDb surface (faked in tests)
        registry: ModelRegistry,
        *,
        lookback_bars: int = 500,
        label_params: LabelParams | None = None,
        cluster_params: ClusterParams | None = None,
        cluster_instruments: list[str] | None = None,
        regime_seed: int = 7,
    ) -> None:
        self._db = db
        self._registry = registry
        self._lookback = lookback_bars
        self._label_params = label_params or LabelParams()
        self._cluster_params = cluster_params or ClusterParams()
        self._cluster_instruments = cluster_instruments or []
        self._seed = regime_seed
        self._last_liquidity: dict[str, LiquidityRegime] = {}

    async def run(self, instrument: str, timeframe: str, bar_ts: datetime) -> PipelineResult:
        candles = await self._db.fetch_candles(instrument, timeframe, bar_ts, self._lookback)
        if len(candles) < MIN_BARS:
            raise InsufficientDataError(
                f"{instrument}/{timeframe}: {len(candles)} bars <= {bar_ts}; need {MIN_BARS}"
            )
        spreads = await self._db.fetch_spreads(instrument, bar_ts)
        macro = await self._db.fetch_macro(bar_ts)
        sentiment = await self._db.fetch_sentiment(instrument, bar_ts)

        feats = compute_features(candles, macro=macro, sentiment=sentiment, spreads=spreads)
        last = feats.iloc[-1]
        vec = feature_vector(last)

        regime = detect_trend_regime(feats["ret_1"], seed=self._seed)
        spread_pct = float(last["spread_pctile"]) if "spread_pctile" in feats and pd.notna(
            last.get("spread_pctile")
        ) else None
        vol_pct = volume_pctile(candles["volume"])
        liquidity = liquidity_regime(spread_pct, vol_pct)
        vec["regime_entropy"] = regime.entropy

        # QN-045 — baseline persists on every processed bar, no matter what.
        baseline = evaluate_baseline(last, instrument=instrument, timeframe=timeframe)
        await self._db.insert_baseline_signal(baseline)
        await self._db.upsert_features(
            instrument=instrument,
            timeframe=timeframe,
            bar_ts=bar_ts,
            version=FEATURE_SET_VERSION,
            session_label=str(last["session_label"]),
            liquidity_regime=str(liquidity),
            features=vec,
        )

        candidate, challenger_p = await self._score_candidate(
            instrument,
            timeframe,
            baseline,
            vec,
            atr=float(last.get("atr_14", float("nan"))),
            entry=float(candles["close"].iloc[-1]),
        )
        meta = await self._maybe_refresh_clusters(instrument, liquidity, feats["ret_1"], bar_ts)

        return PipelineResult(
            instrument=instrument,
            timeframe=timeframe,
            bar_ts=bar_ts,
            features=vec,
            session_label=str(last["session_label"]),
            liquidity_regime=liquidity,
            regime=regime,
            baseline=baseline,
            candidate=candidate,
            challenger_probability=challenger_p,
            meta=meta,
        )

    async def _score_candidate(
        self,
        instrument: str,
        timeframe: str,
        baseline: BaselineSignalRow,
        vec: dict[str, float],
        *,
        atr: float,
        entry: float,
    ) -> tuple[Candidate | None, float | None]:
        if not baseline.would_trade or baseline.side is None:
            return None, None
        if not pd.notna(atr) or atr <= 0:
            return None, None

        champion = await self._registry.champion(instrument, timeframe)
        challenger = await self._registry.newest_challenger(instrument, timeframe)
        side_sign = 1.0 if baseline.side == "long" else -1.0
        x = {**vec, "cand_side": side_sign}

        challenger_p: float | None = None
        if challenger is not None:
            challenger_p = predict_proba(
                challenger.booster, challenger.calibrator, challenger.meta.feature_names, x
            )
            await self._registry.record_shadow(
                instrument, timeframe, challenger.meta.version
            )
        if champion is None:
            log.info(
                "gate_skip no champion model instrument=%s baseline_side=%s",
                instrument,
                baseline.side,
            )
            return None, challenger_p

        p = predict_proba(champion.booster, champion.calibrator, champion.meta.feature_names, x)
        lp = self._label_params
        stop_dist = lp.atr_stop_mult * atr
        if side_sign > 0:
            sl, tp = entry - stop_dist, entry + lp.rr * stop_dist
        else:
            sl, tp = entry + stop_dist, entry - lp.rr * stop_dist
        return (
            Candidate(
                instrument=instrument,
                side=baseline.side,
                probability=p,
                model_version=f"v{champion.meta.version}",
                entry_price=entry,
                stop_loss_price=sl,
                take_profit_price=tp,
            ),
            challenger_p,
        )

    async def _maybe_refresh_clusters(
        self,
        instrument: str,
        liquidity: LiquidityRegime,
        returns: pd.Series,
        bar_ts: datetime,
    ) -> dict[str, Any]:
        """QN-048 — weekly schedule + event triggers, checked on the hot path
        (the recompute itself is a handful of 60-row correlations — cheap)."""
        meta: dict[str, Any] = {}
        prev_liq = self._last_liquidity.get(instrument)
        self._last_liquidity[instrument] = liquidity
        liq_changed = prev_liq is not None and prev_liq != liquidity
        spike = realized_vol_spike(
            returns,
            window=self._cluster_params.vol_spike_window,
            baseline=self._cluster_params.vol_spike_baseline,
            mult=self._cluster_params.vol_spike_mult,
        )
        last_set: ClusterSet | None = await self._db.latest_cluster_set()
        reason = refresh_reason(
            bar_ts,
            last_set,
            params=self._cluster_params,
            liquidity_changed=liq_changed,
            vol_spike=spike,
        )
        if reason is None:
            return meta
        returns_wide = await self._cluster_returns(bar_ts)
        if returns_wide.empty or len(returns_wide.columns) < 2:
            return meta
        cs = build_cluster_set(
            returns_wide,
            version=(last_set.version + 1) if last_set else 1,
            trigger=reason,
            params=self._cluster_params,
            now=bar_ts,
        )
        await self._db.insert_cluster_set(cs)
        meta["clusters_refreshed"] = reason
        meta["cluster_version"] = cs.version
        log.info("correlation clusters recomputed version=%s trigger=%s", cs.version, reason)
        return meta

    async def _cluster_returns(self, bar_ts: datetime) -> pd.DataFrame:
        """Daily log-return matrix across the configured instruments (D1 closes)."""
        frames: dict[str, pd.Series] = {}
        for inst in self._cluster_instruments:
            candles = await self._db.fetch_candles(
                inst, "D1", bar_ts, self._cluster_params.lookback_days + 10
            )
            if len(candles) < 5:
                continue
            closes = candles.set_index("ts")["close"]
            frames[inst] = np.log(closes).diff()
        if not frames:
            return pd.DataFrame()
        return pd.DataFrame(frames).dropna(how="all")


def rates_from_closes(closes: dict[str, float]) -> RateProvider:
    """Latest-close RateProvider (QN-034 FixedRates semantics, USD pivot)."""
    return FixedRates(closes)
