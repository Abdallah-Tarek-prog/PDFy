// Reads words out of a picture, then lets you click them. You drag over a pasted image, a scan or any
// part of a page. Each word found becomes a clickable spot right where it sits in the picture.

import { renderToCanvas } from '../core/engine';
import { toScreen, viewportFor, type Annot, type PageRef } from '../core/model';
import type { Session } from '../core/session';
import { sourceOcg } from '../features/images';
import { h, toast } from '../ui/dom';
import type { PageView } from '../view/viewer';
import { showDictionary } from './dictpopup';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FoundWord { text: string; x0: number; y0: number; x1: number; y1: number; line: number }

/** Draws the chosen part of the page, with pasted images on top, as the eye sees it. */
export async function regionCanvas(session: Session, page: PageRef, rect: number[], k = 3): Promise<{ canvas: HTMLCanvasElement; left: number; top: number; scale: number }> {
  const vp1 = viewportFor(page, 1);
  const a = toScreen(vp1, rect[0], rect[1]), b = toScreen(vp1, rect[2], rect[3]);
  const left = Math.max(0, Math.min(a[0], b[0])), right = Math.min(vp1.width, Math.max(a[0], b[0]));
  const top = Math.max(0, Math.min(a[1], b[1])), bottom = Math.min(vp1.height, Math.max(a[1], b[1]));
  const w = right - left, ht = bottom - top;
  const scale = Math.min(k, Math.sqrt(14_000_000 / (w * ht || 1)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(ht * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (page.source) {
    const pdfPage = await session.pdfPage(page);
    await renderToCanvas(pdfPage, page, canvas, scale, { x: left * scale, y: top * scale }, sourceOcg(session, page)).promise;
  }
  const images = page.annots.filter(x => x.kind === 'image' && x.image);
  for (const annot of images) await drawImageOn(ctx, annot, vp1, left, top, scale);
  return { canvas, left, top, scale };
}

async function drawImageOn(ctx: CanvasRenderingContext2D, a: Annot, vp1: ReturnType<typeof viewportFor>, left: number, top: number, scale: number) {
  const bitmap = await createImageBitmap(a.image!.blob);
  try {
    const cx = (a.rect[0] + a.rect[2]) / 2, cy = (a.rect[1] + a.rect[3]) / 2;
    const [sx, sy] = toScreen(vp1, cx, cy);
    const w = a.rect[2] - a.rect[0], ht = a.rect[3] - a.rect[1];
    // Same angle the page view uses: page rotation is already part of how the box is stored.
    const m = vp1.m;
    const ang = ((a.angle ?? 0) * Math.PI) / 180;
    const ux = Math.cos(ang), uy = Math.sin(ang);
    const screenAngle = Math.atan2(m[1] * ux + m[3] * uy, m[0] * ux + m[2] * uy);
    ctx.save();
    ctx.translate((sx - left) * scale, (sy - top) * scale);
    ctx.rotate(screenAngle);
    ctx.drawImage(bitmap, (-w / 2) * scale, (-ht / 2) * scale, w * scale, ht * scale);
    ctx.restore();
  } finally {
    bitmap.close();
  }
}

/** Light text on a dark screenshot reads far better when flipped first. */
export function prepareForReading(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  let sum = 0, n = 0;
  const step = Math.max(4, Math.floor(d.length / 200000) * 4);
  for (let i = 0; i < d.length; i += step) { sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
  if (sum / (n || 1) >= 110) return false;
  for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; }
  ctx.putImageData(img, 0, 0);
  return true;
}

let worker: any = null;
let workerLang = '';
let idle = 0;

async function getWorker(lang: string) {
  clearTimeout(idle);
  if (worker && workerLang === lang) return worker;
  if (worker) { await worker.terminate(); worker = null; }
  const url = new URL('vendor/ocr/tesseract.esm.min.js', document.baseURI).href;
  const mod: any = await import(/* @vite-ignore */ url);
  const base = new URL('vendor/ocr/', document.baseURI).href;
  worker = await (mod.default ?? mod).createWorker(lang, 1, {
    workerPath: `${base}worker.min.js`, corePath: `${base}tesseract-core-simd-lstm.wasm.js`, langPath: base,
    gzip: true, cacheMethod: 'none', logger: () => {},
  });
  workerLang = lang;
  return worker;
}

/** The reader uses about 100 MB, so it is let go shortly after the last use. */
function releaseSoon() {
  clearTimeout(idle);
  idle = window.setTimeout(() => {
    void worker?.terminate();
    worker = null;
  }, 45000);
}

let queue: Promise<unknown> = Promise.resolve();

/** Reads are done one after another, so a language change never stops a read halfway. */
export function readWords(canvas: HTMLCanvasElement, lang = 'eng'): Promise<FoundWord[]> {
  const run = queue.then(() => readNow(canvas, lang));
  queue = run.catch(() => {});
  return run;
}

async function readNow(canvas: HTMLCanvasElement, lang: string): Promise<FoundWord[]> {
  prepareForReading(canvas);
  const w = await getWorker(lang);
  try {
    const { data } = await w.recognize(canvas, {}, { blocks: true });
    const out: FoundWord[] = [];
    let line = 0;
    for (const block of data.blocks ?? []) for (const para of block.paragraphs ?? []) for (const ln of para.lines ?? []) {
      line++;
      for (const word of ln.words ?? []) {
        if (!word.text?.trim() || (word.confidence ?? 100) < 35) continue;
        out.push({ text: word.text, x0: word.bbox.x0, y0: word.bbox.y0, x1: word.bbox.x1, y1: word.bbox.y1, line });
      }
    }
    return out;
  } finally {
    releaseSoon();
  }
}

const hasLetter = (t: string) => /\p{L}/u.test(t);

export function wordsToText(words: FoundWord[]): string {
  const lines: string[] = [];
  let at = -1;
  for (const w of words) {
    if (w.line !== at) { lines.push(w.text); at = w.line; } else lines[lines.length - 1] += ` ${w.text}`;
  }
  return lines.join('\n');
}

let activeLayer: { close(): void } | null = null;
export function closeWordLayer() { activeLayer?.close(); }

/** Shows the words where they sit on the page. Positions are shares of the page, so zooming is fine. */
export function showWordLayer(v: PageView, words: FoundWord[], place: { left: number; top: number; scale: number }) {
  activeLayer?.close();
  const vp1 = viewportFor(v.page, 1);
  const layer = h('div', { class: 'word-layer' });
  const lines = new Map<number, string>();
  for (const w of words) lines.set(w.line, `${lines.get(w.line) ?? ''} ${w.text}`.trim());
  for (const w of words) {
    const x = place.left + w.x0 / place.scale, y = place.top + w.y0 / place.scale;
    const bw = (w.x1 - w.x0) / place.scale, bh = (w.y1 - w.y0) / place.scale;
    const spot = h('button', {
      class: `word-spot${hasLetter(w.text) ? '' : ' plain'}`, title: w.text, 'aria-label': `Look up ${w.text}`,
      style: { left: `${(x / vp1.width) * 100}%`, top: `${(y / vp1.height) * 100}%`, width: `${(bw / vp1.width) * 100}%`, height: `${(bh / vp1.height) * 100}%` },
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        layer.querySelectorAll('.word-spot.on').forEach(n => n.classList.remove('on'));
        spot.classList.add('on');
        const r = spot.getBoundingClientRect();
        void showDictionary(w.text, { x: r.left, y: r.bottom, sentence: lines.get(w.line) });
      },
    });
    spot.addEventListener('pointerdown', e => e.stopPropagation());
    layer.append(spot);
  }
  const text = wordsToText(words);
  const bar = h('div', { class: 'word-bar' },
    h('span', null, `${words.length} word${words.length === 1 ? '' : 's'} found. Click one to look it up.`),
    h('button', { class: 'btn small', onclick: () => { void navigator.clipboard?.writeText(text); toast('Text copied.', 'ok'); } }, 'Copy text'),
    h('button', { class: 'btn small primary', onclick: () => close() }, 'Done'));
  bar.addEventListener('pointerdown', e => e.stopPropagation());
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.dict-pop')) { e.stopPropagation(); close(); } };
  // The page can be closed or scrolled away, taking the spots with it. The bar goes too.
  const watch = window.setInterval(() => { if (!layer.isConnected) close(); }, 1000);
  function close() {
    clearInterval(watch);
    layer.remove();
    bar.remove();
    document.removeEventListener('keydown', onKey, true);
    activeLayer = null;
  }
  document.addEventListener('keydown', onKey, true);
  activeLayer = { close };
  v.el.append(layer);
  document.body.append(bar);
}
