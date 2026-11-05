// Finds places on a page that look like they want filling in, and adds form fields there.

import { pointsBounds, uid, type Annot, type PageRef } from '../core/model';
import type { Session } from '../core/session';

/* eslint-disable @typescript-eslint/no-explicit-any */

const BLANK = /_{4,}|\.{6,}|…{3,}/g;
const BOX = /[☐□▢◻]/g;

export async function detectFields(session: Session, progress: (i: number, total: number) => boolean): Promise<number> {
  const found: { page: PageRef; annots: Annot[] }[] = [];
  let count = 0;
  const pages = session.pages;
  for (let i = 0; i < pages.length; i++) {
    if (!progress(i, pages.length)) break;
    const page = pages[i];
    const pdfPage = await session.pdfPage(page);
    if (!pdfPage) continue;
    const content = await pdfPage.getTextContent();
    const annots: Annot[] = [];
    for (const it of content.items as any[]) {
      if (typeof it.str !== 'string' || !it.str) continue;
      const size = Math.hypot(it.transform[2], it.transform[3]) || 11;
      const x = it.transform[4], y = it.transform[5];
      const perChar = it.width / (it.str.length || 1);
      const add = (type: 'text' | 'check', start: number, length: number) => {
        const x0 = x + start * perChar, x1 = x0 + length * perChar;
        const rect = type === 'check'
          ? pointsBounds([x0, y - size * 0.1, x0 + size, y + size * 0.9])
          : pointsBounds([x0, y - size * 0.25, x1, y + size * 1.1]);
        annots.push({
          id: uid(), kind: 'rect', rect, color: '#0b57d0', opacity: 1, width: 1, created: Date.now(),
          field: { type, name: `${type}_p${i + 1}_${annots.length + 1}` },
        });
      };
      for (const m of it.str.matchAll(BLANK)) add('text', m.index ?? 0, m[0].length);
      for (const m of it.str.matchAll(BOX)) add('check', m.index ?? 0, 1);
    }
    pdfPage.cleanup();
    if (annots.length) { found.push({ page, annots }); count += annots.length; }
    if (i % 10 === 9) await new Promise(r => setTimeout(r, 0));
  }
  if (!count) return 0;
  const apply = () => {
    for (const f of found) f.page.annots.push(...f.annots);
    session.emit({ kind: 'annots', pageIds: found.map(f => f.page.id) });
  };
  const undo = () => {
    for (const f of found) {
      const ids = new Set(f.annots.map(a => a.id));
      f.page.annots = f.page.annots.filter(a => !ids.has(a.id));
    }
    session.emit({ kind: 'annots', pageIds: found.map(f => f.page.id) });
  };
  apply();
  session.record({ label: 'Detect form fields', undo, redo: apply });
  return count;
}
