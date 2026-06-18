/**
 * Unit tests for scripts/derive-surfaces.mjs (ADR-008 surface drift check).
 * Run: node --test scripts/derive-surfaces.test.mjs
 *
 * Pure functions only (mirrors tests/lkg-gate.test.sh's approach); fixtures are
 * trimmed-but-faithful snippets from the real B2B boilerplate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    extractSurfacesFromFiles,
    toPathSets,
    diffDerived,
    buildProposed,
} from './derive-surfaces.mjs';

const find = (list, p) => list.find((e) => e.path === p);

test('derives code-loaded fragments, nav/footer, sheets, and customer pages', () => {
    const files = [
        { path: 'blocks/commerce-account-sidebar/commerce-account-sidebar.js', content: `loadFragment('/customer/sidebar-fragment');` },
        { path: 'blocks/header/header.js', content: `getMetadata('nav') || '/nav';` },
        { path: 'blocks/footer/footer.js', content: `getMetadata('footer') || '/footer';` },
        { path: 'blocks/commerce-checkout/containers.js', content: `await fetchPlaceholders('placeholders/checkout.json');` },
        { path: 'blocks/header/renderAuthDropdown.js', content: `link('/customer/account'); link('/customer/login');` },
    ];
    const r = extractSurfacesFromFiles(files);
    assert.ok(find(r.fragments, '/customer/sidebar-fragment'), 'code-loaded fragment');
    assert.ok(find(r.navFooter, '/nav') && find(r.navFooter, '/footer'), 'nav + footer');
    assert.ok(find(r.placeholderSheets, 'placeholders/checkout'), 'sheet, .json stripped');
    assert.ok(find(r.customerPages, '/customer/account') && find(r.customerPages, '/customer/login'), 'customer pages');
});

test('toPathSets reduces to sorted, stable path arrays', () => {
    const files = [{ path: 'a.js', content: `link('/customer/login'); link('/customer/account');` }];
    const paths = toPathSets(extractSurfacesFromFiles(files));
    assert.deepEqual(paths.customerPages, ['/customer/account', '/customer/login']);
});

test('diffDerived reports no drift when sets match', () => {
    const committed = { fragments: ['/customer/sidebar-fragment'], placeholderSheets: ['placeholders/search'] };
    const fresh = { fragments: ['/customer/sidebar-fragment'], placeholderSheets: ['placeholders/search'] };
    const diff = diffDerived(committed, fresh);
    assert.equal(diff.hasDrift, false);
    assert.deepEqual(diff.added, {});
    assert.deepEqual(diff.removed, {});
});

test('diffDerived flags a NEW orphan the committed set is missing (the dangerous direction)', () => {
    const committed = { placeholderSheets: ['placeholders/search'] };
    const fresh = { placeholderSheets: ['placeholders/search', 'placeholders/new-b2b-thing'] };
    const diff = diffDerived(committed, fresh);
    assert.equal(diff.hasDrift, true);
    assert.deepEqual(diff.added.placeholderSheets, ['placeholders/new-b2b-thing']);
    assert.equal(diff.removed.placeholderSheets, undefined);
});

test('diffDerived flags a STALE entry the code no longer references', () => {
    const committed = { fragments: ['/customer/sidebar-fragment', '/customer/gone'] };
    const fresh = { fragments: ['/customer/sidebar-fragment'] };
    const diff = diffDerived(committed, fresh);
    assert.equal(diff.hasDrift, true);
    assert.deepEqual(diff.removed.fragments, ['/customer/gone']);
});

test('buildProposed refreshes derived + derivedFrom but preserves the human-owned residual', () => {
    const committed = {
        derivedFrom: 'oldsha',
        derived: { fragments: ['/customer/old'] },
        residual: { spreadsheets: ['/metadata', '/redirects', '/sitemap'], _reason: 'platform' },
    };
    const fresh = { fragments: ['/customer/sidebar-fragment'] };
    const proposed = buildProposed(committed, fresh, 'newsha');
    assert.equal(proposed.derivedFrom, 'newsha');
    assert.deepEqual(proposed.derived, fresh);
    assert.deepEqual(proposed.residual, committed.residual, 'residual untouched');
});

test('does not match bare prose paths (only quoted literals)', () => {
    const files = [{ path: 'README.md', content: `Visit /customer/account for your account.` }];
    const r = extractSurfacesFromFiles(files);
    assert.equal(r.customerPages.length, 0);
});
