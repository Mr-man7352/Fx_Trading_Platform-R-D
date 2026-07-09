"""QN-043 — outcome labelling for meta-model training.

Simulates the platform's own bracket (1×ATR stop, `rr`×ATR target — the same
geometry QN-042 sizes and BE-051 manages) forward from each candidate bar:
first-touch SL ⇒ 0, TP ⇒ 1, horizon expiry ⇒ sign of net P&L. Conservative
tie-break: if a single bar spans BOTH levels, the stop is assumed to fill
first. Costs enter as a spread haircut on entry and exit.

Labels only ever read bars STRICTLY AFTER the candidate bar — the walk-forward
trainer additionally embargoes `horizon` bars between train and test folds so
a label can never straddle a fold boundary (no-future-data AC).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd


@dataclass(frozen=True, slots=True)
class LabelParams:
    horizon: int = 24  # bars to resolve within (24×H1 = one trading day)
    atr_stop_mult: float = 1.0
    rr: float = 1.8  # design §10 min R:R
    cost_pips: float = 1.5  # round-trip spread cost haircut
    pip: float = 0.0001


def label_outcomes(
    candles: pd.DataFrame,
    sides: pd.Series,
    atr: pd.Series,
    params: LabelParams | None = None,
) -> pd.Series:
    """1.0 profitable / 0.0 not / NaN unresolved, aligned to `candles` rows.

    `sides`: +1 long, −1 short, 0/NaN no candidate (⇒ NaN label).
    Tail bars whose horizon extends past the data end are NaN (excluded from
    training — never guessed).
    """
    p = params or LabelParams()
    h = candles["high"].to_numpy(dtype=np.float64)
    lo = candles["low"].to_numpy(dtype=np.float64)
    c = candles["close"].to_numpy(dtype=np.float64)
    side = sides.to_numpy(dtype=np.float64)
    atr_v = atr.to_numpy(dtype=np.float64)
    n = len(c)
    cost = p.cost_pips * p.pip
    out = np.full(n, np.nan)

    for i in range(n):
        s = side[i]
        if not np.isfinite(s) or s == 0 or not np.isfinite(atr_v[i]) or atr_v[i] <= 0:
            continue
        if i + p.horizon >= n:
            continue  # unresolved tail — never label with partial futures
        entry = c[i]
        stop_dist = p.atr_stop_mult * atr_v[i]
        if s > 0:
            sl, tp = entry - stop_dist, entry + p.rr * stop_dist
        else:
            sl, tp = entry + stop_dist, entry - p.rr * stop_dist
        label: float | None = None
        for j in range(i + 1, i + 1 + p.horizon):
            hit_sl = lo[j] <= sl if s > 0 else h[j] >= sl
            hit_tp = h[j] >= tp if s > 0 else lo[j] <= tp
            if hit_sl:  # conservative: SL first when both touch in one bar
                label = 0.0
                break
            if hit_tp:
                label = 1.0
                break
        if label is None:
            pnl = (c[i + p.horizon] - entry) * s - cost
            label = 1.0 if pnl > 0 else 0.0
        out[i] = label
    return pd.Series(out, index=candles.index, name="label")
