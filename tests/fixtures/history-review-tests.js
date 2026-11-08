const app = window.__pdfy, api = window.__api;
const results = [];
const check = (value, message) => { if (!value) throw new Error(message); };
const closeAll = async () => { for (const session of [...app.sessions]) { session.dirty = false; await app.closeSession(session); } };
const bytes = await (await fetch('/fixtures/normal.pdf')).blob();
async function test(name, run) {
  console.log('TEST', name);
  try { await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: String(error.message ?? error) }); }
  finally { await closeAll(); }
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), results }) });
}

await test('A PDF opened as a File is recorded without copying it into history', async () => {
  await closeAll(); await api.clearClosed();
  await app.openFile(new File([bytes], 'dropped-history.pdf', { type: 'application/pdf' }));
  app.viewer.goTo(4);
  await app.closeSession(app.session);
  const [entry] = await api.listClosed();
  check(entry?.name === 'dropped-history.pdf' && entry.page === 4, 'the closed file and page were not recorded');
  check(entry.handle === null && !entry.blob, 'history must contain metadata, not a copy of the PDF');
  await app.home.draw();
  [...document.querySelectorAll('.home-nav-item')].find(b => b.textContent.includes('Recently closed')).click();
  for (let i = 0; i < 50 && !document.querySelector('.home-row .name'); i++) await new Promise(r => setTimeout(r, 20));
  check(document.querySelector('.home-row')?.textContent.includes('Choose file to reopen'), 'Home must explain how the file reopens');
});

await test('Cancelling or choosing the wrong file preserves a closed history entry', async () => {
  const picker = window.showOpenFilePicker;
  try {
    window.showOpenFilePicker = async () => { throw new DOMException('Cancelled', 'AbortError'); };
    await app.reopenClosed();
    check((await api.listClosed()).some(c => c.name === 'dropped-history.pdf'), 'cancel discarded the entry');
    window.showOpenFilePicker = async () => [{ name: 'wrong.pdf', getFile: async () => new File([bytes], 'wrong.pdf', { type: 'application/pdf' }) }];
    await app.reopenClosed();
    check(!app.session && (await api.listClosed()).some(c => c.name === 'dropped-history.pdf'), 'the wrong file consumed the entry');
  } finally { window.showOpenFilePicker = picker; }
});

await test('Choosing a closed file reopens it at its prior page, then consumes the entry', async () => {
  const directory = await navigator.storage.getDirectory();
  const handle = await directory.getFileHandle('dropped-history.pdf', { create: true });
  const writable = await handle.createWritable(); await writable.write(bytes); await writable.close();
  const picker = window.showOpenFilePicker;
  try {
    window.showOpenFilePicker = async () => [handle];
    await app.reopenClosed();
    check(app.session?.name === 'dropped-history.pdf' && app.viewer.current === 4, 'the file did not reopen at page five');
    check(!(await api.listClosed()).some(c => c.name === 'dropped-history.pdf'), 'a successfully reopened entry was not consumed');
    await app.closeSession(app.session);
    check((await api.listClosed()).some(c => c.name === 'dropped-history.pdf' && c.handle), 'closing a reopened file must record its handle');
  } finally { window.showOpenFilePicker = picker; await directory.removeEntry('dropped-history.pdf'); }
});

await test('A deleted file does not discard its history entry', async () => {
  const [before] = await api.listClosed();
  check(before?.handle, 'the test must start with a saved handle');
  await app.reopenClosed();
  check(!app.session, 'a missing file must not create a session');
  check((await api.listClosed()).some(c => c.id === before.id), 'an unsuccessful reopen discarded its history entry');
});

await test('Unsaved blank documents are not recorded as disk files', async () => {
  await api.clearClosed();
  const session = app.newDocument(); session.dirty = false;
  await app.closeSession(session);
  check((await api.listClosed()).length === 0, 'an unsaved blank document was recorded as a file');
});

await api.clearClosed();
export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
