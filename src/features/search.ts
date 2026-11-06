// Text search. Page text is read one page at a time, so searching a large file never freezes.

import type { PageRef } from '../core/model';
import type { Session } from '../core/session';

export interface MatchBox { x: number; y: number; w: number; h: number }
export interface Match { pageId: string; pageIndex: number; text: string; context: string; boxes: MatchBox[] }

interface PageText { text: string; items: { start: number; end: number; x: number; y: number; w: number; h: number }[] }

/* eslint-disable @typescript-eslint/no-explicit-any */

const cache = new WeakMap<Session, Map<string, { sig: string; text: PageText }>>();

export async function pageText(session: Session, page: PageRef): Promise<PageText> {
  let map = cache.get(session);
  if (!map) { map = new Map(); cache.set(session, map); }
  const ocr = session.ocrWords.get(page.id);
  const pictures = session.pictureWords.get(page.id);
  // One entry per page. Words read from pictures belong to this page only, so they join its key.
  const key = ocr || pictures ? `page:${page.id}` : `${page.source}:${page.index}`;
  const sig = `${ocr ? 'ocr' : ''}:${pictures ? session.pictureRevs.get(page.id) ?? 0 : ''}`;
  const hit = map.get(key);
  if (hit && hit.sig === sig) return hit.text;

  let text = '';
  const items: PageText['items'] = [];
  const pushWord = (s: string, x: number, y: number, w: number, ht: number, sep: string) => {
    const start = text.length;
    text += s;
    items.push({ start, end: text.length, x, y, w, h: ht });
    text += sep;
  };
  if (ocr) {
    for (const w of ocr) pushWord(w.text, w.x, w.y, w.w, w.h, ' ');
  } else {
    const pdfPage = await session.pdfPage(page);
    if (pdfPage) {
      const content = await pdfPage.getTextContent();
      for (const it of content.items as any[]) {
        if (typeof it.str !== 'string') continue;
        const ht = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
        pushWord(it.str, it.transform[4], it.transform[5], it.width, ht, it.hasEOL ? '\n' : '');
      }
      pdfPage.cleanup();
    }
  }
  // Words read from pictures come last, after the page's own text.
  if (pictures?.length) {
    if (text && !text.endsWith('\n')) text += '\n';
    for (const w of pictures) pushWord(w.text, w.x, w.y, w.w, w.h, ' ');
  }
  const out = { text, items };
  map.set(key, { sig, text: out });
  return out;
}

export interface SearchOptions { caseSensitive: boolean; wholeWord: boolean }

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function findInPage(pt: PageText, page: PageRef, pageIndex: number, query: string, opt: SearchOptions): Match[] {
  const pattern = escapeRe(query).replace(/\s+/g, '\\s+');
  const re = new RegExp(opt.wholeWord ? `(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])` : pattern, `gu${opt.caseSensitive ? '' : 'i'}`);
  const out: Match[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(pt.text))) {
    if (!m[0].length) { re.lastIndex++; continue; }
    const start = m.index, end = start + m[0].length;
    const boxes: MatchBox[] = [];
    for (const it of pt.items) {
      if (it.end <= start) continue;
      if (it.start >= end) break;
      const len = it.end - it.start || 1;
      const a = Math.max(start, it.start) - it.start, b = Math.min(end, it.end) - it.start;
      boxes.push({ x: it.x + (a / len) * it.w, y: it.y - it.h * 0.2, w: ((b - a) / len) * it.w, h: it.h * 1.2 });
    }
    const context = pt.text.slice(Math.max(0, start - 30), Math.min(pt.text.length, end + 40)).replace(/\s+/g, ' ');
    out.push({ pageId: page.id, pageIndex, text: m[0], context, boxes });
    if (out.length > 5000) break;
  }
  return out;
}

export async function searchDocument(
  session: Session, query: string, opt: SearchOptions,
  onBatch: (found: Match[], done: number, total: number) => void,
  isCancelled: () => boolean,
): Promise<void> {
  const pages = session.pages;
  for (let i = 0; i < pages.length; i++) {
    if (isCancelled()) return;
    try {
      const pt = await pageText(session, pages[i]);
      const found = findInPage(pt, pages[i], i, query, opt);
      if (found.length || i % 20 === 0 || i === pages.length - 1) onBatch(found, i + 1, pages.length);
    } catch (err) {
      console.warn('Could not read page', i + 1, err);
    }
    if (i % 8 === 7) await new Promise(r => setTimeout(r, 0));
  }
}
