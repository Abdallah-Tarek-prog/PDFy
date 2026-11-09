// Exercises the published GitHub release from an isolated older app, including Cancel on unsaved work.
// Run after publishing: PDFY_OLD_EXE=<older build with updater> node tests/updater-host-test.mjs
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (!process.env.PDFY_OLD_EXE) throw new Error('Set PDFY_OLD_EXE to an older native build that includes the updater.');
const profile = mkdtempSync(join(tmpdir(), 'meletiq-update-profile-'));
mkdirSync(join(root, 'tests/output'), { recursive: true });
const install = mkdtempSync(join(root, 'tests/output/update-e2e-'));
const release = join(root, `tests/output/release-${version}/payload`);
cpSync(release, install, { recursive: true });
const baseline = dirname(process.env.PDFY_OLD_EXE);
for (const name of ['PDFy.exe','Meletiq.ico','WebView2Loader.dll','runtimes','web','release.json']) {
  const source = join(baseline,name); if (existsSync(source)) cpSync(source,join(install,name),{recursive:true});
}
copyFileSync(process.env.PDFY_OLD_EXE, join(install, 'PDFy.exe'));
writeFileSync(join(install, 'owner-document.pdf'), 'owner document marker');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const oldHash = hash(join(install, 'PDFy.exe'));
const port = 9347;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0, child, page;
const check = (value, message) => { if (!value) throw new Error(message); passed++; console.log('ok ' + message); };

class Page {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); this.pending.get(m.id)?.(m); this.pending.delete(m.id); };
  }
  async eval(expression) {
    const id = ++this.id;
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Evaluation timed out')), 15000);
      this.pending.set(id, value => { clearTimeout(timer); resolve(value); });
      this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }));
    });
    if (response.error || response.result.exceptionDetails) throw new Error(JSON.stringify(response.error ?? response.result.exceptionDetails));
    return response.result.result.value;
  }
}
async function connect(version) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const target = list.find(t => t.type === 'page' && t.url.includes('pdfy.local'));
      if (target) {
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
        const p = new Page(ws);
        if (await p.eval('!!window.__pdfy')) {
          await p.eval(`window.__updateState = null; window.chrome.webview.addEventListener('message', e => { if (e.data?.type === 'app-update') window.__updateState = e.data; }); window.chrome.webview.postMessage({type:'update-state'}); 1`);
          await wait(150);
          if (await p.eval(version ? `window.__updateState?.currentVersion === ${JSON.stringify(version)}` : `typeof window.__updateState?.currentVersion === 'string'`)) return p;
        }
        ws.close();
      }
    } catch { /* Window is starting or restarting. */ }
    await wait(250);
  }
  throw new Error('App version ' + version + ' did not start');
}
async function until(expression, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await page.eval(expression).catch(() => false)) return true; await wait(200); }
  return false;
}
try {
  child = spawn(join(install, 'PDFy.exe'), [], { env: { ...process.env, PDFY_DEV: '1', PDFY_TEST_DATA_DIR: profile, PDFY_DEBUG_PORT: String(port) }, stdio: 'ignore', windowsHide: true });
  page = await connect();
  check(await page.eval(`window.__updateState.currentVersion !== ${JSON.stringify(version)}`), 'Baseline app has an older version');
  check(true, 'Older installed app starts with an isolated profile');
  await page.eval(`window.chrome.webview.postMessage({type:'update-check'}); 1`);
  check(await until(`['ready','error'].includes(window.__updateState?.phase)`, 180000), 'Public release check and download complete');
  const status = await page.eval('window.__updateState');
  check(status.phase === 'ready' && status.latestVersion === version, 'GitHub package checksum and manifest are verified: ' + status.message);
  await page.eval(`window.__pdfy.newDocument().markDirty(); window.chrome.webview.postMessage({type:'update-install'}); 1`);
  check(await until(`document.querySelector('.overlay-bg')?.textContent.includes('Save your changes')`), 'Restart offers to save unsaved work');
  await page.eval(`[...document.querySelectorAll('.dialog-foot button')].find(b => b.textContent === 'Cancel').click(); 1`); await wait(300);
  check(child.exitCode === null && await page.eval('window.__pdfy.sessions.some(s => s.dirty)'), 'Cancel keeps the app and unsaved document open');
  await page.eval(`window.chrome.webview.postMessage({type:'update-install'}); 1`);
  check(await until(`document.querySelector('.overlay-bg')?.textContent.includes('Save your changes')`), 'A canceled update can be retried');
  await page.eval(`[...document.querySelectorAll('.dialog-foot button')].find(b => b.textContent === "Don't save").click(); 1`);
  page.ws.close(); page = await connect(version);
  check(hash(join(install, 'PDFy.exe')) === hash(join(release, 'PDFy.exe')), 'Updater installs the published native executable and restarts');
  check(await page.eval(`(() => { const a=window.__pdfy,s=a.newDocument(); a.setMode('edit'); a.tools.setTool('markdown'); a.tools.openEditor(a.viewer.views.get(s.pages[0].id),{...a.tools.base('text','markdown'),rect:[30,400,330,650],markdown:true,text:''},true); const found=!!document.querySelector('.markdown-editor [aria-label="Bold (Ctrl+B)"]'); document.querySelector('.md-done')?.click(); return found; })()`), 'New formatted Markdown editor loads after updating the existing browser profile');
  check(hash(join(install, '.previous-release/PDFy.exe')) === oldHash, 'Previous native release is retained for rollback');
  check(readFileSync(join(install, 'owner-document.pdf'), 'utf8') === 'owner document marker', 'Unrelated documents remain untouched');
  await page.eval(`window.chrome.webview.postMessage({type:'update-check'}); 1`);
  check(await until(`window.__updateState?.message === 'You’re up to date.'`), 'New release correctly reports that it is up to date');
  await page.eval(`window.chrome.webview.postMessage({type:'win',action:'close'}); 1`);
  console.log(`Passed ${passed} end-to-end updater checks.`);
} catch (error) {
  console.error(error);
  const log = join(profile, 'pdfy.log'); if (existsSync(log)) console.error(readFileSync(log, 'utf8').split('\n').slice(-12).join('\n'));
  process.exitCode = 1;
} finally {
  page?.ws.close();
  if (child && child.exitCode === null) child.kill();
  execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='PDFy.exe'" | Where-Object { $_.ExecutablePath -eq '${join(install, 'PDFy.exe').replace(/'/g, "''")}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`], { windowsHide: true });
}
