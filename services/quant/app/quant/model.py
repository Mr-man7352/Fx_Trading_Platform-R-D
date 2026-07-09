"""QN-043 — LightGBM meta-model with walk-forward training + calibration.

P(profitable) must be TRUSTWORTHY (story goal), so raw booster scores are
calibrated on out-of-fold predictions only: expanding-window folds with an
embargo of `horizon` bars guarantee no training row's label overlaps a test
fold (no-future-data AC — asserted at runtime AND unit-tested). Isotonic
regression when enough OOF rows exist, Platt (logistic on log-odds) otherwise.

Calibrators serialize to JSON (breakpoints / coefficients) — no pickle: the
artifact is language-neutral and can't execute code on load.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import lightgbm as lgb
import numpy as np
import pandas as pd
from numpy.typing import NDArray
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, roc_auc_score

MODEL_FORMAT_VERSION = 1
_ISOTONIC_MIN_OOF = 300

DEFAULT_LGBM_PARAMS: dict[str, Any] = {
    "objective": "binary",
    "learning_rate": 0.05,
    "num_leaves": 31,
    "min_data_in_leaf": 20,
    "feature_fraction": 0.9,
    "bagging_fraction": 0.9,
    "bagging_freq": 1,
    "num_boost_round": 300,
    "seed": 7,
    "deterministic": True,
    "force_row_wise": True,
    "num_threads": 1,
    "verbose": -1,
}


def _clip(p: NDArray[np.float64] | float) -> NDArray[np.float64] | float:
    return np.clip(p, 1e-6, 1.0 - 1e-6)


@dataclass(frozen=True, slots=True)
class Calibrator:
    """JSON-serializable probability calibrator (isotonic or Platt)."""

    method: str  # "isotonic" | "platt"
    params: dict[str, Any]

    def apply(self, p_raw: NDArray[np.float64] | float) -> NDArray[np.float64] | float:
        p = _clip(np.asarray(p_raw, dtype=np.float64))
        if self.method == "isotonic":
            out = np.interp(p, self.params["x"], self.params["y"])
        elif self.method == "platt":
            logit = np.log(p / (1.0 - p))
            z = self.params["coef"] * logit + self.params["intercept"]
            out = 1.0 / (1.0 + np.exp(-z))
        else:  # pragma: no cover - constructor controls method
            raise ValueError(f"unknown calibration method {self.method!r}")
        out = np.clip(out, 0.0, 1.0)
        return float(out) if np.isscalar(p_raw) or np.asarray(p_raw).ndim == 0 else out

    def to_json(self) -> dict[str, Any]:
        return {"method": self.method, "params": self.params}

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> Calibrator:
        return cls(method=data["method"], params=data["params"])


def fit_calibrator(p_raw: NDArray[np.float64], y: NDArray[np.float64]) -> Calibrator:
    """Isotonic when the OOF sample is big enough, Platt otherwise."""
    p_raw = np.asarray(_clip(p_raw), dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    if len(p_raw) >= _ISOTONIC_MIN_OOF:
        iso = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip")
        iso.fit(p_raw, y)
        # Store breakpoints: np.interp reproduces sklearn's prediction exactly.
        return Calibrator(
            method="isotonic",
            params={
                "x": [float(v) for v in iso.X_thresholds_],
                "y": [float(v) for v in iso.y_thresholds_],
            },
        )
    logit = np.log(p_raw / (1.0 - p_raw)).reshape(-1, 1)
    lr = LogisticRegression(C=1e6, solver="lbfgs")
    lr.fit(logit, y)
    return Calibrator(
        method="platt",
        params={"coef": float(lr.coef_[0][0]), "intercept": float(lr.intercept_[0])},
    )


def reliability_curve(
    p: NDArray[np.float64], y: NDArray[np.float64], *, bins: int = 10
) -> list[dict[str, float]]:
    """Reliability curve rows (QN-043 AC) — also the ECE building block."""
    edges = np.linspace(0.0, 1.0, bins + 1)
    rows: list[dict[str, float]] = []
    for i in range(bins):
        mask = (p >= edges[i]) & (p < edges[i + 1] if i < bins - 1 else p <= edges[i + 1])
        if not mask.any():
            continue
        rows.append(
            {
                "bin_lo": float(edges[i]),
                "bin_hi": float(edges[i + 1]),
                "mean_pred": float(p[mask].mean()),
                "frac_pos": float(y[mask].mean()),
                "n": float(mask.sum()),
            }
        )
    return rows


def expected_calibration_error(
    p: NDArray[np.float64], y: NDArray[np.float64], *, bins: int = 10
) -> float:
    rows = reliability_curve(p, y, bins=bins)
    n_total = sum(r["n"] for r in rows)
    if n_total == 0:
        return math.nan
    return float(
        sum(abs(r["mean_pred"] - r["frac_pos"]) * r["n"] for r in rows) / n_total
    )


@dataclass(slots=True)
class TrainResult:
    booster: lgb.Booster
    calibrator: Calibrator
    feature_names: list[str]
    oof: pd.DataFrame  # columns: index, fold, p_raw, p_cal, label
    metrics: dict[str, float]
    reliability: list[dict[str, float]] = field(default_factory=list)
    lgbm_params: dict[str, Any] = field(default_factory=dict)
    # Fold bounds for auditability + the no-future-data unit test (QN-043 AC):
    # each entry is {"fold", "train_end", "start", "end"} in row indices.
    folds: list[dict[str, int]] = field(default_factory=list)


def _train_booster(X: pd.DataFrame, y: pd.Series, params: dict[str, Any]) -> lgb.Booster:
    p = dict(params)
    rounds = int(p.pop("num_boost_round"))
    return lgb.train(p, lgb.Dataset(X, label=y, free_raw_data=True), num_boost_round=rounds)


def walk_forward_train(
    X: pd.DataFrame,
    y: pd.Series,
    *,
    n_folds: int = 5,
    embargo: int = 24,  # ≥ label horizon — keeps fold labels out of training
    min_train: int = 200,
    lgbm_params: dict[str, Any] | None = None,
) -> TrainResult:
    """Expanding-window walk-forward training with OOF calibration.

    Rows must be TIME-ORDERED (the caller passes bar-ordered candidates).
    Fold k trains on rows [0, start_k − embargo) and predicts [start_k, end_k).
    """
    params = {**DEFAULT_LGBM_PARAMS, **(lgbm_params or {})}
    mask = y.notna()
    X, y = X.loc[mask].reset_index(drop=True), y.loc[mask].reset_index(drop=True)
    n = len(X)
    if n < min_train + n_folds * 20:
        raise ValueError(f"not enough labelled rows to walk-forward train (got {n})")

    fold_edges = np.linspace(min_train, n, n_folds + 1, dtype=int)
    oof_rows: list[pd.DataFrame] = []
    fold_bounds: list[dict[str, int]] = []
    for k in range(n_folds):
        start, end = int(fold_edges[k]), int(fold_edges[k + 1])
        train_end = start - embargo
        if train_end < min_train // 2:
            continue
        # No-future-data invariant (QN-043 AC): training rows end a full
        # embargo before the fold starts, so no label straddles the boundary.
        assert train_end + embargo <= start
        fold_bounds.append({"fold": k, "train_end": train_end, "start": start, "end": end})
        booster = _train_booster(X.iloc[:train_end], y.iloc[:train_end], params)
        p_raw = booster.predict(X.iloc[start:end])
        oof_rows.append(
            pd.DataFrame(
                {
                    "row": np.arange(start, end),
                    "fold": k,
                    "p_raw": np.asarray(p_raw, dtype=np.float64),
                    "label": y.iloc[start:end].to_numpy(dtype=np.float64),
                }
            )
        )
    if not oof_rows:
        raise ValueError("walk-forward produced no out-of-fold predictions")
    oof = pd.concat(oof_rows, ignore_index=True)

    calibrator = fit_calibrator(oof["p_raw"].to_numpy(), oof["label"].to_numpy())
    oof["p_cal"] = calibrator.apply(oof["p_raw"].to_numpy())

    y_oof = oof["label"].to_numpy()
    p_cal = oof["p_cal"].to_numpy()
    metrics = {
        "n_train": float(n),
        "n_oof": float(len(oof)),
        "auc": float(roc_auc_score(y_oof, oof["p_raw"])) if len(set(y_oof)) > 1 else math.nan,
        "brier_raw": float(brier_score_loss(y_oof, _clip(oof["p_raw"].to_numpy()))),
        "brier_cal": float(brier_score_loss(y_oof, _clip(p_cal))),
        "ece_cal": expected_calibration_error(p_cal, y_oof),
        "base_rate": float(y_oof.mean()),
    }
    final_booster = _train_booster(X, y, params)
    return TrainResult(
        booster=final_booster,
        calibrator=calibrator,
        feature_names=list(X.columns),
        oof=oof,
        metrics=metrics,
        reliability=reliability_curve(p_cal, y_oof),
        lgbm_params=params,
        folds=fold_bounds,
    )


def predict_proba(
    booster: lgb.Booster,
    calibrator: Calibrator,
    feature_names: list[str],
    features: dict[str, float],
) -> float:
    """Calibrated P(profitable) for one feature map (missing features → NaN,
    which LightGBM handles natively as its missing-value path)."""
    row = pd.DataFrame([[features.get(name, math.nan) for name in feature_names]],
                       columns=feature_names)
    p_raw = float(np.asarray(booster.predict(row))[0])
    return float(calibrator.apply(p_raw))
