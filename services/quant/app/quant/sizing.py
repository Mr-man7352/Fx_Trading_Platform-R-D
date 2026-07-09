"""QN-042/QN-044 — vol-targeted position sizing, Kelly-capped, FCA-compliant.

Built on the QN-034 cross-currency primitives (`app.execution.sizing`).
Deterministic pure maths — the LLM layer NEVER touches sizing (QN-044 AC).

Sizing ladder (every rung can only SHRINK the position):
  1. base risk    — min(config risk %, 1% hard ceiling) of equity at the stop
  2. Kelly cap    — risk% capped at `kelly_fraction × kelly_f(p, R:R)` when a
                    calibrated probability is available; non-positive edge ⇒ 0
  3. vol target   — units capped so a 1×ATR adverse move ≈ `vol_risk_pct` of
                    equity (the story's headline property)
  4. prob scaling — optional flag (QN-044): ~0.5× at P=0.60 → 1.0× at P≥0.75
  5. FCA leverage — notional ≤ equity × cap (30:1 FX majors, 20:1 minors/XAU,
                    10:1 oil); broker margin rate can only tighten it
  6. min/step     — round DOWN to unit step; below min units ⇒ 0
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.execution.sizing import (
    RateProvider,
    pip_size,
    pip_value,
    split_instrument,
    units_for_risk,
)

SIZING_MODEL_VERSION = "qn042-v1"

# FCA retail leverage caps (design §10). Majors = both legs in the major set.
_MAJOR_CCY = {"USD", "EUR", "JPY", "GBP", "CHF", "CAD"}
_METALS = {"XAU_USD"}
_ENERGY = {"WTICO_USD", "BCO_USD"}

_HARD_RISK_CEILING = 0.01  # 1% equity per trade — non-negotiable (§10)


def fca_leverage_cap(instrument: str) -> float:
    """30:1 major FX / 20:1 minor FX + gold / 10:1 oil (FCA retail caps)."""
    if instrument in _ENERGY:
        return 10.0
    if instrument in _METALS:
        return 20.0
    base, quote = split_instrument(instrument)
    if base in _MAJOR_CCY and quote in _MAJOR_CCY:
        return 30.0
    return 20.0


@dataclass(frozen=True, slots=True)
class SizingConfig:
    account_currency: str = "GBP"
    risk_per_trade_pct: float = 0.01  # clamped to the 1% hard ceiling anyway
    vol_risk_pct: float = 0.005  # 1×ATR adverse move ≈ 0.5% equity
    kelly_fraction: float = 0.25  # fraction of full Kelly allowed
    prob_sizing_enabled: bool = False  # QN-044 flag
    min_rr: float = 1.8  # design §10 min R:R — Kelly payoff ratio
    min_units: float = 1.0  # OANDA minimum trade size
    unit_step: float = 1.0


@dataclass(frozen=True, slots=True)
class SizingDecision:
    units: float  # always >= 0; side is explicit elsewhere
    risk_amount: float  # account ccy at the stop for `units`
    risk_pct_used: float
    target_vol_pct: float
    prob_scale: float
    kelly_f: float | None
    caps_applied: list[str] = field(default_factory=list)
    model_version: str = SIZING_MODEL_VERSION


def kelly_f(probability: float, payoff_ratio: float) -> float:
    """Full-Kelly risk fraction f* = p − (1−p)/b. Can be ≤ 0 (no edge)."""
    if not 0 < probability < 1:
        raise ValueError("probability must be in (0, 1)")
    if payoff_ratio <= 0:
        raise ValueError("payoff_ratio must be positive")
    return probability - (1.0 - probability) / payoff_ratio


def probability_scale(probability: float) -> float:
    """QN-044: linear ~0.5× at P=0.60 → 1.0× at P=0.75, clamped [0.5, 1.0]."""
    scale = 0.5 + (probability - 0.60) * (0.5 / 0.15)
    return min(max(scale, 0.5), 1.0)


def size_position(
    *,
    instrument: str,
    entry_price: float,
    stop_loss_price: float,
    account_equity: float,
    rates: RateProvider,
    config: SizingConfig | None = None,
    atr: float | None = None,
    probability: float | None = None,
    margin_rate: float | None = None,
) -> SizingDecision:
    """Deterministic position size in venue units (see module docstring)."""
    cfg = config or SizingConfig()
    if account_equity <= 0:
        raise ValueError("account_equity must be positive")
    if entry_price <= 0:
        raise ValueError("entry_price must be positive")
    stop_distance = abs(entry_price - stop_loss_price)
    if stop_distance <= 0:
        raise ValueError("stop_loss_price must differ from entry_price")

    caps: list[str] = []
    pip = pip_size(instrument)
    stop_pips = stop_distance / pip
    per_unit_pip = pip_value(instrument, 1.0, cfg.account_currency, rates)

    # 1. base risk %, hard-capped at 1% (§10 non-negotiable).
    risk_pct = min(cfg.risk_per_trade_pct, _HARD_RISK_CEILING)
    if cfg.risk_per_trade_pct > _HARD_RISK_CEILING:
        caps.append("hard_risk_ceiling")

    # 2. fractional-Kelly cap on the risk fraction.
    kf: float | None = None
    if probability is not None:
        kf = kelly_f(probability, cfg.min_rr)
        if kf <= 0:
            return SizingDecision(
                units=0.0,
                risk_amount=0.0,
                risk_pct_used=0.0,
                target_vol_pct=cfg.vol_risk_pct,
                prob_scale=1.0,
                kelly_f=kf,
                caps_applied=[*caps, "kelly_no_edge"],
            )
        kelly_risk = cfg.kelly_fraction * kf
        if kelly_risk < risk_pct:
            risk_pct = kelly_risk
            caps.append("kelly_cap")

    units = units_for_risk(
        instrument, account_equity * risk_pct, stop_pips, cfg.account_currency, rates
    )

    # 3. vol target: 1×ATR adverse move ≈ vol_risk_pct of equity.
    if atr is not None and atr > 0:
        atr_pips = atr / pip
        units_vol = units_for_risk(
            instrument, account_equity * cfg.vol_risk_pct, atr_pips, cfg.account_currency, rates
        )
        if units_vol < units:
            units = units_vol
            caps.append("vol_target")

    # 4. probability-modulated sizing (QN-044, flag-gated).
    prob_scale = 1.0
    if cfg.prob_sizing_enabled and probability is not None:
        prob_scale = probability_scale(probability)
        units *= prob_scale

    # 5. FCA leverage cap (broker margin rate may only tighten it).
    leverage = fca_leverage_cap(instrument)
    if margin_rate is not None and margin_rate > 0:
        leverage = min(leverage, 1.0 / margin_rate)
    _, quote = split_instrument(instrument)
    notional_per_unit = entry_price * rates.rate(quote, cfg.account_currency)
    max_units = account_equity * leverage / notional_per_unit
    if units > max_units:
        units = max_units
        caps.append("fca_leverage")

    # 6. broker min / step (epsilon guards float dust like 24999.999999…).
    units = int(units / cfg.unit_step + 1e-9) * cfg.unit_step
    if units < cfg.min_units:
        return SizingDecision(
            units=0.0,
            risk_amount=0.0,
            risk_pct_used=0.0,
            target_vol_pct=cfg.vol_risk_pct,
            prob_scale=prob_scale,
            kelly_f=kf,
            caps_applied=[*caps, "below_min_units"],
        )

    risk_amount = units * stop_pips * per_unit_pip
    return SizingDecision(
        units=units,
        risk_amount=risk_amount,
        risk_pct_used=risk_amount / account_equity,
        target_vol_pct=cfg.vol_risk_pct,
        prob_scale=prob_scale,
        kelly_f=kf,
        caps_applied=caps,
    )
