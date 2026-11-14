#!/usr/bin/env bash
# Refresh the `deploy` branch (what Render builds) from the latest main - backend files only.
#
#   scripts/update_deploy.sh              # fetch origin/main, commit the backend files to `deploy`, push it
#   scripts/update_deploy.sh --dry-run    # show what would be committed, change nothing
#   scripts/update_deploy.sh --squash     # restart `deploy` history as ONE commit (force-pushes ONLY `deploy`)
#   scripts/update_deploy.sh --from=<ref> # use another source ref instead of origin/main
#
# `deploy` holds only what the Docker image needs: Dockerfile, .dockerignore, requirements.txt, render.yaml,
# api/ (code + spectral_channels.json), science/ (the three .py files) and static_export/. It never contains
# cache/, cache_large/, tests, scripts or the frontend, so Render's clone is small and fast.
#
# The tree is built from git objects only: your working directory, your current branch and main are never touched.
# Normal runs add a commit on top of the previous `deploy` (a fast-forward push, never a force-push).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

SRC=origin/main; DRY=0; SQUASH=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --squash) SQUASH=1 ;;
    --from=*) SRC="${arg#--from=}" ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

echo "Fetching origin..."
git fetch -q origin main
HAVE_REMOTE_DEPLOY=0
if git fetch -q origin deploy 2>/dev/null; then HAVE_REMOTE_DEPLOY=1; fi

if [ "$SRC" = "origin/main" ] && git rev-parse -q --verify refs/heads/main >/dev/null; then
  ahead=$(git rev-list --count origin/main..main)
  [ "$ahead" -gt 0 ] && echo "NOTE: local main has $ahead commit(s) not pushed to origin/main - they are NOT included. Push main first if you want them deployed."
fi
SRC_SHA=$(git rev-parse --verify "$SRC^{commit}")

# --- the whitelist of paths that go into the deploy branch ------------------------------------------
INCLUDE='^(Dockerfile|[.]dockerignore|requirements[.]txt|render[.]yaml)$|^api/[^/]+[.](py|json)$|^science/[^/]+[.]py$|^static_export/'
EXCLUDE='^api/sample_frames'

# --- build the tree in a throw-away index (the real index and working tree are not used) -------------
TMP_INDEX=$(mktemp -u)
trap 'rm -f "$TMP_INDEX"' EXIT
export GIT_INDEX_FILE="$TMP_INDEX"
git ls-tree -r "$SRC_SHA" | awk -F'\t' -v inc="$INCLUDE" -v exc="$EXCLUDE" '$2 ~ inc && $2 !~ exc' | git update-index --index-info
NOTE=$(printf '%s\n' \
  '# deploy branch (auto-generated)' '' \
  'Backend files only, for the Render Docker build. Do not edit here: change main, then run `scripts/update_deploy.sh`.' '' \
  '(The main commit each deploy came from is in the commit message. It is NOT written into any file, so a main commit that' \
  'changes no backend file leaves this tree identical and the script does nothing - no needless Render rebuild.)' | git hash-object -w --stdin)
printf '100644 blob %s\tDEPLOY_BRANCH.md\n' "$NOTE" | git update-index --index-info

# --- safety checks ------------------------------------------------------------------------------------
FILES=$(git ls-files)
if echo "$FILES" | grep -qE '^(cache|cache_large|web|tests|scripts)/|\.fits$'; then
  echo "ABORT: the deploy tree would contain cache/, cache_large/, web/, tests/, scripts/ or FITS files:" >&2
  echo "$FILES" | grep -E '^(cache|cache_large|web|tests|scripts)/|\.fits$' | head >&2; exit 1
fi
for need in Dockerfile requirements.txt render.yaml api/main.py science/pipeline.py static_export/barnards-star/frames.json; do
  echo "$FILES" | grep -qx "$need" || { echo "ABORT: $need is missing from the deploy tree" >&2; exit 1; }
done
TREE=$(git write-tree)
unset GIT_INDEX_FILE
N=$(echo "$FILES" | wc -l)
BYTES=$(git ls-tree -r -l "$TREE" | awk '{s+=$4} END{print s}')
echo "Deploy tree: $N files, $((BYTES / 1048576)) MiB (source main@${SRC_SHA:0:9})"

# --- parent: the previous deploy tip (so pushes are plain fast-forwards) -------------------------------
PARENT=""
if [ "$HAVE_REMOTE_DEPLOY" = 1 ] && [ "$SQUASH" = 0 ]; then
  PARENT=$(git rev-parse origin/deploy)
  if [ "$(git rev-parse "$PARENT^{tree}")" = "$TREE" ]; then echo "deploy is already up to date - nothing to do."; exit 0; fi
fi

if [ "$DRY" = 1 ]; then
  echo "--dry-run: would commit these paths (top level):"; echo "$FILES" | cut -d/ -f1 | sort | uniq -c
  exit 0
fi

MSG="Deploy backend from main@${SRC_SHA:0:9}"
[ -n "${DEPLOY_TRAILER:-}" ] && MSG="$MSG"$'\n\n'"$DEPLOY_TRAILER"
if [ -n "$PARENT" ]; then COMMIT=$(git commit-tree "$TREE" -p "$PARENT" -m "$MSG"); else COMMIT=$(git commit-tree "$TREE" -m "$MSG"); fi
git update-ref refs/heads/deploy "$COMMIT"
echo "Committed ${COMMIT:0:9} on branch deploy$([ -z "$PARENT" ] && echo ' (new root commit, no history)')"

if [ "$SQUASH" = 1 ] && [ "$HAVE_REMOTE_DEPLOY" = 1 ]; then
  echo "Force-pushing ONLY the deploy branch (--squash)..."
  git push --force-with-lease=deploy:"$(git rev-parse origin/deploy)" origin deploy
else
  git push origin deploy
fi
echo "Done. Render redeploys automatically if it is pointed at the deploy branch."
