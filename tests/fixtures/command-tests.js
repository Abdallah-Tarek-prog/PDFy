// Drives every ribbon command through its real dialog. File pickers are replaced with stand-ins, since
// they are native Windows windows. Everything after the picker is the real code path.
const app = window.__pdfy, A = window.__api;
const results = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
const fx = async name => { const r = await fetch(`/fixtures/${name}`); return new File([await r.blob()], name, { type: name.endsWith('.pdf') ? 'application/pdf' : '' }); };
const ok = (v, msg) => { if (!v) throw new Error(msg ?? 'check failed'); };
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg ?? 'values differ'}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); };
const only = window.__only ? new RegExp(window.__only, 'i') : null;

// ---- Stand-ins for native windows ----

const saved = [];
let saveFails = false;
function fakeHandle(name, initial) {
  let current = initial ?? null;
  return {
    kind: 'file', name,
    queryPermission: async () => 'granted', requestPermission: async () => 'granted',
    getFile: async () => { if (!current) throw new Error('no file'); return new File([current], name, { type: 'application/pdf' }); },
    createWritable: async () => {
      if (saveFails) throw new DOMException('Blocked for the test', 'NoModificationAllowedError');
      const parts = [];
      return {
        write: async b => { parts.push(b); },
        close: async () => { current = new Blob(parts, { type: 'application/pdf' }); saved.push({ name, blob: current }); },
        abort: async () => {},
      };
    },
  };
}
window.showSaveFilePicker = async o => fakeHandle(o?.suggestedName ?? 'file.pdf');
let openHandles = [];
window.showOpenFilePicker = async () => { const h = openHandles; openHandles = []; if (!h.length) throw new DOMException('cancelled', 'AbortError'); return h; };
let nextFiles = [];
const realClick = HTMLInputElement.prototype.click;
HTMLInputElement.prototype.click = function () {
  if (this.type !== 'file') return realClick.call(this);
  const dt = new DataTransfer();
  nextFiles.forEach(f => dt.items.add(f));
  nextFiles = [];
  this.files = dt.files;
  setTimeout(() => this.dispatchEvent(new Event('change')), 0);
};
const realAnchor = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () {
  if (!this.download) return realAnchor.call(this);
  fetch(this.href).then(r => r.blob()).then(blob => saved.push({ name: this.download, blob }));
};

// ---- Helpers ----

async function test(name, fn) {
  if (only && !only.test(name)) return;
  console.log('TEST', name);
  saveFails = false;
  const t0 = performance.now();
  try {
    const note = await fn();
    results.push({ ok: true, name, ms: Math.round(performance.now() - t0), note });
  } catch (err) {
    results.push({ ok: false, name, error: String(err?.message ?? err), toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent) });
  }
  document.querySelectorAll('.overlay-bg').forEach(d => d.remove());
  document.querySelectorAll('.toast').forEach(t => t.remove());
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), results }, null, 1) });
}
const closeAll = async () => { for (const s of [...app.sessions]) { s.dirty = false; await app.closeSession(s); } };
async function settle(ms = 2500) {
  const start = performance.now();
  while (performance.now() - start < ms) {
    const views = [...app.viewer.views.values()];
    if (views.length && views.every(v => !v.needsRender && !v.task)) break;
    await wait(30);
  }
  await wait(80);
}
async function fresh(name = 'normal.pdf') {
  await closeAll();
  saved.length = 0;
  const f = await fx(name);
  const s = await app.openPdfBlob(f, name, fakeHandle(name, f));
  ok(s, `opened ${name}`);
  await settle();
  return s;
}
const ribbon = async (tab, label) => {
  // The tab name is from the old ribbon. Buttons are now found wherever they live: toolbar, menu or More.
  void tab;
  const b = await app.revealCommand(label);
  await wait(20);
  ok(b, `button ${label} on ${tab}`);
  ok(!b.disabled, `button ${label} is enabled`);
  b.click();
  await wait(40);
};
const waitFor = async (fn, what, ms = 25000) => {
  const start = performance.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (performance.now() - start > ms) throw new Error(`Timed out waiting for ${what}. Toasts: ${[...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')}`);
    await wait(30);
  }
};
/** Fills the open form window and presses its main button. */
const fill = async (values = {}) => {
  await waitFor(() => document.querySelector('.overlay-bg .dialog-foot .primary'), 'a dialog');
  for (const [k, v] of Object.entries(values)) {
    const el = document.querySelector(`.overlay-bg #f-${k}`);
    ok(el, `field ${k}`);
    if (el.type === 'checkbox') el.checked = v; else el.value = v;
  }
  document.querySelector('.overlay-bg .dialog-foot .primary').click();
  await wait(30);
};
const lastSaved = async (count = 1) => { await waitFor(() => saved.length >= count, 'a saved file'); return saved[saved.length - 1]; };
const reopen = (blob, pw) => A.openPdf(blob, async retry => (retry ? null : pw ?? null));
const words = async (pdf, i) => (await (await pdf.getPage(i + 1)).getTextContent()).items.map(x => x.str).join(' ');
const annotsOf = async (pdf, i) => (await pdf.getPage(i + 1)).getAnnotations({ intent: 'display' });

// ---- Opening and saving ----

await test('Open: ribbon button with a PDF and with a picture', async () => {
  await closeAll();
  const f = await fx('normal.pdf');
  openHandles = [fakeHandle('normal.pdf', f)];
  await ribbon('Home', 'Open');
  await waitFor(() => app.session?.name === 'normal.pdf', 'the PDF');
  const png = await window.mockGemini();
  openHandles = [fakeHandle('shot.png', new File([png], 'shot.png', { type: 'image/png' }))];
  // getFile above returns a PDF type, so make this one honest.
  openHandles[0].getFile = async () => new File([png], 'shot.png', { type: 'image/png' });
  await closeAll();
  await ribbon('Home', 'Open');
  await waitFor(() => app.session?.pages[0].annots.some(a => a.kind === 'image'), 'the picture');
  // Cancelling the picker is not an error.
  await ribbon('Home', 'Open');
  await wait(100);
  ok(![...document.querySelectorAll('.toast.error')].length, 'no error');
});

await test('Save writes to the file, reopens clean, and can be repeated', async () => {
  const s = await fresh();
  s.addAnnots(s.pages[0], [{ id: 'x1', kind: 'rect', rect: [100, 100, 200, 200], color: '#ff0000', opacity: 1, width: 2 }]);
  ok(s.dirty, 'marked unsaved');
  await ribbon('Home', 'Save');
  await lastSaved(1);
  await waitFor(() => !s.dirty, 'clean after saving');
  ok(!s.canUndo, 'history starts fresh on the saved file');
  ok(document.title.indexOf('•') < 0, 'title shows no unsaved mark');
  await settle();
  await wait(200);
  const ghost = s.pages[0].annots.find(a => a.kind === 'rect');
  ok(ghost?.ghost, 'the square is now in the file');
  // Second round: edit the saved square, add another, save again.
  const { ghost: _g, ...rest } = ghost;
  s.replaceAnnot(s.pages[0], ghost, { ...rest, color: '#00aa00' });
  s.addAnnots(s.pages[0], [{ id: 'x2', kind: 'ellipse', rect: [300, 100, 400, 200], color: '#0000ff', opacity: 1, width: 2 }]);
  await ribbon('Home', 'Save');
  await lastSaved(2);
  await waitFor(() => !s.dirty, 'clean again');
  const r = await reopen(saved[1].blob);
  const list = await annotsOf(r.pdf, 0);
  eq(list.filter(a => a.subtype === 'Square').length, 1, 'still one square');
  eq(list.filter(a => a.subtype === 'Circle').length, 1, 'one circle');
  await r.close();
  // Save As makes a separate file and moves the document to it.
  await ribbon('Home', 'Save as');
  await lastSaved(3);
  ok(saved[2].blob.size > 1000);
});

await test('A failed save keeps the work and offers another place', async () => {
  const s = await fresh();
  s.addAnnots(s.pages[0], [{ id: 'y1', kind: 'rect', rect: [100, 100, 200, 200], color: '#ff0000', opacity: 1, width: 2 }]);
  saveFails = true;
  await ribbon('Home', 'Save');
  await waitFor(() => document.querySelector('.overlay-bg')?.textContent.includes('Could not save there'), 'the warning');
  ok(s.dirty, 'still marked unsaved');
  ok(s.pages[0].annots.some(a => a.id === 'y1'), 'edit is safe');
  saveFails = false;
  [...document.querySelectorAll('.overlay-bg .btn')].find(b => b.textContent.startsWith('Save elsewhere')).click();
  await lastSaved(1);
  await waitFor(() => !s.dirty, 'saved in the new place');
});

await test('Closing with unsaved work can save first', async () => {
  const s = await fresh();
  s.addAnnots(s.pages[0], [{ id: 'z1', kind: 'rect', rect: [100, 100, 200, 200], color: '#ff0000', opacity: 1, width: 2 }]);
  const closing = app.closeSession(s);
  await waitFor(() => document.querySelector('.overlay-bg')?.textContent.includes('Save your changes'), 'the question');
  document.querySelector('.overlay-bg .primary').click();
  await lastSaved(1);
  await closing;
  eq(app.sessions.length, 0, 'closed after saving');
  // Cancel keeps it open.
  const s2 = await fresh();
  s2.markDirty();
  const c2 = app.closeSession(s2);
  await waitFor(() => document.querySelector('.overlay-bg')?.textContent.includes('Save your changes'), 'the question');
  [...document.querySelectorAll('.overlay-bg .btn')].find(b => b.textContent === 'Cancel').click();
  await c2;
  eq(app.sessions.length, 1, 'still open');
});

// ---- Page commands ----

await test('Pages tab: rotate, duplicate, blank, delete, insert, merge', async () => {
  const s = await fresh();
  await ribbon('Pages', 'Rotate right');
  eq(s.pages[0].rotate, 90);
  await ribbon('Pages', 'Rotate left');
  eq(s.pages[0].rotate, 0);
  await ribbon('Pages', 'Duplicate');
  eq(s.pages.length, 13);
  await ribbon('Pages', 'Blank page');
  eq(s.pages.length, 14);
  await settle();
  eq(s.pages[app.viewer.current].source, null, 'jumped to the blank page');
  await ribbon('Pages', 'Delete');
  eq(s.pages.length, 13);
  nextFiles = [await fx('form.pdf')];
  await ribbon('Pages', 'From file');
  await waitFor(() => s.pages.length === 14, 'the inserted page');
  nextFiles = [await fx('annotated.pdf'), new File([await window.mockGemini()], 'a.png', { type: 'image/png' })];
  await ribbon('Pages', 'Merge');
  await waitFor(() => s.pages.length === 17, 'merged pages');
  const { blob } = await A.buildFile(s);
  const r = await reopen(blob);
  eq(r.pdf.numPages, 17, 'all saved');
  await r.close();
  // Merge with nothing open makes a new document.
  await closeAll();
  nextFiles = [await fx('normal.pdf'), await fx('form.pdf')];
  await ribbon('Pages', 'Merge');
  await waitFor(() => app.session?.pages.length === 13, 'a merged document');
});

await test('Extract and split through their dialogs', async () => {
  const s = await fresh();
  await ribbon('Pages', 'Extract');
  await fill({ range: '1-2, 5' });
  let out = await lastSaved(1);
  let r = await reopen(out.blob);
  eq(r.pdf.numPages, 3, 'extracted');
  ok((await words(r.pdf, 2)).includes('needle5'));
  await r.close();
  // A bad range is refused kindly.
  await ribbon('Pages', 'Extract');
  await fill({ range: 'abc' });
  await waitFor(() => [...document.querySelectorAll('.toast')].some(t => t.textContent.includes('No valid pages')), 'the message');
  await ribbon('Pages', 'Split');
  await fill({ mode: 'every', n: 5 });
  out = await lastSaved(2);
  let zip = A.unzipSync(new Uint8Array(await out.blob.arrayBuffer()));
  eq(Object.keys(zip).length, 3, 'three files');
  await ribbon('Pages', 'Split');
  await fill({ mode: 'ranges', ranges: '1-3; 4-; 99' });
  out = await lastSaved(3);
  zip = A.unzipSync(new Uint8Array(await out.blob.arrayBuffer()));
  eq(Object.keys(zip).length, 2, 'two ranges');
  r = await reopen(new Blob([Object.values(zip)[1]]));
  eq(r.pdf.numPages, 9, 'second part');
  await r.close();
  void s;
});

// ---- Insert tab ----

await test('Watermark, header and footer, page numbers, Bates dialogs', async () => {
  const s = await fresh();
  await ribbon('Insert', 'Watermark');
  await fill({ text: 'DRAFT COPY', range: '1-2' });
  await wait(50);
  ok(s.pages[0].annots.some(a => a.text === 'DRAFT COPY'), 'watermark');
  ok(!s.pages[2].annots.some(a => a.text === 'DRAFT COPY'), 'only on chosen pages');
  await ribbon('Insert', 'Header & footer');
  await fill({ tc: '{file}', bc: 'Page {page} of {pages}' });
  await wait(50);
  await ribbon('Insert', 'Page numbers');
  await fill({ pos: 'br', format: 'Page {page}', start: 5 });
  await wait(50);
  ok(s.pages[1].annots.some(a => a.text === 'Page 6'), 'starts at the chosen number');
  await ribbon('Insert', 'Bates numbers');
  await fill({ prefix: 'CASE-', digits: 4, start: 12 });
  await wait(50);
  ok(s.pages[0].annots.some(a => a.text === 'CASE-0012'), 'Bates');
  const { blob } = await A.buildFile(s);
  const r = await reopen(blob);
  const t = await words(r.pdf, 1);
  ok(t.includes('Page 2 of 12') && t.includes('normal.pdf') && t.includes('Page 6') && t.includes('CASE-0013') && t.includes('DRAFT COPY'), `page text: ${t.slice(-160)}`);
  await r.close();
});

await test('Page theme and all images dialogs', async () => {
  const s = await fresh();
  await ribbon('Insert', 'Page theme');
  await fill({ mode: 'dark', style: 'neutral', range: '1-2' });
  await waitFor(() => s.pages[1].annots.some(a => a.kind === 'image'), 'converted pages');
  await ribbon('Insert', 'All images');
  await fill({ mode: 'light', style: 'gemini' });
  await waitFor(() => s.pages[0].annots.find(a => a.kind === 'image').image.theme === 'light', 'all images light');
  await waitFor(() => !document.querySelector('.overlay-bg'), 'done');
  // Nothing to convert gives a message.
  const s2 = await fresh();
  await ribbon('Insert', 'All images');
  await waitFor(() => [...document.querySelectorAll('.toast')].some(t => t.textContent.includes('no images')), 'the message');
  void s2;
});

// ---- Protect tab ----

await test('Protect: add password, remove password, clean, properties, check, PDF/A', async () => {
  const s = await fresh();
  await ribbon('Protect', 'Add password');
  await fill({ user: 'open-me', owner: 'owner-me', print: true, copy: false, edit: false });
  let out = await lastSaved(1);
  let refused = false;
  try { const x = await reopen(out.blob, 'bad'); await x.close(); } catch { refused = true; }
  ok(refused, 'needs the password');
  let r = await reopen(out.blob, 'open-me');
  eq(r.pdf.numPages, 12);
  await r.close();
  // Empty password is refused kindly.
  await ribbon('Protect', 'Add password');
  await fill({});
  await waitFor(() => [...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Enter a password')), 'the message');
  // Removing when there is none says so.
  await ribbon('Protect', 'Remove password');
  await waitFor(() => [...document.querySelectorAll('.toast')].some(t => t.textContent.includes('does not need')), 'the message');
  await ribbon('Protect', 'Clean metadata');
  out = await lastSaved(2);
  ok(out.name.includes('clean'));
  await ribbon('Protect', 'Properties');
  await fill({ title: 'New title', author: 'Someone' });
  await wait(30);
  eq(s.pendingOptions.metadata.title, 'New title');
  await ribbon('Home', 'Save');
  out = await lastSaved(3);
  r = await reopen(out.blob);
  eq((await r.pdf.getMetadata()).info.Title, 'New title', 'properties are saved');
  await r.close();
  await waitFor(() => !s.dirty, 'saved');
  await ribbon('Protect', 'Check file');
  await waitFor(() => document.querySelector('.chk-table'), 'the report');
  document.querySelector('.overlay-bg .primary').click();
  await wait(30);
  await ribbon('Protect', 'Save as PDF/A');
  await fill({ level: '2B' });
  out = await lastSaved(4);
  const info = await A.inspectFile(out.blob);
  ok(String(info.pdfa).startsWith('2'), `labelled: ${info.pdfa}`);
});

await test('Locked file: remove password through the button', async () => {
  await closeAll();
  saved.length = 0;
  const f = await fx('locked.pdf');
  const p = app.openPdfBlob(f, 'locked.pdf');
  const input = await waitFor(() => document.querySelector('.overlay-bg input[type=password]'), 'the password box');
  input.value = 'secret';
  document.querySelector('.overlay-bg .primary').click();
  await p;
  await settle();
  await ribbon('Protect', 'Remove password');
  const out = await lastSaved(1);
  const r = await reopen(out.blob);
  eq(r.pdf.numPages, 3, 'opens with no password');
  ok((await words(r.pdf, 0)).includes('Locked page 1'));
  await r.close();
});

await test('Digital ID and signature through the real flow', async () => {
  const s = await fresh();
  await ribbon('Protect', 'Create digital ID');
  await fill({ name: 'Test Person', email: 'a@b.c', password: 'pw1', years: 3 });
  const id = await lastSaved(1);
  ok(id.name.endsWith('.p12'), id.name);
  nextFiles = [new File([id.blob], 'id.p12')];
  await ribbon('Protect', 'Digital signature');
  await fill({ password: 'wrong', reason: 'Approved', location: 'Cairo', visible: false });
  await waitFor(() => [...document.querySelectorAll('.toast.error')].some(t => t.textContent.includes('not correct')), 'the wrong password message');
  nextFiles = [new File([id.blob], 'id.p12')];
  await ribbon('Protect', 'Digital signature');
  await fill({ password: 'pw1', reason: 'Approved', location: 'Cairo', visible: false });
  const out = await lastSaved(2);
  ok(out.name.includes('signed'));
  const bytes = new TextDecoder('latin1').decode(await out.blob.arrayBuffer());
  ok(/\/ByteRange\s*\[\s*0 \d+ \d+ \d+/.test(bytes), 'byte range is filled in');
  ok(!bytes.includes('**********'), 'no placeholder left');
  const r = await reopen(out.blob);
  eq(r.pdf.numPages, 12);
  await r.close();
  void s;
});

// ---- Edit and forms ----

await test('Apply redactions dialog and find and redact', async () => {
  const s = await fresh();
  app.panels.show('search');
  app.panels.search.input.value = 'needle2';
  app.panels.search.input.dispatchEvent(new Event('input'));
  await waitFor(() => app.panels.search.matches.length === 1, 'a search result');
  [...document.querySelectorAll('.panel:not([hidden]) .btn')].find(b => b.textContent.includes('redaction')).click();
  await wait(50);
  ok(s.pages[1].annots.some(a => a.kind === 'redact'), 'marked');
  await ribbon('Edit', 'Apply redactions');
  await fill();
  await waitFor(() => s.pages[1].source === null, 'page converted');
  await settle();
  const { blob } = await A.buildFile(s);
  const r = await reopen(blob);
  ok(!(await words(r.pdf, 1)).includes('needle2'), 'gone');
  ok((await words(r.pdf, 2)).includes('needle3'), 'others stay');
  await r.close();
  app.panels.show('thumbs');
  // With nothing marked.
  await fresh();
  await ribbon('Edit', 'Apply redactions');
  await waitFor(() => [...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Nothing is marked')), 'the message');
});

await test('Flatten buttons and detect fields button', async () => {
  const s = await fresh('form.pdf');
  await ribbon('Forms', 'Flatten forms');
  let out = await lastSaved(1);
  let r = await reopen(out.blob);
  eq((await annotsOf(r.pdf, 0)).filter(a => a.subtype === 'Widget').length, 0, 'flat');
  await r.close();
  await ribbon('Forms', 'Detect fields');
  await waitFor(() => [...document.querySelectorAll('.toast')].some(t => /field|No blank/.test(t.textContent)), 'the result');
  s.addAnnots(s.pages[0], [{ id: 'q', kind: 'rect', rect: [100, 100, 200, 200], color: '#ff0000', opacity: 1, width: 2 }]);
  await ribbon('Convert', 'Flatten');
  out = await lastSaved(2);
  r = await reopen(out.blob);
  eq((await annotsOf(r.pdf, 0)).filter(a => a.subtype === 'Square').length, 0, 'square is page content');
  await r.close();
});

// ---- Convert tab ----

await test('Convert tab: all exports', async () => {
  const s = await fresh();
  s.setPages(s.pages.slice(0, 2), 'short');
  let n = 0;
  for (const [label, ext, sig] of [['To text', 'txt', null], ['To HTML', 'html', null], ['To Word', 'docx', 'PK'], ['To Excel', 'xlsx', 'PK'], ['To PowerPoint', 'pptx', 'PK']]) {
    await ribbon('Convert', label);
    const out = await lastSaved(++n);
    ok(out.name.endsWith(ext), out.name);
    ok(out.blob.size > 30, `${label} has content`);
    if (sig) eq(new TextDecoder().decode(await out.blob.slice(0, 2).arrayBuffer()), sig, label);
    await waitFor(() => !document.querySelector('.overlay-bg'), 'progress window to close');
  }
  await ribbon('Convert', 'To images');
  await fill({ format: 'png', dpi: '96' });
  let out = await lastSaved(++n);
  const zip = A.unzipSync(new Uint8Array(await out.blob.arrayBuffer()));
  eq(Object.keys(zip).length, 2, 'two pictures');
  await ribbon('Convert', 'To images');
  await fill({ format: 'jpg', dpi: '150' });
  out = await lastSaved(++n);
  ok(out.name.endsWith('.zip'));
  await ribbon('Convert', 'Compress');
  await fill({ level: 'strong' });
  out = await lastSaved(++n);
  ok(out.name.includes('compressed'));
});

await test('Images to PDF, Convert image, OCR, batch, compare, notes', async () => {
  await closeAll();
  saved.length = 0;
  const png = new File([await window.mockGemini()], 'one.png', { type: 'image/png' });
  nextFiles = [png, png];
  await ribbon('Convert', 'Images to PDF');
  await waitFor(() => app.session?.pages.length === 2, 'two pages');
  const s = app.session;
  await settle();
  ok(Math.abs(s.pages[0].view[2] - 1100 * 0.75) < 1, `page fits the picture: ${s.pages[0].view[2]}`);
  const { blob } = await A.buildFile(s);
  let r = await reopen(blob);
  eq(r.pdf.numPages, 2);
  await r.close();
  // Convert image.
  nextFiles = [png];
  await ribbon('Convert', 'Convert image');
  await fill({ to: 'jpg' });
  let out = await lastSaved(1);
  ok(out.name.endsWith('.jpg'));
  eq((await createImageBitmap(out.blob)).width, 1100, 'picture converted');
  // OCR through the dialog.
  await closeAll();
  const c = new OffscreenCanvas(1000, 300);
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, 1000, 300);
  x.fillStyle = '#000'; x.font = '44px Arial'; x.fillText('Receipt number 7741', 40, 120);
  const pic = await c.convertToBlob({ type: 'image/png' });
  await app.pasteImages([pic]);
  await wait(300);
  const flat = await A.buildFile(app.session, { flattenAnnots: true });
  await closeAll();
  const scan = await app.openPdfBlob(new File([flat.blob], 'scan.pdf', { type: 'application/pdf' }), 'scan.pdf');
  await settle();
  await ribbon('Convert', 'OCR');
  await fill({ range: '1' });
  await waitFor(() => scan.ocrWords.get(scan.pages[0].id)?.length > 2, 'recognised words', 40000);
  await waitFor(() => !document.querySelector('.overlay-bg'), 'progress window to close');
  // Batch.
  nextFiles = [await fx('normal.pdf'), await fx('form.pdf')];
  await ribbon('Convert', 'Batch');
  await fill({ job: 'clean' });
  out = await lastSaved(2);
  eq(Object.keys(A.unzipSync(new Uint8Array(await out.blob.arrayBuffer()))).length, 2, 'two results');
  // Compare.
  await fresh();
  nextFiles = [await fx('annotated.pdf')];
  await ribbon('Convert', 'Compare');
  await waitFor(() => document.querySelector('.cmp-grid'), 'compare results');
  document.querySelector('.overlay-bg .primary').click();
  await wait(50);
  // Notes out and in.
  const s3 = app.session;
  s3.addAnnots(s3.pages[0], [{ id: 'n1', kind: 'rect', rect: [100, 100, 200, 200], color: '#ff0000', opacity: 1, width: 2 }]);
  saved.length = 0;
  await ribbon('Convert', 'Export notes');
  out = await lastSaved(1);
  ok(out.name.endsWith('.xfdf'));
  nextFiles = [new File([out.blob], 'n.xfdf')];
  await ribbon('Convert', 'Import notes');
  await waitFor(() => s3.pages[0].annots.filter(a => a.kind === 'rect').length === 2, 'imported notes');
  // Text compare.
  await ribbon('Convert', 'Text compare');
  await waitFor(() => document.querySelector('.text-cmp'), 'text compare');
  document.querySelector('.overlay-bg .primary').click();
});

await test('Print prepares every page, with edits', async () => {
  const s = await fresh();
  s.setPages(s.pages.slice(0, 3), 'short');
  s.addAnnots(s.pages[0], [{ id: 'p1', kind: 'rect', rect: [100, 100, 300, 300], color: '#ff0000', fill: '#ff0000', opacity: 1, width: 2 }]);
  let frame = null;
  const realPrint = window.HTMLIFrameElement;
  void realPrint;
  const obs = new MutationObserver(list => { for (const m of list) for (const n of m.addedNodes) if (n.tagName === 'IFRAME') frame = n; });
  obs.observe(document.body, { childList: true });
  await ribbon('Home', 'Print');
  await waitFor(() => frame, 'the print frame', 20000);
  await waitFor(() => frame.contentDocument?.images.length === 3, 'three page pictures', 20000);
  obs.disconnect();
  const img = frame.contentDocument.images[0];
  await img.decode();
  ok(img.naturalWidth > 500, 'sharp picture');
  // The red square is part of what prints.
  const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight).getContext('2d');
  c.drawImage(img, 0, 0);
  const k = img.naturalWidth / 612;
  const px = c.getImageData(200 * k, (792 - 200) * k, 1, 1).data;
  ok(px[0] > 200 && px[1] < 60, `edits print: ${[...px]}`);
  frame.remove();
});

// ---- Reading ----

await test('Outline, internal links, layers', async () => {
  const s = await fresh('structure.pdf');
  await wait(300);
  app.panels.show('outline');
  const link = await waitFor(() => [...document.querySelectorAll('.tree-link')].find(b => b.textContent === 'Chapter three'), 'the contents list');
  link.click();
  await waitFor(() => app.viewer.current === 2, 'jump from the contents');
  await settle();
  app.panels.show('thumbs');
  app.viewer.goTo(0);
  await settle();
  await wait(300);
  const a = await waitFor(() => document.querySelector('.pdf-link'), 'link on the page');
  a.click();
  await waitFor(() => app.viewer.current === 1, 'jump from the link');
  // Layers: hide one and the page is redrawn without it.
  app.viewer.goTo(0);
  await settle();
  const red = () => {
    const v = app.viewer.views.get(s.pages[0].id);
    const k = v.canvas.width / parseFloat(v.el.style.width) * app.viewer.scale;
    return [...v.canvas.getContext('2d').getImageData(200 * k, (792 - 500) * k, 1, 1).data];
  };
  ok(red()[1] < 50, `layer shows at first: ${red()}`);
  app.panels.show('layers');
  const box = await waitFor(() => document.querySelector('.layer-row input'), 'the layer list');
  box.click();
  await wait(100);
  await settle();
  await wait(300);
  ok(red()[1] > 200, `layer hidden: ${red()}`);
  app.panels.show('thumbs');
});

await test('Reading modes and full screen buttons', async () => {
  await fresh();
  await ribbon('Home', 'Night');
  eq(app.viewer.scroller.dataset.reading, 'night');
  ok(getComputedStyle(document.querySelector('.page canvas')).filter.includes('invert'), 'pages invert');
  await ribbon('Home', 'Sepia');
  ok(getComputedStyle(document.querySelector('.page canvas')).filter.includes('sepia'), 'pages warm');
  await ribbon('Home', 'Normal');
  eq(getComputedStyle(document.querySelector('.page canvas')).filter, 'none');
  await ribbon('Home', 'Fit page');
  await ribbon('Home', 'Two pages');
  ok(app.viewer.rows[0].pages.length === 2);
  await ribbon('Home', 'Scroll');
  await ribbon('Home', 'Reflow');
  await waitFor(() => document.querySelector('.reflow'), 'reflow');
  document.querySelector('.overlay-bg .primary').click();
  await wait(30);
  await ribbon('Shapes', 'Scale');
  await fill({ real: 10, unit: 'ft' });
  await wait(30);
  const m = app.tools.hooks.measure();
  eq(m.unit, 'ft');
  ok(Math.abs(m.scale * 72 - 10) < 0.01, 'scale stored');
  localStorage.removeItem('pdfy.measure');
  document.documentElement.requestFullscreen = async () => { document.documentElement.dataset.fs = '1'; };
  await ribbon('Home', 'Full screen');
  await wait(30);
  eq(document.documentElement.dataset.fs, '1', 'full screen asked for');
  app.setMode('view');
});

await test('Pin a file to a spot, and a voice note', async () => {
  const s = await fresh();
  const place = async () => {
    const v = app.viewer.views.get(s.pages[0].id);
    const r = v.el.getBoundingClientRect();
    v.el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: r.left + 200, clientY: r.top + 200 }));
    await wait(30);
  };
  nextFiles = [new File(['hello pinned file'], 'notes.txt', { type: 'text/plain' })];
  await ribbon('Comment', 'Attach file');
  await waitFor(() => app.tools.tool === 'attach', 'attach mode');
  await place();
  const a = s.pages[0].annots.find(x => x.kind === 'attachment');
  ok(a, 'pinned');
  eq(a.attachment.name, 'notes.txt');
  // The microphone here is a test signal.
  await ribbon('Comment', 'Voice note');
  await waitFor(() => document.querySelector('.rec-time'), 'recording window');
  await wait(600);
  document.querySelector('.overlay-bg .primary').click();
  await waitFor(() => app.tools.tool === 'attach', 'place voice note');
  await place();
  const voice = s.pages[0].annots.find(x => x.attachment?.voice);
  ok(voice, 'voice note pinned');
  ok(voice.attachment.blob.size > 100, `recorded ${voice.attachment.blob.size} bytes`);
  const { blob, warnings } = await A.buildFile(s);
  eq(warnings.length, 0, warnings.join(';'));
  await fetch('/__save/attachment-output.pdf', { method: 'PUT', body: blob });
  const r = await reopen(blob);
  const list = (await annotsOf(r.pdf, 0)).filter(x => x.subtype === 'FileAttachment');
  eq(list.length, 2, 'both saved');
  ok(list.some(x => x.file?.filename === 'notes.txt'), `file name: ${JSON.stringify(list.map(x => x.file))}`);
  await r.close();
  return `voice note ${voice.attachment.blob.size} bytes`;
});

await test('Camera scan with a test camera', async () => {
  await closeAll();
  void app.scanCmd();
  const video = await waitFor(() => document.querySelector('.scan-video'), 'the camera window');
  await waitFor(() => video.videoWidth > 0, 'camera picture');
  [...document.querySelectorAll('.overlay-bg .btn')].find(b => b.textContent === 'Take picture').click();
  await waitFor(() => document.querySelector('.scan-strip img'), 'the picture');
  await wait(200);
  document.querySelector('.overlay-bg .primary').click();
  await waitFor(() => app.session?.pages.length === 1, 'a page');
  ok(app.session.pages[0].annots.some(a => a.kind === 'image'), 'scan is on the page');
});

await test('Word editor: open, change, save, and read back', async () => {
  await closeAll();
  saved.length = 0;
  nextFiles = [await fx('sample.docx')];
  await ribbon('Convert', 'Word editor');
  await waitFor(() => document.querySelector('.overlay-bg .primary')?.textContent === 'Open a Word file', 'the choice');
  document.querySelector('.overlay-bg .primary').click();
  const sheet = await waitFor(() => document.querySelector('.doc-sheet'), 'the editor');
  ok(sheet.textContent.includes('Quarterly report'), 'document shows');
  ok(sheet.querySelector('table'), 'table shows');
  ok(sheet.querySelector('img'), 'picture shows');
  // A real edit through the browser's editing commands.
  const h1 = sheet.querySelector('h1');
  const range = document.createRange();
  range.selectNodeContents(h1);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  sheet.focus();
  document.execCommand('insertText', false, 'Annual report');
  sheet.dispatchEvent(new Event('input', { bubbles: true }));
  const end = document.createRange();
  end.selectNodeContents(sheet.querySelectorAll('p')[1]);
  sel.removeAllRanges();
  sel.addRange(end);
  document.execCommand('bold');
  [...document.querySelectorAll('.doc-bar .btn')].find(b => b.textContent === 'Save Word file').click();
  const out = await lastSaved(1);
  eq(out.name, 'sample.docx');
  const zip = A.unzipSync(new Uint8Array(await out.blob.arrayBuffer()));
  const xml = A.strFromU8(zip['word/document.xml']);
  ok(!new DOMParser().parseFromString(xml, 'application/xml').querySelector('parsererror'), 'valid XML');
  ok(xml.includes('Annual report'), 'edit saved');
  ok(xml.includes('w:val="Heading1"'), 'heading kept');
  ok(xml.includes('<w:tbl>'), 'table kept');
  ok(xml.includes('<w:numPr>'), 'lists kept');
  ok(xml.includes('<w:drawing>') && Object.keys(zip).some(k => k.startsWith('word/media/')), 'picture kept');
  ok(xml.includes('هذا نص عربي'), 'Arabic kept');
  ok(xml.includes('<w:bidi/>'), 'right-to-left kept');
  ok(xml.includes('https://example.com/') || A.strFromU8(zip['word/_rels/document.xml.rels']).includes('https://example.com/'), 'link kept');
  // It reads back through the converter, as a second round would.
  const again = A.docxToPrint(new Uint8Array(await out.blob.arrayBuffer()));
  ok(again.html.includes('Annual report') && again.html.includes('Long content line number 70'), 'round trip');
  ok(!again.html.includes('• First') || again.html.includes('wnum'), 'no doubled bullets');
  await fetch('/__save/edited.docx', { method: 'PUT', body: out.blob });
  // Closing asks only if there is unsaved work.
  document.querySelector('.overlay-bg .dialog-head .icon-btn').click();
  await wait(100);
  ok(!document.querySelector('.doc-sheet'), 'closed after saving');
  // A new blank document.
  saved.length = 0;
  await ribbon('Convert', 'Word editor');
  await waitFor(() => document.querySelector('.overlay-bg .dialog-foot .btn'), 'the choice');
  [...document.querySelectorAll('.overlay-bg .btn')].find(b => b.textContent === 'New document').click();
  const blank = await waitFor(() => document.querySelector('.doc-sheet'), 'a blank page');
  blank.focus();
  document.execCommand('insertText', false, 'Fresh words');
  blank.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('.doc-bar [title="Insert table"]')][0].click();
  [...document.querySelectorAll('.doc-bar .btn')].find(b => b.textContent === 'Save Word file').click();
  const made = await lastSaved(1);
  const xml2 = A.strFromU8(A.unzipSync(new Uint8Array(await made.blob.arrayBuffer()))['word/document.xml']);
  ok(xml2.includes('Fresh words') && xml2.includes('<w:tbl>'), 'new document saved');
  document.querySelector('.overlay-bg .dialog-head .icon-btn').click();
});

await test('Form fields added by drag and dialog', async () => {
  const s = await fresh();
  const v = app.viewer.views.get(s.pages[0].id);
  const r = v.el.getBoundingClientRect();
  app.tools.setTool('field-dropdown');
  // A pointer gesture over the page.
  const fire = (type, x, y) => (type === 'down' ? v.el.querySelector('.overlay') ?? v.el : window).dispatchEvent(new PointerEvent(type === 'down' ? 'pointerdown' : type === 'move' ? 'pointermove' : 'pointerup', { bubbles: true, button: 0, clientX: x, clientY: y }));
  v.el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: r.left + 100, clientY: r.top + 100 }));
  fire('move', r.left + 300, r.top + 140);
  fire('up', r.left + 300, r.top + 140);
  await waitFor(() => document.querySelector('.overlay-bg #f-options'), 'the field dialog');
  await fill({ name: 'colour', options: 'Red\nGreen' });
  await waitFor(() => s.pages[0].annots.some(a => a.field), 'the field');
  const { blob } = await A.buildFile(s);
  const o = await reopen(blob);
  const w = (await annotsOf(o.pdf, 0)).find(x => x.fieldName === 'colour');
  ok(w, 'saved');
  eq(w.options.length, 2, 'choices saved');
  await o.close();
});

await closeAll();
document.querySelectorAll('.toast').forEach(t => t.remove());
export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length } };
