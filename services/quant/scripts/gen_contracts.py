"""QN-003 — Pydantic models from @fx/types JSON Schemas.

Vendors `packages/types/dist/schemas/*.json` into app/contracts/schemas/ (for
fx_common.load_contract) and generates Pydantic v2 models into app/contracts/.
Requires `pnpm --filter @fx/types build` to have emitted the schemas first.

Run from services/quant: `uv run python scripts/gen_contracts.py`
Output is committed; CI regenerates and fails on drift (scripts/check_codegen.sh).
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = ROOT.parent.parent
SCHEMAS_SRC = REPO_ROOT / "packages" / "types" / "dist" / "schemas"
CONTRACTS_DIR = ROOT / "app" / "contracts"
SCHEMAS_DST = CONTRACTS_DIR / "schemas"

INIT_CONTENT = '''"""Generated from @fx/types JSON Schemas (QN-003) — scripts/gen_contracts.py."""
'''


def main() -> None:
    if not SCHEMAS_SRC.is_dir():
        sys.exit(f"{SCHEMAS_SRC} missing — run `pnpm --filter @fx/types build` first")

    # Clean slate so removed contracts disappear (drift check catches strays).
    if CONTRACTS_DIR.exists():
        shutil.rmtree(CONTRACTS_DIR)
    SCHEMAS_DST.mkdir(parents=True)
    for schema in sorted(SCHEMAS_SRC.glob("*.json")):
        shutil.copy2(schema, SCHEMAS_DST / schema.name)

    subprocess.run(
        [
            sys.executable,
            "-m",
            "datamodel_code_generator",
            "--input",
            str(SCHEMAS_DST),
            "--input-file-type",
            "jsonschema",
            "--output",
            str(CONTRACTS_DIR),
            "--output-model-type",
            "pydantic_v2.BaseModel",
            "--target-python-version",
            "3.13",
            "--snake-case-field",
            "--allow-population-by-field-name",
            "--use-schema-description",
            "--use-double-quotes",
            "--disable-timestamp",
            # Explicit formatters: the default becomes opt-in in a future
            # datamodel-code-generator — implicit defaults would break the
            # CI drift check on upgrade.
            "--formatters",
            "black",
            "isort",
        ],
        check=True,
    )
    (CONTRACTS_DIR / "__init__.py").write_text(INIT_CONTENT, encoding="utf-8")
    print(f"generated contracts in {CONTRACTS_DIR}")


if __name__ == "__main__":
    main()
