"""QN-061 — signed risk report: determinism, hash/signature integrity,
and content completeness (metrics, config snapshot, disclaimer)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from app.quant.risk_report import (
    DISCLAIMER,
    build_report_html,
    sign_report,
    verify_report,
)

GENERATED_AT = datetime(2026, 7, 14, 12, 0, tzinfo=UTC)
KEY = "test-signing-key-32-characters!!"


def _validation() -> dict[str, Any]:
    return {
        "id": "11111111-1111-4111-8111-111111111111",
        "windowStart": "2026-04-15T00:00:00+00:00",
        "windowEnd": "2026-07-14T00:00:00+00:00",
        "verdict": "PASS",
        "underpowered": False,
        "downgradedShare": 0.03,
        "effectSizeR": 0.1,
        "createdAt": "2026-07-14T11:00:00+00:00",
        "metrics": {
            "params": {
                "window_days": 90,
                "effect_size_r": 0.1,
                "alpha": 0.05,
                "power": 0.8,
                "downgraded_tolerance": 0.1,
                "rr": 1.8,
                "horizon_bars": 24,
            },
            "agent": {"n_trades": 214, "n_skipped": 0, "mean_r": 0.31, "net_mean_r": 0.27},
            "baseline": {"n_candidates_resolved": 412, "mean_r": 0.05},
            "llm_cost": {"usd": 148.22, "total_r": 3.7},
            "comparison": {"agent_net_minus_baseline_r": 0.22, "required_n_per_group": 180},
            "warnings": [],
        },
    }


def _champions() -> list[dict[str, Any]]:
    return [
        {
            "instrument": "XAU_USD",
            "timeframe": "H1",
            "version": 2,
            "trained_at": "2026-07-10T09:00:00+00:00",
            "artifact_path": "var/models/XAU_USD/H1/v2",
        }
    ]


def _html() -> str:
    return build_report_html(
        validation=_validation(),
        champions=_champions(),
        settings_snapshot={"version": 7, "settings": {"risk": {"riskPerTradePct": 0.01}}},
        quant_config={"min_rr": 1.8, "risk_per_trade_pct": 0.01},
        trading_mode="paper",
        generated_at=GENERATED_AT,
    )


# ── signing ──────────────────────────────────────────────────────────────────


def test_sign_and_verify_roundtrip() -> None:
    html = _html()
    sha256, signature = sign_report(html, KEY)
    assert len(sha256) == 64 and len(signature) == 64
    assert verify_report(html, KEY, sha256=sha256, signature=signature)


def test_tampered_content_fails_verification() -> None:
    html = _html()
    sha256, signature = sign_report(html, KEY)
    tampered = html.replace("PASS", "FAIL")
    assert not verify_report(tampered, KEY, sha256=sha256, signature=signature)


def test_wrong_key_fails_verification_even_with_matching_hash() -> None:
    html = _html()
    sha256, signature = sign_report(html, KEY)
    assert not verify_report(
        html, "some-other-key-32-characters!!!!", sha256=sha256, signature=signature
    )


def test_same_inputs_produce_byte_identical_reports() -> None:
    # Determinism is what makes the stored hash meaningful.
    assert _html() == _html()
    assert sign_report(_html(), KEY) == sign_report(_html(), KEY)


# ── content ──────────────────────────────────────────────────────────────────


def test_report_contains_metrics_config_and_disclaimer() -> None:
    html = _html()
    # QN-060 comparison numbers (net-of-cost AC).
    assert "0.27" in html  # agent net mean R
    assert "148.22" in html  # LLM cost USD
    assert "0.22" in html  # agent-net minus baseline
    # Powered comparison (BE-122).
    assert "180" in html  # required n per group
    # Champion provenance + config snapshot.
    assert "XAU_USD" in html and "var/models/XAU_USD/H1/v2" in html
    assert "riskPerTradePct" in html and "platform_settings v7" in html
    # Disclaimer verbatim (escaped) — the report is a legal artifact.
    assert "paper-trading validation only" in html
    assert DISCLAIMER.split(".")[0] in html


def test_no_champion_is_stated_not_hidden() -> None:
    html = build_report_html(
        validation=_validation(),
        champions=[],
        settings_snapshot={"version": None, "settings": None},
        quant_config={},
        trading_mode="paper",
        generated_at=GENERATED_AT,
    )
    assert "no champion promoted" in html


def test_html_escapes_hostile_strings() -> None:
    hostile = _validation()
    hostile["metrics"]["warnings"] = ['<script>alert("xss")</script>']
    html = build_report_html(
        validation=hostile,
        champions=_champions(),
        settings_snapshot={"version": 1, "settings": {}},
        quant_config={},
        trading_mode="paper",
        generated_at=GENERATED_AT,
    )
    assert "<script>" not in html
    assert "&lt;script&gt;" in html
