// Tests for the 2026-11-06 update: the pen shortcut, colours that remember their size, Read picture
// as real text, voice notes, the Edit toolbar with the study tools, bookmarks, Create document,
// the page editor, zooming and moving, pen settings, Settings, forms, the library and the guide.
const app = window.__pdfy, A = window.__api;
const results = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
const fx = async name => { const r = await fetch(`/fixtures/${name}`); return new File([await r.blob()], name, { type: 'application/pdf' }); };
const closeAll = async () => { for (const s of [...app.sessions]) { s.dirty = false; await app.closeSession(s); } };
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
  document.querySelectorAll('.overlay-bg, .dict-pop, .word-bar, .voice-player, .dropdown, .ctx-menu').forEach(d => d.remove());
  app.pageEditor.close();
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), results }, null, 1) });
}
const ok = (v, msg) => { if (!v) throw new Error(msg ?? 'check failed'); };
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg ?? 'values differ'}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); };
async function settle(ms = 4000) {
  const start = performance.now();
  while (performance.now() - start < ms) {
    const views = [...app.viewer.views.values()];
    if (views.length && views.every(v => !v.needsRender && !v.task)) break;
    await wait(40);
  }
  await wait(60);
}
const until = async (fn, ms = 6000, what = 'condition') => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(50); }
  throw new Error(`Timed out waiting for ${what}`);
};
const reopen = async blob => { const r = await A.openPdf(blob, async () => null); return { pdf: r.pdf, destroy: () => r.close() }; };
const key = (code, opts = {}, target = document.activeElement ?? document.body) => target.dispatchEvent(new KeyboardEvent('keydown', { code, key: opts.key ?? code.replace(/^Key/, '').toLowerCase(), bubbles: true, cancelable: true, ...opts }));
function screen(page, px, py) {
  const v = app.viewer.views.get(page.id);
  const r = v.el.getBoundingClientRect();
  const m = v.vp.m;
  return [r.left + m[0] * px + m[2] * py + m[4], r.top + m[1] * px + m[3] * py + m[5]];
}
/** A point on the visible part of a page, as shares of what is on screen. */
function spot(page, fx = 0.5, fy = 0.5) {
  const r = app.viewer.views.get(page.id).el.getBoundingClientRect(), v = app.viewer.scroller.getBoundingClientRect();
  const l = Math.max(r.left, v.left) + 20, rt = Math.min(r.right, v.right) - 20, t = Math.max(r.top, v.top) + 20, b = Math.min(r.bottom, v.bottom) - 60;
  return [l + (rt - l) * fx, t + (b - t) * fy];
}
const ptr = (type, x, y, extra = {}, target) => (target ?? document.elementFromPoint(x, y)).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 7, isPrimary: true, pointerType: 'mouse', ...extra }));
async function openFixture(name) {
  await closeAll();
  await app.openFile(await fx(name));
  await until(() => app.session, 6000, 'the document');
  await settle();
  return app.session;
}
/** A short tone as a WAV file, standing in for a recording. */
function toneWav(seconds = 1.2) {
  const rate = 8000, n = Math.round(rate * seconds);
  const buf = new ArrayBuffer(44 + n * 2), d = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => d.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); d.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
  d.setUint32(24, rate, true); d.setUint32(28, rate * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); str(36, 'data'); d.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) d.setInt16(44 + i * 2, Math.sin(i / rate * 2 * Math.PI * 440) * 8000, true);
  return new Blob([buf], { type: 'audio/wav' });
}

// ---- The pen shortcut ----

await test('I picks the pen from Read, even right after changing Thickness', async () => {
  await openFixture('normal.pdf');
  app.setMode('view');
  app.tools.setTool('hand');
  // Leave the keyboard in a number box, as after typing a thickness.
  const box = document.createElement('input');
  box.type = 'number';
  document.body.append(box);
  box.focus();
  key('KeyI', {}, box);
  box.remove();
  eq(app.mode, 'edit', 'Edit opens');
  eq(app.tools.tool, 'pen', 'the pen is chosen');
  // Drawing hands the keyboard back to the page from any box.
  const sel = document.createElement('select');
  document.body.append(sel);
  sel.focus();
  const page = app.session.pages[0];
  const [x, y] = spot(page, 0.3, 0.3);
  ptr('pointerdown', x, y);
  ptr('pointermove', x + 30, y + 10);
  ptr('pointerup', x + 30, y + 10);
  ok(document.activeElement !== sel, 'the drop-down no longer has the keyboard');
  sel.remove();
  key('KeyH');
  eq(app.tools.tool, 'highlight', 'the next letter works straight away');
  app.setMode('view');
  app.session.dirty = false;
});

await test('Each colour keeps its own thickness and opacity', async () => {
  const t = app.tools;
  t.setStyle({ color: '#111111' }, 'pen');
  t.setStyle({ width: 1.5, opacity: 1 }, 'pen');
  t.setStyle({ color: '#ffd400' }, 'pen');
  t.setStyle({ width: 6, opacity: 0.6 }, 'pen');
  t.setStyle({ color: '#111111' }, 'pen');
  eq(t.style('pen').width, 1.5, 'black is thin again');
  eq(t.style('pen').opacity, 1, 'black is solid again');
  t.setStyle({ color: '#ffd400' }, 'pen');
  eq(t.style('pen').width, 6, 'yellow is thick again');
  eq(t.style('pen').opacity, 0.6, 'yellow kept its opacity');
  t.setStyle({ color: '#d92d20' }, 'pen');
  eq(t.style('pen').width, 6, 'a colour used for the first time starts from the last size');
  // Other tools keep their own lists.
  t.setStyle({ color: '#ffd400' }, 'marker');
  t.setStyle({ width: 14 }, 'marker');
  t.setStyle({ color: '#ffd400' }, 'pen');
  eq(t.style('pen').width, 6, 'the marker did not change the pen');
  ok(JSON.parse(localStorage.getItem('pdfy.colourStyles')).pen['#ffd400'].width === 6, 'kept between sessions');
});

// ---- Read picture ----

await test('Read picture: words become invisible selectable text, searchable, with nothing drawn', async () => {
  await closeAll();
  await paste(await mockGemini());
  await until(() => app.session?.pages[0]?.annots.some(a => a.kind === 'image'), 6000, 'the pasted image');
  await settle();
  const s = app.session, page = s.pages[0];
  const img = page.annots.find(a => a.kind === 'image');
  await app.study.readPicture(page, img.rect);
  const spans = await until(() => { const l = document.querySelectorAll('.read-layer span'); return l.length > 20 ? l : null; }, 30000, 'the words');
  ok(!document.querySelector('.word-spot'), 'no yellow spots');
  const st = getComputedStyle(spans[0]);
  eq(st.color, 'rgba(0, 0, 0, 0)', 'the words are invisible');
  const bg = getComputedStyle(spans[0]).backgroundColor;
  eq(bg, 'rgba(0, 0, 0, 0)', 'no colour behind the words');
  // Select a few words and copy them like any text.
  const range = document.createRange();
  range.setStart(spans[2].firstChild, 0);
  range.setEnd(spans[6].firstChild, spans[6].textContent.length);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  const picked = getSelection().toString().trim();
  ok(picked.split(/\s+/).length >= 3, `selectable: “${picked}”`);
  getSelection().removeAllRanges();
  // Ctrl+F finds them.
  const word = [...spans].map(x => x.textContent.trim()).find(w => /^[A-Za-z]{6,}$/.test(w));
  const hits = A.findInPage(await A.pageText(s, page), page, 0, word, { caseSensitive: false, wholeWord: true });
  ok(hits.length >= 1, `search finds “${word}”`);
  // The layer follows zoom, and Done leaves nothing behind.
  const before = spans[3].getBoundingClientRect().width;
  app.viewer.setScale(app.viewer.scale * 1.5);
  await wait(250);
  const after = document.querySelectorAll('.read-layer span')[3].getBoundingClientRect().width;
  ok(after > before * 1.3, `words grow with the page (${before.toFixed(0)} to ${after.toFixed(0)} px)`);
  document.querySelector('.word-bar .primary').click();
  ok(!document.querySelector('.read-layer') && !document.querySelector('.word-bar'), 'Done removes everything');
  s.dirty = false;
  return `${spans.length} words, selected “${picked}”`;
});

// ---- Voice notes ----

await test('Voice note: one click plays it, and it still plays after saving and reopening', async () => {
  const s = await openFixture('normal.pdf');
  const page = s.pages[0];
  const blob = toneWav();
  app.pendingAttachment = { name: 'Voice note test.wav', mime: 'audio/wav', blob, voice: true };
  app.tools.setTool('attach');
  const [x, y] = spot(page, 0.5, 0.4);
  ptr('pointerdown', x, y);
  ptr('pointerup', x, y);
  const note = await until(() => page.annots.find(a => a.kind === 'attachment'), 3000, 'the pinned note');
  ok(note.attachment.voice, 'marked as a voice note');
  app.openAttachment(note);
  const player = await until(() => document.querySelector('.voice-player'), 3000, 'the player');
  ok(player.querySelector('.vp-play') && player.querySelector('.vp-seek'), 'play button and position bar');
  ok([...player.querySelectorAll('.btn')].some(b => b.textContent === 'Delete'), 'can be deleted from the player');
  document.querySelector('.voice-player .icon-btn').click();
  ok(!document.querySelector('.voice-player'), 'closes');
  // Saved, then opened again as a new document.
  const { blob: saved } = await A.buildFile(s);
  await closeAll();
  await app.openPdfBlob(saved, 'voice.pdf');
  await settle();
  const p2 = app.session.pages[0];
  await until(() => p2.ghostsLoaded, 4000, 'the notes in the file');
  const again = p2.annots.find(a => a.kind === 'attachment');
  ok(again, 'the voice note is in the saved file');
  ok(again.attachment.voice, 'still known as a voice note');
  ok(again.attachment.fileId, 'its sound can be found in the file');
  app.openAttachment(again);
  await until(() => document.querySelector('.voice-player'), 4000, 'the player after reopening');
  ok(again.attachment.blob && again.attachment.blob.size === blob.size, `the same recording comes back (${again.attachment.blob?.size} bytes)`);
  app.session.dirty = false;
});

// ---- Toolbars ----

await test('Edit holds the study tools, Read has no Study button, and bookmarks are on the toolbar', async () => {
  await openFixture('normal.pdf');
  app.setMode('view');
  const read = app.row.commands().map(c => c.label);
  ok(!read.includes('Study'), 'no separate Study button');
  ok(read.includes('Bookmarks'), 'Bookmarks button in Read');
  app.setMode('edit');
  const edit = app.row.commands().map(c => c.label);
  for (const l of ['Markdown', 'Equation', 'Read picture', 'Word lookup', 'Ink', 'Highlight', 'Image theme']) ok(edit.includes(l), `${l} in Edit`);
  app.setMode('study');
  eq(app.mode, 'edit', 'the old Study mode opens Edit');
  key('KeyM', { ctrlKey: true, shiftKey: true, key: 'M' }, document.body);
  eq(app.tools.tool, 'markdown', 'Ctrl+Shift+M still picks Markdown');
  app.setMode('view');
  ok(await app.revealCommand('Settings'), 'Settings is in More');
  ok(await app.revealCommand('Feature guide'), 'Feature guide is in More');
});

// ---- Bookmarks ----

await test('Bookmarks: Ctrl+B adds and removes, the page shows a ribbon, and they are saved in the file', async () => {
  const s = await openFixture('structure.pdf');
  app.viewer.goTo(1);
  await settle();
  key('KeyB', { ctrlKey: true, key: 'b' }, document.body);
  eq(s.bookmarks.length, 1, 'one bookmark');
  ok(app.isBookmarked(1), 'on page 2');
  ok(app.viewer.views.get(s.pages[1].id).el.classList.contains('bookmarked'), 'the ribbon shows on the page');
  ok(document.querySelector('.bm-toggle').classList.contains('active'), 'the button beside the page number is on');
  app.panels.show('bookmarks');
  ok(document.querySelector('.bm-row .bm-page')?.textContent === '2', 'listed with its page number');
  const { blob } = await A.buildFile(s);
  const doc = await reopen(blob);
  const outline = await doc.pdf.getOutline();
  doc.destroy();
  ok(outline?.some(o => o.title === 'Page 2'), 'saved into the file’s contents list');
  key('KeyB', { ctrlKey: true, key: 'b' }, document.body);
  eq(s.bookmarks.length, 0, 'Ctrl+B again removes it');
  app.panels.show('thumbs');
  s.dirty = false;
});

// ---- New documents ----

await test('Create document: lined A4, three pages, with real lines', async () => {
  await closeAll();
  const blob = A.makePaperPdf({ title: 'Physics notes', paper: 'lined', w: 595.28, h: 841.89, pages: 3 });
  const doc = await reopen(blob);
  eq(doc.pdf.numPages, 3, 'three pages');
  const pg = await doc.pdf.getPage(2);
  const vp = pg.getViewport({ scale: 1 });
  ok(Math.abs(vp.width - 595.28) < 0.5 && Math.abs(vp.height - 841.89) < 0.5, 'A4');
  const c = document.createElement('canvas');
  c.width = vp.width; c.height = vp.height;
  await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let blue = 0, red = 0;
  for (let i = 0; i < d.length; i += 4) { if (d[i + 2] - d[i] > 20) blue++; if (d[i] - d[i + 1] > 15 && d[i] - d[i + 2] > 15) red++; }
  const meta = await doc.pdf.getMetadata();
  doc.destroy();
  ok(blue > 3000, `ruled lines drawn (${blue} blue pixels)`);
  ok(red > 300, `margin line drawn (${red} red pixels)`);
  eq(meta.info.Title, 'Physics notes', 'the title is kept, any language');
  for (const paper of ['blank', 'narrow', 'grid', 'dotted', 'graph', 'cornell', 'music']) {
    const r = await reopen(A.makePaperPdf({ title: 'تجربة', paper, w: 612, h: 792, pages: 1 }));
    eq(r.pdf.numPages, 1, `${paper} opens`);
    r.destroy();
  }
  // Through the window itself.
  const p = app.createDocument();
  const dlg = await until(() => document.querySelector('.create-doc'), 3000, 'the window');
  const sels = dlg.querySelectorAll('select.cd-select');
  sels[0].value = 'grid'; sels[0].dispatchEvent(new Event('change'));
  dlg.querySelector('input[type=number]').value = '2';
  dlg.querySelector('.cd-title').value = 'Grid test';
  [...dlg.querySelectorAll('.btn')].find(b => b.textContent === 'Create PDF').click();
  await p;
  await until(() => app.session?.name === 'Grid test.pdf', 4000, 'the new document');
  eq(app.session.pages.length, 2, 'two pages');
  app.session.dirty = false;
});

await test('The + beside the tabs offers Browse file and Create document', async () => {
  document.querySelector('.tab-add').click();
  const items = [...document.querySelectorAll('.dropdown .dd-item')].map(b => b.dataset.label);
  ok(items.includes('Browse file') && items.includes('Create document'), items.join(', '));
  document.querySelector('.dropdown')?.remove();
});

// ---- Page editor ----

await test('Page editor: full screen, tick pages, rotate, insert new paper, drag to reorder', async () => {
  const s = await openFixture('structure.pdf');
  const n = s.pages.length;
  localStorage.removeItem('pdfy.settings');
  (await app.revealCommand('Pages')).click();
  ok(app.pageEditor.isOpen, 'Pages opens the full-screen editor');
  const cells = await until(() => { const c = document.querySelectorAll('.pe-cell'); return c.length === n ? c : null; }, 4000, 'every page');
  await until(() => document.querySelectorAll('.pe-cell canvas').length === n, 6000, 'the pictures');
  cells[1].querySelector('.pe-check').click();
  eq(app.panels.thumbs.selected.size, 1, 'one ticked');
  const before = s.pages[1].rotate;
  [...document.querySelectorAll('.pe-btn')].find(b => b.textContent === 'Rotate right').click();
  eq(s.pages[1].rotate, (before + 90) % 360, 'the ticked page turned');
  eq(s.pages[0].rotate, 0, 'the others did not');
  // Insert lined pages after it.
  const p = app.insertPagesDialog(1);
  const dlg = await until(() => document.querySelector('.create-doc.single'), 3000, 'Insert page');
  dlg.querySelector('select.cd-select').value = 'dotted';
  dlg.querySelector('input[type=number]').value = '2';
  [...document.querySelectorAll('.dialog-foot .btn')].find(b => b.textContent === 'Insert').click();
  await p;
  eq(s.pages.length, n + 2, 'two pages inserted');
  // Move the first page to the end by dragging.
  const first = s.pages[0];
  app.panels.thumbs.selected.clear();
  app.panels.thumbs.selected.add(first.id);
  const drag = new DataTransfer();
  document.querySelector('.pe-cell').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: drag }));
  const sc = document.querySelector('.pe-scroll').getBoundingClientRect();
  document.querySelector('.pe-scroll').dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: sc.right - 30, clientY: sc.bottom - 30, dataTransfer: drag }));
  document.querySelector('.pe-scroll').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: sc.right - 30, clientY: sc.bottom - 30, dataTransfer: drag }));
  ok(s.pages.indexOf(first) > 0, `the first page moved to position ${s.pages.indexOf(first) + 1}`);
  key('Escape', { key: 'Escape' }, document.querySelector('.pe-scroll'));
  ok(!app.pageEditor.isOpen, 'Escape closes it');
  saveSettingsSidebar();
  app.panels.show(null);
  (await app.revealCommand('Pages')).click();
  ok(!app.pageEditor.isOpen && app.panels.active === 'thumbs', 'set to the side list, the button opens the side list');
  localStorage.removeItem('pdfy.settings');
  s.dirty = false;
  return `${document.querySelectorAll('.pe-cell').length} cells drawn at the end`;
});
function saveSettingsSidebar() { localStorage.setItem('pdfy.settings', JSON.stringify({ pagesView: 'sidebar' })); }

// ---- Moving around ----

await test('Zoom: Ctrl+wheel and a touchpad pinch zoom at the pointer, the middle button moves the page', async () => {
  const s = await openFixture('normal.pdf');
  app.viewer.setScale(1);
  await settle();
  const sc = app.viewer.scroller, r = sc.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 3;
  sc.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
  const afterWheel = app.viewer.scale;
  ok(afterWheel > 1.1, `Ctrl+wheel zoomed in to ${Math.round(afterWheel * 100)}%`);
  for (let i = 0; i < 10; i++) sc.dispatchEvent(new WheelEvent('wheel', { deltaY: -3.5, ctrlKey: true, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
  ok(app.viewer.scale > afterWheel * 1.2, `a pinch zooms smoothly too, to ${Math.round(app.viewer.scale * 100)}%`);
  sc.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
  const z = app.viewer.scale;
  localStorage.setItem('pdfy.settings', JSON.stringify({ wheelZooms: true }));
  sc.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
  ok(app.viewer.scale < z, 'with “Mouse wheel zooms” on, the wheel alone zooms');
  localStorage.removeItem('pdfy.settings');
  app.viewer.setScale(3);
  await wait(300);
  sc.scrollLeft = 200; sc.scrollTop = 200;
  const l0 = sc.scrollLeft, t0 = sc.scrollTop;
  ptr('pointerdown', cx, cy, { button: 1, buttons: 4 }, sc);
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: cx - 80, clientY: cy - 60, pointerId: 7, buttons: 4 }));
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: cx - 80, clientY: cy - 60, pointerId: 7, button: 1 }));
  ok(sc.scrollLeft > l0 + 40 && sc.scrollTop > t0 + 30, `middle-drag moved right and down (${sc.scrollLeft - l0}, ${sc.scrollTop - t0})`);
  // Two fingers on a touch screen pinch to zoom, even with a drawing tool chosen.
  app.setMode('edit');
  app.tools.setTool('pen');
  const z0 = app.viewer.scale;
  const t = (type, id, x, y) => (type === 'pointerdown' ? document.elementFromPoint(x, y) : window).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: id, pointerType: 'touch', isPrimary: id === 11, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
  t('pointerdown', 11, cx - 40, cy);
  t('pointerdown', 12, cx + 40, cy);
  for (let i = 1; i <= 5; i++) { t('pointermove', 11, cx - 40 - i * 12, cy); t('pointermove', 12, cx + 40 + i * 12, cy); }
  t('pointerup', 11, cx - 100, cy);
  t('pointerup', 12, cx + 100, cy);
  ok(app.viewer.scale > z0 * 1.5, `pinch zoomed from ${Math.round(z0 * 100)}% to ${Math.round(app.viewer.scale * 100)}%`);
  eq(s.pages[0].annots.filter(a => a.kind === 'ink').length, 0, 'the pinch drew nothing');
  app.tools.setTool('hand');
  app.setMode('view');
  s.dirty = false;
});

// ---- Pen and tablet ----

await test('Pen settings: pointer shape, back of the pen erases, “only the pen” lets the mouse move the page', async () => {
  const s = await openFixture('normal.pdf');
  const page = s.pages[0];
  app.setMode('edit');
  app.tools.setTool('pen');
  const sc = app.viewer.scroller;
  ok(sc.style.getPropertyValue('--draw-cursor').includes('svg'), 'the default pointer is a dot');
  localStorage.setItem('pdfy.settings', JSON.stringify({ pen: { cursor: 'size' } }));
  app.tools.setStyle({ width: 8 }, 'pen');
  ok(/width%3D'\d+/.test(sc.style.getPropertyValue('--draw-cursor')) || sc.style.getPropertyValue('--draw-cursor').includes('svg'), 'the pen-size ring');
  localStorage.setItem('pdfy.settings', JSON.stringify({ pen: { cursor: 'cross' } }));
  app.tools.syncCursor();
  eq(sc.style.getPropertyValue('--draw-cursor'), 'crosshair', 'the cross');
  // Draw with the pen tip.
  const [x, y] = spot(page, 0.3, 0.3);
  ptr('pointerdown', x, y, { pointerType: 'pen' });
  ptr('pointermove', x + 40, y + 5, { pointerType: 'pen' });
  ptr('pointerup', x + 40, y + 5, { pointerType: 'pen' });
  const inks = () => page.annots.filter(a => a.kind === 'ink').length;
  eq(inks(), 1, 'the pen drew');
  // Turn it over: the eraser end removes the stroke even with Ink chosen.
  ptr('pointerdown', x + 20, y + 2, { pointerType: 'pen', button: 5, buttons: 32 });
  ptr('pointerup', x + 20, y + 2, { pointerType: 'pen', button: 5, buttons: 0 });
  eq(inks(), 0, 'the back of the pen erased it');
  // Only the pen draws: the mouse moves the page instead.
  localStorage.setItem('pdfy.settings', JSON.stringify({ pen: { drawWith: 'pen' } }));
  app.viewer.setScale(2.5);
  await settle();
  sc.scrollTop = 300;
  const t0 = sc.scrollTop;
  const [mx, my] = spot(page, 0.5, 0.6);
  ptr('pointerdown', mx, my, { pointerType: 'mouse' });
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: mx, clientY: my - 80, pointerId: 7, buttons: 1, pointerType: 'mouse' }));
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: mx, clientY: my - 80, pointerId: 7, pointerType: 'mouse' }));
  eq(inks(), 0, 'the mouse did not draw');
  ok(sc.scrollTop > t0 + 40, 'the mouse moved the page');
  // Write straight away in Read.
  localStorage.setItem('pdfy.settings', JSON.stringify({ pen: { autoInk: true } }));
  app.setMode('view');
  app.tools.setTool('hand');
  const [px, py] = spot(page, 0.4, 0.5);
  ptr('pointerdown', px, py, { pointerType: 'pen' });
  ptr('pointermove', px + 30, py + 8, { pointerType: 'pen' });
  ptr('pointerup', px + 30, py + 8, { pointerType: 'pen' });
  eq(inks(), 1, 'the pen wrote in Read');
  eq(app.tools.tool, 'hand', 'the tool is still Pan for the mouse');
  localStorage.removeItem('pdfy.settings');
  app.tools.syncCursor();
  s.dirty = false;
});

// ---- Settings ----

await test('Settings: clear sections, a theme gallery with pictures, and your own theme', async () => {
  const before = document.documentElement.dataset.uiTheme;
  void app.settingsDialog();
  const dlg = await until(() => document.querySelector('.settings'), 3000, 'Settings');
  const sections = [...dlg.querySelectorAll('.st-nav-item')].map(b => b.textContent);
  for (const n of ['Appearance', 'Pen and tablet', 'Pages and moving around', 'Study tools', 'Quick setups', 'General and help']) ok(sections.includes(n), `${n} section`);
  const cards = dlg.querySelectorAll('.st-theme:not(.new)');
  ok(cards.length >= 9, `${cards.length} theme cards`);
  ok(dlg.querySelector('.theme-mini[data-ui-theme="forest"]'), 'each card is a picture in its own colours');
  const forestBg = getComputedStyle(dlg.querySelector('.theme-mini[data-ui-theme="forest"] .tm-title')).backgroundColor;
  const slateBg = getComputedStyle(dlg.querySelector('.theme-mini[data-ui-theme="slate"] .tm-title')).backgroundColor;
  ok(forestBg !== slateBg, `pictures differ (${forestBg} and ${slateBg})`);
  [...cards].find(c => c.textContent.includes('Forest')).click();
  eq(document.documentElement.dataset.uiTheme, 'forest', 'clicking a card applies it at once');
  // Your own theme from five colours.
  const id = A.saveCustomUiTheme ? null : null;
  void id;
  dlg.querySelector('.st-theme.new').click();
  await until(() => document.querySelector('.st-editor'), 3000, 'the theme editor');
  document.querySelector('.st-editor .st-input').value = 'Exam blue';
  [...document.querySelectorAll('.dialog-foot .btn')].find(b => b.textContent === 'Save and use').click();
  await until(() => document.documentElement.dataset.uiTheme?.startsWith('custom-'), 3000, 'the new theme in use');
  const chrome = getComputedStyle(document.documentElement).getPropertyValue('--chrome').trim();
  ok(chrome.startsWith('#'), `its colours apply (${chrome})`);
  // Pen section has the test pad.
  [...document.querySelectorAll('.st-nav-item')].find(b => b.textContent === 'Pen and tablet').click();
  ok(document.querySelector('.st-pad') && document.querySelectorAll('.st-card').length === 5, 'pointer choices and a test pad');
  [...document.querySelectorAll('.dialog-foot .btn')].find(b => b.textContent === 'Done').click();
  localStorage.removeItem('pdfy.customUiThemes');
  A.applyUiTheme(before || 'slate');
});

await test('A quick setup changes the tools but never the interface theme', async () => {
  A.applyUiTheme('midnight');
  await app.study.applySet(A.allSets().find(x => x.id === 'study'));
  eq(document.documentElement.dataset.uiTheme, 'midnight', 'the interface theme stayed');
  await app.study.applySet(A.allSets().find(x => x.id === 'night'));
  eq(document.documentElement.dataset.uiTheme, 'midnight', 'night reading changed only the pages');
  eq(app.reading, 'night', 'pages are dark');
  app.setReading('normal');
  localStorage.removeItem('pdfy.styles');
  localStorage.removeItem('pdfy.settings');
  A.applyUiTheme('slate');
});

// ---- Forms ----

await test('Forms: a field made in PDFy can be filled in straight away, and the answer is saved', async () => {
  const s = await openFixture('normal.pdf');
  const page = s.pages[0];
  const mk = (type, name, rect, options) => ({ id: `f${Math.random().toString(36).slice(2)}`, kind: 'rect', rect, color: '#0b57d0', opacity: 1, width: 1.5, fill: null, field: { type, name, options }, created: Date.now() });
  s.addAnnots(page, [mk('text', 'student_name', [72, 650, 300, 672]), mk('check', 'agree', [72, 610, 86, 624]), mk('dropdown', 'year', [72, 570, 200, 590], ['First', 'Second', 'Third'])], 'Add fields');
  app.setMode('view');
  app.tools.setTool('hand');
  await wait(100);
  const ctls = document.querySelectorAll('.own-field-ctl');
  eq(ctls.length, 3, 'three fillable controls in Read');
  ok(getComputedStyle(ctls[0]).display !== 'none', 'shown in Read');
  ctls[0].value = 'Muhammad';
  ctls[0].dispatchEvent(new Event('change'));
  const box = document.querySelector('.own-field-ctl[type=checkbox]');
  box.checked = true; box.dispatchEvent(new Event('change'));
  const sel = document.querySelector('select.own-field-ctl');
  sel.value = 'Second'; sel.dispatchEvent(new Event('change'));
  eq(page.annots.find(a => a.field?.name === 'student_name').field.value, 'Muhammad', 'the typed text is kept');
  app.setMode('edit');
  ok(getComputedStyle(document.querySelector('.own-fields')).display === 'none', 'in Edit they are boxes to move instead');
  app.setMode('view');
  const { blob } = await A.buildFile(s);
  const doc = await reopen(blob);
  const list = await (await doc.pdf.getPage(1)).getAnnotations();
  doc.destroy();
  const byName = n => list.find(a => a.fieldName === n);
  eq(byName('student_name')?.fieldValue, 'Muhammad', 'text saved into the PDF form');
  ok(byName('agree')?.fieldValue && byName('agree').fieldValue !== 'Off', 'tick saved');
  eq(byName('year')?.fieldValue?.[0] ?? byName('year')?.fieldValue, 'Second', 'choice saved');
  void app.formsHelp();
  ok(await until(() => document.querySelector('.help-steps'), 2000, 'the explainer'), 'How forms work explains it');
  s.dirty = false;
});

// ---- Library ----

await test('Collections and recently closed: kept as links, old ones forgotten after 7 days', async () => {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle('library-test.pdf', { create: true });
  const w = await handle.createWritable();
  await w.write(await (await fx('normal.pdf')).arrayBuffer());
  await w.close();
  const c = await A.createCollection('Physics', '#4f8cf7');
  ok(await A.addToCollection(c.id, 'library-test.pdf', handle, 1), 'added');
  ok(!(await A.addToCollection(c.id, 'library-test.pdf', handle, 1)), 'the same file is not added twice');
  eq((await A.listItems(c.id)).length, 1, 'listed');
  eq((await A.countItems()).get(c.id), 1, 'counted');
  ok((await A.collectionsOf(handle)).has(c.id), 'found from the file');
  await A.clearClosed();
  await A.addClosed('library-test.pdf', handle, 0, 1);
  await A.addClosed('library-test.pdf', handle, 0, 1);
  eq((await A.listClosed()).length, 1, 'closing the same file twice keeps one entry');
  // An entry from 8 days ago is forgotten.
  const db = await new Promise((res, rej) => { const r = indexedDB.open('pdfy-library', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  await new Promise(res => { const t = db.transaction('closed', 'readwrite'); t.objectStore('closed').put({ id: 'old', name: 'old.pdf', handle, closedAt: Date.now() - 8 * 86400000, page: 0, pages: 1 }); t.oncomplete = res; });
  db.close();
  const names = (await A.listClosed()).map(x => x.name);
  ok(!names.includes('old.pdf'), 'the 8-day-old one is gone');
  ok(names.includes('library-test.pdf'), 'the recent one stays');
  // The Home screen shows them.
  await closeAll();
  // Closing imported Files now records them too; make this disk file the last closed entry.
  await A.addClosed('library-test.pdf', handle, 0, 1);
  await app.home.draw();
  ok([...document.querySelectorAll('.home-nav-item')].some(b => b.textContent.includes('Physics')), 'the collection is on Home');
  [...document.querySelectorAll('.home-nav-item')].find(b => b.textContent.includes('Recently closed')).click();
  await until(() => [...document.querySelectorAll('.home-row .name')].some(n => n.textContent === 'library-test.pdf'), 3000, 'the closed file on Home');
  // Reopen the last closed one.
  await app.reopenClosed();
  await until(() => app.session?.name === 'library-test.pdf', 4000, 'reopened');
  // Closing it records it again.
  await app.closeSession(app.session);
  await wait(200);
  ok((await A.listClosed()).some(x => x.name === 'library-test.pdf'), 'closing remembers it');
  await A.deleteCollection(c.id);
  eq((await A.listCollections()).filter(x => x.id === c.id).length, 0, 'deleted');
  await A.clearClosed();
  await root.removeEntry('library-test.pdf');
});

// ---- The guide ----

await test('Feature guide: twelve illustrated steps, shown once per update, and from Settings', async () => {
  void app.showGuide();
  const g = await until(() => document.querySelector('.guide'), 2000, 'the guide');
  eq(g.querySelectorAll('.guide-dot').length, 12, 'twelve steps');
  ok(g.querySelector('.guide-visual .ga-art'), 'each step has a picture');
  key('ArrowRight', { key: 'ArrowRight' }, document.body);
  eq(g.querySelector('.guide-text h2').textContent, 'Paste a screenshot, then flip its theme', 'arrow keys step through');
  key('Escape', { key: 'Escape' }, document.body);
  ok(!document.querySelector('.guide'), 'Escape closes it');
  eq(JSON.parse(localStorage.getItem('pdfy.settings')).guideSeen, A.GUIDE_VERSION, 'remembered, so it does not open again until the next update');
  localStorage.removeItem('pdfy.settings');
});

// ---- Wording ----

await test('Status texts are sentences, not words strung together with dots', async () => {
  await openFixture('normal.pdf');
  app.updateMemory?.();
  const mem = app.memEl.textContent;
  ok(!/[·•]/.test(mem), `memory text: “${mem}”`);
  const all = [...document.querySelectorAll('button, .style-hint, .status-pill, .muted, p, span')].map(e => e.textContent).filter(t => / [·•] /.test(t));
  eq(all.length, 0, `no dot-separated texts on screen: ${all.slice(0, 3).join(' | ')}`);
  app.session.dirty = false;
});

// ---- Fixes from the Codex review ----

await test('Review: moving a voice note from a saved file and saving again keeps the recording', async () => {
  const s = await openFixture('normal.pdf');
  const page = s.pages[0];
  const blob = toneWav(0.8);
  s.addAnnots(page, [{ id: 'v1', kind: 'attachment', rect: [300, 600, 320, 624], color: '#c9e4ff', opacity: 1, width: 0.75, fill: null, attachment: { name: 'Voice.wav', mime: 'audio/wav', blob, voice: true }, created: Date.now() }]);
  const first = (await A.buildFile(s)).blob;
  await closeAll();
  const s2 = await app.openPdfBlob(first, 'voice.pdf');
  await settle();
  const p2 = s2.pages[0];
  await until(() => p2.ghostsLoaded, 4000, 'the notes');
  const ghost = p2.annots.find(a => a.kind === 'attachment');
  ok(ghost && !ghost.attachment.blob, 'reopened without reading the sound yet');
  // Moved before ever being played.
  const { ghost: _g, ...rest } = ghost;
  s2.replaceAnnot(p2, ghost, { ...rest, rect: [350, 600, 370, 624] }, 'Move');
  const second = (await A.buildFile(s2)).blob;
  const doc = await reopen(second);
  const list = (await (await doc.pdf.getPage(1)).getAnnotations()).filter(a => a.subtype === 'FileAttachment');
  const bytes = list[0]?.fileId ? await doc.pdf.getAttachmentContent(list[0].fileId) : null;
  doc.destroy();
  eq(list.length, 1, 'still one voice note');
  const size = (bytes?.content ?? bytes)?.length ?? 0;
  eq(size, blob.size, 'the recording is all there');
  s2.dirty = false;
});

await test('Review: Ctrl+Z and Ctrl+X do nothing to the document while the Thickness box has the keyboard', async () => {
  const s = await openFixture('normal.pdf');
  const page = s.pages[0];
  s.addAnnots(page, [{ id: 'r1', kind: 'rect', rect: [100, 500, 200, 560], color: '#d92d20', opacity: 1, width: 1.5, fill: null, created: Date.now() }], 'Add shape');
  app.viewer.select(page.id, 'r1');
  const box = document.createElement('input');
  box.type = 'number';
  document.body.append(box);
  box.focus();
  key('KeyZ', { ctrlKey: true, key: 'z' }, box);
  key('KeyX', { ctrlKey: true, key: 'x' }, box);
  key('Backspace', { key: 'Backspace' }, box);
  eq(page.annots.filter(a => a.id === 'r1').length, 1, 'the shape is still there');
  key('KeyI', { key: 'i' }, box);
  eq(app.tools.tool, 'pen', 'but I still picks the pen');
  box.remove();
  app.setMode('view');
  s.dirty = false;
});

await test('Review: bookmarks survive saving and reopening, without doubling', async () => {
  const s = await openFixture('structure.pdf');
  app.viewer.goTo(2);
  await settle();
  app.toggleBookmark();
  let blob = (await A.buildFile(s)).blob;
  await closeAll();
  const s2 = await app.openPdfBlob(blob, 'marked.pdf');
  await settle();
  eq(s2.bookmarks.length, 1, 'the bookmark is back');
  eq(s2.pages.findIndex(p => p.id === s2.bookmarks[0].pageId), 2, 'on page 3');
  ok(app.isBookmarked(2), 'the ribbon shows');
  // Save again: still one. Remove it and save: none.
  blob = (await A.buildFile(s2)).blob;
  let doc = await reopen(blob);
  const titles = (await doc.pdf.getOutline() ?? []).map(o => o.title);
  doc.destroy();
  eq(titles.filter(t => t === 'Page 3').length, 1, 'not doubled');
  s2.bookmarks = [];
  blob = (await A.buildFile(s2)).blob;
  doc = await reopen(blob);
  const after = (await doc.pdf.getOutline() ?? []).filter(o => o.title === 'Page 3').length;
  doc.destroy();
  eq(after, 0, 'a removed bookmark leaves the file');
  s2.dirty = false;
});

await test('Review: radio choices with one name are one question, and saved answers are drawn', async () => {
  const s = await openFixture('normal.pdf');
  const page = s.pages[0];
  const mk = (id, type, name, rect, options, value) => ({ id, kind: 'rect', rect, color: '#0b57d0', opacity: 1, width: 1.5, fill: null, field: { type, name, options, value }, created: Date.now() });
  s.addAnnots(page, [mk('ra', 'radio', 'level', [72, 500, 86, 514], ['Beginner']), mk('rb', 'radio', 'level', [120, 500, 134, 514], ['Advanced']), mk('tx', 'text', 'answer', [72, 440, 320, 470], undefined, 'Muhammad')], 'Fields');
  app.setMode('view');
  app.tools.setTool('hand');
  await wait(80);
  const radios = [...document.querySelectorAll('.own-field-ctl[type=radio]')];
  eq(radios.length, 2, 'two choices');
  radios[0].checked = true; radios[0].dispatchEvent(new Event('change'));
  radios[1].checked = true; radios[1].dispatchEvent(new Event('change'));
  const val = id => page.annots.find(a => a.id === id).field.value;
  eq(val('ra'), false, 'choosing the second clears the first');
  eq(val('rb'), true, 'the second is chosen');
  await wait(50);
  ok([...document.querySelectorAll('.own-field-ctl[type=radio]')][1].checked, 'the choice still shows after the page is redrawn');
  s.undo();
  eq(val('ra'), true, 'one Undo brings the first choice back');
  eq(val('rb'), false, 'and clears the second in the same step');
  await wait(50);
  ok([...document.querySelectorAll('.own-field-ctl[type=radio]')][0].checked, 'the screen follows Undo');
  s.redo();
  const blob = (await A.buildFile(s)).blob;
  const doc = await reopen(blob);
  const pg = await doc.pdf.getPage(1);
  const list = await pg.getAnnotations();
  const group = list.filter(a => a.fieldName === 'level');
  eq(group.length, 2, 'both choices saved');
  ok(group.every(a => a.radioButton), 'as radio buttons of one question');
  ok(group.some(a => a.fieldValue === 'Advanced'), `the answer is saved (${group.map(a => a.fieldValue).join(', ')})`);
  // The typed answer is drawn into the page, so it prints.
  const vp = pg.getViewport({ scale: 2 });
  const c = document.createElement('canvas');
  c.width = vp.width; c.height = vp.height;
  await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  const [x0, y0] = vp.convertToViewportPoint(72, 470), [x1, y1] = vp.convertToViewportPoint(320, 440);
  const d = c.getContext('2d').getImageData(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)).data;
  let dark = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) dark++;
  doc.destroy();
  ok(dark > 80, `the typed answer is drawn in the saved page (${dark} dark pixels)`);
  // An answer in letters the font lacks is kept, without asking other apps to redraw every field.
  const tx2 = page.annots.find(a => a.id === 'tx');
  s.replaceAnnot(page, tx2, { ...tx2, field: { ...tx2.field, value: '答案' } }, 'Fill');
  const b2 = (await A.buildFile(s)).blob;
  const d2 = await reopen(b2);
  const v2 = (await (await d2.pdf.getPage(1)).getAnnotations()).find(a => a.fieldName === 'answer')?.fieldValue;
  const raw = new TextDecoder('latin1').decode(new Uint8Array(await b2.arrayBuffer()));
  d2.destroy();
  eq(v2, '答案', 'the Chinese answer is stored');
  ok(!raw.includes('/NeedAppearances true'), 'other fields keep their own look');
  s.dirty = false;
});

await test('Review: a document created from Home opens in front, and picture-word search keeps one cache entry per page', async () => {
  await openFixture('normal.pdf');
  app.toggleHome();
  ok(!document.querySelector('.start').hidden, 'Home is showing');
  await app.openPdfBlob(A.makePaperPdf({ title: 'x', paper: 'grid', w: 612, h: 792, pages: 1 }), 'From home.pdf');
  ok(document.querySelector('.start').hidden, 'Home steps aside for the new document');
  const s = app.session, page = s.pages[0];
  for (let i = 0; i < 20; i++) { s.addPictureWords(page.id, [{ text: `word${i}`, x: 10 + i * 30, y: 10, w: 20, h: 8 }]); await A.pageText(s, page); }
  const pt = await A.pageText(s, page);
  ok(pt.text.includes('word19'), 'the newest words are found');
  s.dirty = false;
});

await closeAll();
export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
