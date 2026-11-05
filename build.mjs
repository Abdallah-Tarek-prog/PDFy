// Bundles the app and copies only the engine files it needs into dist.
import { build, context } from 'esbuild';
import { cp, mkdir, rm, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');
const out = 'dist';

const common = {
  bundle: true, minify: !watch, sourcemap: watch, format: 'esm', target: 'es2022',
  logLevel: 'warning', legalComments: 'none',
};

const entries = [
  { entryPoints: ['src/main.ts'], outfile: `${out}/app.js` },
  { entryPoints: ['src/workers/edit.worker.ts'], outfile: `${out}/edit.worker.js` },
  { entryPoints: ['src/workers/theme.worker.ts'], outfile: `${out}/theme.worker.js` },
];

async function dirSize(d) {
  let total = 0;
  for (const e of await readdir(d, { withFileTypes: true })) {
    total += e.isDirectory() ? await dirSize(join(d, e.name)) : (await stat(join(d, e.name))).size;
  }
  return total;
}

async function copyStatic() {
  await mkdir(`${out}/vendor`, { recursive: true });
  await cp('public', out, { recursive: true });
  const pdfjs = 'node_modules/pdfjs-dist';
  await cp(`${pdfjs}/build/pdf.worker.min.mjs`, `${out}/vendor/pdf.worker.min.mjs`);
  for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) await cp(`${pdfjs}/${d}`, `${out}/vendor/${d}`, { recursive: true });
  await cp('vendor-ocr', `${out}/vendor/ocr`, { recursive: true, force: true }).catch(() => {});
  await cp('vendor-extra', `${out}/vendor/extra`, { recursive: true, force: true }).catch(() => {});
  await cp('vendor-math', `${out}/vendor/math`, { recursive: true, force: true }).catch(() => {});
  await cp('vendor-dict', `${out}/vendor/dict`, { recursive: true, force: true }).catch(() => {});
}

// Outside the dist folder there may be an older copy of the app using these files.
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await copyStatic();

if (watch) {
  for (const e of entries) {
    const ctx = await context({ ...common, ...e });
    await ctx.watch();
  }
  console.log('Watching for changes');
} else {
  await Promise.all(entries.map(e => build({ ...common, ...e })));
  console.log(`Built ${out}: ${((await dirSize(out)) / 1048576).toFixed(1)} MB`);
}
