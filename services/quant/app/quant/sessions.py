"""QN-040/QN-047 — DST-aware FX session, rollover, and gap-risk features.

Session boundaries are defined in exchange-local wall-clock time via IANA
timezones and converted per bar — NEVER fixed UTC hours (London opens 07:00
UTC in summer, 08:00 UTC in winter; system design §10). Rollover and the
Friday close both anchor to 17:00 America/New_York (21:00/22:00 UTC
depending on DST).

All functions take timezone-aware datetimes; naive input raises.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta
from enum import StrEnum
from zoneinfo import ZoneInfo


class SessionLabel(StrEnum):
    TOKYO = "TOKYO"
    LONDON = "LONDON"
    NEW_YORK = "NEW_YORK"
    OVERLAP = "OVERLAP"
    OFF_HOURS = "OFF_HOURS"


class GapRisk(StrEnum):
    HIGH = "HIGH"
    NORMAL = "NORMAL"


@dataclass(frozen=True, slots=True)
class SessionSpec:
    """One trading session in its exchange-local wall-clock window."""

    tz: str
    open: time
    close: time


# Exchange-local session windows. Tokyo has no DST; London/NY windows shift
# against UTC twice a year — that shift is the whole point of this module.
SESSIONS: dict[str, SessionSpec] = {
    "TOKYO": SessionSpec("Asia/Tokyo", time(9, 0), time(18, 0)),
    "LONDON": SessionSpec("Europe/London", time(8, 0), time(16, 30)),
    "NEW_YORK": SessionSpec("America/New_York", time(8, 0), time(17, 0)),
}

# Session spread multipliers for the risk-gate spread filter (design §10):
# 1.5× overnight/off-hours, 1.0× London/NY. Consumed by BE-070 via features.
SPREAD_MULTIPLIERS: dict[SessionLabel, float] = {
    SessionLabel.TOKYO: 1.5,
    SessionLabel.LONDON: 1.0,
    SessionLabel.NEW_YORK: 1.0,
    SessionLabel.OVERLAP: 1.0,
    SessionLabel.OFF_HOURS: 1.5,
}

_NY = ZoneInfo("America/New_York")
_ROLLOVER = time(17, 0)  # 17:00 New York — daily rollover & Friday close.


def _require_aware(ts: datetime) -> datetime:
    if ts.tzinfo is None:
        raise ValueError("session functions require timezone-aware datetimes")
    return ts


def _in_session(ts: datetime, spec: SessionSpec) -> bool:
    local = ts.astimezone(ZoneInfo(spec.tz))
    if local.weekday() >= 5:  # Sat/Sun in exchange-local time
        return False
    return spec.open <= local.time() < spec.close


def session_label(ts: datetime) -> SessionLabel:
    """DST-aware session label for a bar timestamp (UTC or any aware tz).

    OVERLAP means the London/New-York overlap specifically (the deep-liquidity
    window); other adjacencies resolve by priority LONDON > NEW_YORK > TOKYO.
    """
    _require_aware(ts)
    london = _in_session(ts, SESSIONS["LONDON"])
    new_york = _in_session(ts, SESSIONS["NEW_YORK"])
    if london and new_york:
        return SessionLabel.OVERLAP
    if london:
        return SessionLabel.LONDON
    if new_york:
        return SessionLabel.NEW_YORK
    if _in_session(ts, SESSIONS["TOKYO"]):
        return SessionLabel.TOKYO
    return SessionLabel.OFF_HOURS


def spread_multiplier(label: SessionLabel) -> float:
    """Risk-gate spread-filter multiplier for a session (OFF_HOURS ⇒ 1.5×)."""
    return SPREAD_MULTIPLIERS[label]


def next_rollover(ts: datetime) -> datetime:
    """Next 17:00 America/New_York at or after `ts` (exclusive), DST-aware.

    Wall-clock arithmetic on the NY-local datetime keeps the anchor at 17:00
    local across DST transitions (21:00 UTC in summer, 22:00 in winter).
    """
    local = _require_aware(ts).astimezone(_NY)
    candidate = local.replace(hour=17, minute=0, second=0, microsecond=0)
    if local.time() >= _ROLLOVER:
        candidate += timedelta(days=1)
    return candidate


def is_triple_swap_day(ts: datetime) -> bool:
    """True when the NEXT rollover after `ts` is Wednesday 17:00 NY.

    Wednesday rollover books 3 days of financing (weekend swap) for FX and
    XAU. The risk gate combines this with position holding time (QN-047 AC:
    positions held >2 days crossing it get flagged).
    """
    return next_rollover(ts).weekday() == 2  # Wednesday


def rollovers_crossed(open_ts: datetime, as_of: datetime) -> list[datetime]:
    """All 17:00-NY rollover instants in (open_ts, as_of] (NY-local datetimes)."""
    _require_aware(open_ts)
    _require_aware(as_of)
    crossings: list[datetime] = []
    cursor = next_rollover(open_ts)
    while cursor.astimezone(_NY) <= as_of.astimezone(_NY):
        crossings.append(cursor)
        cursor = next_rollover(cursor + timedelta(minutes=1))
    return crossings


def position_triple_swap_flag(open_ts: datetime, as_of: datetime) -> bool:
    """True when a position opened at `open_ts` and held >2 days as of `as_of`
    has crossed a Wednesday rollover (QN-047 AC)."""
    if any(r.weekday() == 2 for r in rollovers_crossed(open_ts, as_of)):
        return as_of - open_ts > timedelta(days=2)
    return False


def in_weekend_gap_window(ts: datetime, *, window_hours: float = 6.0) -> bool:
    """True inside the pre-close window before Friday 17:00 New York (DST-aware)."""
    local = _require_aware(ts).astimezone(_NY)
    if local.weekday() != 4:  # Friday NY-local
        return False
    close = local.replace(hour=17, minute=0, second=0, microsecond=0)
    return close - timedelta(hours=window_hours) <= local < close


def weekend_gap_risk(ts: datetime, *, high_vol_regime: bool, window_hours: float = 6.0) -> GapRisk:
    """`HIGH` inside the Friday pre-close window during a high-vol regime —
    the flag the risk gate uses for the optional pre-weekend flatten (§10)."""
    if high_vol_regime and in_weekend_gap_window(ts, window_hours=window_hours):
        return GapRisk.HIGH
    return GapRisk.NORMAL


def hours_to_next_rollover(ts: datetime) -> float:
    """Decimal hours from `ts` to the next 17:00-NY rollover (absolute time)."""
    return (next_rollover(ts) - _require_aware(ts).astimezone(_NY)).total_seconds() / 3600.0
