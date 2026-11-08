const app = window.__pdfy, api = window.__api, results = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
const ok = (v, m) => { if (!v) throw new Error(m); };
async function until(fn) { for (let i = 0; i < 200; i++) { const v = await fn(); if (v) return v; await wait(30); } throw new Error('Timed out'); }
const normal = await (await fetch('/fixtures/normal.pdf')).blob(), form = await (await fetch('/fixtures/form.pdf')).blob();
const root = await navigator.storage.getDirectory(); let serial = 0;
async function reset() {
  app.tools.cancel(); await app.tools.settle();
  for (const s of [...app.sessions]) { s.dirty = false; await app.closeSession(s); }
  await api.clearClosed(); document.querySelectorAll('.toast').forEach(t => t.remove());
}
async function file(blob = normal) {
  const dir = await root.getDirectoryHandle(`reload-${++serial}`, { create: true });
  const handle = await dir.getFileHandle('Reload sample.pdf', { create: true }); await write(handle, blob); return { dir, handle };
}
async function write(handle, blob) { const w = await handle.createWritable(); await w.write(blob); await w.close(); }
async function loaded() {
  await until(() => [...app.viewer.views.values()].some(v => v.textHost?.querySelector('span')));
  await wait(100);
}
async function test(name, run) {
  console.log('TEST', name);
  try { await run(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String(e.message ?? e) }); }
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, results }) });
}
async function click(x,y) {
  for (const type of ['mousePressed','mouseReleased']) await __cdp('Input.dispatchMouseEvent', { type, x,y,button:'left',buttons:type === 'mousePressed' ? 1 : 0,clickCount:1 });
  await wait(60);
}
function selectWord() {
  const sc = app.viewer.scroller.getBoundingClientRect();
  for (const span of document.querySelectorAll('.textLayer span')) {
    const r = span.getBoundingClientRect();
    if (!span.firstChild || r.width < 5 || r.top < sc.top + 5 || r.bottom > sc.bottom - 20) continue;
    const range = document.createRange(); range.selectNodeContents(span);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); app.showSelBar();
    if (!app.selBar.hidden) return span.textContent;
  }
  throw new Error('No visible word to select: ' + JSON.stringify({ tool: app.tools.tool, sc: [sc.top,sc.bottom], spans: [...document.querySelectorAll('.textLayer span')].slice(0,3).map(s=>({text:s.textContent,box:[s.getBoundingClientRect().top,s.getBoundingClientRect().bottom],parent:s.parentElement.className})) }));
}
function tabAction(session, pattern) {
  app.tabMenu(new MouseEvent('contextmenu', { clientX: 120, clientY: 125 }), session);
  const button = [...document.querySelectorAll('.ctx-item')].find(b => pattern.test(b.textContent));
  ok(button && !button.disabled, `Missing enabled tab action ${pattern}`); return button;
}

await test('Clicking page whitespace and the document background clears native text and its floating toolbar', async () => {
  await reset(); const { handle } = await file(); await app.openHandle(handle); app.tools.setTool('hand'); await loaded();
  const v = [...app.viewer.views.values()][0], sc = app.viewer.scroller.getBoundingClientRect();
  for (const point of [[v.el.getBoundingClientRect().left + 12, sc.top + 80], [sc.left + 8, sc.top + 110]]) {
    selectWord(); ok(!getSelection().isCollapsed && !app.selBar.hidden, 'selection setup failed'); await click(...point);
    ok(getSelection().isCollapsed && app.selBar.hidden, 'blank-space click left native selection or its toolbar behind');
  }
});

await test('The selection toolbar still uses the selected text when clicked', async () => {
  await reset(); const { handle } = await file(); await app.openHandle(handle); app.tools.setTool('hand'); await loaded();
  selectWord(); const button = document.querySelector('.sel-bar button[aria-label="Highlight"]'), r = button.getBoundingClientRect();
  const before = app.session.pages.reduce((n,p) => n + p.annots.length, 0); await click(r.left+r.width/2,r.top+r.height/2);
  ok(app.session.pages.reduce((n,p) => n + p.annots.length, 0) > before, 'whitespace deselection swallowed the selection-toolbar action');
});

await test('Reload from disk replaces the same tab with fresh external changes and clamps its page', async () => {
  await reset(); const { handle } = await file(); await app.openHandle(handle); const old = app.session;
  app.viewer.goTo(3); app.viewer.setScale(1.3); await old.preserveSources(); await write(handle, form);
  tabAction(old, /reload.*disk/i).click(); await until(() => app.sessions.length === 1 && app.session !== old);
  ok(app.session.pages.length === 1 && app.viewer.current === 0 && Math.abs(app.viewer.scale-1.3) < .001, 'reload did not use new bytes or preserve view');
  ok(await app.session.handle.isSameEntry(handle) && !(await api.listClosed()).length, 'reload duplicated the file or recorded a spurious close');
  ok(!app.session.canUndo, 'reload retained undo commands for the old backing PDF');
  tabAction(app.session, /reload.*disk/i); await __shot('tab-reload-path-menu');
  await __cdp('Emulation.setDeviceMetricsOverride',{width:560,height:820,deviceScaleFactor:1,mobile:false});
  try { await wait(100); tabAction(app.session,/reload.*disk/i); const bounds=document.querySelector('.ctx-menu').getBoundingClientRect();ok(bounds.left>=0&&bounds.right<=innerWidth,'tab menu overflowed a small window');await __shot('tab-reload-path-small'); }
  finally { await __cdp('Emulation.clearDeviceMetricsOverride',{}); document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); }
});

await test('Reloading a dirty document can be canceled, then explicitly confirmed', async () => {
  await reset(); const { handle } = await file(); await app.openHandle(handle); const old = app.session, p = old.pages[0];
  old.addAnnots(p,[{id:'unsaved-reload',kind:'text',rect:[30,300,250,350],text:'Keep until confirmed',color:'#111111',fontSize:12,width:0,opacity:1}]);
  await old.preserveSources(); await write(handle,form); tabAction(old,/reload.*disk/i).click();
  await until(() => document.querySelector('.dialog')); [...document.querySelectorAll('.dialog-foot button')].find(b => b.textContent === 'Cancel').click(); await wait(100);
  ok(app.session === old && old.dirty && p.annots.some(a=>a.id==='unsaved-reload'), 'canceling reload lost edits');
  tabAction(old,/reload.*disk/i).click(); await until(() => document.querySelector('.dialog'));
  [...document.querySelectorAll('.dialog-foot button')].find(b => /reload/i.test(b.textContent)).click();
  await until(() => app.session !== old); ok(app.session.pages.length === 1 && app.sessions.length === 1, 'confirmed reload did not replace the dirty tab');
});

await test('A failed reload keeps the original document, edits and tab', async () => {
  await reset(); const { dir, handle } = await file(); await app.openHandle(handle); const old = app.session;
  await old.preserveSources(); await dir.removeEntry(handle.name); tabAction(old,/reload.*disk/i).click(); await wait(300);
  const dialog = document.querySelector('.dialog'); if(dialog) [...dialog.querySelectorAll('.dialog-foot button')].find(b => /OK|Cancel/.test(b.textContent))?.click();
  ok(app.sessions.length === 1 && app.session === old && old.pages.length > 1, 'read failure destroyed the original tab');
});

async function pausedReload(old) {
  const original = api.Session.prototype.addSource; let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  api.Session.prototype.addSource = async function(...args) {
    const pages = await original.apply(this,args);
    if (this !== old) { entered = true; await gate; }
    return pages;
  };
  return { release, entered: () => entered, restore: () => { release(); api.Session.prototype.addSource = original; } };
}

await test('Duplicate reloads coalesce; a background tab reload keeps its slot and leaves the active document alone', async () => {
  await reset(); const { handle } = await file(); await app.openHandle(handle); const old = app.session, other = app.newDocument();
  const pause = await pausedReload(old);
  try {
    const first = app.reloadFromDisk(old), second = app.reloadFromDisk(old); ok(first === second, 'duplicate reloads did not coalesce');
    await until(pause.entered); pause.release(); await first;
    ok(app.sessions.length === 2 && app.sessions[0] !== old && app.sessions[1] === other && app.session === other, 'background reload moved tabs or stole the active document');
  } finally { pause.restore(); }
});

await test('Editing or closing the target while reloading never loses work or resurrects a closed tab', async () => {
  await reset(); const { handle } = await file(); await app.openHandle(handle); let old = app.session;
  let pause = await pausedReload(old);
  try {
    const pending = app.reloadFromDisk(old); await until(pause.entered);
    old.addAnnots(old.pages[0],[{id:'during-reload',kind:'text',rect:[30,300,250,350],text:'Keep this edit',color:'#111111',fontSize:12,width:0,opacity:1}]);
    pause.release(); await pending;
    ok(app.session === old && old.dirty && old.pages[0].annots.some(a=>a.id==='during-reload'), 'reload discarded an edit made during loading');
  } finally { pause.restore(); }
  old.dirty = false; pause = await pausedReload(old);
  try {
    const pending = app.reloadFromDisk(old); await until(pause.entered); await app.closeSession(old); pause.release(); await pending;
    ok(!app.sessions.includes(old) && !app.sessions.length, 'reload resurrected a closed target');
  } finally { pause.restore(); }
});

await test('A queued style edit finishes before reload decides whether the document changed', async () => {
  await reset(); const { handle } = await file(); await app.openHandle(handle); const old = app.session, p = old.pages[0];
  const a = {id:'pending-style',kind:'text',rect:[30,300,250,350],text:'Style stays',color:'#111111',fontSize:12,width:0,opacity:1};
  old.addAnnots(p,[a]); old.dirty = false; app.viewer.select(p.id,a.id); app.onSelection();
  const pause = await pausedReload(old), original = app.changeStyle; let releaseStyle;
  const styleGate = new Promise(resolve => { releaseStyle = resolve; });
  app.changeStyle = async function(...args) { await styleGate; return original.apply(this,args); };
  try {
    const pending = app.reloadFromDisk(old); await until(pause.entered);
    const styled = app.applyStyle({fontSize:29}); pause.release(); await wait(100); releaseStyle(); await Promise.all([pending,styled]);
    ok(app.session === old && p.annots.find(n=>n.id===a.id)?.fontSize === 29, 'reload swapped out the target before its queued style edit could finish');
  } finally { releaseStyle(); pause.restore(); app.changeStyle = original; }
});

await test('A save completed during reload keeps the saved working document', async () => {
  await reset(); const { handle } = await file(); await app.openHandle(handle); const old = app.session, p = old.pages[0];
  old.addAnnots(p,[{id:'saved-during-reload',kind:'text',rect:[30,300,250,350],text:'Saved meanwhile',color:'#111111',fontSize:12,width:0,opacity:1}]);
  old.dirty = false; const pause = await pausedReload(old);
  try {
    const pending = app.reloadFromDisk(old); await until(pause.entered); ok(await app.saveSession(old), 'concurrent save failed'); pause.release(); await pending;
    ok(app.session === old && p.annots.some(a=>a.id==='saved-during-reload') && !old.dirty, 'reload replaced a document that finished saving during its read');
  } finally { pause.restore(); }
});

await test('Save as during reload keeps the new file association', async () => {
  await reset(); const { handle } = await file(); await app.openHandle(handle); const old = app.session;
  const destination = await root.getFileHandle(`Saved as ${++serial}.pdf`,{create:true}), picker = window.showSaveFilePicker, pause = await pausedReload(old);
  window.showSaveFilePicker = async () => destination;
  try {
    const pending = app.reloadFromDisk(old); await until(pause.entered); ok(await app.saveSession(old,true), 'concurrent Save as failed'); pause.release(); await pending;
    ok(app.session === old && await old.handle.isSameEntry(destination) && old.name === destination.name, 'reload restored the old file association after Save as');
  } finally { window.showSaveFilePicker = picker; pause.restore(); }
});

await reset();
export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
