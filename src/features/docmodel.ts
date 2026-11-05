// Reads a PDF page as blocks of content: paragraphs, tables and pictures, in reading order.
// Word and HTML export are built from this, so both get tables and pictures.

import { OPS, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import { linesOf, toParagraphs, type Line, type Paragraph } from './convert';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ImageBlock { type: 'image'; y: number; blob: Blob; ptW: number; ptH: number; width: number; height: number }
export interface TableBlock { type: 'table'; y: number; rows: string[][] }
export interface TextBlock { type: 'text'; y: number; p: Paragraph; align: 'left' | 'center' }
export type Block = ImageBlock | TableBlock | TextBlock;

const MIN_IMAGE_POINTS = 18; // Smaller marks are usually decoration such as bullets.

function objectOf(page: PDFPageProxy, id: string): Promise<any> {
  const store: any = id.startsWith('g_') ? page.commonObjs : page.objs;
  return new Promise(resolve => {
    let done = false;
    const finish = (v: any) => { if (!done) { done = true; resolve(v); } };
    try { store.get(id, finish); } catch { finish(null); }
    setTimeout(() => finish(null), 3000);
  });
}

async function toPng(img: any): Promise<Blob | null> {
  const w = img.width, h = img.height;
  if (!w || !h) return null;
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d')!;
  if (img.bitmap) {
    ctx.drawImage(img.bitmap, 0, 0);
  } else if (img.data) {
    const out = ctx.createImageData(w, h);
    const src = img.data as Uint8Array;
    const n = w * h;
    if (src.length >= n * 4) out.data.set(src.subarray(0, n * 4));
    else if (src.length >= n * 3) {
      for (let i = 0, j = 0; i < n; i++, j += 3) {
        out.data[i * 4] = src[j]; out.data[i * 4 + 1] = src[j + 1]; out.data[i * 4 + 2] = src[j + 2]; out.data[i * 4 + 3] = 255;
      }
    } else return null;
    ctx.putImageData(out, 0, 0);
  } else return null;
  return c.convertToBlob({ type: 'image/png' });
}

function multiply(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/** Finds pictures by following how the page draws them. */
export async function pageImages(page: PDFPageProxy): Promise<ImageBlock[]> {
  const out: ImageBlock[] = [];
  let list: { fnArray: number[]; argsArray: any[] };
  try { list = await page.getOperatorList(); } catch { return out; }
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i], args = list.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = multiply(ctm, args);
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const ptW = Math.hypot(ctm[0], ctm[1]), ptH = Math.hypot(ctm[2], ctm[3]);
      if (ptW < MIN_IMAGE_POINTS || ptH < MIN_IMAGE_POINTS) continue;
      const img = typeof args[0] === 'string' ? await objectOf(page, args[0]) : args[0];
      if (!img) continue;
      const key = `${args[0]}:${Math.round(ctm[5])}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const blob = await toPng(img);
      if (blob) out.push({ type: 'image', y: ctm[5] + Math.max(ctm[3], 0), blob, ptW, ptH, width: img.width, height: img.height });
      if (out.length >= 40) break; // A page full of tiny tiles is really one picture, so stop early.
    }
  }
  return out;
}

const columnStarts = (l: Line, gap: number): number[] => {
  const starts: number[] = [];
  let prevEnd = -Infinity;
  for (const w of l.words) {
    if (w.x - prevEnd > gap) starts.push(w.x);
    prevEnd = w.x + (w.width ?? 0);
  }
  return starts;
};

/** Lines whose words sit in the same columns, row after row, are a table. */
function findTables(lines: Line[]): { start: number; end: number; columns: number[] }[] {
  const found: { start: number; end: number; columns: number[] }[] = [];
  let i = 0;
  while (i < lines.length) {
    const gap = lines[i].size * 1.4;
    const base = columnStarts(lines[i], gap);
    if (base.length < 2) { i++; continue; }
    let columns = base;
    let j = i + 1;
    while (j < lines.length) {
      const cur = columnStarts(lines[j], lines[j].size * 1.4);
      if (cur.length < 2) break;
      const shared = cur.filter(x => columns.some(c => Math.abs(c - x) < 8)).length;
      if (shared < Math.min(2, cur.length)) break;
      for (const x of cur) if (!columns.some(c => Math.abs(c - x) < 8)) columns = [...columns, x];
      j++;
    }
    if (j - i >= 2) {
      found.push({ start: i, end: j, columns: [...columns].sort((a, b) => a - b) });
      i = j;
    } else i++;
  }
  return found;
}

function tableRows(lines: Line[], columns: number[]): string[][] {
  return lines.map(l => {
    const cells = columns.map(() => '');
    for (const w of l.words) {
      let at = 0;
      for (let k = 0; k < columns.length; k++) if (w.x >= columns[k] - 4) at = k;
      cells[at] = cells[at] ? `${cells[at]} ${w.text}`.replace(/\s+/g, ' ') : w.text;
    }
    return cells.map(c => c.trim());
  });
}

/** All of a page's content, top to bottom. */
export async function pageBlocks(pdf: PDFDocumentProxy, index: number, bodySize: number): Promise<Block[]> {
  const lines = await linesOf(pdf, index);
  const page = await pdf.getPage(index + 1);
  const pageW = page.view[2] - page.view[0];
  const blocks: Block[] = [];
  const tables = findTables(lines);
  let from = 0;
  const addText = (slice: Line[]) => {
    for (const p of toParagraphs(slice, index, bodySize)) {
      const centered = p.text.length < 80 && Math.abs(p.x + p.width / 2 - (page.view[0] + pageW / 2)) < pageW * 0.03 && p.x > pageW * 0.15;
      blocks.push({ type: 'text', y: p.y, p, align: centered ? 'center' : 'left' });
    }
  };
  for (const t of tables) {
    if (t.start > from) addText(lines.slice(from, t.start));
    blocks.push({ type: 'table', y: lines[t.start].y, rows: tableRows(lines.slice(t.start, t.end), t.columns) });
    from = t.end;
  }
  if (from < lines.length) addText(lines.slice(from));
  blocks.push(...await pageImages(page));
  page.cleanup();
  return blocks.sort((a, b) => b.y - a.y);
}

/** The most used text size across the document, which counts as body text. */
export async function bodyTextSize(pdf: PDFDocumentProxy): Promise<number> {
  const sizes = new Map<number, number>();
  const pages = Math.min(pdf.numPages, 40);
  for (let i = 0; i < pages; i++) {
    for (const l of await linesOf(pdf, i)) {
      const k = Math.round(l.size);
      sizes.set(k, (sizes.get(k) ?? 0) + l.text.length);
    }
  }
  return [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 11;
}
