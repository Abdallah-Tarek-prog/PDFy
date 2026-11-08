const app = window.__pdfy;
const results = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (value, message) => { if (!value) throw new Error(message); };
const closeAll = async () => { for (const s of [...app.sessions]) { s.dirty = false; await app.closeSession(s); } };
const tab = s => document.querySelector(`[data-session-id="${s.id}"]`);
async function documentTab(name, width = 900, height = 1100) {
  const s = app.newDocument();
  s.name = name;
  s.pages = Array.from({ length: 18 }, () => s.blankPage(width, height));
  s.emit({ kind: 'structure' });
  s.dirty = false;
  await wait(70);
  return s;
}
const snapshot = () => ({ top: app.viewer.scroller.scrollTop, left: app.viewer.scroller.scrollLeft, scale: app.viewer.scale, layout: app.viewer.layout, fit: app.viewer.fit, page: app.viewer.current });
const matches = (saved, label) => {
  const now = snapshot();
  check(Math.abs(now.top - saved.top) <= 2, `${label}: vertical position ${now.top} instead of ${saved.top}`);
  check(Math.abs(now.left - saved.left) <= 2, `${label}: horizontal position ${now.left} instead of ${saved.left}`);
  check(now.scale === saved.scale && now.fit === saved.fit && now.layout === saved.layout, `${label}: zoom or layout changed: ${JSON.stringify(now)}`);
  check(now.page === saved.page, `${label}: page ${now.page} instead of ${saved.page}`);
};
async function test(name, run) {
  console.log('TEST', name);
  try { await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: String(error.message ?? error) }); }
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, heapMB: 0, results }) });
}
await closeAll();
await test('Mouse tab switching restores each document page, both scroll offsets and zoom, even with equal filenames', async () => {
  const a = await documentTab('Lecture.pdf');
  app.viewer.setLayout('continuous'); app.viewer.setScale(1.6); app.viewer.goTo(7, 173);
  app.viewer.scroller.scrollLeft = 119; await wait(90);
  const first = snapshot();
  const b = await documentTab('Lecture.pdf', 1100, 1400);
  app.viewer.setLayout('continuous'); app.viewer.setScale(1.2); app.viewer.goTo(3, 91);
  app.viewer.scroller.scrollLeft = 67; await wait(90);
  const second = snapshot();
  for (let i = 0; i < 3; i++) {
    tab(a).click(); await wait(90); matches(first, 'first tab');
    tab(b).click(); await wait(90); matches(second, 'second tab');
  }
});
await test('Single-page and facing layouts retain their own page and zoom when switching tabs by keyboard', async () => {
  await closeAll();
  const a = await documentTab('Single.pdf');
  app.viewer.setLayout('single'); app.viewer.setScale(1.5); app.viewer.goTo(8);
  app.viewer.scroller.scrollTop = 210; app.viewer.scroller.scrollLeft = 54; await wait(90);
  const first = snapshot();
  const b = await documentTab('Facing.pdf');
  app.viewer.setLayout('facing'); app.viewer.setScale(.85); app.viewer.goTo(10, 87); await wait(90);
  const second = snapshot();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', code: 'Digit1', ctrlKey: true, bubbles: true, cancelable: true }));
  await wait(90); check(app.session === a, 'Ctrl+1 did not activate the first tab'); matches(first, 'single-page tab');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', code: 'Digit2', ctrlKey: true, bubbles: true, cancelable: true }));
  await wait(90); check(app.session === b, 'Ctrl+2 did not activate the second tab'); matches(second, 'facing tab');
});
await test('Switching tabs immediately after a scroll captures the latest position', async () => {
  await closeAll();
  const a = await documentTab('Rapid A.pdf'), b = await documentTab('Rapid B.pdf');
  app.activate(a); app.viewer.setLayout('continuous'); app.viewer.setScale(1.4); await wait(70);
  app.viewer.scroller.scrollTop = 4321; app.viewer.scroller.scrollLeft = 43;
  const top = app.viewer.scroller.scrollTop, left = app.viewer.scroller.scrollLeft;
  tab(b).click(); tab(a).click(); await wait(90);
  check(Math.abs(app.viewer.scroller.scrollTop - top) <= 2 && Math.abs(app.viewer.scroller.scrollLeft - left) <= 2, 'the last scroll before switching was lost');
});
await closeAll();
export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
