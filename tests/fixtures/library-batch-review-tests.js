const app = window.__pdfy, api = window.__api, results = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
const ok = (v, m) => { if (!v) throw new Error(m); };
async function until(fn) { for (let i = 0; i < 200; i++) { const v = await fn(); if (v) return v; await wait(30); } throw new Error('Timed out'); }
const normal = await (await fetch('/fixtures/normal.pdf')).blob(), form = await (await fetch('/fixtures/form.pdf')).blob();
const root = await navigator.storage.getDirectory(); let serial = 0;
async function closeAll() { await app.tools.settle(); for (const s of [...app.sessions]) { s.dirty = false; await app.closeSession(s); } }
async function reset() {
  await closeAll(); await api.clearClosed();
  for (const c of await api.listCollections()) await api.deleteCollection(c.id);
  document.querySelectorAll('.toast').forEach(t => t.remove());
}
async function files() {
  const directory = await root.getDirectoryHandle(`batch-${++serial}`, { create: true }), handles = [];
  for (const name of ['A.pdf','B.pdf','C.pdf']) {
    const h = await directory.getFileHandle(name, { create: true }), w = await h.createWritable(); await w.write(normal); await w.close(); handles.push(h);
  }
  return { directory, handles };
}
async function show(name) {
  if (app.session && !app.showingHome) app.toggleHome();
  await app.home.draw();
  if (document.querySelector('.home-head h2')?.textContent !== name) {
    const nav = [...document.querySelectorAll('.home-nav-item')].find(b => [...b.querySelectorAll('span')].some(s => s.textContent === name));
    ok(nav, `Missing ${name} navigation`); nav.click();
  }
  await until(() => document.querySelector('.home-head h2')?.textContent === name);
  await wait(40);
}
const rows = () => [...document.querySelectorAll('.home-list .home-row')];
const rowNames = () => rows().map(r => r.querySelector('.name').textContent).join(',');
const tabNames = () => app.sessions.map(s => s.name).join(',');
const checkbox = name => document.querySelector(`.home-select[aria-label="Select ${name}"]`);
async function opened() { await until(() => !app.home.opening); await wait(60); }
async function test(name, run) {
  console.log('TEST', name);
  try { await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: String(error.message ?? error) }); }
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, results }) });
}
async function addThroughDialog(session, collection) {
  const pending = app.addToCollection(session);
  const box = await until(() => document.querySelector(`.coll-pick input[data-id="${collection.id}"]`));
  if (!box.checked) box.click();
  [...document.querySelectorAll('.dialog-foot button')].find(b => b.textContent === 'Save').click(); await pending;
}

await test('Collections select some or all files and preserve the open-tab order, not addition order', async () => {
  await reset(); const { handles } = await files(), c = await api.createCollection('Batch collection');
  for (const h of handles) await app.openHandle(h); const sessions = [...app.sessions];
  for (const s of [sessions[2], sessions[0], sessions[1]]) await addThroughDialog(s, c);
  ok((await api.listItems(c.id)).map(i => i.name).join(',') === 'A.pdf,B.pdf,C.pdf', 'adding C,A,B did not retain original A,B,C tab order');
  await closeAll(); await api.clearClosed(); await show(c.name);
  ok(rowNames() === 'A.pdf,B.pdf,C.pdf' && document.querySelector('.home-open-selected').disabled, 'collection display order or empty selection is wrong');
  checkbox('B.pdf').click(); checkbox('A.pdf').click();
  ok(!app.sessions.length && document.querySelector('.home-select-all input').indeterminate, 'selecting files opened them or lost partial selection state');
  document.querySelector('.home-open-selected').click(); await opened();
  ok(tabNames() === 'A.pdf,B.pdf', `selected files opened as ${tabNames()}`);
  ok((await api.listItems(c.id)).map(i => i.name).join(',') === 'A.pdf,B.pdf,C.pdf', 'opening a subset changed saved collection order');
  await show(c.name); document.querySelector('.home-select-all input').click();
  ok(rows().every(r => r.querySelector('.home-select').checked), 'Select all missed files');
  document.querySelector('.home-open-all').click(); await opened();
  ok(tabNames() === 'A.pdf,B.pdf,C.pdf' && app.sessions.length === 3, 'Open all lost order or duplicated existing tabs');
});

await test('Shift/range and Ctrl+A selection work, and refresh keeps the selected IDs', async () => {
  await reset(); const { handles } = await files(), c = await api.createCollection('Selection controls');
  for (const h of handles) await api.addToCollection(c.id, h.name, h);
  await show(c.name); checkbox('A.pdf').click();
  const last = checkbox('C.pdf'), r = last.getBoundingClientRect();
  for (const type of ['mousePressed','mouseReleased']) await window.__cdp('Input.dispatchMouseEvent', { type, x: r.left + r.width / 2, y: r.top + r.height / 2, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, modifiers: 8, clickCount: 1 });
  ok(rows().every(r => r.querySelector('.home-select').checked), 'Shift-click did not select the range');
  await app.home.draw(); ok(rows().every(r => r.querySelector('.home-select').checked), 'refresh discarded the selection');
  document.querySelector('.home-select-all input').click(); checkbox('A.pdf').focus();
  for (const type of ['keyDown','keyUp']) await window.__cdp('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
  ok(rows().every(r => r.querySelector('.home-select').checked), 'Ctrl+A did not select the collection');
  await window.__shot('collection-batch-selection');
  await window.__cdp('Emulation.setDeviceMetricsOverride', { width: 560, height: 820, deviceScaleFactor: 1, mobile: false });
  try { await wait(100); const b = document.querySelector('.home-batch').getBoundingClientRect(); ok(b.left >= 0 && b.right <= innerWidth, 'batch controls overflow a small window'); await window.__shot('collection-batch-small'); }
  finally { await window.__cdp('Emulation.clearDeviceMetricsOverride', {}); }
});

await test('Recently closed Open all alphabetizes reordered tabs and restores the saved page', async () => {
  await reset(); const { handles } = await files();
  for (const h of handles) await app.openHandle(h);
  const [a,b,c] = [...app.sessions]; app.moveTab(c, 0); await app.orderWrites;
  for (const [s, page] of [[c,3],[a,1],[b,2]]) { app.activate(s); app.viewer.goTo(page); await app.closeSession(s); }
  const history = await api.listClosed();
  ok([...history].sort((a,b) => a.order - b.order).map(f => f.name).join(',') === 'C.pdf,A.pdf,B.pdf', 'close operations shifted the recorded tab positions');
  await show('Recently closed'); document.querySelector('.home-open-all').click(); await opened();
  ok(tabNames() === 'A.pdf,B.pdf,C.pdf' && app.viewer.current === 3, `history reopened in ${tabNames()} or lost the last file's page`);
  ok(!(await api.listClosed()).length, 'successfully reopened entries remained in history');
});

await test('Already-open tabs are reused, collection members stay together and other documents keep their edits', async () => {
  await reset(); const { handles } = await files(), c = await api.createCollection('Reuse existing tabs');
  for (const h of handles) await api.addToCollection(c.id, h.name, h);
  await app.openHandle(handles[2]); const existingC = app.session;
  const other = app.newDocument(); other.name = 'Other.pdf';
  other.addAnnots(other.pages[0], [{ id: 'outside-edit', kind: 'rect', rect: [10,10,60,60], color: '#123456', width: 1, opacity: 1 }]);
  await app.openHandle(handles[0]); const existingA = app.session;
  await show(c.name); const button = document.querySelector('.home-open-all');
  button.click(); button.click(); await opened();
  ok(tabNames() === 'A.pdf,B.pdf,C.pdf,Other.pdf', `unexpected tabs: ${tabNames()}`);
  ok(app.sessions[0] === existingA && app.sessions[2] === existingC && app.sessions[3] === other, 'existing files were duplicated or the other document was lost');
  ok(other.dirty && other.pages[0].annots.some(a => a.id === 'outside-edit'), 'grouping lost the other document’s unsaved edits');
});

await test('Recently closed opens only the selected entries alphabetically', async () => {
  await reset(); const { handles } = await files();
  for (const h of handles) await app.openHandle(h);
  const [a,b,c] = [...app.sessions]; app.moveTab(c, 0); await app.orderWrites;
  for (const s of [c,a,b]) await app.closeSession(s);
  await show('Recently closed'); checkbox('B.pdf').click(); checkbox('C.pdf').click();
  document.querySelector('.home-open-selected').click(); await opened();
  ok(tabNames() === 'B.pdf,C.pdf', `selected history opened as ${tabNames()}`);
  const remaining = await api.listClosed();
  ok(remaining.length === 1 && remaining[0].name === 'A.pdf', 'opening selected history consumed an unselected entry');
});

await test('A missing collection file does not stop other files and stays selected for retry', async () => {
  await reset(); const { directory, handles } = await files(), c = await api.createCollection('Partial failure');
  for (const h of handles) await api.addToCollection(c.id, h.name, h); await directory.removeEntry('B.pdf');
  await show(c.name); document.querySelector('.home-open-all').click(); await opened();
  ok(tabNames() === 'A.pdf,C.pdf' && (await api.listItems(c.id)).length === 3, 'one failed entry stopped the batch or was deleted');
  await show(c.name); ok(checkbox('B.pdf').checked && !checkbox('A.pdf').checked && !checkbox('C.pdf').checked, 'failed files did not retain selection');
});

await test('Closing a tab while the batch loads never resurrects it or drops another tab', async () => {
  await reset(); const { handles } = await files(), c = await api.createCollection('Close during opening');
  for (const h of handles) await api.addToCollection(c.id, h.name, h);
  const original = app.openPdfBlob; let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  app.openPdfBlob = async function(...args) { if (args[1] === 'B.pdf') { entered = true; await gate; } return original.apply(this, args); };
  try {
    await show(c.name); document.querySelector('.home-open-all').click(); await until(() => entered);
    const closed = app.sessions[0]; await app.closeSession(closed); release(); await opened();
    ok(tabNames() === 'B.pdf,C.pdf' && app.sessions.includes(app.session) && !app.sessions.includes(closed), `closing during load left broken tabs: ${tabNames()}`);
  } finally { release(); app.openPdfBlob = original; }
});

await test('All stored-handle permissions are requested before any PDF loads', async () => {
  await reset(); const { handles } = await files(), requested = [], original = app.openPdfBlob;
  for (const handle of handles) {
    handle.queryPermission = async () => 'prompt';
    handle.requestPermission = async () => { requested.push(handle.name); return 'granted'; };
  }
  app.openPdfBlob = async function(...args) { ok(requested.length === 3, 'PDF loading began before all file permissions were requested'); return original.apply(this, args); };
  try {
    const ids = await app.openLibraryFiles(handles.map((handle, order) => ({ id: handle.name, name: handle.name, handle, order })));
    ok(ids.length === 3 && tabNames() === 'A.pdf,B.pdf,C.pdf', 'permission preflight lost files or their order');
  } finally { app.openPdfBlob = original; }
});

await test('Recent keeps its single-open behavior and removes moved files without selection styling', async () => {
  await reset(); const { directory, handles } = await files(); await app.openHandle(handles[0]); await closeAll();
  await directory.removeEntry('A.pdf'); await show('Recent files');
  const recent = rows().find(r => r.querySelector('.name').textContent === 'A.pdf'); ok(recent, 'Recent row missing'); recent.click(); await opened();
  ok(!(await api.listRecent()).some(f => f.name === 'A.pdf') && !document.querySelector('.home-row.selected'), 'a moved Recent file was kept or left selected');
});

await test('Metadata-only closed files use one multi-file picker and cancel preserves all entries', async () => {
  await reset(); const { handles } = await files(); await api.addClosed('A.pdf', null, 1, 10, 1); await api.addClosed('B.pdf', null, 2, 10, 2);
  const picker = window.showOpenFilePicker; let calls = 0;
  try {
    window.showOpenFilePicker = async options => { calls++; ok(options.multiple, 'batch must use a multi-file picker'); throw new DOMException('Cancelled','AbortError'); };
    await show('Recently closed'); document.querySelector('.home-open-all').click(); await opened();
    ok(!app.sessions.length && (await api.listClosed()).length === 2 && rows().every(r => r.querySelector('.home-select').checked), 'cancellation discarded entries or selection');
    window.showOpenFilePicker = async options => { calls++; ok(options.multiple, 'batch picker lost multiple'); return [handles[1],handles[0],handles[2]]; };
    document.querySelector('.home-open-selected').click(); await opened();
    ok(calls === 2 && tabNames() === 'A.pdf,B.pdf' && !(await api.listClosed()).length, 'picker order changed tabs, opened an unselected extra, or prompted repeatedly');
  } finally { window.showOpenFilePicker = picker; }
});

await test('A chosen missing file never replaces another stored handle with the same name', async () => {
  await reset(); const first = await root.getDirectoryHandle(`same-first-${++serial}`, { create: true }), second = await root.getDirectoryHandle(`same-second-${serial}`, { create: true });
  const a = await first.getFileHandle('same.pdf', { create: true }), b = await second.getFileHandle('same.pdf', { create: true });
  for (const [h,blob] of [[a,normal],[b,form]]) { const w = await h.createWritable(); await w.write(blob); await w.close(); }
  await api.addClosed('same.pdf', a, 0, 10, 1); await api.addClosed('same.pdf', null, 0, 1, 2);
  const picker = window.showOpenFilePicker;
  try {
    window.showOpenFilePicker = async () => [b]; await show('Recently closed'); document.querySelector('.home-open-all').click(); await opened();
    const stored = app.sessions.find(s => s.pages.length > 1), chosen = app.sessions.find(s => s.pages.length === 1);
    ok(app.sessions.length === 2 && stored && chosen && await stored.handle.isSameEntry(a) && await chosen.handle.isSameEntry(b), 'same-name selection substituted the wrong PDF contents/handle');
  } finally { window.showOpenFilePicker = picker; }
});

await closeAll(); await api.clearClosed();
export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
