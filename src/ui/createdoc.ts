// Making new documents: blank, lined, grid, dotted and other papers, in any common size, or a
// PDF made from pictures. The paper is written as a small real PDF, so the lines are sharp
// vector lines that print well, and many pages share one drawing.

import { openDialog } from './dialogs';
import { clear, h, icon, pickFiles } from './dom';

export type Paper = 'blank' | 'lined' | 'narrow' | 'grid' | 'dotted' | 'graph' | 'cornell' | 'music';

export const PAPERS: { id: Paper; name: string; about: string }[] = [
  { id: 'blank', name: 'Blank', about: 'A plain white page' },
  { id: 'lined', name: 'Lined', about: 'Ruled lines with a margin, for writing' },
  { id: 'narrow', name: 'Narrow lined', about: 'Closer lines, for small handwriting' },
  { id: 'grid', name: 'Grid', about: '5 mm squares' },
  { id: 'dotted', name: 'Dotted', about: 'A 5 mm dot grid, for notes and sketches' },
  { id: 'graph', name: 'Graph paper', about: '1 mm and 1 cm lines, for plots' },
  { id: 'cornell', name: 'Cornell notes', about: 'Cue column, notes area and a summary box' },
  { id: 'music', name: 'Music staff', about: 'Twelve five-line staves' },
];

const MM = 72 / 25.4;
export const SIZES: { id: string; name: string; w: number; h: number }[] = [
  { id: 'a4', name: 'A4 (210 × 297 mm)', w: 210 * MM, h: 297 * MM },
  { id: 'letter', name: 'Letter (8.5 × 11 in)', w: 612, h: 792 },
  { id: 'a5', name: 'A5 (148 × 210 mm)', w: 148 * MM, h: 210 * MM },
  { id: 'a3', name: 'A3 (297 × 420 mm)', w: 297 * MM, h: 420 * MM },
  { id: 'legal', name: 'Legal (8.5 × 14 in)', w: 612, h: 1008 },
  { id: 'tabloid', name: 'Tabloid (11 × 17 in)', w: 792, h: 1224 },
];

type Prim = { k: 'line'; x1: number; y1: number; x2: number; y2: number; c: string; w: number } | { k: 'dot'; x: number; y: number; r: number; c: string } | { k: 'rect'; x: number; y: number; w: number; h: number; c: string; lw: number };

/** The marks on one page, measured from the top left, in points. */
function paperMarks(paper: Paper, w: number, h: number): Prim[] {
  const out: Prim[] = [];
  const line = (x1: number, y1: number, x2: number, y2: number, c: string, lw = 0.5) => out.push({ k: 'line', x1, y1, x2, y2, c, w: lw });
  const ruled = (top: number, gap: number, left = 0, right = w, bottom = h - 36) => { for (let y = top; y <= bottom; y += gap) line(left, y, right, y, '#a9c6e8', 0.6); };
  switch (paper) {
    case 'lined': ruled(72, 8.7 * MM); line(25 * MM, 0, 25 * MM, h, '#e9a3a3', 0.8); break;
    case 'narrow': ruled(60, 6 * MM); line(20 * MM, 0, 20 * MM, h, '#e9a3a3', 0.8); break;
    case 'grid': for (let x = 0; x <= w; x += 5 * MM) line(x, 0, x, h, '#cfd8e3', 0.5); for (let y = 0; y <= h; y += 5 * MM) line(0, y, w, y, '#cfd8e3', 0.5); break;
    case 'dotted': for (let x = 5 * MM; x < w; x += 5 * MM) for (let y = 5 * MM; y < h; y += 5 * MM) out.push({ k: 'dot', x, y, r: 0.55, c: '#9aa6b5' }); break;
    case 'graph': {
      const step = MM, n = Math.ceil(Math.max(w, h) / step);
      for (let i = 0; i <= n; i++) {
        const major = i % 10 === 0, mid = i % 5 === 0;
        const c = major ? '#8fb3d9' : mid ? '#bcd2ea' : '#e1ebf6', lw = major ? 0.7 : mid ? 0.45 : 0.3;
        if (i * step <= w) line(i * step, 0, i * step, h, c, lw);
        if (i * step <= h) line(0, i * step, w, i * step, c, lw);
      }
      break;
    }
    case 'cornell': {
      const head = 1.1 * 72, foot = h - 2 * 72, cue = Math.min(2.5 * 72, w * 0.3);
      line(0, head, w, head, '#7f9dbd', 1);
      line(cue, head, cue, foot, '#e9a3a3', 1);
      line(0, foot, w, foot, '#7f9dbd', 1);
      ruled(head + 8.7 * MM, 8.7 * MM, cue + 6, w - 18, foot - 6);
      break;
    }
    case 'music': {
      const gap = 7, staffH = gap * 4, margin = 54, blocks = 12;
      const space = (h - margin * 2 - staffH) / (blocks - 1);
      for (let b = 0; b < blocks; b++) for (let i = 0; i < 5; i++) { const y = margin + b * space + i * gap; line(40, y, w - 40, y, '#444b55', 0.6); }
      break;
    }
  }
  return out;
}

const hex = (c: string) => [1, 3, 5].map(i => (parseInt(c.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');
const n = (v: number) => (Math.round(v * 100) / 100).toString();

function streamFor(paper: Paper, w: number, h: number): string {
  const ops: string[] = ['1 J 1 j'];
  let stroke = '', width = -1, fill = '';
  for (const p of paperMarks(paper, w, h)) {
    if (p.k === 'line') {
      if (p.c !== stroke) { ops.push(`${hex(p.c)} RG`); stroke = p.c; }
      if (p.w !== width) { ops.push(`${n(p.w)} w`); width = p.w; }
      ops.push(`${n(p.x1)} ${n(h - p.y1)} m ${n(p.x2)} ${n(h - p.y2)} l S`);
    } else if (p.k === 'dot') {
      if (p.c !== fill) { ops.push(`${hex(p.c)} rg`); fill = p.c; }
      const x = p.x, y = h - p.y, r = p.r, k = r * 0.5523;
      ops.push(`${n(x + r)} ${n(y)} m ${n(x + r)} ${n(y + k)} ${n(x + k)} ${n(y + r)} ${n(x)} ${n(y + r)} c ${n(x - k)} ${n(y + r)} ${n(x - r)} ${n(y + k)} ${n(x - r)} ${n(y)} c ${n(x - r)} ${n(y - k)} ${n(x - k)} ${n(y - r)} ${n(x)} ${n(y - r)} c ${n(x + k)} ${n(y - r)} ${n(x + r)} ${n(y - k)} ${n(x + r)} ${n(y)} c f`);
    }
  }
  return ops.join('\n');
}

/** A PDF title can hold any language when written as UTF-16. */
function pdfText(s: string): string {
  let out = '<FEFF';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code > 0xffff) { const v = code - 0x10000; out += ((0xd800 + (v >> 10)).toString(16) + (0xdc00 + (v & 0x3ff)).toString(16)).toUpperCase().padStart(8, '0'); }
    else out += code.toString(16).toUpperCase().padStart(4, '0');
  }
  return `${out}>`;
}

/** A complete small PDF of `pages` pages of this paper. Every page shares one drawing. */
export function makePaperPdf(opts: { title: string; paper: Paper; w: number; h: number; pages: number }): Blob {
  const count = Math.max(1, Math.min(500, Math.round(opts.pages)));
  const objs: string[] = [];
  const pageIds = Array.from({ length: count }, (_, i) => 5 + i);
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map(i => `${i} 0 R`).join(' ')}] /Count ${count} >>`;
  const body = opts.paper === 'blank' ? '' : streamFor(opts.paper, opts.w, opts.h);
  objs[3] = `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
  objs[4] = `<< /Title ${pdfText(opts.title)} /Producer (Meletiq PDF) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`;
  for (const id of pageIds) objs[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(opts.w)} ${n(opts.h)}] /Contents 3 0 R /Resources << >> >>`;
  let out = '%PDF-1.7\n%âãÏÓ\n';
  const offsets: number[] = [];
  // Everything written is plain ASCII except the second line, which is 4 bytes after encoding as Latin-1.
  const enc = (s: string) => Uint8Array.from(s, c => c.charCodeAt(0) & 0xff);
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([enc(out)], { type: 'application/pdf' });
}

/** Draws the paper small, for the preview in the dialogs. */
function drawPreview(canvas: HTMLCanvasElement, paper: Paper, w: number, h: number) {
  const box = 150;
  const k = Math.min(box / w, box / h);
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.round(w * k * dpr);
  canvas.height = Math.round(h * k * dpr);
  canvas.style.width = `${Math.round(w * k)}px`;
  canvas.style.height = `${Math.round(h * k)}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(k * dpr, 0, 0, k * dpr, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  for (const p of paperMarks(paper, w, h)) {
    if (p.k === 'line') { ctx.strokeStyle = p.c; ctx.lineWidth = Math.max(p.w, 0.6 / k); ctx.beginPath(); ctx.moveTo(p.x1, p.y1); ctx.lineTo(p.x2, p.y2); ctx.stroke(); }
    else if (p.k === 'dot') { ctx.fillStyle = p.c; ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(p.r, 0.7 / k), 0, Math.PI * 2); ctx.fill(); }
  }
}

export type CreateResult =
  | { kind: 'blank'; title: string; paper: Paper; w: number; h: number; pages: number }
  | { kind: 'images'; title: string; files: File[]; fit: 'image' | 'a4' | 'letter'; margin: boolean };

function paperFields(start: { paper?: Paper; size?: string; landscape?: boolean; pages?: number }, sameAs?: { w: number; h: number }) {
  const paper = h('select', { class: 'cd-select', 'aria-label': 'Paper type' }, ...PAPERS.map(p => h('option', { value: p.id, selected: p.id === (start.paper ?? 'blank') }, p.name)));
  const sizes = [...(sameAs ? [{ id: 'same', name: 'Same as this page', w: sameAs.w, h: sameAs.h }] : []), ...SIZES];
  const size = h('select', { class: 'cd-select', 'aria-label': 'Page size' }, ...sizes.map(s => h('option', { value: s.id, selected: s.id === (start.size ?? (sameAs ? 'same' : 'a4')) }, s.name)));
  const group = `orient-${Math.random().toString(36).slice(2, 7)}`;
  const portrait = h('input', { type: 'radio', name: group, value: 'portrait', checked: !start.landscape });
  const landscape = h('input', { type: 'radio', name: group, value: 'landscape', checked: !!start.landscape });
  const pages = h('input', { type: 'number', class: 'cd-select', min: 1, max: 500, step: 1, value: start.pages ?? 1, 'aria-label': 'Number of pages' });
  const about = h('p', { class: 'cd-about muted' });
  const preview = h('canvas', { class: 'cd-preview', 'aria-hidden': 'true' });
  const read = () => {
    const s = sizes.find(x => x.id === size.value) ?? sizes[0];
    const long = Math.max(s.w, s.h), short = Math.min(s.w, s.h);
    const turned = s.id === 'same' ? landscape.checked !== (s.w > s.h) : landscape.checked;
    const w = s.id === 'same' ? (turned ? s.h : s.w) : landscape.checked ? long : short;
    const ht = s.id === 'same' ? (turned ? s.w : s.h) : landscape.checked ? short : long;
    return { paper: paper.value as Paper, w, h: ht, pages: Math.max(1, Math.min(500, Math.round(+pages.value || 1))) };
  };
  const update = () => {
    const r = read();
    about.textContent = PAPERS.find(p => p.id === r.paper)?.about ?? '';
    drawPreview(preview, r.paper, r.w, r.h);
  };
  if (sameAs) { portrait.checked = sameAs.h >= sameAs.w; landscape.checked = !portrait.checked; }
  for (const el of [paper, size, portrait, landscape]) el.addEventListener('change', update);
  update();
  const fields = h('div', { class: 'cd-grid' },
    h('label', { class: 'cd-field' }, h('span', null, 'Paper type'), paper),
    h('label', { class: 'cd-field' }, h('span', null, 'Page size'), size),
    h('div', { class: 'cd-field' }, h('span', null, 'Orientation'),
      h('div', { class: 'cd-radios' }, h('label', null, portrait, 'Portrait'), h('label', null, landscape, 'Landscape'))),
    h('label', { class: 'cd-field' }, h('span', null, 'Number of pages'), pages));
  return { fields, about, preview, read };
}

/** The Create document window: a blank or ruled document, or a PDF from pictures. */
export function createDocumentDialog(): Promise<CreateResult | null> {
  const title = h('input', { class: 'cd-title', value: 'Untitled', 'aria-label': 'Document title', spellcheck: false });
  const blank = paperFields({});
  let files: File[] = [];
  const fileList = h('div', { class: 'cd-files' });
  const fit = h('select', { class: 'cd-select', 'aria-label': 'Page size' },
    h('option', { value: 'image' }, 'Same size as each picture'), h('option', { value: 'a4' }, 'A4, picture fitted'), h('option', { value: 'letter' }, 'Letter, picture fitted'));
  const margin = h('input', { type: 'checkbox', checked: true });
  const drawFiles = () => {
    clear(fileList);
    if (!files.length) { fileList.append(h('p', { class: 'muted' }, 'No pictures chosen yet. PNG, JPG, WebP, HEIC and more.')); return; }
    fileList.append(...files.slice(0, 40).map(f => h('div', { class: 'cd-file' }, icon('photo', 14), h('span', null, f.name))));
    if (files.length > 40) fileList.append(h('p', { class: 'muted' }, `and ${files.length - 40} more`));
  };
  drawFiles();
  const choose = h('button', { class: 'btn', onclick: async () => { const got = await pickFiles('image/*,.heic,.heif', true); if (got.length) { files = got; if (title.value === 'Untitled') title.value = got[0].name.replace(/\.[^.]+$/, ''); drawFiles(); } } }, 'Choose pictures…');

  const panes = {
    blank: h('div', { class: 'cd-pane' }, blank.fields, h('div', { class: 'cd-side' }, blank.preview, blank.about)),
    images: h('div', { class: 'cd-pane', hidden: true },
      h('div', { class: 'cd-images' }, h('div', { class: 'row-gap' }, choose), fileList,
        h('label', { class: 'cd-field' }, h('span', null, 'Page size'), fit),
        h('label', { class: 'check-row' }, margin, 'Leave a small margin around each picture'))),
  };
  let tab: 'blank' | 'images' = 'blank';
  const navBtn = (id: 'blank' | 'images', ic: string, label: string) => {
    const b = h('button', { class: `cd-nav${id === tab ? ' on' : ''}`, onclick: () => {
      tab = id;
      for (const x of nav.querySelectorAll('.cd-nav')) x.classList.toggle('on', x === b);
      panes.blank.hidden = id !== 'blank';
      panes.images.hidden = id !== 'images';
    } }, icon(ic, 16), label);
    return b;
  };
  const nav = h('nav', { class: 'cd-navs' }, navBtn('blank', 'newDoc', 'Blank document'), navBtn('images', 'imagesToPdf', 'PDF from pictures'));

  const create = h('button', { class: 'btn primary' }, 'Create PDF');
  const cancel = h('button', { class: 'btn' }, 'Cancel');
  const body = h('div', { class: 'create-doc' }, nav,
    h('div', { class: 'cd-main' },
      h('label', { class: 'cd-field' }, h('span', null, 'Document title'), title),
      panes.blank, panes.images,
      h('div', { class: 'cd-foot' }, cancel, create)));
  return openDialog<CreateResult | null>('Create document', body, [], null, close => {
    cancel.addEventListener('click', () => close(null));
    create.addEventListener('click', () => {
      const name = title.value.trim() || 'Untitled';
      if (tab === 'blank') close({ kind: 'blank', title: name, ...blank.read() });
      else if (!files.length) choose.click();
      else close({ kind: 'images', title: name, files, fit: fit.value as 'image', margin: margin.checked });
    });
    title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); create.click(); } });
    title.select();
  }, true);
}

/** Insert page: paper, size, orientation, how many, and where. */
export async function insertPageDialog(current: { w: number; h: number }, pageNo: number): Promise<{ paper: Paper; w: number; h: number; pages: number; where: 'after' | 'before' | 'end' } | null> {
  const f = paperFields({}, current);
  const where = h('select', { class: 'cd-select', 'aria-label': 'Where' },
    h('option', { value: 'after' }, `After page ${pageNo}`), h('option', { value: 'before' }, `Before page ${pageNo}`), h('option', { value: 'end' }, 'At the end'));
  const body = h('div', { class: 'create-doc single' }, h('div', { class: 'cd-main' },
    h('div', { class: 'cd-pane' }, h('div', null, f.fields, h('label', { class: 'cd-field' }, h('span', null, 'Where'), where)), h('div', { class: 'cd-side' }, f.preview, f.about))));
  const ok = await openDialog('Insert page', body, [{ label: 'Cancel', value: false }, { label: 'Insert', value: true, primary: true }], false, undefined, true);
  return ok ? { ...f.read(), where: where.value as 'after' } : null;
}
