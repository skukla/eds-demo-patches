#!/usr/bin/env node
/**
 * canary-wait-for-code: after the canary update pushes, wait until the live site
 * serves the new code, so the checks test the updated storefront and not the one
 * before it.
 *
 * AEM's Code Sync republishes code on every push, but not instantly, and its status
 * endpoint needs a sign-in. So this takes a code file the push changed and polls the
 * live site until that file is byte-for-byte the pushed version. No fixed sleep: it
 * waits exactly as long as publishing takes, up to a limit.
 *
 * Environment:
 *   CANARY_REPO     owner/name of the canary repository
 *   CANARY_URL      the live site
 *   BEFORE, AFTER   the repository's commit before and after the update
 *   GITHUB_TOKEN    for the compare call (any token that can read a public repo)
 *
 * The live site does not serve head.html byte for byte: AEM moves a Content-Security-Policy
 * meta marked move-to-http-header into the response headers, and replaces each nonce="aem"
 * with a fresh random nonce per response (seen 2026-10-30, after Adobe's boilerplate added
 * both). Both sides are compared in servedForm, which undoes exactly those two rewrites.
 *
 * EDS-49 in skukla/demo-builder-vscode.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { CANARY_REPO: repo, CANARY_URL: site, BEFORE: before, AFTER: after, GITHUB_TOKEN: token } = process.env;
const LIMIT_MS = 10 * 60_000;
const EVERY_MS = 15_000;
/** Files Code Sync publishes: code and styles, not content or config. */
const CODE = /^(blocks|scripts|styles)\/.+\.(js|css)$|^head\.html$/;

/** A code file as the live site serves it: the CSP meta moved to a header, every nonce random. */
export function servedForm(text) {
    return text
        .replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*move-to-http-header="true"\s*\/?>/gs, '')
        .replace(/nonce="[^"]*"/g, 'nonce="aem"')
        .trim();
}

async function changedCodeFile() {
    const res = await fetch(`https://api.github.com/repos/${repo}/compare/${before}...${after}`, {
        headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) throw new Error(`could not compare ${before.slice(0, 7)}...${after.slice(0, 7)}: ${res.status}`);
    const { files = [] } = await res.json();
    return files.find((f) => f.status !== 'removed' && CODE.test(f.filename))?.filename;
}

async function main() {
    if (!repo || !site || !before || !after) throw new Error('CANARY_REPO, CANARY_URL, BEFORE and AFTER must be set');
    if (before === after) {
        console.log('The update pushed nothing; nothing to wait for.');
        return;
    }
    const file = await changedCodeFile();
    if (!file) {
        console.log('The update changed no code file; nothing to wait for.');
        return;
    }
    const expected = await (await fetch(`https://raw.githubusercontent.com/${repo}/${after}/${file}`)).text();
    const started = Date.now();
    while (Date.now() - started < LIMIT_MS) {
        const live = await fetch(`${site.replace(/\/$/, '')}/${file}?canary=${Date.now()}`).then((r) => (r.ok ? r.text() : ''));
        if (servedForm(live) === servedForm(expected)) {
            console.log(`The live site serves the updated ${file} after ${Math.round((Date.now() - started) / 1000)}s.`);
            return;
        }
        await new Promise((r) => setTimeout(r, EVERY_MS));
    }
    throw new Error(`The live site still did not serve the updated ${file} after ${LIMIT_MS / 60_000} minutes.`);
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
    main().catch((error) => {
        console.error(`canary-wait-for-code: ${error.message}`);
        process.exit(1);
    });
}
