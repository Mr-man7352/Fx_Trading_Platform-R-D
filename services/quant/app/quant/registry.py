"""QN-043/QN-046 — model registry, champion/challenger promotion, drift monitor.

Artifacts live on the filesystem (`<model_dir>/<instrument>/<timeframe>/v<N>/`):
`model.txt` (LightGBM native), `calibrator.json`, `metadata.json` — no pickle
anywhere. The DB `model_registry` table (Step 2.3 schema) carries the roles;
`role` state machine:

    challenger ──promote (≥ min_shadow shadow predictions, or force)──▶ champion
    champion   ──superseded by a promotion──▶ retired

New models ALWAYS register as challenger and shadow the incumbent (QN-046 AC:
bad retrains can't reach live). The pipeline records a shadow prediction for
the newest challenger on every scored bar; the drift monitor compares recent
calibrated predictions against realized outcomes and alerts on decalibration.
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

import lightgbm as lgb
import numpy as np
from numpy.typing import NDArray

from app.quant.model import (
    Calibrator,
    TrainResult,
    expected_calibration_error,
)

ROLE_CHAMPION = "champion"
ROLE_CHALLENGER = "challenger"
ROLE_RETIRED = "retired"

DEFAULT_MIN_SHADOW = 100
DEFAULT_ECE_ALERT = 0.08
DEFAULT_BRIER_DEGRADATION = 1.2  # alert when recent Brier > 1.2× training Brier


@dataclass(slots=True)
class ModelMetadata:
    instrument: str
    timeframe: str
    version: int
    role: str
    trained_at: datetime
    calibration_method: str
    feature_set_version: int
    feature_names: list[str]
    metrics: dict[str, float]
    reliability: list[dict[str, float]] = field(default_factory=list)
    lgbm_params: dict[str, Any] = field(default_factory=dict)
    label_params: dict[str, Any] = field(default_factory=dict)
    shadow_count: int = 0
    artifact_path: str = ""

    def to_json(self) -> dict[str, Any]:
        data = asdict(self)
        data["trained_at"] = self.trained_at.isoformat()
        return data

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> ModelMetadata:
        data = dict(data)
        data["trained_at"] = datetime.fromisoformat(data["trained_at"])
        return cls(**data)


@dataclass(slots=True)
class LoadedModel:
    booster: lgb.Booster
    calibrator: Calibrator
    meta: ModelMetadata


class RegistryDb(Protocol):
    """DB seam (implemented over asyncpg in app.quant.dbio; faked in tests)."""

    async def upsert_model(self, meta: ModelMetadata) -> None: ...

    async def list_models(self, instrument: str, timeframe: str) -> list[ModelMetadata]: ...

    async def set_role(
        self, instrument: str, timeframe: str, version: int, role: str,
        promoted_at: datetime | None = None,
    ) -> None: ...

    async def bump_shadow_count(self, instrument: str, timeframe: str, version: int) -> int: ...


class ModelStore:
    """Filesystem artifact store — pure I/O, no policy."""

    def __init__(self, model_dir: Path) -> None:
        self._dir = Path(model_dir)

    def _version_dir(self, instrument: str, timeframe: str, version: int) -> Path:
        return self._dir / instrument / timeframe / f"v{version}"

    def next_version(self, instrument: str, timeframe: str) -> int:
        base = self._dir / instrument / timeframe
        if not base.is_dir():
            return 1
        versions = [
            int(p.name[1:]) for p in base.iterdir() if p.is_dir() and p.name.startswith("v")
        ]
        return max(versions, default=0) + 1

    def save(
        self,
        result: TrainResult,
        *,
        instrument: str,
        timeframe: str,
        feature_set_version: int,
        label_params: dict[str, Any] | None = None,
        trained_at: datetime | None = None,
    ) -> ModelMetadata:
        version = self.next_version(instrument, timeframe)
        vdir = self._version_dir(instrument, timeframe, version)
        vdir.mkdir(parents=True, exist_ok=True)
        result.booster.save_model(str(vdir / "model.txt"))
        (vdir / "calibrator.json").write_text(json.dumps(result.calibrator.to_json()))
        meta = ModelMetadata(
            instrument=instrument,
            timeframe=timeframe,
            version=version,
            role=ROLE_CHALLENGER,  # NEVER born champion (QN-046)
            trained_at=trained_at or datetime.now(UTC),
            calibration_method=result.calibrator.method,
            feature_set_version=feature_set_version,
            feature_names=result.feature_names,
            metrics=result.metrics,
            reliability=result.reliability,
            lgbm_params={k: v for k, v in result.lgbm_params.items()},
            label_params=label_params or {},
            artifact_path=str(vdir),
        )
        (vdir / "metadata.json").write_text(json.dumps(meta.to_json(), indent=2))
        return meta

    def load(self, instrument: str, timeframe: str, version: int) -> LoadedModel:
        vdir = self._version_dir(instrument, timeframe, version)
        booster = lgb.Booster(model_file=str(vdir / "model.txt"))
        calibrator = Calibrator.from_json(json.loads((vdir / "calibrator.json").read_text()))
        meta = ModelMetadata.from_json(json.loads((vdir / "metadata.json").read_text()))
        return LoadedModel(booster=booster, calibrator=calibrator, meta=meta)


@dataclass(frozen=True, slots=True)
class DriftReport:
    """QN-046 calibration-drift check over a recent prediction/outcome window."""

    n: int
    ece: float
    brier: float
    training_brier: float
    decalibrated: bool
    reason: str | None


def calibration_drift(
    predictions: NDArray[np.float64],
    outcomes: NDArray[np.float64],
    *,
    training_brier: float,
    ece_alert: float = DEFAULT_ECE_ALERT,
    brier_degradation: float = DEFAULT_BRIER_DEGRADATION,
    min_n: int = 50,
) -> DriftReport:
    """Alert when the served model's recent calibration has drifted."""
    p = np.asarray(predictions, dtype=np.float64)
    y = np.asarray(outcomes, dtype=np.float64)
    if len(p) != len(y):
        raise ValueError("predictions and outcomes must align")
    if len(p) < min_n:
        return DriftReport(len(p), math.nan, math.nan, training_brier, False, None)
    ece = expected_calibration_error(p, y)
    brier = float(np.mean((p - y) ** 2))
    reason: str | None = None
    if ece > ece_alert:
        reason = f"ece {ece:.3f} > {ece_alert}"
    elif training_brier > 0 and brier > brier_degradation * training_brier:
        reason = f"brier {brier:.3f} > {brier_degradation}x training {training_brier:.3f}"
    return DriftReport(len(p), ece, brier, training_brier, reason is not None, reason)


class ModelRegistry:
    """Policy layer: which model serves, which shadows, when to promote."""

    def __init__(self, store: ModelStore, db: RegistryDb) -> None:
        self._store = store
        self._db = db

    async def register(self, meta: ModelMetadata) -> ModelMetadata:
        """Register a freshly trained model — always as challenger."""
        meta.role = ROLE_CHALLENGER
        await self._db.upsert_model(meta)
        return meta

    async def champion(self, instrument: str, timeframe: str) -> LoadedModel | None:
        models = await self._db.list_models(instrument, timeframe)
        serving = [m for m in models if m.role == ROLE_CHAMPION]
        if not serving:
            return None
        newest = max(serving, key=lambda m: m.version)
        return self._store.load(instrument, timeframe, newest.version)

    async def newest_challenger(self, instrument: str, timeframe: str) -> LoadedModel | None:
        models = await self._db.list_models(instrument, timeframe)
        challengers = [m for m in models if m.role == ROLE_CHALLENGER]
        if not challengers:
            return None
        newest = max(challengers, key=lambda m: m.version)
        return self._store.load(instrument, timeframe, newest.version)

    async def record_shadow(self, instrument: str, timeframe: str, version: int) -> int:
        """Count one shadow prediction for a challenger (pipeline hot path)."""
        return await self._db.bump_shadow_count(instrument, timeframe, version)

    async def promote(
        self,
        instrument: str,
        timeframe: str,
        version: int,
        *,
        min_shadow: int = DEFAULT_MIN_SHADOW,
        force: bool = False,
    ) -> ModelMetadata:
        """Challenger → champion; the old champion retires.

        Refuses (QN-046 AC) unless the challenger has shadowed the incumbent
        for at least `min_shadow` scored bars — `force=True` is the explicit
        operator override and is expected to be audited by the caller.
        """
        models = await self._db.list_models(instrument, timeframe)
        target = next((m for m in models if m.version == version), None)
        if target is None:
            raise ValueError(f"no model v{version} for {instrument}/{timeframe}")
        if target.role != ROLE_CHALLENGER:
            raise ValueError(f"v{version} is {target.role}, not a challenger")
        if not force and target.shadow_count < min_shadow:
            raise ValueError(
                f"v{version} has shadowed {target.shadow_count} bars; "
                f"needs >= {min_shadow} (or force=True)"
            )
        now = datetime.now(UTC)
        for m in models:
            if m.role == ROLE_CHAMPION:
                await self._db.set_role(instrument, timeframe, m.version, ROLE_RETIRED)
        await self._db.set_role(instrument, timeframe, version, ROLE_CHAMPION, promoted_at=now)
        target.role = ROLE_CHAMPION
        return target
