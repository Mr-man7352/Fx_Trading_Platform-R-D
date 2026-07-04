#!/usr/bin/env bash
# QN-003/QN-004 — CI drift check: regenerate all codegen output and fail if it
# differs from what is committed. Run from services/quant with a synced venv;
# requires `pnpm --filter @fx/types build` to have run (schemas present).
set -euo pipefail
cd "$(dirname "$0")/.."

uv run python scripts/gen_contracts.py
uv run python scripts/gen_proto.py

if ! git diff --exit-code -- app/contracts app/proto_gen; then
  echo "::error::Generated code drifted — run scripts/gen_contracts.py + gen_proto.py and commit" >&2
  exit 1
fi
# Catch brand-new untracked generated files too.
untracked=$(git ls-files --others --exclude-standard -- app/contracts app/proto_gen)
if [[ -n "$untracked" ]]; then
  echo "::error::Untracked generated files: $untracked" >&2
  exit 1
fi
echo "codegen up to date"
