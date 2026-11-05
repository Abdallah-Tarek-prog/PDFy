// Pasted and inserted images, and everything to do with changing their theme.

import { renderToCanvas } from '../core/engine';
import { annotBounds, transformAnnot } from '../core/geometry';
import { analyzeImage, convertImage } from '../core/jobs';
import { pageRotation, placeBox, toScreen, uid, viewportFor, type Annot, type ImageAsset, type PageRef, type ThemeMode } from '../core/model';
import type { Session } from '../core/session';
import { hexToRgb, paletteForBackground, rgbToHex, type Palette, type Rgb } from '../theme/engine';
import { styleById } from '../theme/presets';

const MAX_SIDE = 6000; // Larger pictures are scaled down, because no page shows that much detail.
const MARGIN = 36;

/** Turns any browser-readable image into a stored PNG or JPEG. */
export async function assetFromBlob(blob: Blob, style = 'neutral'): Promise<ImageAsset> {
  const bitmap = await createImageBitmap(blob);
  let { width, height } = bitmap;
  const k = Math.min(1, MAX_SIDE / Math.max(width, height));
  let stored = blob;
  try {
    if (k < 1 || (blob.type !== 'image/png' && blob.type !== 'image/jpeg')) {
      width = Math.round(width * k);
      height = Math.round(height * k);
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
      stored = await canvas.convertToBlob({ type: 'image/png' });
    }
  } finally {
    bitmap.close();
  }
  return { blob: stored, original: stored, width, height, theme: 'original', style, keepPhotos: true };
}

/** Screenshots are 96 pixels per inch, so 1 pixel is 0.75 points. */
const PIXEL_TO_POINT = 0.75;

export function fitSize(asset: ImageAsset, maxW: number, maxH: number): { w: number; h: number } {
  const k = Math.min(1, maxW / (asset.width * PIXEL_TO_POINT), maxH / (asset.height * PIXEL_TO_POINT));
  return { w: asset.width * PIXEL_TO_POINT * k, h: asset.height * PIXEL_TO_POINT * k };
}

export function makeImageAnnot(page: PageRef, asset: ImageAsset, sx: number, sy: number, w: number, h: number, author?: string): Annot {
  const box = placeBox(page, sx, sy, sx + w, sy + h);
  return {
    id: uid(), kind: 'image', rect: box.rect, angle: box.angle, color: '#000000', opacity: 1, width: 0,
    image: asset, author, created: Date.now(),
  };
}

/**
 * Chooses where a pasted image goes. Each paste lands under the last one, flowing to the next page
 * when it does not fit, so a stack of screenshots builds a tidy document with no dragging.
 */
export function pastePlacement(session: Session, pageIndex: number, asset: ImageAsset, allowNewPage: boolean): { page: PageRef; x: number; y: number; w: number; h: number; added: boolean } {
  let index = Math.min(pageIndex, session.pages.length - 1);
  const flowBottom = (p: PageRef) => {
    const vp = viewportFor(p, 1);
    let bottom = 0;
    for (const a of p.annots) {
      if (a.kind !== 'image' || a.ghost) continue;
      const b = annotBounds(a);
      for (const [x, y] of [[b[0], b[1]], [b[2], b[3]], [b[0], b[3]], [b[2], b[1]]]) bottom = Math.max(bottom, toScreen(vp, x, y)[1]);
    }
    return bottom;
  };
  for (let guard = 0; guard < 5000; guard++) {
    const page = session.pages[index];
    const vp = viewportFor(page, 1);
    const maxW = vp.width - MARGIN * 2, maxH = vp.height - MARGIN * 2;
    const size = fitSize(asset, maxW, maxH);
    const bottom = flowBottom(page);
    const blankStart = page.source === null && bottom === 0;
    const y = bottom > 0 ? bottom + 12 : blankStart ? MARGIN : Math.max(MARGIN, (vp.height - size.h) / 2);
    if (y + size.h <= vp.height - MARGIN / 2) return { page, x: (vp.width - size.w) / 2, y, ...size, added: false };
    if (index + 1 < session.pages.length) { index++; continue; }
    if (allowNewPage) {
      const fresh = session.blankPage(vp.width, vp.height);
      return { page: fresh, x: (vp.width - size.w) / 2, y: MARGIN, ...fitSize(asset, maxW, maxH), added: true };
    }
    return { page, x: (vp.width - size.w) / 2, y: Math.max(MARGIN, (vp.height - size.h) / 2), ...size, added: false };
  }
  throw new Error('No page to place the image on');
}

/** Draws part of a page to a picture. Used by theme snip, page conversion and stamp capture. */
export async function renderRegion(session: Session, page: PageRef, rect: number[], maxScale = 3, maxPixels = 14_000_000): Promise<{ blob: Blob; w: number; h: number; sx0: number; sy0: number; sx1: number; sy1: number }> {
  const vp1 = viewportFor(page, 1);
  const a = toScreen(vp1, rect[0], rect[1]), b = toScreen(vp1, rect[2], rect[3]);
  const sx0 = Math.max(0, Math.min(a[0], b[0])), sx1 = Math.min(vp1.width, Math.max(a[0], b[0]));
  const sy0 = Math.max(0, Math.min(a[1], b[1])), sy1 = Math.min(vp1.height, Math.max(a[1], b[1]));
  const cssW = sx1 - sx0, cssH = sy1 - sy0;
  const k = Math.min(maxScale, Math.sqrt(maxPixels / (cssW * cssH || 1)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(cssW * k));
  canvas.height = Math.max(1, Math.round(cssH * k));
  const pdfPage = await session.pdfPage(page);
  await renderToCanvas(pdfPage, page, canvas, k, { x: sx0 * k, y: sy0 * k }, sourceOcg(session, page)).promise;
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob(x => (x ? res(x) : rej(new Error('Could not create the picture'))), 'image/png'));
  const out = { blob, w: canvas.width, h: canvas.height, sx0, sy0, sx1, sy1 };
  canvas.width = 0;
  return out;
}

export const sourceOcg = (session: Session, page: PageRef) => (page.source ? session.sources.get(page.source)?.ocg : undefined);

/** Finds the page colour around a box, so "match page" blends in. */
export async function samplePageColour(session: Session, page: PageRef, rect: number[]): Promise<Rgb> {
  if (!page.source) return [255, 255, 255];
  const canvas = document.createElement('canvas');
  const k = 0.25;
  const vp = viewportFor(page, k);
  canvas.width = Math.max(1, Math.ceil(vp.width));
  canvas.height = Math.max(1, Math.ceil(vp.height));
  try {
    await renderToCanvas(await session.pdfPage(page), page, canvas, k).promise;
    const ctx = canvas.getContext('2d')!;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const a = toScreen(vp, rect[0], rect[1]), b = toScreen(vp, rect[2], rect[3]);
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    const counts = new Map<number, number>();
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue; // Skip the area the image covers.
        const i = (y * canvas.width + x) * 4;
        const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    let best = 0xffffff, top = 0;
    for (const [c, n] of counts) if (n > top) { top = n; best = c; }
    return [best >> 16, (best >> 8) & 255, best & 255];
  } finally {
    canvas.width = 0;
  }
}

export async function ensureAnalysis(asset: ImageAsset): Promise<ImageAsset> {
  if (asset.analysis) return asset;
  asset.analysis = await analyzeImage(asset.original);
  return asset;
}

export interface ThemeChoice { mode: ThemeMode; style: string; keepPhotos: boolean }

async function targetPalette(session: Session, page: PageRef, a: Annot, choice: ThemeChoice): Promise<Palette> {
  const style = styleById(choice.style);
  if (choice.mode === 'light') return style.light;
  if (choice.mode === 'dark') return style.dark;
  const bg = await samplePageColour(session, page, annotBounds(a));
  const dark = hexToRgb(rgbToHex(bg)).reduce((x, y) => x + y, 0) / 3 < 128;
  return paletteForBackground(bg, dark ? style.dark : style.light);
}

/** Always converts from the original, so switching back and forth never loses quality. */
export async function applyTheme(session: Session, page: PageRef, a: Annot, choice: ThemeChoice): Promise<void> {
  const image = a.image;
  if (!image) return;
  const { ghost: _g, ...rest } = a;
  if (choice.mode === 'original') {
    session.replaceAnnot(page, a, { ...rest, image: { ...image, blob: image.original, theme: 'original', style: choice.style, keepPhotos: choice.keepPhotos } }, 'Restore original image');
    return;
  }
  const palette = await targetPalette(session, page, a, choice);
  const { blob, analysis } = await convertImage(image.original, palette, choice.keepPhotos, image.analysis);
  const current = page.annots.find(x => x.id === a.id) ?? a;
  session.replaceAnnot(page, current, { ...rest, image: { ...image, blob, analysis, theme: choice.mode, style: choice.style, keepPhotos: choice.keepPhotos } }, 'Change image theme');
}

/** Lifts an area of the page into an image and converts it to the opposite theme. */
export async function snipRegion(session: Session, page: PageRef, rect: Annot['rect'], style: string, author?: string): Promise<Annot> {
  const shot = await renderRegion(session, page, rect);
  const asset = await assetFromBlob(shot.blob, style);
  await ensureAnalysis(asset);
  const annot = makeImageAnnot(page, asset, shot.sx0, shot.sy0, shot.sx1 - shot.sx0, shot.sy1 - shot.sy0, author);
  const palette = asset.analysis!.isDark ? styleById(style).light : styleById(style).dark;
  const { blob, analysis } = await convertImage(asset.original, palette, true, asset.analysis);
  annot.image = { ...asset, blob, analysis, theme: asset.analysis!.isDark ? 'light' : 'dark' };
  session.addAnnots(page, [annot], 'Theme snip');
  return annot;
}

/** Converts whole pages, laying a picture over each. The text underneath stays searchable. */
export async function convertPages(session: Session, pages: PageRef[], mode: 'light' | 'dark', style: string, progress: (done: number) => boolean): Promise<number> {
  const palette = mode === 'light' ? styleById(style).light : styleById(style).dark;
  const made: { page: PageRef; annot: Annot }[] = [];
  for (let i = 0; i < pages.length; i++) {
    if (!progress(i)) break;
    const page = pages[i];
    const box = page.crop ?? page.view;
    const shot = await renderRegion(session, page, box, 2);
    const asset = await assetFromBlob(shot.blob, style);
    const { blob, analysis } = await convertImage(asset.original, palette, true);
    const annot = makeImageAnnot(page, { ...asset, blob, analysis, theme: mode }, shot.sx0, shot.sy0, shot.sx1 - shot.sx0, shot.sy1 - shot.sy0);
    annot.contents = `Converted page (${mode})`;
    made.push({ page, annot });
  }
  const apply = () => {
    for (const m of made) m.page.annots.push(m.annot);
    session.emit({ kind: 'annots', pageIds: made.map(m => m.page.id) });
  };
  const undo = () => {
    for (const m of made) m.page.annots = m.page.annots.filter(a => a.id !== m.annot.id);
    session.emit({ kind: 'annots', pageIds: made.map(m => m.page.id) });
  };
  apply();
  session.record({ label: 'Convert page theme', undo, redo: apply });
  return made.length;
}

/**
 * True redaction: the page becomes a picture with the boxes painted in, and the original page is
 * dropped from the saved file. Nothing under the boxes can be recovered, but the page's other text
 * is no longer selectable either until OCR is run.
 */
export async function applyRedactions(session: Session, pages: PageRef[]): Promise<number> {
  const changes: { index: number; before: PageRef; after: PageRef }[] = [];
  for (const page of pages) {
    const marks = page.annots.filter(a => a.kind === 'redact');
    if (!marks.length) continue;
    const vp1 = viewportFor(page, 1);
    const k = 200 / 72;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp1.width * k);
    canvas.height = Math.round(vp1.height * k);
    await renderToCanvas(await session.pdfPage(page), page, canvas, k, undefined, sourceOcg(session, page)).promise;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000';
    const vpk = viewportFor(page, k);
    for (const m of marks) {
      const a = toScreen(vpk, m.rect[0], m.rect[1]), b = toScreen(vpk, m.rect[2], m.rect[3]);
      ctx.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
    }
    const blob = await new Promise<Blob>((res, rej) => canvas.toBlob(x => (x ? res(x) : rej(new Error('Could not create the page image'))), 'image/jpeg', 0.92));
    canvas.width = 0;

    const after = session.blankPage(vp1.width, vp1.height);
    const asset: ImageAsset = { blob, original: blob, width: Math.round(vp1.width * k), height: Math.round(vp1.height * k), theme: 'original', style: 'neutral', keepPhotos: true };
    const img = makeImageAnnot(after, asset, 0, 0, vp1.width, vp1.height);
    img.burn = true;
    after.annots = [img];
    // Keep the other edits in place. Their coordinates follow the new, unrotated page.
    const map = (x: number, y: number) => { const p = toScreen(vp1, x, y); return [p[0], vp1.height - p[1]]; };
    for (const a of page.annots) {
      if (a.kind === 'redact' || a.ghost) continue;
      after.annots.push(transformAnnot(a, map, pageRotation(page)));
    }
    changes.push({ index: session.pages.indexOf(page), before: page, after });
  }
  if (!changes.length) return 0;
  const next = [...session.pages];
  for (const c of changes) next[c.index] = c.after;
  session.setPages(next, 'Apply redactions');
  return changes.length;
}

/** Crops an image and its original alike, so theme switching still works afterwards. */
export async function cropImageAnnot(session: Session, page: PageRef, a: Annot, sel: { x0: number; y0: number; x1: number; y1: number }, bounds: { x0: number; y0: number; x1: number; y1: number }, scale: number): Promise<void> {
  const image = a.image;
  if (!image) return;
  const w = bounds.x1 - bounds.x0, ht = bounds.y1 - bounds.y0;
  const fx0 = Math.max(0, (sel.x0 - bounds.x0) / w), fx1 = Math.min(1, (sel.x1 - bounds.x0) / w);
  const fy0 = Math.max(0, (sel.y0 - bounds.y0) / ht), fy1 = Math.min(1, (sel.y1 - bounds.y0) / ht);
  if (fx1 - fx0 < 0.01 || fy1 - fy0 < 0.01) return;
  const cut = async (blob: Blob): Promise<Blob> => {
    const bmp = await createImageBitmap(blob);
    const sw = Math.max(1, Math.round((fx1 - fx0) * bmp.width)), sh = Math.max(1, Math.round((fy1 - fy0) * bmp.height));
    const out = new OffscreenCanvas(sw, sh);
    out.getContext('2d')!.drawImage(bmp, -Math.round(fx0 * bmp.width), -Math.round(fy0 * bmp.height));
    bmp.close();
    return out.convertToBlob({ type: 'image/png' });
  };
  const original = await cut(image.original);
  const blob = image.blob === image.original ? original : await cut(image.blob);
  const nw = Math.round((fx1 - fx0) * image.width), nh = Math.round((fy1 - fy0) * image.height);
  // The new box in page terms, found through the same on-screen coordinates the user dragged in.
  const box = placeBox(page, Math.max(sel.x0, bounds.x0) / scale, Math.max(sel.y0, bounds.y0) / scale, Math.min(sel.x1, bounds.x1) / scale, Math.min(sel.y1, bounds.y1) / scale);
  const { ghost: _g, ...rest } = a;
  session.replaceAnnot(page, a, {
    ...rest, rect: box.rect, angle: a.angle ?? box.angle,
    image: { ...image, blob, original, width: nw, height: nh, analysis: undefined },
  }, 'Crop image');
}

/** Converts every pasted or inserted image in the document as one undo step. */
export async function convertAllImages(session: Session, choice: ThemeChoice, progress: (i: number, n: number) => boolean): Promise<number> {
  const list: { page: PageRef; a: Annot }[] = [];
  for (const page of session.pages) for (const a of page.annots) if (a.kind === 'image' && a.image && !a.burn) list.push({ page, a });
  const changes: { page: PageRef; before: Annot; after: Annot }[] = [];
  for (let i = 0; i < list.length; i++) {
    if (!progress(i, list.length)) break;
    const { page, a } = list[i];
    const image = a.image!;
    const { ghost: _g, ...rest } = a;
    if (choice.mode === 'original') {
      changes.push({ page, before: a, after: { ...rest, image: { ...image, blob: image.original, theme: 'original' } } });
      continue;
    }
    const palette = await targetPalette(session, page, a, choice);
    const { blob, analysis } = await convertImage(image.original, palette, choice.keepPhotos, image.analysis);
    changes.push({ page, before: a, after: { ...rest, image: { ...image, blob, analysis, theme: choice.mode, style: choice.style, keepPhotos: choice.keepPhotos } } });
  }
  const swap = (from: 'before' | 'after', to: 'before' | 'after') => {
    for (const c of changes) {
      const at = c.page.annots.findIndex(x => x.id === c[from].id);
      if (at >= 0) c.page.annots[at] = c[to];
    }
    session.emit({ kind: 'annots', pageIds: [...new Set(changes.map(c => c.page.id))] });
  };
  if (changes.length) {
    swap('before', 'after');
    session.record({ label: 'Convert all images', undo: () => swap('after', 'before'), redo: () => swap('before', 'after') });
  }
  return changes.length;
}

export function rotateImageAnnot(session: Session, page: PageRef, a: Annot) {
  const { ghost: _g, ...rest } = a;
  session.replaceAnnot(page, a, { ...rest, angle: ((a.angle ?? 0) - 90 + 360) % 360 }, 'Rotate image');
}
