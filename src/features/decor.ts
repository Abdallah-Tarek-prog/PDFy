// Watermarks, headers, footers, page numbers and Bates numbers. They preview as normal objects
// and are drawn into the page when saved, so they cannot be selected and removed in the saved file.

import { pageRotation, placeBox, uid, viewportFor, type Annot, type PageRef } from '../core/model';
import type { Session } from '../core/session';

let measure: OffscreenCanvasRenderingContext2D | null = null;

export function textWidth(text: string, size: number, bold = false): number {
  measure ??= new OffscreenCanvas(4, 4).getContext('2d')!;
  measure.font = `${bold ? 'bold ' : ''}${size}px Arial, Helvetica, sans-serif`;
  return measure.measureText(text).width;
}

export type Pos = 'tl' | 'tc' | 'tr' | 'bl' | 'bc' | 'br';

function placedText(page: PageRef, text: string, pos: Pos, size: number, color: string, margin: number): Annot {
  const vp = viewportFor(page, 1);
  const w = textWidth(text, size) + 10, h = size * 1.6;
  const x = pos[1] === 'l' ? margin : pos[1] === 'r' ? vp.width - margin - w : (vp.width - w) / 2;
  const y = pos[0] === 't' ? margin : vp.height - margin - h;
  const box = placeBox(page, x, y, x + w, y + h);
  return {
    id: uid(), kind: 'text', rect: box.rect, angle: box.angle, color, textColor: color, opacity: 1, width: 0,
    fontSize: size, text, burn: true, created: Date.now(),
  };
}

function bulkAdd(session: Session, items: { page: PageRef; annots: Annot[] }[], label: string) {
  const apply = () => {
    for (const it of items) it.page.annots.push(...it.annots);
    session.emit({ kind: 'annots', pageIds: items.map(i => i.page.id) });
  };
  const undo = () => {
    for (const it of items) {
      const ids = new Set(it.annots.map(a => a.id));
      it.page.annots = it.page.annots.filter(a => !ids.has(a.id));
    }
    session.emit({ kind: 'annots', pageIds: items.map(i => i.page.id) });
  };
  apply();
  session.record({ label, undo, redo: apply });
}

export interface HeaderFooter {
  slots: Partial<Record<Pos, string>>;
  size: number;
  color: string;
  margin: number;
  start: number;
}

export function addHeaderFooter(session: Session, pages: PageRef[], o: HeaderFooter, label = 'Add header and footer') {
  const date = new Date().toLocaleDateString();
  const total = o.start + pages.length - 1;
  const items = pages.map((page, i) => {
    const annots: Annot[] = [];
    for (const [pos, raw] of Object.entries(o.slots) as [Pos, string][]) {
      if (!raw) continue;
      const text = raw.replace(/\{page\}/g, String(o.start + i)).replace(/\{pages\}/g, String(total))
        .replace(/\{date\}/g, date).replace(/\{file\}/g, session.name);
      annots.push(placedText(page, text, pos, o.size, o.color, o.margin));
    }
    return { page, annots };
  });
  bulkAdd(session, items, label);
}

export function addBates(session: Session, pages: PageRef[], o: { prefix: string; suffix: string; start: number; digits: number; pos: Pos; size: number; color: string; margin: number }) {
  const items = pages.map((page, i) => {
    const code = `${o.prefix}${String(o.start + i).padStart(o.digits, '0')}${o.suffix}`;
    return { page, annots: [placedText(page, code, o.pos, o.size, o.color, o.margin)] };
  });
  bulkAdd(session, items, 'Add Bates numbers');
}

export function addWatermark(session: Session, pages: PageRef[], o: { text: string; size: number; color: string; opacity: number; angle: number }) {
  const items = pages.map(page => {
    const vp = viewportFor(page, 1);
    const w = textWidth(o.text, o.size, true) + 12, h = o.size * 1.4;
    const box = placeBox(page, (vp.width - w) / 2, (vp.height - h) / 2, (vp.width + w) / 2, (vp.height + h) / 2);
    const a: Annot = {
      id: uid(), kind: 'text', rect: box.rect, angle: (pageRotation(page) + o.angle) % 360, color: o.color, textColor: o.color,
      opacity: o.opacity, width: 0, fontSize: o.size, bold: true, text: o.text, burn: true, created: Date.now(),
    };
    return { page, annots: [a] };
  });
  bulkAdd(session, items, 'Add watermark');
}
