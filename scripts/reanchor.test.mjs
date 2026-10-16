/**
 * Unit tests for scripts/reanchor.mjs.
 * Run: node --test scripts/reanchor.test.mjs
 *
 * Re-anchoring finds a patch's target text in a file whose only change is
 * whitespace (re-indented, re-wrapped), and returns the file's exact text there,
 * so the ledger can be updated to match. Anything beyond whitespace is not its
 * business: those cases must come back empty, for a person or a later step.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reanchor } from './reanchor.mjs';

const PRECOND = "const navTools = nav.querySelector('.nav-tools');";

test('a re-indented single line still matches exactly, so it is no re-anchor', () => {
    // The gate finds the precondition anywhere in the file; indentation before it
    // never broke it. Only whitespace INSIDE the precondition's span can.
    const file = "function x() {\n      const navTools = nav.querySelector('.nav-tools');\n}\n";
    assert.equal(reanchor(file, PRECOND), null);
});

test('spacing changed inside the line: returns the file\'s exact text there', () => {
    const file = "function x() {\n  const navTools  =  nav.querySelector('.nav-tools');\n}\n";
    assert.equal(reanchor(file, PRECOND), "const navTools  =  nav.querySelector('.nav-tools');");
});

test('re-wrapped over lines: returns the span with the file\'s own line breaks', () => {
    const file = "a();\nconst navTools =\n    nav.querySelector('.nav-tools');\nb();\n";
    assert.equal(reanchor(file, PRECOND), "const navTools =\n    nav.querySelector('.nav-tools');");
});

// Found by replaying the real gate on today's real header.js (2026-10-16): a
// formatter breaks a member chain BEFORE the dot, putting whitespace where there
// was none. Word-by-word matching missed it.
test('a call chain wrapped before the dot (formatter style)', () => {
    const file = "a();\n  const navTools = nav\n    .querySelector('.nav-tools');\nb();\n";
    assert.equal(reanchor(file, PRECOND), "const navTools = nav\n    .querySelector('.nav-tools');");
});

test('arguments spread over lines with spacing inside the brackets', () => {
    const pre = 'call(a, b);';
    const file = 'x;\ncall(\n  a,\n  b\n);\ny;\n';
    assert.equal(reanchor(file, pre), 'call(\n  a,\n  b\n);');
});

test('a trailing comma added by a formatter is a code change, not whitespace', () => {
    const file = 'x;\ncall(\n  a,\n  b,\n);\n';
    assert.equal(reanchor(file, 'call(a, b);'), null);
});

test('multi-line precondition re-indented as a whole', () => {
    const pre = 'if (a) {\n  b();\n}';
    const file = 'start\n    if (a) {\n        b();\n    }\nend\n';
    assert.equal(reanchor(file, pre), 'if (a) {\n        b();\n    }');
});

test('an exact match is not a re-anchor (the gate already calls it OK)', () => {
    const file = `x\n${PRECOND}\ny\n`;
    assert.equal(reanchor(file, PRECOND), null);
});

test('a real code change is not re-anchored', () => {
    const file = "const navTools = nav.querySelector('.nav-tools-wrapper');\n";
    assert.equal(reanchor(file, PRECOND), null);
});

test('two whitespace-variant matches are ambiguous: not re-anchored', () => {
    const file = "  const navTools = nav.querySelector('.nav-tools');\n\tconst navTools = nav.querySelector('.nav-tools');\n";
    assert.equal(reanchor(file, PRECOND), null);
});

test('a word split by new whitespace is a change, not a re-indent', () => {
    // "querySelector" -> "query Selector" changes a token; must not match.
    const file = "const navTools = nav.query Selector('.nav-tools');\n";
    assert.equal(reanchor(file, PRECOND), null);
});

test('empty or whitespace-only precondition never matches', () => {
    assert.equal(reanchor('anything', '   \n '), null);
});

test('a match must not start or end inside a word', () => {
    // "x  =  1" normalised is "x=1", which also sits inside "max=1" and "x=10".
    assert.equal(reanchor('const max  =  1;\n', 'x = 1'), null);
    assert.equal(reanchor('let x  =  10;\n', 'x = 1'), null);
    assert.equal(reanchor('let x  =  1;\n', 'x = 1'), 'x  =  1', 'control: the whole word matches');
});
