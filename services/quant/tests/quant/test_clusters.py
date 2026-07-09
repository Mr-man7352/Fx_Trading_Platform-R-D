"""QN-048 — clustering maths, refresh triggers, and the risk-off AC fixture."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import numpy as np
import pandas as pd

from app.quant.clusters import (
    TRIGGER_BOOTSTRAP,
    TRIGGER_LIQUIDITY,
    TRIGGER_VOL_SPIKE,
    TRIGGER_WEEKLY,
    ClusterParams,
    ClusterSet,
    build_cluster_set,
    compute_clusters,
    realized_vol_spike,
    refresh_reason,
)

NOW = datetime(2025, 7, 16, 12, 0, tzinfo=UTC)
PARAMS = ClusterParams()


def _cluster_of(clusters: list[list[str]], name: str) -> list[str]:
    return next(c for c in clusters if name in c)


def _returns(n: int = 80, seed: int = 1) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    a = rng.standard_normal(n) * 0.005
    return pd.DataFrame(
        {
            "EUR_USD": a,
            "GBP_USD": a + rng.standard_normal(n) * 0.0005,  # corr ~ +0.99
            "USD_JPY": -a + rng.standard_normal(n) * 0.0005,  # corr ~ -0.99 (|corr| high)
            "XAU_USD": rng.standard_normal(n) * 0.005,  # independent
        }
    )


class TestComputeClusters:
    def test_correlated_pairs_cluster_at_070(self) -> None:
        clusters = compute_clusters(_returns(), threshold=0.7)
        eur = _cluster_of(clusters, "EUR_USD")
        assert "GBP_USD" in eur
        assert "USD_JPY" in eur  # |corr| clustering catches inverse pairs
        assert _cluster_of(clusters, "XAU_USD") == ["XAU_USD"]

    def test_all_singletons_when_uncorrelated(self) -> None:
        rng = np.random.default_rng(3)
        df = pd.DataFrame(rng.standard_normal((80, 3)) * 0.004, columns=["A", "B", "C"])
        clusters = compute_clusters(df, threshold=0.7)
        assert sorted(len(c) for c in clusters) == [1, 1, 1]

    def test_edge_cases(self) -> None:
        assert compute_clusters(pd.DataFrame()) == []
        one = pd.DataFrame({"EUR_USD": np.random.default_rng(1).standard_normal(40)})
        assert compute_clusters(one) == [["EUR_USD"]]


class TestVolSpike:
    def test_calm_series_no_spike(self) -> None:
        rng = np.random.default_rng(7)
        calm = pd.Series(rng.standard_normal(120) * 0.004)
        assert realized_vol_spike(calm) is False

    def test_shock_detected(self) -> None:
        rng = np.random.default_rng(7)
        series = np.concatenate(
            [rng.standard_normal(120) * 0.004, rng.standard_normal(5) * 0.03]
        )
        assert realized_vol_spike(pd.Series(series)) is True

    def test_short_history_never_spikes(self) -> None:
        assert realized_vol_spike(pd.Series(np.zeros(30))) is False


class TestRefreshReason:
    def _last(self, days_ago: float) -> ClusterSet:
        return ClusterSet(
            version=1,
            computed_at=NOW - timedelta(days=days_ago),
            trigger=TRIGGER_WEEKLY,
            lookback_days=60,
            threshold=0.7,
            clusters=[["EUR_USD"]],
        )

    def test_bootstrap_when_no_previous(self) -> None:
        assert refresh_reason(NOW, None, params=PARAMS) == TRIGGER_BOOTSTRAP

    def test_fresh_and_quiet_no_refresh(self) -> None:
        assert refresh_reason(NOW, self._last(2), params=PARAMS) is None

    def test_weekly_schedule(self) -> None:
        assert refresh_reason(NOW, self._last(7.5), params=PARAMS) == TRIGGER_WEEKLY

    def test_event_triggers_beat_schedule(self) -> None:
        # QN-048 AC: liquidity transition / vol spike recompute immediately.
        assert (
            refresh_reason(NOW, self._last(1), params=PARAMS, vol_spike=True)
            == TRIGGER_VOL_SPIKE
        )
        assert (
            refresh_reason(NOW, self._last(1), params=PARAMS, liquidity_changed=True)
            == TRIGGER_LIQUIDITY
        )


class TestRiskOffFixture:
    """QN-048 AC: a 2020-03-style convergence is caught by the event trigger
    BEFORE the weekly refresh would have seen it."""

    @staticmethod
    def _risk_off_returns(seed: int = 17) -> pd.DataFrame:
        rng = np.random.default_rng(seed)
        # 55 calm days: nearly independent EUR/GBP …
        eur_calm = rng.standard_normal(55) * 0.004
        gbp_calm = rng.standard_normal(55) * 0.004
        # … then 10 risk-off days: a common shock drives both (vol > 2×).
        # Sized so the 20-day event window crosses corr=0.7 while 55 calm days
        # still dilute the full 60-day window below it.
        shock = rng.standard_normal(10) * 0.009
        eur_off = shock + rng.standard_normal(10) * 0.002
        gbp_off = shock + rng.standard_normal(10) * 0.002
        return pd.DataFrame(
            {
                "EUR_USD": np.concatenate([eur_calm, eur_off]),
                "GBP_USD": np.concatenate([gbp_calm, gbp_off]),
            }
        )

    def test_event_trigger_fires_before_weekly(self) -> None:
        returns = self._risk_off_returns()
        last = ClusterSet(
            version=3,
            computed_at=NOW - timedelta(days=2),  # weekly not due for 5 more days
            trigger=TRIGGER_WEEKLY,
            lookback_days=60,
            threshold=0.7,
            clusters=[["EUR_USD"], ["GBP_USD"]],
        )
        spike = realized_vol_spike(
            returns["EUR_USD"], window=5, baseline=50, mult=2.0
        )
        assert spike is True
        reason = refresh_reason(NOW, last, params=PARAMS, vol_spike=spike)
        assert reason == TRIGGER_VOL_SPIKE  # fires 5 days before the weekly

    def test_event_window_detects_convergence_weekly_window_does_not(self) -> None:
        returns = self._risk_off_returns()
        params = ClusterParams(event_lookback_days=20, lookback_days=60)
        event_set = build_cluster_set(
            returns, version=4, trigger=TRIGGER_VOL_SPIKE, params=params, now=NOW
        )
        weekly_set = build_cluster_set(
            returns, version=4, trigger=TRIGGER_WEEKLY, params=params, now=NOW
        )
        # Short event window: the fresh convergence dominates → one cluster.
        assert _cluster_of(event_set.clusters, "EUR_USD") == ["EUR_USD", "GBP_USD"]
        assert event_set.lookback_days == 20
        # Full 60-day window: 55 calm days dilute it → still separate.
        assert _cluster_of(weekly_set.clusters, "EUR_USD") == ["EUR_USD"]
        assert weekly_set.lookback_days == 60

    def test_versions_and_params_recorded_for_audit(self) -> None:
        returns = self._risk_off_returns()
        cs = build_cluster_set(
            returns, version=9, trigger=TRIGGER_VOL_SPIKE, params=PARAMS, now=NOW
        )
        assert cs.version == 9
        assert cs.computed_at == NOW
        assert cs.threshold == 0.7
        assert cs.params["vol_spike_mult"] == 2.0
