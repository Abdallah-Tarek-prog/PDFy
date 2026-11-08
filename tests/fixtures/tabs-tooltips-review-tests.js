const app = window.__pdfy;
const results = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (value, message) => { if (!value) throw new Error(message); };
const only = window.__only ? new RegExp(window.__only, 'i') : null;
const bytes = await (await fetch('/fixtures/normal.pdf')).blob();
const closeAll = async () => { for (const session of [...app.sessions]) { session.dirty = false; await app.closeSession(session); } };
const tab = session => [...document.querySelectorAll('.doc-tab')].find(t => t.dataset.sessionId === session.id);
const names = () => app.sessions.map(s => s.name).join(',');
async function openTabs() {
  await closeAll();
  const sessions = [];
  for (const name of ['A.pdf', 'B.pdf', 'C.pdf']) sessions.push(await app.openPdfBlob(bytes, name));
  app.setMode('view');
  await wait(150);
  return sessions;
}
function dragTab(source, target, after) {
  const from = tab(source), to = tab(target), box = to.getBoundingClientRect();
  const dataTransfer = new DataTransfer();
  from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
  const point = { clientX: after ? box.right - 3 : box.left + 3, clientY: box.top + box.height / 2 };
  to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, ...point }));
  check(to.classList.contains(after ? 'drop-after' : 'drop-before'), 'the drop location was not shown');
  to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, ...point }));
  from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
}
async function test(name, run) {
  if (only && !only.test(name)) return;
  console.log('TEST', name);
  try { await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: String(error.message ?? error) }); }
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), results }) });
}

await test('Tool instructions are hover titles, with no automatic hints or instructional messages', async () => {
  await openTabs();
  app.setMode('edit');
  document.querySelectorAll('.toast').forEach(t => t.remove());
  for (const tool of ['hand', 'eraser', 'polygon', 'polyline', 'markdown', 'crop', 'edit-text', 'field-text', 'pen']) {
    app.tools.setTool(tool);
    check(!document.querySelector('.status-pill.hint'), `${tool} showed an automatic hint`);
    check(![...document.querySelectorAll('.style-hint')].some(h => /click|drag|press|hold/i.test(h.textContent)), `${tool} showed instructions in its style controls`);
  }
  const eraser = app.row.commands().find(c => c.label === 'Eraser');
  check(eraser.title.includes('Drag over pen'), 'eraser instructions were lost from its hover title');
  const button = [...document.querySelectorAll('.tb-btn')].find(b => b.dataset.label === 'Eraser');
  check(button.title.includes(eraser.title), 'the toolbar button does not expose the instructions on hover');
  check(document.querySelector('.style-bar .swatches'), 'functional pen style controls were removed');
  app.tools.setTool('markdown');
  check(document.querySelector('.style-bar select'), 'functional Markdown theme controls were removed');
  app.study.toggleLookup(true);
  document.dispatchEvent(new Event('pdfy-form-found'));
  check(!document.querySelector('.toast.info'), 'tool selection or form detection showed an automatic tip');
  check(![...document.querySelectorAll('.toast')].some(t => /click|drag|press|hold/i.test(t.textContent)), 'selecting a tool showed instructional text');
  app.study.toggleLookup(false);
  app.tools.setTool('eraser');
  await window.__shot('tools-hover-only');
});

await test('Dragging tabs reorders both ways and preserves the active document and edits', async () => {
  const [a, b, c] = await openTabs();
  a.addAnnots(a.pages[0], [{ id: 'kept-edit', kind: 'rect', rect: [10, 10, 40, 40], color: '#123456', width: 1, opacity: 1 }]);
  app.viewer.setScale(1.7);
  const activePage = app.viewer.views.values().next().value?.page.id;
  dragTab(a, c, true);
  check(names() === 'B.pdf,C.pdf,A.pdf', `rightward move produced ${names()}`);
  dragTab(c, b, false);
  check(names() === 'C.pdf,B.pdf,A.pdf', `leftward move produced ${names()}`);
  check(app.session === c && app.viewer.scale === 1.7, 'dragging changed the active document or zoom');
  check(app.viewer.views.values().next().value?.page.id === activePage, 'dragging replaced the viewer');
  check(a.dirty && a.pages[0].annots.some(n => n.id === 'kept-edit'), 'dragging lost unsaved edits');
  const shown = [...document.querySelectorAll('.doc-tab .name')].map(n => n.textContent).join(',');
  check(shown === names(), 'the visual order differs from keyboard navigation order');
  check(!document.querySelector('.drop-before,.drop-after,.dragging'), 'drag feedback remained after dropping');
  // The empty part of the strip is also a drop target for moving a tab to the end.
  const from = tab(c), strip = from.parentElement, dataTransfer = new DataTransfer(), stripBox = strip.getBoundingClientRect();
  from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
  strip.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientX: stripBox.right - 2 }));
  strip.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX: stripBox.right - 2 }));
  from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
  check(names() === 'B.pdf,A.pdf,C.pdf' && app.session === c, 'dropping at the empty end of the strip did not reorder safely');
  await window.__shot('tabs-reordered');
});

await test('Cancelled drags and close buttons are safe; keyboard reorder updates navigation and closing', async () => {
  const [a, b, c] = await openTabs();
  const from = tab(a), target = tab(c), dataTransfer = new DataTransfer();
  const r = target.getBoundingClientRect();
  from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
  target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientX: r.right - 2 }));
  from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
  check(names() === 'A.pdf,B.pdf,C.pdf' && !document.querySelector('.drop-before,.drop-after,.dragging'), 'cancelling changed order or left feedback');
  const close = tab(a).querySelector('button');
  close.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 }));
  check(!tab(a).draggable && app.sessions.length === 3, 'the close button can start a tab drag');
  tab(b).focus();
  tab(b).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  check(names() === 'B.pdf,A.pdf,C.pdf' && document.activeElement === tab(b), 'keyboard reordering lost order or focus');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', code: 'Digit1', ctrlKey: true, bubbles: true, cancelable: true }));
  check(app.session === b, 'Ctrl+1 did not follow the reordered tabs');
  tab(b).querySelector('button').click();
  for (let i = 0; i < 80 && app.sessions.includes(b); i++) await wait(20);
  check(names() === 'A.pdf,C.pdf' && app.session === a, 'closing a moved tab used the old order');
});

await test('A real browser mouse drag reorders an open tab', async () => {
  const [a, , c] = await openTabs();
  const start = tab(a).querySelector('.name').getBoundingClientRect(), end = tab(c).getBoundingClientRect();
  const x0 = start.left + start.width / 2, y = start.top + start.height / 2, x1 = end.right - 4;
  const mouse = (type, x, buttons) => window.__cdp('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: 1 });
  await window.__cdp('Input.setInterceptDrags', { enabled: true });
  try {
    await mouse('mouseMoved', x0, 0);
    await mouse('mousePressed', x0, 1);
    for (let i = 1; i <= 10; i++) { await mouse('mouseMoved', x0 + (x1 - x0) * i / 10, 1); await wait(30); }
    check(tab(a).classList.contains('dragging'), 'the browser did not start dragging the tab');
    const data = { items: [{ mimeType: 'application/x-pdfy-tab', data: a.id }], dragOperationsMask: 16 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await window.__cdp('Input.dispatchDragEvent', { type, x: x1, y, data });
    await mouse('mouseReleased', x1, 0);
  } finally { await window.__cdp('Input.setInterceptDrags', { enabled: false }); }
  await wait(100);
  check(names() === 'B.pdf,C.pdf,A.pdf', `the mouse drag produced ${names()}`);
  check(app.session === c, 'dragging an inactive tab activated it');
});

await closeAll();
export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
