// Full feature test, run inside the app. Each test drives the real code and checks the real result,
// usually by saving a file and reading it back with a fresh engine.
const app = window.__pdfy, A = window.__api;
const results = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
const fx = async name => { const r = await fetch(`/fixtures/${name}`); return new File([await r.blob()], name, { type: 'application/pdf' }); };
const closeAll = async () => { for (const s of [...app.sessions]) { s.dirty = false; await app.closeSession(s); } };
const clickDialog = (sel = '.primary') => document.querySelector(`.overlay-bg ${sel}`)?.click();
const save = (blob, name) => fetch(`/__save/${name}`, { method: 'PUT', body: blob });

const only = window.__only ? new RegExp(window.__only, 'i') : null;

async function test(name, fn) {
  if (only && !only.test(name)) return;
  console.log('TEST', name);
  const t0 = performance.now();
  try {
    const note = await fn();
    results.push({ ok: true, name, ms: Math.round(performance.now() - t0), note });
  } catch (err) {
    results.push({ ok: false, name, error: String(err?.message ?? err) });
  }
  // A left-over dialog from a failed test must not block the next one.
  document.querySelectorAll('.overlay-bg').forEach(d => d.remove());
  const last = results[results.length - 1];
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), results }, null, 1) });
  void last;
}
const ok = (v, msg) => { if (!v) throw new Error(msg ?? 'check failed'); };
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg ?? 'values differ'}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); };

async function openSession(name) {
  const f = await fx(name);
  const s = await app.openPdfBlob(f, name);
  ok(s, `${name} did not open`);
  await settle();
  return s;
}
async function settle(ms = 4000) {
  const start = performance.now();
  while (performance.now() - start < ms) {
    const views = [...app.viewer.views.values()];
    if (views.length && views.every(v => !v.needsRender && !v.task)) break;
    await wait(40);
  }
  await wait(60);
}
const reopen = (blob, password) => A.openPdf(blob, async retry => (retry ? null : password ?? null));
const pageWords = async (pdf, i) => (await pdf.getPage(i + 1).then(p => p.getTextContent())).items.map(x => x.str).join(' ');
const annotsOf = async (pdf, i) => (await (await pdf.getPage(i + 1)).getAnnotations({ intent: 'display' }));

// ---- Opening ----

await test('Opens a normal PDF and draws the page', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  eq(s.pages.length, 12, 'page count');
  const v = [...app.viewer.views.values()][0];
  ok(v.canvas && v.canvas.width > 100, 'canvas was drawn');
  await wait(300);
  ok(v.textHost.querySelectorAll('span').length > 3, 'text layer exists');
  const ctx = v.canvas.getContext('2d');
  const d = ctx.getImageData(0, 0, v.canvas.width, v.canvas.height).data;
  let dark = 0;
  for (let i = 0; i < d.length; i += 400) if (d[i] < 100) dark++;
  ok(dark > 5, 'page has visible ink');
});

for (const [file, want] of [['empty.pdf', 'empty'], ['not-a-pdf.pdf', 'damaged'], ['truncated.pdf', ''], ['corrupted.pdf', '']]) {
  await test(`Broken file does not crash: ${file}`, async () => {
    await closeAll();
    const f = await fx(file);
    const openP = app.openPdfBlob(f, file);
    let dialogText = '';
    for (let i = 0; i < 100; i++) {
      await wait(60);
      const d = document.querySelector('.overlay-bg');
      if (d) { dialogText = d.textContent; clickDialog(); break; }
    }
    const s = await Promise.race([openP, wait(8000).then(() => 'timeout')]);
    ok(s !== 'timeout', 'hung');
    if (want) ok(dialogText.toLowerCase().includes(want), `message was: ${dialogText}`);
    // Files that open despite damage must still let the user move through pages.
    if (s) { await settle(); for (let i = 0; i < s.pages.length; i++) { app.viewer.goTo(i); await wait(120); } }
    ok(document.getElementById('app').children.length > 0, 'interface still there');
    return s ? 'opened in repaired form' : `refused: ${dialogText.slice(0, 80)}`;
  });
}

await test('Password: wrong then right', async () => {
  await closeAll();
  const f = await fx('locked.pdf');
  const openP = app.openPdfBlob(f, 'locked.pdf');
  for (const pw of ['wrong', 'secret']) {
    let input = null;
    for (let i = 0; i < 80 && !input; i++) { await wait(50); input = document.querySelector('.overlay-bg input[type=password]'); }
    ok(input, `asked for password (${pw})`);
    input.value = pw;
    clickDialog();
    await wait(300);
  }
  const s = await openP;
  ok(s, 'opened');
  eq(s.pages.length, 3);
  ok((await pageWords(s.sources.values().next().value.pdf, 0)).includes('Locked page 1'), 'decrypted text');
});

await test('Password: cancelling is handled', async () => {
  await closeAll();
  const f = await fx('locked.pdf');
  const openP = app.openPdfBlob(f, 'locked.pdf');
  for (let i = 0; i < 80; i++) { await wait(50); if (document.querySelector('.overlay-bg input[type=password]')) break; }
  document.querySelector('.overlay-bg .dialog-foot .btn:not(.primary)').click();
  eq(await openP, null, 'returned nothing');
  eq(app.sessions.length, 0);
});

// ---- Memory ----

await test('3,000 pages: memory stays flat', async () => {
  await closeAll();
  const t0 = performance.now();
  const s = await openSession('huge-3000.pdf');
  const openMs = Math.round(performance.now() - t0);
  eq(s.pages.length, 3000);
  const heap0 = performance.memory.usedJSHeapSize;
  let maxViews = 0, maxCanvas = 0, maxPx = 0;
  for (const target of [100, 500, 1500, 2200, 2999, 40, 2750, 900, 1100, 1800, 300, 2500]) {
    app.viewer.goTo(target);
    await settle(1500);
    maxViews = Math.max(maxViews, app.viewer.views.size);
    maxCanvas = Math.max(maxCanvas, app.viewer.liveCanvasCount());
    maxPx = Math.max(maxPx, app.viewer.lastPixels);
    ok(document.querySelectorAll('.page').length <= 8, 'too many pages in the document');
  }
  // Fast scrolling, 200 jumps.
  for (let i = 0; i < 200; i++) { app.viewer.scroller.scrollTop = Math.random() * app.viewer.sizer.offsetHeight; await wait(6); }
  await settle(2500);
  const heap1 = performance.memory.usedJSHeapSize;
  const heapGrowth = Math.round((heap1 - heap0) / 1048576);
  ok(maxViews <= 8, `at most a few pages exist (saw ${maxViews})`);
  ok(heapGrowth < 60, `heap grew by ${heapGrowth} MB`);
  return `opened in ${openMs} ms, max ${maxViews} pages live, ${maxCanvas} canvases, ${(maxPx / 1e6).toFixed(1)} MP, heap +${heapGrowth} MB`;
});

await test('Extreme zoom stays within the canvas limit', async () => {
  await closeAll();
  await openSession('normal.pdf');
  for (const z of [0.2, 8, 0.5, 8, 4, 1]) {
    app.viewer.setScale(z);
    await wait(320);
    await settle(2500);
    const c = [...app.viewer.views.values()].map(v => v.canvas?.width * v.canvas?.height || 0);
    ok(Math.max(...c) <= 12_100_000, `canvas too large at ${z}: ${Math.max(...c)}`);
  }
  app.viewer.setScale(8);
  await wait(400); await settle(2500); await wait(500);
  const sharp = [...app.viewer.views.values()].some(v => v.detail);
  app.viewer.setFit('width');
  return sharp ? 'detail view used at 800%' : 'no detail needed on this screen';
});

await test('Layouts: one page, two pages, continuous', async () => {
  await closeAll();
  await openSession('normal.pdf');
  app.viewer.setLayout('facing'); await settle();
  ok(app.viewer.rows[0].pages.length === 2, 'two across');
  app.viewer.setLayout('single'); await settle();
  app.viewer.goTo(5); await settle();
  eq(document.querySelectorAll('.page').length, 1, 'only one page on screen');
  app.viewer.setLayout('continuous'); await settle();
});

await test('Rotated and mixed page sizes', async () => {
  await closeAll();
  const s = await openSession('rotated-mixed.pdf');
  await wait(1200);
  const sized = s.pages.map(p => ({ r: p.baseRotate, w: p.view[2], h: p.view[3] }));
  eq(sized[1].r, 90, 'file rotation read');
  eq(sized[2].w, 842, 'real size read');
  app.viewer.goTo(1); await settle();
  const v = app.viewer.views.get(s.pages[1].id);
  ok(parseFloat(v.el.style.width) > parseFloat(v.el.style.height), 'rotated page is wide');
});

// ---- Annotations ----

const ALL_KINDS = page => {
  const base = { color: '#d92d20', opacity: 1, width: 1.5, author: 'Test', created: Date.now() };
  const id = () => Math.random().toString(36).slice(2);
  return [
    { ...base, id: id(), kind: 'highlight', color: '#ffd400', opacity: 0.5, rect: [60, 700, 300, 720], quads: [[60, 720, 300, 720, 60, 700, 300, 700]] },
    { ...base, id: id(), kind: 'underline', rect: [60, 680, 300, 695], quads: [[60, 695, 300, 695, 60, 680, 300, 680]] },
    { ...base, id: id(), kind: 'strikeout', rect: [60, 660, 300, 675], quads: [[60, 675, 300, 675, 60, 660, 300, 660]] },
    { ...base, id: id(), kind: 'squiggly', rect: [60, 640, 300, 655], quads: [[60, 655, 300, 655, 60, 640, 300, 640]] },
    { ...base, id: id(), kind: 'ink', rect: [50, 500, 200, 600], paths: [[50, 500, 100, 600, 150, 500, 200, 600]] },
    { ...base, id: id(), kind: 'rect', rect: [220, 500, 300, 560], fill: '#ffeecc' },
    { ...base, id: id(), kind: 'ellipse', rect: [320, 500, 400, 560] },
    { ...base, id: id(), kind: 'line', rect: [420, 500, 500, 560], pts: [420, 500, 500, 560] },
    { ...base, id: id(), kind: 'arrow', rect: [420, 420, 500, 480], pts: [420, 420, 500, 480] },
    { ...base, id: id(), kind: 'polygon', rect: [60, 400, 160, 480], pts: [60, 400, 160, 400, 110, 480] },
    { ...base, id: id(), kind: 'polyline', rect: [180, 400, 280, 480], pts: [180, 400, 230, 480, 280, 400] },
    { ...base, id: id(), kind: 'cloud', rect: [300, 400, 400, 480], pts: [300, 400, 400, 400, 400, 480, 300, 480] },
    { ...base, id: id(), kind: 'text', rect: [60, 340, 300, 390], text: 'A text box that says hello', textColor: '#111111', fontSize: 13, width: 0 },
    { ...base, id: id(), kind: 'text', rect: [320, 340, 560, 390], text: 'مرحبا بالعالم', textColor: '#111111', fontSize: 16, width: 0 },
    { ...base, id: id(), kind: 'callout', rect: [60, 270, 240, 320], pts: [300, 250], text: 'Callout text', textColor: '#111111', fontSize: 12, fill: '#ffffff' },
    { ...base, id: id(), kind: 'note', rect: [500, 700, 520, 720], color: '#ffe066', fill: '#ffe066', contents: 'A sticky note' },
    { ...base, id: id(), kind: 'stamp', rect: [320, 270, 450, 310], text: 'APPROVED', contents: 'APPROVED', color: '#0b8a4f' },
    { ...base, id: id(), kind: 'measure', measureType: 'distance', measureUnit: 'in', measureScale: 1 / 72, rect: [60, 200, 204, 210], pts: [60, 205, 204, 205], width: 1 },
    { ...base, id: id(), kind: 'link', rect: [60, 150, 200, 180], url: 'https://example.org/' },
  ];
};

await test('Every annotation type survives save and reopen', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  const page = s.pages[0];
  const list = ALL_KINDS(page);
  s.addAnnots(page, list, 'All');
  await settle();
  eq(page.annots.length, list.length);
  const { blob, warnings } = await A.buildFile(s);
  eq(warnings.length, 0, `warnings: ${warnings.join('; ')}`);
  await save(blob, 'annotated-output.pdf');
  const r = await reopen(blob);
  const got = await annotsOf(r.pdf, 0);
  const types = got.map(a => a.subtype).sort();
  await r.close();
  for (const want of ['Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Ink', 'Square', 'Circle', 'Line', 'Polygon', 'PolyLine', 'FreeText', 'Text', 'Stamp', 'Link']) {
    ok(types.includes(want), `missing ${want} (found ${types.join(',')})`);
  }
  eq(got.length, list.length, 'all annotations');
  return `${got.length} annotations written (${blob.size} bytes)`;
});

await test('Undo and redo restore everything', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  const page = s.pages[0];
  const [a] = ALL_KINDS(page);
  s.addAnnots(page, [a]);
  eq(page.annots.length, 1);
  s.undo(); eq(page.annots.length, 0, 'undo add');
  s.redo(); eq(page.annots.length, 1, 'redo add');
  const before = s.pages.slice();
  s.setPages(s.pages.slice(1), 'delete');
  eq(s.pages.length, 11);
  s.undo(); eq(s.pages.length, 12, 'undo delete');
  ok(s.pages.every((p, i) => p === before[i]), 'same pages back');
  ok(s.pages[0].annots.length === 1, 'annotation came back with the page');
  s.rotatePages([s.pages[0].id], 90); eq(s.pages[0].rotate, 90);
  s.undo(); eq(s.pages[0].rotate, 0, 'undo rotate');
});

await test('Editing an annotation from another app', async () => {
  await closeAll();
  const s = await openSession('annotated.pdf');
  await wait(400);
  const page = s.pages[0];
  const ghost = page.annots.find(a => a.ghost && a.kind === 'rect');
  ok(ghost, 'found the existing square');
  eq(ghost.contents, 'Square from another app', 'comment read');
  eq(ghost.author, 'Someone else', 'author read');
  // Unedited: saved file keeps exactly one square.
  let { blob } = await A.buildFile(s);
  let r = await reopen(blob);
  eq((await annotsOf(r.pdf, 0)).filter(a => a.subtype === 'Square').length, 1, 'kept');
  await r.close();
  // Edited: original replaced, not duplicated.
  const { ghost: _g, ...rest } = ghost;
  s.replaceAnnot(page, ghost, { ...rest, color: '#00ff00', rect: [120, 320, 320, 400] });
  await settle();
  ({ blob } = await A.buildFile(s));
  r = await reopen(blob);
  const squares = (await annotsOf(r.pdf, 0)).filter(a => a.subtype === 'Square');
  eq(squares.length, 1, 'replaced, not duplicated');
  eq(Math.round(squares[0].rect[0]), 120, 'moved');
  await r.close();
  // Deleted.
  const edited = page.annots.find(a => a.importedFrom === ghost.importedFrom);
  s.removeAnnot(page, edited);
  ({ blob } = await A.buildFile(s));
  r = await reopen(blob);
  eq((await annotsOf(r.pdf, 0)).filter(a => a.subtype === 'Square').length, 0, 'deleted');
  await r.close();
});

await test('Flatten: annotations become part of the page', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  s.addAnnots(s.pages[0], ALL_KINDS(s.pages[0]).filter(a => a.kind !== 'link'));
  const { blob } = await A.buildFile(s, { flattenAnnots: true });
  const r = await reopen(blob);
  eq((await annotsOf(r.pdf, 0)).length, 0, 'no annotations left');
  await r.close();
});

await test('Flatten: existing annotations too', async () => {
  await closeAll();
  const s = await openSession('annotated.pdf');
  const { blob } = await A.buildFile(s, { flattenAnnots: true });
  const r = await reopen(blob);
  const left = (await annotsOf(r.pdf, 0)).filter(a => a.subtype !== 'Link');
  eq(left.length, 0, 'square is now page content');
  await r.close();
});

// ---- Pages ----

await test('Delete, reorder, rotate, duplicate, blank, crop, then save', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  const p = s.pages;
  const blank = s.blankPage(300, 400);
  // New order: 3, 1, blank, 1-copy, 5.
  const dup = { ...p[0], id: 'dup', annots: [], removed: [] };
  p[4].rotate = 90;
  p[2].crop = [40, 100, 560, 700];
  s.setPages([p[2], p[0], blank, dup, p[4]], 'mix');
  await settle();
  const { blob } = await A.buildFile(s);
  await save(blob, 'pages-output.pdf');
  const r = await reopen(blob);
  eq(r.pdf.numPages, 5);
  ok((await pageWords(r.pdf, 0)).includes('needle3'), 'first is page 3');
  ok((await pageWords(r.pdf, 1)).includes('needle1'), 'second is page 1');
  eq((await pageWords(r.pdf, 2)).trim(), '', 'third is blank');
  ok((await pageWords(r.pdf, 3)).includes('needle1'), 'fourth is the copy');
  ok((await pageWords(r.pdf, 4)).includes('needle5'), 'fifth is page 5');
  eq((await r.pdf.getPage(5)).rotate, 90, 'rotation saved');
  const cropped = await r.pdf.getPage(1);
  eq(Math.round(cropped.view[2] - cropped.view[0]), 520, 'crop saved');
  const blankPage = await r.pdf.getPage(3);
  eq(blankPage.view[2], 300, 'blank size');
  await r.close();
  return `${blob.size} bytes`;
});

await test('Deleted pages really leave the file', async () => {
  await closeAll();
  const s = await openSession('huge-3000.pdf');
  s.setPages(s.pages.slice(0, 5), 'keep five');
  const { blob } = await A.buildFile(s, { dropDocLevel: true });
  const r = await reopen(blob);
  eq(r.pdf.numPages, 5);
  await r.close();
  ok(blob.size < 60000, `file should shrink, is ${blob.size} bytes`);
  return `3,000 pages (2.4 MB) to 5 pages (${Math.round(blob.size / 1024)} KB)`;
});

await test('Merge two PDFs, with pictures as pages', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  const extra = await s.addSource(await fx('form.pdf'), 'form.pdf');
  s.setPages([...s.pages.slice(0, 2), ...extra, s.pages[11]], 'merge');
  const { blob } = await A.buildFile(s);
  const r = await reopen(blob);
  eq(r.pdf.numPages, 4);
  ok((await pageWords(r.pdf, 2)).includes('Application form'), 'merged page');
  ok((await pageWords(r.pdf, 3)).includes('needle12'), 'last page');
  await r.close();
});

// ---- Watermark and friends ----

await test('Watermark, header and footer, page numbers, Bates', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  A.addWatermark(s, s.pages.slice(0, 2), { text: 'CONFIDENTIAL', size: 60, color: '#888888', opacity: 0.25, angle: 45 });
  A.addHeaderFooter(s, s.pages, { slots: { bc: 'Page {page} of {pages}', tl: '{file}' }, size: 10, color: '#444444', margin: 24, start: 1 });
  A.addBates(s, s.pages, { prefix: 'DOC-', suffix: '', start: 7, digits: 6, pos: 'br', size: 9, color: '#111111', margin: 18 });
  await settle();
  const { blob } = await A.buildFile(s);
  await save(blob, 'decor-output.pdf');
  const r = await reopen(blob);
  const t = await pageWords(r.pdf, 2);
  ok(t.includes('Page 3 of 12'), `numbers: ${t.slice(-120)}`);
  ok(t.includes('DOC-000009'), 'Bates number');
  ok((await pageWords(r.pdf, 0)).includes('CONFIDENTIAL'), 'watermark');
  eq((await annotsOf(r.pdf, 0)).length, 0, 'drawn into the page, not removable annotations');
  await r.close();
});

// ---- Forms ----

await test('Fill a form and read the values back', async () => {
  await closeAll();
  const s = await openSession('form.pdf');
  await wait(400);
  const src = [...s.sources.values()][0];
  const widgets = await annotsOf(src.pdf, 0);
  const name = widgets.find(w => w.fieldName === 'name');
  const agree = widgets.find(w => w.fieldName === 'agree');
  const country = widgets.find(w => w.fieldName === 'country');
  ok(name && agree && country, 'fields found');
  ok(document.querySelectorAll('.widgets .field').length >= 4, 'form controls on the page');
  // Type through the real control.
  const input = [...document.querySelectorAll('.widgets input[type=text]')][0];
  input.value = 'Abdelrahman Test';
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const check = document.querySelector('.widgets input[type=checkbox]');
  check.checked = true;
  check.dispatchEvent(new Event('change', { bubbles: true }));
  const sel = document.querySelector('.widgets select');
  sel.value = 'Jordan';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  ok(src.formsEdited, 'marked as edited');
  await settle();
  const { blob } = await A.buildFile(s);
  await save(blob, 'form-output.pdf');
  const r = await reopen(blob);
  const after = await annotsOf(r.pdf, 0);
  eq(after.find(w => w.fieldName === 'name').fieldValue, 'Abdelrahman Test', 'text value');
  ok(after.find(w => w.fieldName === 'agree').fieldValue !== 'Off', 'checkbox value');
  eq(String(after.find(w => w.fieldName === 'country').fieldValue), 'Jordan', 'dropdown value');
  await r.close();
  // Flatten removes the fields but keeps what they say.
  const flat = await A.buildFile(s, { flattenForms: true });
  const r2 = await reopen(flat.blob);
  eq((await annotsOf(r2.pdf, 0)).filter(a => a.subtype === 'Widget').length, 0, 'flattened');
  await r2.close();
});

await test('Create form fields', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  const base = { color: '#0b57d0', opacity: 1, width: 1, kind: 'rect' };
  s.addAnnots(s.pages[0], [
    { ...base, id: 'a', rect: [60, 300, 260, 324], field: { type: 'text', name: 'city' } },
    { ...base, id: 'b', rect: [60, 270, 78, 288], field: { type: 'check', name: 'ok' } },
    { ...base, id: 'c', rect: [60, 240, 260, 264], field: { type: 'dropdown', name: 'pick', options: ['One', 'Two'] } },
    { ...base, id: 'd', rect: [60, 180, 260, 234], field: { type: 'list', name: 'many', options: ['One', 'Two'] } },
    { ...base, id: 'e', rect: [300, 270, 318, 288], field: { type: 'radio', name: 'choice', options: ['Yes'] } },
    { ...base, id: 'f', rect: [300, 180, 500, 234], field: { type: 'signature', name: 'sig' } },
  ]);
  const { blob, warnings } = await A.buildFile(s);
  eq(warnings.length, 0, warnings.join('; '));
  const r = await reopen(blob);
  const names = (await annotsOf(r.pdf, 0)).filter(a => a.subtype === 'Widget').map(a => a.fieldName);
  await r.close();
  for (const n of ['city', 'ok', 'pick', 'many', 'choice', 'sig']) ok(names.includes(n), `missing ${n}: ${names}`);
});

// ---- Security ----

await test('Add a password, then remove it', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  const { blob } = await A.buildFile(s, { encrypt: { userPassword: 'abc123', ownerPassword: 'owner9', permissions: { printing: 'highResolution', copying: false } } });
  await save(blob, 'protected-output.pdf');
  let refused = false;
  try { await reopen(blob, 'nope'); } catch { refused = true; }
  ok(refused, 'wrong password was refused');
  const r = await reopen(blob, 'abc123');
  eq(r.pdf.numPages, 12);
  const pg = await r.pdf.getPage(1);
  const tc = await pg.getTextContent();
  ok(tc.items.map(x => x.str).join(' ').includes('needle1'), 'text readable with the password');
  await r.close();
});

await test('A locked file keeps its password when edited', async () => {
  await closeAll();
  const f = await fx('locked.pdf');
  const openP = app.openPdfBlob(f, 'locked.pdf');
  let input = null;
  for (let i = 0; i < 80 && !input; i++) { await wait(50); input = document.querySelector('.overlay-bg input[type=password]'); }
  input.value = 'secret';
  clickDialog();
  const s = await openP;
  await settle();
  s.addAnnots(s.pages[0], [{ id: 'x', kind: 'rect', rect: [100, 100, 200, 200], color: '#ff0000', opacity: 1, width: 2 }]);
  const { blob } = await A.buildFile(s);
  let refused = false;
  try { await reopen(blob, 'wrong'); } catch { refused = true; }
  ok(refused, 'still locked');
  const r = await reopen(blob, 'secret');
  ok((await annotsOf(r.pdf, 0)).some(a => a.subtype === 'Square'), 'edit saved');
  ok((await pageWords(r.pdf, 0)).includes('Locked page 1'), 'text intact');
  await r.close();
  // Removing the password gives a file anyone can open.
  const open = await A.buildFile(s, { removePassword: true });
  const r2 = await reopen(open.blob);
  eq(r2.pdf.numPages, 3, 'opens with no password');
  await r2.close();
});

await test('Clean metadata removes author details', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  const meta = await A.buildFile(s, { metadata: { title: 'Secret title', author: 'Secret author' } });
  let r = await reopen(meta.blob);
  eq((await r.pdf.getMetadata()).info.Title, 'Secret title', 'properties saved');
  await r.close();
  const clean = await A.buildFile(s, { stripMetadata: true });
  r = await reopen(clean.blob);
  const info = (await r.pdf.getMetadata()).info;
  ok(!info.Author && !info.Title, `leftover: ${JSON.stringify(info)}`);
  await r.close();
});

// ---- Redaction ----

await test('Redaction: the text is truly gone from the file', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  const page = s.pages[0];
  s.addAnnots(page, [{ id: 'r1', kind: 'redact', rect: [50, 550, 200, 580], color: '#000', opacity: 1, width: 0 }]);
  const n = await A.applyRedactions(s, s.pages);
  eq(n, 1);
  await settle();
  const { blob } = await A.buildFile(s);
  await save(blob, 'redacted-output.pdf');
  const r = await reopen(blob);
  eq(r.pdf.numPages, 12);
  eq((await pageWords(r.pdf, 0)).trim(), '', 'page has no text left');
  ok((await pageWords(r.pdf, 1)).includes('needle2'), 'other pages untouched');
  await r.close();
  const raw = await blob.arrayBuffer();
  const asText = new TextDecoder('latin1').decode(raw);
  ok(!asText.includes('needle1 '), 'no trace in the raw bytes');
});

// ---- Compress ----

await test('Compress really shrinks a picture-heavy PDF', async () => {
  await closeAll();
  // Build a file with a big noisy picture.
  const c = new OffscreenCanvas(2400, 3200);
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 2400, 3200);
  g.addColorStop(0, '#0a4'); g.addColorStop(1, '#f60');
  x.fillStyle = g; x.fillRect(0, 0, 2400, 3200);
  for (let i = 0; i < 9000; i++) { x.fillStyle = `hsl(${i % 360} 80% 50%)`; x.fillRect(Math.random() * 2400, Math.random() * 3200, 18, 18); }
  const png = await c.convertToBlob({ type: 'image/png' });
  const s = app.newDocument();
  const asset = await A.assetFromBlob(png);
  const annot = A.makeImageAnnot(s.pages[0], asset, 0, 0, 595, 842);
  annot.burn = true;
  s.addAnnots(s.pages[0], [annot]);
  const big = await A.buildFile(s);
  const bigFile = new File([big.blob], 'pics.pdf', { type: 'application/pdf' });
  await closeAll();
  const s2 = await app.openPdfBlob(bigFile, 'pics.pdf');
  await settle();
  const small = await A.buildFile(s2, { compress: { quality: 0.6, maxSide: 1200 } });
  ok(small.blob.size < bigFile.size * 0.7, `${bigFile.size} to ${small.blob.size}`);
  const r = await reopen(small.blob);
  eq(r.pdf.numPages, 1);
  await r.close();
  await save(small.blob, 'compressed-output.pdf');
  return `${(bigFile.size / 1048576).toFixed(1)} MB to ${(small.blob.size / 1048576).toFixed(1)} MB`;
});

// ---- Theme ----

await test('Paste with no document creates one, and stacks images', async () => {
  await closeAll();
  const blob = await window.mockGemini();
  for (let i = 0; i < 4; i++) { await window.paste(blob); await wait(350); }
  const s = app.session;
  ok(s, 'document created');
  const count = s.pages.reduce((n, p) => n + p.annots.filter(a => a.kind === 'image').length, 0);
  eq(count, 4, 'four images');
  ok(s.pages.length >= 2, 'flowed to a new page');
  // No two images overlap on the same page.
  for (const p of s.pages) {
    const r = p.annots.map(a => a.rect);
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
      const overlap = r[i][0] < r[j][2] && r[j][0] < r[i][2] && r[i][1] < r[j][3] && r[j][1] < r[i][3];
      ok(!overlap, 'images overlap');
    }
  }
  return `${s.pages.length} pages`;
});

await test('Theme: photo is kept, colours convert, buttons update, save works', async () => {
  await closeAll();
  const blob = await window.mockGemini();
  await window.paste(blob);
  await wait(900);
  const s = app.session;
  const page = s.pages[0];
  let annot = page.annots.find(a => a.kind === 'image');
  await A.ensureAnalysis(annot.image);
  ok(annot.image.analysis.photos.length >= 1, 'photo found');
  await A.applyTheme(s, page, annot, { mode: 'light', style: 'gemini', keepPhotos: true });
  annot = page.annots.find(a => a.kind === 'image');
  eq(annot.image.theme, 'light', 'state updated');
  const px = async (b, x, y) => {
    const bmp = await createImageBitmap(b);
    const c = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d');
    c.drawImage(bmp, 0, 0);
    return [...c.getImageData(x, y, 1, 1).data].slice(0, 3);
  };
  const near = (a, b, t = 3) => a.every((v, i) => Math.abs(v - b[i]) <= t);
  ok(near(await px(annot.image.blob, 1090, 10), [255, 255, 255]), 'background is white');
  ok(near(await px(annot.image.blob, 100, 600), [0xf0, 0xf4, 0xf9]), 'sidebar is Gemini light');
  // The photo is the same, pixel for pixel.
  const a = await px(annot.image.original, 480, 480), b = await px(annot.image.blob, 480, 480);
  ok(near(a, b, 0), `photo pixel changed: ${a} to ${b}`);
  // Back to the original with no loss.
  await A.applyTheme(s, page, annot, { mode: 'original', style: 'gemini', keepPhotos: true });
  annot = page.annots.find(a => a.kind === 'image');
  eq(annot.image.blob, annot.image.original, 'exact original returned');
  // Dark, undo, redo.
  await A.applyTheme(s, page, annot, { mode: 'light', style: 'github', keepPhotos: true });
  s.undo();
  eq(page.annots.find(a => a.kind === 'image').image.theme, 'original', 'undo');
  s.redo();
  eq(page.annots.find(a => a.kind === 'image').image.theme, 'light', 'redo');
  // Saved file carries the converted picture.
  const { blob: out } = await A.buildFile(s);
  await save(out, 'theme-output.pdf');
  const r = await reopen(out);
  ok((await annotsOf(r.pdf, 0)).some(x => x.subtype === 'Stamp'), 'image saved');
  await r.close();
  return `${out.size} bytes`;
});

await test('Theme: match page follows a dark PDF background', async () => {
  await closeAll();
  // Make a dark page by burning a filled box into a new document.
  const base = app.newDocument();
  base.addAnnots(base.pages[0], [{ id: 'bg', kind: 'rect', rect: [0, 0, 595, 842], color: '#102030', fill: '#102030', opacity: 1, width: 0, burn: true }]);
  const dark = await A.buildFile(base);
  base.dirty = false;
  await closeAll();
  const s = await app.openPdfBlob(new File([dark.blob], 'dark.pdf'), 'dark.pdf');
  await settle();
  // A light screenshot pasted onto the dark page.
  const c = new OffscreenCanvas(500, 300);
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, 500, 300);
  x.fillStyle = '#1f1f1f'; x.font = '16px Arial'; x.fillText('A light screenshot on a dark page', 20, 60);
  await window.paste(await c.convertToBlob({ type: 'image/png' }));
  await wait(800);
  const page = s.pages[0];
  const annot = page.annots.find(a => a.kind === 'image');
  await A.applyTheme(s, page, annot, { mode: 'match', style: 'neutral', keepPhotos: true });
  const got = page.annots.find(a => a.kind === 'image').image.blob;
  const bmp = await createImageBitmap(got);
  const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const p = [...ctx.getImageData(5, 5, 1, 1).data];
  ok(Math.abs(p[0] - 0x10) < 6 && Math.abs(p[1] - 0x20) < 6 && Math.abs(p[2] - 0x30) < 6, `background should match the page: ${p}`);
});

await test('Theme snip and whole page conversion', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  const page = s.pages[0];
  const a = await A.snipRegion(s, page, [40, 540, 400, 760], 'gemini');
  eq(a.image.theme, 'dark', 'white page area goes dark');
  await settle();
  const made = await A.convertPages(s, s.pages.slice(0, 3), 'dark', 'neutral', () => true);
  eq(made, 3);
  await settle();
  const { blob } = await A.buildFile(s, {}, s.pages.slice(0, 3));
  await save(blob, 'page-theme-output.pdf');
  const r = await reopen(blob);
  ok((await pageWords(r.pdf, 1)).includes('needle2'), 'text under the picture is still searchable');
  await r.close();
  s.undo();
  eq(s.pages[1].annots.filter(x => x.kind === 'image').length, 0, 'undo');
});

await test('Theme: works on a rotated page', async () => {
  await closeAll();
  const s = await openSession('rotated-mixed.pdf');
  await wait(1000);
  app.viewer.goTo(1);
  await settle();
  const c = new OffscreenCanvas(400, 200);
  const x = c.getContext('2d');
  x.fillStyle = '#131314'; x.fillRect(0, 0, 400, 200);
  await window.paste(await c.convertToBlob({ type: 'image/png' }));
  await wait(600);
  const page = s.pages[1];
  const img = page.annots.find(a => a.kind === 'image');
  ok(img, 'placed');
  eq(img.angle, 90, 'stays upright');
  const { blob } = await A.buildFile(s);
  await save(blob, 'rotated-output.pdf');
  const r = await reopen(blob);
  ok((await annotsOf(r.pdf, 1)).some(z => z.subtype === 'Stamp'), 'saved');
  await r.close();
});

// ---- Search and text ----

await test('Search finds text and highlights it', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  const found = [];
  await A.searchDocument(s, 'NEEDLE7', { caseSensitive: false, wholeWord: false }, m => found.push(...m), () => false);
  eq(found.length, 1);
  eq(found[0].pageIndex, 6);
  ok(found[0].boxes[0].w > 10, 'has a position');
  const none = [];
  await A.searchDocument(s, 'NEEDLE7', { caseSensitive: true, wholeWord: false }, m => none.push(...m), () => false);
  eq(none.length, 0, 'match case');
  const whole = [];
  await A.searchDocument(s, 'needle', { caseSensitive: false, wholeWord: true }, m => whole.push(...m), () => false);
  eq(whole.length, 0, 'whole word');
  // Through the panel.
  app.panels.show('search');
  const input = app.panels.search.input;
  input.value = 'needle3';
  input.dispatchEvent(new Event('input'));
  await wait(900);
  eq(app.panels.search.matches.length, 1, 'panel found it');
  await settle();
  ok(document.querySelector('.match'), 'highlight drawn');
  eq(app.viewer.current, 2, 'jumped to the page');
  app.panels.show('thumbs');
});

// ---- Convert ----

await test('Export: text, HTML, Word, Excel, PowerPoint, images', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  s.setPages(s.pages.slice(0, 3), 'short');
  const { blob } = await A.buildFile(s);
  const r = await reopen(blob);
  const tick = () => true;
  const txt = await A.exportText(r.pdf, tick);
  ok((await txt.text()).includes('needle2'), 'text');
  const html = await A.exportHtml(r.pdf, 'doc', tick);
  ok((await html.text()).includes('needle3'), 'html');
  const docx = await A.exportDocx(r.pdf, tick); await save(docx, 'out.docx');
  const xlsx = await A.exportXlsx(r.pdf, tick); await save(xlsx, 'out.xlsx');
  const pptx = await A.exportPptx(r.pdf, tick); await save(pptx, 'out.pptx');
  const img = await A.exportImages(r.pdf, 'doc', 96, 'png', tick); await save(img.blob, img.name);
  await r.close();
  for (const [n, b] of [['docx', docx], ['xlsx', xlsx], ['pptx', pptx], ['zip', img.blob]]) {
    const sig = new Uint8Array(await b.slice(0, 2).arrayBuffer());
    ok(sig[0] === 0x50 && sig[1] === 0x4b, `${n} is a zip`);
  }
  return `docx ${docx.size}, xlsx ${xlsx.size}, pptx ${pptx.size}, images ${img.blob.size}`;
});

await test('PDF to Word keeps tables, pictures and reading order', async () => {
  const f = await fx('report.pdf');
  const r = await A.openPdf(f);
  const docx = await A.exportDocx(r.pdf, () => true);
  await save(docx, 'report.docx');
  const zip = A.unzipSync(new Uint8Array(await docx.arrayBuffer()));
  const xml = A.strFromU8(zip['word/document.xml']);
  ok(xml.includes('<w:tbl>'), 'has a table');
  ok(Object.keys(zip).some(k => k.startsWith('word/media/')), 'has a picture');
  ok(xml.includes('<w:drawing>'), 'picture is placed');
  for (const t of ['Sales Report', 'Region', '4500', 'East', 'Text after the table']) ok(xml.includes(t), `missing ${t}`);
  const order = ['Sales Report', 'This paragraph', 'Region', 'Text after the table', '<w:drawing>', 'Text after the picture'].map(t => xml.indexOf(t));
  ok(order.every((v, i) => i === 0 || v > order[i - 1]), `reading order: ${order}`);
  ok(/<w:jc w:val="center"\/>[^]*Sales Report/.test(xml.slice(0, xml.indexOf('Sales Report') + 20)), 'centred heading');
  new DOMParser().parseFromString(xml, 'application/xml').querySelector('parsererror') && ok(false, 'XML must be valid');
  const html = await (await A.exportHtml(r.pdf, 'report', () => true)).text();
  ok(html.includes('<table>') && html.includes('<img') && html.includes('4500'), 'HTML has table and picture');
  const rt = A.docxToPrint(new Uint8Array(await docx.arrayBuffer()));
  ok(rt.html.includes('4500') && rt.html.includes('data:image/png'), 'Word file reads back through the converter');
  await r.close();
  return `${docx.size} bytes`;
});

await test('A file the save engine cannot read is rebuilt, and nothing is lost', async () => {
  await closeAll();
  // The page tree is written in a way the save engine refuses, yet the viewer reads it fine.
  const base = await (await fx('normal.pdf')).arrayBuffer();
  const s = await app.openPdfBlob(new File([base], 'x.pdf', { type: 'application/pdf' }), 'x.pdf');
  await settle();
  // The source lies about its page count, as a damaged file would look to the save engine.
  const src = [...s.sources.values()][0];
  const real = src.pdf.numPages;
  Object.defineProperty(src.pdf, 'numPages', { get: () => real + 1, configurable: true });
  s.addAnnots(s.pages[0], [{ id: 'keep', kind: 'rect', rect: [100, 100, 200, 200], color: '#ff0000', opacity: 1, width: 2 }]);
  const { blob, warnings } = await A.buildFile(s);
  delete src.pdf.numPages;
  ok(warnings.some(w => w.includes('internal damage')), `tells the user: ${warnings}`);
  const r = await reopen(blob);
  eq(r.pdf.numPages, real, 'all pages');
  ok((await pageWords(r.pdf, 3)).includes('needle4'), 'text stays searchable');
  ok((await annotsOf(r.pdf, 0)).some(a => a.subtype === 'Square'), 'edits are kept');
  await r.close();
  s.dirty = false;
  return `${Math.round(blob.size / 1024)} KB`;
});

await test('Compare two PDFs', async () => {
  const d = A.diffWords('the quick brown fox', 'the slow brown fox jumps');
  ok(d.some(o => o.type === 'del' && o.text.includes('quick')), 'removal');
  ok(d.some(o => o.type === 'add' && o.text.includes('slow')), 'addition');
  ok(d.some(o => o.type === 'add' && o.text.includes('jumps')), 'addition at end');
  eq(A.diffWords('same words', 'same words').every(o => o.type === 'same'), true, 'identical');
  const p = A.compareFiles(await fx('normal.pdf'), 'a.pdf', await fx('annotated.pdf'), 'b.pdf');
  let shown = false;
  for (let i = 0; i < 100 && !shown; i++) { await wait(100); shown = !!document.querySelector('.cmp-grid'); }
  ok(shown, 'results window opened');
  await wait(500);
  const rows = document.querySelectorAll('.cmp-row').length;
  eq(rows, 12, 'one row per page');
  ok(document.querySelector('.cmp-row.changed'), 'differences listed');
  clickDialog();
  await p;
});

await test('XFDF: export and import annotations', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  s.addAnnots(s.pages[0], ALL_KINDS(s.pages[0]).filter(a => a.kind !== 'link'));
  const xml = A.exportXfdf(s);
  await save(new Blob([xml]), 'out.xfdf');
  ok(xml.includes('<highlight') && xml.includes('<ink'), 'contains annotations');
  await closeAll();
  const s2 = await openSession('normal.pdf');
  const n = A.importXfdf(s2, xml);
  ok(n >= 15, `imported ${n}`);
  const { blob } = await A.buildFile(s2);
  const r = await reopen(blob);
  ok((await annotsOf(r.pdf, 0)).length >= 15, 'saved');
  await r.close();
  let threw = false;
  try { A.importXfdf(s2, 'this is not xml <<<'); } catch { threw = true; }
  ok(threw, 'bad file gives a message');
});

// ---- Recovery ----

await test('Crash recovery brings back edits and images', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  const page = s.pages[2];
  s.addAnnots(page, [{ id: 'keep', kind: 'rect', rect: [100, 100, 200, 200], color: '#ff0000', opacity: 1, width: 2 }]);
  const asset = await A.assetFromBlob(await window.mockGemini());
  s.addAnnots(page, [A.makeImageAnnot(page, asset, 50, 50, 300, 200)]);
  s.setPages(s.pages.slice(1), 'drop first');
  await A.saveJournal(s);
  const list = await A.listJournals();
  const j = list.find(x => x.id === s.id);
  ok(j, 'journal written');
  eq(j.pages.length, 11);
  const restored = await A.restoreAnnots(j.pages[1].annots);
  eq(restored.length, 2);
  ok(restored.find(a => a.kind === 'image')?.image.blob.size > 1000, 'image restored');
  // Exercise the real recovery path as a crash would.
  s.dirty = false;
  await app.recover(j);
  const again = app.session;
  ok(again !== s, 'a new document');
  eq(again.pages.length, 11, 'page deletion survived');
  ok(again.pages[1].annots.some(a => a.id === 'keep'), 'annotation survived');
  ok(again.pages[1].annots.some(a => a.kind === 'image'), 'image survived');
  ok(again.dirty, 'marked unsaved');
  await A.dropJournal(s.id);
  await A.dropJournal(again.id);
  eq((await A.listJournals()).filter(x => x.id === s.id).length, 0, 'cleared');
});

// ---- Newer features ----

await test('Bookmarks are saved into the file contents', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  s.bookmarks.push({ id: 'b1', pageId: s.pages[2].id, title: 'Third page' }, { id: 'b2', pageId: s.pages[8].id, title: 'مرحبا' });
  const { blob } = await A.buildFile(s, {}, s.pages);
  const r = await reopen(blob);
  const out = await r.pdf.getOutline();
  eq(out?.length, 2, 'two entries');
  eq(out[0].title, 'Third page');
  eq(out[1].title, 'مرحبا', 'non-Latin title');
  eq(await r.pdf.getPageIndex(out[0].dest[0]), 2, 'points at the right page');
  await r.close();
});

await test('Attachments are saved and can be read back', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  s.attachments.push({ name: 'notes.txt', blob: new Blob(['hello attachment'], { type: 'text/plain' }) });
  const { blob } = await A.buildFile(s, {}, s.pages);
  await save(blob, 'attach-output.pdf');
  const r = await reopen(blob);
  const list = await r.pdf.getAttachments();
  const [id, a] = [...list.entries()][0];
  eq(a?.filename, 'notes.txt');
  const got = await r.pdf.getAttachmentContent(id);
  eq(new TextDecoder().decode(got instanceof Uint8Array ? got : got.content), 'hello attachment');
  await r.close();
  app.panels.show('attachments');
  await wait(200);
  ok(document.querySelector('.attach-name')?.textContent === 'notes.txt', 'listed in the panel');
  app.panels.show('thumbs');
});

await test('Fonts and styles on text boxes', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  const base = { kind: 'text', color: '#111', textColor: '#111', opacity: 1, width: 0, fontSize: 14, rect: [60, 300, 400, 330] };
  s.addAnnots(s.pages[0], [
    { ...base, id: 'f1', text: 'Serif bold', font: 'times', bold: true },
    { ...base, id: 'f2', text: 'Mono italic', font: 'courier', italic: true, rect: [60, 260, 400, 290] },
    { ...base, id: 'f3', text: 'Sans plain', rect: [60, 220, 400, 250] },
  ]);
  const { blob, warnings } = await A.buildFile(s);
  eq(warnings.length, 0, warnings.join(';'));
  const report = await A.inspectFile(blob);
  const names = report.fonts.map(f => f.name).join(',');
  ok(/Times-Bold/.test(names), `times: ${names}`);
  ok(/Courier-Oblique/.test(names), `courier: ${names}`);
  ok(/Helvetica/.test(names), `helvetica: ${names}`);
});

await test('Arabic and other languages save as real, selectable text', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  const base = { kind: 'text', color: '#111111', textColor: '#111111', opacity: 1, width: 0, fontSize: 16 };
  s.addAnnots(s.pages[0], [
    { ...base, id: 'ar', rect: [60, 300, 500, 340], text: 'مرحبا بالعالم' },
    { ...base, id: 'ru', rect: [60, 260, 500, 300], text: 'Привет мир' },
    { ...base, id: 'gr', rect: [60, 220, 500, 260], text: 'Γειά σου Κόσμε' },
    { ...base, id: 'mx', rect: [60, 180, 500, 220], text: 'رقم 42 Test' },
  ]);
  const { blob, warnings } = await A.buildFile(s);
  eq(warnings.length, 0, warnings.join(';'));
  await save(blob, 'languages-output.pdf');
  const report = await A.inspectFile(blob);
  ok(report.fonts.some(f => f.embedded), `a real font is inside: ${JSON.stringify(report.fonts)}`);
  const r = await reopen(blob);
  const list = await annotsOf(r.pdf, 0);
  eq(list.filter(a => a.subtype === 'FreeText').length, 4, 'all saved');
  await r.close();
  // Burned in, the words are real page text that search can find.
  const s2 = await openSession('normal.pdf');
  s2.addAnnots(s2.pages[0], [
    { ...base, id: 'b1', rect: [60, 300, 500, 340], text: 'Привет мир', burn: true },
    { ...base, id: 'b2', rect: [60, 260, 500, 300], text: 'Γειά σου', burn: true },
    { ...base, id: 'b3', rect: [60, 220, 500, 260], text: 'مرحبا', burn: true },
  ]);
  const out = await A.buildFile(s2);
  await save(out.blob, 'languages-burned-output.pdf');
  const r2 = await reopen(out.blob);
  const text = await pageWords(r2.pdf, 0);
  ok(text.includes('Привет'), `Cyrillic is real text: ${text.slice(-120)}`);
  ok(text.includes('Γειά'), 'Greek is real text');
  ok(/[\u0600-\u06FF\uFE70-\uFEFF]/.test(text), 'Arabic is real text');
  await r2.close();
});

await test('A font that cannot be cut down still saves', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  s.addAnnots(s.pages[0], [{ kind: 'text', id: 'c', font: 'courier', color: '#111', textColor: '#111', opacity: 1, width: 0, fontSize: 14, rect: [60, 300, 500, 340], text: 'Привет mono', burn: true }]);
  const { blob } = await A.buildFile(s);
  const r = await reopen(blob);
  ok((await pageWords(r.pdf, 0)).includes('Привет'), 'text is real');
  await r.close();
  return `${Math.round(blob.size / 1024)} KB`;
});

await test('PDF/A: typed text uses embedded fonts', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  s.addAnnots(s.pages[0], [{ kind: 'text', id: 't', color: '#111', textColor: '#111', opacity: 1, width: 0, fontSize: 12, rect: [60, 300, 500, 340], text: 'Plain words' }]);
  const { blob } = await A.buildFile(s, { pdfa: '2B' });
  const info = await A.inspectFile(blob);
  ok(info.fonts.some(f => f.embedded), `embedded: ${JSON.stringify(info.fonts)}`);
});

await test('PDF/A: label added, and the check reports it', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  const before = await A.inspectFile((await A.buildFile(s)).blob);
  eq(before.pdfa, null, 'not PDF/A to start');
  const { blob } = await A.buildFile(s, { pdfa: '2B' });
  await save(blob, 'pdfa-output.pdf');
  const after = await A.inspectFile(blob);
  eq(after.outputIntent, true, 'colour profile');
  ok(String(after.pdfa).startsWith('2'), `label: ${after.pdfa}`);
  const r = await reopen(blob);
  eq(r.pdf.numPages, 12);
  await r.close();
  return JSON.stringify({ pdfa: after.pdfa, fonts: after.fonts.length, unembedded: after.fonts.filter(f => !f.embedded).length });
});

await test('Detect form fields from blank lines', async () => {
  await closeAll();
  // Make a page with blanks to fill.
  const maker = app.newDocument();
  maker.addAnnots(maker.pages[0], [
    { id: 'l1', kind: 'text', color: '#000', textColor: '#000', opacity: 1, width: 0, fontSize: 12, rect: [60, 700, 500, 730], text: 'Name: ____________________', burn: true },
    { id: 'l2', kind: 'text', color: '#000', textColor: '#000', opacity: 1, width: 0, fontSize: 12, rect: [60, 660, 500, 690], text: 'Date: ..........', burn: true },
  ]);
  const made = await A.buildFile(maker);
  maker.dirty = false;
  await closeAll();
  const s = await app.openPdfBlob(new File([made.blob], 'blank.pdf'), 'blank.pdf');
  await settle();
  const n = await A.detectFields(s, () => true);
  eq(n, 2, 'two blanks found');
  const { blob } = await A.buildFile(s);
  const r = await reopen(blob);
  eq((await annotsOf(r.pdf, 0)).filter(a => a.subtype === 'Widget').length, 2, 'became real fields');
  await r.close();
  s.undo();
  eq(s.pages[0].annots.filter(a => a.field).length, 0, 'undo removes them all');
});

await test('Batch job over several files', async () => {
  const files = [await fx('normal.pdf'), await fx('annotated.pdf'), await fx('not-a-pdf.pdf')];
  const r = await A.runBatch(files, 'numbers', '', () => true);
  eq(r.done, 2);
  eq(r.failed.length, 1, 'bad file is reported and skipped');
  ok(r.blob.size > 1000);
  const t = await A.runBatch([files[0]], 'text', '', () => true);
  eq(t.done, 1);
  const pw = await A.runBatch([files[0]], 'password', 'pw123', () => true);
  eq(pw.done, 1);
});

await test('DICOM medical image to PDF page', async () => {
  // A small 16-bit uncompressed scan, written by hand.
  const w = 64, h = 48;
  const head = new Uint8Array(132); head.set([68, 73, 67, 77], 128);
  const parts = [head];
  const el = (g, e, vr, bytes) => {
    const long = ['OW', 'OB', 'UN'].includes(vr);
    const a = new Uint8Array(long ? 12 : 8);
    const d = new DataView(a.buffer);
    d.setUint16(0, g, true); d.setUint16(2, e, true);
    a[4] = vr.charCodeAt(0); a[5] = vr.charCodeAt(1);
    if (long) d.setUint32(8, bytes.length, true); else d.setUint16(6, bytes.length, true);
    parts.push(a, bytes);
  };
  const str = s => { const v = s.length % 2 ? `${s} ` : s; return new TextEncoder().encode(v); };
  const u16 = v => new Uint8Array(new Uint16Array([v]).buffer);
  el(0x0002, 0x0010, 'UI', str('1.2.840.10008.1.2.1\0'));
  el(0x0028, 0x0002, 'US', u16(1));
  el(0x0028, 0x0004, 'CS', str('MONOCHROME2'));
  el(0x0028, 0x0010, 'US', u16(h));
  el(0x0028, 0x0011, 'US', u16(w));
  el(0x0028, 0x0100, 'US', u16(16));
  el(0x0028, 0x0101, 'US', u16(12));
  el(0x0028, 0x0103, 'US', u16(0));
  const pix = new Uint16Array(w * h);
  for (let i = 0; i < pix.length; i++) pix[i] = (i % w) * 60;
  el(0x7fe0, 0x0010, 'OW', new Uint8Array(pix.buffer));
  const file = new File(parts, 'scan.dcm');
  const png = await A.dicomToPng(file);
  const bmp = await createImageBitmap(png);
  eq(bmp.width, w); eq(bmp.height, h);
  const c = new OffscreenCanvas(w, h).getContext('2d');
  c.drawImage(bmp, 0, 0);
  const row = c.getImageData(0, 10, w, 1).data;
  ok(row[0] < 10 && row[(w - 1) * 4] > 240, `brightness range ${row[0]} to ${row[(w - 1) * 4]}`);
  let threw = false;
  try { await A.dicomToPng(new File([new Uint8Array(500)], 'x.dcm')); } catch { threw = true; }
  ok(threw, 'non-DICOM data gives a message');
  await closeAll();
  await app.pasteImages([file], 'scan.dcm');
  await wait(400);
  eq(app.session.pages[0].annots.filter(a => a.kind === 'image').length, 1, 'placed as a page image');
});

await test('HEIC phone photo', async () => {
  const r = await fetch('/fixtures/sample.heic');
  ok(r.ok, 'test photo exists');
  const file = new File([await r.blob()], 'photo.heic', { type: 'image/heic' });
  const png = await A.heicToPng(file);
  const bmp = await createImageBitmap(png);
  ok(bmp.width > 50 && bmp.height > 50, `decoded ${bmp.width} by ${bmp.height}`);
  await closeAll();
  await app.pasteImages([file], 'photo.heic');
  await wait(300);
  eq(app.session.pages[0].annots.filter(a => a.kind === 'image').length, 1, 'placed on a page');
  const jpg = await A.convertImageFile(png, 'image/jpeg');
  ok(jpg.size > 500, 'saved as JPG');
  return `${bmp.width} by ${bmp.height}`;
});

await test('Crop a pasted image, then theme still works', async () => {
  await closeAll();
  await window.paste(await window.mockGemini());
  await wait(800);
  const s = app.session;
  const page = s.pages[0];
  const a = page.annots.find(x => x.kind === 'image');
  const k = app.viewer.scale;
  const v = app.viewer.views.get(page.id);
  const b = { x0: 40 * k, y0: 40 * k, x1: 440 * k, y1: 340 * k };
  await A.cropImageAnnot(s, page, a, { x0: 100 * k, y0: 100 * k, x1: 300 * k, y1: 250 * k }, b, k);
  const c = page.annots.find(x => x.kind === 'image');
  ok(c.image.width < a.image.width, 'smaller');
  ok(Math.abs((c.rect[2] - c.rect[0]) - 200) < 1, 'box is 200 points wide');
  ok(Math.abs((c.rect[3] - c.rect[1]) - 150) < 1, 'box is 150 points tall');
  const bmp = await createImageBitmap(c.image.original);
  ok(Math.abs(bmp.width - c.image.width) <= 1, 'original cropped too');
  await A.applyTheme(s, page, c, { mode: 'light', style: 'gemini', keepPhotos: true });
  eq(page.annots.find(x => x.kind === 'image').image.theme, 'light', 'theme after crop');
  s.undo(); s.undo();
  eq(page.annots.find(x => x.kind === 'image').image.width, a.image.width, 'undo restores the full image');
  void v;
});

await test('Convert all images at once, and auto-convert on paste', async () => {
  await closeAll();
  const blob = await window.mockGemini();
  for (let i = 0; i < 3; i++) { await window.paste(blob); await wait(300); }
  const s = app.session;
  const n = await A.convertAllImages(s, { mode: 'light', style: 'gemini', keepPhotos: true }, () => true);
  eq(n, 3);
  const all = () => s.pages.flatMap(p => p.annots.filter(a => a.kind === 'image'));
  ok(all().every(a => a.image.theme === 'light'), 'all light');
  s.undo();
  ok(all().every(a => a.image.theme === 'original'), 'one undo restores all');
  await closeAll();
  localStorage.setItem('pdfy.pasteMode', 'light');
  await window.paste(blob);
  await wait(1200);
  const got = app.session.pages[0].annots.find(a => a.kind === 'image');
  localStorage.removeItem('pdfy.pasteMode');
  eq(got.image.theme, 'light', 'converted on paste');
});

await test('Custom colours', async () => {
  await closeAll();
  localStorage.setItem('pdfy.customStyle', JSON.stringify({ light: { bg: '#fff0f0', surface: '#ffe0e0', text: '#330000' }, dark: { bg: '#001020', surface: '#002040', text: '#e0f0ff' } }));
  await window.paste(await window.mockGemini());
  await wait(700);
  const s = app.session, page = s.pages[0];
  await A.applyTheme(s, page, page.annots.find(a => a.kind === 'image'), { mode: 'light', style: 'custom', keepPhotos: true });
  const b = page.annots.find(a => a.kind === 'image').image.blob;
  const bmp = await createImageBitmap(b);
  const c = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d');
  c.drawImage(bmp, 0, 0);
  const p = [...c.getImageData(1090, 10, 1, 1).data];
  localStorage.removeItem('pdfy.customStyle');
  ok(Math.abs(p[0] - 255) < 3 && Math.abs(p[1] - 240) < 3 && Math.abs(p[2] - 240) < 3, `background ${p}`);
});

await test('OCR reads Arabic', async () => {
  await closeAll();
  const c = document.createElement('canvas');
  c.width = 1400; c.height = 300;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, 1400, 300);
  x.fillStyle = '#000'; x.font = '70px Arial'; x.direction = 'rtl'; x.textAlign = 'right';
  x.fillText('مرحبا بكم في المكتبة العامة', 1340, 170);
  const png = await new Promise(r => c.toBlob(r, 'image/png'));
  await app.pasteImages([png]);
  await wait(400);
  const s = app.session;
  const flat = await A.buildFile(s, { flattenAnnots: true });
  s.dirty = false;
  await closeAll();
  const scan = await app.openPdfBlob(new File([flat.blob], 'ar.pdf'), 'ar.pdf');
  await settle();
  const r = await A.runOcr(scan, scan.pages, 'ara', () => true);
  ok(r.words >= 2, `read ${r.words} words`);
  const found = scan.ocrWords.get(scan.pages[0].id).map(w => w.text).join(' ');
  ok(/[\u0600-\u06FF]/.test(found), `Arabic letters found: ${found}`);
  const { blob } = await A.buildFile(scan);
  const o = await reopen(blob);
  const text = await pageWords(o.pdf, 0);
  ok(/[\u0600-\u06FF\uFE70-\uFEFF]/.test(text), `saved as searchable text: ${text.slice(0, 80)}`);
  await o.close();
  return found.slice(0, 60);
});

await test('OCR reads a picture of text and makes it searchable', async () => {
  await closeAll();
  const c = new OffscreenCanvas(1200, 400);
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, 1200, 400);
  x.fillStyle = '#000'; x.font = '48px Arial';
  x.fillText('Scanned invoice number 4821', 60, 120);
  x.fillText('The quick brown fox', 60, 240);
  const png = await c.convertToBlob({ type: 'image/png' });
  await app.pasteImages([png]);
  await wait(500);
  const s = app.session;
  const { blob: flat } = await A.buildFile(s, { flattenAnnots: true });
  s.dirty = false;
  await closeAll();
  const scan = await app.openPdfBlob(new File([flat], 'scan.pdf'), 'scan.pdf');
  await settle();
  const pdf = [...scan.sources.values()][0].pdf;
  eq((await pageWords(pdf, 0)).trim(), '', 'no text to begin with');
  const { runOcr } = A;
  const result = await runOcr(scan, scan.pages, 'eng', () => true);
  ok(result.words >= 6, `read ${result.words} words`);
  const found = [];
  await A.searchDocument(scan, 'invoice', { caseSensitive: false, wholeWord: false }, m => found.push(...m), () => false);
  eq(found.length, 1, 'search finds it');
  const { blob } = await A.buildFile(scan);
  await save(blob, 'ocr-output.pdf');
  const r = await reopen(blob);
  ok((await pageWords(r.pdf, 0)).toLowerCase().includes('invoice'), 'saved file has searchable text');
  await r.close();
  return `${result.words} words`;
});

await test('Digital signature: create an ID, sign, file is intact', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  s.addAnnots(s.pages[0], [{ id: 'n', kind: 'rect', rect: [100, 100, 200, 200], color: '#ff0000', opacity: 1, width: 2 }]);
  const p12 = await A.createDigitalId('Test Signer', 'test@example.com', 'id-pass', 2);
  ok(p12.size > 1000, 'ID file made');
  let refused = false;
  try { await A.readDigitalId(await p12.arrayBuffer(), 'wrong'); } catch { refused = true; }
  ok(refused, 'wrong ID password refused');
  const id = await A.readDigitalId(await p12.arrayBuffer(), 'id-pass');
  eq(id.name, 'Test Signer');
  const { blob } = await A.buildFile(s, { signature: { name: id.name, reason: 'Testing', location: 'Cairo', pageIndex: 0, rect: [320, 80, 560, 140] } });
  const signed = await A.applySignature(new Uint8Array(await blob.arrayBuffer()), id);
  await save(signed, 'signed-output.pdf');
  const r = await reopen(signed);
  eq(r.pdf.numPages, 12, 'still opens');
  const sigField = (await annotsOf(r.pdf, 0)).find(a => a.fieldType === 'Sig');
  ok(sigField, 'signature field present');
  await r.close();
  return `${signed.size} bytes`;
});

await test('Office conversion produces a printable page', async () => {
  const docx = A.docxToPrint(new Uint8Array(await (await fetch('/fixtures/sample.docx')).arrayBuffer()));
  for (const t of ['Quarterly report', 'bold words', 'red italic', 'First bullet', 'Region', 'data:image/png', 'https://example.com/', 'هذا نص عربي', 'Long content line number 70']) ok(docx.html.includes(t), `Word: missing ${t}`);
  ok(Math.abs(docx.widthIn - 8.27) < 0.01, `page width ${docx.widthIn}`);
  ok(/color:#C80000/i.test(docx.html), 'colour kept');
  ok(docx.html.includes('1.</span>') && docx.html.includes('2.</span>'), 'numbered list counts');
  const xlsx = A.xlsxToPrint(new Uint8Array(await (await fetch('/fixtures/sample.xlsx')).arrayBuffer()));
  for (const t of ['Budget', 'Rent', '1545.5', 'Unique cell text', 'Second sheet']) ok(xlsx.html.includes(t), `Excel: missing ${t}`);
  ok(/background:#DDEEFF/i.test(xlsx.html), 'fill colour kept');
  const pptx = A.pptxToPrint(new Uint8Array(await (await fetch('/fixtures/sample.pptx')).arrayBuffer()));
  for (const t of ['Deck title slide', 'A subtitle here', 'Second slide title', 'Free text box', 'data:image/png']) ok(pptx.html.includes(t), `PowerPoint: missing ${t}`);
  eq(pptx.widthIn, 10, 'slide width');
  ok(/left:36pt;top:21/.test(pptx.html), 'placeholder position inherited from the layout');
  let threw = false;
  try { await A.officeToPrint(new File([new Uint8Array(200)], 'old.doc')); } catch (e) { threw = /old Office/.test(e.message); }
  ok(threw, 'old formats get a clear message');
});

// ---- Stress ----

await test('Stress: 300 annotations and fast undo', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  const page = s.pages[0];
  for (let i = 0; i < 300; i++) {
    const pts = [];
    for (let k = 0; k < 40; k++) pts.push(50 + Math.random() * 500, 50 + Math.random() * 700);
    s.addAnnots(page, [{ id: `ink${i}`, kind: 'ink', rect: [50, 50, 550, 750], paths: [pts], color: '#1a56db', opacity: 1, width: 1 }]);
  }
  for (let i = 0; i < 300; i++) s.undo();
  eq(page.annots.length, 0, 'all undone');
  for (let i = 0; i < 300; i++) s.redo();
  eq(page.annots.length, 300, 'all redone');
  const { blob } = await A.buildFile(s);
  const r = await reopen(blob);
  eq((await annotsOf(r.pdf, 0)).length, 300);
  await r.close();
});

await test('Stress: open, close, repeat, memory returns', async () => {
  await closeAll();
  const h0 = performance.memory.usedJSHeapSize;
  for (let i = 0; i < 12; i++) {
    const s = await openSession('normal.pdf');
    app.viewer.goTo(i % 12);
    await settle(800);
    s.dirty = false;
    await app.closeSession(s);
  }
  await wait(500);
  const growth = Math.round((performance.memory.usedJSHeapSize - h0) / 1048576);
  ok(growth < 40, `heap grew ${growth} MB`);
  return `heap +${growth} MB after 12 cycles`;
});

await test('Stress: conversion while scrolling stays responsive', async () => {
  await closeAll();
  const s = await openSession('normal.pdf');
  const asset = await A.assetFromBlob(await window.mockGemini());
  const page = s.pages[0];
  const a = A.makeImageAnnot(page, asset, 40, 40, 500, 330);
  s.addAnnots(page, [a]);
  let frames = 0, longest = 0, last = performance.now(), run = true;
  const tick = () => { const n = performance.now(); longest = Math.max(longest, n - last); last = n; frames++; if (run) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  for (let i = 0; i < 6; i++) {
    const cur = page.annots.find(x => x.id === a.id);
    await A.applyTheme(s, page, cur, { mode: i % 2 ? 'dark' : 'light', style: 'gemini', keepPhotos: true });
  }
  run = false;
  ok(longest < 700, `interface froze for ${Math.round(longest)} ms`);
  return `longest pause ${Math.round(longest)} ms`;
});

await closeAll();
document.querySelectorAll('.toast').forEach(t => t.remove());
const summary = { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576) };
export default { summary, failures: results.filter(r => !r.ok), notes: results.filter(r => r.ok && r.note).map(r => `${r.name}: ${r.note}`) };
