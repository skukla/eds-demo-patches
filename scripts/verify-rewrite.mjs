#!/usr/bin/env node
/**
 * verify-rewrite.mjs — is a drafted patch rewrite fit to propose?
 *
 *   node scripts/verify-rewrite.mjs <proposals-dir> <ledger>:<id> ...
 *     reads each ledger's patch (as edited) and the saved canonical file
 *     (<proposals-dir>/<ledger>__<id>.target); prints one line per patch and
 *     exits 1 if any is not fit.
 *
 * WHY. Claude drafts the rewrite of a patch upstream broke (the gate's
 * FIXED_DIFFERENTLY). A draft is only worth a person's review if it would apply:
 * its precondition occurs exactly once in canonical's current file (the gate's own
 * OK rule) and it still changes something. Anything else is not opened as a PR.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** How many times `needle` occurs in `text`, overlapping matches excluded. */
function occurrences(text, needle) {
    let count = 0;
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) count += 1;
    return count;
}

/**
 * @param {{precondition: string, replacement: string}} patch - the patch as drafted
 * @param {string} target - canonical's current file
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function verifyRewrite(patch, target) {
    const { precondition, replacement } = patch;
    if (!precondition) return { ok: false, reason: 'the precondition is empty' };
    if (precondition === replacement) return { ok: false, reason: 'the replacement changes nothing' };
    const found = occurrences(target, precondition);
    if (found === 0) return { ok: false, reason: 'the precondition is not found in the current file' };
    if (found > 1) return { ok: false, reason: `the precondition occurs ${found} times, not once` };
    return { ok: true };
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
    const [dir, ...entries] = process.argv.slice(2);
    let failed = 0;
    for (const entry of entries) {
        const [ledgerDir, id] = entry.split(':');
        const ledger = JSON.parse(readFileSync(join(ledgerDir, 'code-patches.json'), 'utf8'));
        const patch = ledger.patches.find((p) => p.id === id);
        const target = readFileSync(join(dir, `${ledgerDir}__${id}.target`), 'utf8');
        const verdict = patch ? verifyRewrite(patch, target) : { ok: false, reason: 'the patch is gone from its ledger' };
        if (!verdict.ok) failed += 1;
        console.log(`${verdict.ok ? 'fits' : 'NOT FIT'}  ${entry}${verdict.ok ? '' : `: ${verdict.reason}`}`);
    }
    process.exit(failed ? 1 : 0);
}
