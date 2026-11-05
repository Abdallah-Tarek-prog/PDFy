// Converting a PDF to other formats, with no outside service. Files are written by hand,
// because DOCX, XLSX and PPTX are zip files of XML.

import { strToU8, zipSync, type Zippable } from 'fflate';
import { openPdf, renderToCanvas, type PDFDocumentProxy } from '../core/engine';
import { makeViewport, type PageRef } from '../core/model';
import type { Session } from '../core/session';
import { bodyTextSize, pageBlocks } from './docmodel';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Line { text: string; x: number; y: number; size: number; bold: boolean; width: number; words: { text: string; x: number; width: number }[] }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/** Groups a page's text into reading-order lines. */
export async function linesOf(pdf: PDFDocumentProxy, index: number): Promise<Line[]> {
  const page = await pdf.getPage(index + 1);
  const content = await page.getTextContent();
  const styles = content.styles as Record<string, { fontFamily?: string }>;
  const rows: { y: number; parts: any[] }[] = [];
  for (const it of content.items as any[]) {
    if (typeof it.str !== 'string' || !it.str.trim()) continue;
    const y = it.transform[5];
    const size = Math.hypot(it.transform[2], it.transform[3]) || 10;
    const row = rows.find(r => Math.abs(r.y - y) < size * 0.45);
    if (row) row.parts.push(it);
    else rows.push({ y, parts: [it] });
  }
  rows.sort((a, b) => b.y - a.y);
  const lines: Line[] = rows.map(r => {
    r.parts.sort((a, b) => a.transform[4] - b.transform[4]);
    const first = r.parts[0];
    let text = '';
    let prevEnd: number | null = null;
    const words: Line['words'] = [];
    for (const p of r.parts) {
      const x = p.transform[4];
      const size = Math.hypot(p.transform[2], p.transform[3]) || 10;
      if (prevEnd !== null && x - prevEnd > size * 0.25 && !text.endsWith(' ')) text += ' ';
      text += p.str;
      words.push({ text: p.str, x, width: p.width ?? 0 });
      prevEnd = x + (p.width ?? 0);
    }
    const family = (styles[first.fontName]?.fontFamily ?? '') + (first.fontName ?? '');
    return { text, x: first.transform[4], y: r.y, size: Math.hypot(first.transform[2], first.transform[3]) || 10, bold: /bold|black|heavy/i.test(family), width: (prevEnd ?? first.transform[4]) - first.transform[4], words };
  });
  page.cleanup();
  return lines;
}

export interface Paragraph { text: string; size: number; bold: boolean; page: number; heading: boolean; y: number; x: number; width: number }

/** Joins lines into paragraphs. A big gap, a font change or an indent starts a new one. */
export function toParagraphs(lines: Line[], page: number, body: number): Paragraph[] {
  const out: Paragraph[] = [];
  let cur: Paragraph | null = null;
  let last: Line | null = null;
  for (const l of lines) {
    const gap = last ? last.y - l.y : 0;
    const startNew = !cur || !last || gap > last.size * 1.65 || Math.abs(l.size - last.size) > 1 || l.bold !== last.bold || gap < 0;
    if (startNew) {
      if (cur) out.push(cur);
      cur = { text: l.text, size: l.size, bold: l.bold, page, heading: l.size > body * 1.2, y: l.y, x: l.x, width: l.width };
    } else {
      const hyphen = cur!.text.endsWith('-');
      cur!.text = (hyphen ? cur!.text.slice(0, -1) : `${cur!.text} `) + l.text.trimStart();
    }
    last = l;
  }
  if (cur) out.push(cur);
  return out;
}

export type Progress = (fraction: number, text: string) => boolean;

async function gatherParagraphs(pdf: PDFDocumentProxy, progress: Progress): Promise<Paragraph[]> {
  const pagesLines: Line[][] = [];
  const sizes = new Map<number, number>();
  for (let i = 0; i < pdf.numPages; i++) {
    if (!progress(i / pdf.numPages * 0.9, `Reading page ${i + 1} of ${pdf.numPages}`)) throw new Error('cancelled');
    const lines = await linesOf(pdf, i);
    pagesLines.push(lines);
    for (const l of lines) {
      const k = Math.round(l.size);
      sizes.set(k, (sizes.get(k) ?? 0) + l.text.length);
    }
  }
  const body = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 11;
  return pagesLines.flatMap((lines, i) => toParagraphs(lines, i, body));
}

export async function exportText(pdf: PDFDocumentProxy, progress: Progress): Promise<Blob> {
  const parts: string[] = [];
  for (let i = 0; i < pdf.numPages; i++) {
    if (!progress(i / pdf.numPages, `Page ${i + 1} of ${pdf.numPages}`)) throw new Error('cancelled');
    const lines = await linesOf(pdf, i);
    parts.push(lines.map(l => l.text).join('\n'));
  }
  return new Blob([parts.join('\n\n')], { type: 'text/plain;charset=utf-8' });
}

export async function exportHtml(pdf: PDFDocumentProxy, name: string, progress: Progress): Promise<Blob> {
  const body = await bodyTextSize(pdf);
  const parts: string[] = [];
  for (let i = 0; i < pdf.numPages; i++) {
    if (!progress(i / pdf.numPages, `Page ${i + 1} of ${pdf.numPages}`)) throw new Error('cancelled');
    if (i) parts.push(`<hr data-page="${i + 1}">`);
    for (const b of await pageBlocks(pdf, i, body)) {
      if (b.type === 'text') {
        const tag = b.p.heading ? (b.p.size > 20 ? 'h1' : 'h2') : 'p';
        const text = b.p.bold && !b.p.heading ? `<strong>${esc(b.p.text)}</strong>` : esc(b.p.text);
        parts.push(`<${tag} dir="auto"${b.align === 'center' ? ' style="text-align:center"' : ''}>${text}</${tag}>`);
      } else if (b.type === 'table') {
        parts.push(`<table>${b.rows.map(r => `<tr>${r.map(c => `<td dir="auto">${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`);
      } else {
        parts.push(`<img alt="" style="width:${Math.round(b.ptW * 1.33)}px;max-width:100%" src="${await blobToDataUrl(b.blob)}">`);
      }
    }
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(name)}</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem}hr{border:0;border-top:1px solid #ddd;margin:2rem 0}table{border-collapse:collapse;margin:1rem 0}td{border:1px solid #ccc;padding:.25rem .5rem}img{display:block;margin:1rem 0}</style></head><body>${parts.join('\n')}</body></html>`;
  return new Blob([html], { type: 'text/html;charset=utf-8' });
}

const blobToDataUrl = (b: Blob) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result));
  r.onerror = () => rej(r.error);
  r.readAsDataURL(b);
});

const DOCX_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const RTL_TEXT = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

export async function exportDocx(pdf: PDFDocumentProxy, progress: Progress): Promise<Blob> {
  const body = await bodyTextSize(pdf);
  const xml: string[] = [];
  const media: Zippable = {};
  const rels: string[] = [];
  let pictures = 0;
  const first = await pdf.getPage(1);
  const pageW = Math.round((first.view[2] - first.view[0]) * 20), pageH = Math.round((first.view[3] - first.view[1]) * 20);
  const usable = (pageW / 20) - 72 * 1.5;

  const run = (text: string, size: number, bold: boolean, rtl: boolean) =>
    `<w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${Math.max(14, Math.round(size * 2))}"/>${rtl ? '<w:rtl/>' : ''}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;

  for (let i = 0; i < pdf.numPages; i++) {
    if (!progress(i / pdf.numPages, `Page ${i + 1} of ${pdf.numPages}`)) throw new Error('cancelled');
    if (i) xml.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    for (const b of await pageBlocks(pdf, i, body)) {
      if (b.type === 'text') {
        const rtl = RTL_TEXT.test(b.p.text);
        const jc = b.align === 'center' ? '<w:jc w:val="center"/>' : '';
        const sp = b.p.heading ? '<w:spacing w:before="200" w:after="80"/>' : '<w:spacing w:after="120"/>';
        xml.push(`<w:p><w:pPr>${rtl ? '<w:bidi/>' : ''}${sp}${jc}</w:pPr>${run(b.p.text, b.p.size, b.p.bold || b.p.heading, rtl)}</w:p>`);
      } else if (b.type === 'table') {
        const cols = Math.max(...b.rows.map(r => r.length));
        const grid = Array.from({ length: cols }, () => `<w:gridCol w:w="${Math.round((usable * 20) / cols)}"/>`).join('');
        const border = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(e => `<w:${e} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`).join('');
        const rows = b.rows.map(r => `<w:tr>${r.map(c => `<w:tc><w:tcPr><w:tcW w:w="${Math.round((usable * 20) / cols)}" w:type="dxa"/></w:tcPr><w:p>${c ? run(c, body, false, RTL_TEXT.test(c)) : ''}</w:p></w:tc>`).join('')}</w:tr>`).join('');
        xml.push(`<w:tbl><w:tblPr><w:tblBorders>${border}</w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl><w:p/>`);
      } else {
        pictures++;
        const rid = `rIdImg${pictures}`;
        media[`word/media/image${pictures}.png`] = [new Uint8Array(await b.blob.arrayBuffer()), { level: 0 }];
        rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${pictures}.png"/>`);
        const k = Math.min(1, usable / b.ptW);
        const cx = Math.round(b.ptW * k * 12700), cy = Math.round(b.ptH * k * 12700);
        xml.push(`<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${pictures}" name="Picture ${pictures}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${pictures}" name="Picture ${pictures}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`);
      }
    }
  }
  const files: Zippable = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${DOCX_NS}><w:body>${xml.join('')}<w:sectPr><w:pgSz w:w="${pageW}" w:h="${pageH}"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`),
    'word/_rels/document.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`),
    ...media,
  };
  return new Blob([zipSync(files) as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

const colName = (n: number) => { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; } return s; };

/** Finds columns by lining up where text starts across rows, then writes one sheet per page. */
export async function exportXlsx(pdf: PDFDocumentProxy, progress: Progress): Promise<Blob> {
  const sheets: string[] = [];
  for (let i = 0; i < pdf.numPages; i++) {
    if (!progress(i / pdf.numPages, `Page ${i + 1} of ${pdf.numPages}`)) throw new Error('cancelled');
    const lines = await linesOf(pdf, i);
    const starts: number[] = [];
    for (const l of lines) for (const w of l.words) {
      if (!starts.some(s => Math.abs(s - w.x) < 12)) starts.push(w.x);
    }
    starts.sort((a, b) => a - b);
    const colOf = (x: number) => {
      let best = 0, d = Infinity;
      starts.forEach((s, k) => { const q = Math.abs(s - x); if (q < d) { d = q; best = k; } });
      return best;
    };
    const rows = lines.map((l, r) => {
      const cells = new Map<number, string>();
      for (const w of l.words) {
        const c = colOf(w.x);
        cells.set(c, (cells.get(c) ?? '') + w.text);
      }
      const xml = [...cells.entries()].sort((a, b) => a[0] - b[0]).map(([c, text]) => {
        const ref = `${colName(c)}${r + 1}`;
        const n = text.trim().replace(/,/g, '');
        if (/^-?\d+(\.\d+)?$/.test(n)) return `<c r="${ref}"><v>${n}</v></c>`;
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
      }).join('');
      return `<row r="${r + 1}">${xml}</row>`;
    }).join('');
    sheets.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`);
  }
  const files: Zippable = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((_, i) => `<sheet name="Page ${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`),
  };
  sheets.forEach((xml, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(xml); });
  return new Blob([zipSync(files) as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/** Renders a finished PDF's page to a picture. Includes annotations because they are in the file. */
export async function renderSavedPage(pdf: PDFDocumentProxy, index: number, dpi: number, type: 'image/png' | 'image/jpeg', quality = 0.9): Promise<{ blob: Blob; w: number; h: number; ptW: number; ptH: number }> {
  const page = await pdf.getPage(index + 1);
  const k = dpi / 72;
  const ref = {
    id: 'x', source: 'x', index, view: [...page.view] as PageRef['view'], baseRotate: page.rotate, rotate: 0, crop: null,
    annots: [], removed: [], sized: true,
  } as PageRef;
  const vp = makeViewport(page.view, page.rotate, k);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(vp.width));
  canvas.height = Math.max(1, Math.round(vp.height));
  await renderToCanvas(page, ref, canvas, k, undefined, undefined, false).promise;
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob(x => (x ? res(x) : rej(new Error('Could not create the picture'))), type, quality));
  const out = { blob, w: canvas.width, h: canvas.height, ptW: vp.width / k, ptH: vp.height / k };
  canvas.width = 0;
  page.cleanup();
  return out;
}

export async function exportImages(pdf: PDFDocumentProxy, base: string, dpi: number, format: 'png' | 'jpg', progress: Progress): Promise<{ blob: Blob; name: string }> {
  const type = format === 'png' ? 'image/png' : 'image/jpeg';
  const n = pdf.numPages;
  if (n === 1) {
    const one = await renderSavedPage(pdf, 0, dpi, type);
    return { blob: one.blob, name: `${base}.${format}` };
  }
  const files: Zippable = {};
  const pad = String(n).length;
  for (let i = 0; i < n; i++) {
    if (!progress(i / n, `Page ${i + 1} of ${n}`)) throw new Error('cancelled');
    const r = await renderSavedPage(pdf, i, dpi, type);
    // Already compressed, so storing it uncompressed in the zip is fastest.
    files[`${base}-${String(i + 1).padStart(pad, '0')}.${format}`] = [new Uint8Array(await r.blob.arrayBuffer()), { level: 0 }];
  }
  return { blob: new Blob([zipSync(files) as BlobPart], { type: 'application/zip' }), name: `${base}-images.zip` };
}

/** Each page becomes one slide picture. It looks exact, but the text in it cannot be edited. */
export async function exportPptx(pdf: PDFDocumentProxy, progress: Progress): Promise<Blob> {
  const n = pdf.numPages;
  const first = await renderSavedPage(pdf, 0, 12, 'image/jpeg');
  const emu = (pt: number) => Math.round(pt * 12700);
  const sw = emu(first.ptW), sh = emu(first.ptH);
  const files: Zippable = {};
  const slideIds: string[] = [], rels: string[] = [], types: string[] = [];
  for (let i = 0; i < n; i++) {
    if (!progress(i / n, `Slide ${i + 1} of ${n}`)) throw new Error('cancelled');
    const r = await renderSavedPage(pdf, i, 150, 'image/jpeg', 0.88);
    const k = Math.min(sw / emu(r.ptW), sh / emu(r.ptH));
    const cx = Math.round(emu(r.ptW) * k), cy = Math.round(emu(r.ptH) * k);
    files[`ppt/media/page${i + 1}.jpg`] = [new Uint8Array(await r.blob.arrayBuffer()), { level: 0 }];
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:pic><p:nvPicPr><p:cNvPr id="2" name="Page ${i + 1}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${Math.round((sw - cx) / 2)}" y="${Math.round((sh - cy) / 2)}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree></p:cSld></p:sld>`);
    files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/page${i + 1}.jpg"/></Relationships>`);
    slideIds.push(`<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`);
    rels.push(`<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`);
    types.push(`<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
  }
  const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const emptyTree = '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>';
  const scheme = '<a:clrScheme name="PDFy"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F1F1F"/></a:dk2><a:lt2><a:srgbClr val="F2F2F2"/></a:lt2><a:accent1><a:srgbClr val="1A56DB"/></a:accent1><a:accent2><a:srgbClr val="D92D20"/></a:accent2><a:accent3><a:srgbClr val="0B8A4F"/></a:accent3><a:accent4><a:srgbClr val="B54708"/></a:accent4><a:accent5><a:srgbClr val="6938EF"/></a:accent5><a:accent6><a:srgbClr val="0E7090"/></a:accent6><a:hlink><a:srgbClr val="1A56DB"/></a:hlink><a:folHlink><a:srgbClr val="6938EF"/></a:folHlink></a:clrScheme>';
  const font = '<a:fontScheme name="PDFy"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>';
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const line = `<a:ln w="9525">${fill}</a:ln>`;
  const fmt = `<a:fmtScheme name="PDFy"><a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst><a:lnStyleLst>${line}${line}${line}</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst></a:fmtScheme>`;
  Object.assign(files, {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${types.join('')}</Types>`),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>'),
    'ppt/presentation.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds.join('')}</p:sldIdLst><p:sldSz cx="${sw}" cy="${sh}"/><p:notesSz cx="${sh}" cy="${sw}"/></p:presentation>`),
    'ppt/_rels/presentation.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${rels.join('')}</Relationships>`),
    'ppt/slideMasters/slideMaster1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster ${NS}>${emptyTree}<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`),
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>'),
    'ppt/slideLayouts/slideLayout1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout ${NS} type="blank">${emptyTree}</p:sldLayout>`),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>'),
    'ppt/theme/theme1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="PDFy"><a:themeElements>${scheme}${font}${fmt}</a:themeElements></a:theme>`),
  });
  return new Blob([zipSync(files) as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}

/** Opens a finished file just long enough for the callback to use it. */
export async function withSavedPdf<T>(blob: Blob, password: string | undefined, fn: (pdf: PDFDocumentProxy) => Promise<T>): Promise<T> {
  const opened = await openPdf(blob, async retry => (retry ? null : password ?? null));
  try { return await fn(opened.pdf); } finally { await opened.close(); }
}

export const SESSION_TYPE_HINT = (s: Session) => s.name;
