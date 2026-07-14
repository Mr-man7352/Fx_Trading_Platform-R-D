"""QN-060 — paper-window validator: R-normalisation, power guard, §9.4
downgraded-bar policy, verdict precedence, and DB orchestration (fake db)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import numpy as np
import pandas as pd
import pytest

from app.quant.paper_validation import (
    VERDICT_EXTEND,
    VERDICT_FAIL,
    VERDICT_PASS,
    VERDICT_UNDERPOWERED,
    BaselineCandidateRow,
    PaperTradeRow,
    PaperValidationParams,
    PaperValidationResult,
    evaluate_window,
    llm_cost_in_r,
    required_n_per_group,
    resolve_baseline_candidates,
    run_paper_validation,
    trade_r_multiples,
)

_START = datetime(2026, 4, 1, tzinfo=UTC)
_END = datetime(2026, 6, 30, tzinfo=UTC)


def _trade(
    *,
    realized: float,
    entry: float = 100.0,
    stop: float | None = 99.0,
    units: float = 10.0,
    swap: float = 0.0,
    commission: float = 0.0,
) -> PaperTradeRow:
    return PaperTradeRow(
        closed_at=_START + timedelta(days=1),
        instrument="XAU_USD",
        units=units,
        entry_price=entry,
        stop_loss=stop,
        realized_pnl=realized,
        swap_pnl=swap,
        commission=commission,
    )


# ── R-normalisation ──────────────────────────────────────────────────────────


def test_trade_r_multiples_normalises_by_planned_risk() -> None:
    # risk = 10 units × 1.0 stop distance = 10 ⇒ +18 realized = +1.8R
    r, risks, skipped = trade_r_multiples([_trade(realized=18.0)])
    assert r == [pytest.approx(1.8)]
    assert risks == [pytest.approx(10.0)]
    assert skipped == 0


def test_trade_r_multiples_nets_swap_and_commission() -> None:
    r, _, _ = trade_r_multiples([_trade(realized=18.0, swap=-4.0, commission=4.0)])
    assert r == [pytest.approx(1.0)]  # (18 − 4 − 4) / 10


def test_trade_r_multiples_skips_unnormalisable_trades() -> None:
    trades = [
        _trade(realized=5.0, stop=None),  # no stop
        _trade(realized=5.0, stop=100.0),  # zero risk distance
        _trade(realized=-10.0),  # good: −1R
    ]
    r, _, skipped = trade_r_multiples(trades)
    assert skipped == 2
    assert r == [pytest.approx(-1.0)]


def test_llm_cost_in_r() -> None:
    assert llm_cost_in_r(50.0, [10.0, 30.0]) == pytest.approx(2.5)  # mean risk 20
    assert llm_cost_in_r(50.0, []) is None


# ── power guard ──────────────────────────────────────────────────────────────


def test_required_n_grows_with_variance_and_shrinks_with_effect() -> None:
    tight = [0.1, 0.12, 0.11, 0.09] * 10
    wide = [2.0, -2.0, 1.5, -1.7] * 10
    n_tight = required_n_per_group(tight, tight, effect_size_r=0.1, alpha=0.05, power=0.8)
    n_wide = required_n_per_group(wide, wide, effect_size_r=0.1, alpha=0.05, power=0.8)
    assert n_wide > n_tight
    n_big_effect = required_n_per_group(wide, wide, effect_size_r=1.0, alpha=0.05, power=0.8)
    assert n_big_effect < n_wide


# ── verdicts ─────────────────────────────────────────────────────────────────


def _big_samples(edge: float) -> tuple[list[float], list[float]]:
    """Well-powered legs: tiny variance, agent leg `edge` above baseline."""
    rng = np.random.default_rng(7)
    base = list(rng.normal(0.0, 0.05, size=400))
    agent = list(rng.normal(edge, 0.05, size=400))
    return agent, base


def _evaluate(
    agent: list[float],
    base: list[float],
    *,
    llm_cost: float = 0.0,
    downgraded: float = 0.0,
    params: PaperValidationParams | None = None,
) -> PaperValidationResult:
    return evaluate_window(
        agent_r=agent,
        risk_amounts=[10.0] * len(agent),
        skipped_trades=0,
        baseline_r=base,
        llm_cost_usd=llm_cost,
        downgraded_share=downgraded,
        window_start=_START,
        window_end=_END,
        params=params or PaperValidationParams(),
    )


def test_pass_when_edge_meets_preregistered_effect() -> None:
    agent, base = _big_samples(edge=0.3)
    result = _evaluate(agent, base)
    assert result.verdict == VERDICT_PASS
    assert not result.underpowered
    assert result.metrics["comparison"]["agent_net_minus_baseline_r"] >= 0.1


def test_fail_when_edge_below_effect_size() -> None:
    agent, base = _big_samples(edge=0.05)  # real but sub-threshold edge
    assert _evaluate(agent, base).verdict == VERDICT_FAIL


def test_llm_cost_deduction_can_flip_pass_to_fail() -> None:
    agent, base = _big_samples(edge=0.3)
    # 0.3R/trade edge × 400 trades × 10 risk ⇒ deduct >0.25R/trade via cost:
    # cost_r_total = cost / mean_risk = 1000/10 = 100R over 400 trades = 0.25R
    passing = _evaluate(agent, base, llm_cost=0.0)
    failing = _evaluate(agent, base, llm_cost=1000.0)
    assert passing.verdict == VERDICT_PASS
    assert failing.verdict == VERDICT_FAIL
    assert failing.metrics["llm_cost"]["usd"] == 1000.0


def test_downgraded_share_above_tolerance_extends_window() -> None:
    agent, base = _big_samples(edge=0.3)
    result = _evaluate(agent, base, downgraded=0.11)
    assert result.verdict == VERDICT_EXTEND
    assert any("§9.4" in w or "extend" in w for w in result.warnings)


def test_underpowered_sample_cannot_pass() -> None:
    # 3 trades with a huge apparent edge — guard must refuse to PASS.
    result = _evaluate([2.0, 1.8, 2.2], [-0.1, 0.0, 0.1] * 50)
    assert result.verdict == VERDICT_UNDERPOWERED
    assert result.underpowered
    assert any("underpowered" in w for w in result.warnings)


def test_no_trades_is_underpowered_not_crash() -> None:
    result = _evaluate([], [0.1, -0.2, 0.3])
    assert result.verdict == VERDICT_UNDERPOWERED
    assert result.metrics["agent"]["n_trades"] == 0


# ── baseline resolution through the QN-043 bracket sim ───────────────────────


def _trending_candles(n: int = 300) -> pd.DataFrame:
    ts = pd.date_range("2026-04-01", periods=n, freq="1h", tz="UTC")
    close = 100.0 + 0.5 * np.arange(n)
    return pd.DataFrame(
        {
            "ts": ts,
            "open": close - 0.25,
            "high": close + 1.0,
            "low": close - 1.0,
            "close": close,
            "volume": np.full(n, 1000.0),
        }
    )


def test_resolve_baseline_candidates_resolves_win_as_rr() -> None:
    candles = _trending_candles()
    cand = BaselineCandidateRow(
        bar_ts=candles["ts"].iloc[150].to_pydatetime(),
        instrument="XAU_USD",
        timeframe="H1",
        side="long",
    )
    params = PaperValidationParams()
    outcomes = resolve_baseline_candidates(candles, [cand], params=params)
    assert outcomes == [pytest.approx(params.rr)]  # steady uptrend ⇒ TP first


def test_resolve_baseline_candidates_empty_inputs() -> None:
    params = PaperValidationParams()
    assert resolve_baseline_candidates(pd.DataFrame(), [], params=params) == []


# ── orchestration through the DB seam ────────────────────────────────────────


class _FakeDb:
    def __init__(self) -> None:
        self.inserted: list[PaperValidationResult] = []
        self.candle_requests: list[tuple[str, str, int]] = []

    async def fetch_closed_paper_trades(self, start: Any, end: Any) -> list[PaperTradeRow]:
        return [_trade(realized=18.0), _trade(realized=-10.0)]

    async def fetch_llm_cost_usd(self, start: Any, end: Any) -> float:
        return 5.0

    async def fetch_downgraded_signal_share(self, start: Any, end: Any) -> float:
        return 0.5  # §9.4 breach ⇒ EXTEND regardless of the comparison

    async def fetch_baseline_candidates(self, start: Any, end: Any) -> list[BaselineCandidateRow]:
        candles = _trending_candles()
        return [
            BaselineCandidateRow(
                bar_ts=candles["ts"].iloc[150].to_pydatetime(),
                instrument="XAU_USD",
                timeframe="H1",
                side="long",
            )
        ]

    async def fetch_candles(
        self, instrument: str, timeframe: str, end: Any, limit: int
    ) -> pd.DataFrame:
        self.candle_requests.append((instrument, timeframe, limit))
        return _trending_candles()

    async def insert_paper_validation(self, result: PaperValidationResult) -> None:
        self.inserted.append(result)


async def test_run_paper_validation_persists_verdict_row() -> None:
    db = _FakeDb()
    result = await run_paper_validation(db, now=_END)
    assert result.verdict == VERDICT_EXTEND  # downgraded 50% dominates
    assert result.downgraded_share == 0.5
    assert db.inserted == [result]
    # candle window sized for warmup + horizon beyond the 90-day window
    _, timeframe, limit = db.candle_requests[0]
    assert timeframe == "H1"
    assert limit >= 90 * 24


async def test_run_paper_validation_persist_false_skips_insert() -> None:
    db = _FakeDb()
    await run_paper_validation(db, now=_END, persist=False)
    assert db.inserted == []
