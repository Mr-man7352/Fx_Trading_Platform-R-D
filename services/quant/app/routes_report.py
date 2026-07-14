"""REST surface for Step 6.4 — QN-061 signed risk report.

  POST /risk-report/generate
      Build, sign, and persist the live-promotion risk report from the
      LATEST QN-060 paper validation. Refuses (409) unless that validation
      is a PASS — the report documents evidence, it never invents it.
      Refuses (503) without REPORT_SIGNING_KEY: an unsigned report must
      never appear in `risk_reports` (BE-101 counts any row as evidence).

  GET /risk-report/latest[?includeHtml=true]
      Metadata (hash, signature, config snapshot) of the authoritative
      (latest) report; the full HTML on request.

Shares the lazily built QuantRuntime with the other REST routers.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.config import get_settings
from app.grpc.servicer import UnavailableError
from app.quant.risk_report import build_report_html, sign_report
from app.routes_backtest import get_runtime

router = APIRouter()

_MIN_KEY_LENGTH = 16


def _quant_config_snapshot() -> dict[str, Any]:
    s = get_settings()
    return {
        "risk_per_trade_pct": s.risk_per_trade_pct,
        "vol_risk_pct": s.vol_risk_pct,
        "kelly_fraction": s.kelly_fraction,
        "prob_sizing_enabled": s.prob_sizing_enabled,
        "min_rr": s.min_rr,
        "pipeline_lookback_bars": s.pipeline_lookback_bars,
        "label_horizon_bars": s.label_horizon_bars,
        "corr_threshold": s.corr_threshold,
        "corr_lookback_days": s.corr_lookback_days,
        "instruments": s.instruments,
        "trading_mode": s.trading_mode,
    }


@router.post("/risk-report/generate")
async def generate_report() -> dict[str, Any]:
    settings = get_settings()
    key = settings.report_signing_key
    if not key or len(key) < _MIN_KEY_LENGTH:
        raise HTTPException(
            status_code=503,
            detail=(
                "REPORT_SIGNING_KEY missing or too short (min "
                f"{_MIN_KEY_LENGTH} chars) — refusing to produce an unsigned report"
            ),
        )

    runtime = get_runtime()
    try:
        db = await runtime.db()
    except UnavailableError as err:
        raise HTTPException(status_code=503, detail=str(err)) from err

    validation = await db.latest_paper_validation()
    if validation is None:
        raise HTTPException(
            status_code=409, detail="no QN-060 paper-validation run recorded — run it first"
        )
    if validation["verdict"] != "PASS":
        raise HTTPException(
            status_code=409,
            detail=(
                f"latest paper validation verdict is {validation['verdict']} — "
                "a risk report documents a PASS, it never invents one"
            ),
        )

    champions = await db.fetch_champions()
    platform_settings = await db.fetch_latest_platform_settings() or {
        "version": None,
        "settings": None,
        "note": "no platform_settings row — env/compiled defaults in effect",
    }
    quant_config = _quant_config_snapshot()
    generated_at = datetime.now(tz=UTC)

    content_html = build_report_html(
        validation=validation,
        champions=champions,
        settings_snapshot=platform_settings,
        quant_config=quant_config,
        trading_mode=settings.trading_mode,
        generated_at=generated_at,
    )
    sha256, signature = sign_report(content_html, key)
    config_snapshot = {"platformSettings": platform_settings, "quant": quant_config}
    persisted = await db.insert_risk_report(
        paper_validation_id=validation.get("id"),
        content_html=content_html,
        sha256=sha256,
        signature=signature,
        config_snapshot=config_snapshot,
    )
    return {
        "id": persisted["id"],
        "createdAt": persisted["createdAt"],
        "paperValidationId": validation.get("id"),
        "sha256": sha256,
        "signature": signature,
        "bytes": len(content_html.encode("utf-8")),
    }


@router.get("/risk-report/latest")
async def latest_report(
    include_html: bool = Query(default=False, alias="includeHtml"),
) -> dict[str, Any]:
    runtime = get_runtime()
    try:
        db = await runtime.db()
    except UnavailableError as err:
        raise HTTPException(status_code=503, detail=str(err)) from err
    # runtime.db() is typed Any (lazy seam) — pin the shape for mypy --strict.
    latest: dict[str, Any] | None = await db.latest_risk_report()
    if latest is None:
        raise HTTPException(status_code=404, detail="no risk report generated yet")
    if not include_html:
        latest = {k: v for k, v in latest.items() if k != "contentHtml"}
    return latest
