/**
 * Unit tests for scripts/verify-rewrite.mjs.
 * Run: node --test scripts/verify-rewrite.test.mjs
 *
 * After Claude drafts a rewrite of a broken patch, this decides whether it is fit
 * to propose: the new precondition must occur exactly once in canonical's current
 * file, and the patch must still change something. A draft that fails is not
 * opened as a PR.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyRewrite } from './verify-rewrite.mjs';

const TARGET = "a();\nconst navTools = nav.querySelector('.tools');\nb();\n";

test('a precondition found exactly once, with a real replacement, is fit', () => {
    const patch = { precondition: "const navTools = nav.querySelector('.tools');", replacement: 'let navTools = x;' };
    assert.deepEqual(verifyRewrite(patch, TARGET), { ok: true });
});

test('a precondition the file does not contain is not fit', () => {
    const patch = { precondition: "nav.querySelector('.nav-tools')", replacement: 'x' };
    assert.equal(verifyRewrite(patch, TARGET).ok, false);
    assert.match(verifyRewrite(patch, TARGET).reason, /not found/);
});

test('a precondition found twice is not fit', () => {
    const patch = { precondition: '();', replacement: 'x' };
    assert.match(verifyRewrite(patch, TARGET).reason, /2 times/);
});

test('a replacement equal to its precondition changes nothing: not fit', () => {
    const patch = { precondition: 'a();', replacement: 'a();' };
    assert.match(verifyRewrite(patch, TARGET).reason, /changes nothing/);
});

test('an empty precondition is not fit', () => {
    assert.equal(verifyRewrite({ precondition: '', replacement: 'x' }, TARGET).ok, false);
});
