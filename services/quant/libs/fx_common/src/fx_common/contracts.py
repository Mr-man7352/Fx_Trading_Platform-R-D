"""Contract (JSON Schema) loaders (QN-002).

Schemas originate in `@fx/types` (Zod source of truth) and are vendored into
the service by QN-003 codegen (`app/contracts/schemas/`). fx_common stays
app-agnostic: callers pass `schemas_dir` or set `FX_CONTRACTS_DIR`.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from fx_common.errors import FXError


def load_contract(name: str, schemas_dir: Path | str | None = None) -> dict[str, Any]:
    """Load contract `name` (e.g. "HealthResponse") as a parsed JSON Schema dict.

    Resolution order for the schemas directory: explicit arg → FX_CONTRACTS_DIR env.
    """
    directory = schemas_dir or os.environ.get("FX_CONTRACTS_DIR")
    if directory is None:
        raise FXError(
            "CONTRACTS_DIR_UNSET",
            "Pass schemas_dir or set FX_CONTRACTS_DIR to the vendored schemas directory",
        )
    path = Path(directory) / f"{name}.json"
    if not path.is_file():
        raise FXError("CONTRACT_NOT_FOUND", f"No contract schema at {path}")
    with path.open(encoding="utf-8") as fh:
        schema: dict[str, Any] = json.load(fh)
    return schema
