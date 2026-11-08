// Talks to the background workers. Workers start on demand and stop when idle, so the memory of
// the save and theme engines is only used while they are working.

import type { BuildJob, BuildResult, Inspection, SourceInput } from '../workers/edit.worker';
import { boxForSave, isRichBox } from '../study/box';
import type { ThemeJob, ThemeResult } from '../workers/theme.worker';
import type { Analysis, Palette } from '../theme/engine';
import type { BuildOptions, SaveAnnot, SavePage } from './model';
import { rgbaLine } from './text-raster';
import type { Annot, PageRef } from './model';
import type { Session } from './session';
import { openPdf, renderToCanvas, type PDFDocumentProxy, type PDFPageProxy } from './engine';
import { annotBounds, transformAnnot } from './geometry';
import { pageRotation, toScreen, uid, viewportFor } from './model';

const IDLE_MS = 20000;

class WorkerHost<Req extends { id: number }, Res extends { id: number; ok: boolean; error?: string }> {
  private worker: Worker | null = null;
  private timer = 0;
  private next = 1;
  private pending = new Map<number, { resolve(r: Res): void; reject(e: Error): void; progress?: (p: number) => void }>();

  constructor(private url: string, private label: string) {}

  private start(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(this.url, { type: 'module' });
    w.onmessage = (e: MessageEvent<Res & { progress?: number }>) => {
      const job = this.pending.get(e.data.id);
      if (!job) return;
      if (e.data.progress !== undefined && e.data.ok === undefined) { job.progress?.(e.data.progress); return; }
      this.pending.delete(e.data.id);
      if (e.data.ok) job.resolve(e.data);
      else job.reject(new Error(e.data.error ?? `${this.label} failed`));
      this.arm();
    };
    // If the worker dies, fail the jobs and let the next job start a new worker. The interface lives on.
    w.onerror = e => this.fail(`${this.label} stopped: ${e.message || 'out of memory or a bad file'}`);
    this.worker = w;
    return w;
  }

  private fail(message: string) {
    for (const job of this.pending.values()) job.reject(new Error(message));
    this.pending.clear();
    this.stop();
  }

  private stop() {
    this.worker?.terminate();
    this.worker = null;
  }

  private arm() {
    clearTimeout(this.timer);
    if (this.pending.size === 0) this.timer = window.setTimeout(() => this.stop(), IDLE_MS);
  }

  run(job: Omit<Req, 'id'>, progress?: (p: number) => void): Promise<Res> {
    clearTimeout(this.timer);
    const id = this.next++;
    return new Promise<Res>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress });
      try { this.start().postMessage({ ...job, id }); }
      catch (err) { this.pending.delete(id); reject(err as Error); }
    });
  }
}

const theme = new WorkerHost<ThemeJob, ThemeResult>('theme.worker.js', 'Theme engine');
const edit = new WorkerHost<BuildJob, BuildResult>('edit.worker.js', 'Save engine');

export async function analyzeImage(blob: Blob): Promise<Analysis> {
  const r = await theme.run({ blob, target: null, keepPhotos: true });
  return r.analysis!;
}

export async function convertImage(blob: Blob, target: Palette, keepPhotos: boolean, analysis?: Analysis): Promise<{ blob: Blob; analysis: Analysis }> {
  const r = await theme.run({ blob, target, keepPhotos, analysis });
  return { blob: r.blob!, analysis: r.analysis! };
}

export async function inspectFile(blob: Blob, password?: string): Promise<Inspection> {
  const r = await edit.run({ op: 'inspect', sources: [{ id: 'x', blob, password }], pages: [], options: {} });
  return r.inspection!;
}

const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

/** Windows fonts in the desktop app, and the test server's copy of them in tests. */
function fontBase(): string | undefined {
  if (window.chrome?.webview) return 'https://fonts.pdfy.local/';
  if (location.hostname === 'localhost') return `${location.origin}/sysfonts/`;
  return undefined;
}

const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const fitsStandardFont = (s: string) => {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 10 || c === 13 || c === 9) continue;
    if ((c >= 32 && c <= 126) || (c >= 160 && c <= 255)) continue;
    if (WIN_ANSI_EXTRA.includes(ch)) continue;
    return false;
  }
  return true;
};

async function toSaveAnnot(a: Annot): Promise<SaveAnnot | null> {
  if (a.ghost) return null; // Unedited existing annotations stay in the file untouched.
  if (a.kind === 'attachment' && !a.attachment?.blob) throw new Error('The pinned file could not be read. Saving was stopped to keep the original file safe.');
  const { image, ...rest } = a;
  const out: SaveAnnot = { ...rest };
  if (isRichBox(a)) {
    const box = await boxForSave(a);
    out.rect = box.rect;
    out.contents = box.contents;
    out.vectorPdf = box.vectorPdf;
    out.vectorHeight = box.vectorHeight;
    out.textImage = box.textImage;
    out.mixedDirection = !!box.textImage;
    return out;
  }
  if (image) {
    out.imageBytes = await image.blob.arrayBuffer();
    out.imageType = image.blob.type === 'image/jpeg' ? 'jpg' : 'png';
  }
  if (a.attachment?.blob) {
    out.attachmentBytes = await a.attachment.blob.arrayBuffer();
    out.attachment = { name: a.attachment.name, mime: a.attachment.mime, voice: a.attachment.voice };
  }
  // Arabic, Chinese and emoji do not fit the built-in font, so that text is saved as a sharp picture.
  const text = a.text ?? '';
  if (text && !fitsStandardFont(text) && (a.kind === 'text' || a.kind === 'callout' || a.kind === 'stamp')) {
    out.textImage = await rgbaLine(a);
    out.mixedDirection = RTL.test(text) && /[A-Za-z0-9]/.test(text);
  }
  return out;
}

export async function buildSavePages(session: Session, pages = session.pages): Promise<SavePage[]> {
  const out: SavePage[] = [];
  for (const p of pages) out.push(await toSavePage(session, p));
  return out;
}

async function toSavePage(session: Session, p: PageRef): Promise<SavePage> {
  const annots: SaveAnnot[] = [];
  for (const a of p.annots) {
    const s = await toSaveAnnot(a);
    if (s) annots.push(s);
  }
  const removed = [...p.removed];
  for (const a of p.annots) if (!a.ghost && a.importedFrom) removed.push(a.importedFrom, ...(a.importedReplies ?? []));
  return {
    source: p.source, index: p.index, view: p.view, rotate: p.rotate,
    absoluteRotate: (((p.baseRotate + p.rotate) % 360) + 360) % 360,
    crop: p.crop, annots, removed,
    hiddenText: session.ocrWords.get(p.id),
  };
}

/**
 * A file or voice note that was already in the PDF only has its bytes read when someone opens it.
 * If it was moved or changed, it is written again, so its bytes are fetched first. Without this,
 * moving a voice note and saving would lose the recording.
 */
async function loadPinnedFiles(session: Session, pages: PageRef[]) {
  for (const p of pages) {
    const src = p.source ? session.sources.get(p.source) : null;
    for (const a of p.annots) {
      const f = a.attachment;
      if (a.ghost || a.kind !== 'attachment' || f?.blob) continue;
      if (!f || !src || !f.fileId) throw new Error(`The pinned file "${f?.name ?? 'attachment'}" could not be read. Saving was stopped to keep the original file safe.`);
      try {
        const got = await src.pdf.getAttachmentContent(f.fileId) as unknown as { content?: Uint8Array } | Uint8Array | null;
        const bytes = got instanceof Uint8Array ? got : got?.content;
        if (!bytes) throw new Error('The attachment has no readable bytes.');
        f.blob = new Blob([bytes as BlobPart], { type: f.mime || (f.voice ? 'audio/webm' : 'application/octet-stream') });
      } catch (err) { throw new Error(`The pinned file "${f.name}" could not be read. Saving was stopped to keep the original file safe.`, { cause: err }); }
    }
  }
}

/** Produces the final file as a Blob and proves it opens before anyone relies on it. */
export async function buildFile(
  session: Session,
  options: BuildOptions = {},
  pages: PageRef[] = session.pages,
  progress?: (p: number) => void,
): Promise<{ blob: Blob; warnings: string[] }> {
  const usedIds = new Set(pages.map(p => p.source).filter(Boolean) as string[]);
  const sources: SourceInput[] = [];
  let keepPassword: string | undefined;
  for (const id of usedIds) {
    const src = session.sources.get(id);
    if (!src) continue;
    // Form values live in the render engine, so ask it for a copy that includes them.
    const blob = src.formsEdited ? new Blob([await src.pdf.saveDocument() as BlobPart], { type: 'application/pdf' }) : src.blob;
    sources.push({ id, blob, password: src.password, pages: src.pdf.numPages });
    if (src.password && !options.removePassword) keepPassword = src.password;
  }
  const expectPassword = options.encrypt?.userPassword ?? keepPassword;
  await loadPinnedFiles(session, pages);
  const full = withDocumentParts(session, options, pages);
  await attachmentsAndMarks(session, full, pages);

  let result: BuildResult;
  try {
    const savePages = await buildSavePages(session, pages);
    result = await edit.run({ op: 'build', sources, pages: savePages, options: full, keepPassword }, progress);
  } catch (err) {
    console.warn('Save engine could not use this file', err);
    return rebuildFromPictures(session, full, pages, keepPassword, progress);
  }
  const blob = result.blob!;

  // Prove the result opens, has the right pages, and that pages nobody touched still look the same.
  let trouble: string | null = null;
  try {
    const check = await openPdf(blob, async retry => (retry ? null : expectPassword ?? null));
    try {
      if (check.pdf.numPages !== pages.length && pages.length > 0) trouble = `Saved file has ${check.pdf.numPages} pages, expected ${pages.length}`;
      else if (!(await untouchedPagesMatch(session, options, pages, check.pdf, result.suspect ? 20 : 3))) trouble = 'A page looks different after saving';
      else await check.pdf.getPage(1);
    } finally {
      await check.close();
    }
  } catch (err) {
    trouble = String((err as Error).message);
  }
  if (trouble) {
    console.warn('Saved file failed its check:', trouble);
    return rebuildFromPictures(session, full, pages, keepPassword, progress);
  }
  const notes = [...(result.warnings ?? [])];
  for (const src of session.sources.values()) {
    if (!usedIds.has(src.id) || src.password) continue;
    const limits = await src.pdf.getPermissions().catch(() => null);
    if (limits) { notes.push('This file had usage restrictions set by its author. The saved copy does not keep them.'); break; }
  }
  return { blob, warnings: notes };
}

function withDocumentParts(session: Session, options: BuildOptions, pages: PageRef[]): BuildOptions {
  const full: BuildOptions = { ...options, fontBase: fontBase() };
  if (pages === session.pages) {
    full.bookmarks = session.bookmarks
      .map(b => ({ title: b.title, pageIndex: pages.findIndex(p => p.id === b.pageId) }))
      .filter(m => m.pageIndex >= 0);
  }
  return full;
}

async function attachmentsAndMarks(session: Session, full: BuildOptions, pages: PageRef[]) {
  if (pages === session.pages && session.attachments.length) {
    full.attachments = await Promise.all(session.attachments.map(async a => ({ name: a.name, mime: a.blob.type, bytes: await a.blob.arrayBuffer() })));
  }
}

const SAMPLE_SIZE = 420;
const SAMPLE_LIMIT_MS = 4000;

async function sampleOf(page: PDFPageProxy, ref: PageRef, k: number): Promise<{ data: Uint8ClampedArray; w: number; h: number } | null> {
  const canvas = document.createElement('canvas');
  const vp = viewportFor(ref, k);
  canvas.width = Math.max(1, Math.round(vp.width));
  canvas.height = Math.max(1, Math.round(vp.height));
  const task = renderToCanvas(page, ref, canvas, k);
  const timer = new Promise<'late'>(res => setTimeout(() => res('late'), SAMPLE_LIMIT_MS));
  const done = await Promise.race([task.promise.then(() => 'ok' as const), timer]);
  if (done === 'late') { task.cancel(); canvas.width = 0; return null; }
  const out = { data: canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data, w: canvas.width, h: canvas.height };
  canvas.width = 0;
  return out;
}

/**
 * Compares a sample of saved pages with what the viewer showed. Areas with new edits are left out,
 * since those are meant to change. Any doubt about the check itself counts as a pass.
 */
async function untouchedPagesMatch(session: Session, options: BuildOptions, pages: PageRef[], saved: PDFDocumentProxy, limit: number): Promise<boolean> {
  if (options.compress || options.flattenAnnots || options.flattenForms) return true;
  let compared = 0;
  for (let i = 0; i < pages.length && compared < limit; i++) {
    const p = pages[i];
    if (!p.source || p.removed.length || session.ocrWords.has(p.id)) continue;
    const own = p.annots.filter(a => !a.ghost);
    if (own.some(a => a.importedFrom)) continue;
    const src = session.sources.get(p.source);
    if (!src || src.formsEdited) continue;
    try {
      // This also loads the page's real size, which may differ from the first page's.
      const before = await session.pdfPage(p);
      if (!before) continue;
      const after = await saved.getPage(i + 1);
      const box = p.crop ?? p.view;
      const k = SAMPLE_SIZE / Math.max(box[2] - box[0], box[3] - box[1], 1);
      const vp = viewportFor(p, k);
      const masks = own.map(a => {
        const b = annotBounds(a);
        const q0 = toScreen(vp, b[0], b[1]), q1 = toScreen(vp, b[2], b[3]);
        return [Math.min(q0[0], q1[0]) - 3, Math.min(q0[1], q1[1]) - 3, Math.max(q0[0], q1[0]) + 3, Math.max(q0[1], q1[1]) + 3];
      });
      const refAfter = { ...p, view: [...after.view] as PageRef['view'], baseRotate: after.rotate, rotate: 0, crop: null };
      const a = await sampleOf(before, p, k), b = await sampleOf(after, refAfter, k);
      compared++;
      if (!a || !b) continue;
      if (a.w !== b.w || a.h !== b.h) return false;
      let changed = 0, counted = 0;
      for (let y = 0; y < a.h; y++) {
        for (let x = 0; x < a.w; x++) {
          if (masks.some(m => x >= m[0] && x <= m[2] && y >= m[1] && y <= m[3])) continue;
          counted++;
          const j = (y * a.w + x) * 4;
          if (Math.abs(a.data[j] - b.data[j]) + Math.abs(a.data[j + 1] - b.data[j + 1]) + Math.abs(a.data[j + 2] - b.data[j + 2]) > 60) changed++;
        }
      }
      if (counted > 200 && changed / counted > 0.015) return false;
    } catch (err) {
      console.warn('Page comparison skipped', err);
    }
  }
  return true;
}

const REBUILD_NOTE = 'This PDF has internal damage the save engine cannot safely read. Its pages were saved as sharp pictures with the text kept searchable where it could be read. Links, form fields and bookmarks from the original are not kept.';

/**
 * The fallback when a file cannot be saved normally. The viewing engine already draws it, so each page
 * is drawn to a picture with its words laid invisibly on top. It always looks right, and it stays searchable.
 */
async function rebuildFromPictures(session: Session, options: BuildOptions, pages: PageRef[], keepPassword: string | undefined, progress?: (p: number) => void): Promise<{ blob: Blob; warnings: string[] }> {
  const rebuilt: SavePage[] = [];
  for (let i = 0; i < pages.length; i++) {
    progress?.((i / pages.length) * 0.7);
    const p = pages[i];
    let pdfPage: PDFPageProxy | null = null;
    if (p.source) {
      try { pdfPage = await session.pdfPage(p); }
      catch (err) { throw new Error(`Page ${i + 1} could not be read. Saving was stopped to keep the original file safe.`, { cause: err }); }
      if (!pdfPage) throw new Error(`Page ${i + 1} could not be read. Saving was stopped to keep the original file safe.`);
    }
    if (!pdfPage) { rebuilt.push(await toSavePage(session, { ...p, source: null, index: -1, removed: [] })); continue; }
    const vp1 = viewportFor(p, 1);
    const W = vp1.width, H = vp1.height;
    const k = Math.min(200 / 72, Math.sqrt(14_000_000 / (W * H || 1)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(W * k));
    canvas.height = Math.max(1, Math.round(H * k));
    try { await renderToCanvas(pdfPage, p, canvas, k, undefined, p.source ? session.sources.get(p.source)?.ocg : undefined).promise; }
    catch (err) { canvas.width = 0; throw new Error(`Page ${i + 1} could not be drawn. Saving was stopped to keep the original file safe.`, { cause: err }); }
    const flip = (x: number, y: number) => { const q = toScreen(vp1, x, y); return [q[0], H - q[1]]; };
    const annots: SaveAnnot[] = [];
    try {
      const jpg = await new Promise<Blob>((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('Could not create the page picture'))), 'image/jpeg', 0.92));
      annots.push({ id: uid(), kind: 'image', rect: [0, 0, W, H], color: '#000000', opacity: 1, width: 0, burn: true, imageBytes: await jpg.arrayBuffer(), imageType: 'jpg' });
    } finally { canvas.width = 0; }
    for (const a of p.annots) {
      if (a.ghost) continue; // Already part of the picture.
      const s = await toSaveAnnot(transformAnnot(a, flip, pageRotation(p)));
      if (s) annots.push(s);
    }
    const hiddenText: NonNullable<SavePage['hiddenText']> = [];
    try {
      const content = await pdfPage.getTextContent();
      for (const it of content.items as { str?: string; transform?: number[]; width?: number; height?: number }[]) {
        if (!it.str?.trim() || !it.transform) continue;
        const [x, y] = flip(it.transform[4], it.transform[5]);
        hiddenText.push({ x, y, w: it.width || 1, h: Math.hypot(it.transform[2], it.transform[3]) || it.height || 10, text: it.str });
      }
    } catch { /* The page simply will not be searchable. */ }
    rebuilt.push({ source: null, index: -1, view: [0, 0, W, H], rotate: 0, absoluteRotate: 0, crop: null, annots, removed: [], hiddenText });
  }
  const options2: BuildOptions = { ...options, dropDocLevel: false };
  const result = await edit.run({ op: 'build', sources: [], pages: rebuilt, options: options2, keepPassword }, f => progress?.(0.7 + f * 0.3));
  const notes = [REBUILD_NOTE, ...(result.warnings ?? [])];
  return { blob: result.blob!, warnings: notes };
}
