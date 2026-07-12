"""QN-054 — ablation harness: edge attribution across components.

Quant-core ablations run HERE by masking feature groups before scoring
(LightGBM treats NaN as its native missing path — same mechanism live
degradation uses):

  quant_only  — macro_* AND sent_* features masked
  +sentiment  — macro_* masked, sentiment kept
  +full       — nothing masked (the production feature set)

Agent-layer ablations (debate-round sweep 0/1/2 × regime uncertainty,
memory on/off) are inherently sequential and run through the Node QN-056
runner; their metric blocks are passed in as `agentic_results` and merged so
ONE report attributes performance to components (story AC).
"""

from __future__ import annotations

from typing import Any

import pandas as pd

from app.backtest.engine import BacktestEngine, BacktestParams, ProbaFn

ABLATION_VARIANTS: dict[str, tuple[str, ...]] = {
    "quant_only": ("macro_", "sent_"),
    "plus_sentiment": ("macro_",),
    "full": (),
}


def mask_feature_groups(features: pd.DataFrame, prefixes: tuple[str, ...]) -> pd.DataFrame:
    """NaN-out every column whose name starts with one of `prefixes`."""
    if not prefixes:
        return features
    out = features.copy()
    for col in out.columns:
        if isinstance(col, str) and col.startswith(prefixes):
            out[col] = float("nan")
    return out


def masked_proba_fn(base: ProbaFn, prefixes: tuple[str, ...]) -> ProbaFn:
    def fn(features: pd.DataFrame, sides: pd.Series):
        return base(mask_feature_groups(features, prefixes), sides)

    return fn


def run_ablations(
    candles: pd.DataFrame,
    *,
    params: BacktestParams,
    proba_fn: ProbaFn,
    macro: pd.DataFrame | None = None,
    sentiment: pd.DataFrame | None = None,
    spreads: pd.DataFrame | None = None,
    agentic_results: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Run every quant-core variant + merge agentic blocks into one report."""
    variants: dict[str, Any] = {}
    for name, prefixes in ABLATION_VARIANTS.items():
        engine = BacktestEngine(
            candles,
            params=params,
            proba_fn=masked_proba_fn(proba_fn, prefixes),
            macro=macro,
            sentiment=sentiment,
            spreads=spreads,
        )
        report = engine.run()
        variants[name] = {
            "masked_prefixes": list(prefixes),
            "metrics": report["metrics"],
        }

    full = variants["full"]["metrics"]
    attribution = {
        name: {
            "delta_expectancy_r": _delta(v["metrics"], full, "expectancy_r"),
            "delta_net_return_pct": _delta(v["metrics"], full, "net_return_pct"),
            "delta_n_trades": _delta(v["metrics"], full, "n_trades"),
        }
        for name, v in variants.items()
        if name != "full"
    }

    report: dict[str, Any] = {
        "harness": "qn054-v1",
        "quant_core_variants": variants,
        "attribution_vs_full": attribution,
    }
    if agentic_results:
        # Blocks produced by the QN-056 runner: debate sweep × regime
        # uncertainty and memory on/off — merged verbatim with provenance.
        report["agentic"] = agentic_results
        report["notes"] = [
            "agentic blocks computed by the Node event-driven runner (QN-056)",
            "debate-regime linkage: optimal rounds per entropy band documented there",
        ]
    return report


def _delta(variant: dict[str, Any], full: dict[str, Any], key: str) -> float | None:
    a, b = variant.get(key), full.get(key)
    if a is None or b is None:
        return None
    try:
        return float(a) - float(b)
    except (TypeError, ValueError):
        return None
