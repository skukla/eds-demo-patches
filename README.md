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
  patches.json          content patches (DA.live HTML)
  code-patches.json     code patches (canonical + demo-team block files)
last-known-good         one-line canonical SHA storefronts build from
scripts/lkg-gate.sh     the drift-gate check script
tests/                  bash unit + integration tests for the gate
.github/workflows/lkg-gate.yml   daily cron + PR-time gate
```

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

### Current ledger (`citisignal/code-patches.json`)

| id | target | source | exit |
|---|---|---|---|
| `header-nav-tools-defensive` | `blocks/header/header.js` | canonical | upstream PR to hlxsites |
| `product-link-sku-encoding` | `scripts/commerce.js` | canonical | upstream PR to hlxsites |
| `product-link-sku-slash-encoding` | `scripts/commerce.js` | canonical | upstream PR to hlxsites |
| `aem-assets-sku-sanitization` | `scripts/__dropins__/tools/lib/aem/assets.js` | canonical | upstream PR to @dropins |
| `commerce-account-sidebar-selector-race` | `blocks/commerce-account-sidebar/commerce-account-sidebar.js` | canonical | upstream PR to hlxsites |
| `product-teaser-sku-encoding` | `blocks/product-teaser/product-teaser.js` | demo-team block source | PR to demo-system-stores/accs-citisignal |
| `product-teaser-image-url-handling` | `blocks/product-teaser/product-teaser.js` | demo-team block source | PR to demo-system-stores/accs-citisignal |

The two `product-teaser` patches target a demo-team block (sourced live from
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

## Running locally

```bash
# Full drift gate (clones canonical + demo-team block source over the network).
# Exits 0 and prints the verified canonical SHA on success.
bash scripts/lkg-gate.sh

# Tests (offline, no network):
bash tests/lkg-gate.test.sh              # unit: classification + resolution
bash tests/lkg-gate.integration.test.sh  # main() flow incl. obsolete detection
```

A green local run whose stdout SHA equals `last-known-good` confirms the ledger
applies against current canonical. If preconditions don't match, the patches are
wrong — fix them before committing.
