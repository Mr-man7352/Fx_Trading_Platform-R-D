"""QN-061 — signed risk report generator.

Produces a SELF-CONTAINED HTML document (no external assets — it must render
identically in ten years) from a PASS QN-060 paper validation: comparison
metrics, champion model provenance, operator config snapshot, and the
disclaimer. The report is hashed (SHA-256) and signed (HMAC-SHA256 with
`REPORT_SIGNING_KEY`) and stored WITH content in `risk_reports`, so the
audit trail verifies without any filesystem dependency.

Verification (audit): recompute `sha256(content_html)` and
`hmac_sha256(content_html, key)` and compare against the stored row —
`verify_report` below does exactly that.

Pure module: no DB, no clock — callers inject everything (testable, and the
same inputs always produce byte-identical output).
"""

from __future__ import annotations

import hashlib
import hmac
import html
import json
from datetime import datetime
from typing import Any

DISCLAIMER = (
    "This report documents a paper-trading validation only. Past performance, "
    "simulated or live, does not guarantee future results. Leveraged FX and "
    "CFD trading carries a high risk of loss exceeding deposits. This system "
    "trades a single operator's own account (own-account-only, invite-only); "
    "nothing in this report is investment advice or an invitation to trade. "
    "Live promotion additionally requires the full BE-101 checklist, canary "
    "sizing with human confirmation (BE-121), and an armed kill-switch path."
)


def sign_report(content_html: str, key: str) -> tuple[str, str]:
    """(sha256 hex, hmac-sha256 hex). Key is the raw REPORT_SIGNING_KEY."""
    digest = hashlib.sha256(content_html.encode("utf-8")).hexdigest()
    signature = hmac.new(
        key.encode("utf-8"), content_html.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return digest, signature


def verify_report(content_html: str, key: str, *, sha256: str, signature: str) -> bool:
    """Audit-side check: hash AND signature must both match."""
    digest, sig = sign_report(content_html, key)
    return hmac.compare_digest(digest, sha256) and hmac.compare_digest(sig, signature)


def _fmt(value: Any) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:.6g}"
    return html.escape(str(value))


def _kv_table(rows: list[tuple[str, Any]]) -> str:
    body = "".join(
        f"<tr><th>{html.escape(label)}</th><td>{_fmt(value)}</td></tr>" for label, value in rows
    )
    return f"<table>{body}</table>"


def build_report_html(
    *,
    validation: dict[str, Any],
    champions: list[dict[str, Any]],
    settings_snapshot: dict[str, Any],
    quant_config: dict[str, Any],
    trading_mode: str,
    generated_at: datetime,
) -> str:
    """Deterministic HTML from the QN-060 record + config snapshot.

    `validation` is the `latest_paper_validation()` dict (camelCase keys);
    `champions` are current champion registry rows; `settings_snapshot` is the
    latest `platform_settings` row; `quant_config` the quant-side risk knobs.
    """
    metrics = validation.get("metrics", {}) or {}
    agent = metrics.get("agent", {}) or {}
    baseline = metrics.get("baseline", {}) or {}
    llm_cost = metrics.get("llm_cost", {}) or {}
    comparison = metrics.get("comparison", {}) or {}
    params = metrics.get("params", {}) or {}
    warnings: list[str] = list(metrics.get("warnings", []) or [])

    champion_rows = (
        "".join(
            "<tr>"
            f"<td>{_fmt(c.get('instrument'))}</td>"
            f"<td>{_fmt(c.get('timeframe'))}</td>"
            f"<td>v{_fmt(c.get('version'))}</td>"
            f"<td>{_fmt(c.get('trained_at'))}</td>"
            f"<td><code>{_fmt(c.get('artifact_path'))}</code></td>"
            "</tr>"
            for c in champions
        )
        or '<tr><td colspan="5">no champion promoted — this alone blocks live (BE-101)</td></tr>'
    )
    warning_items = "".join(f"<li>{html.escape(w)}</li>" for w in warnings) or "<li>none</li>"
    settings_json = html.escape(
        json.dumps(settings_snapshot.get("settings"), indent=2, sort_keys=True, default=str)
    )
    quant_json = html.escape(json.dumps(quant_config, indent=2, sort_keys=True, default=str))

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>FX Platform — Signed Risk Report</title>
<style>
  body {{ font: 14px/1.5 system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; color: #111; }}
  h1 {{ font-size: 1.4rem; }} h2 {{ font-size: 1.1rem; margin-top: 2rem; }}
  table {{ border-collapse: collapse; width: 100%; margin: .5rem 0; }}
  th, td {{ border: 1px solid #ccc; padding: .3rem .6rem; text-align: left; vertical-align: top; }}
  th {{ background: #f5f5f5; width: 18rem; font-weight: 600; }}
  .verdict-PASS {{ color: #0a6b2d; font-weight: 700; }}
  .disclaimer {{ border: 1px solid #b00; background: #fff5f5; padding: 1rem; margin-top: 2rem; }}
  code {{ font-size: .85em; }}
</style>
</head>
<body>
<h1>Signed Risk Report — 90-day Paper Validation (QN-061)</h1>
{
        _kv_table(
            [
                ("Generated at (UTC)", generated_at.isoformat()),
                ("Trading mode at generation", trading_mode),
                ("Validation verdict", validation.get("verdict")),
                (
                    "Validation window",
                    f"{validation.get('windowStart')} → {validation.get('windowEnd')}",
                ),
                ("Validation recorded at", validation.get("createdAt")),
            ]
        )
    }

<h2>Agents vs shadow baseline — net of LLM cost (QN-060)</h2>
{
        _kv_table(
            [
                ("Agent trades (n)", agent.get("n_trades")),
                ("Agent trades excluded (no usable stop)", agent.get("n_skipped")),
                ("Agent mean R (gross)", agent.get("mean_r")),
                ("Agent mean R (net of LLM cost)", agent.get("net_mean_r")),
                ("Baseline candidates resolved (n)", baseline.get("n_candidates_resolved")),
                ("Baseline mean R", baseline.get("mean_r")),
                ("Agent-net minus baseline (R)", comparison.get("agent_net_minus_baseline_r")),
                ("LLM cost over window (USD)", llm_cost.get("usd")),
                ("LLM cost (total R)", llm_cost.get("total_r")),
            ]
        )
    }

<h2>Pre-registered analysis plan &amp; power (BE-122: powered comparison)</h2>
{
        _kv_table(
            [
                ("Window (days)", params.get("window_days")),
                ("Pre-registered effect size (R)", params.get("effect_size_r")),
                ("Alpha / power", f"{params.get('alpha')} / {params.get('power')}"),
                ("Required n per group", comparison.get("required_n_per_group")),
                ("Underpowered", validation.get("underpowered")),
                (
                    "Downgraded-cycle share (§9.4 tolerance "
                    + _fmt(params.get("downgraded_tolerance"))
                    + ")",
                    validation.get("downgradedShare"),
                ),
            ]
        )
    }

<h2>Validation warnings</h2>
<ul>{warning_items}</ul>

<h2>Champion models (registry at generation time)</h2>
<table>
<tr><th>Instrument</th><th>TF</th><th>Version</th><th>Trained at</th><th>Artifact</th></tr>
{champion_rows}
</table>

<h2>Config snapshot</h2>
<h3>Operator settings (platform_settings v{_fmt(settings_snapshot.get("version"))})</h3>
<pre><code>{settings_json}</code></pre>
<h3>Quant risk knobs</h3>
<pre><code>{quant_json}</code></pre>

<div class="disclaimer"><strong>Disclaimer.</strong> {html.escape(DISCLAIMER)}</div>
</body>
</html>
"""
