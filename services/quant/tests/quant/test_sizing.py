"""QN-042/QN-044 — vol-target sizing, Kelly cap, FCA caps, prob modulation.

Fixture mirrors QN-034's AC: GBP account trading USD-quoted instruments.
"""

from __future__ import annotations

import pytest

from app.execution.sizing import FixedRates
from app.quant.sizing import (
    SizingConfig,
    SizingDecision,
    fca_leverage_cap,
    kelly_f,
    probability_scale,
    size_position,
)

RATES = FixedRates({"EUR_USD": 1.10, "GBP_USD": 1.25, "USD_JPY": 150.0, "XAU_USD": 2400.0})
EQUITY = 10_000.0  # GBP


def _size(**overrides: object) -> SizingDecision:
    args: dict = dict(
        instrument="EUR_USD",
        entry_price=1.10,
        stop_loss_price=1.0950,  # 50 pips
        account_equity=EQUITY,
        rates=RATES,
        config=SizingConfig(),
    )
    args.update(overrides)
    return size_position(**args)


class TestBaseRisk:
    def test_one_percent_risk_gbp_account(self) -> None:
        # pip value/unit = 0.0001 × rate(USD→GBP) = 0.00008 GBP.
        # units = 100 GBP / (50 pips × 0.00008) = 25,000.
        d = _size()
        assert d.units == 25_000
        assert d.risk_amount == pytest.approx(100.0, rel=1e-9)
        assert d.risk_pct_used == pytest.approx(0.01, rel=1e-9)

    def test_hard_ceiling_clamps_config(self) -> None:
        # §10 non-negotiable: even a 5% config risks only 1%.
        d = _size(config=SizingConfig(risk_per_trade_pct=0.05))
        assert d.units == 25_000
        assert "hard_risk_ceiling" in d.caps_applied

    def test_input_validation(self) -> None:
        with pytest.raises(ValueError):
            _size(stop_loss_price=1.10)
        with pytest.raises(ValueError):
            _size(account_equity=0)


class TestVolTarget:
    def test_atr_cap_binds_when_atr_wide(self) -> None:
        # ATR 100 pips, vol_risk 0.5% ⇒ units_vol = 50/(100×0.00008) = 6,250.
        d = _size(atr=0.0100)
        assert d.units == 6_250
        assert "vol_target" in d.caps_applied
        assert d.target_vol_pct == 0.005

    def test_atr_cap_ignored_when_looser(self) -> None:
        d = _size(atr=0.0010)  # 10 pips → vol units 62,500 > stop-risk units
        assert d.units == 25_000
        assert "vol_target" not in d.caps_applied


class TestKelly:
    def test_kelly_math(self) -> None:
        assert kelly_f(0.60, 1.8) == pytest.approx(0.60 - 0.40 / 1.8)
        with pytest.raises(ValueError):
            kelly_f(1.5, 1.8)

    def test_no_edge_zeroes_the_trade(self) -> None:
        d = _size(probability=0.30)  # f* < 0 at R:R 1.8
        assert d.units == 0.0
        assert "kelly_no_edge" in d.caps_applied

    def test_fractional_kelly_binds_near_breakeven(self) -> None:
        # p=0.36, b=1.8 ⇒ f*≈0.0044; quarter-Kelly ≈ 0.11% < 1% ⇒ cap binds.
        d = _size(probability=0.36)
        assert "kelly_cap" in d.caps_applied
        assert 0 < d.units < 25_000

    def test_kelly_loose_at_healthy_probability(self) -> None:
        d = _size(probability=0.65)
        assert "kelly_cap" not in d.caps_applied
        assert d.units == 25_000


class TestProbabilityModulation:
    def test_scale_endpoints(self) -> None:
        # QN-044 AC: P=0.60 vs P=0.75 scales ~0.5×–1×.
        assert probability_scale(0.60) == 0.5
        assert probability_scale(0.75) == 1.0
        assert probability_scale(0.675) == pytest.approx(0.75)
        assert probability_scale(0.90) == 1.0  # clamped
        assert probability_scale(0.50) == 0.5  # clamped

    def test_flag_on_scales_units(self) -> None:
        cfg = SizingConfig(prob_sizing_enabled=True)
        low = _size(probability=0.60, config=cfg)
        high = _size(probability=0.75, config=cfg)
        assert low.units == pytest.approx(high.units * 0.5, rel=0.01)
        assert low.prob_scale == 0.5
        assert high.prob_scale == 1.0

    def test_flag_off_never_scales(self) -> None:
        d = _size(probability=0.60)  # default config: flag off
        assert d.prob_scale == 1.0
        assert d.units == 25_000


class TestFcaCaps:
    def test_cap_table(self) -> None:
        assert fca_leverage_cap("EUR_USD") == 30.0
        assert fca_leverage_cap("GBP_USD") == 30.0
        assert fca_leverage_cap("NZD_USD") == 20.0  # minor
        assert fca_leverage_cap("XAU_USD") == 20.0
        assert fca_leverage_cap("WTICO_USD") == 10.0
        assert fca_leverage_cap("BCO_USD") == 10.0

    def test_leverage_cap_binds_on_tight_stop(self) -> None:
        # 2-pip stop wants 625k units; 30:1 on £10k caps ≈ 340,909.
        d = _size(stop_loss_price=1.0998)
        assert "fca_leverage" in d.caps_applied
        max_notional_gbp = d.units * 1.10 * (1 / 1.25)
        assert max_notional_gbp <= EQUITY * 30.0 * (1 + 1e-9)

    def test_broker_margin_rate_can_only_tighten(self) -> None:
        loose = _size(stop_loss_price=1.0998, margin_rate=0.02)  # 50:1 — ignored
        tight = _size(stop_loss_price=1.0998, margin_rate=0.10)  # 10:1 — binds
        assert tight.units < loose.units

    def test_min_units_floor(self) -> None:
        d = _size(account_equity=0.05)
        assert d.units == 0.0
        assert "below_min_units" in d.caps_applied

    def test_units_rounded_to_step(self) -> None:
        d = _size(config=SizingConfig(unit_step=1000.0))
        assert d.units % 1000 == 0
