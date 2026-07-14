"""QN-062 — decision replay from provenance (quant leg).

Proves full reconstructability of the DETERMINISTIC half of a past decision:
re-runs the pipeline point-in-time at the stored `bar_ts` (side-effect-free,
`persist=False`) and compares the replayed feature vector + candidate against
what the signal row recorded at decision time.

The agent half is replayed from provenance by the Node side (LLM cached
mode: `agent_runs.output` IS the cache, `retrieved_memory_ids` pins the exact
§9.5 memory context — BE-064); this module never touches an LLM.

Honesty rules:
- A model-registry change since the original run (new champion) legitimately
  changes the probability — the report says so (`model_version_match`)
  instead of pretending drift. Stored signals don't persist the model
  version (schema gap noted in the report) so the match is inferred from
  the replayed candidate's version when the caller can't supply one.
- Feature comparison is tolerance-based (float round-trips through jsonb),
  with missing/extra keys reported explicitly, never swallowed.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from app.quant.pipeline import PipelineResult

# jsonb round-trips floats through text: exact for doubles, but be tolerant
# of downstream serialisers that clipped precision.
REL_TOL = 1e-9
ABS_TOL = 1e-12

# Non-deterministic-by-design keys a replay may legitimately differ on: none
# today — the pipeline is seeded. Kept explicit so future exceptions are
# documented here, not silently skipped.
IGNORED_FEATURE_KEYS: frozenset[str] = frozenset()


@dataclass(frozen=True, slots=True)
class StoredCandidate:
    """Candidate values persisted on the `signals` row at decision time."""

    side: str
    probability: float | None
    entry_price: float | None
    stop_loss_price: float | None
    take_profit_price: float | None
    model_version: str | None = None  # schema gap: not persisted on signals


@dataclass(slots=True)
class QuantReplayReport:
    deterministic: bool
    model_version_match: bool | None
    feature_drift: list[dict[str, Any]] = field(default_factory=list)
    missing_keys: list[str] = field(default_factory=list)
    extra_keys: list[str] = field(default_factory=list)
    candidate: dict[str, Any] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "deterministic": self.deterministic,
            "modelVersionMatch": self.model_version_match,
            "featureDrift": self.feature_drift,
            "missingKeys": self.missing_keys,
            "extraKeys": self.extra_keys,
            "candidate": self.candidate,
            "notes": self.notes,
        }


def _close(a: float, b: float) -> bool:
    if math.isnan(a) and math.isnan(b):
        return True
    return math.isclose(a, b, rel_tol=REL_TOL, abs_tol=ABS_TOL)


def compare_features(
    stored: dict[str, Any],
    replayed: dict[str, float],
) -> tuple[list[dict[str, Any]], list[str], list[str]]:
    """(drift rows, keys missing from replay, keys only in replay)."""
    drift: list[dict[str, Any]] = []
    stored_keys = {k for k in stored if k not in IGNORED_FEATURE_KEYS}
    replay_keys = {k for k in replayed if k not in IGNORED_FEATURE_KEYS}
    for key in sorted(stored_keys & replay_keys):
        s, r = stored[key], replayed[key]
        if not isinstance(s, (int, float)) or isinstance(s, bool):
            # Non-numeric stored value (shouldn't happen) — compare as-is.
            if s != r:
                drift.append({"key": key, "stored": s, "replayed": r})
            continue
        if not _close(float(s), float(r)):
            drift.append({"key": key, "stored": float(s), "replayed": float(r)})
    missing = sorted(stored_keys - replay_keys)
    extra = sorted(replay_keys - stored_keys)
    return drift, missing, extra


def compare_candidate(
    stored: StoredCandidate | None,
    result: PipelineResult,
    *,
    model_version_match: bool | None,
) -> tuple[dict[str, Any], list[str]]:
    """Candidate-geometry comparison; probability only when the model matches."""
    notes: list[str] = []
    replayed = result.candidate
    if stored is None and replayed is None:
        return {"storedHasCandidate": False, "replayedHasCandidate": False, "match": True}, notes
    if stored is None or replayed is None:
        notes.append(
            "candidate presence differs between stored signal and replay — "
            "if the champion changed since the original run this is expected"
        )
        return {
            "storedHasCandidate": stored is not None,
            "replayedHasCandidate": replayed is not None,
            "match": False,
        }, notes

    fields: dict[str, Any] = {
        "side": {
            "stored": stored.side,
            "replayed": replayed.side,
            "match": stored.side == replayed.side,
        },
    }
    for name, s_val, r_val in (
        ("entryPrice", stored.entry_price, replayed.entry_price),
        ("stopLossPrice", stored.stop_loss_price, replayed.stop_loss_price),
        ("takeProfitPrice", stored.take_profit_price, replayed.take_profit_price),
    ):
        match = s_val is not None and _close(float(s_val), float(r_val))
        fields[name] = {"stored": s_val, "replayed": r_val, "match": match}

    if model_version_match is False:
        fields["probability"] = {
            "stored": stored.probability,
            "replayed": replayed.probability,
            "match": None,
        }
        notes.append(
            "probability not judged: model registry changed since the original "
            f"run (replayed with {replayed.model_version})"
        )
    else:
        match = stored.probability is not None and _close(
            float(stored.probability), float(replayed.probability)
        )
        fields["probability"] = {
            "stored": stored.probability,
            "replayed": replayed.probability,
            "match": match,
        }

    judged = [f["match"] for f in fields.values() if f["match"] is not None]
    return {
        "storedHasCandidate": True,
        "replayedHasCandidate": True,
        "modelVersion": replayed.model_version,
        "fields": fields,
        "match": all(judged),
    }, notes


def build_replay_report(
    *,
    stored_features: dict[str, Any] | None,
    stored_candidate: StoredCandidate | None,
    result: PipelineResult,
) -> QuantReplayReport:
    notes: list[str] = []

    model_version_match: bool | None = None
    if stored_candidate is not None and result.candidate is not None:
        if stored_candidate.model_version is None:
            model_version_match = None
            notes.append(
                "stored signal does not persist the model version (schema gap) — "
                "probability compared against the CURRENT champion; treat a "
                "probability mismatch as inconclusive if the registry changed"
            )
        else:
            model_version_match = stored_candidate.model_version == result.candidate.model_version

    if stored_features:
        drift, missing, extra = compare_features(stored_features, result.features)
    else:
        drift, missing, extra = [], [], []
        notes.append("no stored feature vector on the signal — feature drift not judged")

    candidate_cmp, cand_notes = compare_candidate(
        stored_candidate, result, model_version_match=model_version_match
    )
    notes.extend(cand_notes)

    deterministic = (
        not drift
        and not missing
        and bool(candidate_cmp.get("match"))
        and model_version_match is not False
    )
    return QuantReplayReport(
        deterministic=deterministic,
        model_version_match=model_version_match,
        feature_drift=drift,
        missing_keys=missing,
        extra_keys=extra,
        candidate=candidate_cmp,
        notes=notes,
    )
