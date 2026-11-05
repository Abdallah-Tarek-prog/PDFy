// Tests the study tools in the real PDFy.exe, where notes, equations and any-font text are printed by
// the engine into real vector text. Also checks the font list from Windows and the reference window.
// Copy dist to app/web first.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const exe = join(root, 'app', 'PDFy.exe');
const PORT = 9335;
const wait = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, note = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${note ? ` :: ${note}` : ''}`); };

const targets = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page');

async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const t = (await targets()).find(x => x.url.includes('pdfy.local/index.html'));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        let id = 0;
        const pending = new Map();
        ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
        return async expression => {
          const n = ++id;
          const r = await new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('timed out')), 120000);
            pending.set(n, m => { clearTimeout(timer); res(m); });
            ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }));
          });
          if (r.error) throw new Error(r.error.message);
          if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
          return r.result.result.value;
        };
      }
    } catch { /* Starting. */ }
    await wait(250);
  }
  throw new Error('The app did not start');
}

const child = spawn(exe, [], { env: { ...process.env, PDFY_DEBUG_PORT: String(PORT), PDFY_DEV: '1' }, stdio: 'ignore' });
try {
  const run = await connect();
  for (let i = 0; i < 60 && !(await run('!!window.__pdfy').catch(() => false)); i++) await wait(250);
  await wait(800);
  await run(`[...document.querySelectorAll('.overlay-bg .btn')].find(b => b.textContent === 'Discard')?.click()`).catch(() => {});

  const fonts = await run('window.__api.installedFonts().then(f => f.length)');
  check('Every installed Windows font is listed', fonts > 40, `${fonts} font families`);
  const voices = await run(`Promise.all(['en-GB', 'en-US', 'ar'].map(l => window.__api.hasVoice(l)))`);
  console.log(`info Windows voices on this PC: UK English ${voices[0] ? 'yes' : 'no'}, US English ${voices[1] ? 'yes' : 'no'}, Arabic ${voices[2] ? 'yes' : 'no'}`);

  const out = await run(`(async () => {
    const app = window.__pdfy, A = window.__api;
    const s = app.newDocument();
    await new Promise(r => setTimeout(r, 400));
    const page = s.pages[0];
    const NOTE = '# Heading one\\nSome **bold** and ==highlighted== text, $a^2+b^2=c^2$.\\n\\n> [!tip] Remember\\n> A callout.\\n\\nمرحبا بالعالم، هذه ملاحظة.';
    const note = await A.fitMarkdown({ id: 'n1', kind: 'text', markdown: true, mdTheme: 'obsidian-dark', rect: [60, 400, 330, 760], color: '#111111', opacity: 1, width: 0, fill: null, fontSize: 12, text: NOTE });
    const m = await A.texToSvg('\\\\frac{-b \\\\pm \\\\sqrt{b^2-4ac}}{2a}', true);
    const size = A.mathBoxSize(m, 20);
    const math = { id: 'm1', kind: 'math', rect: [360, 640, 360 + size.w, 640 + size.h], color: '#1a56db', opacity: 1, width: 0, fill: null, fontSize: 20, latex: '\\\\frac{-b \\\\pm \\\\sqrt{b^2-4ac}}{2a}', mathSvg: m.svg, mathDisplay: true };
    const text = { id: 't1', kind: 'text', rect: [360, 500, 560, 560], color: '#7048e8', textColor: '#7048e8', opacity: 1, width: 0, fill: null, fontSize: 16, fontName: 'Georgia', text: 'Georgia text with عربي and 123' };
    s.addAnnots(page, [note, math, text]);
    const t0 = performance.now();
    const boxes = [];
    for (const a of [note, math, text]) {
      const b = await A.boxForSave(a);
      boxes.push({ id: a.id, vector: !!b.vectorPdf, picture: !!b.textImage, bytes: b.vectorPdf?.byteLength ?? 0 });
    }
    const printMs = Math.round(performance.now() - t0);
    const t1 = performance.now();
    const again = await A.boxForSave(note);
    const cachedMs = Math.round(performance.now() - t1);
    const kept = await A.buildFile(s);
    const flat = await A.buildFile(s, { flattenAnnots: true });
    const open = await A.openPdf(flat.blob, async () => null);
    const words = (await (await open.pdf.getPage(1)).getTextContent()).items.map(i => i.str).join(' ');
    await open.close();
    const reopened = await A.openPdf(kept.blob, async () => null);
    const list = await (await reopened.pdf.getPage(1)).getAnnotations({ intent: 'display' });
    await reopened.close();
    const bytes = new Uint8Array(await kept.blob.arrayBuffer());
    let bin = ''; for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
    s.dirty = false;
    return { boxes, printMs, cachedMs, againVector: !!again.vectorPdf, words, annots: list.map(a => a.subtype), size: kept.blob.size, flatSize: flat.blob.size, keptB64: btoa(bin) };
  })()`);
  mkdirSync(join(root, 'tests', 'output'), { recursive: true });
  writeFileSync(join(root, 'tests', 'output', 'study-exe-output.pdf'), Buffer.from(out.keptB64, 'base64'));
  for (const b of out.boxes) check(`Saved as real vector text, not a picture: ${b.id}`, b.vector && !b.picture, `${b.bytes} bytes`);
  check('Printing three boxes is quick', out.printMs < 6000, `${out.printMs} ms for three, ${out.cachedMs} ms when unchanged`);
  check('Note text is real, selectable text in the saved file', /Heading one/.test(out.words) && /Remember/.test(out.words), out.words.slice(0, 140));
  // The print engine writes Arabic as its joined letter shapes, so copied text comes out in those shapes.
  check('Arabic in a note is real text, not a picture', /[؀-ۿﭐ-﷿ﹰ-﻿]/.test(out.words));
  check('Text in a chosen font is real text', /Georgia text/.test(out.words));
  check('Boxes stay editable annotations when not flattened', out.annots.filter(t => t === 'FreeText').length === 2 && out.annots.includes('Stamp'), out.annots.join(', '));
  check('File size stays reasonable', out.size < 400000, `${Math.round(out.size / 1024)} KB with three boxes`);

  // The publishers' pages, read by the Windows app, with their own recordings.
  const pages = await run(`(async () => {
    const A = window.__api, out = {};
    for (const id of ['cambridge', 'oxford', 'longman']) {
      const t0 = performance.now();
      const r = await A.lookUpOnline(id, 'water');
      const b = r?.blocks[0];
      const rec = b?.prons.find(p => p.audio)?.audio;
      out[id] = { ms: Math.round(performance.now() - t0), hw: b?.headword, senses: r?.blocks.reduce((n, x) => n + x.senses.length, 0), arabic: r?.blocks.some(x => x.senses.some(s => /[\u0600-\u06FF]/.test(s.arabic ?? ''))), plays: rec ? await A.playRecording(rec, 8000) : false };
    }
    let refused = false;
    try { await A.lookUpOnline('oxford', 'https://example.com/'); } catch { refused = true; }
    out.refused = refused;
    return out;
  })()`);
  for (const id of ['cambridge', 'oxford', 'longman']) {
    const p = pages[id];
    check(`${id} page read by the app`, p.hw === 'water' && p.senses >= 2, `${p.senses} meanings in ${p.ms} ms${id === 'cambridge' ? (p.arabic ? ', with Arabic' : ', NO Arabic') : ''}`);
    check(`${id} recording plays`, p.plays);
  }
  check('Other sites are refused', pages.refused);

  // The publishers' pages open in PDFy's own small window.
  await run(`window.chrome.webview.postMessage({ type: 'reference', url: 'https://www.ldoceonline.com/dictionary/water', title: 'Longman: water' })`);
  let ref = null;
  for (let i = 0; i < 40 && !ref; i++) { await wait(250); ref = (await targets()).find(t => /ldoceonline/.test(t.url)); }
  check('Longman opens in the reference window', ref, ref?.url ?? 'not seen');
} catch (err) {
  check('Runner', false, err.message);
} finally {
  child.kill();
}
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
