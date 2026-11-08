// Verify highlighters against real PDF pixels, including saved and reopened annotations.
const app = window.__pdfy, A = window.__api, results = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
const ok = (v, message) => { if (!v) throw new Error(message); };
const until = async fn => { for (let i = 0; i < 150; i++) { const v = fn(); if (v) return v; await wait(40); } throw new Error('Timed out'); };
async function test(name, run) {
  console.log('TEST', name);
  try { await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: String(error.message ?? error) }); }
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, results }) });
}
function documentBlob(markerIntent) {
  const ops = [
    '0 0 0 rg BT /F1 20 Tf 30 420 Td (BLACK TEXT) Tj ET 300 418 40 20 re f',
    '0 0 .8 rg BT /F1 20 Tf 30 380 Td (BLUE TEXT) Tj ET 300 378 40 20 re f',
    '.8 0 0 rg BT /F1 20 Tf 30 340 Td (RED TEXT) Tj ET 300 338 40 20 re f',
    '0 0 0 rg BT /F1 20 Tf 30 300 Td (HIGHLIGHT) Tj ET 300 298 40 20 re f',
    '0 0 0 rg BT /F1 20 Tf 30 180 Td (PEN CONTROL) Tj ET 300 178 40 20 re f',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  if (markerIntent) {
    objects[2] = objects[2].replace('/Contents 4 0 R', '/Contents 4 0 R /Annots [6 0 R]');
    objects.push(`<< /Type /Annot /Subtype /Ink /IT /${markerIntent} /Rect [20 416 350 444] /InkList [[20 430 350 430]] /C [1 .83 0] /CA .55 /BS << /W 28 >> >>`);
  }
  let body = '%PDF-1.7\n'; const offsets = [0];
  objects.forEach((o, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([body], { type: 'application/pdf' });
}
async function closeAll() {
  app.tools.cancel();
  for (const s of [...app.sessions]) { s.dirty = false; await app.closeSession(s); }
}
let session, page, view;
async function open(blob = documentBlob()) {
  await closeAll();
  await app.openFile(new File([blob], 'Marker colours.pdf', { type: 'application/pdf' }));
  session = app.session; page = session.pages[0];
  app.setMode('edit'); app.viewer.setScale(1); app.viewer.scroller.scrollTop = 0;
  view = await until(() => app.viewer.views.get(page.id));
  await until(() => view.canvas && !view.task && !view.needsRender);
  await wait(100);
}
function screen(x, y) {
  const r = view.el.getBoundingClientRect(), m = view.vp.m;
  return [r.left + m[0] * x + m[2] * y + m[4], r.top + m[1] * x + m[3] * y + m[5]];
}
const mouse = (type, x, y) => window.__cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
async function stroke(y, preview = false) {
  const [x0, sy] = screen(20, y), [x1] = screen(350, y);
  await mouse('mousePressed', x0, sy);
  for (let i = 1; i <= 6; i++) await mouse('mouseMoved', x0 + (x1 - x0) * i / 6, sy);
  await wait(80);
  if (preview) {
    ok(view.annotsG.querySelector('path.highlighter'), 'the live marker is missing its blend effect');
    await window.__shot('marker-live-preview');
  }
  await mouse('mouseReleased', x1, sy); await wait(100);
}
async function canvasFor(pdf) {
  const p = await pdf.getPage(1), viewport = p.getViewport({ scale: 1 });
  const c = document.createElement('canvas'); c.width = viewport.width; c.height = viewport.height;
  await p.render({ canvas: c, viewport }).promise;
  return c;
}
function pixel(c, x, y) { return [...c.getContext('2d').getImageData(x, c.height - y, 1, 1).data].slice(0, 3); }
function blendedPixels(c, ratio = 1) {
  const at = (x, y) => pixel(c, Math.floor(x * ratio), Math.ceil(y * ratio));
  const black = at(310, 425), blue = at(310, 385), red = at(310, 345), highlight = at(310, 305), white = at(260, 425);
  ok(black.every(v => v < 5), `marker washed out black text: ${black}`);
  ok(blue[0] < 5 && blue[1] < 5 && blue[2] > 60 && blue[2] < 180, `marker washed out blue text: ${blue}`);
  // A thumbnail's few-pixel colour swatch has antialiased edges.
  ok(red[0] > 195 && red[1] < 60 && red[2] < 30, `marker washed out red text: ${red}`);
  ok(highlight.every(v => v < 5), `highlight washed out black text: ${highlight}`);
  ok(white[0] > 245 && white[1] > 200 && white[2] < 180, `the page is missing the marker tint: ${white}`);
}

await test('Marker preview and completed strokes blend with black and coloured PDF text', async () => {
  await open();
  app.tools.setTool('marker'); app.tools.setStyle({ color: '#ffd400', opacity: .55, width: 28 });
  await stroke(430, true); await stroke(390); await stroke(350);
  ok(page.annots.length === 3 && page.annots.every(a => a.kind === 'ink' && a.marker), 'marker strokes lost their identity');
  page.annots.push({ id: 'highlight', kind: 'highlight', rect: [20, 298, 350, 326], quads: [[20, 326, 350, 326, 20, 298, 350, 298]], color: '#ffd400', opacity: .55, width: 1 });
  app.tools.setTool('pen'); app.tools.setStyle({ color: '#ffd400', opacity: .55, width: 28 });
  await stroke(190);
  ok(!page.annots.at(-1).marker, 'a translucent pen became a marker');
  app.viewer.drawAnnots(view); app.tools.setTool('hand'); app.viewer.select(null);
  await window.__shot('marker-coloured-text');
  ok(getComputedStyle(view.annotsG.querySelector('.highlighter')).mixBlendMode === 'multiply', 'the completed marker lost blending');
  ok(getComputedStyle(view.annotsG.lastElementChild).mixBlendMode === 'normal', 'the regular pen changed blending');
});

await test('Thumbnails use the same highlighter blend and preserve regular pen opacity', async () => {
  app.panels.show('thumbs');
  const c = await until(() => [...app.panels.thumbs.cache.values()].find(c => c.width && c.height));
  blendedPixels(c, c.width / 400);
  const p = pixel(c, Math.floor(310 * c.width / 400), Math.ceil(185 * c.width / 400));
  ok(p[0] > 100 && p[1] > 100, 'the ordinary pen should still paint over black text');
  app.panels.show(null);
});

await test('Saved and flattened PDFs retain marker blending and editable marker identity', async () => {
  for (const flattenAnnots of [false, true]) {
    const built = await A.buildFile(session, { flattenAnnots });
    const opened = await A.openPdf(built.blob);
    try {
      blendedPixels(await canvasFor(opened.pdf));
      const annots = await (await opened.pdf.getPage(1)).getAnnotations();
      if (flattenAnnots) ok(annots.length === 0, 'flattened markers remained annotations');
      else {
        ok(annots.filter(a => a.it === 'FreehandHighlight').length === 3, 'saved markers lost their intent');
        await open(built.blob);
        await until(() => page.ghostsLoaded && page.annots.length === 5);
        const marker = page.annots.find(a => a.marker);
        ok(marker, 'reopened ink was not recognised as a marker');
        // Editing an imported marker must retain its blend mode when it leaves the PDF canvas.
        session.replaceAnnot(page, marker, { ...marker, color: '#ffd400', ghost: false });
        await until(() => view.annotsG.querySelector('.highlighter:not(.ghost)'));
        await window.__shot('marker-reopened-edited');
      }
    } finally { await opened.close(); }
  }
});

await test('XFDF preserves markers separately from translucent pens', async () => {
  const xml = A.exportXfdf(session), target = new A.Session('Imported');
  target.pages = [{ ...page, id: 'xfdf-page', annots: [], removed: [] }];
  A.importXfdf(target, xml);
  ok(target.pages[0].annots.filter(a => a.marker).length === 3, 'XFDF lost the marker intent');
  ok(target.pages[0].annots.filter(a => a.kind === 'ink' && !a.marker).length === 1, 'XFDF converted the regular pen to a marker');
  await target.close();
});

await test('Night reading keeps light text readable; tab names use the pointing hand', async () => {
  app.viewer.scroller.dataset.reading = 'night';
  ok(getComputedStyle(view.annotsG.querySelector('.highlighter')).mixBlendMode === 'screen', 'night reading needs blending for light text');
  await window.__shot('marker-night-reading');
  app.viewer.scroller.dataset.reading = 'normal';
  const name = document.querySelector('.doc-tab .name');
  ok(getComputedStyle(name).cursor === 'pointer', 'tab names show a text or grab cursor');
  ok(getComputedStyle(name).userSelect === 'none', 'tab names can still be selected as text');
  ok(name.closest('.doc-tab').draggable, 'tabs lost drag reordering');
});

await test('Imported pdf.js InkHighlight markers retain blending when edited', async () => {
  await open(documentBlob('InkHighlight'));
  await until(() => page.ghostsLoaded && page.annots.length);
  const marker = page.annots[0];
  ok(marker.kind === 'ink' && marker.marker, 'InkHighlight was imported as ordinary pen ink');
  session.replaceAnnot(page, marker, { ...marker, ghost: false, color: '#ffd400' });
  ok(view.annotsG.querySelector('.highlighter:not(.ghost)'), 'editing an imported marker lost its blending');
});

await closeAll();
export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
