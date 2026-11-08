// Screenshots of the screens added on 2026-11-06, into tests/output/shots, for checking by eye.
const app = window.__pdfy, A = window.__api;
const wait = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const shot = async (name, ms = 250) => { await wait(ms); await window.__shot(name); results.push({ ok: true, name }); };
const fx = async name => { const r = await fetch(`/fixtures/${name}`); return new File([await r.blob()], name, { type: 'application/pdf' }); };
const closeAll = async () => { for (const s of [...app.sessions]) { s.dirty = false; await app.closeSession(s); } };
const until = async (fn, ms = 6000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(50); } return null; };

try {
  A.applyUiTheme('slate');
  await closeAll();
  // Home, with a collection and a closed file.
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle('Lecture 4 - Waves.pdf', { create: true });
  const w = await handle.createWritable(); await w.write(await (await fx('structure.pdf')).arrayBuffer()); await w.close();
  const c1 = await A.createCollection('Physics', '#4f8cf7');
  await A.createCollection('Exam revision', '#e5534b');
  await A.addToCollection(c1.id, handle.name, handle, 4);
  await A.addClosed(handle.name, handle, 2, 4);
  await app.home.draw();
  await shot('u01-home');
  [...document.querySelectorAll('.home-nav-item')].find(b => b.textContent.includes('Recently closed')).click();
  await shot('u02-home-closed', 400);

  // Create document.
  const made = app.createDocument();
  const dlg = await until(() => document.querySelector('.create-doc'));
  const sels = dlg.querySelectorAll('select.cd-select');
  sels[0].value = 'lined'; sels[0].dispatchEvent(new Event('change'));
  await shot('u03-create-document');
  dlg.querySelectorAll('.cd-nav')[1].click();
  await shot('u04-create-from-pictures');
  dlg.querySelectorAll('.cd-nav')[0].click();
  dlg.querySelector('input[type=number]').value = '6';
  [...dlg.querySelectorAll('.btn')].find(b => b.textContent === 'Create PDF').click();
  await made;
  await wait(800);

  // Edit toolbar with the study tools, and the pen style row.
  await closeAll();
  await app.openFile(await fx('report.pdf'));
  await wait(900);
  app.setMode('edit');
  app.tools.setTool('pen');
  await shot('u05-edit-toolbar', 500);
  app.tools.setTool('hand');
  app.setMode('view');

  // Page editor.
  await closeAll();
  await app.openFile(await fx('structure.pdf'));
  await wait(600);
  app.pageEditor.open();
  await until(() => document.querySelectorAll('.pe-cell canvas').length >= 3);
  document.querySelectorAll('.pe-check')[1]?.click();
  await shot('u06-page-editor', 500);
  document.querySelector('.pe-fab').click();
  await shot('u07-page-editor-insert', 300);
  document.querySelector('.dropdown')?.remove();
  app.pageEditor.close();

  // Bookmarks.
  app.viewer.goTo(1);
  await wait(300);
  app.toggleBookmark();
  app.panels.show('bookmarks');
  await shot('u08-bookmarks', 500);
  app.panels.show('thumbs');

  // Settings.
  void app.settingsDialog('appearance');
  await until(() => document.querySelector('.settings'));
  await shot('u09-settings-appearance', 400);
  [...document.querySelectorAll('.st-nav-item')].find(b => b.textContent === 'Pen and tablet').click();
  await shot('u10-settings-pen', 300);
  [...document.querySelectorAll('.st-nav-item')].find(b => b.textContent === 'Quick setups').click();
  await shot('u11-settings-setups', 300);
  document.querySelector('.overlay-bg')?.remove();

  // The guide.
  void app.showGuide();
  await until(() => document.querySelector('.guide'));
  document.querySelectorAll('.guide-dot')[1].click();
  await shot('u12-guide-paste', 400);
  for (const i of [3, 5, 6, 8, 10]) { document.querySelectorAll('.guide-dot')[i].click(); await shot(`u13-guide-${i + 1}`, 350); }
  document.querySelector('.guide-bg')?.remove();

  // Voice player and a filled form in Read.
  const s = app.session;
  const page = s.pages[0];
  const v = app.viewer.views.get(page.id);
  const mk = (type, name, rect, options) => ({ id: `f${Math.random().toString(36).slice(2)}`, kind: 'rect', rect, color: '#0b57d0', opacity: 1, width: 1.5, fill: null, field: { type, name, options, value: type === 'text' ? 'Muhammad Sayed' : type === 'check' ? true : 'Second' }, created: Date.now() });
  s.addAnnots(page, [mk('text', 'name', [72, 700, 300, 722]), mk('check', 'agree', [72, 670, 86, 684]), mk('dropdown', 'year', [100, 668, 220, 688], ['First', 'Second', 'Third'])], 'Fields');
  await shot('u14-form-in-read', 400);
  const blob = new Blob([new Uint8Array(44)], { type: 'audio/wav' });
  const note = { id: 'vn1', kind: 'attachment', rect: [320, 690, 340, 714], color: '#c9e4ff', opacity: 1, width: 0.75, fill: null, attachment: { name: 'Voice note 6 Nov 14-32.webm', mime: 'audio/webm', blob, voice: true }, created: Date.now() };
  s.addAnnots(page, [note], 'Voice');
  await wait(200);
  app.openAttachment(page.annots.find(a => a.id === 'vn1'));
  await shot('u15-voice-player', 500);
  document.querySelector('.voice-player')?.remove();
  void v;
  s.dirty = false;

  // Light theme check of the new screens.
  A.applyUiTheme('daylight');
  void app.settingsDialog('appearance');
  await until(() => document.querySelector('.settings'));
  await shot('u16-settings-daylight', 400);
  document.querySelector('.overlay-bg')?.remove();
  A.applyUiTheme('slate');

  await A.deleteCollection(c1.id);
  for (const c of await A.listCollections()) await A.deleteCollection(c.id);
  await A.clearClosed();
  await root.removeEntry(handle.name);
  await closeAll();
} catch (err) {
  results.push({ ok: false, name: 'visual', error: String(err?.message ?? err) });
}
await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, heapMB: 0, results }, null, 1) });
export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
