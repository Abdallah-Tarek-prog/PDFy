// A simple Word document editor: open a .docx, change it in place, save it as .docx or PDF.
// It handles everyday documents: headings, formatting, lists, tables and pictures. Page headers,
// footnotes, tracked changes and text boxes from the original are not kept.

import { strToU8, zipSync, type Zippable } from 'fflate';
import { clear, h, icon, safe, toast } from '../ui/dom';
import { openDialog } from '../ui/dialogs';
import { docxToPrint } from './office';

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

interface RunStyle { b?: boolean; i?: boolean; u?: boolean; s?: boolean; color?: string; size?: number; bg?: string; font?: string }

/** Any CSS colour to a six-digit hex, using the browser's own parser. */
function toHex(colour: string): string | null {
  if (!colour) return null;
  const probe = new OffscreenCanvas(1, 1).getContext('2d')!;
  probe.fillStyle = '#000';
  probe.fillStyle = colour;
  const v = String(probe.fillStyle);
  const m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return m[1].toUpperCase();
  const r = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(v);
  if (!r || r[4] === '0') return null;
  return [r[1], r[2], r[3]].map(n => (+n).toString(16).padStart(2, '0')).join('').toUpperCase();
}

const PT = (css: string): number | undefined => {
  const m = /([\d.]+)(pt|px)/.exec(css);
  if (!m) return undefined;
  return m[2] === 'pt' ? +m[1] : +m[1] * 0.75;
};

/** Turns the edited page back into a Word file. */
export async function htmlToDocx(root: HTMLElement, page: { widthIn: number; heightIn: number; marginIn: number }): Promise<Blob> {
  const media: Zippable = {};
  const rels: string[] = [];
  let pictures = 0, links = 0;

  const dataToBytes = (url: string): { bytes: Uint8Array; ext: string } | null => {
    const m = /^data:image\/(png|jpe?g|gif|bmp);base64,(.*)$/i.exec(url);
    if (!m) return null;
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, ext: m[1].toLowerCase().replace('jpeg', 'jpg') };
  };

  const picture = (img: HTMLImageElement): string => {
    const data = dataToBytes(img.src);
    if (!data) return '';
    pictures++;
    const rid = `rIdImg${pictures}`;
    const path = `media/image${pictures}.${data.ext}`;
    media[`word/${path}`] = [data.bytes, { level: 0 }];
    rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${path}"/>`);
    const maxW = (page.widthIn - page.marginIn * 2) * 72;
    let w = PT(img.style.width) ?? (img.width || img.naturalWidth) * 0.75;
    let ht = PT(img.style.height) ?? (img.height || img.naturalHeight) * 0.75;
    if (w > maxW) { ht *= maxW / w; w = maxW; }
    const cx = Math.round(w * 12700), cy = Math.round(ht * 12700);
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${pictures}" name="Picture ${pictures}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${pictures}" name="Picture ${pictures}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  };

  const runProps = (st: RunStyle, rtl: boolean) => {
    let out = '';
    if (st.font) out += `<w:rFonts w:ascii="${esc(st.font)}" w:hAnsi="${esc(st.font)}" w:cs="${esc(st.font)}"/>`;
    if (st.b) out += '<w:b/>';
    if (st.i) out += '<w:i/>';
    if (st.s) out += '<w:strike/>';
    if (st.color) out += `<w:color w:val="${st.color}"/>`;
    if (st.size) out += `<w:sz w:val="${Math.round(st.size * 2)}"/>`;
    if (st.u) out += '<w:u w:val="single"/>';
    if (st.bg) out += `<w:shd w:val="clear" w:color="auto" w:fill="${st.bg}"/>`;
    if (rtl) out += '<w:rtl/>';
    return out ? `<w:rPr>${out}</w:rPr>` : '';
  };

  const inline = (node: Node, st: RunStyle): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent ?? '';
      if (!t) return '';
      return `<w:r>${runProps(st, RTL.test(t))}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
    }
    if (!(node instanceof HTMLElement)) return '';
    const tag = node.tagName;
    if (tag === 'BR') return '<w:r><w:br/></w:r>';
    if (tag === 'IMG') return picture(node as HTMLImageElement);
    if (node.classList.contains('wnum')) return '';
    if (node.classList.contains('pagebreak')) return '<w:r><w:br w:type="page"/></w:r>';
    const next: RunStyle = { ...st };
    if (tag === 'B' || tag === 'STRONG') next.b = true;
    if (tag === 'I' || tag === 'EM') next.i = true;
    if (tag === 'U') next.u = true;
    if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') next.s = true;
    const css = node.style;
    if (css.fontWeight === '700' || css.fontWeight === 'bold') next.b = true;
    if (css.fontWeight === '400' || css.fontWeight === 'normal') next.b = false;
    if (css.fontStyle === 'italic') next.i = true;
    if (css.textDecorationLine.includes('underline') || css.textDecoration.includes('underline')) next.u = true;
    if (css.textDecorationLine.includes('line-through') || css.textDecoration.includes('line-through')) next.s = true;
    if (css.color) next.color = toHex(css.color) ?? next.color;
    if (css.backgroundColor) next.bg = toHex(css.backgroundColor) ?? next.bg;
    if (css.fontSize) next.size = PT(css.fontSize) ?? next.size;
    if (css.fontFamily) next.font = css.fontFamily.split(',')[0].replace(/["']/g, '').trim() || next.font;
    const fontAttr = node.getAttribute('color');
    if (tag === 'FONT' && fontAttr) next.color = toHex(fontAttr) ?? next.color;
    const inner = [...node.childNodes].map(c => inline(c, next)).join('');
    if (tag === 'A') {
      const href = node.getAttribute('href');
      if (href && /^(https?:|mailto:)/i.test(href)) {
        links++;
        const rid = `rIdLink${links}`;
        rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(href)}" TargetMode="External"/>`);
        const linked = [...node.childNodes].map(c => inline(c, { ...next, color: next.color ?? '0563C1', u: true })).join('');
        return `<w:hyperlink r:id="${rid}">${linked}</w:hyperlink>`;
      }
    }
    return inner;
  };

  const blockProps = (el: HTMLElement, extra = ''): string => {
    const css = el.style;
    const align = css.textAlign || el.getAttribute('align') || '';
    const jc = { left: 'left', right: 'right', center: 'center', justify: 'both', start: 'left', end: 'right' }[align];
    const rtl = el.getAttribute('dir') === 'rtl' || (el.getAttribute('dir') !== 'ltr' && RTL.test(el.textContent ?? ''));
    let out = extra;
    if (rtl) out += '<w:bidi/>';
    const before = PT(css.marginTop), after = PT(css.marginBottom);
    if (before !== undefined || after !== undefined) out += `<w:spacing${before !== undefined ? ` w:before="${Math.round(before * 20)}"` : ''}${after !== undefined ? ` w:after="${Math.round(after * 20)}"` : ''}/>`;
    if (jc) out += `<w:jc w:val="${jc}"/>`;
    return out ? `<w:pPr>${out}</w:pPr>` : '';
  };

  const paragraph = (el: HTMLElement, styleId?: string, listNum?: { id: number; lvl: number }): string => {
    let extra = '';
    if (styleId) extra += `<w:pStyle w:val="${styleId}"/>`;
    if (listNum) extra += `<w:numPr><w:ilvl w:val="${listNum.lvl}"/><w:numId w:val="${listNum.id}"/></w:numPr>`;
    const body = [...el.childNodes].map(c => inline(c, {})).join('');
    return `<w:p>${blockProps(el, extra)}${body}</w:p>`;
  };

  const list = (el: HTMLElement, lvl: number): string => {
    const id = el.tagName === 'OL' ? 2 : 1;
    return [...el.children].map(li => {
      const nested = [...li.children].filter(c => c.tagName === 'UL' || c.tagName === 'OL') as HTMLElement[];
      nested.forEach(n => n.remove());
      const self = paragraph(li as HTMLElement, undefined, { id, lvl });
      const kids = nested.map(n => list(n, lvl + 1)).join('');
      nested.forEach(n => li.append(n));
      return self + kids;
    }).join('');
  };

  const table = (el: HTMLTableElement): string => {
    const rows = [...el.rows];
    const cols = Math.max(1, ...rows.map(r => [...r.cells].reduce((n, c) => n + c.colSpan, 0)));
    const usable = Math.round(((page.widthIn - page.marginIn * 2) * 1440) / cols);
    const grid = Array.from({ length: cols }, () => `<w:gridCol w:w="${usable}"/>`).join('');
    const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(e => `<w:${e} w:val="single" w:sz="4" w:space="0" w:color="888888"/>`).join('');
    const body = rows.map(r => `<w:tr>${[...r.cells].map(c => {
      const fill = toHex(c.style.backgroundColor);
      const props = `<w:tcPr><w:tcW w:w="${usable * c.colSpan}" w:type="dxa"/>${c.colSpan > 1 ? `<w:gridSpan w:val="${c.colSpan}"/>` : ''}${fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ''}</w:tcPr>`;
      const blocks = blocksOf(c);
      return `<w:tc>${props}${blocks || '<w:p/>'}</w:tc>`;
    }).join('')}</w:tr>`).join('');
    return `<w:tbl><w:tblPr><w:tblBorders>${borders}</w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`;
  };

  function blocksOf(container: HTMLElement): string {
    const out: string[] = [];
    let loose: Node[] = [];
    const flush = () => {
      if (!loose.length) return;
      const hasContent = loose.some(n => (n.textContent ?? '').trim() || n.nodeName === 'IMG' || n.nodeName === 'BR');
      if (hasContent) out.push(`<w:p>${loose.map(n => inline(n, {})).join('')}</w:p>`);
      loose = [];
    };
    for (const n of [...container.childNodes]) {
      if (n instanceof HTMLElement) {
        const tag = n.tagName;
        if (/^H[1-6]$/.test(tag)) { flush(); out.push(paragraph(n, `Heading${tag[1]}`)); continue; }
        if (tag === 'P' || tag === 'DIV' || tag === 'BLOCKQUOTE') {
          flush();
          if (n.classList.contains('pagebreak')) { out.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>'); continue; }
          const num = n.dataset.num;
          out.push(paragraph(n, undefined, num ? { id: num === 'bullet' ? 1 : 2, lvl: +(n.dataset.lvl ?? 0) } : undefined));
          continue;
        }
        if (tag === 'UL' || tag === 'OL') { flush(); out.push(list(n, 0)); continue; }
        if (tag === 'TABLE') { flush(); out.push(table(n as HTMLTableElement), '<w:p/>'); continue; }
      }
      loose.push(n);
    }
    flush();
    return out.join('');
  }

  const body = blocksOf(root) || '<w:p/>';
  const heading = (n: number, size: number) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  const bullets = ['•', '◦', '▪'];
  const levels = (fmt: 'bullet' | 'decimal') => [0, 1, 2].map(l => `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${fmt === 'bullet' ? bullets[l] : `%${l + 1}.`}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${360 * (l + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join('');
  const files: Zippable = {
    '[Content_Types].xml': strToU8(`${X}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Default Extension="bmp" ContentType="image/bmp"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`),
    '_rels/.rels': strToU8(`${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    'word/document.xml': strToU8(`${X}<w:document ${NS}><w:body>${body}<w:sectPr><w:pgSz w:w="${Math.round(page.widthIn * 1440)}" w:h="${Math.round(page.heightIn * 1440)}"/><w:pgMar w:top="${Math.round(page.marginIn * 1440)}" w:right="${Math.round(page.marginIn * 1440)}" w:bottom="${Math.round(page.marginIn * 1440)}" w:left="${Math.round(page.marginIn * 1440)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`),
    'word/_rels/document.xml.rels': strToU8(`${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdSt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdNu" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${rels.join('')}</Relationships>`),
    'word/styles.xml': strToU8(`${X}<w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${heading(1, 36)}${heading(2, 28)}${heading(3, 24)}${heading(4, 22)}${heading(5, 22)}${heading(6, 22)}</w:styles>`),
    'word/numbering.xml': strToU8(`${X}<w:numbering ${NS}><w:abstractNum w:abstractNumId="0">${levels('bullet')}</w:abstractNum><w:abstractNum w:abstractNumId="1">${levels('decimal')}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`),
    ...media,
  };
  return new Blob([zipSync(files) as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

export const WORD_CSS = `.wt{width:100%;margin:6pt 0;border-collapse:collapse}.wt td{border:0.5pt solid #888;padding:3pt 5pt;vertical-align:top}`;

export interface EditorHooks {
  save(blob: Blob, name: string): Promise<boolean>;
  toPdf(html: string, page: { widthIn: number; heightIn: number; marginIn: number }, name: string): Promise<void>;
  pickImage(): Promise<File | undefined>;
}

const BLANK = { html: '<p><br></p>', widthIn: 8.27, heightIn: 11.69, marginIn: 1 };

/** Opens the editor window. Returns once it is closed. */
export async function openDocxEditor(file: File | null, hooks: EditorHooks): Promise<void> {
  let job = BLANK;
  let extraCss = '';
  if (file) {
    const printed = docxToPrint(new Uint8Array(await file.arrayBuffer()));
    const parsed = new DOMParser().parseFromString(printed.html, 'text/html');
    extraCss = parsed.querySelector('style')?.textContent ?? '';
    job = { html: parsed.body.innerHTML, widthIn: printed.widthIn, heightIn: printed.heightIn, marginIn: Math.min(1.5, printed.marginIn) };
  }
  const base = file ? file.name.replace(/\.docx$/i, '') : 'New document';
  const sheet = h('div', { class: 'doc-sheet', contenteditable: 'true', spellcheck: true, dir: 'auto', 'aria-label': 'Document text' });
  sheet.innerHTML = job.html;
  sheet.style.width = `${job.widthIn}in`;
  sheet.style.padding = `${job.marginIn}in`;
  // Word's styles apply only inside the sheet.
  const style = h('style', null, extraCss.replace(/(^|\})\s*(html,\s*body|body)\s*\{/g, '$1 .doc-sheet{').replace(/\*\{box-sizing:border-box\}/, '').replace(/@media print\{[^}]*\}\}/, ''));
  let dirty = false;
  sheet.addEventListener('input', () => { dirty = true; });

  const exec = (cmd: string, value?: string) => {
    sheet.focus();
    document.execCommand(cmd, false, value);
    dirty = true;
  };
  const btn = (ic: string, title: string, run: () => void) => h('button', { class: 'icon-btn', title, 'aria-label': title, onmousedown: (e: Event) => e.preventDefault(), onclick: safe(run, title) }, icon(ic, 16));
  const txt = (label: string, title: string, run: () => void, css?: Record<string, string>) => h('button', { class: 'icon-btn doc-txt', title, 'aria-label': title, style: css, onmousedown: (e: Event) => e.preventDefault(), onclick: safe(run, title) }, label);

  const block = h('select', { 'aria-label': 'Paragraph style', class: 'doc-select' },
    ...[['P', 'Normal text'], ['H1', 'Heading 1'], ['H2', 'Heading 2'], ['H3', 'Heading 3']].map(([v, t]) => h('option', { value: v }, t)));
  block.addEventListener('change', () => exec('formatBlock', block.value));
  const size = h('select', { 'aria-label': 'Text size', class: 'doc-select' },
    ...[['2', '10'], ['3', '12'], ['4', '14'], ['5', '18'], ['6', '24'], ['7', '36']].map(([v, t]) => h('option', { value: v, selected: v === '3' }, t)));
  size.addEventListener('change', () => exec('fontSize', size.value));
  const colour = h('input', { type: 'color', value: '#c00000', title: 'Text colour', 'aria-label': 'Text colour', class: 'doc-colour' });
  colour.addEventListener('change', () => exec('foreColor', colour.value));

  const insertTable = () => {
    const cells = '<td><br></td><td><br></td><td><br></td>';
    exec('insertHTML', `<table class="wt"><tr>${cells}</tr><tr>${cells}</tr><tr>${cells}</tr></table><p><br></p>`);
  };
  const insertImage = async () => {
    const f = await hooks.pickImage();
    if (!f) return;
    const reader = new FileReader();
    const url = await new Promise<string>(res => { reader.onload = () => res(String(reader.result)); reader.readAsDataURL(f); });
    exec('insertImage', url);
  };
  const addLink = () => {
    const url = prompt('Web address');
    if (url) exec('createLink', /^[a-z]+:/i.test(url) ? url : `https://${url}`);
  };

  const status = h('span', { class: 'muted doc-status' });
  const saveDocx = async () => {
    const blob = await htmlToDocx(sheet, job);
    if (await hooks.save(blob, `${base}.docx`)) { dirty = false; status.textContent = 'Saved'; }
  };
  const savePdf = async () => {
    const printable = `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0;background:#fff;color:#000}body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.15}p{margin:0 0 6pt}${WORD_CSS}img{max-width:100%}${extraCss.replace(/^.*?html,body\{[^}]*\}/, '')}</style></head><body>${sheet.innerHTML}</body></html>`;
    await hooks.toPdf(printable, job, `${base}.pdf`);
  };

  const bar = h('div', { class: 'doc-bar', role: 'toolbar', 'aria-label': 'Formatting' },
    block, size,
    txt('B', 'Bold (Ctrl+B)', () => exec('bold'), { fontWeight: '700' }),
    txt('I', 'Italic (Ctrl+I)', () => exec('italic'), { fontStyle: 'italic' }),
    txt('U', 'Underline (Ctrl+U)', () => exec('underline'), { textDecoration: 'underline' }),
    colour,
    h('span', { class: 'doc-sep' }),
    btn('list', 'Bulleted list', () => exec('insertUnorderedList')),
    btn('numbers', 'Numbered list', () => exec('insertOrderedList')),
    txt('≡', 'Align left', () => exec('justifyLeft')),
    txt('≣', 'Centre', () => exec('justifyCenter')),
    h('span', { class: 'doc-sep' }),
    btn('link', 'Add link', addLink),
    btn('image', 'Insert picture', () => void insertImage()),
    btn('thumbs', 'Insert table', insertTable),
    h('span', { class: 'doc-sep' }),
    btn('undo', 'Undo (Ctrl+Z)', () => exec('undo')),
    btn('redo', 'Redo (Ctrl+Y)', () => exec('redo')),
    h('span', { style: { flex: '1' } }),
    status,
    h('button', { class: 'btn small', onclick: safe(savePdf, 'Saving as PDF') }, 'Save as PDF'),
    h('button', { class: 'btn small primary', onclick: safe(saveDocx, 'Saving') }, 'Save Word file'));

  const body = h('div', { class: 'doc-editor' }, style, bar, h('div', { class: 'doc-scroll' }, sheet));
  clear(status);

  for (;;) {
    await openDialog(`Word editor: ${base}`, body, [], true, undefined, true);
    if (!dirty) break;
    const leave = await openDialog<boolean>('Unsaved changes', h('p', null, 'Close the Word editor without saving your changes?'),
      [{ label: 'Keep editing', value: false }, { label: "Don't save", value: true, danger: true }], false);
    if (leave) break;
  }
  toast('Word editor closed.', 'info', 1500);
}
