// Tests the real PDFy.exe: starts it, drives it over the debug port, crashes its engine on purpose.
import { spawn, execSync } from 'node:child_process';
import { statSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const exe = join(root, 'app', 'PDFy.exe');
const PORT = 9333;
const results = [];
const wait = ms => new Promise(r => setTimeout(r, ms));

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json`);
  return (await r.json()).filter(t => t.type === 'page');
}

class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.addEventListener('message', e => this.onMessage(e)); }
  onMessage(e) {
    const m = JSON.parse(e.data);
    if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${method} timed out`)), 30000);
      this.pending.set(id, m => { clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(m.result); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
}

async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await targets();
      const t = list.find(x => x.url.includes('pdfy.local'));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        return new Page(ws);
      }
    } catch { /* Not up yet. */ }
    await wait(250);
  }
  throw new Error('The app did not start');
}

const check = (name, ok, note = '') => { results.push({ name, ok: !!ok, note }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${note ? ` :: ${note}` : ''}`); };

const work = mkdtempSync(join(tmpdir(), 'pdfy-host-'));
// A normal folder, because browsers refuse to write into system folders such as AppData.
const sample = join(root, 'tests', 'output', 'sample file.pdf');
mkdirSync(join(root, 'tests', 'output'), { recursive: true });
copyFileSync(join(root, 'tests', 'fixtures', 'normal.pdf'), sample);

const t0 = Date.now();
const child = spawn(exe, [sample], {
  env: { ...process.env, PDFY_DEBUG_PORT: String(PORT), PDFY_DEV: '1', PDFY_TEST_DATA_DIR: work },
  stdio: 'ignore',
});

function memoryOf() {
  try {
    const out = execSync(`powershell -NoProfile -Command "$ids=@(${child.pid}); $all=Get-CimInstance Win32_Process; do { $n=$all | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId } | ForEach-Object { $_.ProcessId }; $ids+=$n } while ($n); $s=0; foreach($i in $ids){ $p=Get-Process -Id $i -ErrorAction SilentlyContinue; if($p){ $s+=$p.PrivateMemorySize64 } }; [math]::Round($s/1MB)"`, { encoding: 'utf8' });
    return +out.trim();
  } catch { return -1; }
}

try {
  let page = await connect();
  const started = Date.now() - t0;

  // Left-over recovery data from an earlier test run must not get in the way.
  await wait(600);
  await page.eval(`[...document.querySelectorAll('.overlay-bg .btn')].find(b => b.textContent === 'Discard')?.click()`).catch(() => {});

  // The file given on the command line opens.
  let opened = false;
  for (let i = 0; i < 40 && !opened; i++) { opened = await page.eval(`!!document.querySelector('.doc-tab .name') && document.querySelector('.doc-tab .name').textContent === 'sample file.pdf'`).catch(() => false); await wait(250); }
  check('Opens a file passed on the command line', opened);
  await wait(1200);
  check('Draws the page', await page.eval(`!!document.querySelector('.page canvas.base') && document.querySelector('.page canvas.base').width > 100`));
  const title = await page.eval('document.title');
  check('Window title follows the document', title.includes('sample file.pdf'), title);
  check('Secure context, so saving and clipboard are allowed', await page.eval('isSecureContext'));
  check('File pickers available', await page.eval(`typeof window.showOpenFilePicker === 'function' && typeof window.showSaveFilePicker === 'function'`));
  check('Workers run', await page.eval(`new Promise(res => { const w = new Worker('theme.worker.js', { type: 'module' }); w.onmessage = () => { w.terminate(); res(true); }; w.onerror = () => res(false); const c = new OffscreenCanvas(8, 8); c.getContext('2d').fillRect(0, 0, 8, 8); c.convertToBlob().then(blob => w.postMessage({ id: 1, blob, target: null, keepPhotos: true })); })`));

  const idleMem = memoryOf();
  check('Memory with a document open', idleMem > 0, `${idleMem} MB across all processes, ${started} ms to start`);

  // Saving through the handle the window gave the page writes the real file on disk.
  const before = statSync(sample).size;
  const saved = await page.eval(`(async () => {
    const dt = new DataTransfer();
    const c = new OffscreenCanvas(300, 200);
    const x = c.getContext('2d'); x.fillStyle = '#131314'; x.fillRect(0, 0, 300, 200); x.fillStyle = '#e3e3e3'; x.fillText('hello', 20, 40);
    dt.items.add(new File([await c.convertToBlob({ type: 'image/png' })], 'a.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 900));
    (await window.__pdfy.revealCommand('Save')).click();
    await new Promise(r => setTimeout(r, 2500));
    return { title: document.title, toast: [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '), dialog: document.querySelector('.overlay-bg')?.textContent ?? null };
  })()`);
  const after = statSync(sample).size;
  check('Save writes back to the original file', after > before, `${before} to ${after} bytes. ${saved.toast}`);
  check('Document is clean after saving', !saved.title.includes('•'), saved.title);

  // Office files through the real print engine.
  for (const [file, want] of [['sample.docx', ['Quarterly report', 'bold words', 'Region', 'Long content line number 70']], ['sample.xlsx', ['Budget', 'Rent', 'Unique cell text']], ['sample.pptx', ['Deck title slide', 'Second slide title', 'Free text box']]]) {
    const b64 = readFileSync(join(root, 'tests', 'fixtures', file)).toString('base64');
    const out = await page.eval(`(async () => {
      try {
        const bytes = Uint8Array.from(atob('${b64}'), c => c.charCodeAt(0));
        const job = await __api.officeToPrint(new File([bytes], '${file}'));
        const blob = await __api.printToPdf(job);
        const o = await __api.openPdf(blob);
        let text = '';
        for (let i = 1; i <= o.pdf.numPages; i++) text += (await (await o.pdf.getPage(i)).getTextContent()).items.map(x => x.str).join(' ') + ' ';
        const pages = o.pdf.numPages;
        const first = await o.pdf.getPage(1);
        const size = first.view.map(Math.round);
        await o.close();
        return { pages, text, size, bytes: blob.size };
      } catch (e) { return { error: String(e) }; }
    })()`);
    const missing = want.filter(w => !(out.text ?? '').includes(w));
    check(`${file} to PDF with selectable text`, !out.error && !missing.length, out.error ?? `${out.pages} pages, ${out.bytes} bytes, page ${out.size}${missing.length ? `, missing ${missing}` : ''}`);
    if (file === 'sample.docx') check('Long Word files run onto more pages', out.pages >= 2, `${out.pages} pages`);
  }
  // A web page to PDF. This one needs the internet, so a failure here may just mean being offline.
  const web = await page.eval(`(async () => {
    try {
      const blob = await __api.printToPdf({ url: 'https://example.com/', widthIn: 8.27, heightIn: 11.69, marginIn: 0.4 });
      const o = await __api.openPdf(blob);
      const text = (await (await o.pdf.getPage(1)).getTextContent()).items.map(x => x.str).join(' ');
      await o.close();
      return { text: text.slice(0, 60), bytes: blob.size };
    } catch (e) { return { error: String(e) }; }
  })()`);
  check('Web page to PDF', !web.error && /Example/i.test(web.text ?? ''), web.error ?? `${web.bytes} bytes: ${web.text}`);

  // OCR files load from inside the app.
  const ocrFiles = await page.eval(`Promise.all(['vendor/ocr/tesseract.esm.min.js','vendor/ocr/worker.min.js','vendor/ocr/tesseract-core-simd-lstm.wasm.js','vendor/ocr/eng.traineddata.gz','vendor/extra/forge.min.js','vendor/extra/heic2any.min.js'].map(p => fetch(p).then(r => r.ok)))`);
  check('Optional engines are in the app folder', ocrFiles.every(Boolean), JSON.stringify(ocrFiles));

  // Make unsaved edits, wait for the recovery data, then crash the page's engine on purpose.
  await page.eval(`(async () => {
    const c = new OffscreenCanvas(200, 100);
    c.getContext('2d').fillRect(0, 0, 200, 100);
    const dt = new DataTransfer();
    dt.items.add(new File([await c.convertToBlob({ type: 'image/png' })], 'b.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  })()`);
  await wait(4000);
  const urlBefore = (await targets())[0]?.id;
  page.send('Page.crash').catch(() => {});
  await wait(500);
  let back = false, dialog = '';
  for (let i = 0; i < 80 && !back; i++) {
    await wait(250);
    try {
      page = await connect();
      dialog = await page.eval(`document.querySelector('.overlay-bg')?.textContent ?? ''`);
      back = dialog.includes('Recover');
    } catch { /* Still restarting. */ }
  }
  check('Window survives an engine crash and reloads', child.exitCode === null, `target ${urlBefore ? 'reloaded' : ''}`);
  check('Recovery is offered after the crash', back, dialog.slice(0, 120));
  if (back) {
    await page.eval(`document.querySelector('.overlay-bg .primary').click()`);
    await wait(3500);
    const restored = await page.eval(`({ tabs: [...document.querySelectorAll('.doc-tab .name')].map(x => x.textContent), dirty: document.title.includes('•'), dialog: document.querySelector('.overlay-bg')?.textContent ?? null, toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent) })`);
    check('Recovered document is back and marked unsaved', restored.tabs.length === 1 && restored.dirty, JSON.stringify(restored));
  }

  // Recent files: close the document, and it is offered on the start screen and reopens.
  const recent = await page.eval(`(async () => {
    for (const s of [...__pdfy.sessions]) { s.dirty = false; await __pdfy.closeSession(s); }
    await new Promise(r => setTimeout(r, 400));
    const row = [...document.querySelectorAll('.recent-row')].find(r => r.textContent.includes('sample file.pdf'));
    if (!row) return { listed: false };
    row.click();
    await new Promise(r => setTimeout(r, 1500));
    return { listed: true, reopened: __pdfy.session?.name, pages: __pdfy.session?.pages.length };
  })()`);
  check('Recent files are listed and reopen', recent.listed && recent.reopened === 'sample file.pdf', JSON.stringify(recent));
  await page.eval(`__pdfy.session?.markDirty()`);

  // Closing with unsaved work asks first.
  child.exitCode === null && execSync(`powershell -NoProfile -Command "(Get-Process -Id ${child.pid}).CloseMainWindow() | Out-Null"`);
  await wait(1200);
  const asked = await page.eval(`document.querySelector('.overlay-bg')?.textContent ?? ''`).catch(() => '');
  check('Closing the window asks about unsaved work', asked.includes('Save your changes'), asked.slice(0, 80));
  check('Window stays open until answered', child.exitCode === null);
  await page.eval(`[...document.querySelectorAll('.overlay-bg .btn')].find(b => b.textContent.includes("Don't save")).click()`).catch(() => {});
  for (let i = 0; i < 40 && child.exitCode === null; i++) await wait(250);
  check('Closes after answering', child.exitCode !== null, `exit code ${child.exitCode}`);
} catch (err) {
  check('Host test ran to the end', false, err.message);
} finally {
  if (child.exitCode === null) { try { child.kill(); } catch { /* Gone. */ } }
  await wait(800);
  try { rmSync(work, { recursive: true, force: true }); } catch { /* A leftover temp file is harmless. */ }
}
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
