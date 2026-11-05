// Printing renders what will be saved, including edits, in a hidden frame.

import type { PDFDocumentProxy } from '../core/engine';
import { renderSavedPage } from './convert';

export async function printPdf(pdf: PDFDocumentProxy, progress: (f: number, t: string) => boolean): Promise<void> {
  const urls: string[] = [];
  const parts: string[] = [];
  let first: { w: number; h: number } | null = null;
  try {
    for (let i = 0; i < pdf.numPages; i++) {
      if (!progress(i / pdf.numPages, `Preparing page ${i + 1} of ${pdf.numPages}`)) return;
      const r = await renderSavedPage(pdf, i, 170, 'image/jpeg', 0.92);
      first ??= { w: r.ptW, h: r.ptH };
      const url = URL.createObjectURL(r.blob);
      urls.push(url);
      parts.push(`<div class="p"><img src="${url}"></div>`);
    }
    if (!first) return;
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;left:-9999px';
    document.body.append(frame);
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(`<!doctype html><html><head><style>@page{size:${first.w}pt ${first.h}pt;margin:0}html,body{margin:0}.p{page-break-after:always;width:100vw;height:100vh;display:flex;align-items:center;justify-content:center}.p:last-child{page-break-after:auto}img{max-width:100%;max-height:100%}</style></head><body>${parts.join('')}</body></html>`);
    doc.close();
    await Promise.all([...doc.images].map(img => img.decode().catch(() => {})));
    frame.contentWindow!.focus();
    frame.contentWindow!.print();
    setTimeout(() => { frame.remove(); urls.forEach(u => URL.revokeObjectURL(u)); }, 60000);
  } catch (err) {
    urls.forEach(u => URL.revokeObjectURL(u));
    throw err;
  }
}
