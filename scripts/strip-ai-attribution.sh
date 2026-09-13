#!/usr/bin/env bash
#
# Remove `Co-Authored-By: Claude …` trailers from every commit in this
# repository, so GitHub credits the author and nobody else.
#
# This rewrites history: every commit gets a new hash. That is safe here and
# was checked before writing this — the repository has no forks and no other
# collaborators — but it does mean the rewritten commits have to be force
# pushed, and anyone holding an old clone would have to re-fetch.
#
# It touches messages only. The verification at the end proves that: the file
# tree at the tip and every author line must come out identical.
#
# Run it from anywhere in the repository, then follow the push instructions it
# prints. It does not push anything itself.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty. Commit or stash first — a rewrite is hard to" >&2
  echo "reason about with uncommitted changes in the way." >&2
  exit 1
fi

# Only local branches and tags. `--all` would be wrong here: after the rewrite
# it also walks the refs/original/ backups and the stale remote-tracking refs,
# so every "before" number would be compared against itself plus the old
# history, and all three checks would report a failure that had not happened.
branches() { git for-each-ref --format='%(refname)' refs/heads refs/tags; }

before_tree="$(git rev-parse HEAD^{tree})"
before_authors="$(git log $(branches) --format='%an <%ae> %s' | sort)"
before_count="$(git rev-list --count $(branches))"

filter="$(mktemp)"
trap 'rm -f "$filter"' EXIT
cat > "$filter" <<'PY'
import sys

message = sys.stdin.read()
kept = [
    line
    for line in message.split("\n")
    if not line.startswith("Co-Authored-By: Claude")
]
# rstrip so removing the trailer does not leave the message ending in blanks.
sys.stdout.write("\n".join(kept).rstrip() + "\n")
PY

echo "Rewriting $before_count commit(s)…"
# --tag-name-filter cat carries the release tags onto the rewritten commits;
# without it v0.1.0 and v0.1.1 would still point at the old, orphaned ones.
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f \
  --tag-name-filter cat \
  --msg-filter "python3 $filter" \
  -- --all

echo
echo "Verifying…"

remaining="$(git log $(branches) --format='%B' | grep -c '^Co-Authored-By: Claude' || true)"
after_tree="$(git rev-parse HEAD^{tree})"
after_authors="$(git log $(branches) --format='%an <%ae> %s' | sort)"
after_count="$(git rev-list --count $(branches))"

fail=0
[[ "$remaining" == "0" ]] || { echo "  ✗ $remaining trailer(s) still present" >&2; fail=1; }
[[ "$after_tree" == "$before_tree" ]] || { echo "  ✗ the file tree changed" >&2; fail=1; }
[[ "$after_authors" == "$before_authors" ]] || { echo "  ✗ an author line changed" >&2; fail=1; }
[[ "$after_count" == "$before_count" ]] || { echo "  ✗ commit count changed" >&2; fail=1; }

if [[ "$fail" == 1 ]]; then
  echo >&2
  echo "Nothing has been pushed. To undo:  git reset --hard refs/original/refs/heads/main" >&2
  exit 1
fi

echo "  ✓ no attribution trailers remain"
echo "  ✓ the file tree is byte-for-byte identical"
echo "  ✓ every author line is unchanged"
echo "  ✓ still $after_count commits"
echo
echo "Nothing has been pushed. When you are ready:"
echo
# The fetch is not optional. filter-branch rewrites refs/remotes/origin/* too,
# so git now believes the remote already holds the new history; --force-with-lease
# compares against that belief and would refuse the push as stale. Fetching puts
# the true remote position back, which is also what makes the lease meaningful.
echo "  git fetch origin"
echo "  git push --force-with-lease origin main"
echo "  git push --force origin v0.1.0 v0.1.1"
echo
echo "The originals are kept under refs/original/ until you expire them."
