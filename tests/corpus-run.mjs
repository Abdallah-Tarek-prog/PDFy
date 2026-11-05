// Runs real-world PDFs through the app in a hidden Edge window. A crash or hang on one file is recorded,
// and the run carries on with the next.
// Usage: node tests/corpus-run.mjs <folder of PDFs> [name filter]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const corpus = process.argv[2];
const filter = process.argv[3] && !process.argv[3].startsWith('--') ? new RegExp(process.argv[3], 'i') : null;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const WEB_PORT = 5196, CDP_PORT = 9448;
const wait = ms => new Promise(r => setTimeout(r, ms));
const outFile = join(root, 'tests', 'output', 'corpus-results.json');
mkdirSync(join(root, 'tests', 'output'), { recursive: true });

const names = readdirSync(corpus).filter(n => n.toLowerCase().endsWith('.pdf') && (!filter || filter.test(n))).sort();
console.log(`${names.length} files, ${Math.round(names.reduce((s, n) => s + statSync(join(corpus, n)).size, 0) / 1048576)} MB`);

const server = spawn(process.execPath, ['serve.mjs'], { cwd: root, env: { ...process.env, PORT: String(WEB_PORT), CORPUS_DIR: corpus }, stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'pdfy-edge-corpus-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--window-size=1200,800', '--no-first-run', '--disable-extensions', `http://localhost:${WEB_PORT}/`], { stdio: 'ignore' });

class Tab {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.crashed = false;
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
      if (m.method === 'Inspector.targetCrashed') this.crashed = true;
    });
    ws.addEventListener('close', () => { this.crashed = true; });
  }
  send(method, params = {}) { return new Promise((res, rej) => { const n = ++this.id; this.pending.set(n, m => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))); this.ws.send(JSON.stringify({ id: n, method, params })); }); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
}

async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const t = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find(x => x.type === 'page');
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        const tab = new Tab(ws);
        await tab.send('Inspector.enable');
        await tab.send('Runtime.enable');
        await tab.send('Page.enable');
        return tab;
      }
    } catch { /* Starting. */ }
    await wait(250);
  }
  throw new Error('Edge did not start');
}

async function prepare(tab) {
  await tab.send('Page.navigate', { url: `http://localhost:${WEB_PORT}/` });
  for (let i = 0; i < 80; i++) { if (await tab.eval('!!window.__api').catch(() => false)) break; await wait(150); }
  await tab.eval(`import('/fixtures/corpus.js?v=' + Date.now()).then(() => { window.__dumpShots = ${process.argv.includes('--shots')}; return true; })`);
}

const results = existsSync(outFile) && process.argv.includes('--resume') ? JSON.parse(readFileSync(outFile, 'utf8')) : [];
const done = new Set(results.map(r => r.name));
let tab = await connect();
await prepare(tab);
const started = Date.now();
let n = 0;
for (const name of names) {
  n++;
  if (done.has(name)) continue;
  let r;
  try {
    r = await Promise.race([
      tab.eval(`window.__corpusOne(${JSON.stringify(name)})`),
      wait(150000).then(() => ({ name, error: 'HUNG: no answer in 150 seconds', hung: true })),
    ]);
  } catch (err) {
    r = { name, error: `PAGE FAILED: ${err.message}`.slice(0, 200), crashed: true };
  }
  if (tab.crashed || r.hung || r.crashed) {
    r.crashed = true;
    console.log(`  restarting after ${name}`);
    try { tab.ws.close(); } catch { /* Gone. */ }
    tab = await connect();
    await prepare(tab);
  }
  results.push(r);
  if (n % 10 === 0 || !r.ok) writeFileSync(outFile, JSON.stringify(results, null, 1));
  if (n % 50 === 0) console.log(`  ${n}/${names.length} in ${Math.round((Date.now() - started) / 1000)} s`);
}
writeFileSync(outFile, JSON.stringify(results, null, 1));

const ok = results.filter(r => r.ok);
const needPw = results.filter(r => /cancelled/i.test(r.error ?? ''));
const refused = results.filter(r => r.stage === 'open' && r.error && !/TIMEOUT|cancelled/i.test(r.error));
const crashes = results.filter(r => r.crashed);
const timeouts = results.filter(r => /TIMEOUT|HUNG/.test(r.error ?? ''));
const problems = results.filter(r => r.problem);
const failed = results.filter(r => r.error && r.stage !== 'open' && !/TIMEOUT|HUNG/.test(r.error) && !r.crashed);
console.log(`\nAll fine: ${ok.length} of ${results.length}. Of those, rebuilt from page pictures: ${results.filter(r => r.ok && r.rebuilt).length}.`);
console.log(`Needs a password: ${needPw.length}. Refused as broken: ${refused.length}.`);
console.log(`Crashes: ${crashes.length}. Hangs: ${timeouts.length}. Saved but looks different: ${problems.length}. Save or draw failed: ${failed.length}.`);
const show = (title, list, f) => { if (list.length) { console.log(`\n${title}:`); for (const r of list.slice(0, 40)) console.log(`  ${r.name.slice(0, 44).padEnd(45)} ${f(r)}`); } };
show('Crashes', crashes, r => r.error);
show('Hangs', timeouts, r => `${r.stage}: ${r.error}`);
show('Failed', failed, r => `${r.stage}: ${r.error}`.slice(0, 140));
show('Looks different', problems, r => `${r.pages}p ${r.problem}`.slice(0, 140));
show('Refused', refused.filter(r => !/damaged|not a PDF|empty/i.test(r.error)), r => r.error.slice(0, 120));

edge.kill();
server.kill();
await wait(1000);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* Harmless. */ }
process.exit(0);
