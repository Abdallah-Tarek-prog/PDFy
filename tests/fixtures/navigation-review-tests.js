// Regression checks for the page editor, pen settings and Home keyboard actions.
const app = window.__pdfy, A = window.__api;
const results = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const ok = (value, message) => { if (!value) throw new Error(message); };
const until = async predicate => {
  for (let i = 0; i < 100; i++) { const value = predicate(); if (value) return value; await wait(30); }
  throw new Error('The expected screen did not appear');
};
const key = (target, code, keyValue, extra = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code, key: keyValue, ...extra }));
async function test(name, run) {
  console.log('TEST', name);
  const started = performance.now();
  try { await run(); results.push({ name, ok: true, ms: Math.round(performance.now() - started) }); }
  catch (err) { results.push({ name, ok: false, error: String(err.message ?? err) }); }
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), results }) });
}

await test('Page editor keeps page shortcuts after a toolbar action has focus', async () => {
  const file = new File([await (await fetch('/fixtures/structure.pdf')).blob()], 'structure.pdf', { type: 'application/pdf' });
  await app.openFile(file);
  const session = app.session;
  app.pageEditor.open();
  await until(() => document.querySelector('.pe-cell'));
  const button = [...document.querySelectorAll('.pe-btn')].find(b => b.textContent === 'Rotate right');
  button.focus();
  key(button, 'KeyA', 'a', { ctrlKey: true });
  ok(app.panels.thumbs.selected.size === session.pages.length, 'Ctrl+A must select pages when a toolbar button has focus');
  const original = app.deletePages;
  let deleted = false;
  try {
    app.deletePages = async () => { deleted = true; };
    key(button, 'Delete', 'Delete');
    ok(deleted, 'Delete must use the page editor selection');
  } finally { app.deletePages = original; app.pageEditor.close(); session.dirty = false; }
});

await test('Reset pen settings immediately updates the visible controls', async () => {
  const previous = localStorage.getItem('pdfy.settings');
  localStorage.setItem('pdfy.settings', JSON.stringify({ pen: { cursor: 'none', drawWith: 'pen', sideButton: 'pan', smoothing: 'strong', tailErases: false, autoInk: true } }));
  const opened = app.settingsDialog('pen');
  try {
    await until(() => document.querySelector('.settings'));
    [...document.querySelectorAll('.settings button')].find(b => b.textContent === 'Reset pen settings').click();
    ok(document.querySelector('[aria-label="What can draw"]').value === 'any', 'The drawing choice must show its reset value');
    ok(document.querySelector('[aria-label="Pen side button"]').value === 'eraser', 'The side button must show its reset value');
    ok(document.querySelector('[aria-label="Smoothing"]').value === 'light', 'Smoothing must show its reset value');
    ok(document.querySelector('[aria-label="Back of the pen erases"]').checked, 'The eraser switch must show its reset value');
    ok(!document.querySelector('[aria-label="Write straight away"]').checked, 'Auto-ink must show its reset value');
    ok([...document.querySelectorAll('.st-card')].some(b => b.textContent.includes('Dot') && b.getAttribute('aria-checked') === 'true'), 'The pointer card must show Dot');
  } finally {
    document.querySelector('.overlay-bg .dialog-foot .primary')?.click();
    await opened;
    if (previous === null) localStorage.removeItem('pdfy.settings'); else localStorage.setItem('pdfy.settings', previous);
    app.tools.syncCursor();
  }
});

await test('Home More keyboard actions do not open the file; the row accepts Enter and Space', async () => {
  const original = app.home.open;
  let opened = 0;
  app.home.open = async () => { opened++; };
  const row = app.home.row({ name: 'Keyboard test.pdf', handle: null, detail: '' }, []);
  document.body.append(row);
  try {
    key(row.querySelector('button'), 'Enter', 'Enter');
    await wait(0);
    ok(opened === 0, 'Enter on More must not activate the parent file row');
    key(row, 'Enter', 'Enter');
    key(row, 'Space', ' ');
    await wait(0);
    ok(opened === 2, 'Enter and Space on the row must each open the file');
  } finally { row.remove(); app.home.open = original; }
});

await test('Cancelling the first collection does not report that a file was added', async () => {
  for (const collection of await A.listCollections()) await A.deleteCollection(collection.id);
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const action = app.home.chooseCollectionFor({ name: 'Cancelled collection.pdf', handle: null });
  await until(() => document.querySelector('.dialog[aria-label="New collection"]'));
  [...document.querySelectorAll('.dialog-foot button')].find(b => b.textContent === 'Cancel').click();
  await action;
  ok(![...document.querySelectorAll('.toast')].some(t => t.textContent.includes('is in the new collection')), 'Cancel must not display a success message');
  ok((await A.listCollections()).length === 0, 'Cancel must leave no collection behind');
});

await test('Closing a file enforces history limits before Home is opened', async () => {
  await A.clearClosed();
  const directory = await navigator.storage.getDirectory();
  const handle = await directory.getFileHandle('closed-retention-test.pdf', { create: true });
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('pdfy-library', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const now = Date.now();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('closed', 'readwrite');
      for (let i = 0; i < 42; i++) transaction.objectStore('closed').put({ id: `retention-${i}`, name: `recent-${i}.pdf`, handle, closedAt: now - i * 1000, page: 0, pages: 1 });
      transaction.objectStore('closed').put({ id: 'expired', name: 'expired.pdf', handle, closedAt: now - 8 * 86400000, page: 0, pages: 1 });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    ok(await A.addClosed('just-closed.pdf', handle, 0, 1), 'Closing the file must be recorded');
    const stored = await new Promise((resolve, reject) => {
      const request = db.transaction('closed').objectStore('closed').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    ok(stored.length === 40, `Raw history must be bounded immediately; got ${stored.length}`);
    ok(!stored.some(item => item.id === 'expired'), 'Expired entries must be removed while closing a file');
    ok(stored.some(item => item.name === 'just-closed.pdf'), 'The newly closed file must remain');
  } finally { db.close(); await A.clearClosed(); await directory.removeEntry('closed-retention-test.pdf'); }
});

await test('Collection creation reports a storage failure instead of claiming success', async () => {
  const original = indexedDB.open;
  let rejected = false;
  try {
    indexedDB.open = () => { throw new Error('Storage is unavailable for this test'); };
    try { await A.createCollection('Must not claim success'); }
    catch (err) { rejected = /could not be saved/.test(err.message); }
  } finally { indexedDB.open = original; }
  ok(rejected, 'An unsaved collection must produce a save error');
  ok(!(await A.listCollections()).some(c => c.name === 'Must not claim success'), 'No unsaved collection must appear');
});

for (const session of [...app.sessions]) { session.dirty = false; await app.closeSession(session); }
export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
