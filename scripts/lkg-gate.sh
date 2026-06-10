#!/usr/bin/env bash
#
# lkg-gate.sh — last-known-good drift gate for the eds-demo-patches ledger.
#
# Verifies every patch in every */code-patches.json against the canonical
# boilerplate (and the demo-team block source for block-targeting patches),
# then on all-green prints the verified canonical SHA to stdout. The caller
# (the GitHub Actions workflow) writes that SHA into `last-known-good`.
#
# Behavior (ADR-006 §"Tracking canonical via a last-known-good gate"):
#   - precondition matches uniquely         -> OK
#   - precondition gone, replacement present -> OBSOLETE (fix landed upstream;
#                                               workflow opens a retirement PR)
#   - precondition gone, replacement absent  -> FIXED_DIFFERENTLY (human triage)
#   - precondition matches >1 time           -> MULTI_MATCH (unsafe first-match;
#                                               fail so the anchor is tightened)
#   - target absent in both clones           -> MISSING
#   - all OK + canonical moved               -> stdout = canonical SHA, exit 0
#   - any non-OK                             -> exit 1, LKG pointer stops advancing
#
# Machine-readable outputs (for the workflow), when GITHUB_OUTPUT is set:
#   sha=<canonical-sha>            always
#   changed=true|false            canonical SHA differs from current last-known-good
#   all_ok=true|false             every patch verified OK
#   obsolete=<id> <id> ...        space-separated ids whose fix landed upstream
#
# The pure functions below (count_occurrences, classify_patch, resolve_target)
# are sourced by tests/lkg-gate.test.sh without running main().

set -euo pipefail

CANONICAL_URL="${CANONICAL_URL:-https://github.com/hlxsites/aem-boilerplate-commerce.git}"
CANONICAL_BRANCH="${CANONICAL_BRANCH:-main}"
BLOCK_SOURCE_URL="${BLOCK_SOURCE_URL:-https://github.com/demo-system-stores/accs-citisignal.git}"
BLOCK_SOURCE_BRANCH="${BLOCK_SOURCE_BRANCH:-main}"
LKG_FILE="${LKG_FILE:-last-known-good}"

# Directories holding the checked-out source trees. main() sets these to the
# clones; tests set them to fixtures.
CANONICAL_DIR="${CANONICAL_DIR:-}"
BLOCK_DIR="${BLOCK_DIR:-}"

# count_occurrences <file> <needle> — count non-overlapping occurrences of a
# (possibly multi-line) needle in a file. Uses jq's string `indices`, which
# handles arbitrary content without shell/regex interpretation.
count_occurrences() {
    local file="$1" needle="$2"
    jq -rn --rawfile f "$file" --arg n "$needle" '$f | indices($n) | length'
}

# resolve_target <repo-relative-path> — echo the absolute path to the target in
# whichever clone contains it (canonical first, then the block source). Empty
# if neither has it. This is how block-targeting patches (e.g. the demo-team
# product-teaser, absent from canonical) get verified against the right tree.
resolve_target() {
    local rel="$1"
    if [[ -n "$CANONICAL_DIR" && -f "$CANONICAL_DIR/$rel" ]]; then
        printf '%s\n' "$CANONICAL_DIR/$rel"
    elif [[ -n "$BLOCK_DIR" && -f "$BLOCK_DIR/$rel" ]]; then
        printf '%s\n' "$BLOCK_DIR/$rel"
    else
        printf '\n'
    fi
}

# classify_patch <file> <precondition> <replacement> — the core decision. Echo
# one of: OK | OBSOLETE | FIXED_DIFFERENTLY | MULTI_MATCH | MISSING.
classify_patch() {
    local file="$1" precond="$2" replacement="$3"
    if [[ -z "$file" || ! -f "$file" ]]; then
        printf 'MISSING\n'
        return
    fi
    local pc
    pc=$(count_occurrences "$file" "$precond")
    if [[ "$pc" -gt 1 ]]; then
        printf 'MULTI_MATCH\n'
    elif [[ "$pc" -eq 1 ]]; then
        printf 'OK\n'
    else
        local rc
        rc=$(count_occurrences "$file" "$replacement")
        if [[ "$rc" -ge 1 ]]; then
            printf 'OBSOLETE\n'
        else
            printf 'FIXED_DIFFERENTLY\n'
        fi
    fi
}

# emit_output <key> <value> — append a key=value line to GITHUB_OUTPUT if set.
emit_output() {
    [[ -n "${GITHUB_OUTPUT:-}" ]] && printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
    return 0
}

main() {
    local workdir
    workdir="$(mktemp -d)"
    trap 'rm -rf "$workdir"' EXIT

    # Injection seam: if CANONICAL_DIR/BLOCK_DIR are pre-set (tests, or a local
    # run against existing clones), skip the network clone and use them as-is.
    if [[ -z "$CANONICAL_DIR" ]]; then
        echo "[lkg-gate] Cloning canonical ($CANONICAL_BRANCH) + block source ($BLOCK_SOURCE_BRANCH)..." >&2
        # blob:none keeps full commit+tree history (for the touched-file FYI)
        # while only fetching HEAD's blobs — the working tree we read against.
        git clone --quiet --filter=blob:none --branch "$CANONICAL_BRANCH" "$CANONICAL_URL" "$workdir/canonical"
        git clone --quiet --depth 1 --branch "$BLOCK_SOURCE_BRANCH" "$BLOCK_SOURCE_URL" "$workdir/blocks"
        CANONICAL_DIR="$workdir/canonical"
        BLOCK_DIR="$workdir/blocks"
    else
        echo "[lkg-gate] Using pre-set CANONICAL_DIR=$CANONICAL_DIR BLOCK_DIR=$BLOCK_DIR" >&2
    fi

    local canonical_sha prev_lkg
    canonical_sha="$(git -C "$CANONICAL_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
    prev_lkg="$([[ -f "$LKG_FILE" ]] && tr -d '[:space:]' < "$LKG_FILE" || true)"

    local all_ok=1
    local -a obsolete_ids=()
    local -a touched_targets=()

    local ledger
    for ledger in ./*/code-patches.json; do
        [[ -e "$ledger" ]] || continue
        echo "[lkg-gate] Verifying $ledger" >&2
        local count
        count="$(jq '.patches | length' "$ledger")"
        local i
        for ((i = 0; i < count; i++)); do
            local id target precond replacement file status
            id="$(jq -r ".patches[$i].id" "$ledger")"
            target="$(jq -r ".patches[$i].target" "$ledger")"
            precond="$(jq -r ".patches[$i].precondition" "$ledger")"
            replacement="$(jq -r ".patches[$i].replacement" "$ledger")"
            file="$(resolve_target "$target")"
            status="$(classify_patch "$file" "$precond" "$replacement")"
            touched_targets+=("$target")
            case "$status" in
                OK)
                    echo "  ✓ $id ($target)" >&2
                    ;;
                OBSOLETE)
                    echo "  ⚠ OBSOLETE: $id — replacement already present in $target; fix appears to have landed upstream. Retirement PR candidate." >&2
                    obsolete_ids+=("$id")
                    all_ok=0
                    ;;
                FIXED_DIFFERENTLY)
                    echo "  ✗ FIXED_DIFFERENTLY: $id — precondition gone from $target and replacement not present. Human triage needed; current region:" >&2
                    if [[ -n "$file" ]]; then grep -nF "$(printf '%s' "$precond" | head -1)" "$file" >&2 || echo "    (anchor line not found)" >&2; fi
                    all_ok=0
                    ;;
                MULTI_MATCH)
                    echo "  ✗ MULTI_MATCH: $id — precondition matches more than once in $target (unsafe first-match). Tighten the anchor." >&2
                    all_ok=0
                    ;;
                MISSING)
                    echo "  ✗ MISSING: $id — target $target not found in canonical or block source." >&2
                    all_ok=0
                    ;;
            esac
        done
    done

    # Touched-file FYI: canonical commits since the previous LKG that touched a
    # patched file — an early heads-up even when all patches still apply.
    # Best-effort: never fails the gate.
    if [[ -n "$prev_lkg" && "$prev_lkg" != "$canonical_sha" ]]; then
        echo "[lkg-gate] Canonical commits since last LKG ($prev_lkg) touching patched files:" >&2
        local uniq_targets
        uniq_targets="$(printf '%s\n' "${touched_targets[@]}" | sort -u)"
        # shellcheck disable=SC2086
        git -C "$CANONICAL_DIR" log --oneline "${prev_lkg}..HEAD" -- $uniq_targets 2>/dev/null | sed 's/^/    /' >&2 \
            || echo "    (could not enumerate — previous LKG not in fetched history)" >&2
    fi

    emit_output "sha" "$canonical_sha"
    emit_output "changed" "$([[ "$prev_lkg" != "$canonical_sha" ]] && echo true || echo false)"
    emit_output "all_ok" "$([[ "$all_ok" -eq 1 ]] && echo true || echo false)"
    if [[ "${#obsolete_ids[@]}" -gt 0 ]]; then
        emit_output "obsolete" "${obsolete_ids[*]}"
    fi

    if [[ "$all_ok" -eq 1 ]]; then
        echo "[lkg-gate] All patches verified against canonical $canonical_sha." >&2
        printf '%s\n' "$canonical_sha"
        exit 0
    fi
    echo "[lkg-gate] One or more patches did not verify cleanly; LKG pointer will not advance." >&2
    exit 1
}

# Only run main when executed directly, so tests can source the functions.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
