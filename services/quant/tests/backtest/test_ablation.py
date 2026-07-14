"""QN-054 — ablation harness tests: masking + attribution + agentic merge."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import numpy as np
import pandas as pd

from app.backtest.ablation import mask_feature_groups, masked_proba_fn, run_ablations
from app.backtest.engine import BacktestParams
from app.quant.labels import LabelParams


def test_mask_feature_groups_only_touches_prefixed_columns():
    f = pd.DataFrame({"rsi_14": [50.0], "macro_cot_net": [1.2], "sent_mean_24h": [0.3]})
    masked = mask_feature_groups(f, ("macro_", "sent_"))
    assert masked["rsi_14"].iloc[0] == 50.0
    assert np.isnan(masked["macro_cot_net"].iloc[0])
    assert np.isnan(masked["sent_mean_24h"].iloc[0])
    # Original untouched (copy semantics).
    assert f["macro_cot_net"].iloc[0] == 1.2


def test_masked_proba_fn_receives_masked_frame():
    seen: list[pd.DataFrame] = []

    def base(features: pd.DataFrame, sides: pd.Series):
        seen.append(features)
        return np.full(len(features), 0.7)

    fn = masked_proba_fn(base, ("sent_",))
    frame = pd.DataFrame({"rsi_14": [1.0], "sent_mean_24h": [0.5]})
    fn(frame, pd.Series([1.0]))
    assert np.isnan(seen[0]["sent_mean_24h"].iloc[0])


def test_run_ablations_report_shape_and_agentic_merge():
    rng = np.random.default_rng(11)
    n = 300
    close = 1.1 + np.cumsum(rng.normal(0.0004, 0.0008, n))
    start = datetime(2026, 3, 2, tzinfo=UTC)
    candles = pd.DataFrame(
        {
            "ts": [start + timedelta(hours=k) for k in range(n)],
            "open": close,
            "high": close + 0.0008,
            "low": close - 0.0008,
            "close": close,
            "volume": 100.0,
        }
    )
    params = BacktestParams(
        instrument="EUR_USD",
        label_params=LabelParams(horizon=6, cost_pips=0.0),
        sweep=(0.6,),
    )
    agentic = {
        "debate_sweep": {"rounds_0": {"expectancy_r": 0.1}, "rounds_2": {"expectancy_r": 0.2}},
        "memory": {"on": {"expectancy_r": 0.2}, "off": {"expectancy_r": 0.15}},
    }
    report = run_ablations(
        candles,
        params=params,
        proba_fn=lambda f, s: np.full(len(f), 0.65),
        agentic_results=agentic,
    )
    assert set(report["quant_core_variants"]) == {"quant_only", "plus_sentiment", "full"}
    assert set(report["attribution_vs_full"]) == {"quant_only", "plus_sentiment"}
    for block in report["attribution_vs_full"].values():
        assert "delta_expectancy_r" in block
    assert report["agentic"] == agentic
