// Regressions for tools, line ends, Pan, word lookup, page grids, search, the View menu, zoom and Read aloud.
// Pointer input goes through the browser itself (window.__cdp), so hit-testing is real.
const app = window.__pdfy;
const results = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const ok = (value, message) => { if (!value) throw new Error(message); };
const until = async (fn, ms = 6000, what = 'condition') => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(40); }
  throw new Error(`Timed out waiting for ${what}`);
};
const closeAll = async () => {
  app.tools.cancel();
  for (const s of [...app.sessions]) { s.dirty = false; await app.closeSession(s); }
};
async function open(name = 'normal.pdf') {
  await closeAll();
  const r = await fetch(`/fixtures/${name}`);
  await app.openFile(new File([await r.blob()], name, { type: 'application/pdf' }));
  await settle();
  return app.session;
}
async function settle() {
  for (let i = 0; i < 150; i++) {
    const views = [...app.viewer.views.values()];
    if (views.length && views.every(v => !v.needsRender && !v.task)) break;
    await wait(40);
  }
  await wait(80);
}
const key = (k, extra = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k === ' ' ? 'Space' : k, bubbles: true, cancelable: true, ...extra }));
const mouse = (type, x, y, extra = {}) => window.__cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
async function drag(x0, y0, x1, y1, modifiers = 0) {
  await mouse('mouseMoved', x0, y0, { button: 'none', buttons: 0, modifiers });
  await mouse('mousePressed', x0, y0, { modifiers });
  for (let i = 1; i <= 6; i++) await mouse('mouseMoved', x0 + (x1 - x0) * i / 6, y0 + (y1 - y0) * i / 6, { modifiers });
  await mouse('mouseReleased', x1, y1, { modifiers });
  await wait(30);
}
async function click(x, y, modifiers = 0) { await mouse('mousePressed', x, y, { modifiers }); await mouse('mouseReleased', x, y, { modifiers }); await wait(30); }
async function dblclick(x, y) {
  await mouse('mouseMoved', x, y, { button: 'none', buttons: 0 });
  await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y);
  await mouse('mousePressed', x, y, { clickCount: 2 }); await mouse('mouseReleased', x, y, { clickCount: 2 });
  await wait(60);
}
/** Page units to window pixels on a mounted page. */
function screen(page, px, py) {
  const v = app.viewer.views.get(page.id);
  const r = v.el.getBoundingClientRect(), m = v.vp.m;
  return [r.left + m[0] * px + m[2] * py + m[4], r.top + m[1] * px + m[3] * py + m[5]];
}
const annot = (kind, extra) => ({ id: `t-${Math.random().toString(36).slice(2)}`, kind, color: '#d92d20', opacity: 1, width: 2, fill: null, created: Date.now(), ...extra });
const activeTools = () => [...document.querySelectorAll('.tb-row .tb-btn')].filter(b => !b.hidden && b.classList.contains('active'));
const btn = label => [...document.querySelectorAll('.tb-row .tb-btn')].find(b => b.dataset.label === label && !b.hidden);
/** A word of the page's own text, with the middle of it on screen. */
function findWord(page) {
  const v = app.viewer.views.get(page.id);
  for (const span of v.textHost.querySelectorAll('span')) {
    const m = /\b[A-Za-z]{5,}\b/.exec(span.textContent ?? '');
    if (!m || span.children.length) continue;
    const range = document.createRange();
    range.setStart(span.firstChild, m.index);
    range.setEnd(span.firstChild, m.index + m[0].length);
    const r = range.getBoundingClientRect();
    const sc = app.viewer.scroller.getBoundingClientRect();
    if (r.width < 8 || r.top < sc.top + 40 || r.bottom > sc.bottom - 80 || r.left < sc.left || r.right > sc.right) continue;
    return { word: m[0], x: r.left + r.width / 2, y: r.top + r.height / 2, rect: r };
  }
  return null;
}
/** Closes menus and pop-ups as a click outside does, so none leaves its key handler behind. */
function closePopups() { if (document.querySelector('.dropdown, .dict-pop')) document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); }
async function test(name, run) {
  console.log('TEST', name);
  const t0 = performance.now();
  try { const note = await run(); results.push({ name, ok: true, ms: Math.round(performance.now() - t0), note }); }
  catch (error) { results.push({ name, ok: false, error: String(error.message ?? error) }); }
  finally {
    app.tools.cancel();
    closePopups();
    document.querySelectorAll('.dropdown, .dict-pop, .toast').forEach(d => d.remove());
  }
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), results }) });
}

await test('Pan is the tool a fresh window starts with', async () => {
  ok(app.tools.tool === 'hand', `started with ${app.tools.tool}`);
});

await test('Exactly one tool looks chosen, through tools, flyouts, Word lookup, Escape and modes', async () => {
  await open();
  app.setMode('edit');
  const one = (why, label) => {
    const on = activeTools();
    ok(on.length === 1, `${why}: ${on.length} chosen (${on.map(b => b.dataset.label).join(', ')})`);
    if (label) ok(on[0].dataset.label === label, `${why}: ${on[0].dataset.label} looked chosen instead of ${label}`);
    ok(on[0].getAttribute('aria-pressed') === 'true', `${why}: chosen button not announced as pressed`);
    const pressed = [...document.querySelectorAll('.tb-row .tb-btn[aria-pressed=true]')].filter(b => !b.hidden);
    ok(pressed.length === 1, `${why}: ${pressed.length} buttons announced as pressed`);
  };
  // Commands that do not fit the toolbar are under More, which then shows as the chosen one.
  const pick = async label => { const b = await app.revealCommand(label); ok(b, `${label} not found`); b.click(); await wait(0); return b.classList.contains('dd-item') ? 'More' : label; };
  one('Edit opens', 'Pan');
  ok(!app.row.commands().some(c => c.label === 'Select text'), 'Pan must be the only reading/selection tool');
  for (const label of ['Highlight', 'Line', 'Pan', 'Ink', 'Lasso', 'Edit text']) one(`after ${label}`, await pick(label));
  const shown = await pick('Distance');
  one('Distance from the Measure flyout', shown === 'More' ? 'More' : 'Measure');
  if (btn('Measure')) {
    btn('Measure').click();
    const checked = [...document.querySelectorAll('.dropdown .dd-item[aria-checked=true]')].map(b => b.dataset.label);
    ok(checked.length === 1 && checked[0] === 'Distance', `flyout marks ${checked.join(', ') || 'nothing'}`);
    closePopups();
  }
  await pick('Word lookup');
  const look = btn('Word lookup');
  ok(look.getAttribute('role') === 'switch' && look.getAttribute('aria-checked') === 'true', 'Word lookup is announced as an on/off switch');
  ok(!look.classList.contains('active'), 'Word lookup must not look like a chosen tool');
  one('Word lookup on', 'Pan');
  app.study.toggleLookup(false);
  await pick('Highlight');
  key('Escape');
  one('Escape', 'Pan');
  await pick('Square');
  app.setMode('view');
  ok(app.tools.tool === 'hand', 'Read mode returns to Pan');
  const viewOn = activeTools().filter(b => b.dataset.label === 'Pan');
  ok(viewOn.length === 1 && viewOn[0].dataset.label === 'Pan', 'Read shows Pan as the one tool');
  key(' ');
  ok(app.tools.tool === 'hand', 'Space holds Pan');
  window.dispatchEvent(new Event('blur'));
  app.setMode('edit');
  await pick('Highlight');
  key(' ');
  window.dispatchEvent(new Event('blur'));
  ok(app.tools.tool === 'highlight' && !app.viewer.scroller.classList.contains('pan-held'), 'losing focus releases temporary Pan and restores the tool');
  key('Escape');
});

await test('A selected line has two end handles; each end moves alone, may cross, and undoes', async () => {
  const s = await open();
  app.setMode('view'); app.tools.setTool('hand');
  const page = s.pages[app.viewer.current];
  const line = annot('arrow', { pts: [150, 600, 350, 500], rect: [150, 500, 350, 600] });
  s.addAnnots(page, [line], 'Add line');
  await wait(50);
  const [ax, ay] = screen(page, 250, 550);
  await click(ax, ay);
  ok(app.viewer.selection?.annotId === line.id, 'clicking the arrow in Pan selects it');
  const handles = [...document.querySelectorAll('.selection .sel-handle')];
  ok(handles.length === 2 && handles.every(hd => hd.hasAttribute('data-end')), `${handles.length} handles shown`);
  const [x0, y0] = screen(page, 150, 600), [x1, y1] = screen(page, 350, 500);
  const h0 = handles[0].getBoundingClientRect(), h1 = handles[1].getBoundingClientRect();
  ok(Math.hypot(h0.left + h0.width / 2 - x0, h0.top + h0.height / 2 - y0) < 2, 'first handle sits on the first end');
  ok(Math.hypot(h1.left + h1.width / 2 - x1, h1.top + h1.height / 2 - y1) < 2, 'second handle sits on the second end');
  // Drag the first end past the second, so the line reverses.
  const [tx, ty] = screen(page, 450, 450);
  await drag(x0, y0, tx, ty);
  const moved = page.annots.find(a => a.id === line.id);
  ok(Math.abs(moved.pts[2] - 350) < 0.01 && Math.abs(moved.pts[3] - 500) < 0.01, `the other end moved: ${moved.pts.slice(2)}`);
  ok(Math.abs(moved.pts[0] - 450) < 1.5 && Math.abs(moved.pts[1] - 450) < 1.5, `the dragged end landed at ${moved.pts.slice(0, 2).map(Math.round)}`);
  ok(moved.rect[0] <= 350.01 && moved.rect[2] >= 448.5, `the bounds follow the crossed line: ${moved.rect.map(Math.round)}`);
  s.undo();
  const back = page.annots.find(a => a.id === line.id);
  ok(back.pts.join() === line.pts.join(), 'Undo puts the end back');
  // Distance measurements update their length too.
  s.removeAnnot(page, back);
  const dist = annot('measure', { measureType: 'distance', measureScale: 1 / 72, measureUnit: 'in', pts: [100, 650, 172, 650], rect: [100, 650, 172, 650] });
  dist.contents = '1.00 in';
  s.addAnnots(page, [dist], 'Measure');
  app.viewer.select(page.id, dist.id); app.onSelection();
  const [ex, ey] = screen(page, 172, 650), [fx, fy] = screen(page, 244, 650);
  await drag(ex, ey, fx, fy);
  const longer = page.annots.find(a => a.id === dist.id);
  ok(longer.contents === '2.00 in', `distance now says ${longer.contents}`);
  return `line ends ${moved.pts.map(Math.round).join(', ')}`;
});

await test('On a turned page, line handles sit on the ends and each end moves alone', async () => {
  const s = await open();
  app.setMode('view'); app.tools.setTool('hand');
  app.panels.thumbs.selected.clear();
  app.panels.thumbs.selected.add(s.pages[0].id);
  await app.rotatePages(90);
  app.panels.thumbs.selected.clear();
  app.viewer.setFit('page');
  await settle();
  const page = s.pages[0];
  ok(page.rotate % 360 === 90, `page turned to ${page.rotate}`);
  const line = annot('line', { pts: [150, 300, 400, 550], rect: [150, 300, 400, 550] });
  s.addAnnots(page, [line], 'Add line');
  app.viewer.select(page.id, line.id); app.onSelection();
  await wait(30);
  const handles = [...document.querySelectorAll('.selection .sel-handle')];
  ok(handles.length === 2, `${handles.length} handles on the turned page`);
  const centre = el => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  const e0 = screen(page, 150, 300), e1 = screen(page, 400, 550);
  ok(Math.hypot(centre(handles[0])[0] - e0[0], centre(handles[0])[1] - e0[1]) < 2, 'first handle on the first end');
  ok(Math.hypot(centre(handles[1])[0] - e1[0], centre(handles[1])[1] - e1[1]) < 2, 'second handle on the second end');
  // Screen right is not page right on a turned page, so the end must follow the mouse, not the page axes.
  await drag(e1[0], e1[1], e1[0] + 40, e1[1] - 25);
  const moved = page.annots.find(a => a.id === line.id);
  ok(Math.abs(moved.pts[0] - 150) < 0.01 && Math.abs(moved.pts[1] - 300) < 0.01, `the other end moved: ${moved.pts.slice(0, 2)}`);
  const now = screen(page, moved.pts[2], moved.pts[3]);
  ok(Math.hypot(now[0] - (e1[0] + 40), now[1] - (e1[1] - 25)) < 2, `the dragged end is ${Math.round(now[0] - e1[0])}, ${Math.round(now[1] - e1[1])} px away, not 40, -25`);
  const h1 = document.querySelectorAll('.selection .sel-handle')[1];
  ok(Math.hypot(centre(h1)[0] - now[0], centre(h1)[1] - now[1]) < 2, 'the handle follows the end');
  s.undo();
  ok(page.annots.find(a => a.id === line.id).pts.join() === line.pts.join(), 'Undo restores the turned line');
  s.dirty = false;
});

await test('Boxes still resize by their eight handles and move by dragging', async () => {
  const s = await open();
  app.setMode('view'); app.tools.setTool('hand');
  const page = s.pages[app.viewer.current];
  const box = annot('rect', { rect: [200, 620, 300, 700] });
  s.addAnnots(page, [box], 'Add shape');
  const [cx, cy] = screen(page, 250, 660);
  await click(cx, cy);
  ok(document.querySelectorAll('.selection .sel-handle').length === 8, 'eight handles on a box');
  const corner = [...document.querySelectorAll('.selection .sel-handle')].find(hd => hd.getAttribute('data-fx') === '1' && hd.getAttribute('data-fy') === '1').getBoundingClientRect();
  await drag(corner.left + 4, corner.top + 4, corner.left + 44, corner.top + 34);
  const grown = page.annots.find(a => a.id === box.id);
  ok(grown.rect[2] - grown.rect[0] > 110, `box resized to ${Math.round(grown.rect[2] - grown.rect[0])}`);
  const [mx, my] = screen(page, (grown.rect[0] + grown.rect[2]) / 2, (grown.rect[1] + grown.rect[3]) / 2);
  await drag(mx, my, mx + 30, my);
  const after = page.annots.find(a => a.id === box.id);
  ok(after.rect[0] > grown.rect[0] + 10, 'dragging the box in Pan moves it');
});

await test('Pan selects text by default, Space pans over text, and Ctrl selects objects', async () => {
  const s = await open();
  app.setMode('view'); app.tools.setTool('hand');
  app.viewer.setScale(3);
  await settle();
  const page = s.pages[app.viewer.current];
  const w = findWord(page);
  ok(w, 'a word on screen');
  const sc = app.viewer.scroller;
  const top = sc.scrollTop, left = sc.scrollLeft;
  getSelection().removeAllRanges();
  await drag(w.rect.left + 1, w.y, w.rect.right - 1, w.y);
  ok(getSelection().toString().trim().length >= 3, 'Pan did not select the text');
  ok(sc.scrollTop === top && sc.scrollLeft === left, 'selecting text panned the document');
  getSelection().removeAllRanges();
  key(' ');
  await drag(w.x, w.y, w.x - 60, w.y - 80);
  document.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }));
  ok(sc.scrollTop - top > 60 && sc.scrollLeft - left > 40, `the page moved ${sc.scrollLeft - left}, ${sc.scrollTop - top}`);
  ok(!getSelection().toString(), 'Space+drag selected text instead of panning');
  // Three boxes: Ctrl+drag around two, then Ctrl+click the third.
  const a = annot('rect', { rect: [100, 650, 140, 690] }), b = annot('rect', { rect: [160, 650, 200, 690] }), c = annot('rect', { rect: [260, 650, 300, 690] });
  s.addAnnots(page, [a, b, c], 'Add shapes');
  app.viewer.goTo(app.viewer.current);
  await settle();
  const [ax, ay] = screen(page, 90, 700), [bx, by] = screen(page, 210, 640);
  await drag(ax, ay, bx, by, 2);
  const chosen = () => app.viewer.selectedAnnots()?.annots.map(x => x.id) ?? [];
  ok(chosen().length === 2 && chosen().includes(a.id) && chosen().includes(b.id), `Ctrl+drag chose ${chosen().length}`);
  const [cx, cy] = screen(page, 280, 670);
  await click(cx, cy, 2);
  ok(chosen().length === 3, `Ctrl+click added the third: ${chosen().length}`);
  // Text selection remains available immediately after choosing objects, with no tool switch.
  const w2 = findWord(page);
  await drag(w2.rect.left + 1, w2.y, w2.rect.right - 1, w2.y);
  ok(getSelection().toString().trim().length >= 3, `Pan selected “${getSelection().toString()}”`);
  getSelection().removeAllRanges();
});

await test('Pan looks up selected page text, including words under a highlight', async () => {
  const s = await open();
  app.setMode('edit');
  app.viewer.setScale(1.6);
  await settle();
  app.tools.setTool('highlight');
  app.study.toggleLookup(true);
  ok(app.tools.tool === 'hand', 'Pan after turning lookup on with Highlight in hand');
  const page = s.pages[app.viewer.current];
  const w = findWord(page);
  getSelection().removeAllRanges();
  await dblclick(w.x, w.y);
  const pop = await until(() => document.querySelector('.dict-pop .dict-word'), 6000, 'the pop-up in Pan');
  ok(pop.textContent.toLowerCase().includes(w.word.toLowerCase().slice(0, 4)), `looked up “${pop.textContent}” for “${w.word}”`);
  ok(getSelection().toString().trim(), 'Pan should select the word natively');
  document.querySelector('.dict-pop')?.remove();
  // A highlight must let the word underneath remain selectable with Pan.
  app.tools.setTool('hand');
  const v = app.viewer.views.get(page.id), r = v.el.getBoundingClientRect(), m = v.vp.m, det = m[0] * m[3] - m[1] * m[2];
  const toPdf = (x, y) => { const dx = x - r.left - m[4], dy = y - r.top - m[5]; return [(m[3] * dx - m[2] * dy) / det, (m[0] * dy - m[1] * dx) / det]; };
  const p0 = toPdf(w.rect.left, w.rect.bottom), p1 = toPdf(w.rect.right, w.rect.top);
  const quad = [p0[0], p1[1], p1[0], p1[1], p0[0], p0[1], p1[0], p0[1]];
  s.addAnnots(page, [annot('highlight', { color: '#ffd400', opacity: 0.5, quads: [quad], rect: [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1])] })], 'Mark text');
  await wait(50);
  await dblclick(w.x, w.y);
  await until(() => document.querySelector('.dict-pop .dict-word'), 6000, 'the pop-up over a highlight');
  ok(!app.viewer.selection, 'the highlight was not picked instead of the word');
  app.study.toggleLookup(false);
  getSelection().removeAllRanges();
  return w.word;
});

await test('Page editor and side list keep picture, number and tick box together for wide pages', async () => {
  const s = await open();
  for (const p of s.pages) app.panels.thumbs.selected.add(p.id);
  await app.rotatePages(90);
  app.panels.thumbs.selected.clear();
  app.pageEditor.open();
  // Before any picture is drawn, every slot already has its page's shape and a visible fill.
  const slots = [...document.querySelectorAll('.pe-cell .pe-holder')];
  ok(slots.length >= 6, `${slots.length} slots`);
  for (const slot of slots) {
    const r = slot.getBoundingClientRect();
    ok(r.width > r.height * 1.2 && r.height > 40, `a waiting slot is ${Math.round(r.width)}×${Math.round(r.height)}`);
    if (!slot.querySelector('canvas')) ok(getComputedStyle(slot).backgroundColor !== 'rgba(0, 0, 0, 0)', 'a waiting slot has no fill');
  }
  await window.__shot('tool-review-page-editor-pending');
  const visibleDrawn = () => [...document.querySelectorAll('.pe-cell')].filter(c => { const r = c.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }).every(c => c.querySelector('canvas'));
  await until(visibleDrawn, 15000, 'every visible page picture');
  const check = () => {
    const cells = [...document.querySelectorAll('.pe-cell')];
    for (const cell of cells) {
      const pic = cell.querySelector('.pe-holder').getBoundingClientRect();
      const num = cell.querySelector('.pe-num').getBoundingClientRect();
      const tick = cell.querySelector('.pe-check').getBoundingClientRect();
      ok(pic.width > pic.height, 'a turned page is wide');
      ok(num.top - pic.bottom >= 0 && num.top - pic.bottom < 14, `number ${Math.round(num.top - pic.bottom)} px under the picture`);
      ok(tick.left >= pic.left && tick.right <= pic.right && tick.top >= pic.top && tick.bottom <= pic.bottom, 'tick box on the picture');
      ok(cell.getBoundingClientRect().height - pic.height < 40, `cell is ${Math.round(cell.getBoundingClientRect().height - pic.height)} px taller than its picture`);
      ok(/^Page \d+$/.test(cell.getAttribute('aria-label')) && cell.hasAttribute('aria-pressed'), 'cells say which page and whether chosen');
    }
    const tops = [...new Set(cells.map(c => Math.round(c.getBoundingClientRect().top)))].sort((x, y) => x - y);
    if (tops.length > 1) ok(tops[1] - tops[0] - cells[0].getBoundingClientRect().height < 40, 'rows sit close together');
  };
  check();
  const first = document.querySelector('.pe-check');
  first.click();
  ok(app.panels.thumbs.selected.size === 1 && first.closest('.pe-cell').getAttribute('aria-pressed') === 'true', 'the tick box chooses the page');
  await window.__shot('tool-review-page-editor-desktop');
  await window.__cdp('Emulation.setDeviceMetricsOverride', { width: 760, height: 640, deviceScaleFactor: 1, mobile: false });
  await wait(250);
  await until(visibleDrawn, 15000, 'visible page pictures at the small size');
  check();
  await window.__shot('tool-review-page-editor-small');
  await window.__cdp('Emulation.clearDeviceMetricsOverride', {});
  await wait(200);
  app.pageEditor.close();
  app.panels.show('thumbs');
  await until(() => document.querySelectorAll('.thumb-cell canvas').length >= 2, 8000, 'side pictures');
  for (const cell of document.querySelectorAll('.thumb-cell')) {
    const pic = cell.querySelector('canvas')?.getBoundingClientRect();
    if (!pic) continue;
    const num = cell.querySelector('.thumb-num').getBoundingClientRect();
    ok(num.top - pic.bottom < 10, `side number ${Math.round(num.top - pic.bottom)} px under its picture`);
    ok(cell.getBoundingClientRect().height - pic.height < 40, 'side cells fit wide pictures');
  }
  await window.__shot('tool-review-side-pages');
  app.panels.show(null);
  s.dirty = false;
});

await test('Closing Search clears its button, highlights and late results; reopening finds the words again', async () => {
  await open();
  app.setMode('view');
  btn('Search').click();
  ok(btn('Search').classList.contains('active') && btn('Search').getAttribute('aria-pressed') === 'true', 'Search shows as open');
  const input = app.panels.search.input;
  input.value = 'the';
  app.panels.search.start();
  await until(() => document.querySelector('.matches .match'), 8000, 'highlights');
  [...document.querySelectorAll('.side .rail-btn')].find(b => b.getAttribute('aria-label') === 'Close the panel').click();
  ok(!btn('Search').classList.contains('active') && btn('Search').getAttribute('aria-pressed') === 'false', 'Search still looks open after closing');
  ok(!document.querySelector('.matches .match'), 'highlights stayed on the page');
  btn('Search').click();
  ok(input.value === 'the', 'the words typed are kept');
  await until(() => document.querySelector('.matches .match'), 8000, 'highlights again');
  // A search still running when the panel switches must not draw afterwards.
  input.value = 'and';
  app.panels.search.start();
  btn('Outline').click();
  await wait(600);
  ok(!document.querySelector('.matches .match'), 'late results drew highlights after switching panels');
  ok(!btn('Search').classList.contains('active') && btn('Outline').classList.contains('active'), 'only Outline shows as open');
  app.panels.show(null);
});

await test('View menu is compact, grouped and complete at desktop and small sizes', async () => {
  await open();
  app.setMode('view');
  const check = async (shot) => {
    closePopups();
    btn('View').click();
    const menu = document.querySelector('.dropdown');
    const r = menu.getBoundingClientRect();
    ok(r.width <= 610, `menu is ${Math.round(r.width)} px wide`);
    ok(r.bottom <= innerHeight && r.right <= innerWidth && r.left >= 0, 'menu fits the window');
    const titles = [...menu.querySelectorAll('.dd-title')].map(t => t.textContent);
    ok(['Layout', 'Zoom', 'Page colours', 'Reading', 'Interface theme'].every(t => titles.includes(t)), `sections: ${titles}`);
    const themes = menu.querySelectorAll('.dd-grid .dd-item');
    ok(themes.length >= 13, `${themes.length} themes`);
    for (const item of menu.querySelectorAll('.dd-item')) {
      const b = item.getBoundingClientRect();
      ok(b.right <= r.right + 0.5 && b.left >= r.left - 0.5, `${item.dataset.label} is cut off`);
      const label = item.querySelector('.dd-label');
      ok(label.scrollWidth <= label.clientWidth + 1, `${item.dataset.label} label is clipped`);
    }
    for (const label of ['Fit page', 'Zoom in', 'Read aloud', 'Full screen']) ok(menu.querySelector(`.dd-item[data-label="${label}"] kbd`), `${label} shortcut shown`);
    ok(menu.querySelectorAll('.dd-item[aria-checked=true]').length === 3, 'one choice each for layout, page colours and theme');
    await window.__shot(shot);
    return `${Math.round(r.width)}×${Math.round(r.height)}`;
  };
  const big = await check('tool-review-view-menu-desktop');
  await window.__cdp('Emulation.setDeviceMetricsOverride', { width: 640, height: 560, deviceScaleFactor: 1, mobile: false });
  await wait(250);
  const small = await check('tool-review-view-menu-small');
  closePopups();
  await window.__cdp('Emulation.clearDeviceMetricsOverride', {});
  await wait(200);
  const was = document.documentElement.dataset.uiTheme;
  const stored = { ...localStorage };
  try {
    window.__api.applyUiTheme('daylight');
    ok(document.documentElement.dataset.theme === 'light', 'a light theme is on');
    await check('tool-review-view-menu-light');
    const menu = document.querySelector('.dropdown');
    ok(getComputedStyle(menu).backgroundColor !== getComputedStyle(menu.querySelector('.dd-item.on')).backgroundColor, 'the chosen items stand out in the light theme');
  } finally {
    closePopups();
    window.__api.applyUiTheme(was);
    for (const k of Object.keys(localStorage)) if (!(k in stored)) localStorage.removeItem(k);
    for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, v);
  }
  ok(document.documentElement.dataset.uiTheme === was, 'the theme from before is back');
  return `desktop ${big}, small ${small}`;
});

await test('Pinch zoom is continuous, holds the spot under the pointer, and goes below fit width', async () => {
  // Far into a long file, where the gaps between pages add up.
  const s = await open('huge-3000.pdf');
  app.viewer.setLayout('continuous');
  app.viewer.setScale(3);
  app.viewer.goTo(Math.min(1500, s.pages.length - 1));
  app.viewer.scroller.scrollLeft = 200;
  await settle();
  const sc = app.viewer.scroller, host = sc.getBoundingClientRect();
  const x = host.left + host.width * 0.3, y = host.top + host.height * 0.5;
  const spotAt = () => {
    for (const v of app.viewer.views.values()) {
      const r = v.el.getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) return { id: v.page.id, fx: (x - r.left) / r.width, fy: (y - r.top) / r.height };
    }
    return null;
  };
  const before = spotAt();
  const wheel = (deltaY, extra = {}) => { const e = new WheelEvent('wheel', { deltaY, ctrlKey: true, clientX: x, clientY: y, bubbles: true, cancelable: true, ...extra }); sc.dispatchEvent(e); return e; };
  const s0 = app.viewer.scale;
  wheel(3.9); const a = app.viewer.scale / s0;
  const s1 = app.viewer.scale;
  wheel(4.15); const b = app.viewer.scale / s1;
  ok(Math.abs(Math.log(a) / 3.9 - Math.log(b) / 4.15) < 1e-6, `pinch steps jump: ${a} then ${b}`);
  // While the page is wider than the window, the spot holds both ways.
  const same = (p, q, both) => p && q && p.id === q.id && Math.abs(p.fy - q.fy) < 0.01 && (!both || Math.abs(p.fx - q.fx) < 0.01);
  ok(same(spotAt(), before, true), `a small pinch moved the spot: ${JSON.stringify(spotAt())} from ${JSON.stringify(before)}`);
  // Below fit width the page is centred, so only its height can hold the spot.
  for (let i = 0; i < 30; i++) wheel(6.5);
  ok(app.viewer.scale < app.viewer.fitScale() * 0.9, `did not zoom out below fit width: ${app.viewer.scale}`);
  ok(same(spotAt(), before, false), `the spot drifted from ${JSON.stringify(before)} to ${JSON.stringify(spotAt())}`);
  const pg = [...app.viewer.views.values()].find(v => v.page.id === before.id).el.getBoundingClientRect();
  ok(Math.abs((pg.left + pg.right) / 2 - (host.left + sc.clientWidth / 2)) < 2, 'a narrow page stays centred');
  for (let i = 0; i < 30; i++) wheel(-6.5);
  for (let i = 0; i < 80 && app.viewer.scale < 3 * Math.exp(-0.0805) * 0.999; i++) wheel(-1);
  ok(same(spotAt(), before, false), `the spot drifted zooming back in: ${JSON.stringify(spotAt())}`);
  ok(app.viewer.scale > app.viewer.fitScale() && sc.scrollWidth > sc.clientWidth, 'zoomed in, the page reaches past the window sideways');
  // Every pinch pixel zooms at the same rate, around 50 px as everywhere else, in both directions.
  const rate = (deltas, extra) => deltas.map(d => {
    app.viewer.setScale(2);
    const start = app.viewer.scale;
    wheel(d, extra);
    ok(app.viewer.scale > 0.11 && app.viewer.scale < 7.9, 'hit the zoom limit');
    return -Math.log(app.viewer.scale / start) / d;
  });
  const pinchRates = rate([49.5, 50, 50.5, -49.5, -50, -50.5, 3, 120]);
  ok(pinchRates.every(r => Math.abs(r - pinchRates[0]) < 1e-9), `pinch zoom per pixel varies: ${pinchRates.map(r => r.toFixed(5))}`);
  // With the Ctrl key really held, it is a mouse wheel: the same steady rate, about 20% for a click.
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', ctrlKey: true, bubbles: true }));
  const mouseRates = rate([49.5, 50, 50.5, -50, 100, -100]);
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', code: 'ControlLeft', ctrlKey: false, bubbles: true }));
  ok(mouseRates.every(r => Math.abs(r - mouseRates[0]) < 1e-9), `wheel zoom per pixel varies: ${mouseRates.map(r => r.toFixed(5))}`);
  const click100 = Math.exp(-100 * mouseRates[0]);
  ok(click100 > 0.78 && click100 < 0.88, `a wheel click zooms by ${click100.toFixed(3)}`);
  // Real touchpad-style scrolling through the browser moves both ways at once.
  app.viewer.setScale(3);
  await settle();
  sc.scrollTop = Math.max(0, sc.scrollTop - 200); sc.scrollLeft = 200;
  const top0 = sc.scrollTop, left0 = sc.scrollLeft;
  await window.__cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 90, deltaY: 140 });
  await until(() => sc.scrollTop !== top0 && sc.scrollLeft !== left0, 2000, 'scrolling both ways');
  await wait(250);
  ok(sc.scrollTop - top0 > 50 && sc.scrollLeft - left0 > 30, `scrolled ${sc.scrollLeft - left0} sideways and ${sc.scrollTop - top0} down`);
  ok(Math.abs(app.viewer.scale - 3) < 1e-9, 'scrolling changed the zoom');
  // With "the wheel zooms" on, a touchpad still scrolls; a mouse wheel click zooms.
  const saved = localStorage.getItem('pdfy.settings');
  localStorage.setItem('pdfy.settings', JSON.stringify({ wheelZooms: true }));
  try {
    const z = app.viewer.scale;
    const pad = new WheelEvent('wheel', { deltaY: 12.5, deltaX: 3.25, clientX: x, clientY: y, bubbles: true, cancelable: true });
    sc.dispatchEvent(pad);
    ok(!pad.defaultPrevented && app.viewer.scale === z, 'a touchpad scroll zoomed');
    const notch = new WheelEvent('wheel', { deltaY: 100, clientX: x, clientY: y, bubbles: true, cancelable: true });
    sc.dispatchEvent(notch);
    ok(notch.defaultPrevented && app.viewer.scale < z && app.viewer.scale > z * 0.75, `a wheel click zoomed to ${app.viewer.scale / z}`);
  } finally {
    if (saved === null) localStorage.removeItem('pdfy.settings'); else localStorage.setItem('pdfy.settings', saved);
  }
});

await test('Read aloud stops while waiting for page text, while talking, on Escape and on switching documents', async () => {
  const synth = window.speechSynthesis;
  const real = { speak: synth.speak, cancel: synth.cancel };
  const spoken = [];
  let current = null;
  synth.speak = u => { spoken.push(u.text); current = u; };
  // Like Windows can: cancelling reports nothing, neither "ended" nor "error".
  synth.cancel = () => { current = null; };
  const settles = p => Promise.race([p.then(() => true), wait(300).then(() => false)]);
  try {
    const s = await open();
    const bar = document.querySelector('.speech-bar');
    // Stopped before the page text arrives: nothing is said later.
    const first = app.readAloud();
    ok(!bar.hidden, 'the Stop bar shows straight away');
    app.stopReading();
    ok(await settles(first), 'a reading stopped during page text never finishes');
    await wait(300);
    ok(spoken.length === 0 && bar.hidden, `a stopped reading still spoke ${spoken.length} time(s)`);
    // Stop, then start again at once: only the new one talks.
    const a = app.readAloud(); app.stopReading(); const b = app.readAloud();
    await until(() => spoken.length, 4000, 'speech');
    await wait(300);
    ok(spoken.length === 1, `${spoken.length} readings talked`);
    ok(!bar.hidden && app.cmd.readAloud.on(), 'Read aloud shows as on');
    const spokenFirst = current;
    bar.querySelector('button').click();
    ok(await settles(Promise.all([a, b])), 'Stop while talking leaves the reading unfinished');
    ok(bar.hidden && !current, 'Stop on the bar stops the voice');
    ok(!spokenFirst.onend && !spokenFirst.onerror, 'the stopped sentence still has its handlers');
    // A late report from the stopped sentence must not end a newer reading.
    const n = app.readAloud();
    await until(() => current, 4000, 'the newer reading');
    spokenFirst.onend?.(new Event('end'));
    ok(!(await settles(n)) && !bar.hidden, 'the old sentence ended the new reading');
    app.stopReading();
    ok(await settles(n), 'the newer reading does not stop');
    // Escape stops it too.
    const c = app.readAloud();
    await until(() => current, 4000, 'speech again');
    key('Escape');
    ok(await settles(c), 'Escape leaves the reading unfinished');
    ok(bar.hidden && !current, 'Escape stops reading');
    // Opening another document stops it.
    const d = app.readAloud();
    await until(() => current, 4000, 'speech before switching');
    const r = await fetch('/fixtures/structure.pdf');
    await app.openFile(new File([await r.blob()], 'structure.pdf', { type: 'application/pdf' }));
    ok(await settles(d), 'switching documents leaves the reading unfinished');
    ok(bar.hidden && !current && app.session !== s, 'switching documents stops reading');
  } finally {
    synth.speak = real.speak; synth.cancel = real.cancel;
    delete synth.speak; delete synth.cancel;
  }
});

await closeAll();
export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
