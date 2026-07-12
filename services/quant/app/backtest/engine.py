"""QN-050 — vectorised quant-core backtest engine.

Architecture (scope note in the story): this engine covers the QUANT-CORE-ONLY
path. Agent + memory backtests are inherently sequential and run through the
Node event-driven runner (QN-056), which reconciles its quant-only
configuration against THIS engine as a correctness cross-check.

Fill semantics are the SINGLE SOURCE OF TRUTH shared with model training:
entry at bar close, 1×ATR stop / rr×ATR target, first-touch resolution with
the conservative SL-first tie-break, horizon expiry at close — exactly
`app.quant.labels` (the geometry the champion's probabilities are calibrated
on). Costs (spread / slippage / swap / rollover / weekend gap / flash-crash
slippage) are layered on by `app.backtest.costs`.

vectorbt integration: fills come from the deterministic ledger above (bracket
semantics + gap/swap modelling that `Portfolio.from_signals` cannot express);
vectorbt — when installed — computes the equity-curve statistics (Sharpe,
max drawdown) from the ledger's bar-level returns and the backend used is
recorded in the report (`metrics_backend`). Without vectorbt the same
statistics come from a numpy fallback with identical definitions, so unit
tests and CI never depend on numba.

Features/probabilities are point-in-time by construction: `compute_features`
(QN-040) only joins `release_ts <= bar_ts` / `published_at <= bar_ts`
(QN-051); the engine additionally runs the leakage check from
`app.backtest.pit` and embeds the result in the report.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable

import numpy as np
import pandas as pd

from app.backtest.costs import (
    CostParams,
    TradeCosts,
    effective_spread_pips,
    pip_size,
    stop_exit_slippage_pips,
    swap_pips,
)
from app.backtest.pit import sentiment_leakage_check
from app.quant.baseline import baseline_sides
from app.quant.features import compute_features
from app.quant.labels import LabelParams

log = logging.getLogger("fx.backtest.engine")

BARS_PER_YEAR_H1 = 6240  # ~24×5×52 tradable H1 bars

# ─── Config / results ────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class BacktestParams:
    instrument: str
    timeframe: str = "H1"
    # ADR-008 default threshold; sweep covers the story's 0.55–0.70 AC.
    probability_threshold: float = 0.60
    sweep: tuple[float, ...] = (0.55, 0.575, 0.60, 0.625, 0.65, 0.675, 0.70)
    label_params: LabelParams = field(default_factory=LabelParams)
    cost_params: CostParams = field(default_factory=CostParams)
    risk_pct: float = 0.01  # must match the QN-056 runner (BACKTEST_RISK_PCT)
    initial_equity: float = 10_000.0


@dataclass(slots=True)
class SimTrade:
    entry_ts: datetime
    exit_ts: datetime
    side: str  # "long" | "short"
    probability: float
    entry_price: float
    exit_price: float
    exit_reason: str  # SL | TP | EXPIRY | GAP_SL | END
    gross_pips: float
    costs: TradeCosts
    net_pips: float
    r_multiple: float
    pnl: float
    equity_after: float

    def to_json(self) -> dict[str, Any]:
        return {
            "entry_ts": self.entry_ts.isoformat(),
            "exit_ts": self.exit_ts.isoformat(),
            "side": self.side,
            "probability": round(self.probability, 6),
            "entry_price": self.entry_price,
            "exit_price": self.exit_price,
            "exit_reason": self.exit_reason,
            "gross_pips": round(self.gross_pips, 3),
            "net_pips": round(self.net_pips, 3),
            "r_multiple": round(self.r_multiple, 4),
            "pnl": round(self.pnl, 2),
            "equity_after": round(self.equity_after, 2),
            "costs": self.costs.to_json(),
        }


# ─── Vectorised probability scoring ─────────────────────────────────────────

ProbaFn = Callable[[pd.DataFrame, pd.Series], np.ndarray]
"""(feature frame, candidate sides) → calibrated P(profitable) per row.

Production: `champion_proba_fn` (LightGBM + calibrator, vectorised).
Tests: any deterministic function — the engine never imports lightgbm itself.
"""


def champion_proba_fn(booster: Any, calibrator: Any, feature_names: list[str]) -> ProbaFn:
    """Vectorised QN-043 scoring: one predict over all candidate rows."""

    def fn(features: pd.DataFrame, sides: pd.Series) -> np.ndarray:
        x = pd.DataFrame(
            {
                name: (
                    sides.to_numpy(dtype=np.float64)
                    if name == "cand_side"
                    else features[name].to_numpy(dtype=np.float64)
                    if name in features
                    else np.full(len(features), np.nan)
                )
                for name in feature_names
            },
            index=features.index,
        )
        p_raw = np.asarray(booster.predict(x), dtype=np.float64)
        return np.asarray(calibrator.apply(p_raw), dtype=np.float64)

    return fn


# ─── Metrics (vectorbt when available, identical numpy fallback otherwise) ──


def _numpy_equity_metrics(bar_returns: pd.Series) -> dict[str, float]:
    r = bar_returns.to_numpy(dtype=np.float64)
    if len(r) == 0:
        return {"sharpe": math.nan, "max_drawdown_pct": 0.0}
    mean, std = float(np.mean(r)), float(np.std(r, ddof=1)) if len(r) > 1 else 0.0
    sharpe = (mean / std) * math.sqrt(BARS_PER_YEAR_H1) if std > 0 else math.nan
    equity = np.cumprod(1.0 + r)
    peak = np.maximum.accumulate(equity)
    dd = equity / peak - 1.0
    return {"sharpe": sharpe, "max_drawdown_pct": float(-dd.min())}


def equity_metrics(bar_returns: pd.Series) -> tuple[dict[str, float], str]:
    """(metrics, backend). Tries vectorbt; falls back to numpy (same defs)."""
    try:
        import vectorbt as vbt  # noqa: PLC0415 — heavy import, optional

        acc = bar_returns.vbt.returns(freq="1h")
        return (
            {
                "sharpe": float(acc.sharpe_ratio()),
                "max_drawdown_pct": float(-acc.max_drawdown()),
            },
            f"vectorbt {vbt.__version__}",
        )
    except Exception:  # ImportError or numba issues — never fail the run
        return _numpy_equity_metrics(bar_returns), "numpy-fallback"


# ─── The engine ──────────────────────────────────────────────────────────────


class BacktestEngine:
    """Deterministic quant-core backtest over pre-loaded frames (no I/O)."""

    def __init__(
        self,
        candles: pd.DataFrame,
        *,
        params: BacktestParams,
        proba_fn: ProbaFn,
        macro: pd.DataFrame | None = None,
        sentiment: pd.DataFrame | None = None,
        spreads: pd.DataFrame | None = None,
    ) -> None:
        self._candles = candles.sort_values("ts").reset_index(drop=True)
        self._params = params
        self._proba = proba_fn
        self._macro = macro
        self._sentiment = sentiment
        self._spreads = spreads

    def run(self) -> dict[str, Any]:
        p = self._params
        features = compute_features(
            self._candles, macro=self._macro, sentiment=self._sentiment, spreads=self._spreads
        )
        pit = sentiment_leakage_check(self._sentiment, features["ts"])
        sides = baseline_sides(features)

        candidate_mask = (sides != 0) & features["atr_14"].notna() & (features["atr_14"] > 0)
        proba = np.full(len(features), np.nan)
        if candidate_mask.any():
            idx = features.index[candidate_mask]
            proba[idx] = self._proba(features.loc[idx], sides.loc[idx])

        sweep_results: dict[str, Any] = {}
        thresholds = sorted(set(p.sweep) | {p.probability_threshold})
        for threshold in thresholds:
            trades, bar_returns = self._simulate(features, sides, proba, threshold)
            sweep_results[f"{threshold:.3f}"] = self._metrics(trades, bar_returns)

        chosen = sweep_results[f"{p.probability_threshold:.3f}"]
        optimal = max(
            sweep_results.items(),
            key=lambda kv: (
                kv[1]["expectancy_r"] if math.isfinite(kv[1]["expectancy_r"]) else -1e9,
                kv[1]["n_trades"],
            ),
        )
        trades, bar_returns = self._simulate(features, sides, proba, p.probability_threshold)
        metrics, backend = chosen, chosen.get("metrics_backend", "")
        return {
            "engine": "qn050-v1",
            "instrument": p.instrument,
            "timeframe": p.timeframe,
            "bars": int(len(self._candles)),
            "window": {
                "from": features["ts"].iloc[0].isoformat(),
                "to": features["ts"].iloc[-1].isoformat(),
            },
            "probability_threshold": p.probability_threshold,
            "metrics": metrics,
            "metrics_backend": backend,
            "threshold_sweep": sweep_results,
            "optimal_threshold": {
                "threshold": float(optimal[0]),
                "expectancy_r": optimal[1]["expectancy_r"],
                "note": "default target 0.60 (ADR-008); override only with documented evidence",
            },
            "point_in_time": pit,
            "trades": [t.to_json() for t in trades],
        }

    # ── simulation ───────────────────────────────────────────────────────────

    def _simulate(
        self,
        features: pd.DataFrame,
        sides: pd.Series,
        proba: np.ndarray,
        threshold: float,
    ) -> tuple[list[SimTrade], pd.Series]:
        p = self._params
        lp = p.label_params
        cp = p.cost_params
        pip = pip_size(p.instrument)
        c = self._candles
        o = c["open"].to_numpy(dtype=np.float64)
        h = c["high"].to_numpy(dtype=np.float64)
        lo = c["low"].to_numpy(dtype=np.float64)
        cl = c["close"].to_numpy(dtype=np.float64)
        ts = features["ts"]
        atr = features["atr_14"].to_numpy(dtype=np.float64)
        spread_col = (
            features["spread_pips"].to_numpy(dtype=np.float64)
            if "spread_pips" in features
            else np.full(len(features), np.nan)
        )
        spread_pct = (
            features["spread_pctile"].to_numpy(dtype=np.float64)
            if "spread_pctile" in features
            else np.full(len(features), np.nan)
        )
        session = features["session_label"].astype(str).to_numpy()

        n = len(c)
        equity = p.initial_equity
        trades: list[SimTrade] = []
        bar_pnl = np.zeros(n)
        i = 0
        while i < n - 1:
            s = sides.iloc[i]
            if s == 0 or not np.isfinite(proba[i]) or proba[i] < threshold:
                i += 1
                continue
            if not np.isfinite(atr[i]) or atr[i] <= 0:
                i += 1
                continue

            side = "long" if s > 0 else "short"
            entry = cl[i]
            stop_dist = lp.atr_stop_mult * atr[i]
            sl = entry - stop_dist if s > 0 else entry + stop_dist
            tp = entry + lp.rr * stop_dist if s > 0 else entry - lp.rr * stop_dist

            costs = TradeCosts()
            spread_entry = effective_spread_pips(
                p.instrument, None if math.isnan(spread_col[i]) else spread_col[i], session[i]
            )
            costs.spread_pips += spread_entry  # round-trip charged once

            exit_price, exit_reason, exit_j = entry, "END", min(i + lp.horizon, n - 1)
            for j in range(i + 1, min(i + 1 + lp.horizon, n)):
                # Weekend/overnight gap THROUGH the stop: fill at the open.
                gap_through = o[j] <= sl if s > 0 else o[j] >= sl
                if gap_through:
                    exit_price, exit_reason, exit_j = o[j], "GAP_SL", j
                    costs.gap_excess_pips = abs(sl - o[j]) / pip
                    costs.notes.append(f"gap fill {o[j]} beyond stop {sl}")
                    break
                hit_sl = lo[j] <= sl if s > 0 else h[j] >= sl
                hit_tp = h[j] >= tp if s > 0 else lo[j] <= tp
                if hit_sl:  # conservative: SL first when both touch (labels.py)
                    exit_price, exit_reason, exit_j = sl, "SL", j
                    break
                if hit_tp:
                    exit_price, exit_reason, exit_j = tp, "TP", j
                    break
            else:
                if i + lp.horizon < n:
                    exit_price, exit_reason, exit_j = cl[i + lp.horizon], "EXPIRY", i + lp.horizon
                else:
                    exit_price, exit_reason, exit_j = cl[n - 1], "END", n - 1

            if exit_reason in ("SL", "GAP_SL"):
                spread_now = effective_spread_pips(
                    p.instrument,
                    None if math.isnan(spread_col[exit_j]) else spread_col[exit_j],
                    session[exit_j],
                )
                slip, flash = stop_exit_slippage_pips(
                    spread_now,
                    None if math.isnan(spread_pct[exit_j]) else spread_pct[exit_j],
                    cp,
                )
                costs.slippage_pips += slip
                costs.flash_event = flash
                if flash:
                    costs.notes.append("flash-crash bar: 10x stop slippage applied")

            entry_ts = ts.iloc[i].to_pydatetime()
            exit_ts = ts.iloc[exit_j].to_pydatetime()
            financing, _crossings, triples = swap_pips(entry_ts, exit_ts, cp)
            costs.swap_pips += financing
            if triples:
                costs.notes.append(f"{triples} Wednesday triple-swap crossing(s)")

            gross_pips = (exit_price - entry) / pip * s
            net_pips = gross_pips - costs.total_pips
            risk_pips = stop_dist / pip
            r_multiple = net_pips / risk_pips if risk_pips > 0 else 0.0
            units = (equity * p.risk_pct) / stop_dist if stop_dist > 0 else 0.0
            pnl = net_pips * pip * units
            equity += pnl
            bar_pnl[exit_j] += pnl

            trades.append(
                SimTrade(
                    entry_ts=entry_ts,
                    exit_ts=exit_ts,
                    side=side,
                    probability=float(proba[i]),
                    entry_price=float(entry),
                    exit_price=float(exit_price),
                    exit_reason=exit_reason,
                    gross_pips=float(gross_pips),
                    costs=costs,
                    net_pips=float(net_pips),
                    r_multiple=float(r_multiple),
                    pnl=float(pnl),
                    equity_after=float(equity),
                )
            )
            i = exit_j + 1  # sequential, non-overlapping — mirrors the runner

        equity_curve = p.initial_equity + np.cumsum(bar_pnl)
        prev = np.concatenate(([p.initial_equity], equity_curve[:-1]))
        with np.errstate(divide="ignore", invalid="ignore"):
            bar_returns = pd.Series(np.where(prev > 0, bar_pnl / prev, 0.0), index=ts)
        return trades, bar_returns

    # ── metrics ──────────────────────────────────────────────────────────────

    def _metrics(self, trades: list[SimTrade], bar_returns: pd.Series) -> dict[str, Any]:
        p = self._params
        rs = np.array([t.r_multiple for t in trades], dtype=np.float64)
        pnls = np.array([t.pnl for t in trades], dtype=np.float64)
        wins = rs > 0
        gross_win = float(pnls[pnls > 0].sum())
        gross_loss = float(-pnls[pnls < 0].sum())
        eq_metrics, backend = equity_metrics(bar_returns)
        cost_totals = {
            "spread_pips": float(sum(t.costs.spread_pips for t in trades)),
            "slippage_pips": float(sum(t.costs.slippage_pips for t in trades)),
            "swap_pips": float(sum(t.costs.swap_pips for t in trades)),
            "gap_excess_pips": float(sum(t.costs.gap_excess_pips for t in trades)),
        }
        return {
            "n_trades": int(len(trades)),
            "hit_rate": float(wins.mean()) if len(rs) else math.nan,
            "expectancy_r": float(rs.mean()) if len(rs) else math.nan,
            "worst_r": float(rs.min()) if len(rs) else math.nan,
            "best_r": float(rs.max()) if len(rs) else math.nan,
            "net_pnl": float(pnls.sum()),
            "net_return_pct": float(pnls.sum() / p.initial_equity),
            "profit_factor": gross_win / gross_loss if gross_loss > 0 else math.inf,
            "sharpe": eq_metrics["sharpe"],
            "max_drawdown_pct": eq_metrics["max_drawdown_pct"],
            "metrics_backend": backend,
            "costs": cost_totals,
            "tail_risk": {
                "gap_events": int(sum(1 for t in trades if t.exit_reason == "GAP_SL")),
                "gap_excess_pips": cost_totals["gap_excess_pips"],
                "flash_events": int(sum(1 for t in trades if t.costs.flash_event)),
                "losses_beyond_1r": int((rs < -1.0).sum()),
            },
            "exit_reasons": {
                reason: int(sum(1 for t in trades if t.exit_reason == reason))
                for reason in ("SL", "TP", "EXPIRY", "GAP_SL", "END")
            },
        }
