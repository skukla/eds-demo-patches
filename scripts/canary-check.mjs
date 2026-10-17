#!/usr/bin/env node
/**
 * canary-check: do our patches still WORK on the canary storefront, not just fit?
 *
 * The daily gate (`lkg-gate.sh`) proves each patch's text still applies to Adobe's
 * boilerplate. It cannot tell whether the patched storefront behaves. This opens the
 * canary (a scratch Demo Builder storefront built from this repo's tested version) in
 * a browser and checks each B2B patch by what it is FOR, reporting per patch:
 * works / broken / could not check. Anything but "works" fails the run.
 *
 * Two passes:
 *   1. served: each patch's replacement text is in the file the live site serves;
 *   2. behaviour: one browser check per patch (below).
 *
 * Environment:
 *   CANARY_URL               the storefront (default: the B2B canary)
 *   CANARY_LEDGER            ledger to check (default: b2b/code-patches.json)
 *   CANARY_GRAPHQL           Commerce GraphQL endpoint, for the shopper sign-in
 *   CANARY_STORE_VIEW        store view code sent as the Store header
 *   PATCH_CANARY_EMAIL       the canary shopper (a GitHub secret)
 *   PATCH_CANARY_PASSWORD    its password (a GitHub secret; never printed)
 *   CANARY_GHOST_PDP         a published product page whose SKU does not exist
 *   CANARY_REAL_PDP          a published product page whose SKU does (the control)
 *
 * EDS-49 in skukla/demo-builder-vscode.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const SITE = (process.env.CANARY_URL || 'https://main--patch-canary-b2b--skukla.aem.live').replace(/\/$/, '');
const LEDGER = process.env.CANARY_LEDGER || 'b2b/code-patches.json';
const GHOST_PDP = process.env.CANARY_GHOST_PDP || '/products/ghost-check/canary-ghost-sku';
const REAL_PDP = process.env.CANARY_REAL_PDP || '/products/pulsewear-max-3/digiwristexplorer';
const WAIT_MS = 20_000;

/** The patches with a browser check below; any other gets the served check only. */
const BEHAVIOUR_CHECKED = new Set([
    'header-nav-tools-defensive',
    'aem-assets-sku-sanitization',
    'account-page-column-layout',
    'commerce-account-sidebar-selector-race',
    'pdp-empty-data-redirect',
]);

const WORKS = 'works';
const BROKEN = 'broken';
const UNCHECKED = 'could not check';

/** One verdict per patch, the worst of its passes. */
const verdicts = new Map();
function record(id, verdict, detail) {
    const rank = { [WORKS]: 0, [UNCHECKED]: 1, [BROKEN]: 2 };
    const prev = verdicts.get(id);
    // A later pass at the same rank wins, so a passing browser check, not the
    // served-text check before it, is what the report says.
    if (!prev || rank[verdict] >= rank[prev.verdict]) verdicts.set(id, { verdict, detail });
}

/** Pass 1: the replacement text is in what the live site serves. */
async function checkServed(patches) {
    for (const patch of patches) {
        try {
            const res = await fetch(`${SITE}/${patch.target}`);
            if (!res.ok) {
                record(patch.id, UNCHECKED, `the site answered ${res.status} for ${patch.target}`);
                continue;
            }
            const body = await res.text();
            if (body.includes(patch.replacement)) record(patch.id, WORKS, 'served');
            else record(patch.id, BROKEN, `the live ${patch.target} does not contain the fix`);
        } catch (error) {
            record(patch.id, UNCHECKED, `could not fetch ${patch.target}: ${error.message}`);
        }
    }
}

/** A Commerce customer token for the canary shopper, or a reason it is missing. */
async function shopperToken() {
    const { CANARY_GRAPHQL: endpoint, CANARY_STORE_VIEW: store } = process.env;
    const { PATCH_CANARY_EMAIL: email, PATCH_CANARY_PASSWORD: password } = process.env;
    if (!endpoint || !store || !email || !password) {
        return { reason: 'the shopper sign-in is not configured (endpoint, store view, email, password)' };
    }
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Store: store },
        body: JSON.stringify({
            query: 'mutation($e:String!,$p:String!){generateCustomerToken(email:$e,password:$p){token}}',
            variables: { e: email, p: password },
        }),
    });
    const answer = await res.json().catch(() => ({}));
    const token = answer?.data?.generateCustomerToken?.token;
    return token ? { token } : { reason: `the shopper could not sign in (${answer?.errors?.[0]?.message ?? res.status})` };
}

/**
 * SELF-TEST: with CANARY_UNPATCHED=1 the browser is served Adobe's unpatched copy of
 * every patched file (at the tested commit) in place of the live one. Each behaviour
 * check must then say "broken" or "could not check": one that still says "works" is not
 * testing its patch. The served pass is skipped in this mode; it reads the live site.
 */
const UNPATCHED = process.env.CANARY_UNPATCHED === '1';
const unpatched = [];

async function loadUnpatched(ledger, patches) {
    const sha = readFileSync(ledger.lkgFile, 'utf8').trim();
    const repo = ledger.canonical.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
    for (const target of new Set(patches.map((p) => p.target))) {
        const res = await fetch(`https://raw.githubusercontent.com/${repo}/${sha}/${target}`);
        if (!res.ok) throw new Error(`could not read Adobe's ${target} at ${sha.slice(0, 7)}: ${res.status}`);
        unpatched.push({ target, body: await res.text() });
    }
}

/** A browser context; in self-test mode it serves the unpatched files. */
async function newContext(browser) {
    const context = await browser.newContext();
    for (const { target, body } of unpatched) {
        await context.route((url) => url.pathname === `/${target}`, (route) =>
            route.fulfill({ status: 200, contentType: 'application/javascript', body }));
    }
    return context;
}

/** Open a page and let the drop-ins settle. */
async function open(page, path) {
    await page.goto(`${SITE}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: WAIT_MS }).catch(() => undefined);
}

/** The first `n` top-level sections of a fragment's HTML (depth-counted, not regex-matched). */
function firstSections(html, n) {
    const tag = /<\/?div\b[^>]*>/g;
    let depth = 0;
    let closed = 0;
    for (let m = tag.exec(html); m; m = tag.exec(html)) {
        depth += m[0].startsWith('</') ? -1 : 1;
        if (depth === 0 && ++closed === n) return html.slice(0, m.index + m[0].length);
    }
    return html;
}

async function checkHeader(browser) {
    const page = await (await newContext(browser)).newPage();
    // The condition the patch exists for: DA.live strips an empty tools section, so
    // the menu arrives with only brand and sections. Served that way here on purpose.
    await page.route((url) => url.pathname === '/nav.plain.html', async (route) => {
        const real = await route.fetch();
        await route.fulfill({ response: real, body: firstSections(await real.text(), 2) });
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`${e.message} ${e.stack ?? ''}`));
    try {
        await open(page, '/');
        const decorated = await page.locator('header nav').count();
        const headerErrors = errors.filter((e) => e.includes('header'));
        if (headerErrors.length) record('header-nav-tools-defensive', BROKEN, `header threw: ${headerErrors[0].slice(0, 160)}`);
        else if (!decorated) record('header-nav-tools-defensive', BROKEN, 'the header has no nav');
        else record('header-nav-tools-defensive', WORKS, 'header renders with its tools section missing');
    } finally {
        await page.context().close();
    }
}

async function checkSkuSlash(browser) {
    const page = await (await newContext(browser)).newPage();
    try {
        await open(page, '/');
        const src = await page.evaluate(async () => {
            const m = await import('/scripts/__dropins__/tools/lib/aem/assets.js');
            const host = document.createElement('div');
            const slot = document.createElement('span');
            host.appendChild(slot);
            document.body.appendChild(host);
            m.makeAemAssetsImageSlot({
                alias: 'CANARY/SLASH-1',
                params: { width: 100, height: 100 },
                imageProps: { src: 'https://delivery-p1-e1.adobeaemcloud.com/adobe/assets/urn:aaid:aem:0/as/x.jpg', alt: 'x' },
            })(slot);
            await new Promise((r) => setTimeout(r, 300));
            return host.querySelector('img')?.getAttribute('src') ?? '';
        });
        if (src.includes('/as/CANARY-SLASH-1.')) record('aem-assets-sku-sanitization', WORKS, 'slash replaced in the image name');
        else if (src.includes('CANARY/SLASH-1')) record('aem-assets-sku-sanitization', BROKEN, `image name keeps the slash: ${src}`);
        else record('aem-assets-sku-sanitization', UNCHECKED, `unexpected image address: ${src || '(none)'}`);
    } catch (error) {
        record('aem-assets-sku-sanitization', UNCHECKED, error.message);
    } finally {
        await page.context().close();
    }
}

async function checkAccount(browser) {
    const ids = ['account-page-column-layout', 'commerce-account-sidebar-selector-race'];
    const signedIn = await shopperToken();
    if (!signedIn.token) {
        for (const id of ids) record(id, UNCHECKED, signedIn.reason);
        return;
    }
    const context = await newContext(browser);
    await context.addCookies([
        { name: 'auth_dropin_user_token', value: signedIn.token, url: SITE },
        { name: 'auth_dropin_firstname', value: 'Patch', url: SITE },
    ]);
    const page = await context.newPage();
    // The condition the layout patch exists for: a page NOT marked with the Columns
    // template. Adobe's own code lays out a marked page (commerce.js applyTemplates),
    // and the canary's account pages are all marked, so the mark is removed here on
    // purpose; only the patch can then switch the columns on.
    await page.route((url) => url.pathname === '/customer/account', async (route) => {
        const real = await route.fetch();
        const html = (await real.text()).replace(/<meta name="template"[^>]*>/i, '');
        await route.fulfill({ response: real, body: html });
    });
    try {
        await open(page, '/customer/account');
        if (/\/customer\/login/.test(page.url())) {
            for (const id of ids) record(id, UNCHECKED, 'the account page sent the signed-in shopper to the login page');
            return;
        }
        const layout = await page.evaluate(() => ({
            columns: document.body.classList.contains('columns'),
            width: [...document.querySelectorAll('main > .section')]
                .some((s) => s.style.getPropertyValue('--column-width')),
        }));
        record(ids[0], layout.columns && layout.width ? WORKS : BROKEN,
            layout.columns && layout.width
                ? 'menu left, content right, on a page without the Columns template'
                : `body.columns=${layout.columns}, --column-width set=${layout.width}`);
        // The sidebar patch acts on the commerce-account-sidebar block. A storefront
        // whose account pages use another menu (the B2B template's commerce-account-nav)
        // never runs it, and that is reported as such, not as a broken sidebar.
        if ((await page.locator('.commerce-account-sidebar').count()) === 0) {
            record(ids[1], UNCHECKED, 'no account page here uses the commerce-account-sidebar block, so the patch never runs');
        } else {
            const items = await page.locator('.commerce-account-sidebar a')
                .first().waitFor({ state: 'attached', timeout: WAIT_MS }).then(() => true).catch(() => false);
            record(ids[1], items ? WORKS : BROKEN, items ? 'the sidebar lists its items' : 'the account sidebar is empty');
        }
    } finally {
        await context.close();
    }
}

async function checkMissingProduct(browser) {
    const id = 'pdp-empty-data-redirect';
    const page = await (await newContext(browser)).newPage();
    try {
        await open(page, REAL_PDP);
        const control = !/notfound/.test(page.url()) && (await page.locator('.product-details').count()) > 0;
        if (!control) {
            record(id, UNCHECKED, `the control product page (${REAL_PDP}) did not render, so a redirect proves nothing`);
            return;
        }
        await open(page, GHOST_PDP);
        const landed = await page.waitForURL(/notfound/, { timeout: WAIT_MS }).then(() => true).catch(() => false);
        record(id, landed ? WORKS : BROKEN, landed ? 'a missing product lands on the 404 page' : `stayed on ${page.url()}`);
    } finally {
        await page.context().close();
    }
}

function report() {
    const lines = ['| Patch | Verdict | Detail |', '|---|---|---|'];
    for (const [id, { verdict, detail }] of verdicts) lines.push(`| ${id} | ${verdict} | ${detail} |`);
    const table = lines.join('\n');
    console.log(`Canary ${SITE}\n\n${table}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Patch canary: ${SITE}\n\n${table}\n`);
    }
    return [...verdicts.values()].every((v) => v.verdict === WORKS);
}

async function main() {
    const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
    const patches = ledger.patches ?? ledger;
    if (UNPATCHED) await loadUnpatched(ledger, patches);
    else await checkServed(patches);
    const browser = await chromium.launch();
    try {
        await checkHeader(browser);
        await checkSkuSlash(browser);
        await checkAccount(browser);
        await checkMissingProduct(browser);
    } finally {
        await browser.close();
    }
    // A patch with no behaviour check keeps its served verdict, and says so, so a new
    // patch is noticed rather than silently passing on its text alone.
    for (const patch of patches) {
        const v = verdicts.get(patch.id);
        if (v && !BEHAVIOUR_CHECKED.has(patch.id) && v.verdict === WORKS) {
            verdicts.set(patch.id, { verdict: WORKS, detail: 'served; no behaviour check for this patch yet' });
        }
    }
    const allWork = report();
    if (!UNPATCHED) process.exit(allWork ? 0 : 1);
    // Self-test passes only when EVERY behaviour check failed without its patch.
    const blind = [...BEHAVIOUR_CHECKED].filter((id) => verdicts.get(id)?.verdict === WORKS);
    if (blind.length) {
        console.error(`These checks pass with their patch removed, so they test nothing: ${blind.join(', ')}`);
        process.exit(1);
    }
    const unproven = [...BEHAVIOUR_CHECKED].filter((id) => verdicts.get(id)?.verdict === UNCHECKED);
    if (unproven.length) console.log(`Not self-tested (could not run): ${unproven.join(', ')}`);
    console.log('Self-test passed: every check that ran fails without its patch.');
    process.exit(0);
}

main().catch((error) => {
    console.error(`canary-check could not run: ${error.stack ?? error}`);
    process.exit(2);
});
