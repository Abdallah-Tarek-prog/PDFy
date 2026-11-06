// Uses the app the way a person does: real mouse moves, clicks, drags and key presses.
const app = window.__pdfy, A = window.__api;
const results = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 6000, what = 'condition') => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(50); }
  throw new Error(`Timed out waiting for ${what}`);
};
const fx = async name => { const r = await fetch(`/fixtures/${name}`); return new File([await r.blob()], name, { type: 'application/pdf' }); };
const closeAll = async () => { for (const s of [...app.sessions]) { s.dirty = false; await app.closeSession(s); } };
const ok = (v, msg) => { if (!v) throw new Error(msg ?? 'check failed'); };
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg ?? 'values differ'}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); };
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
  document.querySelectorAll('.overlay-bg').forEach(d => d.remove());
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), results }, null, 1) });
}

const cdp = (method, params) => window.__cdp(method, params);
const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: extra.button ?? (type === 'mouseMoved' && !extra.held ? 'none' : 'left'), buttons: extra.held || type === 'mousePressed' ? 1 : 0, clickCount: extra.clickCount ?? 1, modifiers: extra.modifiers ?? 0 });
const click = async (x, y, opts) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, opts); await mouse('mouseReleased', x, y, opts); await wait(40); };
const dblclick = async (x, y) => { await click(x, y); await mouse('mousePressed', x, y, { clickCount: 2 }); await mouse('mouseReleased', x, y, { clickCount: 2 }); await wait(60); };
const drag = async (x0, y0, x1, y1, steps = 8, opts = {}) => {
  await mouse('mouseMoved', x0, y0);
  await mouse('mousePressed', x0, y0, opts);
  for (let i = 1; i <= steps; i++) await mouse('mouseMoved', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, { held: true, ...opts });
  await mouse('mouseReleased', x1, y1, opts);
  await wait(60);
};
const key = async (k, code, vk, modifiers = 0, text) => {
  await cdp('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, text });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await wait(30);
};
const type = text => cdp('Input.insertText', { text });

/** Where a spot in page points is on screen, at the current zoom. */
function screen(page, px, py) {
  const v = app.viewer.views.get(page.id);
  const r = v.el.getBoundingClientRect();
  const m = v.vp.m;
  return [r.left + m[0] * px + m[2] * py + m[4], r.top + m[1] * px + m[3] * py + m[5]];
}
const tool = async name => { app.tools.setTool(name); await wait(30); };
const pressRibbon = async (tab, label) => {
  // The tab name is from the old ribbon. Buttons are now found wherever they live: toolbar, menu or More.
  void tab;
  const b = await app.revealCommand(label);
  await wait(50);
  ok(b, `button ${label}`);
  const r = b.getBoundingClientRect();
  await click(r.left + r.width / 2, r.top + r.height / 2);
};
async function settle(ms = 3000) {
  const start = performance.now();
  while (performance.now() - start < ms) {
    const views = [...app.viewer.views.values()];
    if (views.length && views.every(v => !v.needsRender && !v.task)) break;
    await wait(40);
  }
  await wait(100);
}
async function fresh(name = 'normal.pdf') {
  await closeAll();
  const s = await app.openPdfBlob(await fx(name), name);
  ok(s, 'opened');
  await settle();
  await wait(350);
  app.viewer.setFit('page');
  await settle();
  app.tools.setTool('select');
  return s;
}

await test('Pen: draw with the mouse', async () => {
  const s = await fresh();
  await tool('pen');
  const p = s.pages[0];
  const [x0, y0] = screen(p, 100, 400), [x1, y1] = screen(p, 300, 300);
  await drag(x0, y0, x1, y1, 25);
  const a = p.annots.find(z => z.kind === 'ink');
  ok(a, 'stroke made');
  ok(a.paths[0].length >= 4, 'has points');
  eq(app.tools.tool, 'pen', 'pen stays active');
  ok(Math.abs(a.paths[0][0] - 100) < 3 && Math.abs(a.paths[0][1] - 400) < 3, `starts where pressed: ${a.paths[0].slice(0, 2)}`);
});

await test('Marker and eraser', async () => {
  const s = await fresh();
  const p = s.pages[0];
  await tool('marker');
  await drag(...screen(p, 100, 500), ...screen(p, 400, 500), 15);
  const m = p.annots.find(z => z.kind === 'ink');
  ok(m && m.width > 5 && m.opacity < 1, 'marker is wide and see-through');
  await tool('eraser');
  await drag(...screen(p, 250, 520), ...screen(p, 250, 480), 8);
  eq(p.annots.filter(z => z.kind === 'ink').length, 0, 'erased');
  await key('z', 'KeyZ', 90, 2);
  eq(p.annots.filter(z => z.kind === 'ink').length, 1, 'Ctrl+Z brings it back');
});

await test('Rectangle: draw, then move, resize, recolour, delete', async () => {
  const s = await fresh();
  const p = s.pages[0];
  await tool('rect');
  await drag(...screen(p, 100, 400), ...screen(p, 300, 300));
  let a = p.annots.find(z => z.kind === 'rect');
  ok(a, 'made');
  eq(app.tools.tool, 'select', 'goes back to Select');
  eq(app.viewer.selection?.annotId, a.id, 'selected');
  // Move: drag the shape.
  const before = [...a.rect];
  await drag(...screen(p, 200, 350), ...screen(p, 250, 310));
  a = p.annots.find(z => z.kind === 'rect');
  ok(Math.abs(a.rect[0] - (before[0] + 50)) < 2, `moved in x: ${a.rect[0]}`);
  ok(Math.abs(a.rect[1] - (before[1] - 40)) < 2, `moved in y: ${a.rect[1]}`);
  // Resize: drag the bottom right handle.
  const handles = [...app.viewer.views.get(p.id).selG.querySelectorAll('.sel-handle')];
  ok(handles.length === 8, 'eight handles');
  const h = handles.find(el => el.getAttribute('data-fx') === '1' && el.getAttribute('data-fy') === '1');
  const r = h.getBoundingClientRect();
  const w0 = a.rect[2] - a.rect[0];
  await drag(r.left + 4, r.top + 4, r.left + 64, r.top + 44);
  a = p.annots.find(z => z.kind === 'rect');
  ok(a.rect[2] - a.rect[0] > w0 + 20, `wider: ${a.rect[2] - a.rect[0]} vs ${w0}`);
  // Recolour with a swatch in the style bar.
  const sw = document.querySelector('.swatch-btn[title="#1a56db"]');
  const sr = sw.getBoundingClientRect();
  await click(sr.left + 8, sr.top + 8);
  eq(p.annots.find(z => z.kind === 'rect').color, '#1a56db', 'recoloured');
  // Arrow key nudges.
  const nudge = p.annots.find(z => z.kind === 'rect').rect[0];
  await key('ArrowRight', 'ArrowRight', 39);
  ok(p.annots.find(z => z.kind === 'rect').rect[0] > nudge, 'arrow key moves it');
  // Delete key.
  await key('Delete', 'Delete', 46);
  eq(p.annots.filter(z => z.kind === 'rect').length, 0, 'deleted');
  await key('z', 'KeyZ', 90, 2);
  eq(p.annots.filter(z => z.kind === 'rect').length, 1, 'undo brings it back');
});

await test('Ellipse, line, arrow, with Shift for straight lines', async () => {
  const s = await fresh();
  const p = s.pages[0];
  await tool('ellipse');
  await drag(...screen(p, 100, 400), ...screen(p, 200, 300));
  await tool('line');
  await drag(...screen(p, 250, 400), ...screen(p, 350, 300));
  await tool('arrow');
  await drag(...screen(p, 380, 400), ...screen(p, 500, 396), 6, { modifiers: 8 });
  ok(p.annots.some(z => z.kind === 'ellipse'), 'ellipse');
  ok(p.annots.some(z => z.kind === 'line'), 'line');
  const arrow = p.annots.find(z => z.kind === 'arrow');
  ok(arrow, 'arrow');
  ok(Math.abs(arrow.pts[1] - arrow.pts[3]) < 0.5, `Shift keeps it level: ${arrow.pts}`);
});

await test('Polygon, polyline, cloud: click points, then finish', async () => {
  const s = await fresh();
  const p = s.pages[0];
  await tool('polygon');
  await click(...screen(p, 100, 400));
  await click(...screen(p, 200, 400));
  await click(...screen(p, 150, 300));
  await key('Enter', 'Enter', 13);
  const poly = p.annots.find(z => z.kind === 'polygon');
  ok(poly, 'Enter finishes it');
  eq(poly.pts.length, 6, 'three corners');
  await tool('polyline');
  await click(...screen(p, 250, 400));
  await click(...screen(p, 300, 300));
  await dblclick(...screen(p, 350, 400));
  ok(p.annots.some(z => z.kind === 'polyline'), 'double-click finishes it');
  await tool('cloud');
  await click(...screen(p, 400, 400));
  await click(...screen(p, 500, 400));
  await click(...screen(p, 500, 300));
  await click(...screen(p, 400, 400));
  ok(p.annots.some(z => z.kind === 'cloud'), 'clicking the first point closes it');
});

await test('Measure: distance and area', async () => {
  const s = await fresh();
  const p = s.pages[0];
  await tool('distance');
  await drag(...screen(p, 100, 300), ...screen(p, 172, 300));
  const d = p.annots.find(z => z.measureType === 'distance');
  ok(d, 'distance made');
  ok(/1\.0\d in/.test(d.contents) || /0\.9\d in/.test(d.contents), `72 points is about 1 inch: ${d.contents}`);
  await tool('area');
  await click(...screen(p, 100, 200));
  await click(...screen(p, 172, 200));
  await click(...screen(p, 172, 128));
  await click(...screen(p, 100, 128));
  await key('Enter', 'Enter', 13);
  const m = p.annots.find(z => z.measureType === 'area');
  ok(m, 'area made');
  ok(/[01]\.\d+ in²/.test(m.contents), `one square inch: ${m.contents}`);
});

await test('Text box: click, type, edit, change font, Arabic', async () => {
  const s = await fresh();
  const p = s.pages[0];
  await tool('text');
  await click(...screen(p, 100, 300));
  let ta = document.querySelector('.inline-editor');
  ok(ta, 'editor opened');
  eq(document.activeElement, ta, 'ready to type');
  await type('Hello from a real keyboard');
  await click(...screen(p, 500, 100));
  let a = p.annots.find(z => z.kind === 'text');
  ok(a, 'text box made');
  eq(a.text, 'Hello from a real keyboard');
  // Double-click to edit it again.
  const [cx, cy] = screen(p, a.rect[0] + 20, a.rect[3] - 10);
  await dblclick(cx, cy);
  ta = document.querySelector('.inline-editor');
  ok(ta, 'editor reopened');
  ta.select();
  await type('مرحبا Changed');
  await click(...screen(p, 500, 100));
  a = p.annots.find(z => z.kind === 'text');
  eq(a.text, 'مرحبا Changed', 'edited');
  // Bold through the style bar.
  await click(cx, cy);
  const bold = document.querySelector('.style-toggle');
  ok(bold, 'bold button');
  const br = bold.getBoundingClientRect();
  await click(br.left + 8, br.top + 8);
  ok(p.annots.find(z => z.kind === 'text').bold, 'bold applied');
  // Empty text boxes do not stay behind.
  await tool('text');
  await click(...screen(p, 100, 200));
  await key('Escape', 'Escape', 27);
  eq(p.annots.filter(z => z.kind === 'text').length, 1, 'cancelled box is gone');
  const { blob, warnings } = await A.buildFile(s);
  eq(warnings.length, 0, warnings.join(';'));
  ok(blob.size > 1000);
});

await test('Sticky note and comment', async () => {
  const s = await fresh();
  const p = s.pages[0];
  await tool('note');
  await click(...screen(p, 400, 600));
  const ta = document.querySelector('.inline-editor.comment');
  ok(ta, 'comment box opened');
  await type('Please review this');
  await click(...screen(p, 100, 100));
  const a = p.annots.find(z => z.kind === 'note');
  eq(a.contents, 'Please review this');
  app.panels.show('comments');
  await wait(300);
  ok(document.querySelector('.comment p')?.textContent.includes('Please review'), 'listed in Comments');
  app.panels.show('thumbs');
});

await test('Select text with the mouse, then copy works, then highlight', async () => {
  const s = await fresh();
  const p = s.pages[0];
  await wait(500);
  // Line of text at y=690, starting at x=60.
  await drag(...screen(p, 62, 695), ...screen(p, 200, 695), 12);
  const sel = window.getSelection().toString();
  ok(sel.length > 5, `text was selected: "${sel}"`);
  window.getSelection().removeAllRanges();
  await tool('highlight');
  await drag(...screen(p, 62, 695), ...screen(p, 200, 695), 12);
  await wait(100);
  const h = p.annots.find(z => z.kind === 'highlight');
  ok(h, 'highlight made from the selection');
  ok(h.quads.length >= 1, 'has a line');
  ok(h.contents?.length > 5, 'remembers the words');
  await tool('underline');
  await drag(...screen(p, 62, 677), ...screen(p, 200, 677), 12);
  await wait(100);
  ok(p.annots.some(z => z.kind === 'underline'), 'underline');
  return `selected "${sel.slice(0, 40)}"`;
});

await test('Whiteout, redact marking, crop, link, snip through the mouse', async () => {
  const s = await fresh();
  const p = s.pages[0];
  await tool('whiteout');
  await drag(...screen(p, 100, 700), ...screen(p, 300, 650));
  ok(p.annots.some(z => z.kind === 'whiteout'), 'whiteout');
  await tool('redact');
  await drag(...screen(p, 350, 700), ...screen(p, 500, 650));
  ok(p.annots.some(z => z.kind === 'redact'), 'redact mark');
  await tool('snip');
  await drag(...screen(p, 60, 760), ...screen(p, 300, 720));
  await wait(900);
  ok(p.annots.some(z => z.kind === 'image'), 'theme snip');
  await tool('link');
  await drag(...screen(p, 100, 200), ...screen(p, 300, 150));
  await wait(150);
  let input = document.querySelector('.overlay-bg input');
  ok(input, 'asks for the address');
  input.value = 'example.org';
  document.querySelector('.overlay-bg .primary').click();
  await wait(100);
  eq(p.annots.find(z => z.kind === 'link')?.url, 'https://example.org', 'link');
  await tool('crop');
  await drag(...screen(p, 50, 780), ...screen(p, 560, 100));
  await wait(200);
  ok(document.querySelector('.overlay-bg .primary'), 'asks which pages');
  document.querySelector('.overlay-bg .primary').click();
  await settle();
  ok(s.pages[0].crop, 'cropped');
  await key('z', 'KeyZ', 90, 2);
  await settle();
  eq(s.pages[0].crop, null, 'undo crop');
});

await test('Edit a line of page text', async () => {
  const s = await fresh();
  const p = s.pages[0];
  await wait(500);
  await tool('edit-text');
  await click(...screen(p, 100, 735));
  const ta = document.querySelector('.inline-editor.edit-line');
  ok(ta, 'line opened for editing');
  ok(ta.value.includes('Page 1'), `text is ${ta.value}`);
  ta.select();
  await type('Changed heading');
  await key('Enter', 'Enter', 13);
  ok(p.annots.some(z => z.kind === 'whiteout' && z.burn), 'old text covered');
  const t = p.annots.find(z => z.kind === 'text' && z.burn);
  eq(t?.text, 'Changed heading', 'new text');
  const { blob } = await A.buildFile(s);
  const o = await A.openPdf(blob);
  const words = (await (await o.pdf.getPage(1)).getTextContent()).items.map(x => x.str).join(' ');
  await o.close();
  ok(words.includes('Changed heading'), 'saved');
});

await test('Form fields: click and type', async () => {
  const s = await fresh('form.pdf');
  await wait(300);
  const input = document.querySelector('.widgets input[type=text]');
  ok(input, 'text field on the page');
  const r = input.getBoundingClientRect();
  await click(r.left + 20, r.top + r.height / 2);
  eq(document.activeElement, input, 'typing goes to the field');
  await type('Typed by keyboard');
  await key('Tab', 'Tab', 9);
  await settle();
  const src = [...s.sources.values()][0];
  ok(src.formsEdited, 'recorded');
  const { blob } = await A.buildFile(s);
  const o = await A.openPdf(blob);
  const list = await (await o.pdf.getPage(1)).getAnnotations();
  await o.close();
  eq(list.find(w => w.fieldName === 'name').fieldValue, 'Typed by keyboard', 'saved value');
});

await test('Stamp and signature through the real ribbon', async () => {
  const s = await fresh();
  const p = s.pages[0];
  await pressRibbon('Comment', 'Stamp');
  await wait(150);
  const opt = [...document.querySelectorAll('.stamp-opt')].find(b => b.textContent === 'DRAFT');
  ok(opt, 'stamp list');
  const or = opt.getBoundingClientRect();
  await click(or.left + 20, or.top + 10);
  await wait(100);
  eq(app.tools.tool, 'stamp', 'ready to place');
  await click(...screen(p, 300, 400));
  eq(p.annots.find(z => z.kind === 'stamp')?.text, 'DRAFT', 'placed');
  await pressRibbon('Comment', 'Sign');
  await wait(200);
  const tabs = [...document.querySelectorAll('.overlay-bg .seg-btn')];
  tabs.find(b => b.textContent === 'Draw').click();
  await wait(50);
  const pad = document.querySelector('.sig-pad');
  const pr = pad.getBoundingClientRect();
  await drag(pr.left + 40, pr.top + 40, pr.left + 300, pr.top + 120, 12);
  [...document.querySelectorAll('.overlay-bg .btn')].find(b => b.textContent === 'Use signature').click();
  await wait(400);
  eq(app.tools.tool, 'signature', 'ready to place');
  await click(...screen(p, 300, 250));
  await wait(100);
  ok(p.annots.some(z => z.kind === 'image' && z.contents === 'Signature'), 'signature placed');
  // Saved for next time.
  await pressRibbon('Comment', 'Sign');
  await wait(250);
  ok(document.querySelector('.sig-item'), 'offered again next time');
  document.querySelector('.sig-item').click();
  await wait(350);
  eq(app.tools.tool, 'signature', 'reused');
  await key('Escape', 'Escape', 27);
  localStorage.removeItem('pdfy.signatures');
  app.setMode('view');
});

await test('Zoom: Ctrl+wheel, shortcuts, typing a number', async () => {
  const s = await fresh();
  void s;
  const z0 = app.viewer.scale;
  const r = app.viewer.scroller.getBoundingClientRect();
  await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: r.left + 300, y: r.top + 200, deltaX: 0, deltaY: -240, modifiers: 2 });
  await wait(250);
  ok(app.viewer.scale > z0, `wheel zooms in: ${z0} to ${app.viewer.scale}`);
  const z1 = app.viewer.scale;
  await key('-', 'Minus', 189, 2);
  await wait(200);
  ok(app.viewer.scale < z1, 'Ctrl+minus');
  await key('0', 'Digit0', 48, 2);
  await settle();
  const input = document.querySelector('.zoom-input');
  input.focus();
  input.value = '150';
  input.dispatchEvent(new Event('change'));
  await wait(250);
  ok(Math.abs(app.viewer.scale - 1.5) < 0.01, `typed zoom: ${app.viewer.scale}`);
  await settle();
  const v = [...app.viewer.views.values()][0];
  ok(v.canvas.width > 900, 'page redrawn sharp at the new zoom');
});

await test('Hand tool drags the page', async () => {
  await fresh();
  app.viewer.setScale(2);
  await settle();
  app.tools.setTool('hand');
  const sc = app.viewer.scroller;
  sc.scrollTop = 400;
  await wait(100);
  const before = sc.scrollTop;
  const r = sc.getBoundingClientRect();
  await drag(r.left + 300, r.top + 300, r.left + 300, r.top + 150);
  ok(sc.scrollTop > before + 100, `scrolled ${before} to ${sc.scrollTop}`);
  app.tools.setTool('select');
});

await test('Thumbnails: click jumps, drag reorders, panel buttons work', async () => {
  const s = await fresh();
  app.panels.show('thumbs');
  await wait(600);
  const first = s.pages[0], third = s.pages[2];
  const cells = () => [...document.querySelectorAll('.thumb-cell')];
  const cell = cells().find(c => c.querySelector('.thumb-num').textContent === '2');
  const cr = cell.getBoundingClientRect();
  await click(cr.left + 40, cr.top + 40);
  await wait(200);
  eq(app.viewer.current, 1, 'click goes to page 2');
  // Rotate from the panel.
  const rot = document.querySelector('.panel-tools [aria-label="Rotate selected right"]');
  const rr = rot.getBoundingClientRect();
  await click(rr.left + 10, rr.top + 10);
  eq(s.pages[1].rotate, 90, 'rotated');
  await key('z', 'KeyZ', 90, 2);
  eq(s.pages[1].rotate, 0, 'undo');
  // Dragging uses the browser's drag and drop, which needs a real gesture.
  const a = cells().find(c => c.querySelector('.thumb-num').textContent === '1').getBoundingClientRect();
  const b = cells().find(c => c.querySelector('.thumb-num').textContent === '3').getBoundingClientRect();
  await click(a.left + 40, a.top + 40);
  const before = s.pages.map(x => x.id).join();
  const dt = new DataTransfer();
  const src = cells().find(c => c.querySelector('.thumb-num').textContent === '1');
  src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt, clientX: a.left + 40, clientY: a.top + 40 }));
  const scroll = document.querySelector('.thumbs-scroll');
  scroll.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: b.left + 40, clientY: b.bottom + 4 }));
  scroll.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: b.left + 40, clientY: b.bottom + 4 }));
  src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  await settle();
  ok(s.pages.map(x => x.id).join() !== before, 'order changed');
  eq(s.pages[2], first, 'page 1 moved after page 3');
  void third;
  // Shift selects a range, and delete removes them all.
  await wait(300);
  const c1 = cells().find(c => c.querySelector('.thumb-num').textContent === '1').getBoundingClientRect();
  const c3 = cells().find(c => c.querySelector('.thumb-num').textContent === '3').getBoundingClientRect();
  await click(c1.left + 40, c1.top + 40);
  await click(c3.left + 40, c3.top + 40, { modifiers: 8 });
  const del = document.querySelector('.panel-tools [aria-label="Delete selected"]');
  const dr = del.getBoundingClientRect();
  await click(dr.left + 10, dr.top + 10);
  await wait(150);
  document.querySelector('.overlay-bg .primary')?.click();
  await wait(150);
  eq(s.pages.length, 9, 'three pages deleted');
});

await test('Tools on rotated pages land where the mouse is', async () => {
  const s = await fresh('rotated-mixed.pdf');
  await wait(900);
  for (const index of [1, 3]) {
    app.viewer.goTo(index);
    await settle();
    await wait(200);
    const p = s.pages[index];
    const v = app.viewer.views.get(p.id);
    const r = v.el.getBoundingClientRect();
    // Rectangle: its saved box must cover the same spot on screen after a save and reopen.
    await tool('rect');
    const sx0 = r.left + r.width * 0.2, sy0 = r.top + r.height * 0.2, sx1 = r.left + r.width * 0.5, sy1 = r.top + r.height * 0.5;
    await drag(sx0, sy0, sx1, sy1);
    const a = p.annots.find(z => z.kind === 'rect');
    ok(a, `rectangle on page ${index + 1}`);
    const c0 = screen(p, a.rect[0], a.rect[1]), c1 = screen(p, a.rect[2], a.rect[3]);
    const minX = Math.min(c0[0], c1[0]), minY = Math.min(c0[1], c1[1]);
    ok(Math.abs(minX - sx0) < 3 && Math.abs(minY - sy0) < 3, `box on page ${index + 1} is where it was dragged: ${minX},${minY} vs ${sx0},${sy0}`);
    // Pen.
    await tool('pen');
    await drag(r.left + r.width * 0.6, r.top + r.height * 0.6, r.left + r.width * 0.8, r.top + r.height * 0.7, 12);
    ok(p.annots.some(z => z.kind === 'ink'), 'pen stroke');
    // Text box reads upright on the rotated page.
    await tool('text');
    await click(r.left + r.width * 0.1, r.top + r.height * 0.8);
    await type('Upright words');
    await click(r.left + r.width * 0.9, r.top + r.height * 0.1);
    const t = p.annots.find(z => z.kind === 'text');
    ok(t, 'text box');
    eq(t.angle, p.baseRotate, 'turned to stay upright');
    app.tools.setTool('select');
    // Moving works in screen direction, even though the page is rotated.
    const rectNow = p.annots.find(z => z.kind === 'rect');
    const before = screen(p, rectNow.rect[0], rectNow.rect[1]);
    await click((sx0 + sx1) / 2, (sy0 + sy1) / 2);
    await drag((sx0 + sx1) / 2, (sy0 + sy1) / 2, (sx0 + sx1) / 2 + 30, (sy0 + sy1) / 2 + 20);
    const moved = p.annots.find(z => z.kind === 'rect');
    const after = screen(p, moved.rect[0], moved.rect[1]);
    ok(Math.abs(after[0] - before[0] - 30) < 3 && Math.abs(after[1] - before[1] - 20) < 3, `moved with the mouse: ${after} from ${before}`);
  }
  const { blob, warnings } = await A.buildFile(s);
  eq(warnings.length, 0, warnings.join(';'));
  await fetch('/__save/rotated-tools-output.pdf', { method: 'PUT', body: blob });
  const o = await A.openPdf(blob);
  const list = await (await o.pdf.getPage(2)).getAnnotations();
  ok(list.some(x => x.subtype === 'Square') && list.some(x => x.subtype === 'Ink') && list.some(x => x.subtype === 'FreeText'), 'all saved');
  await o.close();
});

await test('Links in a PDF are clickable', async () => {
  await fresh('annotated.pdf');
  await wait(400);
  const a = document.querySelector('.pdf-link');
  ok(a, 'link area on the page');
  ok(a.title.includes('example.com'), `link address: ${a.title}`);
});

await test('Document tabs: switch and close', async () => {
  await closeAll();
  await app.openPdfBlob(await fx('normal.pdf'), 'normal.pdf');
  await app.openPdfBlob(await fx('form.pdf'), 'form.pdf');
  await settle();
  const tabs = () => [...document.querySelectorAll('.doc-tab')];
  eq(tabs().length, 2, 'two tabs');
  eq(app.session.name, 'form.pdf');
  const t = tabs()[0].getBoundingClientRect();
  await click(t.left + 30, t.top + 12);
  await settle();
  eq(app.session.name, 'normal.pdf', 'tab switches');
  eq(document.querySelector('.page-input').value, '1');
  ok(app.viewer.views.size > 0, 'pages drawn');
  // Closing with unsaved work asks first.
  app.session.markDirty();
  const x = tabs()[0].querySelector('button').getBoundingClientRect();
  await click(x.left + 6, x.top + 6);
  await wait(120);
  ok(document.querySelector('.overlay-bg')?.textContent.includes('Save your changes'), 'asks');
  [...document.querySelectorAll('.overlay-bg .btn')].find(b => b.textContent === "Don't save").click();
  await wait(250);
  eq(tabs().length, 1, 'closed');
});

await test('Keyboard: Xodo keys: Escape, P, H, I, Ctrl+F, Ctrl+D', async () => {
  const s = await fresh();
  await tool('pen');
  await key('Escape', 'Escape', 27);
  eq(app.tools.tool, 'select', 'Escape returns to Select');
  await key('p', 'KeyP', 80, 0, 'p');
  eq(app.tools.tool, 'hand', 'P is Pan, as in Xodo');
  await key('h', 'KeyH', 72, 0, 'h');
  eq(app.tools.tool, 'highlight', 'H is Highlight, as in Xodo');
  eq(app.mode, 'edit', 'and the Edit tools show');
  await key('i', 'KeyI', 73, 0, 'i');
  eq(app.tools.tool, 'pen', 'I is Ink');
  await key('Escape', 'Escape', 27);
  eq(app.tools.tool, 'select', 'Escape again');
  await key('f', 'KeyF', 70, 2);
  await wait(100);
  eq(app.panels.active, 'search', 'Ctrl+F opens search');
  eq(document.activeElement, app.panels.search.input, 'ready to type');
  app.panels.show('thumbs');
  s.addAnnots(s.pages[0], [{ id: 'k1', kind: 'rect', rect: [100, 100, 200, 200], color: '#ff0000', opacity: 1, width: 2 }]);
  await settle();
  app.viewer.scroller.focus();
  app.viewer.select(s.pages[0].id, 'k1');
  await key('d', 'KeyD', 68, 2);
  eq(s.pages[0].annots.filter(a => a.kind === 'rect').length, 2, 'Ctrl+D duplicates');
});

await test('Image bar, driven by real clicks', async () => {
  await closeAll();
  await window.paste(await window.mockGemini());
  await wait(1000);
  const s = app.session, p = s.pages[0];
  const seg = label => [...document.querySelectorAll('.image-bar .seg-btn')].find(b => b.textContent === label);
  const r = seg('Light').getBoundingClientRect();
  ok(r.width > 10, 'bar is showing');
  await click(r.left + 10, r.top + 8);
  await wait(800);
  eq(p.annots[0].image.theme, 'light', 'Light');
  ok(seg('Light').classList.contains('active'), 'button shows it');
  const o = seg('Original').getBoundingClientRect();
  await click(o.left + 10, o.top + 8);
  await wait(200);
  eq(p.annots[0].image.blob, p.annots[0].image.original, 'Original gives back the exact image');
  // Keep photos off.
  const box = document.querySelector('.image-bar input[type=checkbox]');
  ok(box.checked, 'on by default');
  // Crop through the bar.
  const crop = document.querySelector('.image-bar [title^="Crop"]');
  const cr = crop.getBoundingClientRect();
  await click(cr.left + 8, cr.top + 8);
  eq(app.tools.tool, 'crop-image', 'crop mode');
  ok(app.cropTarget, 'remembers which image');
  const b = p.annots[0].rect;
  await drag(...screen(p, b[0] + 50, b[3] - 50), ...screen(p, b[0] + 250, b[3] - 200));
  for (let i = 0; i < 30 && s.undoLabel !== 'Crop image'; i++) await wait(100);
  const c = p.annots[0];
  ok(Math.abs(c.rect[2] - c.rect[0] - 200) < 3, `cropped width ${c.rect[2] - c.rect[0]}`);
  // Rotating.
  await wait(150);
  const rot = document.querySelector('.image-bar [title="Rotate 90°"]').getBoundingClientRect();
  await click(rot.left + 8, rot.top + 8);
  eq(p.annots[0].angle, 270, 'rotated');
  // Hold to compare.
  const hold = document.querySelector('.image-bar [title="Hold to see the original"]').getBoundingClientRect();
  await mouse('mouseMoved', hold.left + 8, hold.top + 8);
  await mouse('mousePressed', hold.left + 8, hold.top + 8);
  await wait(60);
  const v = app.viewer.views.get(p.id);
  const href = v.annotsG.querySelector('image').getAttribute('href');
  await mouse('mouseReleased', hold.left + 8, hold.top + 8);
  ok(href, 'compare swaps the picture');
});

await test('Reflow window, properties, text compare, layers open without trouble', async () => {
  const s = await fresh();
  void app.reflow();
  await wait(600);
  ok(document.querySelector('.reflow p')?.textContent.length > 10, 'reflow shows text');
  document.querySelector('.overlay-bg .primary').click();
  await wait(100);
  void app.propertiesDialog();
  await wait(250);
  ok(document.querySelector('.overlay-bg input'), 'properties');
  const title = document.querySelector('.overlay-bg #f-title');
  title.value = 'A new title';
  document.querySelector('.overlay-bg .primary').click();
  await wait(100);
  eq(s.pendingOptions.metadata.title, 'A new title');
  void app.textCompareDialog();
  await wait(100);
  const areas = document.querySelectorAll('.overlay-bg textarea');
  areas[0].value = 'one two three';
  areas[1].value = 'one four three';
  [...document.querySelectorAll('.overlay-bg .btn')].find(b => b.textContent === 'Compare').click();
  await wait(50);
  ok(document.querySelector('.overlay-bg ins')?.textContent.includes('four'), 'text compare');
  document.querySelector('.overlay-bg .primary').click();
  await wait(50);
  app.panels.show('layers');
  await wait(200);
  ok(document.querySelector('.panel:not([hidden]) .empty'), 'layers panel');
  app.panels.show('outline');
  await wait(200);
  ok(document.querySelector('.panel:not([hidden]) .empty'), 'contents panel');
  app.panels.show('bookmarks');
  document.querySelector('.panel:not([hidden]) [aria-label="Bookmark this page"]').click();
  await wait(50);
  eq(s.bookmarks.length, 1, 'bookmark added');
  app.panels.show('thumbs');
});

await test('Right-click menus, help and navigation keys', async () => {
  const s = await fresh();
  const p = s.pages[0];
  s.addAnnots(p, [
    { id: 'b1', kind: 'rect', rect: [100, 300, 300, 500], color: '#ff0000', fill: '#ffcccc', opacity: 1, width: 2 },
    { id: 'b2', kind: 'rect', rect: [150, 350, 350, 550], color: '#0000ff', fill: '#ccccff', opacity: 1, width: 2 },
  ]);
  await settle();
  const [x, y] = screen(p, 320, 520);
  await click(x, y, { button: 'right' });
  await wait(80);
  ok(document.querySelector('.ctx-menu'), 'menu opens on an object');
  [...document.querySelectorAll('.ctx-item')].find(b => b.textContent.includes('Send to back')).click();
  eq(p.annots[0].id, 'b2', 'sent to back');
  await key('z', 'KeyZ', 90, 2);
  eq(p.annots[0].id, 'b1', 'undo');
  // On empty page: rotate through the menu.
  const [ex, ey] = screen(p, 500, 100);
  await click(ex, ey, { button: 'right' });
  await wait(80);
  [...document.querySelectorAll('.ctx-item')].find(b => b.textContent.includes('Rotate page right')).click();
  await settle();
  eq(p.rotate, 90, 'page rotated from the menu');
  await key('z', 'KeyZ', 90, 2);
  await settle();
  // Thumbnail menu.
  await wait(300);
  const cell = [...document.querySelectorAll('.thumb-cell')].find(c => c.querySelector('.thumb-num').textContent === '2').getBoundingClientRect();
  await click(cell.left + 40, cell.top + 40, { button: 'right' });
  await wait(80);
  ok([...document.querySelectorAll('.ctx-item')].some(b => b.textContent.includes('Duplicate page')), 'thumbnail menu');
  await key('Escape', 'Escape', 27);
  ok(!document.querySelector('.ctx-menu'), 'Escape closes it');
  // Keys.
  app.viewer.scroller.focus();
  await key('End', 'End', 35);
  await settle();
  eq(app.viewer.current, 11, 'End goes to the last page');
  await key('Home', 'Home', 36);
  await settle();
  eq(app.viewer.current, 0, 'Home goes to the first page');
  await key('F1', 'F1', 112);
  await wait(60);
  ok(document.querySelector('.sc-dialog .sc-row'), 'F1 shows the shortcuts list');
  document.querySelector('.overlay-bg .primary').click();
  await wait(50);
  await key('a', 'KeyA', 65, 2);
  ok(window.getSelection().toString().includes('Page 1'), 'Ctrl+A selects the page words');
  window.getSelection().removeAllRanges();
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' });
  await wait(30);
  eq(app.tools.tool, 'hand', 'Space holds the hand');
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await wait(30);
  eq(app.tools.tool, 'select', 'releasing Space goes back');
});

await test('Quick bar over selected text', async () => {
  const s = await fresh();
  const p = s.pages[0];
  await wait(500);
  await drag(...screen(p, 62, 695), ...screen(p, 200, 695), 12);
  await wait(80);
  const bar = document.querySelector('.sel-bar');
  ok(!bar.hidden, 'bar appears');
  const b = bar.querySelector('[title="Highlight"]').getBoundingClientRect();
  await click(b.left + 8, b.top + 8);
  ok(p.annots.some(a => a.kind === 'highlight'), 'highlight made');
  ok(bar.hidden, 'bar goes away');
  // Redact from a selection.
  await drag(...screen(p, 62, 677), ...screen(p, 200, 677), 12);
  await wait(80);
  const r = bar.querySelector('[title="Mark for redaction"]').getBoundingClientRect();
  await click(r.left + 8, r.top + 8);
  ok(p.annots.some(a => a.kind === 'redact'), 'redaction marked');
});

await test('Several objects: select, move, align, delete together', async () => {
  const s = await fresh();
  const p = s.pages[0];
  const base = { kind: 'rect', color: '#ff0000', opacity: 1, width: 2 };
  s.addAnnots(p, [
    { ...base, id: 'm1', rect: [100, 500, 200, 560] },
    { ...base, id: 'm2', rect: [150, 400, 260, 450] },
    { ...base, id: 'm3', rect: [400, 300, 450, 340] },
  ]);
  await settle();
  // Ctrl+click builds a selection.
  await click(...screen(p, 150, 530));
  await click(...screen(p, 200, 425), { modifiers: 2 });
  eq(app.viewer.extra.size, 1, 'two selected');
  ok(document.querySelector('.style-bar').textContent.includes('2 objects'), 'says so');
  // Move together.
  const r1 = p.annots.find(a => a.id === 'm1').rect[0], r2 = p.annots.find(a => a.id === 'm2').rect[0];
  await drag(...screen(p, 150, 530), ...screen(p, 180, 530));
  ok(Math.abs(p.annots.find(a => a.id === 'm1').rect[0] - r1 - 30) < 2, 'first moved');
  ok(Math.abs(p.annots.find(a => a.id === 'm2').rect[0] - r2 - 30) < 2, 'second moved');
  await key('z', 'KeyZ', 90, 2);
  ok(Math.abs(p.annots.find(a => a.id === 'm1').rect[0] - r1) < 0.01 && Math.abs(p.annots.find(a => a.id === 'm2').rect[0] - r2) < 0.01, 'one undo moves both back');
  // Align.
  [...document.querySelectorAll('.style-bar .btn')].find(b => b.textContent === 'Left').click();
  await wait(30);
  ok(Math.abs(p.annots.find(a => a.id === 'm1').rect[0] - p.annots.find(a => a.id === 'm2').rect[0]) < 3, 'aligned');
  // Shift+drag box picks all three.
  app.viewer.select(null);
  await drag(...screen(p, 60, 620), ...screen(p, 500, 280), 6, { modifiers: 8 });
  eq(app.viewer.extra.size, 2, 'all three in the box');
  await key('Delete', 'Delete', 46);
  eq(p.annots.filter(a => a.kind === 'rect').length, 0, 'all deleted');
  await key('z', 'KeyZ', 90, 2);
  eq(p.annots.filter(a => a.kind === 'rect').length, 3, 'one undo restores all');
});

await test('Comment replies and status survive save and reopen', async () => {
  const s = await fresh();
  const p = s.pages[0];
  localStorage.setItem('pdfy.settings', JSON.stringify({ author: 'Abd Test', reopenAtLastPage: true }));
  s.addAnnots(p, [{ id: 'c1', kind: 'note', rect: [300, 600, 320, 620], color: '#ffe066', fill: '#ffe066', opacity: 1, width: 0.75, contents: 'Please check', author: 'First Person' }]);
  app.panels.show('comments');
  await wait(300);
  const reply = document.querySelector('.reply-input');
  reply.focus();
  await type('Checked, looks fine');
  await key('Enter', 'Enter', 13);
  await wait(250);
  eq(p.annots[0].replies?.length, 1, 'reply added');
  eq(p.annots[0].replies[0].author, 'Abd Test', 'uses my name from settings');
  ok(document.querySelector('.reply')?.textContent.includes('Checked'), 'shown in the thread');
  const status = document.querySelector('.status-select');
  status.value = 'accepted';
  status.dispatchEvent(new Event('change'));
  await wait(150);
  eq(p.annots[0].status, 'accepted');
  const { blob, warnings } = await A.buildFile(s);
  eq(warnings.length, 0, warnings.join(';'));
  // Read back as a fresh document: one comment, with its thread attached.
  await closeAll();
  const s2 = await app.openPdfBlob(new File([blob], 'thread.pdf'), 'thread.pdf');
  await settle();
  await wait(400);
  const notes = s2.pages[0].annots.filter(a => a.kind === 'note');
  eq(notes.length, 1, 'still one comment, not three');
  eq(notes[0].contents, 'Please check');
  eq(notes[0].replies?.[0]?.text, 'Checked, looks fine', 'reply read back');
  eq(notes[0].status, 'accepted', 'status read back');
  eq(notes[0].ghost, true);
  // Deleting the comment takes its thread with it.
  s2.removeAnnot(s2.pages[0], notes[0]);
  const again = await A.buildFile(s2);
  const o = await A.openPdf(again.blob);
  eq((await (await o.pdf.getPage(1)).getAnnotations()).filter(a => a.subtype === 'Text').length, 0, 'thread gone');
  await o.close();
  localStorage.removeItem('pdfy.settings');
  app.panels.show('thumbs');
});

await test('Settings and reopening at the last page', async () => {
  await closeAll();
  void app.settingsDialog('general');
  await wait(80);
  const name = document.querySelector('.settings .st-input');
  name.value = 'Someone New';
  name.dispatchEvent(new Event('change'));
  document.querySelector('.overlay-bg .primary').click();
  await wait(30);
  eq(app.authorName(), 'Someone New', 'name saved');
  const s = app.newDocument();
  await settle();
  app.tools.setTool('rect');
  const pg = s.pages[0];
  await drag(...screen(pg, 100, 400), ...screen(pg, 200, 300));
  eq(pg.annots[0].author, 'Someone New', 'used on new markups');
  localStorage.removeItem('pdfy.settings');
  s.dirty = false;
});

await test('Keyboard: new, next document, close', async () => {
  await closeAll();
  // Ctrl+N opens Create document, as in Xodo. Enter makes a blank page straight away.
  await key('n', 'KeyN', 78, 2);
  await until(() => document.querySelector('.create-doc .cd-title') === document.activeElement, 3000, 'Create document');
  await key('Enter', 'Enter', 13);
  await until(() => app.sessions.length === 1, 4000, 'Ctrl+N then Enter');
  await key('n', 'KeyN', 78, 2);
  await until(() => document.querySelector('.create-doc .cd-title') === document.activeElement, 3000, 'Create document');
  await key('Enter', 'Enter', 13);
  await until(() => app.sessions.length === 2, 4000, 'a second document');
  const second = app.session;
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 2 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 2 });
  await wait(60);
  ok(app.session !== second, 'Ctrl+Tab switches');
  app.sessions.forEach(x => { x.dirty = false; });
  await key('w', 'KeyW', 87, 2);
  await wait(120);
  eq(app.sessions.length, 1, 'Ctrl+W closes');
});

await test('Stress: paste a huge picture and many pictures', async () => {
  await closeAll();
  const big = new OffscreenCanvas(9000, 6000);
  const x = big.getContext('2d');
  x.fillStyle = '#131314'; x.fillRect(0, 0, 9000, 6000);
  x.fillStyle = '#e3e3e3'; x.font = '200px Arial'; x.fillText('Huge screenshot', 300, 800);
  await window.paste(await big.convertToBlob({ type: 'image/png' }));
  for (let i = 0; i < 100 && !app.session; i++) await wait(100);
  const s = app.session;
  ok(s, 'document made');
  const a = s.pages[0].annots[0];
  ok(a, 'placed');
  ok(a.image.width <= 6000, `scaled to a safe size: ${a.image.width}`);
  await A.applyTheme(s, s.pages[0], a, { mode: 'light', style: 'gemini', keepPhotos: true });
  eq(s.pages[0].annots[0].image.theme, 'light', 'huge picture converts');
  await closeAll();
  const small = await window.mockGemini();
  for (let i = 0; i < 40; i++) await window.paste(small);
  for (let i = 0; i < 100 && (app.session?.pages.reduce((n, p) => n + p.annots.length, 0) ?? 0) < 40; i++) await wait(150);
  const total = app.session.pages.reduce((n, p) => n + p.annots.length, 0);
  eq(total, 40, '40 pictures placed');
  await settle();
  const heap = Math.round(performance.memory.usedJSHeapSize / 1048576);
  ok(app.viewer.views.size <= 6, `only pages near the screen are live: ${app.viewer.views.size}`);
  const { blob } = await A.buildFile(app.session);
  const o = await A.openPdf(blob);
  eq(o.pdf.numPages, app.session.pages.length, 'saved');
  await o.close();
  return `${total} images on ${app.session.pages.length} pages, ${(blob.size / 1048576).toFixed(1)} MB, interface memory ${heap} MB`;
});

await test('Garbage on the clipboard is ignored', async () => {
  await closeAll();
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array(4000)], 'fake.png', { type: 'image/png' }));
  document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  let told = false;
  for (let i = 0; i < 30 && !told; i++) { await wait(100); told = [...document.querySelectorAll('.toast')].some(t => t.textContent.includes('could not be read')); }
  ok(document.getElementById('app').children.length > 0, 'still running');
  ok(told, 'tells the user');
  eq(app.sessions.length, 0, 'no empty document left behind');
});

await closeAll();
document.querySelectorAll('.toast').forEach(t => t.remove());
export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, failures: results.filter(r => !r.ok) };
