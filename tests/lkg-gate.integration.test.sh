#!/usr/bin/env bash
#
# Integration test for scripts/lkg-gate.sh main() flow, offline. Uses the
# CANONICAL_DIR/BLOCK_DIR injection seam to skip cloning and feeds a fixture
# ledger containing one healthy patch and one deliberately-obsolete patch
# (precondition gone, replacement already present). Asserts the gate goes red
# and emits the obsolete id — the signal the workflow's retirement-PR step keys
# off of.
#
# Run: bash tests/lkg-gate.integration.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE="$SCRIPT_DIR/scripts/lkg-gate.sh"

PASS=0
FAIL=0
assert_contains() {
    local haystack="$1" needle="$2" msg="$3"
    if printf '%s' "$haystack" | grep -qF "$needle"; then
        echo "  ok   - $msg"
        PASS=$((PASS + 1))
    else
        echo "  FAIL - $msg (missing '$needle' in: $haystack)"
        FAIL=$((FAIL + 1))
    fi
}
assert_eq() {
    if [[ "$1" == "$2" ]]; then echo "  ok   - $3"; PASS=$((PASS + 1));
    else echo "  FAIL - $3 (expected '$1', got '$2')"; FAIL=$((FAIL + 1)); fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- Fixture canonical clone (git repo so rev-parse works) -------------------
CANON="$TMP/canonical"
mkdir -p "$CANON/scripts"
git -C "$CANON" init -q
git -C "$CANON" config user.email t@t.t
git -C "$CANON" config user.name t
# Healthy target: still contains the precondition.
printf 'before\nconst HEALTHY = makeThing();\nafter\n' > "$CANON/scripts/healthy.js"
# Obsolete target: precondition is gone; the replacement is already present
# (as if the fix landed upstream verbatim).
printf 'before\nconst FIXED = makeThing("guarded");\nafter\n' > "$CANON/scripts/obsolete.js"
git -C "$CANON" add -A && git -C "$CANON" commit -qm base

# Block source can be empty for this test (no block-targeting patches).
BLOCKS="$TMP/blocks"; mkdir -p "$BLOCKS"

# --- Fixture patches-repo root with a ledger ---------------------------------
ROOT="$TMP/root"
mkdir -p "$ROOT/citisignal"
cat > "$ROOT/citisignal/code-patches.json" <<'JSON'
{
  "version": "1.0.0",
  "patches": [
    {
      "id": "healthy-patch",
      "target": "scripts/healthy.js",
      "description": "still applies",
      "precondition": "const HEALTHY = makeThing();",
      "replacement": "const HEALTHY = makeThing(\"guarded\");",
      "exit": "TODO",
      "critical": false
    },
    {
      "id": "obsolete-patch",
      "target": "scripts/obsolete.js",
      "description": "fix landed upstream",
      "precondition": "const FIXED = makeThing();",
      "replacement": "const FIXED = makeThing(\"guarded\");",
      "exit": "TODO",
      "critical": false
    }
  ]
}
JSON
# A previous LKG different from the fixture HEAD, to exercise changed=true.
echo "0000000000000000000000000000000000000000" > "$ROOT/last-known-good"

# --- Run the gate (cron-like: no event), capturing outputs -------------------
OUTFILE="$TMP/gh_output"
: > "$OUTFILE"
set +e
( cd "$ROOT" && CANONICAL_DIR="$CANON" BLOCK_DIR="$BLOCKS" GITHUB_OUTPUT="$OUTFILE" bash "$GATE" > "$TMP/stdout" 2> "$TMP/stderr" )
RC=$?
set -e

echo "# exit code"
assert_eq "1" "$RC" "gate exits non-zero when a patch is obsolete"

echo "# GITHUB_OUTPUT contents"
OUT="$(cat "$OUTFILE")"
assert_contains "$OUT" "all_ok=false" "all_ok is false"
assert_contains "$OUT" "changed=true" "changed is true (canonical moved vs prev LKG)"
assert_contains "$OUT" "obsolete=obsolete-patch" "obsolete id is emitted for the workflow"

echo "# stderr classification"
ERR="$(cat "$TMP/stderr")"
assert_contains "$ERR" "✓ healthy-patch" "healthy patch reported OK"
assert_contains "$ERR" "OBSOLETE: obsolete-patch" "obsolete patch flagged"

# --- A green night over a re-made commit: same files, new id ------------------
# The B2B template's sync re-makes its top commits nightly. The gate must not
# move the pointer (and so not publish a release) when only the id changed.
echo "# green run over a re-made commit"
CANON2="$TMP/canonical2"
mkdir -p "$CANON2/scripts"
git -C "$CANON2" init -q
git -C "$CANON2" config user.email t@t.t
git -C "$CANON2" config user.name t
printf 'before\nconst HEALTHY = makeThing();\nafter\n' > "$CANON2/scripts/healthy.js"
git -C "$CANON2" add -A && git -C "$CANON2" commit -qm base
POINTER="$(git -C "$CANON2" rev-parse HEAD)"
git -C "$CANON2" commit -q --allow-empty -m "nightly re-made commit"
ROOT2="$TMP/root2"
mkdir -p "$ROOT2/citisignal"
jq '.patches |= map(select(.id == "healthy-patch"))' "$ROOT/citisignal/code-patches.json" > "$ROOT2/citisignal/code-patches.json"
echo "$POINTER" > "$ROOT2/last-known-good"
OUTFILE2="$TMP/gh_output2"
: > "$OUTFILE2"
set +e
( cd "$ROOT2" && CANONICAL_DIR="$CANON2" BLOCK_DIR="$BLOCKS" GITHUB_OUTPUT="$OUTFILE2" WRITE_LKG=1 bash "$GATE" > "$TMP/stdout2" 2> "$TMP/stderr2" )
RC2=$?
set -e
assert_eq "0" "$RC2" "a green run exits zero"
assert_contains "$(cat "$OUTFILE2")" "changed=false" "the pointer has not moved: same files"
assert_eq "$POINTER" "$(tr -d '[:space:]' < "$ROOT2/last-known-good")" "the pointer file is left as it was"
assert_contains "$(cat "$TMP/stderr2")" "a re-made commit, not a change" "the log says why it did not advance"

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
