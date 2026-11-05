// Compares two PDFs page by page: what the words say, and how the page looks.

import { openPdf, renderToCanvas, type PDFDocumentProxy } from '../core/engine';
import { makeViewport, type PageRef } from '../core/model';
import { clear, h } from '../ui/dom';
import { openDialog, progressDialog, askPassword } from '../ui/dialogs';
import { linesOf } from './convert';

export interface DiffOp { type: 'same' | 'add' | 'del'; text: string }

/** Word-level difference. The common start and end are trimmed first, which keeps it fast. */
export function diffWords(aText: string, bText: string): DiffOp[] {
  const a = aText.split(/\s+/).filter(Boolean), b = bText.split(/\s+/).filter(Boolean);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let ea = a.length, eb = b.length;
  while (ea > start && eb > start && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const out: DiffOp[] = [];
  if (start) out.push({ type: 'same', text: a.slice(0, start).join(' ') });
  const n = ea - start, m = eb - start;
  if (n * m > 4_000_000) {
    // Too different to line up word by word within a sensible memory limit.
    if (n) out.push({ type: 'del', text: a.slice(start, ea).join(' ') });
    if (m) out.push({ type: 'add', text: b.slice(start, eb).join(' ') });
  } else if (n || m) {
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = a[start + i] === b[start + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    const push = (type: DiffOp['type'], text: string) => {
      const last = out[out.length - 1];
      if (last?.type === type) last.text += ` ${text}`; else out.push({ type, text });
    };
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) { push('same', a[start + i]); i++; j++; }
      else if (j < m && (i === n || dp[i * w + j + 1] >= dp[(i + 1) * w + j])) { push('add', b[start + j]); j++; }
      else { push('del', a[start + i]); i++; }
    }
  }
  if (ea < a.length) {
    const tail = a.slice(ea).join(' ');
    const last = out[out.length - 1];
    if (last?.type === 'same') last.text += ` ${tail}`; else out.push({ type: 'same', text: tail });
  }
  return out;
}

const pageText = async (pdf: PDFDocumentProxy, i: number) => (await linesOf(pdf, i)).map(l => l.text).join(' ');

async function draw(pdf: PDFDocumentProxy, i: number, scale: number): Promise<HTMLCanvasElement> {
  const page = await pdf.getPage(i + 1);
  const vp = makeViewport(page.view, page.rotate, scale);
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width);
  c.height = Math.round(vp.height);
  const ref = { view: [...page.view], baseRotate: page.rotate, rotate: 0, crop: null } as unknown as PageRef;
  await renderToCanvas(page, ref, c, scale, undefined, undefined, false).promise;
  page.cleanup();
  return c;
}

/** Marks differing pixels in red over a faded copy of the new page. */
function diffCanvas(a: HTMLCanvasElement, b: HTMLCanvasElement): { canvas: HTMLCanvasElement; changed: number } {
  const w = Math.max(a.width, b.width), ht = Math.max(a.height, b.height);
  const make = (src: HTMLCanvasElement) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = ht;
    const x = c.getContext('2d', { willReadFrequently: true })!;
    x.fillStyle = '#fff'; x.fillRect(0, 0, w, ht);
    x.drawImage(src, 0, 0);
    return x.getImageData(0, 0, w, ht);
  };
  const da = make(a), db = make(b);
  const out = document.createElement('canvas');
  out.width = w; out.height = ht;
  const ctx = out.getContext('2d')!;
  const img = ctx.createImageData(w, ht);
  let changed = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const d = Math.abs(da.data[i] - db.data[i]) + Math.abs(da.data[i + 1] - db.data[i + 1]) + Math.abs(da.data[i + 2] - db.data[i + 2]);
    if (d > 48) {
      changed++;
      img.data[i] = 229; img.data[i + 1] = 72; img.data[i + 2] = 77;
    } else {
      const g = 255 - (255 - (db.data[i] + db.data[i + 1] + db.data[i + 2]) / 3) * 0.35;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = g;
    }
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: out, changed };
}

export async function compareFiles(aBlob: Blob, aName: string, bBlob: Blob, bName: string) {
  const prog = progressDialog('Comparing');
  const A = await openPdf(aBlob, retry => askPassword(aName, retry));
  let B;
  try { B = await openPdf(bBlob, retry => askPassword(bName, retry)); }
  catch (err) { prog.close(); await A.close(); throw err; }
  const total = Math.max(A.pdf.numPages, B.pdf.numPages);
  const rows: { index: number; ops: DiffOp[]; added: number; removed: number; onlyIn?: 'a' | 'b' }[] = [];
  try {
    for (let i = 0; i < total; i++) {
      if (prog.cancelled()) break;
      prog.set(i / total, `Page ${i + 1} of ${total}`);
      if (i >= A.pdf.numPages || i >= B.pdf.numPages) {
        rows.push({ index: i, ops: [], added: 0, removed: 0, onlyIn: i >= A.pdf.numPages ? 'b' : 'a' });
        continue;
      }
      const ops = diffWords(await pageText(A.pdf, i), await pageText(B.pdf, i));
      const count = (t: DiffOp['type']) => ops.filter(o => o.type === t).reduce((s, o) => s + o.text.split(' ').length, 0);
      rows.push({ index: i, ops, added: count('add'), removed: count('del') });
    }
  } finally {
    prog.close();
  }

  const changed = rows.filter(r => r.added || r.removed || r.onlyIn);
  const detail = h('div', { class: 'cmp-detail' });
  const summary = changed.length
    ? `${changed.length} of ${total} pages differ in their text.`
    : `No text differences across ${total} pages. Use "Show pages" to check how they look.`;

  const show = async (r: typeof rows[number]) => {
    clear(detail);
    detail.append(h('h3', null, `Page ${r.index + 1}`));
    if (r.onlyIn) {
      detail.append(h('p', null, `This page exists only in "${r.onlyIn === 'a' ? aName : bName}".`));
      return;
    }
    const words = h('p', { class: 'cmp-words', dir: 'auto' }, ...r.ops.map(o => (o.type === 'same'
      ? h('span', null, ` ${o.text.length > 400 ? `${o.text.slice(0, 180)} … ${o.text.slice(-180)}` : o.text} `)
      : h(o.type === 'add' ? 'ins' : 'del', null, ` ${o.text} `))));
    detail.append(words);
    const holder = h('div', { class: 'cmp-pages' }, 'Drawing pages…');
    detail.append(holder);
    const a = await draw(A.pdf, r.index, 1), b = await draw(B.pdf, r.index, 1);
    const d = diffCanvas(a, b);
    clear(holder);
    const fig = (c: HTMLCanvasElement, t: string) => h('figure', null, h('figcaption', null, t), c);
    holder.append(fig(a, aName), fig(b, bName), fig(d.canvas, `${d.changed.toLocaleString()} pixels differ`));
  };

  const list = h('div', { class: 'cmp-list' }, ...rows.map(r => h('button', {
    class: `cmp-row${r.added || r.removed || r.onlyIn ? ' changed' : ''}`,
    onclick: () => void show(r),
  }, `Page ${r.index + 1}`, h('small', null, r.onlyIn ? 'one file only' : r.added || r.removed ? `+${r.added} −${r.removed}` : 'same'))));

  const body = h('div', null, h('p', null, summary), h('div', { class: 'cmp-grid' }, list, detail));
  if (rows.length) void show(changed[0] ?? rows[0]);
  await openDialog('Compare', body, [{ label: 'Close', value: true, primary: true }], true, undefined, true);
  await A.close();
  await B.close();
}
