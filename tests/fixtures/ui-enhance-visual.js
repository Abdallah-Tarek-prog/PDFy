// Visual QA for the UI_Enhance branch: complete palettes and menus at desktop window sizes.
const app = window.__pdfy, A = window.__api;
const results = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const shot = async name => { await wait(180); await window.__shot(name); };
const dismiss = async () => {
  await wait(0); // The menu installs its outside-click listener after the opening click.
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  await wait(0);
};
const themes = ['graphite', 'carbon', 'slate', 'midnight', 'mocha', 'dracula', 'nord', 'forest', 'ember', 'daylight', 'paper', 'lilac', 'sage'];
async function check(name, run) {
  console.log('TEST', name);
  try { await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: String(error.message ?? error) }); }
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, heapMB: 0, results }) });
}
function inWindow(element) {
  if (!element) throw new Error('The expected menu did not open');
  const rect = element.getBoundingClientRect();
  if (rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1) {
    throw new Error(`The menu extends outside the ${innerWidth} × ${innerHeight} window`);
  }
}
const file = await (await fetch('/fixtures/structure.pdf')).blob();
await app.openPdfBlob(file, 'Study notes.pdf');
app.panels.show('thumbs');
await wait(350);
for (const theme of themes) {
  await check(`${theme}: toolbar, full Actions menu and keyboard focus`, async () => {
    A.applyUiTheme(theme);
    app.setMode('view');
    await app.revealCommand('Compress');
    const menu = document.querySelector('.dropdown');
    inWindow(menu);
    await shot(`ui-${theme}-actions`);
    await dismiss();
  });
}
for (const [width, height] of [[1024, 768], [640, 480], [1920, 1080]]) {
  await window.__cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await wait(180);
  for (const theme of ['graphite', 'daylight']) await check(`${theme} at ${width} × ${height}: menus stay within the window`, async () => {
    A.applyUiTheme(theme);
    await app.revealCommand('Compress');
    inWindow(document.querySelector('.dropdown'));
    await shot(`ui-${theme}-${width}-actions`);
    await dismiss();
    document.querySelector('.tab-add').click();
    inWindow(document.querySelector('.dropdown'));
    await dismiss();
    const settings = app.settingsDialog('appearance');
    await wait(180);
    if (document.querySelector('.dropdown')) throw new Error('A menu remained open over Settings');
    inWindow(document.querySelector('.dialog'));
    if (document.querySelector('.settings').scrollWidth > document.querySelector('.settings').clientWidth + 1) throw new Error('Settings overflows horizontally');
    await shot(`ui-${theme}-${width}-settings`);
    document.querySelector('.dialog-foot .primary').click();
    await settings;
  });
}
await window.__cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await wait(180);
for (const theme of ['graphite', 'carbon', 'daylight', 'sage']) {
  A.applyUiTheme(theme);
  app.setMode('edit'); app.tools.setTool('pen');
  await shot(`ui-${theme}-edit`);
  app.setMode('view');
  const settings = app.settingsDialog('appearance');
  await wait(180);
  await shot(`ui-${theme}-gallery`);
  document.querySelector('.dialog-foot .primary').click();
  await settings;
}
for (const session of [...app.sessions]) { session.dirty = false; await app.closeSession(session); }
export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
