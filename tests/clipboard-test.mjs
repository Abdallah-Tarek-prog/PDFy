// Real Ctrl+V from the real Windows clipboard, in the real PDFy.exe. Saves the clipboard first and puts
// it back afterwards.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const exe = join(root, 'app', 'PDFy.exe');
const PORT = 9335;
const wait = ms => new Promise(r => setTimeout(r, ms));
const work = mkdtempSync(join(tmpdir(), 'pdfy-clip-'));
const saveImage = join(work, 'saved.png'), saveText = join(work, 'saved.txt');
const results = [];
const check = (name, ok, note = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${note ? ` :: ${note}` : ''}`); };

const ps = script => execFileSync('powershell.exe', ['-NoProfile', '-STA', '-Command', `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ${script}`], { encoding: 'utf8' });

// Save what is on the clipboard now.
ps(`$c=[Windows.Forms.Clipboard]; if($c::ContainsImage()){ $c::GetImage().Save('${saveImage}') } elseif($c::ContainsText()){ [IO.File]::WriteAllText('${saveText}', $c::GetText()) }`);

function restore() {
  if (existsSync(saveImage)) ps(`[Windows.Forms.Clipboard]::SetImage([Drawing.Image]::FromFile('${saveImage}'))`);
  else if (existsSync(saveText)) ps(`[Windows.Forms.Clipboard]::SetText([IO.File]::ReadAllText('${saveText}'))`);
  else ps('[Windows.Forms.Clipboard]::Clear()');
}

// A dark screenshot-like picture, copied the way the Snipping Tool does.
const setPicture = () => ps(`$b=New-Object Drawing.Bitmap 640,360; $g=[Drawing.Graphics]::FromImage($b); $g.Clear([Drawing.Color]::FromArgb(19,19,20)); $f=New-Object Drawing.Font 'Segoe UI',16; $g.DrawString('Copied from a dark app',$f,(New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(227,227,227))),30,40); $g.DrawString('A blue link',$f,(New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(168,199,250))),30,90); $g.Dispose(); [Windows.Forms.Clipboard]::SetImage($b)`);
const setWords = () => ps(`[Windows.Forms.Clipboard]::SetText('Words from the clipboard')`);

const child = spawn(exe, [], { env: { ...process.env, PDFY_DEBUG_PORT: String(PORT), PDFY_DEV: '1' }, stdio: 'ignore' });
let ws;
try {
  let target;
  for (let i = 0; i < 80 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(t => t.type === 'page' && t.url.includes('pdfy.local')); } catch { /* Starting. */ }
    await wait(250);
  }
  if (!target) throw new Error('The app did not start');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, m => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  await send('Page.enable');
  await send('Page.bringToFront');
  for (let i = 0; i < 40; i++) { if (await evaluate('!!window.__pdfy').catch(() => false)) break; await wait(150); }
  await wait(500);
  await evaluate(`[...document.querySelectorAll('.overlay-bg .btn')].find(b => b.textContent === 'Discard')?.click()`);
  await evaluate(`document.querySelector('.viewer')?.focus()`);

  const press = async () => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 });
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2, commands: ['paste'] });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
  };

  setPicture();
  await press();
  await wait(1500);
  let state = await evaluate(`({ tabs: __pdfy.sessions.map(s => s.name), annots: __pdfy.session?.pages[0].annots.map(a => a.kind), dark: __pdfy.session?.pages[0].annots[0]?.image?.analysis?.isDark, width: __pdfy.session?.pages[0].annots[0]?.image?.width, bar: document.querySelector('.image-bar')?.style.display })`);
  check('Ctrl+V with a copied picture creates a document', state.tabs?.length === 1 && state.annots?.[0] === 'image', JSON.stringify(state));
  check('The pasted picture is the right size and seen as dark', state.width === 640 && state.dark === true);
  check('The theme bar appears', state.bar === 'flex');

  // Convert through the real button.
  await evaluate(`[...document.querySelectorAll('.image-bar .seg-btn')].find(b => b.textContent === 'Light').click()`);
  await wait(900);
  state = await evaluate(`(async () => {
    const a = __pdfy.session.pages[0].annots[0];
    const bmp = await createImageBitmap(a.image.blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d');
    c.drawImage(bmp, 0, 0);
    return { theme: a.image.theme, corner: [...c.getImageData(630, 350, 1, 1).data].slice(0, 3) };
  })()`);
  check('Clicking Light converts the real pasted picture', state.theme === 'light' && state.corner.every(v => v >= 250), JSON.stringify(state));

  // A second picture lands below the first.
  setPicture();
  await press();
  await wait(1200);
  const second = await evaluate(`__pdfy.session.pages[0].annots.filter(a => a.kind === 'image').map(a => Math.round(a.rect[1]))`);
  check('A second paste lands below the first', second.length === 2 && second[1] < second[0], JSON.stringify(second));

  // Words.
  setWords();
  await press();
  await wait(600);
  const words = await evaluate(`__pdfy.session.pages[0].annots.filter(a => a.kind === 'text').map(a => a.text)`);
  check('Ctrl+V with copied words makes a text box', words[0] === 'Words from the clipboard', JSON.stringify(words));

  // Close, discarding the test document.
  await evaluate(`__pdfy.sessions.forEach(s => { s.dirty = false; })`);
} catch (err) {
  check('Clipboard test ran to the end', false, err.message);
} finally {
  try { restore(); console.log('Clipboard put back.'); } catch (err) { console.log('Could not restore the clipboard:', err.message); }
  try { child.kill(); } catch { /* Gone. */ }
  await wait(800);
  try { rmSync(work, { recursive: true, force: true }); } catch { /* A leftover temp file is harmless. */ }
}
const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
