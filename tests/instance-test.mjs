// Tests the real PDFy.exe for: one window only (later launches become tabs), A–Z order for files
// opened together or dropped together, the crash log, and the minimise button.
// Uses its own data folder, so it runs even while the user's own PDFy is open.
// PDFY_EXE=<path> tests another build than app\PDFy.exe.
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const exe = process.env.PDFY_EXE ?? join(root, 'app', 'PDFy.exe');
const PORT = 9341;
const wait = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, note = '') => { results.push(!!ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${note ? ` :: ${note}` : ''}`); };

class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.addEventListener('message', e => { const m = JSON.parse(e.data); this.pending.get(m.id)?.(m); this.pending.delete(m.id); }); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${method} timed out`)), 20000);
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
  for (let i = 0; i < 120; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page' && t.url.includes('pdfy.local'));
      if (list[0]) {
        const ws = new WebSocket(list[0].webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        return new Page(ws);
      }
    } catch { /* Not up yet. */ }
    await wait(250);
  }
  throw new Error('The app did not start');
}

const work = mkdtempSync(join(tmpdir(), 'pdfy-instance-'));
const env = { ...process.env, PDFY_DEV: '1', PDFY_TEST_DATA_DIR: work };
const out = join(root, 'tests', 'output', 'instance');
mkdirSync(out, { recursive: true });
const file = name => { const p = join(out, name); copyFileSync(join(root, 'tests', 'fixtures', 'normal.pdf'), p); return p; };
const [p10, p2, b, a] = ['Part 10.pdf', 'Part 2.pdf', 'b.pdf', 'a.pdf'].map(file);
const logText = () => existsSync(join(work, 'pdfy.log')) ? readFileSync(join(work, 'pdfy.log'), 'utf8') : '';
const ps = script => execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
const exeCount = () => +ps(`@(Get-CimInstance Win32_Process -Filter "Name='PDFy.exe'" | Where-Object { $_.ExecutablePath -eq '${exe.replace(/'/g, "''")}' }).Count`);
const launch = (args, extra = {}) => spawn(exe, args, { env: { ...env, ...extra }, stdio: 'ignore' });
const exited = (child, ms) => new Promise(res => { if (child.exitCode !== null) return res(true); const t = setTimeout(() => res(false), ms); child.on('exit', () => { clearTimeout(t); res(true); }); });
const tabs = page => page.eval(`[...document.querySelectorAll('.doc-tab .name')].map(n => n.textContent)`);
async function until(page, expr, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await page.eval(expr).catch(() => false)) return true; await wait(200); } return false; }

let main;
try {
  main = launch([], { PDFY_DEBUG_PORT: String(PORT) });
  let page = await connect();
  await wait(800);
  await page.eval(`[...document.querySelectorAll('.overlay-bg .btn')].find(b => b.textContent === 'Discard')?.click()`).catch(() => {});

  // 1. A second launch hands its file to the open window and quits.
  const t0 = Date.now();
  const second = launch([p10]);
  const quit = await exited(second, 8000);
  check('Second launch quits instead of opening a window', quit, `${Date.now() - t0} ms`);
  check('The file opens as a tab in the first window', await until(page, `[...document.querySelectorAll('.doc-tab .name')].some(n => n.textContent === 'Part 10.pdf')`));
  check('Only one PDFy is running', exeCount() === 1, `${exeCount()} running`);

  // 2. Three files opened together from Explorer (three launches at once) arrive A–Z.
  const batch = [p2, b, a].map(p => launch([p]));
  await Promise.all(batch.map(c => exited(c, 8000)));
  await until(page, `document.querySelectorAll('.doc-tab').length >= 4`);
  await wait(1500);
  const order1 = await tabs(page);
  check('Separate and batch opens share natural A–Z tab order', JSON.stringify(order1) === JSON.stringify(['a.pdf', 'b.pdf', 'Part 2.pdf', 'Part 10.pdf']), order1.join(', '));
  check('Still only one PDFy running', exeCount() === 1);

  // 3. Opening a file that is already open switches to its tab instead of adding a copy.
  await exited(launch([a]), 8000);
  await wait(1200);
  const order2 = await tabs(page);
  check('Opening an already-open file adds no tab', order2.length === 4, order2.join(', '));
  check('…and switches to it', await page.eval(`document.querySelector('.doc-tab.active .name')?.textContent === 'a.pdf'`));

  // 4. Dropping several files opens them A–Z.
  const pdf = readFileSync(join(root, 'tests', 'fixtures', 'normal.pdf')).toString('base64');
  await page.eval(`(async () => {
    const bytes = Uint8Array.from(atob('${pdf}'), c => c.charCodeAt(0));
    const dt = new DataTransfer();
    for (const n of ['zeta.pdf', 'Doc 10.pdf', 'alpha.pdf', 'Doc 9.pdf']) dt.items.add(new File([bytes], n, { type: 'application/pdf' }));
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  })()`);
  await until(page, `document.querySelectorAll('.doc-tab').length >= 8`);
  await wait(800);
  const dropped = await tabs(page);
  check('Dropped files merge into the same A–Z tab order', JSON.stringify(dropped) === JSON.stringify(['a.pdf', 'alpha.pdf', 'b.pdf', 'Doc 9.pdf', 'Doc 10.pdf', 'Part 2.pdf', 'Part 10.pdf', 'zeta.pdf']), dropped.join(', '));

  // Two panes also work in the real WebView2 host, with independent selected pages.
  await page.eval(`window.__pdfy.toggleSplitView(); 1`);
  check('Side by side renders both PDFs in the Windows app', await until(page, `window.__pdfy.panes.length === 2 && window.__pdfy.panes.every(p => [...p.viewer.views.values()].some(v => v.canvas?.width > 0))`));
  await page.eval(`(() => { const a=window.__pdfy; a.panes[0].viewer.setScale(1.2); a.panes[0].viewer.goTo(2); a.focusPane(1); a.viewer.setScale(1.4); a.viewer.goTo(5); })(); 1`);
  await wait(300);
  check('Windows pane controls keep pages and zoom independent', await page.eval(`window.__pdfy.panes[0].viewer.current === 2 && window.__pdfy.panes[0].viewer.scale === 1.2 && window.__pdfy.panes[1].viewer.current === 5 && window.__pdfy.panes[1].viewer.scale === 1.4 && document.querySelector('[aria-label="Page number"]').value === '6'`));
  await page.eval(`window.__pdfy.toggleSplitView(); 1`);
  check('Merging Windows panes keeps all document tabs', await page.eval(`!window.__pdfy.splitView && window.__pdfy.sessions.length === 8 && window.__pdfy.panes[1].el.hidden`));

  await page.eval(`(() => { const a=window.__pdfy; a.viewer.setScale(3); const sc=a.viewer.scroller,r=sc.getBoundingClientRect(); sc.scrollTop=200; window.__scrollStart=sc.scrollTop; const x=r.left+r.width/2,y=r.top+r.height/2; sc.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:1,buttons:4,pointerType:'mouse',clientX:x,clientY:y})); window.dispatchEvent(new PointerEvent('pointerup',{button:1,pointerType:'mouse',clientX:x,clientY:y})); window.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:x,clientY:y+100})); })(); 1`);
  await wait(300);
  check('Wheel-click scrolling works after release in the Windows app', await page.eval(`window.__pdfy.viewer.scroller.scrollTop>window.__scrollStart+50 && !!document.querySelector('.auto-scroll-origin')`));
  await page.eval(`window.dispatchEvent(new PointerEvent('pointerdown',{button:1,pointerType:'mouse',cancelable:true})); 1`);
  check('A second wheel click stops Windows auto-scroll', await page.eval(`!document.querySelector('.auto-scroll-origin')`));
  await page.eval(`(() => { const a=window.__pdfy; a.viewer.setScale(1); a.viewer.goTo(0); a.setMode('edit'); a.tools.setTool('markdown'); a.tools.openEditor(a.viewer.views.get(a.session.pages[0].id),{...a.tools.base('text','markdown'),rect:[30,400,330,650],markdown:true,text:'**Windows note**'},true); })(); 1`);
  check('The formatted Markdown toolbar works in Windows WebView2', await page.eval(`!!document.querySelector('.markdown-editor [aria-label="Bold (Ctrl+B)"]') && document.querySelector('.md-editable strong')?.textContent==='Windows note'`));
  await page.eval(`document.querySelector('.md-done').click(); window.__pdfy.tools.settle().then(()=>{for(const s of window.__pdfy.sessions)s.dirty=false;});`);

  // 5. Minimise: the window must not slide sideways first.
  const hwnd = ps(`(Get-Process -Id ${main.pid}).MainWindowHandle`);
  const sampler = join(work, 'sample.ps1');
  writeFileSync(sampler, `
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r); [DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h); public struct RECT { public int L, T, R, B; }'
$h = [System.IntPtr]::new([long]${hwnd}); $seen = @(); $sw = [Diagnostics.Stopwatch]::StartNew()
while ($sw.ElapsedMilliseconds -lt 1500) { $r = New-Object W.U+RECT; [void][W.U]::GetWindowRect($h, [ref]$r); $s = "$($r.L),$($r.T),$($r.R),$($r.B),$([W.U]::IsIconic($h))"; if ($seen[-1] -ne $s) { $seen += $s }; Start-Sleep -Milliseconds 5 }
$seen -join ' ; '`);
  const sampling = new Promise(res => { const c = spawn('powershell', ['-NoProfile', '-File', sampler], { stdio: ['ignore', 'pipe', 'ignore'] }); let s = ''; c.stdout.on('data', d => s += d); c.on('exit', () => res(s.trim())); });
  await wait(700);
  await page.eval(`document.querySelector('.win-btn[title="Minimise"]').click()`);
  const trace = (await sampling).split(' ; ');
  const placed = trace.filter(s => !s.endsWith('True'));
  check('Minimise goes straight to the taskbar', trace.at(-1).endsWith('True') && placed.length === 1, trace.join(' → '));

  // 6. Crash log: page errors, engine crash with memory, unclean end, clean end.
  await page.eval(`setTimeout(() => { throw new Error('test page error') }, 0); 1`);
  await wait(1000);
  check('Log notes the start', /Started PDFy .* computer memory/.test(logText()));
  check('Page errors reach the log', /Page: Uncaught.*test page error/.test(logText()));
  await page.eval(`window.chrome.webview.postMessage({ type: 'win', action: 'restore' })`);
  await wait(1000);
  page.send('Page.crash').catch(() => {});
  for (let i = 0; i < 30 && !logText().includes('Engine failed'); i++) await wait(500);
  check('Engine crash is logged with its meaning and memory', /Engine failed: .*code 0x[0-9A-F]{8} \(.*\).*Last memory reading: PDFy \d/.test(logText()), logText().split('\n').filter(l => l.includes('Engine failed')).at(-1));

  main.kill();
  await exited(main, 5000);
  main = launch([], { PDFY_DEBUG_PORT: String(PORT) });
  page = await connect();
  await wait(2500);
  check('A session that did not close normally is reported next start', /ended without closing normally/.test(logText()));
  await page.eval(`[...document.querySelectorAll('.overlay-bg .btn')].find(b => b.textContent === 'Discard')?.click()`).catch(() => {});
  await page.eval(`document.querySelector('.win-btn.close').click()`).catch(() => {});
  const closed = await exited(main, 10000);
  check('Closing normally is logged', closed && /Closed normally\./.test(logText()) && !existsSync(join(work, 'session.open')));
  console.log('\nLog:\n' + logText());
} catch (e) {
  check('Test ran to the end', false, e.message);
} finally {
  if (main && main.exitCode === null) { try { main.kill(); } catch { /* Gone. */ } }
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
