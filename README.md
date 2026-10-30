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
| `last-known-good` + `.github/workflows/lkg-gate.yml` + `scripts/lkg-gate.sh` | The drift gate (this repo) | Track canonical, advance the LKG pointer, publish the release Demo Builder reads, automate patch retirement |

Background and rationale: **ADR-006 "Thin-Layer Storefront Customization"** in the
`demo-builder-vscode` repo (`docs/architecture/adr/006-thin-layer-storefront-customization.md`).

## Layout

```
citisignal/
  patches.json              content patches (DA.live HTML)
citisignal-b2b/
  code-patches.json         CitiSignal's code patches against the B2B template (+ demo-team blocks)
b2b/
  code-patches.json         3 patches against the B2B template
  runtime-surfaces.json     derived runtime-surface inventory + human residual (ADR-008)
  last-known-good           B2B template SHA storefronts build from
last-known-good             default canonical SHA (hlxsites). No ledger advances it since
                            2026-10-17, but keep it: Demo Builder projects created
                            2026-06-10..06-19 from `custom` read it on update checks
scripts/lkg-gate.sh         the drift-gate check script
scripts/derive-surfaces.mjs runtime-surface derivation + drift check (ADR-008)
tests/                      bash unit + integration tests for the gate
.github/workflows/lkg-gate.yml   daily cron + PR-time gate
```

### Multiple canonicals

A ledger with no `canonical` tracks Adobe's `hlxsites/aem-boilerplate-commerce` and the
root `last-known-good`. Both ledgers in use today override that, declaring the B2B
template and its LKG file:

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
one canonical can move forward while another stays pinned, if only one canonical's
patches still verify.

The `citisignal` and `custom` code ledgers (both against hlxsites) were deleted on
2026-10-17: no Demo Builder package read either. CitiSignal's storefronts are built
from the B2B template and read `citisignal-b2b`.

## Code patches (`code-patches.json`)

Each patch is a named, precondition-anchored string replacement:

```json
{
  "id": "kebab-case-stable-id",
  "target": "scripts/commerce.js",
  "description": "one-line what + why",
  "precondition": "a unique substring of the target file's current content",
  "replacement": "the patched version of that substring",
  "exit": "how this patch becomes obsolete (today: Adobe fixes it itself; we do not file upstream)",
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

Every patch, what it fixes, and why it's necessary. **Ledgers**: C = citisignal-b2b,
B = b2b. A patch in multiple ledgers is the identical
precondition/replacement against each ledger's canonical.

#### SKU URLs — no patch (C, B)

PDPs live at `/products/{urlKey}/{sku}`, and canonical's `getProductLink` cleans
both segments with `sanitizeName()` — the same rule Helix applies to every path it
publishes, so the link and the published page always agree. Canonical's
`getProductSku()` reads `<meta name="sku">` first and the URL only as a fallback;
the `render-pdp` overlay (`accs-discovery-service`) writes that tag into each
product page at publish time. That is Adobe's own `aem-commerce-prerender`
design, so this ledger carries nothing for it.

There used to be two patches here (`product-link-sku-encoding`,
`product-link-sku-slash-encoding`) that put a reversible `_HH` encoding in the URL
instead. Helix rewrote the `_` to `-` on publish, so every SKU containing one
404'd. They were removed with ADR-024 in the `demo-builder-vscode` repo, which
supersedes ADR-007.

#### product-teaser → canonical `getProductLink` (C)

`product-teaser` is a **demo-team custom block** (lives in
`demo-system-stores/accs-citisignal`, not in Adobe canonical or the b2b template).
It hand-built its "Details" link via `rootLink(\`/products/${urlKey}/${sku}\`)`,
**bypassing `getProductLink`** — so its link kept the SKU's case and
underscores, which Helix strips on publish, and missed the page. These route it
through the canonical builder (which every Adobe product block already uses), so
it builds the same Helix-clean path.

- **`product-teaser-sku-encoding`** — the Details link calls
  `getProductLink(urlKey, sku)` instead of hand-building it.
- **`product-teaser-getproductlink-import`** — swaps the block's `rootLink` import
  for `getProductLink` (its only `rootLink` use was that link).

#### Defensive / rendering fixes

- **`header-nav-tools-defensive`** — `blocks/header/header.js` (C, B). Creates
  the `.nav-tools` section when it's missing. DA.live strips empty divs during
  content processing, leaving header.js to throw "Cannot read properties of null".
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

**Removed 2026-10-17, because they never acted on a shipped storefront** (found by
the patch canary; owner: "if the fix never runs, it's dead"):

- `commerce-account-sidebar-selector-race` patched the `commerce-account-sidebar`
  block. Every shipped package takes its account pages from Adobe's B2B content
  (`adobe-commerce/boilerplate-b2b`, directly or as the account overlay over the
  CitiSignal brand), and those pages use `commerce-account-nav`. The overlay replaces
  the four CitiSignal pages that used the sidebar block, so it ran nowhere.
- `account-page-column-layout` laid out sections with authored column widths on a
  page not marked with the Columns template. Adobe's own `applyTemplates` lays out a
  marked page, and every page with column widths in the shipped content sources is
  marked (CitiSignal: 15 of 123 pages have widths, all marked; the B2B and Bodea
  sources: none outside the marked account pages). It added nothing.

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
| **OBSOLETE** | precondition gone, replacement already present byte for byte (upstream ships our exact fix) | red; remove the patch from that ledger, as a commit straight to main |
| **REANCHORABLE** | precondition gone, but present exactly once if only whitespace is normalised (upstream reformatted it) | red; open a PR with the new anchor (`scripts/reanchor.mjs`) |
| **FIXED_DIFFERENTLY** | precondition gone, replacement absent, no whitespace-only match | red; Claude drafts a rewrite as a PR (below) |
| **MULTI_MATCH** | precondition matches more than once (unsafe) | red; tighten the anchor |
| **MISSING** | target absent in both clones | red |

`.github/workflows/lkg-gate.yml`:

- **Daily cron + manual dispatch:** run the gate. If all patches are green and
  canonical's FILES moved (`canonical_moved` compares file trees, not commit ids:
  the B2B template's own sync workflow re-makes its top two commits every night over
  the same files, so the id alone changes daily), commit `chore(lkg): advance to <sha7>`. If upstream
  now ships a patch's replacement byte for byte, remove that patch from THAT
  ledger only (a patch shared by ledgers on two canonicals may be fixed in one)
  as a commit straight to main: it changes no storefront byte. If upstream only reformatted a
  patched region, open a PR with the new anchor for a person to merge. A real
  change (FIXED_DIFFERENTLY) waits for a person. On any non-green patch, the
  pointer does not advance and no release is published.
- **Then, still all green: publish a release** whenever `main` has moved past the
  latest release (`v1.1.0` → `v1.1.1`), naming the verified canonical commits.
  Demo Builder reads the ledgers and the pointers at the **latest release**, never
  at `main`, so this step is what carries a verified boilerplate (or a merged
  ledger change, once a daily run has verified it) to storefronts and to Check for
  Updates. Nobody has to cut a release by hand. Until 2026-10-16 somebody did, and
  nobody did for seven weeks: `v1.0.0` (2026-08-28) stayed the baseline while this
  gate verified 73 newer upstream commits.
- **Pull requests to `main`:** run the same gate as a review-time check and fail
  the run if any precondition broke. Never advances the pointer.
- **No notification integration** (owner preference): a red run is the signal.
- **A patch upstream truly broke (FIXED_DIFFERENTLY) is drafted by Claude.** The
  gate saves the patch, canonical's current file and canonical's change to it
  under `.lkg-proposals/broken/`; `anthropics/claude-code-action` (pinned to a
  commit) edits only that patch's ledger entry and writes a plain-English
  explanation, with file tools only (no shell, no git).
  `scripts/verify-rewrite.mjs` then requires each new precondition to occur
  exactly once in canonical's file; only then is one PR opened per set of broken
  patches, and a re-run while it is open does not ask again. A person approves the
  PR's checks, reads the diff and merges: fitting is not the same as working.
  Claude authenticates with the owner's Claude Code subscription through the
  `CLAUDE_CODE_OAUTH_TOKEN` secret (`claude setup-token`); a rejected or expired
  token turns the run red with the renewal steps. Proven live on 2026-10-16 on a
  test branch where the b2b header patch was broken on purpose: Claude's draft
  was byte-identical to the real patch, with a correct plain-English explanation.
- **Repo setting this needs:** "Allow GitHub Actions to create and approve pull
  requests" (Settings, Actions, General). Without it every PR the workflow opens
  fails. It was off until 2026-10-16 (so no retirement or surface-drift PR could
  have opened; none had been needed yet) and was turned on that day (owner).
- **A PR this workflow opens queues its checks, but GitHub holds them** until a
  maintainer presses "Approve and run" on the PR. The re-anchor matches exactly
  once in canonical by construction; approving the check is how a person sees it
  verified before merging. Merge without approving and the held checks fail once
  the branch is deleted, which sends a failure email for a run that never ran.
- **Proven end to end on 2026-10-16** in two throwaway repos (a copy of this one
  and of the B2B template, with one line reformatted and one fix shipped
  verbatim): the exact fix was retired from just the two B2B ledgers, re-anchor
  PRs opened, merging them turned the next run green and published a release,
  and a run with nothing new published nothing. The test also found `all_ok`
  reporting only the FIRST ledger (fixed) and removal PRs whose queued checks
  failed on a deleted branch and emailed the owner (removal is now a commit).

## The patch canary (`canary.yml`)

The drift gate proves each patch's TEXT still applies. The canary proves the patched
storefront still BEHAVES. `scripts/canary-check.mjs` opens a scratch Demo Builder
storefront built from the tested version (`patch-canary-b2b`, on the CitiSignal B2B
store) in a browser and checks each B2B patch by what it is for:

| Patch | Check |
|---|---|
| `header-nav-tools-defensive` | the header renders when the menu arrives without its tools section (served that way on purpose) |
| `aem-assets-sku-sanitization` | an image for SKU `CANARY/SLASH-1` is named `CANARY-SLASH-1`, slash replaced |
| `pdp-empty-data-redirect` | a published product page whose SKU does not exist lands on the 404 page (a real product page, the control, does not) |

Every patch is also checked for its replacement text in the file the live site serves.
A patch with no behaviour check says so in the report, so a new patch cannot pass on
its text alone unnoticed. Each run reports per patch: works, broken, or could not check;
anything but "works" fails the run.

**Then it checks the checks.** The same run is repeated with Adobe's unpatched files (at
the tested commit) served in place of the live ones. Every check must then fail; one
that still passes is testing nothing, and fails the run.

Runs after each green gate run, daily at 09:47 UTC, and by hand.

**First it updates the canary, the way an SC's Check for Updates would.** Before the checks,
the workflow builds the Demo Builder extension's own update command (`npm run
build:canary-update` in `skukla/demo-builder-vscode`, at the branch named by `EXTENSION_REF`)
and runs it on the canary: the same merge to the tested version, patch re-apply and restore
of Demo Builder's files that an SC's project takes. Running the extension's code rather than
a copy here means the canary tests what SCs actually get.

- `canary/b2b.last-synced` holds the template commit the canary last matched. The run reads
  it, and commits the new one when the update moved the canary.
- After a push, `scripts/canary-wait-for-code.mjs` waits (up to 10 minutes) until the live
  site serves the pushed code, so the checks see the updated storefront.
- "No template change to apply" is the normal result on a day the tested version did not
  move.

It needs two settings on this repo:

| Setting | What | When it breaks |
|---|---|---|
| secret `CANARY_REPO_TOKEN` | fine-grained token, Contents read and write on `skukla/patch-canary-b2b` only, one year | expired: the update step fails with 401; save a new one with `gh secret set CANARY_REPO_TOKEN --repo skukla/eds-demo-patches` |
| variable `EXTENSION_REF` | the extension branch to build the update from; `master` once the release carrying it merges | a deleted branch: the checkout step fails |

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
definitions and the LKG pointer: at the latest release. A merged surface-drift PR
reaches storefronts on their next create/reset after the next green daily run
publishes a release.

## Running locally

```bash
# Full drift gate (clones canonical + demo-team block source over the network).
# Exits 0 and prints the verified canonical SHA on success.
bash scripts/lkg-gate.sh

# Tests (offline, no network):
bash tests/lkg-gate.test.sh              # unit: classification + resolution
bash tests/lkg-gate.integration.test.sh  # main() flow incl. obsolete detection and re-anchoring
node --test scripts/reanchor.test.mjs    # unit: whitespace-only re-anchoring
node --test scripts/verify-rewrite.test.mjs  # unit: is a drafted rewrite fit to propose
node --test scripts/derive-surfaces.test.mjs  # unit: surface derivation + drift diff
node --test scripts/canary-wait-for-code.test.mjs  # unit: the canary compares code as the live site serves it

# Runtime-surface check against a local boilerplate clone (ADR-008):
node scripts/derive-surfaces.mjs derive <clone-dir>                       # print derived set
node scripts/derive-surfaces.mjs check  <clone-dir> b2b/runtime-surfaces.json --sha <sha>
```

A green local run whose stdout SHA equals `last-known-good` confirms the ledger
applies against current canonical. If preconditions don't match, the patches are
wrong — fix them before committing.
