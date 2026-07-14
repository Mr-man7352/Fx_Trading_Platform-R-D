"""QN-050 — deterministic execution-cost model for backtests.

Every cost the platform pays in live trading is modelled on the P&L side:

  spread     — round-trip spread haircut; per-bar spread from `spreads_hist`
               when available, else an instrument default, session-multiplied
               (1.5× OFF_HOURS/TOKYO — same table the risk gate uses).
  slippage   — a fraction of the prevailing spread on STOP exits (stops fill
               worse); in a flash-crash bar (spread percentile above
               `flash_pctile`, SNB-style fixture) the multiplier is 10× and
               the event lands in the tail-risk report.
  swap       — financing pips per 17:00-NY rollover crossing (QN-047,
               DST-aware); a WEDNESDAY crossing books 3 days (triple swap —
               XAU multi-day-hold AC).
  weekend gap— if a bar OPENS beyond the stop (Friday→Sunday gap or any
               gap-through), the fill is at the OPEN, not the stop: loss
               beyond stop, reported in tail-risk (AC).

All functions are pure; the engine composes them per simulated trade.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from app.quant.sessions import SessionLabel, rollovers_crossed, spread_multiplier

# Conservative default spreads (pips) when spreads_hist has no observation.
DEFAULT_SPREAD_PIPS: dict[str, float] = {
    "EUR_USD": 0.8,
    "GBP_USD": 1.2,
    "USD_JPY": 0.9,
    "USD_CHF": 1.4,
    "USD_CAD": 1.6,
    "AUD_USD": 1.1,
    "NZD_USD": 1.6,
    "XAU_USD": 3.5,
    "WTICO_USD": 4.0,
    "BCO_USD": 4.0,
}
FALLBACK_SPREAD_PIPS = 2.0


def pip_size(instrument: str) -> float:
    """Pip definition per instrument (JPY quotes 0.01; metals/energy 0.01)."""
    if instrument.endswith("_JPY"):
        return 0.01
    if instrument.startswith(("XAU", "XAG", "WTICO", "BCO")):
        return 0.01
    return 0.0001


@dataclass(frozen=True, slots=True)
class CostParams:
    """Engine cost knobs — defaults follow system design §10."""

    # Slippage on stop exits as a fraction of the prevailing spread.
    stop_slippage_frac: float = 0.5
    # Spread percentile above which a bar is treated as a flash event…
    flash_pctile: float = 0.99
    # …and slippage is multiplied by this factor (documented in tail risk).
    flash_slippage_mult: float = 10.0
    # Financing cost in pips per rollover crossing (charged against the
    # position regardless of direction — conservative symmetric model).
    financing_pips_per_day: float = 0.6
    # Wednesday rollover books 3 days of financing.
    triple_swap_weekday: int = 2


@dataclass(slots=True)
class TradeCosts:
    spread_pips: float = 0.0
    slippage_pips: float = 0.0
    swap_pips: float = 0.0
    # Loss BEYOND the stop from a gap fill — INFORMATIONAL (tail-risk report):
    # the excess is already inside the gross P&L because the fill IS the open.
    gap_excess_pips: float = 0.0
    flash_event: bool = False
    notes: list[str] = field(default_factory=list)

    @property
    def total_pips(self) -> float:
        """Costs deducted from gross P&L (gap excess is already in gross)."""
        return self.spread_pips + self.slippage_pips + self.swap_pips

    def to_json(self) -> dict[str, Any]:
        return {
            "spread_pips": self.spread_pips,
            "slippage_pips": self.slippage_pips,
            "swap_pips": self.swap_pips,
            "gap_excess_pips": self.gap_excess_pips,
            "flash_event": self.flash_event,
            "notes": list(self.notes),
        }


def effective_spread_pips(
    instrument: str,
    observed_spread_pips: float | None,
    session: SessionLabel | str,
) -> float:
    """Observed spread when known, else the session-multiplied default."""
    if observed_spread_pips is not None and observed_spread_pips > 0:
        return float(observed_spread_pips)
    base = DEFAULT_SPREAD_PIPS.get(instrument, FALLBACK_SPREAD_PIPS)
    label = SessionLabel(session) if not isinstance(session, SessionLabel) else session
    return base * spread_multiplier(label)


def swap_pips(
    open_ts: datetime,
    close_ts: datetime,
    params: CostParams,
) -> tuple[float, int, int]:
    """(total financing pips, crossings, triple crossings) for a holding period.

    DST-aware via QN-047 `rollovers_crossed`; each Wednesday crossing books
    3 days (weekend financing), everything else 1 day.
    """
    crossings = rollovers_crossed(open_ts, close_ts)
    triples = sum(1 for c in crossings if c.weekday() == params.triple_swap_weekday)
    days = (len(crossings) - triples) + 3 * triples
    return days * params.financing_pips_per_day, len(crossings), triples


def stop_exit_slippage_pips(
    spread_pips_now: float,
    spread_pctile: float | None,
    params: CostParams,
) -> tuple[float, bool]:
    """(slippage pips, flash_event) for a stop-side exit."""
    # bool(...) — spread_pctile often arrives as a numpy float, and `>=` would
    # propagate np.bool_ into TradeCosts.flash_event (callers compare with
    # `is True`). Keep the seam a plain Python bool.
    flash = bool(spread_pctile is not None and spread_pctile >= params.flash_pctile)
    mult = params.flash_slippage_mult if flash else 1.0
    return spread_pips_now * params.stop_slippage_frac * mult, flash
