// XFDF is the standard file for moving annotations between PDF apps. Pictures are not included,
// because the format has no common way to carry them.

import { pointsBounds, uid, type Annot, type Kind, type PageRef } from '../core/model';
import type { Session } from '../core/session';

const TAG: Partial<Record<Kind, string>> = {
  highlight: 'highlight', underline: 'underline', strikeout: 'strikeout', squiggly: 'squiggly',
  ink: 'ink', rect: 'square', ellipse: 'circle', line: 'line', arrow: 'line', polygon: 'polygon', polyline: 'polyline',
  cloud: 'polygon', text: 'freetext', note: 'text', stamp: 'stamp', measure: 'line',
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => +v.toFixed(3);

export function exportXfdf(session: Session): string {
  const parts: string[] = [];
  session.pages.forEach((page, index) => {
    for (const a of page.annots) {
      const tag = TAG[a.kind];
      if (!tag) continue;
      const attrs: string[] = [
        `page="${index}"`, `rect="${a.rect.map(n).join(',')}"`, `color="${a.color.toUpperCase()}"`, `opacity="${n(a.opacity)}"`,
        `width="${n(a.width)}"`, `name="${a.id}"`, `title="${esc(a.author ?? '')}"`,
      ];
      if (a.fill) attrs.push(`interior-color="${a.fill.toUpperCase()}"`);
      if (a.quads) attrs.push(`coords="${a.quads.flat().map(n).join(',')}"`);
      if (a.kind === 'line' || a.kind === 'arrow' || a.kind === 'measure') {
        const p = a.pts ?? [];
        attrs.push(`start="${n(p[0] ?? 0)},${n(p[1] ?? 0)}"`, `end="${n(p[2] ?? 0)},${n(p[3] ?? 0)}"`);
        if (a.kind === 'arrow') attrs.push('tail="ClosedArrow"');
      }
      if (a.kind === 'text') attrs.push(`data-size="${a.fontSize ?? 12}"`);
      let inner = '';
      const text = a.contents ?? a.text;
      if (text) inner += `<contents>${esc(text)}</contents>`;
      if (a.paths) inner += `<inklist>${a.paths.map(p => `<gesture>${pairs(p)}</gesture>`).join('')}</inklist>`;
      if ((a.kind === 'polygon' || a.kind === 'polyline' || a.kind === 'cloud') && a.pts) inner += `<vertices>${pairs(a.pts)}</vertices>`;
      parts.push(`<${tag} ${attrs.join(' ')}>${inner}</${tag}>`);
    }
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">\n<annots>\n${parts.join('\n')}\n</annots>\n</xfdf>\n`;
}

function pairs(p: number[]): string {
  const out: string[] = [];
  for (let i = 0; i + 1 < p.length; i += 2) out.push(`${n(p[i])},${n(p[i + 1])}`);
  return out.join(';');
}

const nums = (s: string | null) => (s ?? '').split(/[,;\s]+/).filter(Boolean).map(Number).filter(Number.isFinite);

const KIND_FROM: Record<string, Kind> = {
  highlight: 'highlight', underline: 'underline', strikeout: 'strikeout', squiggly: 'squiggly',
  ink: 'ink', square: 'rect', circle: 'ellipse', line: 'line', polygon: 'polygon', polyline: 'polyline',
  freetext: 'text', text: 'note', stamp: 'stamp',
};

/** Reads annotations from XFDF. Returns how many were added. Unknown entries are skipped. */
export function importXfdf(session: Session, xml: string): number {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('This is not a valid XFDF file.');
  const root = doc.getElementsByTagNameNS('*', 'annots')[0] ?? doc.querySelector('annots');
  if (!root) return 0;
  const byPage = new Map<PageRef, Annot[]>();
  let count = 0;
  for (const el of [...root.children]) {
    const kind = KIND_FROM[el.localName.toLowerCase()];
    const page = session.pages[+(el.getAttribute('page') ?? -1)];
    const r = nums(el.getAttribute('rect'));
    if (!kind || !page || r.length < 4) continue;
    const a: Annot = {
      id: uid(), kind, rect: [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])],
      color: el.getAttribute('color') ?? '#d92d20', opacity: +(el.getAttribute('opacity') ?? 1), width: +(el.getAttribute('width') ?? 1),
      fill: el.getAttribute('interior-color'), author: el.getAttribute('title') ?? undefined, created: Date.now(),
    };
    const contents = el.getElementsByTagNameNS('*', 'contents')[0]?.textContent ?? undefined;
    if (contents) a.contents = contents;
    const coords = nums(el.getAttribute('coords'));
    if (coords.length >= 8) {
      a.quads = [];
      for (let i = 0; i + 7 < coords.length; i += 8) a.quads.push(coords.slice(i, i + 8));
    }
    if (kind === 'ink') {
      a.paths = [...el.getElementsByTagNameNS('*', 'gesture')].map(g => nums(g.textContent));
      a.rect = pointsBounds(a.paths.flat());
    }
    if (kind === 'line') {
      a.pts = [...nums(el.getAttribute('start')), ...nums(el.getAttribute('end'))];
      if (el.getAttribute('tail') || el.getAttribute('head')) a.kind = 'arrow';
    }
    if (kind === 'polygon' || kind === 'polyline') a.pts = nums(el.getElementsByTagNameNS('*', 'vertices')[0]?.textContent ?? '');
    if (kind === 'text') { a.fontSize = +(el.getAttribute('data-size') ?? 12); a.text = contents ?? ''; a.textColor = a.color; }
    if (kind === 'note') a.fill = a.color;
    if (kind === 'stamp') a.text = contents ?? 'STAMP';
    byPage.set(page, [...(byPage.get(page) ?? []), a]);
    count++;
  }
  const items = [...byPage.entries()];
  const apply = () => {
    for (const [p, list] of items) p.annots.push(...list);
    session.emit({ kind: 'annots', pageIds: items.map(i => i[0].id) });
  };
  const undo = () => {
    for (const [p, list] of items) {
      const ids = new Set(list.map(a => a.id));
      p.annots = p.annots.filter(a => !ids.has(a.id));
    }
    session.emit({ kind: 'annots', pageIds: items.map(i => i[0].id) });
  };
  if (count) { apply(); session.record({ label: 'Import annotations', undo, redo: apply }); }
  return count;
}
