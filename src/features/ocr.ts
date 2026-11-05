// Text recognition for scanned pages. The engine weighs about 100 MB of memory while running, so
// it starts only when asked and is shut down right after.

import { renderToCanvas } from '../core/engine';
import { toPdf, viewportFor, type PageRef } from '../core/model';
import type { Session } from '../core/session';
import { sourceOcg } from './images';

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function runOcr(session: Session, pages: PageRef[], lang: string, progress: (f: number, t: string) => boolean): Promise<{ pages: number; words: number }> {
  progress(0, 'Loading the text recognition engine…');
  const url = new URL('vendor/ocr/tesseract.esm.min.js', document.baseURI).href;
  const mod: any = await import(/* @vite-ignore */ url);
  const base = new URL('vendor/ocr/', document.baseURI).href;
  const worker = await (mod.default ?? mod).createWorker(lang, 1, {
    workerPath: `${base}worker.min.js`,
    corePath: `${base}tesseract-core-simd-lstm.wasm.js`,
    langPath: base,
    gzip: true,
    cacheMethod: 'none',
    logger: () => {},
  });
  let done = 0, words = 0;
  try {
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      if (!progress(i / pages.length, `Reading page ${i + 1} of ${pages.length}`)) break;
      const k = 200 / 72;
      const vp = viewportFor(page, k);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      await renderToCanvas(await session.pdfPage(page), page, canvas, k, undefined, sourceOcg(session, page)).promise;
      const { data } = await worker.recognize(canvas, {}, { blocks: true });
      canvas.width = 0;
      const out: { x: number; y: number; w: number; h: number; text: string }[] = [];
      for (const block of data.blocks ?? []) for (const para of block.paragraphs ?? []) for (const line of para.lines ?? []) for (const w of line.words ?? []) {
        if (!w.text?.trim() || (w.confidence ?? 100) < 30) continue;
        const a = toPdf(vp, w.bbox.x0, w.bbox.y1), b = toPdf(vp, w.bbox.x1, w.bbox.y0);
        out.push({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]), text: w.text });
      }
      session.ocrWords.set(page.id, out);
      words += out.length;
      done++;
    }
  } finally {
    await worker.terminate();
  }
  if (done) session.markDirty();
  return { pages: done, words };
}
