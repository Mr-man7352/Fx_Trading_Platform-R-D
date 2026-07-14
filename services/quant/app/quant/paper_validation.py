"""QN-060 — 90-day paper vs baseline validator (net of LLM cost).

The live gate's evidence generator: compares realized paper-mode agent trades
against the always-on QN-045 shadow baseline over a window (default 90 days),
deducting LLM spend from the agent leg, and writes an append-only verdict row
to `paper_validation_runs` that BE-101/BE-122 read.

Comparison is done in R-multiples (risk-normalised, instrument-agnostic):

  agent leg     realized R per closed paper trade — net P&L (realized + swap
                − commission) over the trade's planned risk (units × |entry −
                stop|, quote-ccy approximation). The window's total LLM spend
                is converted to R via the mean per-trade risk amount and
                deducted from the agent mean ("net of LLM cost").
  baseline leg  stored `baseline_signals` candidates re-resolved through the
                SAME bracket sim as training labels (QN-043 `label_outcomes`):
                win ⇒ +rr·R, loss ⇒ −1R.

Verdict policy (precedence order — each check fail-safe):

  EXTEND        §9.4 downgraded-bar policy: >`downgraded_tolerance` (10%) of
                paper signal cycles in the window ran with a downgraded model
                ⇒ the window must extend; the run is not promotion evidence.
  UNDERPOWERED  the pre-registered effect size could not be resolved at the
                requested alpha/power with the observed sample —
                necessary-but-not-sufficient guard (story AC): surfaces the
                warning and can never PASS.
  PASS / FAIL   agent mean net R beats baseline mean R by at least the
                pre-registered `effect_size_r`.

Pure logic lives here (unit-testable without a DB); `run_paper_validation`
orchestrates the DB reads/writes through the QuantDb seam.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, Protocol

import numpy as np
import pandas as pd

from app.quant.features import indicator_frame
from app.quant.labels import LabelParams, label_outcomes

if TYPE_CHECKING:
    from collections.abc import Sequence

VERDICT_PASS = "PASS"
VERDICT_FAIL = "FAIL"
VERDICT_EXTEND = "EXTEND"
VERDICT_UNDERPOWERED = "UNDERPOWERED"

# Warmup bars prepended before the window so indicators (EMA50, ADX, ATR) are
# fully formed on the first in-window baseline bar.
_INDICATOR_WARMUP_BARS = 100


@dataclass(frozen=True, slots=True)
class PaperValidationParams:
    """Pre-registered analysis plan — fixed BEFORE the window is judged."""

    window_days: int = 90
    #: Minimum agent-minus-baseline edge (mean R) required to PASS. Pre-
    #: registered (story AC) — changing it after looking at the data voids
    #: the run.
    effect_size_r: float = 0.10
    alpha: float = 0.05
    power: float = 0.80
    #: §9.4 — share of downgraded paper cycles above which the window extends.
    downgraded_tolerance: float = 0.10
    #: Bracket geometry for the baseline leg (matches QN-043 label sim).
    rr: float = 1.8
    horizon_bars: int = 24


@dataclass(frozen=True, slots=True)
class PaperTradeRow:
    """One closed paper-mode trade (joined with its intent for risk)."""

    closed_at: datetime
    instrument: str
    units: float
    entry_price: float
    stop_loss: float | None
    realized_pnl: float
    swap_pnl: float
    commission: float


@dataclass(frozen=True, slots=True)
class BaselineCandidateRow:
    """One stored `would_trade` row from `baseline_signals`."""

    bar_ts: datetime
    instrument: str
    timeframe: str
    side: str  # "long" | "short"


@dataclass(slots=True)
class PaperValidationResult:
    window_start: datetime
    window_end: datetime
    verdict: str
    underpowered: bool
    downgraded_share: float
    effect_size_r: float
    metrics: dict[str, Any]
    warnings: list[str] = field(default_factory=list)


# ── agent leg ────────────────────────────────────────────────────────────────


def trade_r_multiples(trades: Sequence[PaperTradeRow]) -> tuple[list[float], list[float], int]:
    """(realized R per trade, risk amount per trade, n skipped).

    R = (realized + swap − commission) / (|units| × |entry − stop|). Trades
    without a stop or with zero risk distance can't be normalised — they are
    skipped and counted (surfaced as a warning upstream, never guessed).
    """
    r_multiples: list[float] = []
    risk_amounts: list[float] = []
    skipped = 0
    for t in trades:
        if t.stop_loss is None:
            skipped += 1
            continue
        risk = abs(t.units) * abs(t.entry_price - t.stop_loss)
        if not math.isfinite(risk) or risk <= 0:
            skipped += 1
            continue
        net = t.realized_pnl + t.swap_pnl - t.commission
        r_multiples.append(net / risk)
        risk_amounts.append(risk)
    return r_multiples, risk_amounts, skipped


def llm_cost_in_r(total_cost: float, risk_amounts: Sequence[float]) -> float | None:
    """Window LLM spend expressed in R-multiples (cost / mean per-trade risk).

    None when there are no risk-normalisable trades — the deduction is then
    reported in currency only (never silently dropped).
    """
    if not risk_amounts:
        return None
    mean_risk = float(np.mean(risk_amounts))
    if mean_risk <= 0:
        return None
    return total_cost / mean_risk


# ── baseline leg ─────────────────────────────────────────────────────────────


def resolve_baseline_candidates(
    candles: pd.DataFrame,
    candidates: Sequence[BaselineCandidateRow],
    *,
    params: PaperValidationParams,
) -> list[float]:
    """Realized R of stored baseline candidates via the QN-043 bracket sim.

    `candidates` are already window-bounded by the SQL fetch. `candles` should
    cover [window_start − warmup, now]; bars after the window end are used
    ONLY to resolve brackets opened inside the window (same first-touch /
    conservative-tie-break sim as training labels). Unresolved tail
    candidates are dropped, never guessed.
    """
    if candles.empty or not candidates:
        return []
    features = indicator_frame(candles)
    ts_index = pd.DatetimeIndex(pd.to_datetime(features["ts"], utc=True))
    sides = pd.Series(np.zeros(len(features)), index=features.index)
    for cand in candidates:
        ts = pd.Timestamp(cand.bar_ts)
        ts = ts.tz_localize("UTC") if ts.tzinfo is None else ts.tz_convert("UTC")
        pos = ts_index.get_indexer([ts])
        if pos[0] >= 0:
            sides.iloc[pos[0]] = 1.0 if cand.side == "long" else -1.0
    label_params = LabelParams(horizon=params.horizon_bars, rr=params.rr)
    outcomes = label_outcomes(candles, sides, features["atr_14"], label_params)
    resolved = outcomes.dropna()
    # win ⇒ +rr·R, loss ⇒ −1R (same geometry the sizing/bracket uses).
    return [params.rr if v >= 1.0 else -1.0 for v in resolved.to_numpy()]


# ── statistics ───────────────────────────────────────────────────────────────

_Z = {0.80: 0.8416, 0.90: 1.2816, 0.95: 1.6449}


def _z_two_sided(alpha: float) -> float:
    # Inverse-normal via Acklam-lite is overkill — the plan pre-registers
    # conventional alphas; map them, fall back to 1.96.
    return {0.10: 1.6449, 0.05: 1.9600, 0.01: 2.5758}.get(round(alpha, 4), 1.9600)


def required_n_per_group(
    agent_r: Sequence[float],
    baseline_r: Sequence[float],
    *,
    effect_size_r: float,
    alpha: float,
    power: float,
) -> int:
    """Two-sample normal-approximation sample size for the pre-registered
    effect: n/group = 2 * ((z_alpha/2 + z_beta) * sd_pooled / effect)^2."""
    z_a = _z_two_sided(alpha)
    z_b = _Z.get(round(power, 4), 0.8416)
    pooled: list[float] = [*agent_r, *baseline_r]
    if len(pooled) < 2:
        return 2  # can't even estimate variance — trivially underpowered
    sd = float(np.std(pooled, ddof=1))
    if sd == 0.0:
        return 2
    n = 2.0 * ((z_a + z_b) * sd / effect_size_r) ** 2
    return max(2, math.ceil(n))


# ── verdict ──────────────────────────────────────────────────────────────────


def evaluate_window(
    *,
    agent_r: Sequence[float],
    risk_amounts: Sequence[float],
    skipped_trades: int,
    baseline_r: Sequence[float],
    llm_cost_usd: float,
    downgraded_share: float,
    window_start: datetime,
    window_end: datetime,
    params: PaperValidationParams,
) -> PaperValidationResult:
    """Pure verdict computation — everything observable goes into `metrics`."""
    warnings: list[str] = []
    if skipped_trades:
        warnings.append(
            f"{skipped_trades} closed paper trade(s) had no usable stop distance "
            "and were excluded from R-normalisation"
        )

    n_agent, n_baseline = len(agent_r), len(baseline_r)
    agent_mean_r = float(np.mean(agent_r)) if n_agent else None
    baseline_mean_r = float(np.mean(baseline_r)) if n_baseline else None

    cost_r = llm_cost_in_r(llm_cost_usd, risk_amounts)
    agent_net_mean_r: float | None = None
    if agent_mean_r is not None:
        if cost_r is not None:
            agent_net_mean_r = agent_mean_r - (cost_r / n_agent)
        else:
            agent_net_mean_r = agent_mean_r
            if llm_cost_usd > 0:
                warnings.append(
                    "LLM cost could not be converted to R (no risk-normalisable "
                    "trades) — deduction reported in currency only"
                )

    diff_r: float | None = None
    if agent_net_mean_r is not None and baseline_mean_r is not None:
        diff_r = agent_net_mean_r - baseline_mean_r

    required_n = required_n_per_group(
        agent_r,
        baseline_r,
        effect_size_r=params.effect_size_r,
        alpha=params.alpha,
        power=params.power,
    )
    underpowered = min(n_agent, n_baseline) < required_n
    if underpowered:
        warnings.append(
            f"underpowered: n_agent={n_agent}, n_baseline={n_baseline}, "
            f"required≈{required_n}/group for Δ={params.effect_size_r}R at "
            f"alpha={params.alpha}, power={params.power} — "
            "necessary-but-not-sufficient guard, cannot PASS"
        )

    if downgraded_share > params.downgraded_tolerance:
        verdict = VERDICT_EXTEND
        warnings.append(
            f"downgraded share {downgraded_share:.1%} exceeds "
            f"{params.downgraded_tolerance:.0%} tolerance (§9.4) — window must "
            "extend until ≥90% of cycles are full-capability"
        )
    elif underpowered:
        verdict = VERDICT_UNDERPOWERED
    elif diff_r is not None and diff_r >= params.effect_size_r:
        verdict = VERDICT_PASS
    else:
        verdict = VERDICT_FAIL

    metrics: dict[str, Any] = {
        "params": {
            "window_days": params.window_days,
            "effect_size_r": params.effect_size_r,
            "alpha": params.alpha,
            "power": params.power,
            "downgraded_tolerance": params.downgraded_tolerance,
            "rr": params.rr,
            "horizon_bars": params.horizon_bars,
        },
        "agent": {
            "n_trades": n_agent,
            "n_skipped": skipped_trades,
            "mean_r": agent_mean_r,
            "net_mean_r": agent_net_mean_r,
            "std_r": float(np.std(agent_r, ddof=1)) if n_agent > 1 else None,
        },
        "baseline": {
            "n_candidates_resolved": n_baseline,
            "mean_r": baseline_mean_r,
            "std_r": float(np.std(baseline_r, ddof=1)) if n_baseline > 1 else None,
        },
        "llm_cost": {"usd": llm_cost_usd, "total_r": cost_r},
        "comparison": {
            "agent_net_minus_baseline_r": diff_r,
            "required_n_per_group": required_n,
        },
        "downgraded_share": downgraded_share,
        "warnings": warnings,
    }
    return PaperValidationResult(
        window_start=window_start,
        window_end=window_end,
        verdict=verdict,
        underpowered=underpowered,
        downgraded_share=downgraded_share,
        effect_size_r=params.effect_size_r,
        metrics=metrics,
        warnings=warnings,
    )


# ── orchestration (DB seam) ──────────────────────────────────────────────────


class PaperValidationDb(Protocol):
    """The slice of QuantDb this validator needs (fakeable in tests)."""

    async def fetch_closed_paper_trades(
        self, start: datetime, end: datetime
    ) -> list[PaperTradeRow]: ...

    async def fetch_llm_cost_usd(self, start: datetime, end: datetime) -> float: ...

    async def fetch_downgraded_signal_share(self, start: datetime, end: datetime) -> float: ...

    async def fetch_baseline_candidates(
        self, start: datetime, end: datetime
    ) -> list[BaselineCandidateRow]: ...

    async def fetch_candles(
        self, instrument: str, timeframe: str, end: datetime, limit: int
    ) -> pd.DataFrame: ...

    async def insert_paper_validation(self, result: PaperValidationResult) -> None: ...


def _bars_per_day(timeframe: str) -> int:
    return {
        "M1": 1440,
        "M5": 288,
        "M15": 96,
        "M30": 48,
        "H1": 24,
        "H4": 6,
        "D1": 1,
        "W1": 1,
    }.get(timeframe, 24)


async def run_paper_validation(
    db: PaperValidationDb,
    *,
    params: PaperValidationParams | None = None,
    now: datetime | None = None,
    persist: bool = True,
) -> PaperValidationResult:
    """Read the window, judge it, and (by default) append the verdict row."""
    p = params or PaperValidationParams()
    window_end = now or datetime.now(tz=UTC)
    window_start = window_end - timedelta(days=p.window_days)

    trades = await db.fetch_closed_paper_trades(window_start, window_end)
    llm_cost = await db.fetch_llm_cost_usd(window_start, window_end)
    downgraded_share = await db.fetch_downgraded_signal_share(window_start, window_end)
    candidates = await db.fetch_baseline_candidates(window_start, window_end)

    agent_r, risk_amounts, skipped = trade_r_multiples(trades)

    baseline_r: list[float] = []
    by_key: dict[tuple[str, str], list[BaselineCandidateRow]] = {}
    for cand in candidates:
        by_key.setdefault((cand.instrument, cand.timeframe), []).append(cand)
    for (instrument, timeframe), rows in by_key.items():
        limit = p.window_days * _bars_per_day(timeframe) + _INDICATOR_WARMUP_BARS + p.horizon_bars
        candles = await db.fetch_candles(instrument, timeframe, window_end, limit)
        baseline_r.extend(resolve_baseline_candidates(candles, rows, params=p))

    result = evaluate_window(
        agent_r=agent_r,
        risk_amounts=risk_amounts,
        skipped_trades=skipped,
        baseline_r=baseline_r,
        llm_cost_usd=llm_cost,
        downgraded_share=downgraded_share,
        window_start=window_start,
        window_end=window_end,
        params=p,
    )
    if persist:
        await db.insert_paper_validation(result)
    return result
