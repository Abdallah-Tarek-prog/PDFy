// The same job across many files. One file at a time, so memory stays level however many there are.

import { zipSync, type Zippable } from 'fflate';
import { openPdf } from '../core/engine';
import { buildFile } from '../core/jobs';
import type { BuildOptions } from '../core/model';
import { Session } from '../core/session';
import { addHeaderFooter } from './decor';
import { exportText } from './convert';
import { baseName } from '../ui/dom';

const JOBS: Record<string, (password: string) => BuildOptions> = {
  compress: () => ({ compress: { quality: 0.72, maxSide: 1800 } }),
  flatten: () => ({ flattenAnnots: true, flattenForms: true }),
  clean: () => ({ stripMetadata: true }),
  password: pw => ({ encrypt: { userPassword: pw, ownerPassword: pw } }),
  numbers: () => ({}),
};

export async function runBatch(files: File[], job: string, password: string, progress: (i: number, name: string) => boolean): Promise<{ blob: Blob; done: number; failed: string[] }> {
  const out: Zippable = {};
  const failed: string[] = [];
  let done = 0;
  const seen = new Set<string>();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!progress(i, f.name)) throw new Error('cancelled');
    const session = new Session(f.name);
    try {
      session.pages = await session.addSource(f, f.name);
      let bytes: Uint8Array;
      let ext = 'pdf';
      if (job === 'text') {
        const opened = await openPdf(f);
        try { bytes = new Uint8Array(await (await exportText(opened.pdf, () => true)).arrayBuffer()); }
        finally { await opened.close(); }
        ext = 'txt';
      } else {
        if (job === 'numbers') addHeaderFooter(session, session.pages, { slots: { bc: '{page}' }, size: 10, color: '#333333', margin: 22, start: 1 });
        const { blob } = await buildFile(session, JOBS[job](password));
        bytes = new Uint8Array(await blob.arrayBuffer());
      }
      let name = `${baseName(f.name)}.${ext}`;
      for (let n = 2; seen.has(name); n++) name = `${baseName(f.name)} (${n}).${ext}`;
      seen.add(name);
      out[name] = [bytes, { level: 0 }];
      done++;
    } catch (err) {
      console.warn('Batch', f.name, err);
      failed.push(f.name);
    } finally {
      await session.close();
    }
  }
  return { blob: new Blob([zipSync(out) as BlobPart], { type: 'application/zip' }), done, failed };
}
