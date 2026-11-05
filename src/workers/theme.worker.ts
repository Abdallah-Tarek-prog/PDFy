/// <reference lib="webworker" />
import { analyze, convertPixels, type Analysis, type Palette } from '../theme/engine';

// Pixels live only in this worker for the length of one job. The main thread holds compressed
// blobs, so converting a large screenshot never spikes interface memory.

export interface ThemeJob {
  id: number;
  blob: Blob;
  target: Palette | null; // null means analyse only
  keepPhotos: boolean;
  analysis?: Analysis;
}

export interface ThemeResult {
  id: number;
  ok: boolean;
  blob?: Blob;
  analysis?: Analysis;
  error?: string;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (e: MessageEvent<ThemeJob>) => {
  const job = e.data;
  try {
    const bitmap = await createImageBitmap(job.blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    const { width, height } = bitmap;
    bitmap.close();
    const image = ctx.getImageData(0, 0, width, height);

    if (!job.target) {
      scope.postMessage({ id: job.id, ok: true, analysis: analyze(image.data, width, height) } satisfies ThemeResult);
      return;
    }
    const analysis = convertPixels(image.data, width, height, {
      target: job.target, keepPhotos: job.keepPhotos, analysis: job.analysis,
    });
    ctx.putImageData(image, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    scope.postMessage({ id: job.id, ok: true, blob, analysis } satisfies ThemeResult);
  } catch (err) {
    scope.postMessage({ id: job.id, ok: false, error: String(err) } satisfies ThemeResult);
  }
};
