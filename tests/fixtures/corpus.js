// Runs one real-world PDF through the whole path: open, draw, edit, save, reopen, compare.
const A = window.__api;
const wait = ms => new Promise(r => setTimeout(r, ms));

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT ${what}`)), ms))]);

async function renderPage(pdf, index = 0) {
  const page = await pdf.getPage(index + 1);
  const k = Math.min(0.6, 900 / Math.max(page.view[2] - page.view[0], page.view[3] - page.view[1], 1));
  const ref = { view: [...page.view], baseRotate: page.rotate, rotate: 0, crop: null };
  const vp = page.getViewport({ scale: k });
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(vp.width));
  c.height = Math.max(1, Math.round(vp.height));
  await A.renderToCanvas(page, ref, c, k).promise;
  const data = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  c.width = 0;
  const text = (await page.getTextContent()).items.map(x => x.str ?? '').join('').replace(/\s+/g, '');
  page.cleanup();
  return { data, text, rotate: page.rotate, w: page.view[2] - page.view[0], h: page.view[3] - page.view[1] };
}

function difference(a, b) {
  if (a.data.width !== b.data.width || a.data.height !== b.data.height) return 1;
  const x = a.data.data, y = b.data.data;
  let changed = 0;
  // The small square added for the test sits in the corner, so that area is left out.
  const skipW = Math.round(a.data.width * 0.12), skipH = Math.round(a.data.height * 0.12);
  for (let row = 0; row < a.data.height; row++) {
    for (let col = 0; col < a.data.width; col++) {
      if (col < skipW && row < skipH) continue;
      const i = (row * a.data.width + col) * 4;
      if (Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]) > 60) changed++;
    }
  }
  return changed / (a.data.width * a.data.height);
}

window.__corpusOne = async function corpusOne(name) {
  const out = { name, stage: 'fetch' };
  let session = null;
  const t0 = performance.now();
  try {
    const blob = await (await fetch(`/corpus/${encodeURIComponent(name)}`)).blob();
    out.size = blob.size;
    out.stage = 'open';
    session = new A.Session(name);
    session.pages = await withTimeout(session.addSource(new File([blob], name, { type: 'application/pdf' }), name), 25000, 'open');
    out.pages = session.pages.length;
    const src = [...session.sources.values()][0];

    out.stage = 'draw';
    const before = await withTimeout(renderPage(src.pdf), 25000, 'draw');

    out.stage = 'edit and save';
    await session.pdfPage(session.pages[0]);
    const v = session.pages[0].view;
    const size = Math.min(v[2] - v[0], v[3] - v[1]) * 0.04;
    // A corner mark that does not change what else is on the page.
    const rect = before.rotate === 0 ? [v[0] + 2, v[3] - size - 2, v[0] + size + 2, v[3] - 2]
      : before.rotate === 90 ? [v[0] + 2, v[1] + 2, v[0] + size + 2, v[1] + size + 2]
      : before.rotate === 180 ? [v[2] - size - 2, v[1] + 2, v[2] - 2, v[1] + size + 2]
      : [v[2] - size - 2, v[3] - size - 2, v[2] - 2, v[3] - 2];
    session.pages[0].annots.push({ id: 'corpus', kind: 'rect', rect, color: '#ff0000', opacity: 1, width: 0.5, created: Date.now() });
    const built = await withTimeout(A.buildFile(session), 40000, 'save');
    out.saved = built.blob.size;
    out.warnings = built.warnings.length ? built.warnings.slice(0, 3) : undefined;

    out.stage = 'reopen';
    const again = await withTimeout(A.openPdf(built.blob), 25000, 'reopen');
    try {
      if (again.pdf.numPages !== out.pages) out.problem = `page count ${out.pages} became ${again.pdf.numPages}`;
      out.stage = 'compare';
      const after = await withTimeout(renderPage(again.pdf), 25000, 'draw saved');
      const diff = difference(before, after);
      out.diff = +(diff * 100).toFixed(2);
      if (window.__dumpShots && diff > 0.005) {
        const put = async (d, tag) => {
          const c = new OffscreenCanvas(d.width, d.height);
          c.getContext('2d').putImageData(d, 0, 0);
          await fetch(`/__save/diff-${encodeURIComponent(name)}-${tag}.png`, { method: 'PUT', body: await c.convertToBlob({ type: 'image/png' }) });
        };
        await put(before.data, 'before');
        await put(after.data, 'after');
      }
      out.rebuilt = built.warnings.some(w => w.includes('internal damage'));
      // Pages rebuilt as pictures are resampled, so fine lines differ a little by nature.
      if (diff > (out.rebuilt ? 0.35 : 0.02) && before.data.width > 60 && before.data.height > 60) out.problem = `${out.diff}% of the page looks different`;
      if (before.text !== after.text && !out.rebuilt) {
        const lost = before.text.length - after.text.length;
        if (Math.abs(lost) > 3) out.problem = `${out.problem ? `${out.problem}; ` : ''}text changed by ${lost} characters`;
      }
      const marks = await again.pdf.getPage(1).then(p => p.getAnnotations());
      if (!marks.some(m => m.subtype === 'Square')) out.problem = `${out.problem ? `${out.problem}; ` : ''}the added square is missing`;
    } finally {
      await again.close();
    }

    if (out.pages > 1) {
      out.stage = 'page edits';
      session.pages[0].annots = [];
      const next = session.pages.slice(1, Math.min(out.pages, 12));
      next[0].rotate = 90;
      session.pages = next;
      const second = await withTimeout(A.buildFile(session, { dropDocLevel: true }, session.pages), 40000, 'page edits');
      const check = await withTimeout(A.openPdf(second.blob), 25000, 'reopen page edits');
      if (check.pdf.numPages !== next.length) out.problem = `${out.problem ? `${out.problem}; ` : ''}page edits gave ${check.pdf.numPages} pages, expected ${next.length}`;
      await check.close();
    }
    out.stage = 'done';
    out.ok = !out.problem;
  } catch (err) {
    out.error = String(err?.message ?? err).slice(0, 220);
  } finally {
    try { await withTimeout(session?.close() ?? Promise.resolve(), 4000, 'close'); } catch { out.closeHang = true; }
  }
  out.ms = Math.round(performance.now() - t0);
  return out;
};
await wait(0);
export default true;
