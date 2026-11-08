// Recovery and undo regressions found during the release review.
const app = window.__pdfy, A = window.__api;
const results = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const ok = (value, message) => { if (!value) throw new Error(message); };
const eq = (actual, expected, message) => { if (actual !== expected) throw new Error(`${message}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); };
const closeAll = async () => { for (const session of [...app.sessions]) { session.dirty = false; await app.closeSession(session); } };
const rectangle = id => ({ id, kind: 'rect', rect: [80, 400, 150, 450], color: '#112233', opacity: 1, width: 1 });
async function until(predicate, message) {
  for (let i = 0; i < 100; i++) { const value = await predicate(); if (value) return value; await wait(50); }
  throw new Error(`Timed out: ${message}`);
}
async function test(name, run) {
  console.log('TEST', name);
  try { await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: String(error?.message ?? error) }); }
  finally { await closeAll(); }
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), results }) });
}

await test('Undo and redo keep reordering independent of later additions', async () => {
  const session = new A.Session('Undo.pdf');
  const page = session.blankPage(); session.pages = [page];
  const first = rectangle('first'), second = rectangle('second'), third = rectangle('third');
  session.addAnnots(page, [first, second]); session.clearHistory();
  session.reorderAnnot(page, first, true);
  session.addAnnots(page, [third]);
  session.undo(); session.undo();
  eq(page.annots.map(a => a.id).join(','), 'first,second', 'Undo returns to the original order');
  session.redo();
  eq(page.annots.map(a => a.id).join(','), 'second,first', 'Reordering does not also redo an addition');
  session.redo();
  eq(page.annots.map(a => a.id).join(','), 'second,first,third', 'The added annotation returns exactly once');
  await session.close();
});

await test('Editing two documents within the debounce saves both recovery journals', async () => {
  await closeAll();
  const first = app.newDocument(); first.name = 'Journal first.pdf';
  first.addAnnots(first.pages[0], [rectangle('first-latest')]);
  const second = app.newDocument(); second.name = 'Journal second.pdf';
  second.addAnnots(second.pages[0], [rectangle('second-latest')]);
  await until(async () => {
    const journals = await A.listJournals();
    return journals.find(j => j.id === first.id)?.pages[0].annots.some(a => a.id === 'first-latest') &&
      journals.find(j => j.id === second.id)?.pages[0].annots.some(a => a.id === 'second-latest');
  }, 'both document journals');
});

await test('Recovered deleted and replaced imported annotations do not regain ghosts', async () => {
  await closeAll();
  const file = new File([await (await fetch('/fixtures/annotated.pdf')).blob()], 'Imported annotations.pdf', { type: 'application/pdf' });
  await app.openFile(file);
  const original = app.session, page = original.pages[0];
  await until(() => page.annots.filter(a => a.ghost).length >= 2, 'imported annotations');
  const [deleted, replaced] = page.annots.filter(a => a.ghost && a.kind !== 'attachment');
  ok(deleted && replaced, 'the fixture has two ordinary imported annotations');
  original.removeAnnot(page, deleted);
  const { ghost, ...edited } = replaced;
  original.replaceAnnot(page, replaced, { ...edited, color: '#008866' });
  await A.saveJournal(original);
  const journal = (await A.listJournals()).find(j => j.id === original.id);
  await app.recover(journal);
  const recovered = app.session, restoredPage = recovered.pages[0];
  await until(() => restoredPage.ghostsLoaded, 'recovered page annotations');
  await wait(200);
  ok(!restoredPage.annots.some(a => a.importedFrom === deleted.importedFrom), 'a deleted source annotation must stay absent');
  const replacements = restoredPage.annots.filter(a => a.importedFrom === replaced.importedFrom);
  eq(replacements.length, 1, 'an edited annotation must have exactly one representation');
  ok(!replacements[0].ghost, 'the editable recovered replacement must remain ours');
  eq(replacements[0].color, '#008866', 'the edit survives');
});

await test('Recovery retains OCR words, queued attachments and metadata without storing passwords', async () => {
  await closeAll();
  const original = app.newDocument(), page = original.pages[0];
  original.ocrWords.set(page.id, [{ x: 80, y: 680, w: 90, h: 14, text: 'RecoveryOCRword' }]);
  original.attachments.push({ name: 'recovered-notes.txt', blob: new Blob(['Notes survive a crash'], { type: 'text/plain' }) });
  original.pendingOptions = { metadata: { title: 'Recovered document title', author: 'Recovery test' }, encrypt: { userPassword: 'never-store-this-secret' } };
  original.markDirty();
  await A.saveJournal(original);
  const journal = (await A.listJournals()).find(j => j.id === original.id);
  ok(!JSON.stringify(journal).includes('never-store-this-secret'), 'passwords must not be persisted in recovery');
  await app.recover(journal);
  const recovered = app.session;
  eq(recovered.ocrWords.get(page.id)?.[0].text, 'RecoveryOCRword', 'OCR words return');
  eq(await recovered.attachments[0].blob.text(), 'Notes survive a crash', 'attachment bytes return');
  eq(recovered.pendingOptions.metadata.title, 'Recovered document title', 'pending metadata returns');
  const saved = await A.buildFile(recovered, recovered.pendingOptions);
  const reopened = await A.openPdf(saved.blob);
  try {
    eq((await reopened.pdf.getMetadata()).info.Title, 'Recovered document title', 'metadata is included in the saved file');
    const words = (await (await reopened.pdf.getPage(1)).getTextContent()).items.map(item => item.str).join(' ');
    ok(words.includes('RecoveryOCRword'), 'OCR words remain searchable after saving');
    const attachments = await reopened.pdf.getAttachments();
    const [id, attachment] = [...attachments.entries()][0];
    eq(attachment.filename, 'recovered-notes.txt', 'the queued attachment is saved');
    const bytes = await reopened.pdf.getAttachmentContent(id);
    eq(new TextDecoder().decode(bytes instanceof Uint8Array ? bytes : bytes.content), 'Notes survive a crash', 'saved attachment bytes match');
  } finally { await reopened.close(); }
});

await test('Older recovery journals still reopen without the optional new fields', async () => {
  await closeAll();
  const original = app.newDocument();
  original.addAnnots(original.pages[0], [rectangle('legacy-note')]);
  await A.saveJournal(original);
  const journal = (await A.listJournals()).find(j => j.id === original.id);
  delete journal.ocrWords; delete journal.attachments; delete journal.pendingOptions;
  await app.recover(journal);
  ok(app.session.pages[0].annots.some(a => a.id === 'legacy-note'), 'existing edits return');
  eq(app.session.attachments.length, 0, 'missing attachment metadata defaults to empty');
  eq(app.session.ocrWords.size, 0, 'missing OCR metadata defaults to empty');
});

const assetKeys = async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('pdfy-recovery', 1);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('assets').objectStore('assets').getAllKeys();
      request.onsuccess = () => resolve(new Set(request.result)); request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
};
const image = label => {
  const blob = new Blob([label], { type: 'image/png' });
  return { id: label, kind: 'image', rect: [10, 10, 30, 30], color: '#000000', opacity: 1, width: 0,
    image: { id: label, blob, original: blob, width: 1, height: 1, mime: 'image/png' } };
};

await test('Replacing recovery images prunes old blobs and permits reusing them', async () => {
  const session = new A.Session('Asset pruning.pdf');
  const page = session.blankPage(); session.pages = [page];
  const first = image('asset-first'), ownIds = [];
  const baseline = (await assetKeys()).size;
  try {
    for (let i = 0; i < 4; i++) {
      page.annots = [i === 0 ? first : image(`asset-replacement-${i}`)];
      await A.saveJournal(session);
      const journal = (await A.listJournals()).find(j => j.id === session.id);
      const current = journal.assetIds[0]; ownIds.push(current);
      const keys = await assetKeys();
      ok(keys.has(current), 'the current image stays recoverable');
      ok(ownIds.slice(0, -1).every(id => !keys.has(id)), 'superseded image blobs are removed immediately');
      ok(keys.size <= baseline + 1, 'repeated image replacement must not grow the asset store');
    }
    page.annots = [first];
    await A.saveJournal(session);
    eq(await (await A.loadAsset(ownIds[0])).text(), 'asset-first', 'Undoing to a pruned blob stores it again');
  } finally { await A.dropJournal(session.id); await session.close(); }
});

await test('Shared recovery blobs survive until the final journal drops, including overlapping writes', async () => {
  const first = new A.Session('Shared first.pdf'), second = new A.Session('Shared second.pdf');
  const shared = image('shared-asset');
  for (const session of [first, second]) { const page = session.blankPage(); page.annots = [shared]; session.pages = [page]; }
  try {
    await Promise.all([A.saveJournal(first), A.saveJournal(second)]);
    const journals = await A.listJournals();
    const id = journals.find(j => j.id === first.id).assetIds[0];
    eq(journals.find(j => j.id === second.id).assetIds[0], id, 'the two journals share one stored blob');
    await A.dropJournal(first.id);
    ok(await A.loadAsset(id), 'dropping one journal must preserve the shared image');
    await A.dropJournal(second.id);
    ok(!(await A.loadAsset(id)), 'dropping its final journal removes the image');
    await A.saveJournal(first);
    await Promise.all([A.dropJournal(first.id), A.saveJournal(second)]);
    eq(await (await A.loadAsset(id)).text(), 'shared-asset', 'an overlapping drop and save must not create a missing asset reference');
  } finally {
    await A.dropJournal(first.id); await A.dropJournal(second.id);
    await first.close(); await second.close();
  }
});

export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
