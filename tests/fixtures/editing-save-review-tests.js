// The user's editing/save checklist, exercised through controls and real PDF save output.
const app = window.__pdfy, api = window.__api, results = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
const ok = (v, message) => { if (!v) throw new Error(message); };
const until = async fn => { for (let i = 0; i < 200; i++) { const v = fn(); if (v) return v; await wait(25); } throw new Error('Timed out'); };
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
async function closeAll() { app.tools.cancel(); for (const s of [...app.sessions]) { s.dirty = false; if (s.handle?.writes) s.handle = null; await app.closeSession(s); } }
async function test(name, run) {
  console.log('TEST', name);
  try { await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: String(error.message ?? error) }); }
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), results }) });
}
async function blank() {
  await closeAll(); const s = app.newDocument(); app.setMode('edit');
  document.querySelectorAll('.toast').forEach(t => t.remove());
  app.viewer.setScale(1);
  await until(() => app.viewer.views.get(s.pages[0].id));
  return s;
}
const ink = (id, width = 2) => ({ id, kind: 'ink', rect: [30, 400, 180, 420], paths: [[30, 410, 180, 410]], color: '#111111', width, opacity: 1 });
const text = (id, fontSize = 12) => ({ id, kind: 'text', rect: [30, 300, 250, 350], text: id, color: '#111111', textColor: '#111111', width: 0, opacity: 1, fontSize, font: 'helvetica' });
function select(s, annots) {
  app.tools.setTool('hand'); app.viewer.select(s.pages[0].id, annots[0].id);
  for (const a of annots.slice(1)) app.viewer.toggleSelect(s.pages[0].id, a.id);
  app.onSelection();
}
function control(label, selector = 'input,select,button') {
  const l = [...document.querySelectorAll('.style-bar > label')].find(l => l.firstChild?.textContent?.trim() === label || l.textContent.trim() === label);
  return l?.querySelector(selector);
}
async function change(label, value) {
  const c = control(label); ok(c, `Missing ${label} control`); c.value = value;
  c.dispatchEvent(new Event('change', { bubbles: true })); await wait(60);
}
function handle(name, options = {}) {
  let current = new Blob([], { type: 'application/pdf' }); const writes = [];
  return { name, kind: 'file', writes,
    queryPermission: async () => 'granted', requestPermission: async () => 'granted',
    getFile: async () => new File([current], name, { type: 'application/pdf' }),
    createWritable: async () => ({
      write: async blob => { writes.push(blob); await options.write?.(blob, writes.length); current = blob; },
      close: async () => {}, abort: async () => {},
    }),
  };
}
async function savedAnnots(blob) {
  const doc = await api.openPdf(blob);
  try { const p = await doc.pdf.getPage(1); return { rotation: p.rotate, annots: await p.getAnnotations() }; }
  finally { await doc.close(); }
}

await test('Bulk ink editing shows style controls and changes every selected stroke in one undo', async () => {
  const s = await blank(), p = s.pages[0], annots = [ink('a'), ink('b', 4), ink('c')];
  s.addAnnots(p, annots); select(s, annots);
  ok(control('Thickness')?.placeholder === 'Mixed' && control('Thickness').value === '', 'mixed thickness should be explicit');
  ok(!control('Font'), 'ink should not show font controls');
  ok([...document.querySelectorAll('.style-bar button')].some(b => b.textContent === 'Align'), 'alignment must remain available');
  await change('Thickness', '6'); ok(p.annots.every(a => a.width === 6), 'only one ink stroke changed');
  s.undo(); ok(p.annots.map(a => a.width).join() === '2,4,2', 'bulk width must undo in one step');
  s.redo(); ok(p.annots.every(a => a.width === 6), 'bulk width did not redo');
  document.querySelector('.style-bar [aria-label="Colour #1a56db"]').click(); await wait(60);
  await change('Opacity', '0.4');
  ok(p.annots.every(a => a.color === '#1a56db' && a.opacity === .4), 'bulk ink colour/opacity failed');
  await window.__shot('bulk-ink-properties');
});

await test('Mixed selections follow the majority type and apply only compatible properties', async () => {
  const s = await blank(), p = s.pages[0];
  const annots = [ink('minority'), text('first', 12), text('second', 16), text('third', 12)];
  s.addAnnots(p, annots); select(s, annots);
  ok(control('Font') && control('Size'), 'text majority must show font/size even when the primary object is ink');
  ok(!control('Thickness'), 'the minority ink must not determine the controls');
  ok(control('Size').value === '', 'mixed text sizes should show Mixed');
  await change('Size', '24');
  ok(p.annots.filter(a => a.kind === 'text').every(a => a.fontSize === 24), 'not all text sizes changed');
  ok(p.annots[0].fontSize === undefined && p.annots[0].width === 2, 'font size must not change ink');
  await app.applyStyle({ fontName: 'Arial', bold: true, italic: true, color: '#d92d20', fill: '#ffffff' });
  ok(p.annots.filter(a => a.kind === 'text').every(a => a.fontName === 'Arial' && a.bold && a.italic && a.textColor === '#d92d20' && a.fill === '#ffffff'), 'text properties did not apply to all text boxes');
  ok(p.annots[0].color === '#d92d20' && p.annots[0].fill === undefined && p.annots[0].bold === undefined, 'mixed common colour/type-specific properties are wrong');
  select(s, [p.annots[1], p.annots[0]]);
  ok(control('Font'), 'a tied selection should follow its primary type');
  await window.__shot('bulk-text-properties');
});

await test('Selection styles become defaults in other documents and a fresh app instance', async () => {
  const expected = app.tools.style('text');
  ok(expected.color === '#d92d20' && expected.fontSize === 24 && expected.fontName === 'Arial' && expected.bold && expected.italic, 'selected text styles were not remembered');
  const other = app.newDocument(); app.setMode('edit'); app.tools.setTool('text');
  const v = await until(() => app.viewer.views.get(other.pages[0].id));
  const a = { ...app.tools.base('text', 'text'), rect: [30, 200, 250, 250] };
  app.tools.openEditor(v, a, true);
  const editor = document.querySelector('.inline-editor'); editor.value = 'Remembered style';
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await app.tools.settle();
  const created = other.pages[0].annots[0];
  ok(created?.text === 'Remembered style' && created.color === '#d92d20' && created.fontName === 'Arial' && created.fontSize === 24 && created.bold, 'new text in another document lost the saved style');
  const frame = document.createElement('iframe'); frame.hidden = true; frame.src = '/index.html?test=1'; document.body.append(frame);
  try {
    const fresh = await until(() => frame.contentWindow?.__pdfy);
    const style = fresh.tools.style('text');
    ok(style.color === '#d92d20' && style.fontName === 'Arial' && style.fontSize === 24 && style.bold && style.italic && style.fill === '#ffffff', 'styles did not persist through a fresh app load');
  } finally { frame.remove(); }
});

await test('Bulk styling leaves whiteouts, redactions and links unchanged', async () => {
  const s = await blank(), p = s.pages[0];
  const cover = { id: 'cover', kind: 'whiteout', rect: [30, 400, 180, 420], color: '#ffffff', fill: '#ffffff', opacity: 1, width: 0, burn: true };
  const redact = { ...cover, id: 'redaction', kind: 'redact', color: '#000000' };
  const link = { ...cover, id: 'link', kind: 'link', url: 'https://example.com' };
  const before = JSON.stringify([cover, redact, link]), defaults = JSON.stringify(app.tools.style('whiteout'));
  s.addAnnots(p, [cover, redact, link, ink('stroke')]); select(s, p.annots);
  await app.applyStyle({ color: '#d92d20', opacity: .4, width: 6, fill: '#1a56db' });
  ok(JSON.stringify(p.annots.slice(0, 3)) === before, 'bulk properties altered a cover, redaction or link');
  ok(JSON.stringify(app.tools.style('whiteout')) === defaults, 'bulk properties changed the Whiteout default');
  ok(p.annots[3].width === 6 && p.annots[3].opacity === .4, 'compatible ink did not change');
});

await test('Rapid Markdown style changes queue in order and Save waits for them', async () => {
  const s = await blank(), p = s.pages[0];
  const a = { ...text('First note'), markdown: true }, b = { ...text('Second note'), markdown: true };
  s.addAnnots(p, [a, b]); select(s, [a, b]); s.handle = handle('rapid-notes.pdf');
  const first = app.applyStyle({ fontSize: 18 }), second = app.applyStyle({ fontSize: 22 });
  const saving = app.save(); await Promise.all([first, second]); ok(await saving, 'saving queued styles failed');
  ok(p.annots.every(a => a.fontSize === 22), 'a rapid size change was silently dropped');
  s.undo(); ok(p.annots.every(a => a.fontSize === 18), 'the second bulk style was not one undo step');
});

await test('Escape commits new/existing text and Markdown, then returns to Pan', async () => {
  const s = await blank(), p = s.pages[0], v = app.viewer.views.get(p.id);
  for (const markdown of [false, true]) {
    const a = { ...app.tools.base('text', markdown ? 'markdown' : 'text'), rect: [30, 300, 300, 360], markdown };
    app.tools.setTool(markdown ? 'markdown' : 'text'); app.tools.openEditor(v, a, true);
    let editor = document.querySelector('.inline-editor'); editor.value = markdown ? '**Kept Markdown**' : 'Kept text';
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await app.tools.settle();
    let saved = p.annots.find(n => n.id === a.id);
    ok(saved?.text.includes('Kept') && app.tools.tool === 'hand', 'Escape discarded a new draft or did not select Pan');
    app.tools.openEditor(v, saved, false); editor = document.querySelector('.inline-editor'); editor.value += ' edited';
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await app.tools.settle(); saved = p.annots.find(n => n.id === a.id);
    ok(saved.text.endsWith(' edited') && app.tools.tool === 'hand', 'Escape discarded an existing edit');
    s.undo(); ok(!p.annots.find(n => n.id === a.id).text.endsWith(' edited'), 'committed text must remain undoable');
  }
});

await test('Saving a real file preserves undo/redo, original source bytes, and repeated saves', async () => {
  await closeAll();
  const directory = await navigator.storage.getDirectory(), file = await directory.getFileHandle('undo-save-test.pdf', { create: true });
  let writable = await file.createWritable(); await writable.write(await (await fetch('/fixtures/normal.pdf')).blob()); await writable.close();
  try {
    await app.openHandle(file); const s = app.session, p = s.pages[0], source = [...s.sources.values()][0];
    s.addAnnots(p, [text('Undo after saving')]);
    ok(await app.save(), 'the first save failed');
    ok(s.pages[0] === p && s.canUndo && !(source.blob instanceof File), 'saving reset the working model/history or retained a mutable source File');
    ok((await savedAnnots(await file.getFile())).annots.some(a => a.contentsObj?.str === 'Undo after saving'), 'the saved annotation is missing');
    s.undo(); ok(p.annots.length === 0 && s.dirty && s.canRedo, 'saved changes cannot be undone');
    ok(await app.save(), 'saving the undone state failed');
    ok(!(await savedAnnots(await file.getFile())).annots.some(a => a.contentsObj?.str === 'Undo after saving'), 'the undone annotation was written again');
    ok(s.canRedo, 'saving destroyed the redo stack');
    s.redo(); ok(await app.save(), 'saving the redone state failed');
    ok((await savedAnnots(await file.getFile())).annots.some(a => a.contentsObj?.str === 'Undo after saving'), 'redo/save lost the annotation');
  } finally { await closeAll(); await directory.removeEntry('undo-save-test.pdf'); }
});

await test('Background saving freezes output, keeps editing responsive, and preserves newer edits on tab switch', async () => {
  const s = await blank(), p = s.pages[0], started = deferred(), release = deferred();
  const dest = handle('background.pdf', { write: async () => { started.resolve(); await release.promise; } }); s.handle = dest;
  s.addAnnots(p, [text('Before save')]); const saving = app.save(); await started.promise;
  ok(!document.querySelector('.overlay-bg'), 'saving opened a blocking progress dialog');
  s.addAnnots(p, [text('During save')]); s.rotatePages([p.id], 90);
  const other = app.newDocument(); other.addAnnots(other.pages[0], [ink('Editable other tab')]);
  release.resolve(); ok(await saving, 'the background save failed');
  ok(app.session === other && other.pages[0].annots.length === 1, 'saving changed/blocked the active document');
  ok(s.pages[0] === p && p.annots.length === 2 && p.rotate === 90 && s.dirty && s.canUndo, 'edits made during saving were lost or marked saved');
  const saved = await savedAnnots(dest.writes[0]);
  ok(saved.rotation === 0 && saved.annots.length === 1 && saved.annots[0].contentsObj?.str === 'Before save', 'the saved snapshot included later edits');
});

await test('Save As preserves undo and cancellation keeps the current document unchanged', async () => {
  const s = await blank(), p = s.pages[0], original = handle('original.pdf'), destination = handle('renamed.pdf');
  s.handle = original; s.addAnnots(p, [text('Save As undo')]); ok(await app.save(), 'the initial save failed');
  const picker = window.showSaveFilePicker;
  try {
    window.showSaveFilePicker = async () => destination;
    ok(await app.save(true), 'Save As failed');
    ok(s.handle === destination && s.name === destination.name && s.pages[0] === p && s.canUndo, 'Save As reset the working document/history');
    s.undo(); ok(p.annots.length === 0 && await app.save(), 'the Save As result cannot be undone and resaved');
    ok(original.writes.length === 1 && (await savedAnnots(destination.writes.at(-1))).annots.length === 0, 'Save As wrote to the old file or failed to save the undone state');
    s.addAnnots(p, [text('Keep cancelled save')]);
    window.showSaveFilePicker = async () => { throw new DOMException('Cancelled', 'AbortError'); };
    ok(!await app.save(true) && s.dirty && s.canUndo && s.handle === destination && p.annots.length === 1, 'cancelling Save As changed or discarded the document');
  } finally { window.showSaveFilePicker = picker; }
});

await test('Bulk text properties remain within a small window', async () => {
  const s = await blank(), p = s.pages[0]; s.addAnnots(p, [text('One'), text('Two')]); select(s, p.annots);
  await window.__cdp('Emulation.setDeviceMetricsOverride', { width: 560, height: 820, deviceScaleFactor: 1, mobile: false });
  try {
    await wait(150); const r = document.querySelector('.style-bar').getBoundingClientRect();
    ok(r.left >= 0 && r.right <= innerWidth && r.height < 260 && control('Font') && control('Size'), 'bulk text controls overflow the small window');
    await window.__shot('bulk-text-small');
  } finally { await window.__cdp('Emulation.clearDeviceMetricsOverride', {}); await wait(80); }
});

await test('Escape also keeps page-text and comment edits and returns to Pan', async () => {
  await closeAll();
  await app.openFile(new File([await (await fetch('/fixtures/normal.pdf')).blob()], 'page-text.pdf', { type: 'application/pdf' }));
  app.setMode('edit'); app.viewer.setScale(1); app.tools.setTool('edit-text');
  const s = app.session, p = s.pages[0], v = await until(() => app.viewer.views.get(p.id));
  await until(() => v.textLoaded && !v.needsRender && !v.task); app.viewer.scroller.scrollTop = 0;
  const span = [...v.textHost.querySelectorAll('span')].find(s => s.textContent.trim()); ok(span, 'a PDF text span must be loaded');
  const r = span.getBoundingClientRect();
  // The existing UI suite verifies real hit-testing. Here target the span to isolate Escape.
  span.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, pointerType: 'mouse', pointerId: 22, clientX: r.left + 2, clientY: r.top + 2 }));
  let editor = await until(() => document.querySelector('.inline-editor.edit-line')); editor.value = 'Kept page line';
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await app.tools.settle();
  ok(p.annots.some(a => a.text === 'Kept page line') && app.tools.tool === 'hand', 'Escape discarded the page text edit');
  const note = { id: 'comment-escape', kind: 'note', rect: [30, 300, 50, 320], color: '#ffd400', width: 1, opacity: 1 };
  s.addAnnots(p, [note]); app.tools.openCommentEditor(v, note); editor = document.querySelector('.inline-editor.comment'); editor.value = 'Kept comment';
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await app.tools.settle();
  ok(p.annots.find(a => a.id === note.id).contents === 'Kept comment' && app.tools.tool === 'hand', 'Escape discarded the comment');
});

await test('Edits made while source bytes are loading stay outside the save snapshot', async () => {
  await closeAll();
  await app.openFile(new File([await (await fetch('/fixtures/normal.pdf')).blob()], 'snapshot.pdf', { type: 'application/pdf' }));
  const s = app.session, p = s.pages[0], source = [...s.sources.values()][0], started = deferred(), release = deferred();
  const getData = source.pdf.getData;
  source.pdf.getData = async () => { started.resolve(); await release.promise; return getData.call(source.pdf); };
  const dest = handle('snapshot.pdf'); s.handle = dest; s.addAnnots(p, [text('Snapshot start')]);
  try {
    const saving = app.save(); await started.promise;
    s.addAnnots(p, [text('Later during build')]); release.resolve(); ok(await saving, 'snapshot save failed');
    ok((await savedAnnots(dest.writes[0])).annots.length === 1 && s.dirty && p.annots.length === 2, 'a pre-build await changed the save snapshot or lost the newer edit');
  } finally { release.resolve(); source.pdf.getData = getData; }
});

await test('Form values, document parts and save options remain usable across background saves', async () => {
  await closeAll();
  await app.openFile(new File([await (await fetch('/fixtures/form.pdf')).blob()], 'form.pdf', { type: 'application/pdf' }));
  const s = app.session, p = s.pages[0], source = [...s.sources.values()][0];
  const originalAttachments = (await api.inspectFile(source.blob)).attachments;
  const field = (await (await source.pdf.getPage(1)).getAnnotations()).find(a => a.fieldName === 'name');
  ok(field, 'the form fixture must have its name field');
  const set = value => { source.pdf.annotationStorage.setValue(field.id, { value }); source.formsEdited = true; s.markDirty(); };
  set('Before background save');
  s.bookmarks.push({ id: 'save-bookmark', pageId: p.id, title: 'Kept bookmark' });
  s.attachments.push({ name: 'kept.txt', blob: new Blob(['Kept attachment'], { type: 'text/plain' }) });
  s.pendingOptions.metadata = { title: 'Kept metadata' };
  s.ocrWords.set(p.id, [{ x: 30, y: 50, w: 60, h: 12, text: 'KeptOCR' }]); s.markDirty();
  const started = deferred(), release = deferred();
  const dest = handle('form.pdf', { write: async (_b, n) => { if (n === 1) { started.resolve(); await release.promise; } } }); s.handle = dest;
  const saving = app.save(); await started.promise; set('After background save'); release.resolve();
  ok(await saving, 'the form save failed');
  ok((await savedAnnots(dest.writes[0])).annots.find(a => a.fieldName === 'name').fieldValue === 'Before background save' && s.dirty, 'the form snapshot or dirty state changed during writing');
  ok(s.bookmarks.length === 1 && s.attachments.length === 1 && s.ocrWords.has(p.id) && s.pendingOptions.metadata.title === 'Kept metadata', 'saving discarded working document parts');
  ok(await app.save(), 'the second form save failed');
  const saved = await api.openPdf(dest.writes[1]);
  try {
    const annots = await (await saved.pdf.getPage(1)).getAnnotations();
    ok(annots.find(a => a.fieldName === 'name').fieldValue === 'After background save', 'the later form value was lost on repeated save');
    ok((await saved.pdf.getMetadata()).info.Title === 'Kept metadata', 'metadata did not survive the repeated save');
    const report = await api.inspectFile(dest.writes[1]);
    ok(report.attachments === originalAttachments + 1, 'attachments were lost or duplicated in the saved PDF');
    ok((await saved.pdf.getOutline()).some(b => b.title === 'Kept bookmark'), 'bookmarks were lost');
  } finally { await saved.close(); }
});

await test('Repeated Save queues the latest changes without simultaneous disk writes; close waits safely', async () => {
  const s = await blank(), p = s.pages[0], started = deferred(), release = deferred(); let writing = 0, maxWriting = 0;
  const dest = handle('queued.pdf', { write: async (_blob, n) => { writing++; maxWriting = Math.max(writing, maxWriting); if (n === 1) { started.resolve(); await release.promise; } writing--; } }); s.handle = dest;
  s.addAnnots(p, [text('First')]); const first = app.save(); await started.promise;
  s.addAnnots(p, [text('Second')]); const second = app.save(), third = app.save();
  release.resolve(); ok((await Promise.all([first, second, third])).every(Boolean), 'a queued save failed');
  ok(dest.writes.length === 2 && maxWriting === 1 && !s.dirty, 'repeated saves overlapped, were not coalesced, or left a saved document dirty');
  ok((await savedAnnots(dest.writes[1])).annots.length === 2, 'the queued save did not capture the newest changes');
  const start2 = deferred(), finish2 = deferred(); dest.createWritable = async () => ({ write: async () => { start2.resolve(); await finish2.promise; }, close: async () => {}, abort: async () => {} });
  const pending = app.save(); await start2.promise;
  const other = app.newDocument(); other.addAnnots(other.pages[0], [ink('Unsaved other tab')]);
  const closing = app.closeSession(s), repeatedClose = app.closeSession(s); await wait(60);
  ok(app.sessions.includes(s), 'a tab closed and destroyed the source before its write completed');
  finish2.resolve(); await pending; await Promise.all([closing, repeatedClose]);
  ok(!app.sessions.includes(s), 'the saved tab did not close');
  ok(app.sessions.includes(other) && other.dirty && other.canUndo && app.session === other, 'repeat close removed or switched away from another unsaved tab');
});

await test('A failed background save retains edits and history and allows another save', async () => {
  const s = await blank(), p = s.pages[0]; s.addAnnots(p, [text('Keep on failure')]);
  s.handle = handle('failure.pdf', { write: async () => { throw new Error('Injected write failure'); } });
  const rescue = app.rescueSave;
  try { app.rescueSave = async () => null; ok(!await app.save(), 'the injected write failure must fail'); }
  finally { app.rescueSave = rescue; }
  ok(s.dirty && s.canUndo && p.annots.length === 1 && !document.querySelector('.overlay-bg'), 'failed saving discarded or blocked the working document');
  s.handle = handle('permission.pdf'); s.handle.queryPermission = async () => { throw new DOMException('Injected permission failure', 'NotAllowedError'); };
  const logError = console.error; let reported = false;
  console.error = (...args) => { if (args[0] === 'Saving' && args[1]?.message === 'Injected permission failure') { reported = true; return; } logError(...args); };
  try { ok(!await app.save() && s.dirty && s.canUndo && reported, 'a permission failure must resolve safely, report the error, and preserve work'); }
  finally { console.error = logError; }
  s.handle = handle('retry.pdf'); ok(await app.save(), 'saving was stuck after a failure');
});

await test('Close confirmation saves its own tab even if another document becomes active', async () => {
  const s = await blank(), p = s.pages[0], dest = handle('close-target.pdf'); s.handle = dest; s.addAnnots(p, [text('Save this closing tab')]);
  const closing = app.closeSession(s);
  await until(() => document.querySelector('.overlay-bg button') && [...document.querySelectorAll('.overlay-bg button')].some(b => b.textContent.trim() === 'Save'));
  const other = app.newDocument(); other.handle = handle('other-open.pdf'); other.addAnnots(other.pages[0], [text('Keep other tab dirty')]);
  [...document.querySelectorAll('.overlay-bg button')].find(b => b.textContent.trim() === 'Save').click();
  await closing;
  ok(!app.sessions.includes(s) && dest.writes.length === 1, 'close Save wrote the wrong document');
  ok(app.session === other && other.dirty && other.handle.writes.length === 0 && other.pages[0].annots.length === 1, 'close Save changed the other active document');
});

await test('Close confirmation keeps a document open if it changes while being saved', async () => {
  const s = await blank(), p = s.pages[0], started = deferred(), release = deferred();
  s.handle = handle('close-newer-edits.pdf', { write: async () => { started.resolve(); await release.promise; } });
  s.addAnnots(p, [text('Before closing')]); const closing = app.closeSession(s);
  await until(() => [...document.querySelectorAll('.overlay-bg button')].some(b => b.textContent.trim() === 'Save'));
  [...document.querySelectorAll('.overlay-bg button')].find(b => b.textContent.trim() === 'Save').click(); await started.promise;
  const v = app.viewer.views.get(p.id), draft = { ...text('Keep newer edits'), text: '' };
  app.tools.openEditor(v, draft, true); const editor = document.querySelector('.inline-editor'); editor.value = 'Keep newer edits';
  editor.dispatchEvent(new Event('input', { bubbles: true })); release.resolve(); await closing;
  ok(app.sessions.includes(s) && s.dirty && p.annots.some(a => a.text === 'Keep newer edits') && s.canUndo, 'closing discarded a draft typed during its save');
});

await test('Window exit commits a draft to its original document before asking about another dirty tab', async () => {
  const first = await blank(); first.name = 'first-exit.pdf'; first.addAnnots(first.pages[0], [ink('First tab edit')]);
  const second = app.newDocument(); second.name = 'second-exit.pdf'; const p = second.pages[0], a = text('Original second-tab text'); second.addAnnots(p, [a]);
  const v = await until(() => app.viewer.views.get(p.id)); app.tools.openEditor(v, a, false);
  const editor = document.querySelector('.inline-editor'); editor.value = 'Draft stays in the second tab'; editor.dispatchEvent(new Event('input', { bubbles: true }));
  const exiting = app.closeAllForExit();
  await until(() => document.querySelector('.overlay-bg')?.textContent.includes(first.name));
  [...document.querySelectorAll('.overlay-bg button')].find(b => b.textContent.includes("Don't save")).click();
  await until(() => document.querySelector('.overlay-bg')?.textContent.includes(second.name));
  ok(p.annots.find(n => n.id === a.id).text === 'Draft stays in the second tab' && second.canUndo, 'the exit flow sent the draft to the wrong document');
  [...document.querySelectorAll('.overlay-bg button')].find(b => b.textContent.trim() === 'Cancel').click();
  ok(!await exiting && app.sessions.includes(second) && second.dirty, 'cancelling exit lost the remaining document');
});

await closeAll();
export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
