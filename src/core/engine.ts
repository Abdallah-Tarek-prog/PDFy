// Wraps pdf.js for loading and rendering. Three memory rules live here:
//  - Files are read in pieces on demand, never fully into memory.
//  - Each open document gets its own engine worker, and closing it returns all of that memory.
//  - One render at a time, and anything that scrolled away is cancelled.

import {
  getDocument, GlobalWorkerOptions, PDFDataRangeTransport, AnnotationMode, PasswordResponses, RenderingCancelledException,
  type PDFDocumentProxy, type PDFPageProxy,
} from 'pdfjs-dist';
import { makeViewport, type PageRef } from './model';

GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.mjs';

const BASE_OPTIONS = {
  cMapUrl: 'vendor/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: 'vendor/standard_fonts/',
  wasmUrl: 'vendor/wasm/',
  iccUrl: 'vendor/iccs/',
  isEvalSupported: false,
  // Fetch only what the visible pages need.
  disableAutoFetch: true,
  disableStream: true,
  rangeChunkSize: 256 * 1024,
  maxImageSize: 64 * 1024 * 1024,
};

class BlobTransport extends PDFDataRangeTransport {
  constructor(private blob: Blob) {
    super(blob.size, null as unknown as Uint8Array);
  }
  override requestDataRange(begin: number, end: number) {
    this.blob.slice(begin, end).arrayBuffer().then(
      buf => this.onDataRange(begin, new Uint8Array(buf)),
      () => this.onDataRange(begin, new Uint8Array(end - begin)),
    );
  }
}

export interface OpenedPdf {
  pdf: PDFDocumentProxy;
  password?: string;
  close(): Promise<void>;
}

export class PdfOpenError extends Error {
  constructor(message: string, readonly kind: 'empty' | 'invalid' | 'password-cancelled' | 'other') { super(message); }
}

export type AskPassword = (retry: boolean) => Promise<string | null>;

/** Opens a PDF. Every failure becomes a clear message instead of a crash. */
export async function openPdf(blob: Blob, askPassword?: AskPassword): Promise<OpenedPdf> {
  if (blob.size === 0) throw new PdfOpenError('This file is empty.', 'empty');
  const task = getDocument({ ...BASE_OPTIONS, range: new BlobTransport(blob) } as Parameters<typeof getDocument>[0]);
  let password: string | undefined;
  let cancelled = false;
  task.onPassword = async (update: (pw: string) => void, reason: number) => {
    const pw = askPassword ? await askPassword(reason === PasswordResponses.INCORRECT_PASSWORD) : null;
    if (pw == null) { cancelled = true; void task.destroy(); return; }
    password = pw;
    update(pw);
  };
  try {
    const pdf = await task.promise;
    return { pdf, password, close: () => shutDown(task) };
  } catch (err) {
    void task.destroy();
    if (cancelled) throw new PdfOpenError('Opening was cancelled.', 'password-cancelled');
    const name = (err as Error)?.name ?? '';
    if (name === 'InvalidPDFException') throw new PdfOpenError('This file is damaged or is not a PDF.', 'invalid');
    throw new PdfOpenError(`This file could not be opened: ${(err as Error)?.message ?? err}`, 'other');
  }
}

/**
 * Closes a document. The engine's own shutdown can wait forever on data it will never receive,
 * so it gets a moment, and then its worker is stopped outright. Either way the memory comes back.
 */
async function shutDown(task: ReturnType<typeof getDocument>): Promise<void> {
  const worker = (task as unknown as { _worker?: { destroy(): void } })._worker;
  let timer = 0;
  await Promise.race([
    task.destroy().catch(() => {}),
    new Promise<void>(res => { timer = window.setTimeout(res, 2000); }),
  ]);
  clearTimeout(timer);
  try { worker?.destroy(); } catch { /* Already gone. */ }
}

export const isCancelled = (err: unknown): boolean =>
  err instanceof RenderingCancelledException || (err as Error)?.name === 'RenderingCancelledException';

function multiply(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function invert(m: number[]): number[] {
  const d = m[0] * m[3] - m[1] * m[2];
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[4] * m[3]) / d, (m[4] * m[1] - m[5] * m[0]) / d];
}

export interface RenderHandle { promise: Promise<void>; cancel(): void }

/** Draws a page (or part of it) to a canvas. Handles crop, rotation and blank pages. */
export function renderToCanvas(
  pdfPage: PDFPageProxy | null,
  ref: PageRef,
  canvas: HTMLCanvasElement,
  pixelScale: number,
  offset: { x: number; y: number } = { x: 0, y: 0 },
  ocg?: Promise<unknown>,
  storage = true,
): RenderHandle {
  if (!pdfPage) {
    const ctx = canvas.getContext('2d', { alpha: false })!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return { promise: Promise.resolve(), cancel() {} };
  }
  const rotation = (((ref.baseRotate + ref.rotate) % 360) + 360) % 360;
  const box = ref.crop ?? ref.view;
  const target = makeViewport(box, rotation, pixelScale).m as unknown as number[];
  const engineVp = pdfPage.getViewport({ scale: 1, rotation });
  const shifted = multiply([1, 0, 0, 1, -offset.x, -offset.y], target);
  const transform = multiply(shifted, invert(engineVp.transform as number[]));
  const task = pdfPage.render({
    canvas,
    viewport: engineVp,
    transform: transform as [number, number, number, number, number, number],
    annotationMode: storage ? AnnotationMode.ENABLE_STORAGE : AnnotationMode.ENABLE,
    optionalContentConfigPromise: ocg as never,
  });
  return { promise: task.promise, cancel: () => task.cancel() };
}

export { AnnotationMode };
export type { PDFDocumentProxy, PDFPageProxy };
