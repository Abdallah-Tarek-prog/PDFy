const app = window.__pdfy, api = window.__api, results = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (value, message) => { if (!value) throw new Error(message); };
const blob = await (await fetch('/fixtures/normal.pdf')).blob();
const storage = await navigator.storage.getDirectory(), folderName = 'split-view-' + Date.now();
const folder = await storage.getDirectoryHandle(folderName, { create: true });
const closeAll = async () => { for (const s of [...app.sessions]) { s.dirty = false; await app.closeSession(s); } };
const tab = s => document.querySelector(`[data-session-id="${s.id}"]`);
const names = side => [...document.querySelectorAll(`.pane-tabbar[data-pane="${side}"] .doc-tab .name`)].map(t => t.textContent).join(',');
const panes = () => app.panes;
async function test(name, run) {
  console.log('TEST', name);
  try { await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: String(error.message ?? error) }); }
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, heapMB: 0, results }) });
}
await closeAll();
const sessions = [];
for (const name of ['Delta.pdf', 'Charlie.pdf', 'Bravo.pdf', 'Alpha.pdf']) sessions.push(await app.openPdfBlob(blob, name));
const [d,c,b,a] = sessions;
try {
  await test('Side by side creates two aligned tab bars and displays two different PDFs', async () => {
    app.activate(a); app.viewer.setScale(1.35); app.viewer.goTo(2,120); await wait(150);
    document.querySelector('[aria-label="Side by side"]').click(); await wait(180);
    check(app.splitView && panes().length === 2, 'Split view did not start');
    check(panes()[0].viewer.session === a && panes()[1].viewer.session === b, 'The original document or beside document is incorrect');
    check(names(0) === 'Alpha.pdf,Charlie.pdf,Delta.pdf' && names(1) === 'Bravo.pdf', 'Tabs were duplicated or assigned incorrectly');
    check(document.querySelectorAll('.doc-tab').length === 4, 'Tabs were duplicated');
    await window.__shot('split-view-two-documents');
  });
  let rightTop;
  await test('Each half keeps its own page and zoom, and shared controls follow the clicked pane', async () => {
    tab(b).click(); app.viewer.setScale(1.75); app.viewer.goTo(6,130); await wait(150); rightTop = app.viewer.scroller.scrollTop;
    tab(a).click(); await wait(90);
    check(app.viewer === panes()[0].viewer && app.viewer.current === 2 && app.viewer.scale === 1.35, 'Left reading state changed');
    const zoom = document.querySelector('input[aria-label="Zoom"]'); zoom.value = '155'; zoom.dispatchEvent(new Event('change'));
    check(panes()[0].viewer.scale === 1.55 && panes()[1].viewer.scale === 1.75, `Zoom affected the other pane: left=${panes()[0].viewer.scale}, right=${panes()[1].viewer.scale}, active=${app.activePane}`);
    panes()[1].el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    check(app.session === b && app.viewer.current === 6 && document.querySelector('[aria-label="Page number"]').value === '7', 'Clicking the right view did not select it');
    check(Math.abs(app.viewer.scroller.scrollTop - rightTop) < 2, 'Changing focus changed the right reading position');
  });
  let added;
  await test('Opening a document in the right half leaves the selected left PDF in place', async () => {
    added = await app.openPdfBlob(blob, 'Beta notes.pdf');
    check(panes()[0].viewer.session === a && panes()[1].viewer.session === added, 'Opening replaced the other view');
    check(names(1) === 'Beta notes.pdf,Bravo.pdf', 'New right tabs are not alphabetical');
    app.runShortcut('next-tab'); check(app.session === b, 'Ctrl+Tab left the right tab bar');
    app.runShortcut('next-tab'); check(app.session === added, 'Right tabs did not cycle independently');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', code: 'Digit1', ctrlKey: true, bubbles: true, cancelable: true }));
    check(app.session === added, 'Ctrl+1 selected a tab from the other half');
  });
  await test('Dragging between tab bars moves the same session, edits and reading position', async () => {
    tab(c).click(); app.viewer.setScale(1.5); app.viewer.goTo(4,90); await wait(100);
    c.addAnnots(c.pages[0], [{ id: 'split-kept', kind: 'rect', rect: [10,10,60,60], color: '#123456', width: 1, opacity: 1 }]);
    const top = app.viewer.scroller.scrollTop, from = tab(c), to = panes()[1].tabs, box = to.getBoundingClientRect(), dataTransfer = new DataTransfer();
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
    to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientX: box.right - 2 }));
    to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX: box.right - 2 })); await wait(120);
    check(app.session === c && panes()[1].viewer.session === c && !names(0).includes('Charlie'), 'Drag did not move the document to the other half');
    check(app.sessions.filter(s => s === c).length === 1 && c.dirty && c.pages[0].annots.some(n => n.id === 'split-kept'), 'Moving duplicated the document or lost edits');
    check(app.viewer.scale === 1.5 && Math.abs(app.viewer.scroller.scrollTop - top) < 2, 'Moving lost the reading state');
  });
  await test('Drawing in the right view changes only its document', async () => {
    const before = c.pages.reduce((sum,p) => sum + p.annots.length,0), leftBefore = a.pages.reduce((sum,p) => sum + p.annots.length,0);
    app.setMode('edit'); app.tools.setTool('rect'); app.viewer.goTo(0); await wait(140);
    const view = [...app.viewer.views.values()].find(v => v.page === c.pages[0]);
    check(view, 'Right page is not mounted');
    const page = view.el.getBoundingClientRect(), viewport = app.viewer.scroller.getBoundingClientRect();
    const x = Math.max(page.left, viewport.left) + 70, y = Math.max(page.top, viewport.top) + 90;
    await window.__cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await window.__cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x+90, y: y+60, button: 'left', buttons: 1 });
    await window.__cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x+90, y: y+60, button: 'left', buttons: 0, clickCount: 1 }); await wait(100);
    check(c.pages.reduce((sum,p) => sum+p.annots.length,0) === before + 1, 'Right drawing did not reach its session');
    check(a.pages.reduce((sum,p) => sum+p.annots.length,0) === leftBefore, 'Drawing changed the left document');
    await window.__shot('split-view-right-edit');
  });
  await test('Text selection in the right pane has the same selection toolbar', async () => {
    app.tools.useReadingTool(); app.viewer.select(null);
    const view = [...app.viewer.views.values()].find(v => v.page === c.pages[0]);
    for (let i=0;i<80 && !view.textHost.querySelector('span');i++) await wait(25);
    const node = [...view.textHost.querySelectorAll('span')].map(s => s.firstChild).find(n => n?.textContent.length > 5);
    check(node, 'Right text layer is missing');
    const range = document.createRange(); range.setStart(node,0); range.setEnd(node,5);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    app.viewer.scroller.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); await wait(80);
    check(!app.selBar.hidden && app.activePane === 1, 'Selection actions are not wired to the right pane');
    selection.removeAllRanges();
  });
  await test('Canceling an unsaved close keeps both views and closing a clean inactive tab keeps focus', async () => {
    const pending = app.closeSession(c); await wait(100);
    [...document.querySelectorAll('.dialog-foot button')].find(b => b.textContent === 'Cancel').click(); await pending;
    check(app.session === c && panes()[1].viewer.session === c && panes()[0].viewer.session === a && c.dirty, 'Cancel lost a document, active pane or edits');
    await app.closeSession(d);
    check(app.session === c && panes()[0].viewer.session === a, 'Closing an inactive tab changed the active pane');
  });
  await test('Pending zoom edits finish in their original pane before focus moves', async () => {
    app.activate(a);
    const input = document.querySelector('input[aria-label="Zoom"]'); input.focus();
    for (const type of ['keyDown','keyUp']) await window.__cdp('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await window.__cdp('Input.insertText', { text: '160' });
    const previous = panes()[1].viewer.scale;
    panes()[1].el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    check(app.activePane === 1 && panes()[0].viewer.scale === 1.6 && panes()[1].viewer.scale === previous, 'A pending zoom edit affected the newly focused pane');
  });
  await test('A delayed file load remains assigned to the pane that opened it', async () => {
    app.activate(a);
    const original = api.Session.prototype.addSource; let release;
    const gate = new Promise(resolve => { release = resolve; });
    api.Session.prototype.addSource = async function(...args) { if (args[1] === 'Async left.pdf') await gate; return original.apply(this,args); };
    try {
      const pending = app.openPdfBlob(blob, 'Async left.pdf'); app.focusPane(1); const right = panes()[1].session;
      release(); const opened = await pending;
      check(panes()[0].session === opened && panes()[1].session === right && names(0).includes('Async left'), 'A delayed PDF moved into the other pane');
      await app.closeSession(opened); app.activate(c);
    } finally { release(); api.Session.prototype.addSource = original; }
  });
  await test('A library batch keeps opening into its original half when the other pane is clicked', async () => {
    app.focusPane(1); const entries = [];
    for (const [order,name] of ['Library Alpha.pdf','Library Zeta.pdf'].entries()) {
      const handle = await folder.getFileHandle(name,{create:true}), writer = await handle.createWritable(); await writer.write(blob); await writer.close();
      entries.push({ id:name, name, handle, order });
    }
    const original = app.openPdfBlob; let release, entered=false; const gate = new Promise(resolve => { release=resolve; });
    app.openPdfBlob = async function(...args) { if(args[1] === 'Library Zeta.pdf') { entered=true; await gate; } return original.apply(this,args); };
    try {
      const pending = app.openLibraryFiles(entries); for(let i=0;i<80&&!entered;i++) await wait(25); check(entered,'Library batch did not start');
      app.focusPane(0); release(); await pending;
      const opened = app.sessions.filter(s=>s.name.startsWith('Library '));
      check(opened.length===2 && opened.every(s=>app.paneOf.get(s)===1), 'The library batch was split across panes');
      for(const s of opened) await app.closeSession(s); app.activate(c);
    } finally { release(); app.openPdfBlob=original; }
  });
  await test('Saving the inactive visible pane waits for its edits and preserves the other document', async () => {
    const handle = await folder.getFileHandle('Alpha.pdf', { create: true }); const writer = await handle.createWritable(); await writer.write(blob); await writer.close(); a.handle = handle;
    a.addAnnots(a.pages[0], [{ id: 'save-left', kind: 'rect', rect: [15,15,70,70], color: '#123456', width: 1, opacity: 1 }]);
    app.activate(c);
    const tools = panes()[0].tools, original = tools.settle; let release, entered = false, finished = false;
    const gate = new Promise(resolve => { release = resolve; });
    tools.settle = async function() { entered = true; await gate; return original.call(this); };
    try {
      const saving = app.saveSession(a).then(result => { finished = true; return result; }); await wait(50);
      check(entered && !finished && a.dirty, 'Saving skipped pending edits in the inactive pane');
      release(); check(await saving, 'Left file could not be saved');
      check(!a.dirty && c.dirty && app.session === c && (await handle.getFile()).size !== blob.size, 'Saving changed the wrong document or active pane');
    } finally { release(); tools.settle = original; }
  });
  await test('Collections remain saved and render correctly when members occupy both panes', async () => {
    const handle = await folder.getFileHandle('Charlie.pdf', { create: true }); const writer = await handle.createWritable(); await writer.write(blob); await writer.close(); c.handle = handle;
    const group = await api.createCollection('Split collection');
    try {
      await api.addToCollection(group.id, a.name, a.handle); await api.addToCollection(group.id, c.name, c.handle); await app.collectionsChanged();
      const headers = [...document.querySelectorAll(`[data-collection-id="${group.id}"] .tab-group-count`)];
      check(headers.length === 2 && headers.every(h => h.textContent === '1'), 'Group counts include files from the other pane');
      app.moveSessionToPane(c,0); app.moveSessionToPane(c,1);
      check((await api.listItems(group.id)).length === 2 && c.collectionId === group.id && panes()[1].session === c, 'Moving panes changed saved collection membership');
    } finally { await api.deleteCollection(group.id); await app.collectionsChanged(); }
  });
  await test('Both halves and their controls fit narrow windows with and without a side panel', async () => {
    for (const width of [1400, 640]) {
      await window.__cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }); await wait(100);
      check(document.documentElement.scrollWidth <= innerWidth + 1, 'Split view overflows the window');
      for (const pane of panes()) {
        const header = pane.header.getBoundingClientRect(), body = pane.el.getBoundingClientRect();
        check(Math.abs(header.left - body.left) < 2 && Math.abs(header.width - body.width) < 2, 'Tab halves are not aligned to the views');
      }
      const active = app.viewer.scroller.parentElement.getBoundingClientRect();
      for (const control of document.querySelectorAll('.page-pill,.zoom-pill')) {
        const r = control.getBoundingClientRect(); check(r.left >= active.left && r.right <= active.right, 'Page or zoom controls escape their pane');
      }
      await window.__shot('split-view-' + width);
    }
    await window.__cdp('Emulation.clearDeviceMetricsOverride'); app.panels.show('thumbs'); await wait(100);
    check(Math.abs(panes()[0].header.getBoundingClientRect().left - panes()[0].el.getBoundingClientRect().left) < 2, 'Side panel misaligns tab and view');
    app.panels.show(null);
  });
  await test('Returning to one pane merges tabs alphabetically and preserves unsaved work and the active view', async () => {
    app.activate(c); app.viewer.setScale(1.4); app.viewer.goTo(3,85); await wait(120);
    const top = app.viewer.scroller.scrollTop;
    app.toggleSplitView(); await wait(150);
    check(!app.splitView && panes()[1].el.hidden && panes()[1].header.hidden, 'Second half remained visible');
    check(names(0) === 'Alpha.pdf,Beta notes.pdf,Bravo.pdf,Charlie.pdf', 'Tabs did not merge alphabetically');
    check(app.session === c && c.dirty && app.viewer.scale === 1.4 && Math.abs(app.viewer.scroller.scrollTop-top)<2, 'Merging lost edits, active PDF or reading position');
  });
  await test('An empty second pane opens files on the first click and can show Home independently', async () => {
    await closeAll(); const only = await app.openPdfBlob(blob, 'Single.pdf'); app.toggleSplitView();
    const picker = window.showOpenFilePicker; let calls = 0;
    try {
      window.showOpenFilePicker = async () => { calls++; return []; };
      const button = panes()[1].empty.querySelector('button'), box = button.getBoundingClientRect();
      for (const type of ['mousePressed','mouseReleased']) await window.__cdp('Input.dispatchMouseEvent', { type, x: box.left + box.width/2, y: box.top + box.height/2, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
      check(calls === 1 && app.activePane === 1, 'The first click only switched panes instead of opening files');
      panes()[1].header.querySelector('.tab-home').click();
      check(!app.startEl.hidden && app.startEl.parentElement === panes()[1].el && panes()[0].session === only, `Home replaced the other PDF: hidden=${app.startEl.hidden}, host=${app.startEl.parentElement.dataset.pane}, left=${panes()[0].session?.name}, active=${app.activePane}`);
      panes()[1].header.querySelector('.tab-home').click(); check(app.startEl.hidden && !panes()[1].empty.hidden, 'Closing Home did not restore the empty pane');
    } finally { window.showOpenFilePicker = picker; }
  });
  await test('Dropping a file into the inactive right pane opens it there', async () => {
    app.focusPane(0);
    const dataTransfer = new DataTransfer(); dataTransfer.items.add(new File([blob], 'Dropped right.pdf', { type: 'application/pdf' }));
    panes()[1].viewer.scroller.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
    for (let i=0;i<80 && !app.sessions.some(s => s.name === 'Dropped right.pdf');i++) await wait(25);
    check(panes()[1].session?.name === 'Dropped right.pdf' && panes()[0].session?.name === 'Single.pdf', 'The drop opened in the previously active pane');
  });
  await test('Close the others only closes tabs in that half', async () => {
    app.focusPane(0); const extra = await app.openPdfBlob(blob, 'Left extra.pdf'), element = tab(extra), box = element.getBoundingClientRect();
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left+10, clientY: box.bottom }));
    const action = [...document.querySelectorAll('.ctx-item')].find(item => item.textContent === 'Close the others'); check(action, 'Tab close action is missing'); action.click();
    for (let i=0;i<80 && app.sessions.some(s => s.name === 'Single.pdf');i++) await wait(25);
    check(app.sessions.includes(extra) && app.sessions.some(s => s.name === 'Dropped right.pdf') && !app.sessions.some(s => s.name === 'Single.pdf'), 'Closing other tabs crossed into the other pane');
  });
} finally { await closeAll(); if (app.splitView) app.toggleSplitView(); await storage.removeEntry(folderName, { recursive: true }); }
export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
