// Runs the in-app feature test in a hidden Edge window, so nothing appears on screen.
// Usage: node tests/browser-run.mjs [test-file.js] [--shots]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const WEB_PORT = 5198, CDP_PORT = 9444;
const wait = ms => new Promise(r => setTimeout(r, ms));
const visual = process.argv.includes('--visual');
const testFile = visual ? 'visual.js' : process.argv.includes('--study') ? 'study-tests.js' : process.argv.includes('--ui') ? 'ui-tests.js' : process.argv.includes('--commands') ? 'command-tests.js' : 'browser-tests.js';
const only = process.argv.slice(2).find(a => !a.startsWith('--')) ?? '';

const server = spawn(process.execPath, ['serve.mjs'], { cwd: root, env: { ...process.env, PORT: String(WEB_PORT) }, stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'pdfy-edge-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--window-size=1400,900',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--enable-precise-memory-info',
  `http://localhost:${WEB_PORT}/`,
], { stdio: 'ignore' });

let exitCode = 1;
try {
  let target;
  for (let i = 0; i < 80 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find(t => t.type === 'page' && t.url.includes(`:${WEB_PORT}`)); } catch { /* Starting. */ }
    await wait(250);
  }
  if (!target) throw new Error('Edge did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const logs = [];
  let current = '';
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') logs.push(`EXCEPTION ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'log' && String(m.params.args[0]?.value) === 'TEST') current = m.params.args[1]?.value;
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push(`console.error ${m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`);
    if (m.method === 'Inspector.targetCrashed') logs.push('PAGE CRASHED');
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'log' && String(m.params.args[0]?.value) === 'REAL') console.log(m.params.args.map(a => a.value).join(' ').slice(0, 500));
    if (m.method === 'Runtime.bindingCalled' && m.params.name === '__cdpBinding') {
      const { n, method, params } = JSON.parse(m.params.payload);
      send(method, params).then(
        () => send('Runtime.evaluate', { expression: `window.__cdpDone(${n})` }),
        err => { logs.push(`input: ${err.message}`); return send('Runtime.evaluate', { expression: `window.__cdpDone(${n})` }); },
      );
    }
    if (m.method === 'Runtime.bindingCalled' && m.params.name === '__shotBinding') {
      const name = m.params.payload;
      send('Page.captureScreenshot', { format: 'png' }).then(r => {
        mkdirSync(join(root, 'tests', 'output', 'shots'), { recursive: true });
        writeFileSync(join(root, 'tests', 'output', 'shots', `${name}.png`), Buffer.from(r.data, 'base64'));
        return send('Runtime.evaluate', { expression: `window.__shotDone && window.__shotDone()` });
      }).catch(err => logs.push(`shot ${name}: ${err.message}`));
    }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, m => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  await send('Runtime.enable');
  await send('Inspector.enable');
  await send('Page.enable');
  await send('Runtime.addBinding', { name: '__shotBinding' });
  await send('Runtime.addBinding', { name: '__cdpBinding' });
  // Wait for the app first: helpers set before the page has finished loading would be lost.
  for (let i = 0; i < 60; i++) { if (await evaluate('!!window.__pdfy').catch(() => false)) break; await wait(200); }
  await send('Runtime.evaluate', { expression: `(() => { let n = 0; const waiting = new Map(); window.__cdpDone = k => { waiting.get(k)?.(); waiting.delete(k); }; window.__cdp = (method, params) => new Promise(res => { const k = ++n; waiting.set(k, res); __cdpBinding(JSON.stringify({ n: k, method, params })); }); })()` });
  await send('Runtime.evaluate', { expression: `window.__shot = name => new Promise(res => { window.__shotDone = res; __shotBinding(name); })` });

  await evaluate(`window.__only = ${JSON.stringify(only)}; import('/fixtures/helpers.js').then(() => { window.__done = null; import('/fixtures/${testFile}?v=' + Date.now()).then(m => { window.__done = m.default; }).catch(e => { window.__done = { crash: String(e), stack: e.stack }; }); return true; })`);

  const outDir = join(root, 'tests', 'output');
  mkdirSync(outDir, { recursive: true });
  const started = Date.now();
  let result = null, lastDone = -1, lastChange = Date.now();
  while (Date.now() - started < 540000) {
    await wait(1000);
    let d = null;
    try { d = await evaluate('window.__done'); } catch (err) { logs.push(`poll: ${err.message}`); break; }
    if (d) { result = d; break; }
    let p = null;
    try { p = JSON.parse(readFileSync(join(outDir, 'test-progress.json'), 'utf8')); } catch { /* Not yet. */ }
    if (p && p.done !== lastDone) { lastDone = p.done; lastChange = Date.now(); }
    if (Date.now() - lastChange > 120000) { logs.push(`Stuck for 120 seconds on: ${current}`); break; }
  }

  // A picture of how the app looked at the end, for checking by eye.
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(outDir, 'last-screen.png'), Buffer.from(shot.data, 'base64'));
  } catch { /* Not essential. */ }

  let progress = null;
  try { progress = JSON.parse(readFileSync(join(outDir, 'test-progress.json'), 'utf8')); } catch { /* None. */ }
  if (progress) {
    for (const t of progress.results) if (t.toasts?.length) t.error += `\n       on screen: ${t.toasts.join(' | ')}`;
    console.log(`done ${progress.done}, passed ${progress.passed}, memory in use ${progress.heapMB} MB, ${Math.round((Date.now() - started) / 1000)} s`);
    for (const t of progress.results) {
      console.log(`${t.ok ? 'ok  ' : 'FAIL'} ${t.name}${t.ms ? ` [${t.ms} ms]` : ''}${t.note ? ` :: ${String(t.note).replace(/\s+/g, ' ').slice(0, 170)}` : ''}${t.error ? `\n       ${t.error}` : ''}`);
    }
  }
  if (result?.crash) console.log('TEST SCRIPT CRASHED:', result.crash, result.stack);
  if (!result) console.log('The run did not finish.');
  const unique = [...new Set(logs)];
  if (unique.length) console.log(`\nPage errors (${unique.length}):\n${unique.slice(0, 20).map(l => `  ${l.slice(0, 260)}`).join('\n')}`);
  exitCode = result && !result.crash && (result.summary?.failed ?? 0) === 0 ? 0 : 1;
} catch (err) {
  console.log('Runner failed:', err.message);
} finally {
  edge.kill();
  server.kill();
  await wait(1200);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* A leftover temp folder is harmless. */ }
}
process.exit(exitCode);
