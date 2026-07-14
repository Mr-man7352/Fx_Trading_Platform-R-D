"""QN-062 — quant-leg replay: tolerance comparison, model-version honesty,
verdict assembly, and the persist=False no-side-effects contract."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from app.quant.baseline import BaselineSignalRow
from app.quant.pipeline import Candidate, PipelineResult
from app.quant.regime import RegimeResult, TrendRegime
from app.quant.replay import (
    StoredCandidate,
    build_replay_report,
    compare_candidate,
    compare_features,
)

BAR_TS = datetime(2026, 7, 9, 13, 0, tzinfo=UTC)


def _result(
    features: dict[str, float] | None = None,
    candidate: Candidate | None = None,
) -> PipelineResult:
    return PipelineResult(
        instrument="EUR_USD",
        timeframe="H1",
        bar_ts=BAR_TS,
        features=features if features is not None else {"rsi_14": 61.2, "atr_14": 0.0021},
        session_label="LONDON",
        liquidity_regime="HIGH",  # type: ignore[arg-type]
        regime=RegimeResult(label=TrendRegime.TREND_UP, timeline=[], entropy=0.41, debate_rounds=1),
        baseline=BaselineSignalRow(
            bar_ts=BAR_TS,
            instrument="EUR_USD",
            timeframe="H1",
            side="long",
            quant_score=0.5,
            would_trade=True,
            meta={},
        ),
        candidate=candidate,
    )


def _candidate(probability: float = 0.63, model_version: str = "EUR_USD/H1 v3") -> Candidate:
    return Candidate(
        instrument="EUR_USD",
        side="long",
        probability=probability,
        model_version=model_version,
        entry_price=1.0885,
        stop_loss_price=1.0845,
        take_profit_price=1.0965,
    )


# ── feature comparison ───────────────────────────────────────────────────────


def test_identical_features_no_drift() -> None:
    stored = {"rsi_14": 61.2, "atr_14": 0.0021}
    drift, missing, extra = compare_features(stored, dict(stored))
    assert drift == [] and missing == [] and extra == []


def test_jsonb_float_roundtrip_is_tolerated() -> None:
    drift, _, _ = compare_features({"x": 0.1 + 0.2}, {"x": 0.30000000000000004})
    assert drift == []


def test_real_drift_and_key_diffs_are_reported() -> None:
    drift, missing, extra = compare_features(
        {"rsi_14": 61.2, "gone": 1.0}, {"rsi_14": 59.0, "new": 2.0}
    )
    assert drift == [{"key": "rsi_14", "stored": 61.2, "replayed": 59.0}]
    assert missing == ["gone"]
    assert extra == ["new"]


# ── candidate comparison ─────────────────────────────────────────────────────


def _stored(probability: float | None = 0.63, model_version: str | None = None) -> StoredCandidate:
    return StoredCandidate(
        side="long",
        probability=probability,
        entry_price=1.0885,
        stop_loss_price=1.0845,
        take_profit_price=1.0965,
        model_version=model_version,
    )


def test_matching_candidate() -> None:
    cmp, notes = compare_candidate(
        _stored(), _result(candidate=_candidate()), model_version_match=None
    )
    assert cmp["match"] is True
    assert cmp["fields"]["probability"]["match"] is True
    assert notes == []


def test_model_version_changed_skips_probability_judgement() -> None:
    cmp, notes = compare_candidate(
        _stored(probability=0.63, model_version="EUR_USD/H1 v3"),
        _result(candidate=_candidate(probability=0.71, model_version="EUR_USD/H1 v4")),
        model_version_match=False,
    )
    assert cmp["fields"]["probability"]["match"] is None  # not judged, not failed
    assert cmp["match"] is True  # geometry still matches
    assert any("registry changed" in n for n in notes)


def test_candidate_presence_mismatch_is_not_deterministic() -> None:
    cmp, _ = compare_candidate(_stored(), _result(candidate=None), model_version_match=None)
    assert cmp["match"] is False


# ── report assembly ──────────────────────────────────────────────────────────


def test_full_report_deterministic_pass() -> None:
    result = _result(candidate=_candidate())
    report = build_replay_report(
        stored_features=dict(result.features),
        stored_candidate=_stored(),
        result=result,
    )
    assert report.deterministic is True
    # Schema gap surfaced honestly, not hidden.
    assert any("schema gap" in n for n in report.notes)


def test_feature_drift_fails_determinism() -> None:
    result = _result(features={"rsi_14": 61.2}, candidate=_candidate())
    report = build_replay_report(
        stored_features={"rsi_14": 99.0},
        stored_candidate=_stored(),
        result=result,
    )
    assert report.deterministic is False
    assert report.feature_drift[0]["key"] == "rsi_14"


def test_explicit_model_version_mismatch_fails_determinism() -> None:
    result = _result(candidate=_candidate(model_version="EUR_USD/H1 v4"))
    report = build_replay_report(
        stored_features=dict(result.features),
        stored_candidate=_stored(model_version="EUR_USD/H1 v3"),
        result=result,
    )
    assert report.model_version_match is False
    assert report.deterministic is False


def test_missing_stored_features_noted_not_crashed() -> None:
    report = build_replay_report(
        stored_features=None, stored_candidate=None, result=_result(candidate=None)
    )
    assert any("feature drift not judged" in n for n in report.notes)
    assert report.candidate["match"] is True  # both sides no-candidate


# ── persist=False: replay may never write ────────────────────────────────────


async def test_pipeline_persist_false_never_writes(fake_db: Any, trained_artifacts: Any) -> None:
    """Same computation, ZERO side effects — a replay can never contaminate
    the provenance it is checking (baseline rows, features, clusters)."""
    from app.quant.pipeline import QuantPipeline
    from app.quant.registry import ModelRegistry
    from tests.quant.conftest import make_candles

    store, _, _ = trained_artifacts
    fake_db.candles[("EUR_USD", "H1")] = make_candles(600, drift=0.003, vol=0.001, seed=23)
    bar_ts = fake_db.candles[("EUR_USD", "H1")]["ts"].iloc[-1].to_pydatetime()
    pipeline = QuantPipeline(fake_db, ModelRegistry(store, fake_db))

    result = await pipeline.run("EUR_USD", "H1", bar_ts, persist=False)

    assert fake_db.baselines == []
    assert fake_db.features_rows == []
    assert fake_db.cluster_sets == []
    assert result.features  # computation still happened
    assert result.meta == {}  # no cluster refresh attempted

    # Control: the same run with persist=True does write.
    await pipeline.run("EUR_USD", "H1", bar_ts, persist=True)
    assert len(fake_db.baselines) == 1
    assert len(fake_db.features_rows) == 1
