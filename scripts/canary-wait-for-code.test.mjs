/**
 * Unit tests for scripts/canary-wait-for-code.mjs.
 * Run: node --test scripts/canary-wait-for-code.test.mjs
 *
 * The live site rewrites head.html as it serves it (a CSP meta moved to a header, every
 * nonce made random), so the wait compares what the push wrote and what the site serves
 * in servedForm. Shapes from the canary's real head.html and live answer, 2026-10-30.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { servedForm } from './canary-wait-for-code.mjs';

const PUSHED = `<meta
  http-equiv="Content-Security-Policy"
  content="script-src 'nonce-aem' 'strict-dynamic' 'unsafe-inline' http: https:; base-uri 'self';"
  move-to-http-header="true"
/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<script nonce="aem" type="importmap">{"imports":{}}</script>
<script nonce="aem" src="/scripts/aem.js" type="module"></script>
`;

const SERVED = `
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<script nonce="4hGeINta0uZwCmMroKkRVCRs" type="importmap">{"imports":{}}</script>
<script nonce="4hGeINta0uZwCmMroKkRVCRs" src="/scripts/aem.js" type="module"></script>
`;

test('the pushed head.html and the one the site serves for it compare equal', () => {
    assert.equal(servedForm(SERVED), servedForm(PUSHED));
});

test('a different head.html still compares different (the wait is not made blind)', () => {
    const older = SERVED.replace('/scripts/aem.js', '/scripts/old.js');
    assert.notEqual(servedForm(older), servedForm(PUSHED));
});

test('a file with neither rewrite is compared as it is', () => {
    assert.equal(servedForm('a { color: red; }\n'), 'a { color: red; }');
});
