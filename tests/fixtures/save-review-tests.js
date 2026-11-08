// End-to-end regressions for source-page edits, failed save fallbacks and embedded content.
const A = window.__api;
const results = [];
const eq = (a, b, message) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${message}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); };
const ok = (value, message) => { if (!value) throw new Error(message); };
async function rejects(run, message) { try { await run(); } catch { return; } throw new Error(message); }
async function test(name, run) {
  console.log('TEST', name);
  const started = performance.now();
  try { await run(); results.push({ name, ok: true, ms: Math.round(performance.now() - started) }); }
  catch (error) { results.push({ name, ok: false, error: String(error?.message ?? error) }); }
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), results }) });
}
const encode = text => new TextEncoder().encode(text);
const ascii = bytes => { let result = ''; for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192)); return result; };
function pdf(objects) {
  let body = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return new Blob([Uint8Array.from(body, character => character.charCodeAt(0))], { type: 'application/pdf' });
}
function notePdf(label) {
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << >> /Contents 4 0 R /Annots [5 0 R 6 0 R] >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    `<< /Type /Annot /Subtype /Text /Rect [20 30 40 50] /Contents (${label}-first) /Name /Note >>`,
    `<< /Type /Annot /Subtype /Text /Rect [70 30 90 50] /Contents (${label}-second) /Name /Note >>`,
  ]);
}
async function sessionFor(blob, name = 'Review.pdf') {
  const session = new A.Session(name);
  session.pages = await session.addSource(blob, name);
  return session;
}
async function withSaved(session, options, run) {
  const built = await A.buildFile(session, options);
  const reopened = await A.openPdf(built.blob);
  try { return await run(reopened.pdf, built); } finally { await reopened.close(); }
}
const annotations = async (document, page) => (await document.getPage(page)).getAnnotations({ intent: 'display' });

await test('Save review: annotation edits on merged and duplicated pages target the source IDs', async () => {
  const session = await sessionFor(notePdf('base'));
  try {
    const inserted = await session.addSource(notePdf('other'), 'Other.pdf');
    const imported = inserted[0];
    const original = await session.pdfPage(imported);
    const sourceAnnots = await original.getAnnotations();
    imported.removed.push(sourceAnnots[0].id);
    imported.annots.push({ id: 'replacement', importedFrom: sourceAnnots[1].id, kind: 'note', rect: [80, 80, 100, 100], color: '#ffd400', opacity: 1, width: 1, contents: 'replacement-second' });
    const duplicate = { ...imported, id: 'duplicate-page', annots: [], removed: [sourceAnnots[1].id] };
    session.pages = [...session.pages, imported, duplicate];
    await withSaved(session, {}, async document => {
      eq((await annotations(document, 1)).map(a => a.contentsObj?.str).sort(), ['base-first', 'base-second'], 'The base source stays untouched');
      eq((await annotations(document, 2)).map(a => a.contentsObj?.str), ['replacement-second'], 'The merged source has exactly its replacement');
      eq((await annotations(document, 3)).map(a => a.contentsObj?.str), ['other-first'], 'The duplicate uses its own deletion list');
    });
  } finally { await session.close(); }
});

await test('Save review: never-viewed later pages retain their own rotation', async () => {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
  const refs = [];
  for (let i = 0; i < 26; i++) {
    const ref = objects.length + 1;
    refs.push(`${ref} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Rotate ${i === 23 ? 90 : i === 25 ? 270 : 0} /Resources << >> >>`);
  }
  objects[1] = `<< /Type /Pages /Count 26 /Kids [${refs.join(' ')}] >>`;
  const session = await sessionFor(pdf(objects));
  try {
    ok(!session.pages[23].sized && !session.pages[25].sized, 'Later pages must still be unsized');
    session.pages[25].rotate = 90;
    await withSaved(session, {}, async document => {
      eq((await document.getPage(24)).rotate, 90, 'The source rotation beyond the save sample is preserved');
      eq((await document.getPage(26)).rotate, 0, 'A new rotation adds to the real source rotation');
    });
  } finally { await session.close(); }
});

await test('Save review: a failed fallback render rejects rather than saving a blank page', async () => {
  const session = await sessionFor(notePdf('fallback'));
  const source = [...session.sources.values()][0];
  const page = await session.pdfPage(session.pages[0]);
  const originalRender = page.render;
  try {
    source.blob = new Blob(['not a PDF'], { type: 'application/pdf' });
    page.render = () => ({ promise: Promise.reject(new Error('Injected render failure')), cancel() {} });
    await rejects(() => A.buildFile(session), 'Failed rendering must reject the save');
  } finally { page.render = originalRender; await session.close(); }
});

await test('Save review: missing imported voice bytes stop saving; readable bytes survive exactly', async () => {
  const original = new A.Session('Voice.pdf');
  original.pages = [original.blankPage()];
  const bytes = new Uint8Array([82, 73, 70, 70, 9, 8, 7, 6, 87, 65, 86, 69, 1, 2, 3, 4]);
  original.pages[0].annots.push({ id: 'voice-source', kind: 'attachment', rect: [20, 30, 40, 50], color: '#9ac5ae', opacity: 1, width: 1, attachment: { name: 'Voice.wav', mime: 'audio/wav', voice: true, blob: new Blob([bytes], { type: 'audio/wav' }) } });
  const built = await A.buildFile(original);
  await original.close();
  const session = await sessionFor(built.blob);
  const source = [...session.sources.values()][0];
  const native = (await annotations(source.pdf, 1)).find(a => a.subtype === 'FileAttachment');
  ok(native?.fileId, 'The native attachment must have a file ID');
  session.pages[0].annots.push({ id: 'moved-voice', kind: 'attachment', importedFrom: native.id, rect: [80, 90, 100, 110], color: '#9ac5ae', opacity: 1, width: 1, attachment: { name: 'Voice.wav', mime: 'audio/wav', voice: true, fileId: native.fileId } });
  const read = source.pdf.getAttachmentContent;
  try {
    source.pdf.getAttachmentContent = async () => null;
    await rejects(() => A.buildFile(session), 'Missing attachment bytes must reject saving');
    source.pdf.getAttachmentContent = async () => { throw new Error('Injected attachment read failure'); };
    await rejects(() => A.buildFile(session), 'Attachment read failures must reject saving');
    source.pdf.getAttachmentContent = read;
    await withSaved(session, {}, async document => {
      const saved = (await annotations(document, 1)).filter(a => a.subtype === 'FileAttachment');
      eq(saved.length, 1, 'Exactly one moved attachment remains');
      const content = await document.getAttachmentContent(saved[0].fileId);
      eq([...((content instanceof Uint8Array) ? content : content.content)], [...bytes], 'The recording bytes match');
    });
  } finally { source.pdf.getAttachmentContent = read; await session.close(); }
});

await test('Save review: flatten keeps annotations whose appearance must be generated by the viewer', async () => {
  const session = await sessionFor(notePdf('appearance'));
  try {
    await withSaved(session, { flattenAnnots: true }, async (document, built) => {
      eq((await annotations(document, 1)).map(a => a.contentsObj?.str).sort(), ['appearance-first', 'appearance-second'], 'Missing appearances must never delete note content');
      ok(built.warnings.some(message => message.includes('kept editable')), 'The incomplete flatten must be explained');
    });
  } finally { await session.close(); }
});

await test('Save review: compression preserves explicit image masks', async () => {
  const side = 256, raw = new Uint8Array(side * side * 3);
  let random = 7919;
  for (let i = raw.length / 2; i < raw.length; i++) { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; raw[i] = random >>> 24; }
  const compressed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const image = `<< /Type /XObject /Subtype /Image /Width ${side} /Height ${side} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Mask [0 0 0 0 0 0] /Length ${compressed.length} >>\nstream\n${ascii(compressed)}\nendstream`;
  const content = 'q 300 0 0 400 0 0 cm /Im0 Do Q';
  const session = await sessionFor(pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, image,
  ]));
  try {
    const built = await A.buildFile(session, { compress: { quality: 0.15, maxSide: 128 } });
    const content = ascii(new Uint8Array(await built.blob.arrayBuffer()));
    ok(/\/Mask\s*\[\s*0\s+0\s+0\s+0\s+0\s+0\s*\]/.test(content), 'The explicit transparency mask must stay in the saved image dictionary');
  } finally { await session.close(); }
});

export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
