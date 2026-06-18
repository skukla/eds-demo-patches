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

# This script's own directory, so it can find sibling scripts (derive-surfaces.mjs)
# regardless of the caller's CWD.
SCRIPT_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

# ledger_canonical <ledger> — echo the canonical URL for a ledger, falling back
# to CANONICAL_URL when the ledger doesn't override. Supports multi-package
# repos where each package's ledger may track a different upstream
# (e.g. citisignal + custom share hlxsites; b2b tracks the B2B template).
ledger_canonical() {
    local ledger="$1" override
    override="$(jq -r '.canonical // empty' "$ledger" 2>/dev/null)"
    if [[ -n "$override" ]]; then
        printf '%s\n' "$override"
    else
        printf '%s\n' "$CANONICAL_URL"
    fi
}

# ledger_lkg_file <ledger> — echo the LKG file path a ledger writes to, falling
# back to LKG_FILE (root) when unset. Ledgers sharing the default canonical
# share the root LKG; ledgers with overrides usually point at a per-path file.
ledger_lkg_file() {
    local ledger="$1" override
    override="$(jq -r '.lkgFile // empty' "$ledger" 2>/dev/null)"
    if [[ -n "$override" ]]; then
        printf '%s\n' "$override"
    else
        printf '%s\n' "$LKG_FILE"
    fi
}

# slug_for_url <url> — derive a deterministic directory-safe slug for a git
# URL so each unique canonical gets its own clone dir under workdir.
slug_for_url() {
    local url="$1"
    printf '%s\n' "$url" | sed -E 's#^https?://github\.com/##; s#\.git$##; s#/#--#g'
}

main() {
    local workdir
    workdir="$(mktemp -d)"
    trap 'rm -rf "$workdir"' EXIT

    # Single-canonical injection seam preserved for the existing test suite:
    # when CANONICAL_DIR/BLOCK_DIR are pre-set, ALL ledgers verify against
    # that pre-set canonical. Tests remain a single-canonical fixture;
    # production cron honors per-ledger overrides via the multi-canonical
    # path below.
    local injected=0
    if [[ -n "$CANONICAL_DIR" ]]; then
        echo "[lkg-gate] Using pre-set CANONICAL_DIR=$CANONICAL_DIR BLOCK_DIR=$BLOCK_DIR" >&2
        injected=1
    fi

    if [[ "$injected" -eq 0 ]]; then
        # Block source is single — block-targeting patches across ledgers share
        # the demo team's block library today. Clone once.
        echo "[lkg-gate] Cloning block source ($BLOCK_SOURCE_BRANCH)..." >&2
        git clone --quiet --depth 1 --branch "$BLOCK_SOURCE_BRANCH" "$BLOCK_SOURCE_URL" "$workdir/blocks"
        BLOCK_DIR="$workdir/blocks"
    fi

    # Per-ledger state captured in temp files (Bash 3 lacks associative arrays).
    # One ledger == one LKG file. Ledgers sharing the same canonical end up
    # cloning it once (the clone dir is named by URL slug, so the second
    # ledger with the same URL hits the cached directory).
    local statedir="$workdir/state"
    mkdir -p "$statedir"

    local all_ok_global=1
    local -a obsolete_ids=()
    local ledger
    for ledger in ./*/code-patches.json; do
        [[ -e "$ledger" ]] || continue

        local url lkg_file slug clone_dir prev_lkg sha ledger_ok=1
        url="$(ledger_canonical "$ledger")"
        lkg_file="$(ledger_lkg_file "$ledger")"
        slug="$(slug_for_url "$url")"

        if [[ "$injected" -eq 1 ]]; then
            clone_dir="$CANONICAL_DIR"
        else
            clone_dir="$workdir/canonical-$slug"
            if [[ ! -d "$clone_dir" ]]; then
                echo "[lkg-gate] Cloning $url ($CANONICAL_BRANCH) → $clone_dir" >&2
                git clone --quiet --filter=blob:none --branch "$CANONICAL_BRANCH" "$url" "$clone_dir"
            fi
        fi

        sha="$(git -C "$clone_dir" rev-parse HEAD 2>/dev/null || echo unknown)"
        prev_lkg="$([[ -f "$lkg_file" ]] && tr -d '[:space:]' < "$lkg_file" || true)"

        echo "[lkg-gate] Verifying $ledger against $url @ ${sha:0:7}" >&2
        local count i
        count="$(jq '.patches | length' "$ledger")"
        local touched=""
        for ((i = 0; i < count; i++)); do
            local id target precond replacement file status
            id="$(jq -r ".patches[$i].id" "$ledger")"
            target="$(jq -r ".patches[$i].target" "$ledger")"
            precond="$(jq -r ".patches[$i].precondition" "$ledger")"
            replacement="$(jq -r ".patches[$i].replacement" "$ledger")"
            CANONICAL_DIR="$clone_dir"
            file="$(resolve_target "$target")"
            status="$(classify_patch "$file" "$precond" "$replacement")"
            touched+=" $target"
            case "$status" in
                OK)
                    echo "  ✓ $id ($target)" >&2
                    ;;
                OBSOLETE)
                    echo "  ⚠ OBSOLETE: $id — replacement already present in $target; fix appears to have landed upstream. Retirement PR candidate." >&2
                    obsolete_ids+=("$id")
                    ledger_ok=0
                    all_ok_global=0
                    ;;
                FIXED_DIFFERENTLY)
                    echo "  ✗ FIXED_DIFFERENTLY: $id — precondition gone from $target and replacement not present. Human triage needed; current region:" >&2
                    if [[ -n "$file" ]]; then grep -nF "$(printf '%s' "$precond" | head -1)" "$file" >&2 || echo "    (anchor line not found)" >&2; fi
                    ledger_ok=0
                    all_ok_global=0
                    ;;
                MULTI_MATCH)
                    echo "  ✗ MULTI_MATCH: $id — precondition matches more than once in $target (unsafe first-match). Tighten the anchor." >&2
                    ledger_ok=0
                    all_ok_global=0
                    ;;
                MISSING)
                    echo "  ✗ MISSING: $id — target $target not found in canonical or block source." >&2
                    ledger_ok=0
                    all_ok_global=0
                    ;;
            esac
        done

        # Runtime-surface drift check (ADR-008) — advisory, never affects the
        # LKG pass/fail. Re-derive the storefront's runtime surfaces from this
        # ledger's canonical clone and diff against the committed `derived` block.
        # On drift it writes <ledger-dir>/runtime-surfaces.json.proposed and emits
        # surfaces_changed_<slug>=true; the workflow opens a PR. Non-fatal by
        # design: a missing orphan should propose a fix, not freeze patch currency
        # (and a node/script hiccup must never red the gate).
        local ledger_dir surfaces_file surfaces_changed="false"
        ledger_dir="$(dirname "$ledger")"
        surfaces_file="$ledger_dir/runtime-surfaces.json"
        if [[ -f "$surfaces_file" ]] && command -v node >/dev/null 2>&1; then
            if node "$SCRIPT_SELF_DIR/derive-surfaces.mjs" check "$clone_dir" "$surfaces_file" --sha "$sha" >&2; then
                [[ -f "$surfaces_file.proposed" ]] && surfaces_changed="true"
            else
                echo "  ! surface check errored for $ledger_dir (non-fatal) — skipping" >&2
            fi
        fi
        emit_output "surfaces_changed_$slug" "$surfaces_changed"

        # Capture this ledger's verification state for downstream FYI + outputs.
        # Empty fields get a `-` placeholder so `read` (which collapses
        # consecutive tab delimiters) doesn't lose them — translated back
        # in the consumer loops below.
        printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
            "$ledger" "$slug" "$sha" "${prev_lkg:--}" "$lkg_file" "$ledger_ok" \
            >> "$statedir/ledgers.tsv"
        printf '%s\n' "$touched" > "$statedir/touched-$slug"

        # Touched-file FYI per ledger (canonical moved + ledger verified).
        if [[ -n "$prev_lkg" && "$prev_lkg" != "$sha" ]]; then
            echo "[lkg-gate] [$slug] Canonical commits since last LKG ($prev_lkg) touching patched files:" >&2
            local uniq_targets
            uniq_targets="$(printf '%s\n' $touched | sort -u | tr '\n' ' ')"
            # shellcheck disable=SC2086
            git -C "$clone_dir" log --oneline "${prev_lkg}..HEAD" -- $uniq_targets 2>/dev/null | sed 's/^/    /' >&2 \
                || echo "    (could not enumerate — previous LKG not in fetched history)" >&2
        fi
    done

    # Workflow outputs: first ledger un-prefixed (backward compat), all
    # ledgers also emitted with their slug for multi-canonical routing.
    local first=1
    while IFS=$'\t' read -r ledger slug sha prev_lkg lkg_file ledger_ok; do
        # Translate `-` placeholder back to empty.
        [[ "$prev_lkg" == "-" ]] && prev_lkg=""
        if [[ "$first" -eq 1 ]]; then
            emit_output "sha" "$sha"
            emit_output "changed" "$([[ "$prev_lkg" != "$sha" ]] && echo true || echo false)"
            emit_output "all_ok" "$([[ "$ledger_ok" -eq 1 ]] && echo true || echo false)"
            first=0
        fi
        emit_output "sha_$slug" "$sha"
        emit_output "changed_$slug" "$([[ "$prev_lkg" != "$sha" ]] && echo true || echo false)"
        emit_output "all_ok_$slug" "$([[ "$ledger_ok" -eq 1 ]] && echo true || echo false)"
        emit_output "lkg_file_$slug" "$lkg_file"
    done < "$statedir/ledgers.tsv"

    if [[ "${#obsolete_ids[@]}" -gt 0 ]]; then
        emit_output "obsolete" "${obsolete_ids[*]}"
    fi

    if [[ "$all_ok_global" -eq 1 ]]; then
        local n_ledgers
        n_ledgers="$(wc -l < "$statedir/ledgers.tsv" | tr -d ' ')"
        echo "[lkg-gate] All patches verified across $n_ledgers ledger(s):" >&2
        while IFS=$'\t' read -r ledger slug sha prev_lkg lkg_file ledger_ok; do
            [[ "$prev_lkg" == "-" ]] && prev_lkg=""
            local moved="false"
            [[ "$prev_lkg" != "$sha" ]] && moved="true"
            echo "    $ledger @ ${sha:0:7} → $lkg_file (moved: $moved)" >&2
            # Write LKG file if requested AND the canonical moved. Skipped in
            # local dry-runs (developer testing) — gate runs read-only by
            # default. CI sets WRITE_LKG=1 so cron-time advances persist.
            if [[ "${WRITE_LKG:-0}" == "1" && "$moved" == "true" ]]; then
                mkdir -p "$(dirname "$lkg_file")"
                printf '%s\n' "$sha" > "$lkg_file"
                echo "    wrote $lkg_file ← ${sha:0:7}" >&2
            fi
        done < "$statedir/ledgers.tsv"
        # Stdout: first ledger's SHA (backward-compat with workflow).
        head -1 "$statedir/ledgers.tsv" | cut -f3
        exit 0
    fi
    echo "[lkg-gate] One or more patches did not verify cleanly; LKG pointer(s) will not advance." >&2
    exit 1
}

# Only run main when executed directly, so tests can source the functions.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
