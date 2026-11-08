const app = window.__pdfy, api = window.__api, results = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (value, message) => { if (!value) throw new Error(message); };
async function until(fn) { for (let i = 0; i < 160; i++) { if (await fn()) return; await wait(25); } throw new Error('Timed out'); }
const closeAll = async () => { for (const s of [...app.sessions]) { s.dirty = false; await app.closeSession(s); } };
const groupElement = id => document.querySelector(`.tab-group[data-collection-id="${id}"]`);
const header = id => groupElement(id)?.querySelector('.tab-group-toggle');
const tab = s => document.querySelector(`[data-session-id="${s.id}"]`);
const groupNames = id => [...groupElement(id).querySelectorAll('.doc-tab .name')].map(e => e.textContent).join(',');
const context = (el, label) => {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.bottom }));
  const item = [...document.querySelectorAll('.ctx-item')].find(e => e.textContent === label);
  check(item, `Missing menu action: ${label}`); item.click();
};
async function test(name, run) {
  console.log('TEST', name);
  try { await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: String(error.message ?? error) }); }
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, heapMB: 0, results }) });
}
await closeAll();
const root = await navigator.storage.getDirectory(), folderName = `tab-groups-${Date.now()}`;
const folder = await root.getDirectoryHandle(folderName, { create: true });
const blob = await (await fetch('/fixtures/normal.pdf')).blob();
const groups = [await api.createCollection('Algorithms', '#4f8cf7'), await api.createCollection('Digital Design', '#a371f7')];
const handles = [];
for (const name of ['Sorting.pdf', 'Logic.pdf', 'Graphs.pdf', 'Notes.pdf', 'Practice.pdf']) {
  const handle = await folder.getFileHandle(name, { create: true });
  const writer = await handle.createWritable(); await writer.write(blob); await writer.close(); handles.push(handle);
}
await api.addToCollection(groups[0].id, handles[0].name, handles[0]);
await api.addToCollection(groups[0].id, handles[2].name, handles[2]);
await api.addToCollection(groups[1].id, handles[1].name, handles[1]);
const sessions = [];
for (const handle of handles) sessions.push(await app.openPdfBlob(await handle.getFile(), handle.name, handle));
const [a, b, c, d] = sessions;
try {
  await test('Saved collections appear as colored contiguous browser-style tab groups', async () => {
    check(document.querySelectorAll('.tab-group').length === 2, 'Missing collection group headers');
    check(groupNames(groups[0].id) === 'Graphs.pdf,Sorting.pdf', 'Collection members are not alphabetized together');
    check(groupElement(groups[0].id).style.getPropertyValue('--group-colour') === '#4f8cf7', 'Collection color was not used');
    check(header(groups[0].id).textContent.includes('Algorithms') && header(groups[0].id).textContent.includes('2'), 'Header name or count is incorrect');
    check(!tab(d).closest('.tab-group'), 'An ungrouped document was grouped');
    await window.__shot('collection-groups-expanded');
  });
  await test('Collapsing and expanding a group preserves reading position, unsaved work and keyboard focus', async () => {
    app.activate(a); app.viewer.setLayout('continuous'); app.viewer.setScale(1.3); app.viewer.goTo(5, 137); await wait(350);
    a.addAnnots(a.pages[0], [{ id: 'group-kept', kind: 'rect', rect: [20,20,80,80], color: '#123456', width: 1, opacity: 1 }]);
    const top = app.viewer.scroller.scrollTop;
    header(groups[0].id).focus(); header(groups[0].id).click();
    check(header(groups[0].id).getAttribute('aria-expanded') === 'false', 'Group did not collapse');
    check(tab(a).getBoundingClientRect().width === 0 && tab(c).getBoundingClientRect().width === 0, 'Collapsed tabs are still visible');
    check(document.activeElement === header(groups[0].id), 'Collapse lost keyboard focus');
    check(app.session === a && Math.abs(app.viewer.scroller.scrollTop - top) < 2 && a.dirty, 'Collapsing changed the document, position or edits');
    await until(async () => (await api.listCollections()).find(g => g.id === groups[0].id)?.collapsed === true);
    await app.collectionsChanged();
    check(header(groups[0].id).getAttribute('aria-expanded') === 'false', 'Saved collapse state was lost on refresh');
    const digit = String(app.sessions.indexOf(a) + 1);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: digit, code: 'Digit' + digit, ctrlKey: true, bubbles: true, cancelable: true }));
    await wait(90);
    check(header(groups[0].id).getAttribute('aria-expanded') === 'true' && tab(a).getBoundingClientRect().width > 0, 'Keyboard activation did not reveal a collapsed active tab');
    check(Math.abs(app.viewer.scroller.scrollTop - top) < 2, 'Expanding changed the reading position');
    await window.__shot('collection-groups-active');
  });
  await test('Group context menu renames and recolors the same saved collection', async () => {
    context(header(groups[0].id), 'Rename or colour…');
    await until(() => document.querySelector('input[aria-label="Name"]'));
    document.querySelector('input[aria-label="Name"]').value = 'Algorithms revision';
    document.querySelector('.coll-colour[title="#3fb27f"]').click();
    [...document.querySelectorAll('.dialog-foot button')].find(e => e.textContent === 'Save').click();
    await until(() => header(groups[0].id)?.textContent.includes('Algorithms revision'));
    check(groupElement(groups[0].id).style.getPropertyValue('--group-colour') === '#3fb27f', 'Group color did not update');
    check((await api.listCollections()).some(g => g.id === groups[0].id && g.name === 'Algorithms revision' && g.colour === '#3fb27f'), 'Changes were not saved');
  });
  await test('Dragging a tab into a group and removing it updates saved membership without duplicating the tab', async () => {
    const from = tab(d), target = header(groups[0].id), r = target.getBoundingClientRect(), dataTransfer = new DataTransfer();
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientX: r.left + 12 }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX: r.left + 12 }));
    await until(() => d.collectionId === groups[0].id && tab(d)?.closest('.tab-group'));
    check(app.sessions.filter(s => s === d).length === 1, 'Moving duplicated the document');
    check((await api.listItems(groups[0].id)).some(item => item.name === d.name), 'Drop did not save collection membership');
    context(tab(d), 'Remove from group');
    await until(() => d.collectionId === null && !tab(d).closest('.tab-group'));
    check(!(await api.listItems(groups[0].id)).some(item => item.name === d.name), 'Removing did not update saved membership');
    check(app.sessions.includes(d), 'Removing from a group closed its document');
  });
  await test('Group controls fit the existing strip in light and dark themes and scroll on narrow windows', async () => {
    const originalTheme = document.documentElement.dataset.uiTheme;
    for (const theme of ['graphite', 'sage']) {
      api.applyUiTheme(theme); await wait(70);
      const strip = document.querySelector('.doc-tabs').getBoundingClientRect();
      for (const group of document.querySelectorAll('.tab-group')) {
        const box = group.getBoundingClientRect();
        check(box.top >= strip.top - 1 && box.bottom <= strip.bottom + 1, 'Group underline or header is clipped');
      }
      await window.__shot('collection-groups-' + theme);
    }
    await window.__cdp('Emulation.setDeviceMetricsOverride', { width: 640, height: 900, deviceScaleFactor: 1, mobile: false });
    await wait(100);
    check(document.documentElement.scrollWidth <= innerWidth + 1, 'Tab groups overflow the window');
    const strip = document.querySelector('.doc-tabs');
    check(strip.scrollWidth > strip.clientWidth, 'Long groups do not scroll within the strip');
    await window.__shot('collection-groups-narrow');
    await window.__cdp('Emulation.clearDeviceMetricsOverride');
    api.applyUiTheme(originalTheme); await wait(70);
  });
  await test('Close group keeps the collection saved and Open all recreates its tab group', async () => {
    context(header(groups[1].id), 'Close group');
    await until(() => !app.sessions.includes(b));
    check(!groupElement(groups[1].id), 'An empty open group remained');
    const saved = await api.listItems(groups[1].id);
    check(saved.length === 1 && saved[0].name === 'Logic.pdf', 'Close group deleted a saved file link');
    await app.openLibraryFiles(saved.map(item => ({ ...item, order: item.order ?? item.added })));
    check(groupNames(groups[1].id) === 'Logic.pdf', 'Reopening failed to restore the group');
  });
  await test('Canceling an unsaved close stops closing the rest of the group', async () => {
    c.addAnnots(c.pages[0], [{ id: 'first-group-unsaved', kind: 'rect', rect: [10,10,40,40], color: '#123456', width: 1, opacity: 1 }]);
    context(header(groups[0].id), 'Close group');
    await until(() => document.querySelector('.overlay-bg')?.textContent.includes('Save your changes'));
    [...document.querySelectorAll('.dialog-foot button')].find(e => e.textContent === 'Cancel').click();
    await wait(120);
    check(app.sessions.includes(a) && app.sessions.includes(c) && a.dirty && a.pages[0].annots.some(n => n.id === 'group-kept'), 'Cancel closed a grouped document or lost edits');
    await window.__shot('collection-groups-final');
  });
} finally {
  await closeAll();
  for (const group of groups) await api.deleteCollection(group.id);
  await root.removeEntry(folderName, { recursive: true });
}
export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
