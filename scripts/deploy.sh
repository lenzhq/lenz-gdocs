#!/usr/bin/env bash
# Build one flavour, push it, cut a version, and point that flavour's one deployment at it.
#   bash scripts/deploy.sh [internal|public]      (default: internal)
# Each flavour has its own Apps Script project (gitignored files):
#   internal  .clasp.json         + .deploy-id          rootDir dist/internal
#   public    .clasp.public.json  + .deploy-id.public   rootDir dist/public
# Refuses a dirty tree, a branch other than main, or a main that is not origin/main.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
die() { echo "deploy: $*" >&2; exit 1; }

[ $# -le 1 ] || die "usage: scripts/deploy.sh [internal|public]"
FLAVOUR=${1:-internal}
case "$FLAVOUR" in
  internal) PROJECT=.clasp.json; DEPLOY_ID_FILE=.deploy-id ;;
  public) PROJECT=.clasp.public.json; DEPLOY_ID_FILE=.deploy-id.public ;;
  *) die "unknown flavour '$FLAVOUR' (internal or public)." ;;
esac
DIST=dist/$FLAVOUR

[ -e "$PROJECT" ] || die "no $PROJECT; run scripts/clasp-create.sh $FLAVOUR first."
if [ ! -e "config/flavours/$FLAVOUR.json" ]; then
  if [ -e "config/flavours/$FLAVOUR.example.json" ]; then
    die "no config/flavours/$FLAVOUR.json to build from (it is not in git): copy config/flavours/$FLAVOUR.example.json to it and fill in your own values (docs/deploy.md)."
  fi
  die "no config/flavours/$FLAVOUR.json to build from."
fi
[ -z "$(git status --porcelain)" ] || die "the working tree has changes; commit or remove them first."
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "main" ] || die "on '$BRANCH'; deploy from main."
git fetch -q origin main || die "could not fetch origin/main."
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main is not origin/main; pull or push first."

# clasp pushes the build, never src/. A .clasp.json made before the flavours points at src: moved once.
ROOT_DIR=$(node -p 'require(process.argv[1]).rootDir || ""' "$ROOT/$PROJECT")
if [ "$FLAVOUR" = internal ] && [ "$ROOT_DIR" = src ]; then
  node -e 'const fs=require("fs");const f=process.argv[1];const c=JSON.parse(fs.readFileSync(f,"utf8"));c.rootDir=process.argv[2];fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n")' \
    "$ROOT/$PROJECT" "$DIST"
  echo "deploy: $PROJECT rootDir src -> $DIST (clasp pushes the build now)." >&2
  ROOT_DIR=$DIST
fi
[ "$ROOT_DIR" = "$DIST" ] || [ "$ROOT_DIR" = "$ROOT/$DIST" ] || die "$PROJECT has rootDir '$ROOT_DIR', expected $DIST."

SHA=$(git rev-parse --short HEAD)
SUBJECT=$(git log -1 --format=%s)
DESCRIPTION="$SHA $SUBJECT"

npm test || die "npm test failed."
# Never --allow-placeholder: a flavour without its own Lenz OAuth client does not ship.
bash scripts/build.sh "$FLAVOUR" || die "the $FLAVOUR build failed."

# Only the build's top-level .js, .html and appsscript.json may ship (.claspignore); check what clasp sees.
json_field() { node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const v=JSON.parse(s)[process.argv[1]];process.stdout.write(v===undefined||v===null?"":(Array.isArray(v)?v.join("\n"):String(v)))})' "$1"; }
FILES=$(clasp --json -P "$PROJECT" show-file-status | json_field filesToPush) || die "clasp show-file-status failed."
[ -n "$FILES" ] || die "clasp lists no files to push."
BAD=$(printf '%s\n' "$FILES" | grep -Ev "^$DIST/([A-Za-z0-9_.-]+\.(js|html)|appsscript\.json)\$" || true)
[ -z "$BAD" ] || die "clasp would push files that must not ship:
$BAD"
for f in appsscript.json config.js; do
  printf '%s\n' "$FILES" | grep -qx "$DIST/$f" || die "clasp would not push $DIST/$f."
done
# The files the flavour leaves out (the public build: the dev harness) must not be there.
OMITTED=$(node -p 'require(process.argv[1]).omitFiles.join("\n")' "$ROOT/config/flavours/$FLAVOUR.json")
for f in $OMITTED; do
  if printf '%s\n' "$FILES" | grep -qx "$DIST/$f"; then die "clasp would push $DIST/$f, which the $FLAVOUR flavour leaves out."; fi
done
echo "Pushing ($FLAVOUR):"; printf '  %s\n' $FILES

clasp -P "$PROJECT" push --force

VERSION=$(clasp --json -P "$PROJECT" create-version "$DESCRIPTION" | json_field versionNumber) || die "clasp create-version failed."
[[ "$VERSION" =~ ^[0-9]+$ ]] || die "could not read the version number from clasp."

if [ -s "$DEPLOY_ID_FILE" ]; then
  DEPLOYMENT_ID=$(tr -d '[:space:]' < "$DEPLOY_ID_FILE")
  clasp --json -P "$PROJECT" update-deployment "$DEPLOYMENT_ID" --versionNumber "$VERSION" --description "$DESCRIPTION" >/dev/null \
    || die "clasp update-deployment $DEPLOYMENT_ID failed."
else
  DEPLOYMENT_ID=$(clasp --json -P "$PROJECT" create-deployment --versionNumber "$VERSION" --description "$DESCRIPTION" \
    | json_field deploymentId) || die "clasp create-deployment failed."
  [ -n "$DEPLOYMENT_ID" ] || die "could not read the deployment id from clasp."
  printf '%s\n' "$DEPLOYMENT_ID" > "$DEPLOY_ID_FILE"
fi

echo
echo "Flavour:        $FLAVOUR"
echo "Script ID:      $(node -p 'require(process.argv[1]).scriptId' "$ROOT/$PROJECT")"
echo "Version:        $VERSION ($DESCRIPTION)"
echo "Deployment ID:  $DEPLOYMENT_ID"
