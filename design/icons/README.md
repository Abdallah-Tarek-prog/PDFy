# Meletiq PDF app icon

Selected: the user's **A / Profile** eagle, in its original navy and gold.
The transparent vector master is `public/brand/mark.svg`. The app icon is
`public/brand/app-icon.svg`, with a white rounded backing to keep the navy eagle visible
on dark title bars and taskbars. `host/pdfy.ico` and `store/Assets` are generated from it.

## Earlier exploration

Five original, scalable vector directions in the Graphite and Sage brand colours. Compare at 16, 32 and 64 pixels, not only enlarged.

- **A. Split Page** — A folded sheet split between paper and sage, expressing screenshot theme conversion. Source: `public/brand/options/split-page.svg`.
- **B. Folded P** — A memorable P monogram with a folded paper corner. Recommended for the app and Store. Source: `public/brand/options/folded-p.svg`.
- **C. Ink Fold** — A page and pen nib, emphasizing tablet writing and annotation. Source: `public/brand/options/ink-fold.svg`.
- **D. Phase** — A refined version of the existing light/dark mark. Most familiar, less specific to PDFs. Source: `public/brand/options/phase.svg`.
- **E. Study Layers** — Overlapping documents with a precise margin mark, emphasizing notes and collections. Source: `public/brand/options/study-layers.svg`.

These five earlier options remain archived; the selected production mark is the eagle above.

To regenerate raster and Windows assets: build the app, run `node tests/browser-run.mjs --fixture brand-assets.js`, then `node scripts/build-brand.mjs`. The fixture also checks the current app name and captures real-size icon previews on light and dark surfaces.
