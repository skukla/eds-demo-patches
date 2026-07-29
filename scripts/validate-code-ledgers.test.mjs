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
