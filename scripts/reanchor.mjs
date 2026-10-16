#!/usr/bin/env node
/**
 * reanchor.mjs — find a patch's precondition in a file that changed ONLY in
 * whitespace, and return the file's exact text there.
 *
 *   node scripts/reanchor.mjs <file> < precondition.txt
 *     prints the file's exact text for the precondition and exits 0, or prints
 *     nothing and exits 1 when there is no single whitespace-only match.
 *
 * WHY. The most common way upstream breaks a patch without changing what the code
 * does is reformatting: a line re-indented, a call re-wrapped over two lines. The
 * gate then reads the patch as FIXED_DIFFERENTLY and a person has to copy the new
 * text into the ledger by hand. This does that copy, and only that: the file and
 * the precondition must be the same code once whitespace is normalised (kept as one
 * space between two word characters, dropped beside punctuation), exactly once. A
 * changed word, a new argument, an added trailing comma, all come back empty.
 *
 * One limit, stated rather than hidden: whitespace INSIDE a string literal counts
 * as whitespace here, so 'a b' and 'a  b' match. That is why a re-anchor is a pull
 * request a person merges, not a change the gate makes itself.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WORD = /[A-Za-z0-9_$]/;

/**
 * `text` with whitespace normalised, and where each kept character came from.
 * Whitespace between two word characters becomes one space (it separates tokens:
 * `return x` is not `returnx`); any other whitespace is dropped (a formatter puts
 * it around punctuation freely: `nav\n  .querySelector(` is `nav.querySelector(`).
 */
function normalise(text) {
    let out = '';
    const from = [];
    let i = 0;
    while (i < text.length) {
        if (!/\s/.test(text[i])) {
            out += text[i];
            from.push(i);
            i += 1;
            continue;
        }
        let j = i;
        while (j < text.length && /\s/.test(text[j])) j += 1;
        if (i > 0 && j < text.length && WORD.test(text[i - 1]) && WORD.test(text[j])) {
            out += ' ';
            from.push(i);
        }
        i = j;
    }
    return { out, from };
}

/** A match that neither starts nor ends in the middle of a word. */
function wholeWords(text, at, want) {
    const before = text[at - 1];
    const after = text[at + want.length];
    const startsInWord = before !== undefined && WORD.test(before) && WORD.test(want[0]);
    const endsInWord = after !== undefined && WORD.test(after) && WORD.test(want[want.length - 1]);
    return !startsInWord && !endsInWord;
}

/**
 * The file's exact text for `precondition`, when they differ only in whitespace
 * and match exactly once; null otherwise (an exact match included, which the gate
 * already calls OK).
 *
 * @param {string} file - the target file's content
 * @param {string} precondition - the patch's precondition
 * @returns {string | null}
 */
export function reanchor(file, precondition) {
    const want = normalise(precondition.trim()).out;
    if (want.length === 0) return null;
    const have = normalise(file);
    const starts = [];
    for (let at = have.out.indexOf(want); at >= 0; at = have.out.indexOf(want, at + 1)) {
        if (wholeWords(have.out, at, want)) starts.push(at);
    }
    if (starts.length !== 1) return null;
    const [first] = starts;
    const span = file.slice(have.from[first], have.from[first + want.length - 1] + 1);
    return span === precondition ? null : span;
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
    const [file] = process.argv.slice(2);
    const found = reanchor(readFileSync(file, 'utf8'), readFileSync(0, 'utf8'));
    if (found === null) process.exit(1);
    process.stdout.write(found);
}
