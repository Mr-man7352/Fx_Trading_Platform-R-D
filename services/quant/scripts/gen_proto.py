"""QN-004 — generate Python gRPC stubs from proto/quant.proto.

Run from services/quant: `uv run python scripts/gen_proto.py`
Output (app/proto_gen/) is committed; CI regenerates and fails on drift
(scripts/check_codegen.sh). Never edit generated files by hand.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import grpc_tools
from grpc_tools import protoc

ROOT = Path(__file__).resolve().parent.parent
PROTO_DIR = ROOT / "proto"
OUT_DIR = ROOT / "app" / "proto_gen"

INIT_CONTENT = '''"""Generated gRPC stubs (QN-004) — regenerate via scripts/gen_proto.py."""

from app.proto_gen import quant_pb2, quant_pb2_grpc

__all__ = ["quant_pb2", "quant_pb2_grpc"]
'''


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    well_known = Path(grpc_tools.__file__).parent / "_proto"
    rc = protoc.main(
        [
            "protoc",
            f"-I{PROTO_DIR}",
            f"-I{well_known}",
            f"--python_out={OUT_DIR}",
            f"--pyi_out={OUT_DIR}",
            f"--grpc_python_out={OUT_DIR}",
            str(PROTO_DIR / "quant.proto"),
        ]
    )
    if rc != 0:
        sys.exit(rc)

    # protoc emits top-level `import quant_pb2` — rewrite to package-absolute.
    grpc_module = OUT_DIR / "quant_pb2_grpc.py"
    grpc_module.write_text(
        re.sub(
            r"^import quant_pb2 as",
            "from app.proto_gen import quant_pb2 as",
            grpc_module.read_text(encoding="utf-8"),
            flags=re.MULTILINE,
        ),
        encoding="utf-8",
    )
    (OUT_DIR / "__init__.py").write_text(INIT_CONTENT, encoding="utf-8")
    print(f"generated stubs in {OUT_DIR}")


if __name__ == "__main__":
    main()
