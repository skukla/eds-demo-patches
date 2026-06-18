/**
 * derive-surfaces.mjs — runtime-surface derivation + drift check for the LKG gate.
 *
 * Part of the ADR-008 "derive, don't hand-curate" mechanism. Statically scans a
 * cloned EDS storefront boilerplate for the content paths the storefront CODE
 * fetches at runtime — the orphan documents a demo needs but that nothing in the
 * published content links to (so reference-following discovery can't reach them).
 *
 * The LKG gate (scripts/lkg-gate.sh) already clones each ledger's canonical
 * daily. This rides that clone: it re-derives the surface set and diffs it against
 * the ledger's committed `runtime-surfaces.json::derived` block. On drift it writes
 * a `.proposed` file; the workflow opens a PR (automation proposes, a human merges
 * — same doctrine as obsolete-patch retirement). The `residual` block is
 * human-owned (platform conventions that no scan can derive) and never touched.
 *
 * Pure functions (extractSurfacesFromFiles, toPathSets, diffDerived, buildProposed)
 * are imported by derive-surfaces.test.mjs; main() runs only when invoked directly.
 *
 * Usage:
 *   node scripts/derive-surfaces.mjs derive <clone-dir>
 *   node scripts/derive-surfaces.mjs check  <clone-dir> <ledger>/runtime-surfaces.json [--sha <sha>]
 *
 * Always exits 0 (advisory — drift never blocks the LKG pointer). On drift in
 * `check` mode it writes `<file>.proposed` and prints `SURFACE_DRIFT`.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, extname, dirname } from 'node:path';

const lineOf = (content, index) => content.slice(0, index).split('\n').length;

/**
 * Pure extractor: given `{ path, content }` source files, derive the runtime
 * surfaces the code references, with provenance (first file:line) and a note.
 */
export function extractSurfacesFromFiles(files) {
    const buckets = {
        fragments: new Map(),
        navFooter: new Map(),
        placeholderSheets: new Map(),
        customerPages: new Map(),
    };
    const record = (bucket, surfacePath, file, content, index, note) => {
        if (!buckets[bucket].has(surfacePath)) {
            buckets[bucket].set(surfacePath, { provenance: `${file}:${lineOf(content, index)}`, note });
        }
    };

    for (const { path: file, content } of files) {
        let m;
        // 1. Code-loaded fragments: loadFragment('/customer/sidebar-fragment'), etc.
        const fragRe = /loadFragment\(\s*['"`]([^'"`]+)['"`]/g;
        while ((m = fragRe.exec(content)) !== null) {
            record('fragments', m[1], file, content, m.index, 'code-loaded fragment (unreachable by content crawl)');
        }
        // 2. nav/footer via getMetadata('nav'|'footer') — metadata-overridable default.
        const metaRe = /getMetadata\(\s*['"`](nav|footer)['"`]\s*\)/g;
        while ((m = metaRe.exec(content)) !== null) {
            record('navFooter', `/${m[1]}`, file, content, m.index, `metadata-overridable (<meta name="${m[1]}">)`);
        }
        // 3. Placeholder sheets: 'placeholders/<name>.json' literals (suffix normalized).
        const sheetRe = /['"`](placeholders\/[a-z0-9.-]+)['"`]/g;
        while ((m = sheetRe.exec(content)) !== null) {
            record('placeholderSheets', m[1].replace(/\.json$/, ''), file, content, m.index, 'explicit placeholder sheet');
        }
        // 4. Customer/auth pages referenced as literals in executable code.
        const custRe = /['"`](\/customer\/[a-z0-9-]+)['"`]/g;
        while ((m = custRe.exec(content)) !== null) {
            record('customerPages', m[1], file, content, m.index, 'referenced by storefront code');
        }
    }

    const toArr = (map) => [...map.entries()]
        .map(([surfacePath, meta]) => ({ path: surfacePath, ...meta }))
        .sort((a, b) => a.path.localeCompare(b.path));
    return {
        fragments: toArr(buckets.fragments),
        navFooter: toArr(buckets.navFooter),
        placeholderSheets: toArr(buckets.placeholderSheets),
        customerPages: toArr(buckets.customerPages),
    };
}

/** Reduce the rich extractor output to stable sorted path arrays (committed shape). */
export function toPathSets(result) {
    const out = {};
    for (const [cat, list] of Object.entries(result)) out[cat] = list.map((e) => e.path);
    return out;
}

/** Per-category diff of committed vs freshly-derived path sets. */
export function diffDerived(committed = {}, fresh = {}) {
    const cats = [...new Set([...Object.keys(committed), ...Object.keys(fresh)])];
    const added = {};
    const removed = {};
    let hasDrift = false;
    for (const cat of cats) {
        const c = new Set(committed[cat] || []);
        const f = new Set(fresh[cat] || []);
        const a = [...f].filter((p) => !c.has(p)).sort();
        const r = [...c].filter((p) => !f.has(p)).sort();
        if (a.length) { added[cat] = a; hasDrift = true; }
        if (r.length) { removed[cat] = r; hasDrift = true; }
    }
    return { added, removed, hasDrift };
}

/** Build the proposed file: refresh `derived` + `derivedFrom`, preserve everything else (residual). */
export function buildProposed(committed, freshPaths, sha) {
    return { ...committed, derivedFrom: sha || committed.derivedFrom, derived: freshPaths };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const SCAN_EXT = new Set(['.js', '.html']);
const SKIP_DIR = new Set(['node_modules', '.git', 'cypress', 'fonts', 'icons']);

function collectFiles(root) {
    const files = [];
    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
            if (SKIP_DIR.has(name)) continue;
            const full = join(dir, name);
            const st = statSync(full);
            if (st.isDirectory()) { walk(full); continue; }
            if (!SCAN_EXT.has(extname(name)) || name.endsWith('.d.ts')) continue;
            files.push({ path: relative(root, full), content: readFileSync(full, 'utf8') });
        }
    };
    walk(root);
    return files;
}

function deriveFrom(dir) {
    const result = extractSurfacesFromFiles(collectFiles(dir));
    return { result, paths: toPathSets(result) };
}

function emitOutput(key, value) {
    if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`, { flag: 'a' });
}

function main(argv) {
    const args = argv.slice(2);
    const mode = args[0];
    const shaIdx = args.indexOf('--sha');
    const sha = shaIdx >= 0 ? args[shaIdx + 1] : undefined;

    if (mode === 'derive') {
        const dir = args[1];
        const { paths } = deriveFrom(dir);
        console.log(JSON.stringify({ derivedFrom: sha, derived: paths }, null, 2));
        return 0;
    }

    if (mode === 'check') {
        const dir = args[1];
        const file = args[2];
        let committed;
        try {
            committed = JSON.parse(readFileSync(file, 'utf8'));
        } catch {
            console.error(`[derive-surfaces] no committed surfaces file at ${file} — skipping`);
            return 0;
        }
        const { result, paths } = deriveFrom(dir);
        const diff = diffDerived(committed.derived || {}, paths);

        if (!diff.hasDrift) {
            console.error(`[derive-surfaces] ✓ surfaces match committed derived set (${file})`);
            emitOutput('surfaces_changed', 'false');
            return 0;
        }

        // Drift: report with provenance, write the proposed refresh for the workflow PR.
        console.error(`[derive-surfaces] ⚠ SURFACE_DRIFT in ${file}:`);
        const provOf = (cat, p) => (result[cat] || []).find((e) => e.path === p)?.provenance || '?';
        for (const [cat, list] of Object.entries(diff.added)) {
            for (const p of list) console.error(`    + ${cat}: ${p}   (${provOf(cat, p)})`);
        }
        for (const [cat, list] of Object.entries(diff.removed)) {
            for (const p of list) console.error(`    - ${cat}: ${p}   (no longer referenced in canonical)`);
        }
        writeFileSync(`${file}.proposed`, `${JSON.stringify(buildProposed(committed, paths, sha), null, 2)}\n`);
        emitOutput('surfaces_changed', 'true');
        console.log('SURFACE_DRIFT');
        return 0;
    }

    console.error('usage: derive-surfaces.mjs derive <dir> | check <dir> <surfaces.json> [--sha <sha>]');
    return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    process.exit(main(process.argv));
}
