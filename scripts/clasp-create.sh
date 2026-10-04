#!/usr/bin/env bash
# Create one flavour's standalone Apps Script project and write its project file (gitignored).
#   bash scripts/clasp-create.sh [internal|public]      (default: internal)
#   internal  .clasp.json         title "Lenz Fact-Checking (dev)"
#   public    .clasp.public.json  title "Lenz Fact-Checking"
# (titles from config/flavours/<flavour>.json; LENZ_SCRIPT_TITLE overrides). The project file's
# rootDir is dist/<flavour>, what scripts/build.sh writes. Run once per flavour, after `clasp login`
# (docs/deploy.md, "Sign clasp in"). Refuses if the flavour's project file exists.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
die() { echo "clasp-create: $*" >&2; exit 1; }

[ $# -le 1 ] || die "usage: scripts/clasp-create.sh [internal|public]"
FLAVOUR=${1:-internal}
case "$FLAVOUR" in
  internal) PROJECT=.clasp.json ;;
  public) PROJECT=.clasp.public.json ;;
  *) die "unknown flavour '$FLAVOUR' (internal or public)." ;;
esac
if [ -z "${LENZ_SCRIPT_TITLE:-}" ] && [ ! -e "$ROOT/config/flavours/$FLAVOUR.json" ]; then
  die "no config/flavours/$FLAVOUR.json (it is not in git): copy config/flavours/$FLAVOUR.example.json to it and fill in your own values (docs/deploy.md)."
fi
TITLE=${LENZ_SCRIPT_TITLE:-$(node -p 'require(process.argv[1]).scriptTitle' "$ROOT/config/flavours/$FLAVOUR.json")}

[ ! -e "$PROJECT" ] || die "$PROJECT already exists (script $(node -p 'require(process.argv[1]).scriptId' "$ROOT/$PROJECT")); nothing to do."

# clasp 3.4.1 writes .clasp.json in its project root and pulls the new project's default files
# (manifest, Code.gs) into it. It runs in an empty scratch directory, so neither touches the repo:
# `-P .` stops it finding the repo's .clasp.json upwards (and, with no project file there, it does not
# check one exists, so it would overwrite one). The repo gets only the project file, written here.
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
(cd "$STAGE" && clasp --json -P . create-script --type standalone --title "$TITLE") >/dev/null || die "clasp create-script failed."
[ -e "$STAGE/.clasp.json" ] || die "clasp finished but wrote no project file."

node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!c.scriptId)process.exit(1);c.rootDir=process.argv[3];fs.writeFileSync(process.argv[2],JSON.stringify(c,null,2)+"\n")' \
  "$STAGE/.clasp.json" "$ROOT/$PROJECT" "dist/$FLAVOUR" || die "clasp's project file has no scriptId."
SCRIPT_ID=$(node -p 'require(process.argv[1]).scriptId' "$ROOT/$PROJECT")
echo "Flavour:    $FLAVOUR ($PROJECT, rootDir dist/$FLAVOUR)"
echo "Script ID:  $SCRIPT_ID"
echo "Script URL: https://script.google.com/d/$SCRIPT_ID/edit"
