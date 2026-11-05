// Measures how smooth scrolling and zooming are in the real exe. Compare engine settings with EXTRA=...
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = 9339;
const wait = ms => new Promise(r => setTimeout(r, ms));
const file = join(root, 'tests', 'output', 'scroll-sample.pdf');
mkdirSync(join(root, 'tests', 'output'), { recursive: true });
copyFileSync(join(root, 'tests', 'fixtures', 'huge-3000.pdf'), file);

const child = spawn(join(root, 'app', 'PDFy.exe'), [file], { env: { ...process.env, PDFY_DEBUG_PORT: String(PORT), PDFY_DEV: '1' }, stdio: 'ignore' });
try {
  let target;
  for (let i = 0; i < 80 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(t => t.type === 'page' && t.url.includes('pdfy.local')); } catch { /* Starting. */ }
    await wait(250);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, m => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
  await send('Page.enable');
  await send('Page.bringToFront');
  for (let i = 0; i < 80; i++) {
    await evaluate(`[...document.querySelectorAll('.overlay-bg .btn')].find(b => b.textContent === 'Discard')?.click()`).catch(() => {});
    if (await evaluate(`!!document.querySelector('.page canvas.base')`).catch(() => false)) break;
    await wait(100);
  }
  await wait(800);
  const run = (label, code) => evaluate(`(async () => {
    const v = __pdfy.viewer, sc = v.scroller;
    ${code}
    await new Promise(r => setTimeout(r, 500));
    const times = [];
    let last = performance.now();
    const start = last;
    await new Promise(done => {
      const tick = now => {
        times.push(now - last); last = now;
        sc.scrollTop += 24;
        if (now - start < 3000) requestAnimationFrame(tick); else done();
      };
      requestAnimationFrame(tick);
    });
    times.shift();
    times.sort((a, b) => a - b);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const p95 = times[Math.floor(times.length * 0.95)], worst = times[times.length - 1];
    return { fps: Math.round(1000 / avg), p95: Math.round(p95), worst: Math.round(worst), size: [innerWidth, innerHeight, devicePixelRatio] };
  })()`).then(r => console.log(`${label.padEnd(28)} ${String(r.fps).padStart(3)} frames a second, 95% of frames under ${r.p95} ms, worst ${r.worst} ms, window ${r.size.join(' x ')}`));
  await run('Scrolling, fit width', `v.setFit('width');`);
  await run('Scrolling, with night mode', `__pdfy.setReading('night');`);
  await run('Scrolling, zoomed to 300%', `__pdfy.setReading('normal'); v.setScale(3); await new Promise(r => setTimeout(r, 700));`);
} catch (err) {
  console.log('Failed:', err.message);
} finally {
  try { child.kill(); } catch { /* Gone. */ }
  await wait(1000);
  try { rmSync(file, { force: true }); } catch { /* Harmless. */ }
}
process.exit(0);
