// Puts the app into many states and takes a picture of each, for checking by eye.
const app = window.__pdfy, A = window.__api;
const wait = ms => new Promise(r => setTimeout(r, ms));
const shot = async (name, ms = 350) => { await wait(ms); await window.__shot(name); };
const fx = async name => { const r = await fetch(`/fixtures/${name}`); return new File([await r.blob()], name, { type: 'application/pdf' }); };
async function settle(ms = 3000) {
  const start = performance.now();
  while (performance.now() - start < ms) {
    const views = [...app.viewer.views.values()];
    if (views.length && views.every(v => !v.needsRender && !v.task)) break;
    await wait(40);
  }
  await wait(120);
}
const closeAll = async () => { for (const s of [...app.sessions]) { s.dirty = false; await app.closeSession(s); } };
const only = window.__only ? new RegExp(window.__only, 'i') : null;
const part = async (name, fn) => {
  if (only && !only.test(name)) return;
  try { await fn(); } catch (err) { console.error(`Visual step ${name}: ${err.message}`); }
  document.querySelectorAll('.overlay-bg').forEach(d => d.remove());
};

await part('start', async () => {
  A.applyUiTheme('daylight');
  await shot('01-start-light');
});

await part('modes', async () => {
  const s = await app.openPdfBlob(await fx('normal.pdf'), 'normal.pdf');
  await settle();
  // Each interface theme, in the three toolbar modes, as Xodo lays them out.
  for (const theme of ['slate', 'midnight', 'mocha', 'dracula', 'nord', 'forest', 'ember', 'daylight', 'paper']) {
    A.applyUiTheme(theme);
    app.setMode(theme === 'slate' || theme === 'daylight' ? 'edit' : 'view');
    await shot(`02-${theme}-${app.mode}`, 200);
  }
  A.applyUiTheme('slate');
  app.setMode('study');
  await shot('02-slate-study', 150);
  app.setMode('view');
  (await app.revealCommand('Compress'));
  await shot('02-slate-actions-menu', 250);
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  void app.showHelp();
  await shot('02-slate-shortcuts', 300);
  document.querySelector('.overlay-bg .primary')?.click();
  s.dirty = false;
});

await part('annots', async () => {
  await closeAll();
  const s = await app.openPdfBlob(await fx('normal.pdf'), 'normal.pdf');
  await settle();
  const base = { color: '#d92d20', opacity: 1, width: 1.5, author: 'Test' };
  let n = 0;
  const id = () => `a${n++}`;
  s.addAnnots(s.pages[0], [
    { ...base, id: id(), kind: 'highlight', color: '#ffd400', opacity: 0.55, rect: [60, 688, 300, 702], quads: [[60, 702, 300, 702, 60, 688, 300, 688]] },
    { ...base, id: id(), kind: 'underline', color: '#0b8a4f', rect: [60, 670, 300, 684], quads: [[60, 684, 300, 684, 60, 670, 300, 670]] },
    { ...base, id: id(), kind: 'strikeout', rect: [60, 652, 300, 666], quads: [[60, 666, 300, 666, 60, 652, 300, 652]] },
    { ...base, id: id(), kind: 'squiggly', rect: [60, 634, 300, 648], quads: [[60, 648, 300, 648, 60, 634, 300, 634]] },
    { ...base, id: id(), kind: 'ink', color: '#1a56db', width: 2, rect: [60, 440, 210, 540], paths: [[60, 450, 90, 530, 120, 450, 150, 530, 180, 450, 210, 530]] },
    { ...base, id: id(), kind: 'rect', rect: [230, 450, 310, 530], fill: '#ffeecc' },
    { ...base, id: id(), kind: 'ellipse', rect: [330, 450, 410, 530] },
    { ...base, id: id(), kind: 'line', rect: [430, 450, 500, 530], pts: [430, 450, 500, 530] },
    { ...base, id: id(), kind: 'arrow', rect: [510, 450, 570, 530], pts: [510, 450, 570, 530] },
    { ...base, id: id(), kind: 'polygon', rect: [60, 330, 160, 420], pts: [60, 330, 160, 330, 110, 420] },
    { ...base, id: id(), kind: 'polyline', rect: [180, 330, 280, 420], pts: [180, 330, 230, 420, 280, 330] },
    { ...base, id: id(), kind: 'cloud', rect: [300, 330, 400, 420], pts: [300, 330, 400, 330, 400, 420, 300, 420] },
    { ...base, id: id(), kind: 'measure', measureType: 'distance', measureUnit: 'in', measureScale: 1 / 72, color: '#1a56db', width: 1, rect: [420, 370, 564, 380], pts: [420, 375, 564, 375] },
    { ...base, id: id(), kind: 'text', rect: [60, 270, 280, 320], text: 'A text box that says hello to you', textColor: '#111111', fontSize: 13, width: 0 },
    { ...base, id: id(), kind: 'text', rect: [300, 270, 560, 320], text: 'مرحبا بالعالم', textColor: '#111111', fontSize: 16, width: 0 },
    { ...base, id: id(), kind: 'text', rect: [60, 230, 280, 260], text: 'Serif bold text', font: 'times', bold: true, textColor: '#7a5af8', fontSize: 14, width: 0 },
    { ...base, id: id(), kind: 'callout', rect: [60, 150, 240, 200], pts: [290, 130], text: 'Callout text', textColor: '#111111', fontSize: 12, fill: '#ffffff' },
    { ...base, id: id(), kind: 'note', rect: [530, 720, 550, 740], color: '#ffe066', fill: '#ffe066', contents: 'A sticky note' },
    { ...base, id: id(), kind: 'stamp', rect: [320, 160, 460, 202], text: 'APPROVED', contents: 'APPROVED', color: '#0b8a4f', width: 2 },
    { ...base, id: id(), kind: 'whiteout', rect: [60, 90, 200, 110], fill: '#ffffff', width: 0 },
    { ...base, id: id(), kind: 'redact', rect: [220, 90, 360, 110], color: '#000', width: 0 },
    { ...base, id: id(), kind: 'link', rect: [380, 90, 520, 110], url: 'https://example.org/', color: '#0b57d0' },
  ]);
  await settle();
  app.viewer.setFit('page');
  await settle();
  await shot('03-annots-on-screen');
  // The same annotations, as drawn from the saved file by the PDF engine, to compare with the overlay.
  const { blob } = await A.buildFile(s);
  s.dirty = false;
  await closeAll();
  const re = await app.openPdfBlob(new File([blob], 'saved.pdf', { type: 'application/pdf' }), 'saved.pdf');
  await settle();
  app.viewer.setFit('page');
  await settle();
  await shot('04-annots-from-saved-file');
  re.dirty = false;
});

await part('theme', async () => {
  await closeAll();
  A.applyUiTheme('daylight');
  await window.paste(await window.mockGemini());
  await wait(900);
  await shot('05-paste-original');
  const s = app.session, page = s.pages[0];
  await A.applyTheme(s, page, page.annots[0], { mode: 'light', style: 'gemini', keepPhotos: true });
  app.imageBar.sync();
  await shot('06-converted-light');
  await A.applyTheme(s, page, page.annots[0], { mode: 'dark', style: 'github', keepPhotos: true });
  app.imageBar.sync();
  await shot('07-converted-github-dark');
  s.dirty = false;
});

await part('real', async () => {
  for (const [file, label] of [['real-dark-ui.png', 'png'], ['real-dark-ui.jpg', 'jpg']]) {
    await closeAll();
    const blob = await (await fetch(`/fixtures/${file}`)).blob();
    await window.paste(blob);
    await wait(1000);
    const s = app.session, page = s.pages[0];
    await A.ensureAnalysis(page.annots[0].image);
    console.log('REAL', label, JSON.stringify(page.annots[0].image.analysis));
    await shot(`08-real-${label}-original`);
    await A.applyTheme(s, page, page.annots[0], { mode: 'light', style: 'gemini', keepPhotos: true });
    app.imageBar.sync();
    await shot(`09-real-${label}-light`);
    s.dirty = false;
  }
});

await part('panels', async () => {
  await closeAll();
  A.applyUiTheme('slate');
  const s = await app.openPdfBlob(await fx('annotated.pdf'), 'annotated.pdf');
  await settle();
  s.addAnnots(s.pages[0], [{ id: 'nn', kind: 'note', rect: [500, 700, 520, 720], color: '#ffe066', fill: '#ffe066', opacity: 1, width: 0.75, contents: 'Please check this number', author: 'Reviewer' }]);
  app.panels.show('comments');
  await shot('10-panel-comments', 500);
  app.panels.show('search');
  app.panels.search.input.value = 'quick';
  app.panels.search.input.dispatchEvent(new Event('input'));
  await shot('11-panel-search', 900);
  app.panels.show('thumbs');
  await shot('12-panel-thumbs', 500);
  app.setReading('night');
  await shot('13-night-reading', 300);
  app.setReading('sepia');
  await shot('14-sepia-reading', 300);
  app.setReading('normal');
  s.dirty = false;
});

await part('dialogs', async () => {
  await closeAll();
  A.applyUiTheme('daylight');
  const s = await app.openPdfBlob(await fx('normal.pdf'), 'normal.pdf');
  await settle();
  void app.watermarkDialog();
  await shot('15-dialog-watermark', 200);
  document.querySelector('.overlay-bg .btn')?.click();
  void app.chooseStamp();
  await shot('16-dialog-stamp', 200);
  document.querySelector('.overlay-bg .dialog-foot .btn')?.click();
  void app.chooseSignature();
  await shot('17-dialog-signature', 200);
  document.querySelector('.overlay-bg .dialog-foot .btn')?.click();
  void app.checkDocument();
  await shot('18-dialog-check', 1200);
  document.querySelector('.overlay-bg .primary')?.click();
  await wait(100);
  void A.compareFiles(await fx('normal.pdf'), 'normal.pdf', await fx('annotated.pdf'), 'annotated.pdf');
  await shot('19-dialog-compare', 1800);
  s.dirty = false;
});

await part('languages', async () => {
  await closeAll();
  A.applyUiTheme('daylight');
  const s = await app.openPdfBlob(await fx('normal.pdf'), 'normal.pdf');
  await settle();
  const base = { kind: 'text', color: '#111111', textColor: '#111111', opacity: 1, width: 0, fontSize: 20 };
  s.addAnnots(s.pages[0], [
    { ...base, id: 'a1', rect: [60, 480, 550, 520], text: 'مرحبا بالعالم، هذا نص عربي للتجربة' },
    { ...base, id: 'a2', rect: [60, 440, 550, 480], text: 'Привет мир, это русский текст' },
    { ...base, id: 'a3', rect: [60, 400, 550, 440], text: 'Γειά σου Κόσμε' },
    { ...base, id: 'a4', rect: [60, 360, 550, 400], text: 'رقم 42 مع Test مختلط' },
    { ...base, id: 'a5', rect: [60, 300, 550, 360], text: 'سطر أول طويل جدا يحتاج إلى أن يلتف إلى السطر التالي داخل المربع', fontSize: 16, bold: true },
    { ...base, id: 'a6', rect: [60, 260, 550, 300], text: 'Serif: مرحبا', font: 'times' },
    { ...base, id: 'a7', rect: [60, 220, 550, 260], text: '日本語のテキスト 中文 한국어' },
  ]);
  app.viewer.setFit('page');
  await settle();
  await shot('20-languages-on-screen');
  const { blob } = await A.buildFile(s);
  s.dirty = false;
  await closeAll();
  const re = await app.openPdfBlob(new File([blob], 'saved.pdf', { type: 'application/pdf' }), 'saved.pdf');
  await settle();
  app.viewer.setFit('page');
  await settle();
  await shot('21-languages-saved');
  re.dirty = false;
});

await part('word', async () => {
  await closeAll();
  A.applyUiTheme('daylight');
  const f = await fx('sample.docx');
  void A.openDocxEditor(new File([f], 'sample.docx'), { save: async () => true, toPdf: async () => {}, pickImage: async () => undefined });
  await shot('22-word-editor', 600);
  document.querySelector('.overlay-bg .dialog-head .icon-btn')?.click();
});

await closeAll();
export default { summary: { failed: 0 } };
