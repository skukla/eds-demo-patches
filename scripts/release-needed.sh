#!/usr/bin/env bash
#
# Reads changed file paths on stdin. Exit 0: publish a release. Exit 1: nothing a storefront reads changed.
#
# It lists what CANNOT matter, never what can. A release no storefront needed costs nothing, and a missed
# one froze every storefront for seven weeks in 2026, so anything not listed here publishes, and so does
# no input at all. Demo Builder reads the ledgers, runtime-surfaces.json and the last-known-good pointers.
#
# demo-builder-vscode's scripts/patchesReleased.mjs holds the same list: keep the two in step.

set -uo pipefail

CANNOT_MATTER='^(.*\.md|\.gitignore|\.github/.*|scripts/.*|tests/.*|canary/.*)$'
# GitHub lists at most this many changed files, so a list this long may have left one out.
COMPARE_FILE_CAP=300

files="$(grep -v '^$' || true)"
[[ -z "$files" ]] && exit 0
[[ "$(printf '%s\n' "$files" | awk 'END { print NR }')" -ge "$COMPARE_FILE_CAP" ]] && exit 0
printf '%s\n' "$files" | grep -qvE "$CANNOT_MATTER"
