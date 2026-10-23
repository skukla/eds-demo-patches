/**
 * Unit tests for scripts/validate-code-ledgers.mjs.
 * Run: node --test scripts/validate-code-ledgers.test.mjs
 *
 * Pure functions only (mirrors derive-surfaces.test.mjs). The interesting cases
 * are refusals: a ledger entry that names a file outside storefront JavaScript
 * is the thing this gate exists to stop.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPatchTarget, validateLedger } from './validate-code-ledgers.mjs';

const valid = (over = {}) => ({
    id: 'p1',
    target: 'blocks/header/header.js',
    description: 'd',
    precondition: 'OLD',
    replacement: 'NEW',
    ...over,
});

test('accepts the targets the live ledgers actually use', () => {
    for (const target of [
        'blocks/commerce-account-sidebar/commerce-account-sidebar.js',
        'blocks/header/header.js',
        'blocks/product-teaser/product-teaser.js',
        'scripts/__dropins__/tools/lib/aem/assets.js',
        'scripts/commerce.js',
        'scripts/scripts.js',
    ]) {
        assert.equal(checkPatchTarget(target).allowed, true, target);
    }
});

test('refuses the targets that make this gate necessary', () => {
    // package.json → arbitrary code at install time.
    // .github/workflows → the colleague's CI secrets.
    for (const target of ['package.json', '.github/workflows/deploy.yml', '.env', '.npmrc']) {
        assert.equal(checkPatchTarget(target).allowed, false, target);
    }
});

test('refuses paths that escape the repo', () => {
    for (const target of [
        '../package.json',
        'blocks/../package.json',
        '/etc/passwd',
        '/scripts/commerce.js',
        'blocks\\..\\package.json',
    ]) {
        assert.equal(checkPatchTarget(target).allowed, false, target);
    }
});

test('refuses anything outside the two prefixes, including near-misses', () => {
    for (const target of ['head.html', 'tools/quick-edit/quick-edit.js', 'blocksy/header/header.js']) {
        assert.equal(checkPatchTarget(target).allowed, false, target);
    }
});

test('refuses non-JavaScript even under an allowed prefix', () => {
    assert.equal(checkPatchTarget('scripts/styles.css').allowed, false);
    assert.equal(checkPatchTarget('blocks/header/header.json').allowed, false);
});

test('accepts a well-formed ledger', () => {
    assert.deepEqual(validateLedger({ patches: [valid()] }, 'x'), []);
});

test('reports every missing required field', () => {
    const problems = validateLedger({ patches: [{ id: 'only-id' }] }, 'x');
    for (const field of ['target', 'description', 'precondition', 'replacement']) {
        assert.ok(
            problems.some((p) => p.includes(`'${field}'`)),
            `expected a problem naming ${field}, got: ${problems.join(' | ')}`,
        );
    }
});

test('reports duplicate ids', () => {
    const problems = validateLedger({ patches: [valid(), valid()] }, 'x');
    assert.ok(problems.some((p) => p.includes('duplicate id')));
});

test('reports a refused target', () => {
    const problems = validateLedger({ patches: [valid({ target: 'package.json' })] }, 'x');
    assert.ok(problems.some((p) => p.includes('refused target')));
});

test('reports an oversized replacement', () => {
    const problems = validateLedger({ patches: [valid({ replacement: 'x'.repeat(20001) })] }, 'x');
    assert.ok(problems.some((p) => p.includes('max 20000')));
});

test('reports a ledger with no patches array', () => {
    assert.ok(validateLedger({}, 'x').length > 0);
    assert.ok(validateLedger(null, 'x').length > 0);
});

/** A retired entry: a live patch's fields plus when and why it was retired. */
const retired = (overrides = {}) => valid({ id: 'old-fix', retiredBy: 'abc1234', reason: 'Adobe fixed it.', ...overrides });

test('accepts a ledger with retired patches', () => {
    assert.deepEqual(validateLedger({ patches: [valid()], retired: [retired()] }, 'x'), []);
});

test('a retired patch must say when and why it was retired', () => {
    const problems = validateLedger({ patches: [], retired: [valid({ id: 'old-fix' })] }, 'x');
    assert.ok(problems.some((p) => p.includes("'retiredBy'")), problems.join(' | '));
    assert.ok(problems.some((p) => p.includes("'reason'")), problems.join(' | '));
});

test('a retired patch is held to the same target policy: its undo writes files too', () => {
    const problems = validateLedger({ patches: [], retired: [retired({ target: '.github/workflows/x.yml' })] }, 'x');
    assert.ok(problems.some((p) => p.includes('.retired[0]') && p.includes('refused target')), problems.join(' | '));
});

test('an id cannot be both live and retired', () => {
    const problems = validateLedger({ patches: [valid({ id: 'same' })], retired: [retired({ id: 'same' })] }, 'x');
    assert.ok(problems.some((p) => p.includes('duplicate id')));
});

test('reports a retired list that is not an array', () => {
    assert.ok(validateLedger({ patches: [], retired: {} }, 'x').some((p) => p.includes("'retired' is not an array")));
});
