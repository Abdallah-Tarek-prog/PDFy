// Normal page right-click insertion, including recorded audio from the test browser's fake device.
const app = window.__pdfy, api = window.__api, results = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
const ok = (v, m) => { if (!v) throw new Error(m); };
async function until(fn) { for (let i = 0; i < 200; i++) { const v = fn(); if (v) return v; await wait(30); } throw new Error('Timed out'); }
async function closeAll() { app.tools.cancel(); for (const s of [...app.sessions]) { s.dirty = false; await app.closeSession(s); } }
async function test(name, run) {
  console.log('TEST', name);
  try { await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: String(error.message ?? error) }); }
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, results }) });
}
async function blank() {
  await closeAll(); const s = app.newDocument(); app.setMode('view'); app.tools.setTool('hand'); app.viewer.setScale(1);
  const v = await until(() => app.viewer.views.get(s.pages[0].id)); await wait(100); return { s, p: s.pages[0], v };
}
async function menu(v, px = 150, py = 500) {
  window.getSelection()?.removeAllRanges(); const r = v.el.getBoundingClientRect(), m = v.vp.m;
  const x = r.left + m[0] * px + m[2] * py + m[4], y = r.top + m[1] * px + m[3] * py + m[5];
  for (const type of ['mousePressed', 'mouseReleased']) await window.__cdp('Input.dispatchMouseEvent', { type, x, y, button: 'right', buttons: type === 'mousePressed' ? 2 : 0, clickCount: 1 });
  await until(() => document.querySelector('.ctx-menu')); return { x, y };
}
function item(prefix) { const b = [...document.querySelectorAll('.ctx-menu button')].find(b => b.textContent.trim().startsWith(prefix)); ok(b, `Missing ${prefix}`); return b; }
const button = label => [...document.querySelectorAll('.overlay-bg button')].find(b => b.textContent.trim() === label);
function centre(a) { return [(a.rect[0] + a.rect[2]) / 2, (a.rect[1] + a.rect[3]) / 2]; }
const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 80; canvas.getContext('2d').fillRect(0, 0, 120, 80);
const image = new File([await new Promise(r => canvas.toBlob(r, 'image/png'))], 'menu-image.png', { type: 'image/png' });

await test('Normal right-click offers image, note and voice insertion; a note uses the clicked location', async () => {
  const { s, p, v } = await blank(); await menu(v);
  item('Insert image'); item('Insert note'); item('Insert voice note'); item('Rotate page right');
  await window.__shot('page-insert-menu'); item('Insert note').click();
  const editor = await until(() => document.querySelector('.inline-editor.comment')); editor.value = 'Note from the page menu';
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await app.tools.settle();
  const note = p.annots.find(a => a.kind === 'note');
  ok(note?.contents === 'Note from the page menu' && Math.abs(note.rect[0] - 150) < 1 && Math.abs(note.rect[3] - 500) < 1, 'the note was not kept at the right-click location');
  ok(app.tools.tool === 'hand' && s.canUndo, 'note insertion must return to Pan and remain undoable');
  s.undo(); ok(p.annots.length === 1 && !p.annots[0].contents, 'undo must restore the blank note');
  s.undo(); ok(!p.annots.length, 'note insertion must remain undoable');
});

await test('Insert image places a file at the clicked position', async () => {
  const { p, v } = await blank(); const at = await menu(v, 170, 480);
  const click = HTMLInputElement.prototype.click;
  try {
    HTMLInputElement.prototype.click = function () {
      if (this.type !== 'file') return click.call(this);
      const files = new DataTransfer(); files.items.add(image); this.files = files.files;
      setTimeout(() => this.dispatchEvent(new Event('change')), 0);
    };
    item('Insert image').click(); await until(() => p.annots.some(a => a.kind === 'image')); await wait(100);
    const r = v.annotsG.querySelector('.k-image').getBoundingClientRect();
    ok(Math.abs(r.left - at.x) < 2 && Math.abs(r.top - at.y) < 2, `the image was not placed where clicked: ${r.left},${r.top} vs ${at.x},${at.y}`);
  } finally { HTMLInputElement.prototype.click = click; }
});

await test('A delayed image picker retains its original document when another tab opens', async () => {
  const { s, p, v } = await blank(); await menu(v, 180, 450);
  const click = HTMLInputElement.prototype.click; let picker;
  try {
    HTMLInputElement.prototype.click = function () { if (this.type === 'file') picker = this; else click.call(this); };
    item('Insert image').click(); await until(() => picker);
    const other = app.newDocument(); const files = new DataTransfer(); files.items.add(image); picker.files = files.files; picker.dispatchEvent(new Event('change'));
    await until(() => p.annots.some(a => a.kind === 'image')); await wait(100);
    ok(app.session === other && !other.pages[0].annots.length && s.dirty, 'the delayed insertion modified or switched to the wrong document');
  } finally { HTMLInputElement.prototype.click = click; }
});

await test('A voice note records, previews and pins at the clicked position; cancellation inserts nothing', async () => {
  const { p, v } = await blank(); await menu(v, 210, 460); item('Insert voice note').click();
  await until(() => button('Stop')); await wait(650); button('Stop').click(); await until(() => button('Keep')); button('Keep').click();
  const note = await until(() => p.annots.find(a => a.attachment?.voice));
  ok(note.attachment.blob.size > 0 && Math.abs(centre(note)[0] - 210) < 1 && Math.abs(centre(note)[1] - 460) < 1 && app.tools.tool === 'hand', 'the recording was not pinned at the chosen location');
  const saved = await api.buildFile(app.session); const reopened = await api.openPdf(saved.blob);
  try { ok((await (await reopened.pdf.getPage(1)).getAnnotations()).some(a => a.subtype === 'FileAttachment'), 'the voice note was not saved into the PDF'); }
  finally { await reopened.close(); }
  await menu(v, 280, 420); item('Insert voice note').click(); await until(() => button('Cancel')); button('Cancel').click(); await wait(100);
  ok(p.annots.length === 1, 'cancelling recording inserted an extra note');
});

await closeAll();
export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
