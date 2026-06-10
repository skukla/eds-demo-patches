#!/usr/bin/env bash
#
# Unit tests for scripts/lkg-gate.sh. Sources the script (guarded so main()
# does not run) and exercises the pure classification functions plus the
# touched-file enumeration mechanism. No network; everything uses fixtures.
#
# Run: bash tests/lkg-gate.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../scripts/lkg-gate.sh
source "$SCRIPT_DIR/scripts/lkg-gate.sh"

PASS=0
FAIL=0

assert_eq() {
    local expected="$1" actual="$2" msg="$3"
    if [[ "$expected" == "$actual" ]]; then
        echo "  ok   - $msg"
        PASS=$((PASS + 1))
    else
        echo "  FAIL - $msg (expected '$expected', got '$actual')"
        FAIL=$((FAIL + 1))
    fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---- Fixtures ---------------------------------------------------------------
# A precondition that spans multiple lines, like the real commerce.js anchors.
PRECOND=$'function getSkuFromUrl() {\n  const path = window.location.pathname;\n  return result?.[1];\n}'
REPLACEMENT=$'function getSkuFromUrl() {\n  const path = window.location.pathname;\n  return result?.[1] ? result[1].replace(/__/g, "/") : null;\n}'

# File where the precondition is present exactly once.
printf 'header\n%s\nfooter\n' "$PRECOND" > "$TMP/present.js"
# File where the precondition appears twice (ambiguous first-match).
printf '%s\n----\n%s\n' "$PRECOND" "$PRECOND" > "$TMP/twice.js"
# File where the precondition is gone but the replacement is present (obsolete).
printf 'header\n%s\nfooter\n' "$REPLACEMENT" > "$TMP/obsolete.js"
# File where neither precondition nor replacement is present (fixed differently).
printf 'totally different content\nfunction other() {}\n' > "$TMP/different.js"

echo "# count_occurrences"
assert_eq "1" "$(count_occurrences "$TMP/present.js" "$PRECOND")" "multi-line needle counted once"
assert_eq "2" "$(count_occurrences "$TMP/twice.js" "$PRECOND")" "multi-line needle counted twice"
assert_eq "0" "$(count_occurrences "$TMP/different.js" "$PRECOND")" "absent needle counts zero"

echo "# classify_patch"
assert_eq "OK" "$(classify_patch "$TMP/present.js" "$PRECOND" "$REPLACEMENT")" "precondition present once -> OK"
assert_eq "MULTI_MATCH" "$(classify_patch "$TMP/twice.js" "$PRECOND" "$REPLACEMENT")" "precondition present twice -> MULTI_MATCH"
assert_eq "OBSOLETE" "$(classify_patch "$TMP/obsolete.js" "$PRECOND" "$REPLACEMENT")" "obsolete true-positive (replacement present) -> OBSOLETE"
assert_eq "FIXED_DIFFERENTLY" "$(classify_patch "$TMP/different.js" "$PRECOND" "$REPLACEMENT")" "obsolete true-negative (replacement absent) -> FIXED_DIFFERENTLY"
assert_eq "MISSING" "$(classify_patch "" "$PRECOND" "$REPLACEMENT")" "empty target -> MISSING"
assert_eq "MISSING" "$(classify_patch "$TMP/does-not-exist.js" "$PRECOND" "$REPLACEMENT")" "nonexistent target -> MISSING"

echo "# resolve_target"
mkdir -p "$TMP/canon/scripts" "$TMP/blocks/blocks/product-teaser"
echo "x" > "$TMP/canon/scripts/commerce.js"
echo "y" > "$TMP/blocks/blocks/product-teaser/product-teaser.js"
CANONICAL_DIR="$TMP/canon"
BLOCK_DIR="$TMP/blocks"
assert_eq "$TMP/canon/scripts/commerce.js" "$(resolve_target "scripts/commerce.js")" "canonical file resolves to canonical clone"
assert_eq "$TMP/blocks/blocks/product-teaser/product-teaser.js" "$(resolve_target "blocks/product-teaser/product-teaser.js")" "block-only file resolves to block source"
assert_eq "" "$(resolve_target "scripts/nonexistent.js")" "missing file resolves to empty"

echo "# touched-file enumeration (git log -- paths)"
REPO="$TMP/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email t@t.t
git -C "$REPO" config user.name t
mkdir -p "$REPO/scripts" "$REPO/untouched"
echo "v1" > "$REPO/scripts/commerce.js"
echo "static" > "$REPO/untouched/other.js"
git -C "$REPO" add -A && git -C "$REPO" commit -qm "base"
BASE_SHA="$(git -C "$REPO" rev-parse HEAD)"
echo "v2" > "$REPO/scripts/commerce.js"
git -C "$REPO" add -A && git -C "$REPO" commit -qm "touch commerce.js"
touched="$(git -C "$REPO" log --oneline "${BASE_SHA}..HEAD" -- scripts/commerce.js | wc -l | tr -d ' ')"
assert_eq "1" "$touched" "one commit since base touched the patched file"
untouched="$(git -C "$REPO" log --oneline "${BASE_SHA}..HEAD" -- untouched/other.js | wc -l | tr -d ' ')"
assert_eq "0" "$untouched" "no commits since base touched the unpatched file"

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
