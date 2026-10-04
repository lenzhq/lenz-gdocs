#!/usr/bin/env bash
# This repository is public. Lists internal references that must not be in the tree: personal
# names, local paths, working-session notes. Literal internal ids are not listed here (that would
# publish them): CHECK_PUBLIC_EXTRA names a file outside the repo with one more extended regex
# (Lenz keeps one with its internal project's ids). Exit 0 = nothing found. CI runs it
# (.github/workflows/test.yml).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
pattern='kosta|pavel|\.claude|session [0-9]|session gdocs|coordinator|addon-plan|lenz-prod|lenz-gdocs-private|/Users/|~/Lenz|\.env\.prod|internal account|lenz\.io accounts only|discord|hubspot'
if [ -n "${CHECK_PUBLIC_EXTRA:-}" ]; then
  extra=$(tr -d '\n' < "$CHECK_PUBLIC_EXTRA")
  if [ -n "$extra" ]; then pattern="$pattern|$extra"; fi
fi
hits=$(git grep -n -I -i -E "$pattern" -- . ':!scripts/check-public.sh' || true)
if [ -n "$hits" ]; then
  echo "$hits"
  echo
  echo "check-public: $(echo "$hits" | wc -l | tr -d ' ') line(s) to fix"
  exit 1
fi
echo "check-public: clean"
