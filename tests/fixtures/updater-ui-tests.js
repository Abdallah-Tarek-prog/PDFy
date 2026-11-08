const app = window.__pdfy, results = [], sent = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (value, message) => { if (!value) throw new Error(message); };
const original = window.chrome.webview;
const state = patch => window.__appUpdates.onUpdateMessage({ type: 'app-update', phase: 'idle', currentVersion: '0.2.0', enabled: true, message: 'You’re up to date.', ...patch });
const button = label => [...document.querySelectorAll('button')].find(b => b.textContent === label);
window.chrome.webview = { postMessage: message => sent.push(message) };
async function test(name, run) {
  console.log('TEST', name);
  try { await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: String(error.message ?? error) }); }
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, heapMB: 0, results }) });
}
try {
  void app.settingsDialog('general'); await wait(100); state({});
  await test('Settings show the native version, auto-update preference and manual check', async () => {
    const toggle = document.querySelector('[aria-label="Automatic updates"]');
    check(toggle?.checked && document.querySelector('.st-main').textContent.includes('Version 0.2.0.'), 'Version or preference missing');
    button('Check for updates').click(); toggle.click();
    check(sent.some(m => m.type === 'update-check') && sent.some(m => m.type === 'update-enabled' && !m.enabled), 'Update controls did not reach the host');
  });
  await test('Checking, download and retry states are clear and keep the selected interface', async () => {
    const theme = document.documentElement.dataset.uiTheme;
    state({ phase: 'checking', message: 'Checking for updates…' }); check(button('Check for updates').disabled, 'Check is enabled during a request');
    state({ phase: 'downloading', message: 'Downloading version 0.3.0…' }); check(button('Check for updates').disabled, 'Check is enabled during download');
    state({ phase: 'error', message: 'Could not check or download updates. Check your connection and try again.' });
    check(!button('Check for updates').disabled && document.querySelector('.st-main [role="status"]').textContent.includes('try again'), 'Retry state is missing');
    check(document.documentElement.dataset.uiTheme === theme, 'Updater changed the interface');
  });
  await test('Verified updates offer restart and settings fit narrow and wide windows', async () => {
    state({ phase: 'ready', latestVersion: '0.3.0', message: 'Version 0.3.0 is ready. It installs when you close the app, or restart now.' });
    check(!button('Restart to update').hidden, 'Restart action missing'); button('Restart to update').click();
    check(sent.some(m => m.type === 'update-install'), 'Restart did not use the normal native close flow');
    await window.__shot('updater-settings-wide');
    await window.__cdp('Emulation.setDeviceMetricsOverride', { width: 640, height: 900, deviceScaleFactor: 1, mobile: false }); await wait(100);
    check(document.documentElement.scrollWidth <= innerWidth + 1, 'Settings overflow the window');
    const buttons = [...document.querySelectorAll('.st-main button')].filter(b => !b.hidden);
    check(buttons.every(b => b.getBoundingClientRect().right <= innerWidth + 1), 'Update buttons are clipped');
    await window.__shot('updater-settings-narrow'); await window.__cdp('Emulation.clearDeviceMetricsOverride');
  });
} finally { button('Done')?.click(); document.querySelector('.dialog-close')?.click(); window.chrome.webview = original; }
export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
