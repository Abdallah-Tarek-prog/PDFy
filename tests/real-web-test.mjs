// The hardest honest test of the theme converter. Real sites, in their real dark mode, are converted to
// light by PDFy and compared with the same site's real light mode. The reverse is tested too.
// Usage: node tests/real-web-test.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const WEB_PORT = 5197, CDP_PORT = 9446;
const wait = ms => new Promise(r => setTimeout(r, ms));
const outDir = join(root, 'tests', 'output', 'web');
mkdirSync(outDir, { recursive: true });

const SITES = [
  ['github', 'https://github.com/microsoft/TypeScript'],
  ['mdn', 'https://developer.mozilla.org/en-US/docs/Web/CSS/color'],
  ['python', 'https://docs.python.org/3/library/functions.html'],
  ['typescript', 'https://www.typescriptlang.org/docs/handbook/2/basic-types.html'],
  ['gemini', 'https://gemini.google.com/app'],
];

const server = spawn(process.execPath, ['serve.mjs'], { cwd: root, env: { ...process.env, PORT: String(WEB_PORT) }, stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'pdfy-edge-web-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--window-size=1280,860', '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });

class Tab {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } }); }
  send(method, params = {}) { return new Promise((res, rej) => { const n = ++this.id; this.pending.set(n, m => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))); this.ws.send(JSON.stringify({ id: n, method, params })); }); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
}

async function openTab(url) {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const t = await r.json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const tab = new Tab(ws);
  await tab.send('Page.enable');
  await tab.send('Runtime.enable');
  return tab;
}

let code = 1;
try {
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${CDP_PORT}/json`); break; } catch { await wait(250); } }
  const shots = {};
  for (const [name, url] of SITES) {
    const tab = await openTab('about:blank');
    try {
      for (const scheme of ['dark', 'light']) {
        const cached = join(outDir, `${name}-real-${scheme}.png`);
        if (existsSync(cached) && !process.argv.includes('--fresh')) { (shots[name] ??= {})[scheme] = readFileSync(cached).toString('base64'); continue; }
        await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
        await tab.send('Page.navigate', { url });
        await wait(5500);
        const png = (await tab.send('Page.captureScreenshot', { format: 'png' })).data;
        writeFileSync(join(outDir, `${name}-real-${scheme}.png`), Buffer.from(png, 'base64'));
        (shots[name] ??= {})[scheme] = png;
      }
    } catch (err) {
      console.log(`${name}: could not capture (${err.message})`);
    }
    await tab.send('Page.close').catch(() => {});
  }

  const app = await openTab(`http://localhost:${WEB_PORT}/`);
  for (let i = 0; i < 60; i++) { if (await app.eval('!!window.__api').catch(() => false)) break; await wait(200); }
  await wait(400);
  await app.eval(`window.__compare = async (fromB64, toB64, targetB64) => {
    const load = async b64 => createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
    const data = bmp => { const c = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d'); c.drawImage(bmp, 0, 0); return c.getImageData(0, 0, bmp.width, bmp.height).data; };
    const fromBlob = await (await fetch('data:image/png;base64,' + fromB64)).blob();
    const targetData = data(await load(targetB64));
    const a = await __api.analyzeImage(fromBlob);
    // The target colours are read off the real page, which is what a matching style preset would hold.
    const tb = await __api.analyzeImage(await (await fetch('data:image/png;base64,' + targetB64)).blob());
    const hex = c => c ? '#' + c.map(v => v.toString(16).padStart(2, '0')).join('') : null;
    const palette = { bg: hex(tb.bg), surface: hex(tb.surface) ?? hex(tb.bg), text: hex(tb.text) ?? (tb.isDark ? '#e6e6e6' : '#1f1f1f') };
    const t0 = performance.now();
    const { blob } = await __api.convertImage(fromBlob, palette, true, a);
    const ms = Math.round(performance.now() - t0);
    const conv = data(await createImageBitmap(blob));
    const fromData = data(await load(fromB64));
    let sum = 0, before = 0, close = 0, n = 0;
    for (let i = 0; i < conv.length; i += 4) {
      const d = Math.abs(conv[i] - targetData[i]) + Math.abs(conv[i + 1] - targetData[i + 1]) + Math.abs(conv[i + 2] - targetData[i + 2]);
      before += Math.abs(fromData[i] - targetData[i]) + Math.abs(fromData[i + 1] - targetData[i + 1]) + Math.abs(fromData[i + 2] - targetData[i + 2]);
      sum += d; n++;
      if (d <= 24) close++;
    }
    const reader = new FileReader();
    const b64 = await new Promise(r => { reader.onload = () => r(String(reader.result).split(',')[1]); reader.readAsDataURL(blob); });
    return { ms, meanDiff: +(sum / n / 3).toFixed(1), startDiff: +(before / n / 3).toFixed(1), closePct: +(close / n * 100).toFixed(1), photos: a.photos.length, png: b64, palette, srcBg: hex(a.bg), srcSurface: hex(a.surface), srcText: hex(a.text) };
  }`);

  console.log('site        direction      start   after   pixels within tolerance');
  for (const [name] of SITES) {
    const s = shots[name];
    if (!s?.dark || !s?.light) continue;
    if (Math.abs(s.dark.length - s.light.length) < 50 && s.dark === s.light) { console.log(`${name}: this site has no dark mode`); continue; }
    for (const [dir, from, to] of [['dark to light', s.dark, s.light], ['light to dark', s.light, s.dark]]) {
      const r = await app.eval(`__compare(${JSON.stringify(from)}, ${JSON.stringify(to)}, ${JSON.stringify(to)})`);
      writeFileSync(join(outDir, `${name}-${dir.replace(/ /g, '-')}.png`), Buffer.from(r.png, 'base64'));
      console.log(`${name.padEnd(11)} ${dir.padEnd(14)} ${String(r.startDiff).padEnd(7)} ${String(r.meanDiff).padEnd(7)} ${r.closePct}%   ${r.ms} ms, photos ${r.photos}, ${r.srcBg}/${r.srcSurface}/${r.srcText} -> ${r.palette.bg}/${r.palette.surface}/${r.palette.text}`);
    }
  }
  code = 0;
} catch (err) {
  console.log('Failed:', err.message);
} finally {
  edge.kill();
  server.kill();
  await wait(1200);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* A leftover temp folder is harmless. */ }
}
process.exit(code);
