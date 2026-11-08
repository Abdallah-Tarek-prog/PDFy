// Office files to PDF, with no Office needed. Each file is turned into a web page, and the Windows
// app's own print engine turns that page into a PDF with real, selectable text.

import { strFromU8, unzipSync, type Unzipped } from 'fflate';

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  s: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const parse = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');

function read(zip: Unzipped, path: string): Document | null {
  const f = zip[path.replace(/^\//, '')];
  return f ? parse(strFromU8(f)) : null;
}

const kids = (el: Element | null | undefined, ns: string, name: string) => (el ? [...el.children].filter(c => c.localName === name && c.namespaceURI === ns) : []);
const kid = (el: Element | null | undefined, ns: string, name: string) => kids(el, ns, name)[0] ?? null;
const all = (el: Element | Document, ns: string, name: string) => [...el.getElementsByTagNameNS(ns, name)];
const attr = (el: Element | null | undefined, ns: string, name: string) => el?.getAttributeNS(ns, name) ?? null;

function relationships(zip: Unzipped, partPath: string): Map<string, { target: string; external: boolean }> {
  const dir = partPath.slice(0, partPath.lastIndexOf('/'));
  const file = `${dir}/_rels/${partPath.slice(dir.length + 1)}.rels`;
  const doc = read(zip, file);
  const out = new Map<string, { target: string; external: boolean }>();
  if (!doc) return out;
  for (const r of [...doc.documentElement.children]) {
    const id = r.getAttribute('Id'), target = r.getAttribute('Target');
    if (!id || !target) continue;
    const external = r.getAttribute('TargetMode') === 'External';
    out.set(id, { target: external ? target : resolvePath(dir, target), external });
  }
  return out;
}

function resolvePath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = `${base}/${target}`.split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.') out.push(p);
  }
  return out.join('/');
}

function dataUrl(zip: Unzipped, path: string): string | null {
  const f = zip[path];
  if (!f) return null;
  const ext = path.split('.').pop()!.toLowerCase();
  const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp' }[ext];
  if (!type) return null; // Old Windows picture formats cannot be shown.
  let bin = '';
  for (let i = 0; i < f.length; i += 32768) bin += String.fromCharCode(...f.subarray(i, i + 32768));
  return `data:${type};base64,${btoa(bin)}`;
}

export interface PrintJob { html: string; widthIn: number; heightIn: number; marginIn: number }

const BASE_CSS = `*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#000}@media print{.pagebreak{break-after:page}}img{max-width:100%}table{border-collapse:collapse}`;
const wrap = (css: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`;

// ---- Word ----

interface WStyle { base?: string; size?: number; bold?: boolean; italic?: boolean; color?: string; align?: string; before?: number; after?: number; heading?: number; font?: string }

function wordStyles(zip: Unzipped): { styles: Map<string, WStyle>; defaults: WStyle } {
  const doc = read(zip, 'word/styles.xml');
  const styles = new Map<string, WStyle>();
  const defaults: WStyle = { size: 11 };
  if (!doc) return { styles, defaults };
  const fromRun = (rPr: Element | null, s: WStyle) => {
    const sz = attr(kid(rPr, NS.w, 'sz'), NS.w, 'val');
    if (sz) s.size = +sz / 2;
    if (kid(rPr, NS.w, 'b')) s.bold = attr(kid(rPr, NS.w, 'b'), NS.w, 'val') !== '0';
    if (kid(rPr, NS.w, 'i')) s.italic = attr(kid(rPr, NS.w, 'i'), NS.w, 'val') !== '0';
    const c = attr(kid(rPr, NS.w, 'color'), NS.w, 'val');
    if (c && c !== 'auto') s.color = `#${c}`;
    const f = attr(kid(rPr, NS.w, 'rFonts'), NS.w, 'ascii');
    if (f) s.font = f;
  };
  const dd = all(doc, NS.w, 'docDefaults')[0];
  if (dd) fromRun(kid(kid(dd, NS.w, 'rPrDefault'), NS.w, 'rPr'), defaults);
  for (const st of all(doc, NS.w, 'style')) {
    const id = attr(st, NS.w, 'styleId');
    if (!id) continue;
    const s: WStyle = {};
    s.base = attr(kid(st, NS.w, 'basedOn'), NS.w, 'val') ?? undefined;
    fromRun(kid(st, NS.w, 'rPr'), s);
    const pPr = kid(st, NS.w, 'pPr');
    const jc = attr(kid(pPr, NS.w, 'jc'), NS.w, 'val');
    if (jc) s.align = jc;
    const sp = kid(pPr, NS.w, 'spacing');
    const before = attr(sp, NS.w, 'before'), after = attr(sp, NS.w, 'after');
    if (before) s.before = +before / 20;
    if (after) s.after = +after / 20;
    const name = attr(kid(st, NS.w, 'name'), NS.w, 'val') ?? '';
    const m = /heading\s*(\d)/i.exec(name);
    if (m) s.heading = +m[1];
    styles.set(id, s);
  }
  return { styles, defaults };
}

function resolveStyle(id: string | null, styles: Map<string, WStyle>, guard = 0): WStyle {
  if (!id || guard > 8) return {};
  const s = styles.get(id);
  if (!s) return {};
  return { ...resolveStyle(s.base ?? null, styles, guard + 1), ...s };
}

function wordNumbering(zip: Unzipped): (numId: string, level: number) => { bullet: boolean; start: number } {
  const doc = read(zip, 'word/numbering.xml');
  const abstract = new Map<string, Element>();
  const nums = new Map<string, string>();
  if (doc) {
    for (const a of all(doc, NS.w, 'abstractNum')) abstract.set(attr(a, NS.w, 'abstractNumId') ?? '', a);
    for (const n of all(doc, NS.w, 'num')) nums.set(attr(n, NS.w, 'numId') ?? '', attr(kid(n, NS.w, 'abstractNumId'), NS.w, 'val') ?? '');
  }
  return (numId, level) => {
    const a = abstract.get(nums.get(numId) ?? '');
    const lvl = a ? kids(a, NS.w, 'lvl').find(l => attr(l, NS.w, 'ilvl') === String(level)) : null;
    const fmt = attr(kid(lvl, NS.w, 'numFmt'), NS.w, 'val');
    return { bullet: !fmt || fmt === 'bullet', start: +(attr(kid(lvl, NS.w, 'start'), NS.w, 'val') ?? 1) };
  };
}

export function docxToPrint(bytes: Uint8Array): PrintJob {
  const zip = unzipSync(bytes);
  const main = read(zip, 'word/document.xml');
  if (!main) throw new Error('This is not a Word document.');
  const rels = relationships(zip, 'word/document.xml');
  const { styles, defaults } = wordStyles(zip);
  const numbering = wordNumbering(zip);
  const counters = new Map<string, number>();
  const body = all(main, NS.w, 'body')[0];

  const run = (r: Element, base: WStyle): string => {
    const rPr = kid(r, NS.w, 'rPr');
    const rs = resolveStyle(attr(kid(rPr, NS.w, 'rStyle'), NS.w, 'val'), styles);
    const on = (n: string, inherited?: boolean) => {
      const e = kid(rPr, NS.w, n);
      return e ? attr(e, NS.w, 'val') !== '0' && attr(e, NS.w, 'val') !== 'false' : inherited;
    };
    const css: string[] = [];
    const size = attr(kid(rPr, NS.w, 'sz'), NS.w, 'val');
    if (size) css.push(`font-size:${+size / 2}pt`);
    else if (rs.size) css.push(`font-size:${rs.size}pt`);
    if (on('b', rs.bold ?? base.bold)) css.push('font-weight:700');
    if (on('i', rs.italic ?? base.italic)) css.push('font-style:italic');
    const deco: string[] = [];
    if (kid(rPr, NS.w, 'u') && attr(kid(rPr, NS.w, 'u'), NS.w, 'val') !== 'none') deco.push('underline');
    if (on('strike')) deco.push('line-through');
    if (deco.length) css.push(`text-decoration:${deco.join(' ')}`);
    const col = attr(kid(rPr, NS.w, 'color'), NS.w, 'val');
    if (col && col !== 'auto') css.push(`color:#${col}`);
    else if (rs.color) css.push(`color:${rs.color}`);
    const hl = attr(kid(rPr, NS.w, 'highlight'), NS.w, 'val');
    if (hl && hl !== 'none') css.push(`background:${hl}`);
    const shd = attr(kid(rPr, NS.w, 'shd'), NS.w, 'fill');
    if (shd && shd !== 'auto') css.push(`background:#${shd}`);
    const font = attr(kid(rPr, NS.w, 'rFonts'), NS.w, 'ascii');
    if (font) css.push(`font-family:"${font}"`);
    const va = attr(kid(rPr, NS.w, 'vertAlign'), NS.w, 'val');
    if (va === 'superscript') css.push('vertical-align:super;font-size:70%');
    if (va === 'subscript') css.push('vertical-align:sub;font-size:70%');

    let html = '';
    for (const c of [...r.children]) {
      if (c.namespaceURI !== NS.w && c.localName !== 'drawing') continue;
      if (c.localName === 't') html += esc(c.textContent ?? '');
      else if (c.localName === 'tab') html += '<span style="display:inline-block;width:36pt"></span>';
      else if (c.localName === 'br') html += attr(c, NS.w, 'type') === 'page' ? '<div class="pagebreak"></div>' : '<br>';
      else if (c.localName === 'drawing') {
        const blip = all(c, NS.a, 'blip')[0];
        const id = attr(blip, NS.r, 'embed');
        const url = id ? dataUrl(zip, rels.get(id)?.target ?? '') : null;
        const ext = all(c, NS.wp, 'extent')[0];
        const w = +(ext?.getAttribute('cx') ?? 0) / 12700, h = +(ext?.getAttribute('cy') ?? 0) / 12700;
        if (url) html += `<img src="${url}" alt="" style="${w ? `width:${w}pt;height:${h}pt` : ''}">`;
      }
    }
    return css.length ? `<span style="${css.join(';')}">${html}</span>` : html;
  };

  const paragraph = (p: Element): string => {
    const pPr = kid(p, NS.w, 'pPr');
    const styleId = attr(kid(pPr, NS.w, 'pStyle'), NS.w, 'val');
    const st = resolveStyle(styleId, styles);
    const css: string[] = [];
    if (st.size) css.push(`font-size:${st.size}pt`);
    if (st.color) css.push(`color:${st.color}`);
    if (st.bold) css.push('font-weight:700');
    if (st.italic) css.push('font-style:italic');
    if (st.font) css.push(`font-family:"${st.font}"`);
    const jc = attr(kid(pPr, NS.w, 'jc'), NS.w, 'val') ?? st.align;
    const rtl = !!kid(pPr, NS.w, 'bidi');
    if (jc) css.push(`text-align:${{ both: 'justify', start: 'left', end: 'right', center: 'center', left: rtl ? 'right' : 'left', right: rtl ? 'left' : 'right', distribute: 'justify' }[jc] ?? jc}`);
    const sp = kid(pPr, NS.w, 'spacing');
    const before = attr(sp, NS.w, 'before'), after = attr(sp, NS.w, 'after'), line = attr(sp, NS.w, 'line');
    css.push(`margin-top:${before ? +before / 20 : st.before ?? 0}pt`);
    css.push(`margin-bottom:${after ? +after / 20 : st.after ?? 6}pt`);
    if (line && attr(sp, NS.w, 'lineRule') !== 'exact' && attr(sp, NS.w, 'lineRule') !== 'atLeast') css.push(`line-height:${(+line / 240).toFixed(2)}`);
    const ind = kid(pPr, NS.w, 'ind');
    const left = attr(ind, NS.w, 'left') ?? attr(ind, NS.w, 'start');
    if (left) css.push(`margin-${rtl ? 'right' : 'left'}:${+left / 20}pt`);
    const first = attr(ind, NS.w, 'firstLine');
    const hanging = attr(ind, NS.w, 'hanging');
    if (first) css.push(`text-indent:${+first / 20}pt`);
    if (hanging) css.push(`text-indent:-${+hanging / 20}pt`);
    const shade = attr(kid(pPr, NS.w, 'shd'), NS.w, 'fill');
    if (shade && shade !== 'auto') css.push(`background:#${shade}`);
    let html = '';
    let listAttr = '';
    const numPr = kid(pPr, NS.w, 'numPr');
    if (numPr) {
      const numId = attr(kid(numPr, NS.w, 'numId'), NS.w, 'val') ?? '0';
      const lvl = +(attr(kid(numPr, NS.w, 'ilvl'), NS.w, 'val') ?? 0);
      if (numId !== '0') {
        const info = numbering(numId, lvl);
        const key = `${numId}:${lvl}`;
        const n = (counters.get(key) ?? info.start - 1) + 1;
        counters.set(key, n);
        for (const k of counters.keys()) if (k.startsWith(`${numId}:`) && +k.split(':')[1] > lvl) counters.delete(k);
        if (!left) css.push(`margin-${rtl ? 'right' : 'left'}:${18 * (lvl + 1)}pt`);
        if (!hanging) css.push('text-indent:-14pt');
        html += `<span class="wnum" style="display:inline-block;width:14pt;text-indent:0">${info.bullet ? ['•', '◦', '▪'][lvl % 3] : `${n}.`}</span>`;
        listAttr = ` data-num="${info.bullet ? 'bullet' : 'decimal'}" data-lvl="${lvl}"`;
      }
    }
    for (const c of [...p.children]) {
      if (c.localName === 'r') html += run(c, st);
      else if (c.localName === 'hyperlink') {
        const id = attr(c, NS.r, 'id');
        const href = id ? rels.get(id)?.target : null;
        const inner = kids(c, NS.w, 'r').map(r => run(r, st)).join('');
        html += href ? `<a href="${esc(href)}">${inner}</a>` : inner;
      } else if (c.localName === 'ins' || c.localName === 'smartTag' || c.localName === 'sdt') {
        for (const r of all(c, NS.w, 'r')) html += run(r, st);
      }
    }
    const tag = st.heading ? `h${Math.min(6, st.heading)}` : 'p';
    return `<${tag} dir="${rtl ? 'rtl' : 'auto'}"${listAttr} style="${css.join(';')}">${html || '&nbsp;'}</${tag}>`;
  };

  const table = (t: Element): string => {
    const rows = kids(t, NS.w, 'tr').map(tr => {
      const cells = kids(tr, NS.w, 'tc').map(tc => {
        const tcPr = kid(tc, NS.w, 'tcPr');
        if (kid(tcPr, NS.w, 'vMerge') && attr(kid(tcPr, NS.w, 'vMerge'), NS.w, 'val') !== 'restart') return '<td style="border-top:0"></td>';
        const span = attr(kid(tcPr, NS.w, 'gridSpan'), NS.w, 'val');
        const fill = attr(kid(tcPr, NS.w, 'shd'), NS.w, 'fill');
        const w = attr(kid(tcPr, NS.w, 'tcW'), NS.w, 'w');
        const type = attr(kid(tcPr, NS.w, 'tcW'), NS.w, 'type');
        const style = [fill && fill !== 'auto' ? `background:#${fill}` : '', w && type === 'dxa' ? `width:${+w / 20}pt` : ''].filter(Boolean).join(';');
        const content = [...tc.children].map(c => (c.localName === 'p' ? paragraph(c) : c.localName === 'tbl' ? table(c) : '')).join('');
        return `<td${span ? ` colspan="${span}"` : ''} style="${style}">${content}</td>`;
      });
      return `<tr>${cells.join('')}</tr>`;
    });
    return `<table class="wt">${rows.join('')}</table>`;
  };

  const parts: string[] = [];
  for (const c of [...(body?.children ?? [])]) {
    if (c.localName === 'p') parts.push(paragraph(c));
    else if (c.localName === 'tbl') parts.push(table(c));
    else if (c.localName === 'sdt') for (const p of all(c, NS.w, 'p')) parts.push(paragraph(p));
  }
  const sect = kid(body, NS.w, 'sectPr');
  const pg = kid(sect, NS.w, 'pgSz');
  const mar = kid(sect, NS.w, 'pgMar');
  const widthIn = +(attr(pg, NS.w, 'w') ?? 12240) / 1440, heightIn = +(attr(pg, NS.w, 'h') ?? 15840) / 1440;
  const marginIn = Math.max(0, +(attr(mar, NS.w, 'left') ?? 1440) / 1440);
  const defaultStyle = resolveStyle('Normal', styles);
  const css = `body{font-family:${defaultStyle.font ? `"${defaultStyle.font}",` : ''}${defaults.font ? `"${defaults.font}",` : ''}Calibri,Arial,sans-serif;font-size:${defaultStyle.size ?? defaults.size ?? 11}pt;line-height:1.15}h1,h2,h3,h4,h5,h6{margin:0;break-after:avoid}.wt{width:100%;margin:6pt 0}.wt td{border:0.5pt solid #888;padding:3pt 5pt;vertical-align:top}.wt p{margin-bottom:0!important}a{color:#0563c1}`;
  return { html: wrap(css, parts.join('')), widthIn, heightIn, marginIn };
}

// ---- Excel ----

const colIndex = (ref: string) => {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
};

export function xlsxToPrint(bytes: Uint8Array): PrintJob {
  const zip = unzipSync(bytes);
  const book = read(zip, 'xl/workbook.xml');
  if (!book) throw new Error('This is not an Excel workbook.');
  const rels = relationships(zip, 'xl/workbook.xml');
  const sstDoc = read(zip, 'xl/sharedStrings.xml');
  const shared = sstDoc ? all(sstDoc, NS.s, 'si').map(si => all(si, NS.s, 't').map(t => t.textContent ?? '').join('')) : [];

  const stylesDoc = read(zip, 'xl/styles.xml');
  const fonts = stylesDoc ? kids(all(stylesDoc, NS.s, 'fonts')[0], NS.s, 'font') : [];
  const fills = stylesDoc ? kids(all(stylesDoc, NS.s, 'fills')[0], NS.s, 'fill') : [];
  const xfs = stylesDoc ? kids(all(stylesDoc, NS.s, 'cellXfs')[0], NS.s, 'xf') : [];
  const cellCss = (s: string | null): string => {
    const xf = s !== null ? xfs[+s] : null;
    if (!xf) return '';
    const css: string[] = [];
    const font = fonts[+(xf.getAttribute('fontId') ?? 0)];
    if (kid(font, NS.s, 'b')) css.push('font-weight:700');
    if (kid(font, NS.s, 'i')) css.push('font-style:italic');
    const color = kid(font, NS.s, 'color')?.getAttribute('rgb');
    if (color && color.length === 8) css.push(`color:#${color.slice(2)}`);
    const fg = kid(kid(fills[+(xf.getAttribute('fillId') ?? 0)], NS.s, 'patternFill'), NS.s, 'fgColor')?.getAttribute('rgb');
    if (fg && fg.length === 8) css.push(`background:#${fg.slice(2)}`);
    const h2 = kid(xf, NS.s, 'alignment')?.getAttribute('horizontal');
    if (h2) css.push(`text-align:${h2}`);
    return css.join(';');
  };

  const sheets = all(book, NS.s, 'sheet');
  const parts: string[] = [];
  sheets.forEach((sheet, index) => {
    const rid = attr(sheet, NS.r, 'id');
    const path = rid ? rels.get(rid)?.target : null;
    const doc = path ? read(zip, path) : null;
    if (!doc) return;
    let maxCol = 0;
    const rows = all(doc, NS.s, 'row').map(row => {
      const cells = new Map<number, string>();
      for (const c of kids(row, NS.s, 'c')) {
        const ref = c.getAttribute('r') ?? '';
        const col = colIndex(ref);
        maxCol = Math.max(maxCol, col);
        const type = c.getAttribute('t');
        const v = kid(c, NS.s, 'v')?.textContent ?? '';
        let text = v;
        if (type === 's') text = shared[+v] ?? '';
        else if (type === 'inlineStr') text = all(c, NS.s, 't').map(t => t.textContent ?? '').join('');
        else if (type === 'b') text = v === '1' ? 'TRUE' : 'FALSE';
        const numeric = !type || type === 'n';
        const style = cellCss(c.getAttribute('s')) + (numeric && text && !cellCss(c.getAttribute('s')).includes('text-align') ? ';text-align:right' : '');
        cells.set(col, `<td style="${style}">${esc(numeric && text ? formatNumber(text) : text)}</td>`);
      }
      return cells;
    });
    if (!rows.some(r => r.size)) return;
    const html = rows.map(cells => {
      let tds = '';
      for (let c = 0; c <= maxCol; c++) tds += cells.get(c) ?? '<td></td>';
      return `<tr>${tds}</tr>`;
    }).join('');
    const name = sheet.getAttribute('name') ?? `Sheet ${index + 1}`;
    parts.push(`<section class="${index < sheets.length - 1 ? 'pagebreak' : ''}"><h2>${esc(name)}</h2><table class="xt">${html}</table></section>`);
  });
  const css = `body{font-family:Calibri,Arial,sans-serif;font-size:9.5pt}h2{font-size:12pt;margin:0 0 6pt}.xt td{border:0.5pt solid #bbb;padding:1.5pt 4pt;white-space:nowrap}section{margin-bottom:10pt}`;
  return { html: wrap(css, parts.join('')), widthIn: 11, heightIn: 8.5, marginIn: 0.4 };
}

function formatNumber(v: string): string {
  const n = +v;
  if (!Number.isFinite(n)) return v;
  return Number.isInteger(n) ? String(n) : String(+n.toFixed(6));
}

// ---- PowerPoint ----

const EMU = 12700;

export function pptxToPrint(bytes: Uint8Array): PrintJob {
  const zip = unzipSync(bytes);
  const pres = read(zip, 'ppt/presentation.xml');
  if (!pres) throw new Error('This is not a PowerPoint file.');
  const presRels = relationships(zip, 'ppt/presentation.xml');
  const size = all(pres, NS.p, 'sldSz')[0];
  const sw = +(size?.getAttribute('cx') ?? 9144000) / EMU, sh = +(size?.getAttribute('cy') ?? 6858000) / EMU;

  const theme = new Map<string, string>();
  const themePath = Object.keys(zip).find(k => /ppt\/theme\/theme\d*\.xml$/.test(k));
  if (themePath) {
    const t = read(zip, themePath);
    const scheme = t && all(t, NS.a, 'clrScheme')[0];
    for (const c of [...(scheme?.children ?? [])]) {
      const col = c.firstElementChild;
      const v = col?.getAttribute('val') ?? col?.getAttribute('lastClr');
      if (v) theme.set(c.localName, `#${v}`);
    }
  }
  const schemeMap: Record<string, string> = { tx1: 'dk1', tx2: 'dk2', bg1: 'lt1', bg2: 'lt2' };
  const colourOf = (el: Element | null): string | null => {
    if (!el) return null;
    const rgb = kid(el, NS.a, 'srgbClr')?.getAttribute('val');
    if (rgb) return `#${rgb}`;
    const sc = kid(el, NS.a, 'schemeClr')?.getAttribute('val');
    if (sc) return theme.get(schemeMap[sc] ?? sc) ?? null;
    return null;
  };

  /** Finds the box a placeholder inherits from its layout or master. */
  const placeholderBoxes = (path: string) => {
    const doc = read(zip, path);
    const out = new Map<string, Element>();
    if (!doc) return out;
    for (const sp of all(doc, NS.p, 'sp')) {
      const ph = all(sp, NS.p, 'ph')[0];
      const xfrm = kid(kid(sp, NS.p, 'spPr'), NS.a, 'xfrm');
      if (!ph || !xfrm) continue;
      const type = ph.getAttribute('type') ?? 'body', idx = ph.getAttribute('idx') ?? '';
      out.set(`${type}:${idx}`, xfrm);
      if (!out.has(type)) out.set(type, xfrm);
    }
    return out;
  };

  const slideIds = all(pres, NS.p, 'sldId');
  const pages: string[] = [];
  slideIds.forEach((sid, index) => {
    const rid = attr(sid, NS.r, 'id');
    const path = rid ? presRels.get(rid)?.target : null;
    const doc = path ? read(zip, path) : null;
    if (!doc || !path) return;
    const rels = relationships(zip, path);
    const layoutPath = [...rels.values()].find(r => /slideLayout/.test(r.target))?.target;
    const layoutBoxes = layoutPath ? placeholderBoxes(layoutPath) : new Map<string, Element>();
    const masterPath = layoutPath ? [...relationships(zip, layoutPath).values()].find(r => /slideMaster/.test(r.target))?.target : undefined;
    const masterBoxes = masterPath ? placeholderBoxes(masterPath) : new Map<string, Element>();

    const items: string[] = [];
    const place = (xfrm: Element | null) => {
      const off = kid(xfrm, NS.a, 'off'), ext = kid(xfrm, NS.a, 'ext');
      if (!off || !ext) return null;
      const rot = +(xfrm?.getAttribute('rot') ?? 0) / 60000;
      return `left:${+off.getAttribute('x')! / EMU}pt;top:${+off.getAttribute('y')! / EMU}pt;width:${+ext.getAttribute('cx')! / EMU}pt;height:${+ext.getAttribute('cy')! / EMU}pt;${rot ? `transform:rotate(${rot}deg);` : ''}`;
    };

    const paragraphs = (body: Element | null, isTitle: boolean): string => {
      const out = kids(body, NS.a, 'p').map(p => {
        const pPr = kid(p, NS.a, 'pPr');
        const algn = pPr?.getAttribute('algn');
        const css = [algn ? `text-align:${{ l: 'left', ctr: 'center', r: 'right', just: 'justify' }[algn] ?? 'left'}` : ''];
        const bullet = !!kid(pPr, NS.a, 'buChar') || (!isTitle && !kid(pPr, NS.a, 'buNone') && (+(pPr?.getAttribute('lvl') ?? 0) > 0));
        const char = kid(pPr, NS.a, 'buChar')?.getAttribute('char') ?? '•';
        const runs = [...p.children].filter(c => c.localName === 'r' || c.localName === 'br' || c.localName === 'fld').map(r => {
          if (r.localName === 'br') return '<br>';
          const rPr = kid(r, NS.a, 'rPr');
          const st: string[] = [];
          const sz = rPr?.getAttribute('sz');
          if (sz) st.push(`font-size:${+sz / 100}pt`);
          if (rPr?.getAttribute('b') === '1') st.push('font-weight:700');
          if (rPr?.getAttribute('i') === '1') st.push('font-style:italic');
          if (rPr?.getAttribute('u') && rPr.getAttribute('u') !== 'none') st.push('text-decoration:underline');
          const col = colourOf(kid(rPr, NS.a, 'solidFill'));
          if (col) st.push(`color:${col}`);
          const face = kid(rPr, NS.a, 'latin')?.getAttribute('typeface');
          if (face && !face.startsWith('+')) st.push(`font-family:"${face}"`);
          return `<span style="${st.join(';')}">${esc(kid(r, NS.a, 't')?.textContent ?? '')}</span>`;
        }).join('');
        const lvl = +(pPr?.getAttribute('lvl') ?? 0);
        if (lvl) css.push(`margin-left:${lvl * 18}pt`);
        return `<p dir="auto" style="${css.filter(Boolean).join(';')}">${bullet ? `<span style="margin-right:6pt">${esc(char)}</span>` : ''}${runs || '&nbsp;'}</p>`;
      });
      return out.join('');
    };

    for (const el of all(doc, NS.p, 'spTree')[0]?.children ? [...all(doc, NS.p, 'spTree')[0].children] : []) {
      if (el.localName === 'sp') {
        const spPr = kid(el, NS.p, 'spPr');
        const ph = all(el, NS.p, 'ph')[0];
        const type = ph?.getAttribute('type') ?? (ph ? 'body' : '');
        const idx = ph?.getAttribute('idx') ?? '';
        const xfrm = kid(spPr, NS.a, 'xfrm') ?? layoutBoxes.get(`${type}:${idx}`) ?? layoutBoxes.get(type) ?? masterBoxes.get(type) ?? (type === 'ctrTitle' ? masterBoxes.get('title') : null) ?? null;
        const box = place(xfrm);
        if (!box) continue;
        const fill = colourOf(kid(spPr, NS.a, 'solidFill'));
        const geom = kid(spPr, NS.a, 'prstGeom')?.getAttribute('prst');
        const line = kid(spPr, NS.a, 'ln');
        const lineCol = colourOf(kid(line, NS.a, 'solidFill'));
        const isTitle = type === 'title' || type === 'ctrTitle';
        const baseSize = isTitle ? (type === 'ctrTitle' ? 40 : 32) : type === 'subTitle' ? 20 : 16;
        const bodyPr = kid(kid(el, NS.p, 'txBody'), NS.a, 'bodyPr');
        const anchor = bodyPr?.getAttribute('anchor');
        const style = [
          box, fill ? `background:${fill};` : '',
          geom === 'ellipse' ? 'border-radius:50%;' : geom === 'roundRect' ? 'border-radius:8pt;' : '',
          lineCol ? `border:${+(line?.getAttribute('w') ?? 9525) / EMU}pt solid ${lineCol};` : '',
          `font-size:${baseSize}pt;`, isTitle ? 'font-weight:600;' : '',
          type === 'ctrTitle' || type === 'subTitle' ? 'text-align:center;' : '',
          anchor === 'ctr' ? 'display:flex;flex-direction:column;justify-content:center;' : anchor === 'b' ? 'display:flex;flex-direction:column;justify-content:flex-end;' : '',
        ].join('');
        items.push(`<div class="sh" style="${style}">${paragraphs(kid(el, NS.p, 'txBody'), isTitle)}</div>`);
      } else if (el.localName === 'pic') {
        const id = attr(all(el, NS.a, 'blip')[0], NS.r, 'embed');
        const url = id ? dataUrl(zip, rels.get(id)?.target ?? '') : null;
        const box = place(kid(kid(el, NS.p, 'spPr'), NS.a, 'xfrm'));
        if (url && box) items.push(`<img class="sh" alt="" src="${url}" style="${box}object-fit:fill;max-width:none">`);
      } else if (el.localName === 'graphicFrame') {
        const box = place(kid(el, NS.p, 'xfrm'));
        const tbl = all(el, NS.a, 'tbl')[0];
        if (box && tbl) {
          const rows = kids(tbl, NS.a, 'tr').map(tr => `<tr>${kids(tr, NS.a, 'tc').map(tc => `<td style="${colourOf(kid(kid(tc, NS.a, 'tcPr'), NS.a, 'solidFill')) ? `background:${colourOf(kid(kid(tc, NS.a, 'tcPr'), NS.a, 'solidFill'))}` : ''}">${paragraphs(kid(tc, NS.a, 'txBody'), false)}</td>`).join('')}</tr>`).join('');
          items.push(`<div class="sh" style="${box}"><table class="pt">${rows}</table></div>`);
        }
      }
    }
    const bg = colourOf(kid(kid(kid(all(doc, NS.p, 'cSld')[0], NS.p, 'bg'), NS.p, 'bgPr'), NS.a, 'solidFill'));
    pages.push(`<div class="slide${index < slideIds.length - 1 ? ' pagebreak' : ''}" style="${bg ? `background:${bg}` : ''}">${items.join('')}</div>`);
  });
  const css = `body{font-family:Calibri,Arial,sans-serif;line-height:1.1}.slide{position:relative;width:${sw}pt;height:${sh}pt;overflow:hidden;background:#fff}.sh{position:absolute;padding:3pt 6pt}img.sh{padding:0}.sh p{margin:0 0 4pt}.pt{width:100%;font-size:12pt}.pt td{border:0.5pt solid #999;padding:3pt 5pt}`;
  return { html: wrap(css, pages.join('')), widthIn: sw / 72, heightIn: sh / 72, marginIn: 0 };
}

export const OFFICE_ACCEPT = '.docx,.xlsx,.pptx';

export async function officeToPrint(file: File): Promise<PrintJob> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error('This looks like an old Office format (.doc, .xls or .ppt). Save it as .docx, .xlsx or .pptx first.');
  }
  const name = file.name.toLowerCase();
  if (name.endsWith('.docx')) return docxToPrint(bytes);
  if (name.endsWith('.xlsx')) return xlsxToPrint(bytes);
  if (name.endsWith('.pptx')) return pptxToPrint(bytes);
  throw new Error('Choose a .docx, .xlsx or .pptx file.');
}

// ---- Talking to the Windows app's print engine ----

let nextId = 1;
const waiting = new Map<number, { resolve(b: Blob): void; reject(e: Error): void }>();

export const canPrintToPdf = () => !!window.chrome?.webview;

export function onHostMessage(data: { type?: string; id?: number; ok?: boolean; file?: string; error?: string }) {
  if (data.type !== 'printed' || data.id === undefined) return;
  const job = waiting.get(data.id);
  if (!job) return;
  waiting.delete(data.id);
  if (!data.ok || !data.file) { job.reject(new Error(data.error ?? 'The page could not be turned into a PDF.')); return; }
  fetch(`https://print.pdfy.local/${encodeURIComponent(data.file)}`)
    .then(r => { if (!r.ok) throw new Error(`Could not read the result (${r.status}).`); return r.blob(); })
    .then(b => job.resolve(new Blob([b], { type: 'application/pdf' })), job.reject);
}

/** Asks the Windows app to print a page or web address to a PDF. */
export function printToPdf(job: { html?: string; url?: string; widthIn: number; heightIn: number; marginIn: number }): Promise<Blob> {
  const webview = window.chrome?.webview;
  if (!webview) return Promise.reject(new Error('This needs the Meletiq PDF desktop app.'));
  const id = nextId++;
  return new Promise<Blob>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    webview.postMessage({ type: 'print', id, ...job });
    setTimeout(() => {
      if (waiting.delete(id)) reject(new Error('This took too long and was stopped.'));
    }, 180000);
  });
}
