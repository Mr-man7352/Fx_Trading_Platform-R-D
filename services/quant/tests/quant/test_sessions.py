"""QN-040/QN-047 — DST-aware sessions, rollover, gap window (AC fixtures)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.quant.sessions import (
    GapRisk,
    SessionLabel,
    hours_to_next_rollover,
    in_weekend_gap_window,
    is_triple_swap_day,
    next_rollover,
    position_triple_swap_flag,
    rollovers_crossed,
    session_label,
    spread_multiplier,
    weekend_gap_risk,
)

LONDON = ZoneInfo("Europe/London")
NY = ZoneInfo("America/New_York")


class TestSessionLabel:
    def test_london_opens_0700_utc_in_summer(self) -> None:
        # 07:30 UTC in July = 08:30 BST → London is open (the AC's headline case).
        assert session_label(datetime(2025, 7, 16, 7, 30, tzinfo=UTC)) == SessionLabel.LONDON

    def test_london_not_open_0700_utc_in_winter(self) -> None:
        # 07:30 UTC in January = 07:30 GMT → pre-open; Tokyo (16:30 JST) has it.
        assert session_label(datetime(2025, 1, 15, 7, 30, tzinfo=UTC)) == SessionLabel.TOKYO

    def test_london_opens_0800_utc_in_winter(self) -> None:
        assert session_label(datetime(2025, 1, 15, 8, 30, tzinfo=UTC)) == SessionLabel.LONDON

    def test_dst_regression_same_wall_clock_same_session(self) -> None:
        # QN-040 AC: one summer bar + one winter bar at the SAME exchange-local
        # wall-clock time resolve to the same session.
        summer = datetime(2025, 7, 16, 9, 0, tzinfo=LONDON)
        winter = datetime(2025, 1, 15, 9, 0, tzinfo=LONDON)
        assert session_label(summer) == session_label(winter) == SessionLabel.LONDON

    def test_overlap_summer_and_winter(self) -> None:
        # London afternoon + NY morning — in both DST phases.
        assert session_label(datetime(2025, 7, 16, 14, 0, tzinfo=UTC)) == SessionLabel.OVERLAP
        assert session_label(datetime(2025, 1, 15, 14, 30, tzinfo=UTC)) == SessionLabel.OVERLAP

    def test_new_york_after_london_close(self) -> None:
        assert session_label(datetime(2025, 7, 16, 17, 0, tzinfo=UTC)) == SessionLabel.NEW_YORK

    def test_tokyo(self) -> None:
        # 01:00 UTC = 10:00 JST.
        assert session_label(datetime(2025, 7, 16, 1, 0, tzinfo=UTC)) == SessionLabel.TOKYO

    def test_off_hours_and_weekend(self) -> None:
        # 22:30 UTC — NY closed (17:00 local close), Tokyo not yet open.
        assert session_label(datetime(2025, 7, 15, 22, 30, tzinfo=UTC)) == SessionLabel.OFF_HOURS
        # Saturday.
        assert session_label(datetime(2025, 7, 19, 12, 0, tzinfo=UTC)) == SessionLabel.OFF_HOURS

    def test_naive_datetime_rejected(self) -> None:
        with pytest.raises(ValueError, match="aware"):
            session_label(datetime(2025, 7, 16, 7, 30))

    def test_spread_multipliers(self) -> None:
        # QN-047 AC: OFF_HOURS ⇒ 1.5× in the risk-gate spread filter.
        assert spread_multiplier(SessionLabel.OFF_HOURS) == 1.5
        assert spread_multiplier(SessionLabel.TOKYO) == 1.5
        assert spread_multiplier(SessionLabel.OVERLAP) == 1.0
        assert spread_multiplier(SessionLabel.LONDON) == 1.0


class TestRollover:
    def test_rollover_2100_utc_in_summer(self) -> None:
        r = next_rollover(datetime(2025, 7, 16, 12, 0, tzinfo=UTC))
        assert r.astimezone(UTC).hour == 21  # 17:00 EDT
        assert r.weekday() == 2

    def test_rollover_2200_utc_in_winter(self) -> None:
        # QN-047 AC DST regression: same 17:00-NY anchor, different UTC hour.
        r = next_rollover(datetime(2025, 1, 15, 12, 0, tzinfo=UTC))
        assert r.astimezone(UTC).hour == 22  # 17:00 EST
        assert r.weekday() == 2

    def test_after_1700_ny_rolls_to_next_day(self) -> None:
        r = next_rollover(datetime(2025, 7, 16, 18, 0, tzinfo=NY))
        assert r.weekday() == 3  # Thursday

    def test_triple_swap_day_flag(self) -> None:
        # Wednesday before 17:00 NY → next rollover IS the Wednesday one.
        assert is_triple_swap_day(datetime(2025, 7, 16, 12, 0, tzinfo=UTC)) is True
        # Thursday → next rollover is Thursday's.
        assert is_triple_swap_day(datetime(2025, 7, 17, 12, 0, tzinfo=UTC)) is False

    def test_position_crossing_wednesday_rollover(self) -> None:
        # QN-047 AC: held >2 days crossing Wednesday 17:00 NY → flag true.
        opened = datetime(2025, 7, 14, 9, 0, tzinfo=NY)  # Monday
        as_of = datetime(2025, 7, 17, 9, 0, tzinfo=NY)  # Thursday (>2 days)
        assert position_triple_swap_flag(opened, as_of) is True
        # Crossed Wednesday but held < 2 days → not flagged.
        opened_wed = datetime(2025, 7, 16, 15, 0, tzinfo=NY)
        as_of_wed = datetime(2025, 7, 16, 18, 0, tzinfo=NY)
        assert position_triple_swap_flag(opened_wed, as_of_wed) is False

    def test_rollovers_crossed_counts(self) -> None:
        opened = datetime(2025, 7, 14, 9, 0, tzinfo=NY)  # Monday
        as_of = datetime(2025, 7, 17, 9, 0, tzinfo=NY)  # Thursday
        crossings = rollovers_crossed(opened, as_of)
        assert len(crossings) == 3  # Mon, Tue, Wed 17:00s
        assert all(c.hour == 17 for c in crossings)

    def test_hours_to_next_rollover_positive(self) -> None:
        assert 0 < hours_to_next_rollover(datetime(2025, 7, 16, 12, 0, tzinfo=UTC)) <= 24


class TestWeekendGap:
    def test_friday_preclose_window_summer_and_winter(self) -> None:
        # QN-047 AC DST regression: same NY wall clock in both phases.
        summer = datetime(2025, 7, 18, 15, 0, tzinfo=NY)  # Friday 15:00 EDT
        winter = datetime(2025, 1, 17, 15, 0, tzinfo=NY)  # Friday 15:00 EST
        assert in_weekend_gap_window(summer) is True
        assert in_weekend_gap_window(winter) is True

    def test_outside_window(self) -> None:
        assert in_weekend_gap_window(datetime(2025, 7, 18, 9, 0, tzinfo=NY)) is False
        assert in_weekend_gap_window(datetime(2025, 7, 17, 15, 0, tzinfo=NY)) is False  # Thursday
        # 17:00 itself is the close — market's shut, not "pre-close".
        assert in_weekend_gap_window(datetime(2025, 7, 18, 17, 0, tzinfo=NY)) is False

    def test_gap_risk_needs_high_vol_regime(self) -> None:
        # QN-047 AC: pre-close window AND high-vol regime → HIGH.
        ts = datetime(2025, 7, 18, 15, 0, tzinfo=NY)
        assert weekend_gap_risk(ts, high_vol_regime=True) == GapRisk.HIGH
        assert weekend_gap_risk(ts, high_vol_regime=False) == GapRisk.NORMAL
        monday = ts - timedelta(days=4)
        assert weekend_gap_risk(monday, high_vol_regime=True) == GapRisk.NORMAL

    def test_window_width_configurable(self) -> None:
        ts = datetime(2025, 7, 18, 10, 0, tzinfo=NY)
        assert in_weekend_gap_window(ts, window_hours=6.0) is False
        assert in_weekend_gap_window(ts, window_hours=8.0) is True
