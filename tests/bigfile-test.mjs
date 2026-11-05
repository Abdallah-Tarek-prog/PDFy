// Opens a 150 MB PDF in the real PDFy.exe and measures real memory. The file is removed afterwards.
import { execSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const exe = join(root, 'app', 'PDFy.exe');
const PORT = 9337;
const wait = ms => new Promise(r => setTimeout(r, ms));
const dir = join(root, 'tests', 'output');
mkdirSync(dir, { recursive: true });
const file = join(dir, 'big-150mb.pdf');

function makeBigPdf(pages) {
  const fd = openSync(file, 'w');
  let pos = 0;
  const offsets = [];
  const write = b => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1'); writeSync(fd, buf); pos += buf.length; };
  const obj = (n, body) => { offsets[n] = pos; write(`${n} 0 obj\n`); write(body); write('\nendobj\n'); };
  write('%PDF-1.7\n');
  const total = 2 + pages * 3;
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${pages} /Kids [ ${kids} ] >>`);
  for (let i = 0; i < pages; i++) {
    const p = 3 + i * 3, c = p + 1, im = p + 2;
    obj(p, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${c} 0 R /Resources << /XObject << /Im0 ${im} 0 R >> >> >>`);
    const content = `q 612 0 0 792 0 0 cm /Im0 Do Q`;
    obj(c, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    // Random colours cannot be compressed, so each page really costs a megabyte in the file.
    const W = 600, H = 600;
    const raw = deflateSync(randomBytes(W * H * 3), { level: 1 });
    offsets[im] = pos;
    write(`${im} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${raw.length} >>\nstream\n`);
    write(raw);
    write('\nendstream\nendobj\n');
  }
  const xref = pos;
  write(`xref\n0 ${total + 1}\n0000000000 65535 f \n`);
  for (let n = 1; n <= total; n++) write(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  write(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  closeSync(fd);
}

makeBigPdf(140);
const sizeMb = Math.round(statSync(file).size / 1048576);
console.log(`Test file: ${sizeMb} MB`);

/** Memory that belongs to this app alone, and what Windows reports with shared memory counted repeatedly. */
function memory(pid) {
  const out = execSync(`powershell -NoProfile -Command "$ids=@(${pid}); $all=Get-CimInstance Win32_Process; do { $n=$all | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId } | ForEach-Object { $_.ProcessId }; $ids+=$n } while ($n); $priv=0; $set=0; foreach($i in $ids){ $p=Get-Process -Id $i -ErrorAction SilentlyContinue; if($p){ $priv+=$p.PrivateMemorySize64; $set+=$p.WorkingSet64 } }; '{0} {1} {2}' -f [math]::Round($priv/1MB),[math]::Round($set/1MB),$ids.Count"`, { encoding: 'utf8' });
  const [priv, set, count] = out.trim().split(' ').map(Number);
  return { priv, set, count };
}
const show = m => `${m.priv} MB private (${m.set} MB counting shared memory repeatedly, ${m.count} processes)`;

// First, the app alone with nothing open.
{
  const empty = spawn(exe, [], { env: { ...process.env, PDFY_DEBUG_PORT: String(PORT + 1) }, stdio: 'ignore' });
  await wait(6000);
  console.log(`Nothing open: ${show(memory(empty.pid))}`);
  empty.kill();
  await wait(2500);
}

const child = spawn(exe, [file], { env: { ...process.env, PDFY_DEBUG_PORT: String(PORT), PDFY_DEV: '1' }, stdio: 'ignore' });

let code = 1;
try {
  let target;
  for (let i = 0; i < 80 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(t => t.type === 'page' && t.url.includes('pdfy.local')); } catch { /* Starting. */ }
    await wait(250);
  }
  if (!target) throw new Error('The app did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, m => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };

  let t0 = Date.now(), opened = false;
  for (let i = 0; i < 200 && !opened; i++) {
    await evaluate(`[...document.querySelectorAll('.overlay-bg .btn')].find(b => b.textContent === 'Discard')?.click()`).catch(() => {});
    opened = await evaluate(`!!document.querySelector('.page canvas.base')`).catch(() => false);
    await wait(100);
  }
  if (!opened) throw new Error('The file did not open');
  const openMs = Date.now() - t0;
  await wait(1500);
  const afterOpen = memory(child.pid);
  console.log(`Opened and drew the first page in ${openMs} ms: ${show(afterOpen)}`);

  let peak = afterOpen;
  t0 = Date.now();
  for (const page of [20, 60, 100, 139, 5, 80, 120, 40, 10, 130]) {
    await evaluate(`__pdfy.viewer.goTo(${page})`);
    for (let i = 0; i < 80; i++) {
      const ready = await evaluate(`[...__pdfy.viewer.views.values()].every(v => !v.needsRender && !v.task)`);
      if (ready) break;
      await wait(60);
    }
    await wait(150);
    const m = memory(child.pid);
    if (m.priv > peak.priv) peak = m;
  }
  console.log(`Jumped to 10 places in ${Date.now() - t0} ms. Peak: ${show(peak)}, for a ${sizeMb} MB file`);
  // Dropping the document returns its memory.
  await evaluate(`(async () => { for (const s of [...__pdfy.sessions]) { s.dirty = false; await __pdfy.closeSession(s); } })()`);
  await wait(2500);
  const after = memory(child.pid);
  console.log(`After closing it: ${show(after)}`);
  code = 0;
} catch (err) {
  console.log('Failed:', err.message);
} finally {
  try { child.kill(); } catch { /* Gone. */ }
  await wait(1200);
  try { rmSync(file, { force: true }); console.log('Test file removed.'); } catch (err) { console.log('Could not remove the test file:', err.message); }
}
process.exit(code);
