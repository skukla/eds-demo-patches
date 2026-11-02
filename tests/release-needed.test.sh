#!/usr/bin/env bash
#
# Which changes publish a release. Every case that should publish matters more than the ones that should
# not: a missed release is what froze storefronts, and an extra one costs nothing.
#
# Run: bash tests/release-needed.test.sh

set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/release-needed.sh"
FAIL=0

check() {
    local expected="$1" msg="$2" input="$3" actual
    printf '%b' "$input" | bash "$SCRIPT"
    actual=$?
    if [[ "$actual" == "$expected" ]]; then
        echo "ok   $msg"
    else
        echo "FAIL $msg (expected $expected, got $actual)"
        FAIL=$((FAIL + 1))
    fi
}

# Publishes.
check 0 'a ledger'                            'b2b/code-patches.json\n'
check 0 'a content ledger'                    'citisignal/patches.json\n'
check 0 'the tested commit'                   'b2b/last-known-good\n'
check 0 'the root pointer'                    'last-known-good\n'
check 0 'the runtime surfaces'                'b2b/runtime-surfaces.json\n'
check 0 'a file nobody has listed'            'something/new.json\n'
check 0 'a ledger among docs'                 'README.md\nb2b/code-patches.json\n'
check 0 'no answer about what changed'        ''
check 0 'a file only named like a doc folder' 'scripts.json\n'
check 0 'a list GitHub may have cut short'    "$(for i in $(seq 1 300); do printf 'docs/%s.md\\n' "$i"; done)"

# Does not.
check 1 'the docs'                            'README.md\nRELEASING.md\n'
check 1 'a workflow'                          '.github/workflows/lkg-gate.yml\n'
check 1 'the gate itself'                     'scripts/lkg-gate.sh\ntests/lkg-gate.test.sh\n'
check 1 'the canary record'                   'canary/b2b.last-synced\n'

[[ "$FAIL" == 0 ]] || { echo "$FAIL failed"; exit 1; }
echo 'all passed'
