#!/usr/bin/env bash
# Refresh the `deploy-web` branch (what the Render frontend service builds) from the latest main - frontend only.
#
#   scripts/update_deploy_web.sh              # fetch origin/main, commit the frontend files to `deploy-web`, push it
#   scripts/update_deploy_web.sh --dry-run    # show what would be committed, change nothing
#   scripts/update_deploy_web.sh --no-push    # commit locally only (e.g. to test a fresh clone first)
#   scripts/update_deploy_web.sh --from=<ref> # use another source ref instead of origin/main
#
# `deploy-web` holds only web/Dockerfile, web/.dockerignore and web/PlanetX/ (no bin/obj). It never contains cache/,
# cache_large/, static_export/, api/, science/, tests or FITS files, so Render's clone is tiny.
#
# The tree is built from git objects only: your working directory, your current branch and main are never touched.
# The first run creates an orphan branch; later runs add a commit on top (a fast-forward push, never a force-push).
# A main commit that changes no frontend file gives an identical tree, and the script does nothing.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

SRC=origin/main; DRY=0; PUSH=1; BRANCH=deploy-web
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --no-push) PUSH=0 ;;
    --from=*) SRC="${arg#--from=}" ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

echo "Fetching origin..."
git fetch -q origin main
HAVE_REMOTE=0
if git ls-remote --exit-code -q origin "refs/heads/$BRANCH" >/dev/null 2>&1; then
  git fetch -q origin "$BRANCH"; HAVE_REMOTE=1
fi

if [ "$SRC" = "origin/main" ] && git rev-parse -q --verify refs/heads/main >/dev/null; then
  ahead=$(git rev-list --count origin/main..main)
  [ "$ahead" -gt 0 ] && echo "NOTE: local main has $ahead commit(s) not pushed to origin/main - they are NOT included. Push main first if you want them deployed."
fi
SRC_SHA=$(git rev-parse --verify "$SRC^{commit}")

# --- the whitelist of paths that go into the deploy-web branch --------------------------------------
INCLUDE='^web/(Dockerfile|[.]dockerignore)$|^web/PlanetX/'
EXCLUDE='^web/PlanetX/(bin|obj)/'

# --- build the tree in a throw-away index (the real index and working tree are not used) -------------
TMP_INDEX=$(mktemp -u)
trap 'rm -f "$TMP_INDEX"' EXIT
export GIT_INDEX_FILE="$TMP_INDEX"
git ls-tree -r "$SRC_SHA" | awk -F'\t' -v inc="$INCLUDE" -v exc="$EXCLUDE" '$2 ~ inc && $2 !~ exc' | git update-index --index-info
NOTE=$(printf '%s\n' \
  '# deploy-web branch (auto-generated)' '' \
  'Frontend files only (web/PlanetX + web/Dockerfile), for the Render frontend Docker service.' \
  'Do not edit here: change main, then run `scripts/update_deploy_web.sh`.' '' \
  'The main commit each deploy came from is in the commit message, not in any file, so a main commit that changes' \
  'no frontend file leaves this tree identical and the script does nothing (no needless Render rebuild).' | git hash-object -w --stdin)
printf '100644 blob %s\tDEPLOY_BRANCH.md\n' "$NOTE" | git update-index --index-info

# --- safety checks ------------------------------------------------------------------------------------
FILES=$(git ls-files)
BAD='^(cache|cache_large|static_export|api|science|tests|scripts)/|^web/tests/|/(bin|obj)/|[.](fits|fits[.]gz|fz)$'
if echo "$FILES" | grep -qE "$BAD"; then
  echo "ABORT: the deploy-web tree would contain backend data, tests, build output or FITS files:" >&2
  echo "$FILES" | grep -E "$BAD" | head >&2; exit 1
fi
for need in web/Dockerfile web/.dockerignore web/PlanetX/PlanetX.csproj web/PlanetX/Program.cs \
            web/PlanetX/wwwroot/js/space.js web/PlanetX/wwwroot/audio/voice/voice.json; do
  echo "$FILES" | grep -qx "$need" || { echo "ABORT: $need is missing from the deploy-web tree" >&2; exit 1; }
done
TREE=$(git write-tree)
unset GIT_INDEX_FILE
N=$(echo "$FILES" | wc -l)
BYTES=$(git ls-tree -r -l "$TREE" | awk '{s+=$4} END{print s}')
echo "deploy-web tree: $N files, $((BYTES / 1024)) KiB (source main@${SRC_SHA:0:9})"

# --- parent: the previous deploy-web tip (so pushes are plain fast-forwards) ---------------------------
PARENT=""
if [ "$HAVE_REMOTE" = 1 ]; then
  PARENT=$(git rev-parse "origin/$BRANCH")
elif git rev-parse -q --verify "refs/heads/$BRANCH" >/dev/null; then
  PARENT=$(git rev-parse "refs/heads/$BRANCH")
fi
if [ -n "$PARENT" ] && [ "$(git rev-parse "$PARENT^{tree}")" = "$TREE" ]; then
  echo "$BRANCH is already up to date - nothing to do."; exit 0
fi

if [ "$DRY" = 1 ]; then
  echo "--dry-run: would commit these paths:"; echo "$FILES" | cut -d/ -f1-3 | sort | uniq -c
  exit 0
fi

MSG="Deploy frontend from main@${SRC_SHA:0:9}"
[ -n "${DEPLOY_TRAILER:-}" ] && MSG="$MSG"$'\n\n'"$DEPLOY_TRAILER"
if [ -n "$PARENT" ]; then COMMIT=$(git commit-tree "$TREE" -p "$PARENT" -m "$MSG"); else COMMIT=$(git commit-tree "$TREE" -m "$MSG"); fi
git update-ref "refs/heads/$BRANCH" "$COMMIT"
echo "Committed ${COMMIT:0:9} on branch $BRANCH$([ -z "$PARENT" ] && echo ' (new root commit, no history)')"

if [ "$PUSH" = 1 ]; then
  git push origin "$BRANCH"     # fast-forward only; never forced
  echo "Done. Render redeploys the frontend automatically if it is pointed at $BRANCH."
else
  echo "--no-push: $BRANCH updated locally only."
fi
