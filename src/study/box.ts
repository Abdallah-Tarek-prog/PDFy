// Markdown boxes, equations and text in any font. On screen the browser engine draws them. On save the
// same engine prints each one to a tiny PDF, which goes into the document as real vector text, so what
// you saw is what you get: any font, any language, both reading directions. If that print ever fails,
// a sharp picture is saved instead, so an edit is never lost.

import { FONT_CSS, type Annot } from '../core/model';
import { canPrintToPdf, printToPdf } from '../features/office';
import { fontCss, fontFaceCss } from './fonts';
import { markdownToHtml, renderMarkdownInto, withMarker } from './markdown';
import { texToSvg } from './math';
import { RICH_CSS, ensureRichCss, themeById, themeVars } from './mdthemes';

export const isRichBox = (a: Annot): boolean =>
  a.kind === 'math' || !!a.markdown || ((a.kind === 'text' || a.kind === 'callout') && !!a.fontName);

const esc = (t: string) => t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const hex = (c: string | undefined, fallback: string) => (/^#[0-9a-f]{3,8}$/i.test(c ?? '') ? c! : fallback);

const textStyle = (a: Annot) =>
  `font-size:${Math.min(400, Math.max(1, Number(a.fontSize) || 12))}px;color:${hex(a.textColor ?? a.color, '#111111')};font-weight:${a.bold ? 700 : 400};font-style:${a.italic ? 'italic' : 'normal'};font-family:${a.fontName ? fontCss(a.fontName) : FONT_CSS[a.font ?? 'helvetica'] ?? FONT_CSS.helvetica}`;

async function innerHtml(a: Annot): Promise<string> {
  if (a.kind === 'math') {
    const svg = a.mathSvg ?? (await texToSvg(a.latex ?? '', a.mathDisplay !== false)).svg;
    return `<div class="math-box" style="color:${hex(a.color, '#111111')}">${svg}</div>`;
  }
  if (a.markdown) {
    return `<div class="md-box" dir="auto" style="${esc(themeVars(themeById(a.mdTheme), a.fontSize))}">${await markdownToHtml(a.text ?? '')}</div>`;
  }
  return `<div class="annot-text" dir="auto" style="${esc(textStyle(a))}">${esc(a.text ?? '')}</div>`;
}

/** Which fonts a box needs, for ones the user added from a file. */
function fontsUsed(a: Annot): string[] {
  if (a.markdown) {
    const t = themeById(a.mdTheme);
    return [t.font, t.headingFont, t.monoFont];
  }
  return a.fontName ? [a.fontName] : [];
}

/** How tall a Markdown box's content is at its current width. Top edge stays where it is. */
export async function measureMarkdown(a: Annot): Promise<number> {
  ensureRichCss();
  const w = a.rect[2] - a.rect[0];
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-20000px;top:0;visibility:hidden;width:${w}px;`;
  const box = document.createElement('div');
  box.className = 'md-box';
  box.dir = 'auto';
  box.style.cssText = themeVars(themeById(a.mdTheme), a.fontSize);
  host.append(box);
  document.body.append(host);
  try {
    await renderMarkdownInto(box, a.text ?? '');
    await document.fonts?.ready;
    return Math.ceil(box.getBoundingClientRect().height) + 2;
  } finally {
    host.remove();
  }
}

/** Returns the box with a height that fits its content. */
export async function fitMarkdown(a: Annot): Promise<Annot> {
  const h = await measureMarkdown(a);
  if (a.angle) {
    // A box on a rotated page grows evenly about its centre.
    const cx = (a.rect[0] + a.rect[2]) / 2, cy = (a.rect[1] + a.rect[3]) / 2;
    const w = a.rect[2] - a.rect[0];
    return { ...a, rect: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2] };
  }
  return { ...a, rect: [a.rect[0], a.rect[3] - h, a.rect[2], a.rect[3]] };
}

// ---- Saving ----

export interface SavedBox {
  rect: Annot['rect'];
  contents: string;
  vectorPdf?: ArrayBuffer;
  vectorHeight?: number;
  textImage?: ArrayBuffer;
}

const MIN_PAGE = 110; // Points. Print engines dislike very small pages.
const SLACK = 40;     // Spare room below the box, so a line that wraps differently is not cut off.

const memo = new Map<string, { pdf?: ArrayBuffer; pageH?: number; png?: ArrayBuffer }>();
const MEMO_LIMIT = 48;

function contentsFor(a: Annot, rect: Annot['rect']): string {
  // The box as drawn, before any page turning, so it reopens the same way up.
  const place = { r: rect.map(n => Math.round(n * 100) / 100), ang: a.angle ?? 0 };
  if (a.kind === 'math') return withMarker(`$$${a.latex ?? ''}$$`, { math: 1, display: a.mathDisplay !== false ? 1 : 0, size: a.fontSize ?? 16, ...place });
  if (a.markdown) {
    const theme = themeById(a.mdTheme);
    // Your own theme travels with the file, so the note looks the same on another computer.
    return withMarker(a.text ?? '', { md: 1, theme: theme.id, size: a.fontSize ?? 12, ...place, ...(theme.builtIn ? {} : { td: theme }) });
  }
  return withMarker(a.text ?? '', { font: a.fontName ?? '', b: a.bold ? 1 : 0, i: a.italic ? 1 : 0, ...place });
}

export async function boxForSave(a: Annot): Promise<SavedBox> {
  let rect = a.rect;
  if (a.markdown) rect = (await fitMarkdown(a)).rect;
  const w = rect[2] - rect[0], ht = rect[3] - rect[1];
  const contents = contentsFor(a, rect);
  const inner = await innerHtml(a);
  const key = `${w.toFixed(2)}|${ht.toFixed(2)}|${inner}`;
  let done = memo.get(key);
  if (!done) {
    done = {};
    if (canPrintToPdf()) {
      try {
        const pageW = Math.max(w + 2, MIN_PAGE), pageH = Math.max(ht + SLACK, MIN_PAGE);
        const faces = await fontFaceCss(fontsUsed(a));
        const html = `<!doctype html><html><head><meta charset="utf-8"><style>@page{margin:0}html,body{margin:0;padding:0;background:transparent}.page-wrap{zoom:1.333333;width:${w}px;height:${ht}px}${RICH_CSS}${faces}</style></head><body><div class="page-wrap">${inner}</div></body></html>`;
        const blob = await printToPdf({ html, widthIn: pageW / 72, heightIn: pageH / 72, marginIn: 0 });
        done.pdf = await blob.arrayBuffer();
        done.pageH = pageH;
      } catch (err) {
        console.warn('Printing a box failed, so it is saved as a picture', err);
      }
    }
    if (!done.pdf) done.png = await boxToPicture(inner, w, ht, fontsUsed(a));
    if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value as string);
    memo.set(key, done);
  }
  return { rect, contents, vectorPdf: done.pdf, vectorHeight: done.pageH, textImage: done.png };
}

/** The fallback: a sharp picture of the box, drawn by the same engine. */
export async function boxToPicture(inner: string, w: number, ht: number, fonts: string[] = []): Promise<ArrayBuffer> {
  const SCALE = 3;
  const faces = await fontFaceCss(fonts);
  const holder = document.createElement('div');
  holder.innerHTML = inner;
  const body = new XMLSerializer().serializeToString(holder);
  const style = esc(`${RICH_CSS}${faces}`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${ht}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${ht}px"><style>${style}</style>${body}</div></foreignObject></svg>`;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error('The box could not be drawn.'));
    img.src = url;
  });
  const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(w * SCALE)), Math.max(1, Math.ceil(ht * SCALE)));
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
}
