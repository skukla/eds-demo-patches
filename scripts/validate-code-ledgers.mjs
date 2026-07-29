/**
 * validate-code-ledgers.mjs — schema + target-policy gate for code-patch ledgers.
 *
 * Code patches are consumed by the Demo Builder extension and their `replacement`
 * content is written into a colleague's storefront repo, where it runs in demo
 * audiences' browsers. A ledger entry naming `package.json` (a dependency
 * addition executes arbitrary code at install time) or `.github/workflows/*`
 * (write access to that repo's CI secrets) would be applied as readily as
 * `blocks/header/header.js`. There is no recall — patches land in the user's
 * repo at build time, so fixing a ledger fixes only future builds.
 *
 * Scope: `*​/code-patches.json` only. Content ledgers (`patches.json`) use a
 * different shape entirely — `pagePath` + `searchPattern` rather than `target` +
 * `precondition` — and are not governed by this policy.
 *
 * DUPLICATION IS DELIBERATE. The identical target rule is enforced inside the
 * extension at `src/features/eds/services/patchTargetPolicy.ts`. CI protects the
 * repo; the extension protects the user. They must not depend on each other,
 * because an account compromise that rewrites a ledger can rewrite this workflow
 * too — only the consumer-side check survives that. Change one, change the other.
 *
 * Pure functions (checkPatchTarget, validateLedger) are imported by
 * validate-code-ledgers.test.mjs; main() runs only when invoked directly.
 *
 * Usage:
 *   node scripts/validate-code-ledgers.mjs [rootDir]
 *
 * Exits 1 when any ledger has a problem, 0 when all are clean.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Directory prefixes a patch may write into. Trailing slash stops `blocksy/`
 *  from matching `blocks`. */
const ALLOWED_PREFIXES = ['blocks/', 'scripts/'];
const ALLOWED_EXTENSION = '.js';

/** Generous ceiling — real replacements run to a few thousand characters. */
const MAX_REPLACEMENT_CHARS = 20000;

const REQUIRED_FIELDS = ['id', 'target', 'description', 'precondition', 'replacement'];

/**
 * Decide whether a patch may modify the given repo-relative path.
 * Mirrors patchTargetPolicy.ts in the extension — see the note above.
 */
export function checkPatchTarget(target) {
    if (typeof target !== 'string' || target.trim().length === 0) {
        return { allowed: false, reason: 'target is empty' };
    }
    if (target.startsWith('/')) {
        return { allowed: false, reason: `'${target}' is an absolute path` };
    }
    if (target.includes('..') || target.includes('\\')) {
        return { allowed: false, reason: `'${target}' contains a path escape` };
    }
    if (!ALLOWED_PREFIXES.some((p) => target.startsWith(p))) {
        return {
            allowed: false,
            reason: `'${target}' is outside ${ALLOWED_PREFIXES.join(', ')}`,
        };
    }
    if (!target.endsWith(ALLOWED_EXTENSION)) {
        return { allowed: false, reason: `'${target}' is not a ${ALLOWED_EXTENSION} file` };
    }
    return { allowed: true };
}

/**
 * Validate one parsed code-patch ledger.
 *
 * @param ledger - Parsed `{ patches: [...] }` object
 * @param label - Path used in problem messages
 * @returns Array of human-readable problems; empty means clean
 */
export function validateLedger(ledger, label) {
    const problems = [];

    if (!ledger || typeof ledger !== 'object') {
        return [`${label}: not a JSON object`];
    }
    if (!Array.isArray(ledger.patches)) {
        return [`${label}: missing a 'patches' array`];
    }

    const seen = new Set();

    ledger.patches.forEach((patch, index) => {
        const where = `${label}[${index}]${patch?.id ? ` id='${patch.id}'` : ''}`;

        if (!patch || typeof patch !== 'object') {
            problems.push(`${where}: entry is not an object`);
            return;
        }

        for (const field of REQUIRED_FIELDS) {
            if (typeof patch[field] !== 'string' || patch[field].length === 0) {
                problems.push(`${where}: missing or empty '${field}'`);
            }
        }

        if (typeof patch.id === 'string') {
            if (seen.has(patch.id)) problems.push(`${where}: duplicate id`);
            seen.add(patch.id);
        }

        if (typeof patch.target === 'string') {
            const verdict = checkPatchTarget(patch.target);
            if (!verdict.allowed) problems.push(`${where}: refused target — ${verdict.reason}`);
        }

        if (typeof patch.replacement === 'string' && patch.replacement.length > MAX_REPLACEMENT_CHARS) {
            problems.push(
                `${where}: replacement is ${patch.replacement.length} chars ` +
                    `(max ${MAX_REPLACEMENT_CHARS})`,
            );
        }
    });

    return problems;
}

/** Find every `<family>/code-patches.json` one level below root. */
function findCodeLedgers(root) {
    return readdirSync(root)
        .filter((entry) => !entry.startsWith('.'))
        .map((entry) => join(root, entry))
        .filter((path) => {
            try {
                return statSync(path).isDirectory();
            } catch {
                return false;
            }
        })
        .map((dir) => join(dir, 'code-patches.json'))
        .filter((file) => {
            try {
                return statSync(file).isFile();
            } catch {
                return false;
            }
        });
}

function main() {
    const root = process.argv[2] ?? '.';
    const ledgers = findCodeLedgers(root);

    if (ledgers.length === 0) {
        console.error(`No code-patches.json found under ${root}`);
        process.exit(1);
    }

    let total = 0;
    for (const file of ledgers) {
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(file, 'utf8'));
        } catch (error) {
            console.error(`✗ ${file}: unparseable JSON — ${error.message}`);
            total += 1;
            continue;
        }

        const problems = validateLedger(parsed, file);
        if (problems.length === 0) {
            console.log(`✓ ${file}`);
        } else {
            for (const problem of problems) console.error(`✗ ${problem}`);
            total += problems.length;
        }
    }

    if (total > 0) {
        console.error(`\n${total} problem(s) found.`);
        process.exit(1);
    }
    console.log(`\nAll ${ledgers.length} code ledgers valid.`);
}

// Run only when invoked directly (mirrors derive-surfaces.mjs).
if (process.argv[1] && process.argv[1].endsWith('validate-code-ledgers.mjs')) {
    main();
}
