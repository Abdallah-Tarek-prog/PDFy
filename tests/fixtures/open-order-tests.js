const app = window.__pdfy, api = window.__api, results = [];
const blob = await (await fetch('/fixtures/normal.pdf')).blob();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (value, message) => { if (!value) throw new Error(message); };
const names = () => app.sessions.map(s => s.name).join(',');
const expected = 'alpha.pdf,Part 2.pdf,Part 10.pdf,Zebra.pdf';
const inputNames = ['Zebra.pdf', 'Part 10.pdf', 'alpha.pdf', 'Part 2.pdf'];
const close = async () => { for (const s of [...app.sessions]) { s.dirty = false; await app.closeSession(s); } };
const root = await navigator.storage.getDirectory(), folderName = 'opening-order-' + Date.now();
const folder = await root.getDirectoryHandle(folderName, { create: true }), handles = [];
for (const name of inputNames) {
  const handle = await folder.getFileHandle(name, { create: true }), writer = await handle.createWritable();
  await writer.write(blob); await writer.close(); handles.push(handle);
}
async function test(name, run) {
  console.log('TEST', name);
  try { await close(); await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: String(error.message ?? error) }); }
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, heapMB: 0, results }) });
}
try {
  await test('Separate PDF opens always insert in natural A–Z order without losing edits or positions', async () => {
    const first = await app.openPdfBlob(blob, inputNames[0]);
    first.addAnnots(first.pages[0], [{ id: 'kept-order-edit', kind: 'rect', rect: [10,10,60,60], color: '#123456', width: 1, opacity: 1 }]);
    app.viewer.setScale(1.6); app.viewer.goTo(4, 110); await wait(100);
    const top = app.viewer.scroller.scrollTop;
    for (const name of inputNames.slice(1)) await app.openPdfBlob(blob, name);
    check(names() === expected, names());
    app.activate(first); await wait(100);
    check(Math.abs(app.viewer.scroller.scrollTop - top) < 2 && first.dirty, 'Opening changed existing position or edits');
  });
  await test('Native/browser multi-file picker opens files A–Z', async () => {
    const original = window.showOpenFilePicker;
    try { window.showOpenFilePicker = async () => [...handles]; await app.openDialog(); }
    finally { window.showOpenFilePicker = original; }
    check(names() === expected, names());
  });
  await test('Fallback file input opens files A–Z', async () => {
    const picker = window.showOpenFilePicker, click = HTMLInputElement.prototype.click;
    const files = await Promise.all(handles.map(h => h.getFile()));
    try {
      window.showOpenFilePicker = undefined;
      HTMLInputElement.prototype.click = function() {
        if (this.type !== 'file') return click.call(this);
        Object.defineProperty(this, 'files', { value: files }); this.dispatchEvent(new Event('change'));
      };
      await app.openDialog();
    } finally { window.showOpenFilePicker = picker; HTMLInputElement.prototype.click = click; }
    check(names() === expected, names());
  });
  await test('Drag-and-drop files open A–Z', async () => {
    const dataTransfer = new DataTransfer();
    for (const handle of handles) dataTransfer.items.add(await handle.getFile());
    await app.onDrop(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
    check(names() === expected, names());
  });
  await test('Single recent-file/Explorer handles stay alphabetized across separate opens', async () => {
    for (const handle of handles) await app.openHandle(handle);
    check(names() === expected, names());
    const original = app.sessions[0]; await app.openHandle(handles[2]);
    check(names() === expected && app.sessions[0] === original && app.sessions.length === 4, 'Reopening duplicated or moved an existing tab');
  });
  await test('Collection batches ignore saved drag order and keep their group alphabetized', async () => {
    const collection = await api.createCollection('Alphabetical opening');
    try {
      for (const handle of handles) await api.addToCollection(collection.id, handle.name, handle);
      await app.collectionsChanged();
      await app.openLibraryFiles((await api.listItems(collection.id)).map(item => ({ ...item, order: item.order ?? item.added })));
      check(names() === expected, names());
      check(app.sessions.every(s => s.collectionId === collection.id), 'Collection group was lost');
    } finally { await close(); await api.deleteCollection(collection.id); await app.collectionsChanged(); }
  });
  await test('Recently closed batches open A–Z and retain each saved page', async () => {
    await api.clearClosed();
    for (const [i, handle] of handles.entries()) await api.addClosed(handle.name, handle, i + 1, 10, i);
    const entries = await api.listClosed();
    await app.openLibraryFiles(entries.map(entry => ({ ...entry, order: entry.order ?? entry.closedAt, closed: entry })));
    check(names() === expected, names());
    check(app.session.name === 'Zebra.pdf' && app.viewer.current === 1, 'Reopening lost the alphabetical last file or its page');
  });
  await test('Recovered and newly created documents use the same ordering', async () => {
    const source = new api.Session('Recovery source');
    for (const name of ['Zebra recovered.pdf', 'Alpha recovered.pdf'])
      await app.recover({ id: name, name, handle: null, sources: [], pages: [source.blankPage(595,842)], bookmarks: [] });
    app.newDocument();
    check(names() === 'Alpha recovered.pdf,Untitled.pdf,Zebra recovered.pdf', names());
    check(app.sessions.filter(s => s.dirty).length === 2, 'Recovery edits were lost');
  });
  await test('The titlebar light/dark shortcut is removed and opening documents preserves the chosen theme', async () => {
    api.applyUiTheme('sage'); const chosen = document.documentElement.dataset.uiTheme;
    for (const name of inputNames) await app.openPdfBlob(blob, name);
    check(!document.querySelector('[aria-label="Switch light or dark"]'), 'The appearance shortcut remains');
    check(document.documentElement.dataset.uiTheme === chosen, 'Opening documents changed the selected interface');
    await window.__shot('alphabetical-tabs-no-theme-switch');
  });
} finally { await close(); await root.removeEntry(folderName, { recursive: true }); }
export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
