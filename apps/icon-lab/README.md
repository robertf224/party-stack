# Icon Lab

Local workshop for building and validating the provider-neutral `@party-stack/icons` universal set.

## What it does

1. **Archives every icon** from:
    - Blueprint / Foundry (`@blueprintjs/icons`)
    - Lucide (`@lucide/icons`)
    - Material Symbols (`@iconify-json/material-symbols`)
    - Salesforce Lightning action/custom/doctype/standard/utility icons (`@salesforce-ux/icons`)
    - SF Symbols names (`sf-symbols-typescript`)
2. **Embeds** each icon with CLIP text semantics (`Xenova/clip-vit-base-patch32`) plus a normalized 16×16 image descriptor when a glyph exists.
3. **Drafts a mapping for every Blueprint icon**, keeping existing package mappings fixed and proposing the closest icon from every other provider.
4. **Audits** existing and generated mappings with pairwise cosine similarity and nearest-neighbor search.

## Compact storage

The browser loads one normalized snapshot per redistributable provider from
`public/icon-sets/`. Those compact archives and their source manifest are the only icon
data committed, so development never depends on mutable upstream URLs. The catalog,
mapping drafts, audits, and multimodal embeddings are all downstream data generated in
the already-ignored `temp/data/` directory. Vite serves them at `/generated-data/` in
development and includes them in production bundles.

`icon-sources.json` records the package, source tarball URL, version, homepage, and
license for every provider. The archive script resolves installed versions so a package
update automatically records the new tarball URL.

## Commands

```bash
pnpm install --filter @party-stack/icon-lab
vp run @party-stack/icon-lab#icons:archive   # explicitly refresh checked-in snapshots
vp run @party-stack/icon-lab#icons:catalog   # derive catalog in temp/
vp run @party-stack/icon-lab#icons:embed     # CLIP + draft mappings (cached)
pnpm --filter @party-stack/icon-lab icons:update          # update sources, then prepare
vp run @party-stack/icon-lab#dev           # open the URL printed by Vite+
```

Before using the app on a fresh checkout, run `vp run @party-stack/icon-lab#icons:embed`
explicitly. It derives the catalog from committed snapshots and generates the CLIP
embeddings and draft mappings in ignored `temp/data`. Generation can take several minutes;
rerun it when icon sources or the embedding pipeline change.

Normal `dev`, `build`, `test`, and workspace CI tasks never generate embeddings.
Builds include prepared data when it exists, and otherwise compile the app with a
warning. The app needs prepared data to function, so generate it before using the
app or creating a bundle for deployment. `icons:archive` remains an explicit
one-off task because it refreshes checked-in provider snapshots.

Mapping review decisions and concept confirmations are saved in browser local storage.
Resolve each provider with an approval or replacement, then confirm the universal
mapping. The review can be filtered to all, in-progress, or confirmed concepts.

In Cloud Agent development, every change automatically saves to the ignored local file
`temp/data/icon-mapping-feedback.json`; **Save now** retries immediately if needed.
**Download JSON** remains available as a portable backup. Prompt the agent to apply the
review when ready; the agent updates and commits the typed provider mapping packages,
not this temporary feedback file.

## SF Symbols glyphs

Only the MIT-licensed symbol-name catalog is committed here. Apple glyph exports stay
local so the repository and built app do not redistribute them.

Install the official SF Symbols app on macOS, export local PNG previews with its bundled
CLI, then point the pipeline at that ignored directory:

```bash
pnpm icons:sf:export
SF_SYMBOLS_ASSET_DIR="$PWD/temp/sf-symbols" \
    vp run @party-stack/icon-lab#icons:embed
```

You can also supply your own directory of `<symbol-name>.png` or
`<symbol-name>.svg` exports.

`icons:catalog` packages matching exports into ignored `temp/data/sfsymbols.local.zip`.
The lab serves that local archive for previews and `icons:embed` uses the same images for
visual descriptors. Neither the images nor their derived archive are committed.
