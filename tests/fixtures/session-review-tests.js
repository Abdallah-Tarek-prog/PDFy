// Files in different collections may have the same name; identity comes from their handles.
const app = window.__pdfy;
const results = [];
const ok = (value, message) => { if (!value) throw new Error(message); };
const closeAll = async () => { for (const s of [...app.sessions]) { s.dirty = false; await app.closeSession(s); } };
async function test(name, run) {
  console.log('TEST', name);
  try { await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: String(error?.message ?? error) }); }
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), results }) });
}

const root = await navigator.storage.getDirectory();
const folderName = `session-review-${Date.now()}`;
const folder = await root.getDirectoryHandle(folderName, { create: true });
try {
  await closeAll();
  const blob = await (await fetch('/fixtures/normal.pdf')).blob();
  const handles = [];
  for (const name of ['first', 'second']) {
    const dir = await folder.getDirectoryHandle(name, { create: true });
    const handle = await dir.getFileHandle('Lecture.pdf', { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    handles.push(handle);
  }
  await test('Different files with the same name open in separate tabs', async () => {
    const first = await app.openPdfBlob(blob, handles[0].name, handles[0]);
    const second = await app.openPdfBlob(blob, handles[1].name, handles[1]);
    ok(first !== second && app.sessions.length === 2, 'Both collection files must have their own tab');
    ok(app.session === second, 'The requested file must be active');
  });
  await test('Reopening an edited file reuses its tab and preserves unsaved work', async () => {
    const first = app.sessions[0];
    first.markDirty();
    const reopenedHandle = await (await folder.getDirectoryHandle('first')).getFileHandle('Lecture.pdf');
    const reopened = await app.openPdfBlob(blob, reopenedHandle.name, reopenedHandle);
    ok(reopened === first && app.sessions.length === 2, 'The existing edited tab must be reused');
    ok(first.dirty, 'Reopening must preserve the unsaved state');
  });
} finally {
  await closeAll();
  await root.removeEntry(folderName, { recursive: true });
}
export default { summary: { total: results.length, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
