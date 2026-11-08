const app = window.__pdfy, results = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
const ok = (v, m) => { if (!v) throw new Error(m); };
async function until(fn) { for (let i = 0; i < 150; i++) { const v = fn(); if (v) return v; await wait(30); } throw new Error('Timed out'); }
async function fresh() {
  app.tools.cancel();
  await app.tools.settle();
  for (const s of [...app.sessions]) { s.dirty = false; await app.closeSession(s); }
  const s = app.newDocument(); app.setMode('edit'); app.viewer.setScale(1);
  const v = await until(() => app.viewer.views.get(s.pages[0].id));
  return { s, p: s.pages[0], v };
}
const text = (id, rect = [60, 450, 310, 510]) => ({ id, kind: 'text', rect, text: 'Keep the box still', color: '#111111', textColor: '#111111', opacity: 1, width: 0, fontSize: 17 });
const sizeInput = () => [...document.querySelectorAll('.style-bar label')].find(l => l.firstChild?.textContent === 'Size')?.querySelector('input');
async function key(key, code, virtual) {
  for (const type of ['keyDown','keyUp']) await window.__cdp('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual });
  await wait(40);
}
async function test(name, run) {
  console.log('TEST', name);
  try { await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: String(error.message ?? error) }); }
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, results }) });
}

await test('Repeated size arrow keys keep the original input focused and never nudge the text box', async () => {
  const { s, p } = await fresh(), a = text('size-keys'); s.addAnnots(p, [a]); app.tools.setTool('hand'); app.viewer.select(p.id, a.id); app.onSelection();
  const input = sizeInput(); ok(input, 'Size input missing'); input.focus();
  for (let i = 0; i < 5; i++) await key('ArrowUp', 'ArrowUp', 38);
  ok(document.activeElement === input && input.isConnected, 'styling replaced the focused input');
  ok(p.annots[0].fontSize === 22, `expected 22, got ${p.annots[0].fontSize}`);
  await key('ArrowRight', 'ArrowRight', 39); await key('ArrowDown', 'ArrowDown', 40);
  ok(p.annots[0].fontSize === 21 && JSON.stringify(p.annots[0].rect) === JSON.stringify(a.rect), 'arrow keys moved the text box');
  app.viewer.scroller.focus(); await wait(30);
  ok(sizeInput()?.value === '21', 'the control did not refresh on blur');
});

await test('Clicking the size spinner repeatedly retains its native control', async () => {
  const { s, p } = await fresh(), a = text('size-mouse'); s.addAnnots(p, [a]); app.tools.setTool('hand'); app.viewer.select(p.id, a.id); app.onSelection();
  const input = sizeInput(); input.focus(); const r = input.getBoundingClientRect();
  for (let i = 0; i < 3; i++) {
    for (const type of ['mousePressed','mouseReleased']) await window.__cdp('Input.dispatchMouseEvent', { type, x: r.right - 8, y: r.top + 6, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
    await wait(40);
  }
  ok(input.isConnected && document.activeElement === input && p.annots[0].fontSize > 17, 'the spinner lost focus or stopped changing the size');
  ok(JSON.stringify(p.annots[0].rect) === JSON.stringify(a.rect), 'spinner clicks moved the text box');
});

await test('Tab and mouse focus move between style controls without rebuilding their targets', async () => {
  const { s, p } = await fresh(), a = text('style-focus'); s.addAnnots(p, [a]); app.tools.setTool('hand'); app.viewer.select(p.id, a.id); app.onSelection();
  const input = sizeInput(); input.focus(); await key('Tab', 'Tab', 9);
  ok(document.activeElement !== input && app.styleBar.contains(document.activeElement), 'Tab lost focus instead of reaching the next style control');
  const colour = app.styleBar.querySelector('button'); colour.focus();
  const r = input.getBoundingClientRect();
  for (const type of ['mousePressed','mouseReleased']) await window.__cdp('Input.dispatchMouseEvent', { type, x: r.right - 8, y: r.top + 6, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  ok(document.activeElement === input && input.isConnected && p.annots[0].fontSize > 17, 'moving focus from another control swallowed the spinner click');
});

await test('Markdown keeps its initial editing room and deleting text does not save an inflated box', async () => {
  const { s, p, v } = await fresh(), a = { ...text('markdown-room', [60,650,310,674]), text: 'Note', markdown: true };
  s.addAnnots(p, [a]); app.tools.openEditor(v, a, false);
  ok(document.querySelector('.inline-editor').getBoundingClientRect().height >= 120, 'Markdown lost its starting editing height');
  app.tools.commitEdit(); await app.tools.settle();
  const plain = { ...text('deleted-lines', [60,650,310,674]), text: 'Short' }; s.addAnnots(p, [plain]); app.tools.openEditor(v, plain, false);
  const editor = document.querySelector('.inline-editor'); editor.value = 'Long line\n'.repeat(10); editor.dispatchEvent(new Event('input'));
  editor.value = 'Short'; editor.dispatchEvent(new Event('input')); app.tools.commitEdit();
  const saved = p.annots.find(n => n.id === plain.id);
  ok(saved.rect[3] - saved.rect[1] < 60, 'deleted lines left an inflated saved box');
});

for (const markdown of [false, true]) await test(`Typing near the page border scrolls inside the ${markdown ? 'Markdown' : 'text'} editor, not the page`, async () => {
  const { s, p } = await fresh(); s.setPages([p, s.blankPage(595, 842)], 'Second page'); await wait(100);
  const v = await until(() => app.viewer.views.get(p.id));
  app.viewer.scroller.scrollTop = Math.max(0, v.el.offsetTop + v.vp.height - app.viewer.scroller.clientHeight + 32); await wait(60);
  const a = { ...text('border', [60, 5, 340, 95]), text: 'First line\nSecond line\nThird line', markdown, fontSize: 18 };
  s.addAnnots(p, [a]); app.tools.openEditor(v, a, false);
  const editor = document.querySelector('.inline-editor'); editor.setSelectionRange(editor.value.length, editor.value.length); await wait(80);
  const before = app.viewer.scroller.scrollTop, initial = editor.value;
  for (let i = 0; i < 14; i++) { await window.__cdp('Input.insertText', { text: ' more text' }); await wait(25); }
  ok(Math.abs(app.viewer.scroller.scrollTop - before) < 2, `page scrolled from ${before} to ${app.viewer.scroller.scrollTop}`);
  ok(editor.scrollTop > 0 && editor.value.length > initial.length, 'the editor should scroll its own text');
  await window.__shot(markdown ? 'border-typing-markdown' : 'border-typing-text');
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await app.tools.settle();
  ok(p.annots.find(n => n.id === a.id).text === initial + ' more text'.repeat(14), 'typing at the border lost content');
});

for (const s of [...app.sessions]) { s.dirty = false; await app.closeSession(s); }
export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
