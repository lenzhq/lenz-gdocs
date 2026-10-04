#!/usr/bin/env bash
# Assemble one flavour of the add-on into dist/<flavour>/ (what clasp pushes). Details: scripts/build.js.
#   bash scripts/build.sh <internal|public> [--allow-placeholder]
set -euo pipefail
exec node "$(dirname "$0")/build.js" "$@"
