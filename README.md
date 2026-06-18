# eds-demo-patches

External patch definitions for Demo Builder's thin-layer EDS storefronts. Demo
Builder no longer ships CitiSignal from a fork of Adobe's canonical
[`hlxsites/aem-boilerplate-commerce`](https://github.com/hlxsites/aem-boilerplate-commerce);
it clones canonical at a verified commit and applies the customizations in this
repo as a thin layer at storefront create/reset time.

This repo plays three roles:

| Artifact | Consumed by | Purpose |
|---|---|---|
| `*/patches.json` | Demo Builder `contentPatchRegistry` | **Content patches** — transform authored DA.live HTML during content copy |
| `*/code-patches.json` | Demo Builder `codePatchRegistry` | **Code patches** — transform cloned-repo files during create/reset |
| `last-known-good` + `.github/workflows/lkg-gate.yml` + `scripts/lkg-gate.sh` | The drift gate (this repo) | Track canonical, advance the LKG pointer, automate patch retirement |

Background and rationale: **ADR-006 "Thin-Layer Storefront Customization"** in the
`demo-builder-vscode` repo (`docs/architecture/adr/006-thin-layer-storefront-customization.md`).

## Layout

```
citisignal/
  patches.json              content patches (DA.live HTML)
  code-patches.json         code patches (canonical + demo-team block files)
custom/
  code-patches.json         2 universal patches against canonical (header + sidebar)
b2b/
  code-patches.json         5 patches (universal + SKU/slash) against the B2B template
  runtime-surfaces.json     derived runtime-surface inventory + human residual (ADR-008)
  last-known-good           B2B template SHA storefronts build from
last-known-good             default canonical SHA (hlxsites) — shared by citisignal + custom
scripts/lkg-gate.sh         the drift-gate check script
scripts/derive-surfaces.mjs runtime-surface derivation + drift check (ADR-008)
tests/                      bash unit + integration tests for the gate
.github/workflows/lkg-gate.yml   daily cron + PR-time gate
```

### Multiple canonicals

Most ledgers track Adobe's canonical `hlxsites/aem-boilerplate-commerce` and share the
root `last-known-good`. A ledger can override that by declaring its own canonical and
LKG file path:

```json
{
  "version": "1.0.0",
  "canonical": "https://github.com/adobe-commerce/boilerplate-b2b-template.git",
  "lkgFile": "b2b/last-known-good",
  "patches": [...]
}
```

The drift gate clones each unique canonical once per run and verifies each ledger
against its own canonical. The workflow advances each LKG pointer independently —
B2B can move forward while citisignal+custom stay pinned (or vice versa) if only
one canonical's patches still verify.

## Code patches (`code-patches.json`)

Each patch is a named, precondition-anchored string replacement:

```json
{
  "id": "kebab-case-stable-id",
  "target": "scripts/commerce.js",
  "description": "one-line what + why",
  "precondition": "a unique substring of the target file's current content",
  "replacement": "the patched version of that substring",
  "exit": "how this patch becomes obsolete (upstream PR → delete on merge, etc.)",
  "critical": false
}
```

- **Precondition must be a unique substring** of its target. The engine does a
  first-occurrence `String.replace`; a non-unique precondition silently patches
  the wrong region. The drift gate fails any patch whose precondition matches
  more than once.
- **Phase routing is mechanical, by `target`** — no phase field. Targets under
  `blocks/` apply **post-install** (after block-library installation, so they
  can patch installed demo-team blocks); everything else applies **pre-reset**
  (against the freshly cloned canonical files).
- **Failure is proceed-and-warn** (ADR-006 D1): a precondition that no longer
  matches yields a non-applied result surfaced in one toast, never a silent
  skip. Set `"critical": true` (default off) to hard-abort instead.
- **Every patch declares an `exit`.** A patch is a liability with an exit plan,
  not a customization mechanism — additive or upstream-first is the default. The
  steady-state ledger is single-digit (~6–8 patches).

### Patch reference — what each patch does and why

Every patch, what it fixes, and why it's necessary. **Ledgers**: C = citisignal,
B = b2b, U = custom. A patch in multiple ledgers is the identical
precondition/replacement against each ledger's canonical.

#### SKU URL encoding — `scripts/commerce.js` (C, B)

PDPs live at `/products/{urlKey}/{sku}`. Canonical slugifies the SKU into the URL
with the lossy `sanitizeName()` and then reverse-engineers the slug back into a
SKU on PDP load to query Commerce. That round-trip silently fails for any SKU
with spaces, punctuation, or mixed case (Commerce returns nothing → blank PDP).
These two patches replace it with a **reversible, lowercase-stable, Helix-path-safe**
encoding. Clean SKUs (`[a-z0-9-]`) encode unchanged, so common catalogs see no
URL change; only messy SKUs gain `_HH` markers. Full rationale + the ruled-out
alternatives (`encodeURIComponent`, urlKey-resolve) are in **ADR-007** in the
`demo-builder-vscode` repo.

- **`product-link-sku-encoding`** — adds the `encodeSkuForUrl` / `decodeSkuFromUrl`
  helpers and decodes the SKU segment in `getSkuFromUrl()` before the Commerce
  lookup.
- **`product-link-sku-slash-encoding`** — `getProductLink()` builds links with
  `encodeSkuForUrl(sku)` instead of `sanitizeName(sku)`. *(Id is historical — it
  now does full reversible encoding, not just forward slashes.)*

> ⚠️ **Coupling:** these two replacements mirror
> `demo-builder-vscode/src/features/eds/services/pdpUrlEncoding.ts` **byte-for-byte**
> — the extension builds prewarm/publish paths with that module, and a published
> path must match the link the storefront generates. Change both together.

#### product-teaser → canonical `getProductLink` (C)

`product-teaser` is a **demo-team custom block** (lives in
`demo-system-stores/accs-citisignal`, not in Adobe canonical or the b2b template).
It hand-built its "Details" link via `rootLink(\`/products/${urlKey}/${sku}\`)`,
**bypassing `getProductLink`** — so it missed the SKU encoding entirely. Rather
than give it its own copy of the encoder, these route it through the canonical
builder (which every Adobe product block already uses), so it inherits the
encoding and urlKey sanitization for free.

- **`product-teaser-sku-encoding`** — the Details link calls
  `getProductLink(urlKey, sku)` instead of hand-building it.
- **`product-teaser-getproductlink-import`** — swaps the block's `rootLink` import
  for `getProductLink` (its only `rootLink` use was that link).

#### Defensive / rendering fixes

- **`header-nav-tools-defensive`** — `blocks/header/header.js` (C, B, U). Creates
  the `.nav-tools` section when it's missing. DA.live strips empty divs during
  content processing, leaving header.js to throw "Cannot read properties of null".
- **`commerce-account-sidebar-selector-race`** —
  `blocks/commerce-account-sidebar/commerce-account-sidebar.js` (C, B, U). Also
  matches the authored `main > div > ol > li` structure so a freshly-published
  storefront's account sidebar isn't empty — the post-decoration class it
  originally queried races against EDS's decoration pipeline.
- **`aem-assets-sku-sanitization`** —
  `scripts/__dropins__/tools/lib/aem/assets.js` (C, B). Replaces `/` with `-` in
  SKU image aliases so SKUs containing forward slashes produce valid AEM Assets
  delivery URLs. One dropin patch instead of 14+ per-block import swaps.
- **`product-teaser-image-url-handling`** —
  `blocks/product-teaser/product-teaser.js` (C). Renders standard Commerce media
  URLs directly instead of forcing every image through the AEM Assets delivery
  path, which would break non-AEM-Assets image sources.

`product-teaser*` patches target a demo-team block (sourced live from
`demo-system-stores/accs-citisignal`, not canonical) and apply post-install. The
gate resolves each target against canonical first, then the block source.

**Not yet in the ledger (deferred):**

- **CSS brand theming** — ADR-006 consolidates ~11 CSS theming files into a
  single vendor point (a `<link>` in `head.html` + an additive brand
  stylesheet). That is an additive-asset mechanism, not a precondition/
  replacement code patch, and needs a hosting + content-extraction decision; it
  is tracked separately, not in this ledger.
- **`scripts/aem.js` `createOptimizedPicture` origin fix** — verified already
  present in current canonical (the fork differed only in line formatting), so
  it would be born obsolete and is intentionally omitted.

## The last-known-good drift gate

Demo Builder builds storefronts from the canonical commit recorded in
`last-known-good` — not raw `main`, not a hand-maintained pin. The pointer is
advanced by automation, the same release-engineering pattern as Chromium's LKGR
or Nix channel promotion. `last-known-good` holds **only** the 40-char SHA; its
git history is the audit log of which boilerplate version storefronts received
when (rich detail lives in the advance commit messages).

`scripts/lkg-gate.sh` clones canonical (and the demo-team block source) and
classifies every patch:

| Classification | Meaning | Gate action |
|---|---|---|
| **OK** | precondition matches uniquely | green |
| **OBSOLETE** | precondition gone, replacement already present (fix landed upstream) | red; open a retirement PR |
| **FIXED_DIFFERENTLY** | precondition gone, replacement absent | red; log region for human triage |
| **MULTI_MATCH** | precondition matches more than once (unsafe) | red; tighten the anchor |
| **MISSING** | target absent in both clones | red |

`.github/workflows/lkg-gate.yml`:

- **Daily cron + manual dispatch:** run the gate. If all patches are green and
  canonical moved, commit `chore(lkg): advance to <sha7>`. If a patch is
  obsolete, open a retirement PR (automation proposes; a human merges — never
  auto-delete, since upstream equivalence can be subtle). On partial pass, do
  nothing — the pointer simply stops advancing.
- **Pull requests to `main`:** run the same gate as a review-time check and fail
  the run if any precondition broke. Never advances the pointer.
- **No notification integration** (owner preference): a red run is the signal.

## The runtime-surface drift check (ADR-008)

A working storefront fetches content documents at runtime that the CDN content
index omits and that nothing in the published content links to — config sheets,
the nav/footer fragments, code-loaded fragments like `/customer/sidebar-fragment`,
placeholder sheets. Demo Builder copies these from a **declared inventory**.
Hand-maintaining that inventory is exactly the kind of list that drifts (it was
already missing 8 real B2B surfaces — see ADR-008). This check keeps it honest by
**deriving the list from the boilerplate code** the gate already clones.

`scripts/derive-surfaces.mjs` statically scans the canonical clone for the paths
the code fetches (`loadFragment('…')`, `getMetadata('nav')`, `fetchPlaceholders('placeholders/…')`,
`/customer/*` literals) and diffs that against a ledger's `runtime-surfaces.json`:

```jsonc
{
  "derivedFrom": "<canonical sha>",
  "derived":  { /* MACHINE-OWNED — regenerated by the gate; do not hand-edit */ },
  "residual": { /* HUMAN-OWNED — platform/content surfaces no scan can derive */ }
}
```

- The gate runs the check **per ledger, against that ledger's own canonical clone**,
  right after patch verification. It is **advisory** — drift never affects the patch
  pass/fail or the LKG pointer (a missing orphan should propose a fix, not freeze
  patch currency).
- On drift it writes `runtime-surfaces.json.proposed` (refreshed `derived`, `residual`
  preserved) and the workflow opens **one** `lkg/surface-drift` PR. Automation
  proposes; a human merges — per-surface provenance (`file:line`) is in the gate logs.
- The check only governs the `derived` block. The `residual` block (the Helix
  platform conventions `/metadata`, `/redirects`, `/sitemap`, plus content-linked
  entry points) is human-owned and never touched — that is the small, stable part
  no static scan can produce.

The extension consumes `runtime-surfaces.json` the same way it consumes patch
definitions and the LKG pointer, so a merged surface-drift PR reaches storefronts on
their next create/reset.

## Running locally

```bash
# Full drift gate (clones canonical + demo-team block source over the network).
# Exits 0 and prints the verified canonical SHA on success.
bash scripts/lkg-gate.sh

# Tests (offline, no network):
bash tests/lkg-gate.test.sh              # unit: classification + resolution
bash tests/lkg-gate.integration.test.sh  # main() flow incl. obsolete detection
node --test scripts/derive-surfaces.test.mjs  # unit: surface derivation + drift diff

# Runtime-surface check against a local boilerplate clone (ADR-008):
node scripts/derive-surfaces.mjs derive <clone-dir>                       # print derived set
node scripts/derive-surfaces.mjs check  <clone-dir> b2b/runtime-surfaces.json --sha <sha>
```

A green local run whose stdout SHA equals `last-known-good` confirms the ledger
applies against current canonical. If preconditions don't match, the patches are
wrong — fix them before committing.
