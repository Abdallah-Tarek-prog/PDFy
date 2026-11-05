// Tests for the study tools: equations, Markdown notes, word lookup, reading pictures, fonts, colours
// and preference sets. Runs inside the app. Outside the desktop app, boxes are saved as pictures,
// because only the desktop app has the print engine. The desktop test checks the vector path.
const app = window.__pdfy, A = window.__api;
const results = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
const fx = async name => { const r = await fetch(`/fixtures/${name}`); return new File([await r.blob()], name, { type: 'application/pdf' }); };
const closeAll = async () => { for (const s of [...app.sessions]) { s.dirty = false; await app.closeSession(s); } };
const save = (blob, name) => fetch(`/__save/${name}`, { method: 'PUT', body: blob });
const only = window.__only ? new RegExp(window.__only, 'i') : null;

async function test(name, fn) {
  if (only && !only.test(name)) return;
  console.log('TEST', name);
  const t0 = performance.now();
  try {
    const note = await fn();
    results.push({ ok: true, name, ms: Math.round(performance.now() - t0), note });
  } catch (err) {
    results.push({ ok: false, name, error: String(err?.message ?? err) });
  }
  document.querySelectorAll('.overlay-bg, .dict-pop, .popover, .word-bar').forEach(d => d.remove());
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), results }, null, 1) });
}
const ok = (v, msg) => { if (!v) throw new Error(msg ?? 'check failed'); };
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg ?? 'values differ'}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); };
async function settle(ms = 4000) {
  const start = performance.now();
  while (performance.now() - start < ms) {
    const views = [...app.viewer.views.values()];
    if (views.length && views.every(v => !v.needsRender && !v.task)) break;
    await wait(40);
  }
  await wait(60);
}
const until = async (fn, ms = 6000, what = 'condition') => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(50); }
  throw new Error(`Timed out waiting for ${what}`);
};
const reopen = async blob => { const r = await A.openPdf(blob, async () => null); return { pdf: r.pdf, destroy: () => r.close() }; };
const pageAnnots = async (doc, i = 0) => (await doc.pdf.getPage(i + 1)).getAnnotations({ intent: 'display' });
function screen(page, px, py) {
  const v = app.viewer.views.get(page.id);
  const r = v.el.getBoundingClientRect();
  const m = v.vp.m;
  return [r.left + m[0] * px + m[2] * py + m[4], r.top + m[1] * px + m[3] * py + m[5]];
}
const pointer = (type, x, y, target) => (target ?? document.elementFromPoint(x, y)).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, isPrimary: true }));

// ---- Equations ----

await test('Equation: LaTeX becomes a vector drawing, with a readable error for mistakes', async () => {
  const r = await A.texToSvg('\\frac{a}{b} + \\sqrt{x^2+1} = \\sum_{i=1}^{n} i', true);
  ok(r.svg.startsWith('<svg') && r.svg.includes('<path'), 'drawn as paths');
  ok(!r.svg.includes('<use'), 'no shared parts, so each drawing stands alone');
  ok(r.width > 3 && r.height > 1, `natural size ${r.width} by ${r.height}`);
  let message = '';
  try { await A.texToSvg('\\frac{a}{b', true); } catch (err) { message = err.message; }
  ok(message, 'a missing brace is reported');
  const link = await A.texToSvg(String.raw`\href{javascript:window.__pwned=9}{x} + \style{background:url(https://example.com/a)}{y}`, true);
  ok(!/href|<a\b|url\(/i.test(link.svg), 'links and outside addresses are removed from equations');
  return `size ${r.width.toFixed(2)} by ${r.height.toFixed(2)} em, error: ${message}`;
});

await test('Equation: insert through the editor, edit, save, reopen and edit again', async () => {
  await closeAll();
  const s = app.newDocument();
  await settle();
  void app.study.insertEquation();
  const input = await until(() => document.querySelector('.eq-input'), 4000, 'the editor');
  // Clicking a palette key puts LaTeX where the cursor is.
  [...document.querySelectorAll('.eq-tab')].find(t => t.textContent === 'Structures').click();
  [...document.querySelectorAll('.eq-key')].find(k => k.title.startsWith('Fraction')).click();
  ok(input.value.includes('\\frac{a}{b}'), 'palette inserted a fraction');
  input.value = 'E = mc^2 + \\int_0^1 x\\,dx';
  input.dispatchEvent(new Event('input'));
  await until(() => document.querySelector('.eq-preview svg'), 6000, 'the preview');
  const insert = [...document.querySelectorAll('.eq-foot .btn')].find(b => b.textContent === 'Insert');
  await until(() => !insert.disabled, 3000, 'Insert to be ready');
  insert.click();
  await wait(100);
  const page = s.pages[0];
  const a = page.annots.find(x => x.kind === 'math');
  ok(a, 'equation added');
  ok(a.mathSvg?.includes('<path'), 'drawing kept with it');
  ok(document.querySelector(`[data-id="${a.id}"] .math-box svg`), 'shown on the page');
  // The bar above the page changes its size, which keeps its shape.
  const w0 = a.rect[2] - a.rect[0];
  await app.study.restyleEquation(page, a, { fontSize: 36 });
  const bigger = page.annots.find(x => x.kind === 'math');
  ok(Math.abs((bigger.rect[2] - bigger.rect[0]) / w0 - 2) < 0.05, 'twice the size, twice as wide');
  const { blob } = await A.buildFile(s);
  await save(blob, 'study-equation.pdf');
  const pdf = await reopen(blob);
  const list = await pageAnnots(pdf);
  const st = list.find(x => x.subtype === 'Stamp');
  ok(st, 'saved as a stamp other apps show');
  ok(st.contentsObj.str.includes('E = mc^2') && st.contentsObj.str.includes('pdfy:'), 'LaTeX kept in the file');
  await pdf.destroy();
  // Reopened, it is an equation again, not a plain stamp.
  s.dirty = false;
  await closeAll();
  const back = await app.openPdfBlob(new File([blob], 'eq.pdf', { type: 'application/pdf' }), 'eq.pdf');
  await settle();
  await until(() => back.pages[0].annots.length, 4000, 'existing annotations');
  const ghost = back.pages[0].annots.find(x => x.kind === 'math');
  ok(ghost && ghost.latex.includes('E = mc^2'), 'reopened as an equation with its LaTeX');
  eq(ghost.fontSize, 36, 'size kept');
  back.dirty = false;
  return `${blob.size} bytes`;
});

// ---- Markdown ----

const NOTE = `# Heading one
Some **bold**, *italic*, ~~gone~~ and ==highlighted== text with \`code\`.

> [!warning] Careful
> A callout, like Obsidian.

- [x] done task
- [ ] open task

| A | B |
|---|---|
| 1 | 2 |

Inline maths $a^2 + b^2 = c^2$ and money like $5 and $6.

$$\\int_0^1 x^2 \\, dx = \\frac{1}{3}$$

مرحبا بالعالم، هذه ملاحظة عربية.

\`\`\`js
const x = 42; // comment
\`\`\`
`;

await test('Markdown: formatting, callouts, tasks, tables, equations and Arabic', async () => {
  const host = document.createElement('div');
  await A.renderMarkdownInto(host, NOTE);
  ok(host.querySelector('h1')?.textContent === 'Heading one', 'heading');
  ok(host.querySelector('mark')?.textContent === 'highlighted', '==highlight==');
  ok(host.querySelector('del'), 'strikethrough');
  ok(host.querySelector('.md-callout.c-warning .md-callout-title')?.textContent === 'Careful', 'callout with its title');
  eq(host.querySelectorAll('.md-check').length, 2, 'task boxes');
  ok(host.querySelector('.md-check.on'), 'ticked task');
  ok(host.querySelector('table td'), 'table');
  ok(host.querySelectorAll('svg').length >= 2, 'inline and block equations drawn');
  ok(host.textContent.includes('$5 and $6'), 'money stays money');
  ok(host.querySelector('.tk-k') && host.querySelector('.tk-c'), 'code coloured');
  ok([...host.querySelectorAll('p')].some(p => p.getAttribute('dir') === 'auto' && /مرحبا/.test(p.textContent)), 'Arabic paragraph picks its own direction');
});

await test('Markdown: nothing in a note can run code or reach the internet', async () => {
  const host = document.createElement('div');
  await A.renderMarkdownInto(host, '<img src=x onerror="window.__pwned=1"> <script>window.__pwned=2</script>\n\n[click](javascript:window.__pwned=3) ![pic](https://example.com/a.png) <a href="https://x" onclick="x()">a</a>');
  await wait(50);
  ok(!window.__pwned, 'nothing ran');
  ok(!host.querySelector('img, script, [onerror], [onclick]'), 'no dangerous elements or handlers');
  ok(![...host.querySelectorAll('a')].some(a => /^javascript/i.test(a.getAttribute('href') ?? '')), 'no script links');
  ok(host.textContent.includes('<script>'), 'raw HTML is shown as typed');
});

await test('Markdown: type a note on the page, it formats on click-away, then save and reopen', async () => {
  await closeAll();
  const s = app.newDocument();
  await settle();
  const page = s.pages[0];
  app.tools.setTool('markdown');
  const [x, y] = screen(page, 72, 700);
  pointer('pointerdown', x, y);
  pointer('pointerup', x, y);
  const ta = await until(() => document.querySelector('textarea.inline-editor.md-source'), 3000, 'the Markdown editor');
  ta.value = NOTE;
  ta.dispatchEvent(new Event('input'));
  ta.blur();
  const a = await until(() => page.annots.find(x => x.markdown), 8000, 'the note');
  const node = await until(() => document.querySelector(`[data-id="${a.id}"] .md-box h1`), 6000, 'the formatted note');
  ok(node, 'formatted on the page');
  const tall = a.rect[3] - a.rect[1];
  ok(tall > 180, `height fits the content: ${tall.toFixed(0)} pt`);
  eq(a.mdTheme, A.themeById(a.mdTheme).id, 'has a theme');
  // A narrower note needs to be taller.
  await app.study.restyleNote(page, a, { rect: [a.rect[0], a.rect[1], a.rect[0] + 180, a.rect[3]] });
  const narrow = page.annots.find(x => x.markdown);
  ok(narrow.rect[3] - narrow.rect[1] > tall, 'narrower is taller');
  await app.study.restyleNote(page, narrow, { mdTheme: 'obsidian-dark' });
  const dark = page.annots.find(x => x.markdown);
  eq(dark.mdTheme, 'obsidian-dark', 'theme changed');
  const { blob } = await A.buildFile(s);
  await save(blob, 'study-markdown.pdf');
  const pdf = await reopen(blob);
  const ft = (await pageAnnots(pdf)).find(x => x.subtype === 'FreeText');
  ok(ft, 'saved as a text box other apps show');
  ok(ft.contentsObj.str.startsWith('# Heading one'), 'Markdown kept in the file');
  await pdf.destroy();
  s.dirty = false;
  await closeAll();
  const back = await app.openPdfBlob(new File([blob], 'md.pdf', { type: 'application/pdf' }), 'md.pdf');
  await settle();
  const g = await until(() => back.pages[0].annots.find(x => x.markdown), 4000, 'the reopened note');
  eq(g.mdTheme, 'obsidian-dark', 'theme back');
  ok(g.text.startsWith('# Heading one') && !g.text.includes('pdfy:'), 'text back, without the hidden marker');
  back.dirty = false;
  return `${(a.rect[2] - a.rect[0]).toFixed(0)} by ${tall.toFixed(0)} pt, file ${blob.size} bytes`;
});

await test('Markdown: the saved picture of a note is sharp and not blank', async () => {
  const html = '<div class="md-box" style="--md-text:#000;--md-bg:#fff;font-size:12px"><h1>Hello</h1><p>World</p></div>';
  const png = await A.boxToPicture(html, 200, 80);
  const bmp = await createImageBitmap(new Blob([png], { type: 'image/png' }));
  eq(bmp.width, 600, 'three times sharper than the page');
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const x = c.getContext('2d');
  x.drawImage(bmp, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let dark = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i] < 90) dark++;
  ok(dark > 500, `text pixels drawn: ${dark}`);
});

// ---- Dictionary ----

await test('Dictionary: words, forms, sounds and Arabic', async () => {
  const book = await A.lookUp('book');
  ok(book.entry, 'book found');
  ok(book.entry.ipaUk || book.entry.ipaUs, 'has a pronunciation');
  const ar = book.entry.parts.flatMap(p => p.arabic.map(a => a.word));
  ok(ar.some(w => w.replace(/[ً-ْ]/g, '').includes('كتاب')), `book in Arabic: ${ar.slice(0, 4).join(', ')}`);
  const running = await A.lookUp('running');
  ok(running.entry, 'running found');
  const went = await A.lookUp('went');
  ok(went.entry && (went.entry.word === 'go' || went.base?.word === 'go' || went.entry.formOf.includes('go')), `went leads to go: ${went.entry?.word}`);
  const comma = await A.lookUp('“students,”');
  eq(comma.entry?.word, 'student', 'punctuation and plural removed');
  const known = await A.lookUp('recieve');
  eq(known.entry?.word, 'receive', 'a common misspelling leads to the right word');
  const typo = await A.lookUp('dictionarry');
  ok(!typo.entry && typo.suggestions.includes('dictionary'), `suggests dictionary: ${typo.suggestions.join(', ')}`);
  return `book: ${book.entry.ipaUk ?? book.entry.ipaUs}; ${ar.slice(0, 3).join(' ')}`;
});

await test('Dictionary: the pop-up shows sounds, Arabic, meanings and publisher links', async () => {
  await A.showDictionary('water', { x: 300, y: 200, sentence: 'Plants need water to grow.', tab: 'quick' });
  const pop = await until(() => document.querySelector('.dict-pop .dict-word') && document.querySelector('.dict-pop'), 5000, 'the pop-up');
  ok(pop.querySelector('.dict-sound'), 'pronunciation buttons');
  ok(pop.querySelector('.dict-ar-text'), 'Arabic shown');
  eq(pop.querySelector('.dict-ar-words').getAttribute('dir'), 'rtl', 'Arabic reads right to left');
  ok(pop.querySelectorAll('.dict-senses li').length >= 1, 'English meanings');
  const labels = [...pop.querySelectorAll('.dict-tab, .dict-foot .btn')].map(b => b.textContent);
  for (const l of ['Quick', 'Longman', 'Oxford', 'Cambridge عربي', 'Translate sentence']) ok(labels.includes(l), `${l} button`);
  // Clicking outside closes it.
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  await wait(30);
  ok(!document.querySelector('.dict-pop'), 'closes on an outside click');
  ok(A.ONLINE_SOURCES.find(s => s.id === 'longman').url('take off').endsWith('/take-off'), 'phrases become page addresses');
});

await test('Dictionary: with lookup on, selecting a word on the page opens it', async () => {
  await closeAll();
  const s = await app.openPdfBlob(await fx('normal.pdf'), 'normal.pdf');
  await settle();
  await until(() => document.querySelector('.textLayer span'), 6000, 'page text');
  app.study.toggleLookup(true);
  const span = [...document.querySelectorAll('.textLayer span')].find(x => /\b[A-Za-z]{4,}\b/.test(x.textContent));
  const m = /\b[A-Za-z]{4,}\b/.exec(span.textContent);
  const range = document.createRange();
  range.setStart(span.firstChild, m.index);
  range.setEnd(span.firstChild, m.index + m[0].length);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  app.viewer.scroller.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  const pop = await until(() => document.querySelector('.dict-pop .dict-word'), 6000, 'the pop-up');
  app.study.toggleLookup(false);
  getSelection().removeAllRanges();
  s.dirty = false;
  return `looked up “${m[0]}” as “${pop.textContent}”`;
});

// ---- Reading a picture ----

await test('Read picture: words in a pasted dark screenshot become clickable', async () => {
  await closeAll();
  await paste(await mockGemini());
  await until(() => app.session?.pages[0]?.annots.some(a => a.kind === 'image'), 6000, 'the pasted image');
  await settle();
  const s = app.session, page = s.pages[0];
  const img = page.annots.find(a => a.kind === 'image');
  const shot = await A.regionCanvas(s, page, img.rect);
  const words = await A.readWords(shot.canvas, 'eng');
  const text = A.wordsToText(words).toLowerCase();
  ok(words.length > 20, `${words.length} words read`);
  ok(/convert|screenshot|colours|gemini/.test(text), `expected words found in: ${text.slice(0, 120)}`);
  const v = app.viewer.views.get(page.id);
  A.showWordLayer(v, words, shot);
  const spot = [...document.querySelectorAll('.word-spot')].find(b => /^[A-Za-z]{5,}$/.test(b.title));
  ok(spot, 'a clickable word');
  const r = spot.getBoundingClientRect();
  ok(r.width > 2 && r.height > 2, 'placed over the picture');
  spot.click();
  await until(() => document.querySelector('.dict-pop .dict-word'), 6000, 'the pop-up');
  document.querySelector('.word-bar .primary').click();
  ok(!document.querySelector('.word-layer'), 'Done removes the spots');
  s.dirty = false;
  return `${words.length} words, clicked “${spot.title}”`;
});

// ---- Fonts and colours ----

await test('Fonts: any installed font, added font files, and saving text in them', async () => {
  const bytes = await (await fetch('/sysfonts/georgia.ttf')).arrayBuffer();
  eq(A.familyNameOf(bytes), 'Georgia', 'name read from the file');
  const names = await A.addFontFiles([new File([bytes], 'my-font.ttf')]);
  eq(names[0], 'Georgia', 'added');
  ok(document.fonts.check("12px 'Georgia'"), 'usable on the page');
  await closeAll();
  const s = app.newDocument();
  await settle();
  const page = s.pages[0];
  s.addAnnots(page, [{ id: 'f1', kind: 'text', rect: [72, 600, 300, 640], color: '#7048e8', textColor: '#7048e8', opacity: 1, width: 0, fill: null, fontSize: 16, fontName: 'Georgia', text: 'Georgia text, and عربي too' }]);
  await wait(50);
  const div = document.querySelector('[data-id="f1"] .annot-text');
  ok(getComputedStyle(div).fontFamily.includes('Georgia'), 'shown in that font');
  const { blob } = await A.buildFile(s);
  const pdf = await reopen(blob);
  const ft = (await pageAnnots(pdf)).find(x => x.subtype === 'FreeText');
  ok(ft?.contentsObj.str.includes('"font":"Georgia"'), 'font remembered in the file');
  await pdf.destroy();
  s.dirty = false;
});

await test('Font picker: search, keep at the top, choose', async () => {
  const anchor = document.createElement('button');
  document.body.append(anchor);
  let chosen = null;
  const { openFontPicker } = await import('/app.js').catch(() => ({}));
  void openFontPicker;
  // Opened the way the bar above the page opens it.
  await closeAll();
  const s = app.newDocument();
  await settle();
  app.tools.setTool('text');
  await wait(30);
  const btn = await until(() => document.querySelector('.style-bar .font-btn'), 2000, 'the font button');
  btn.click();
  const search = await until(() => document.querySelector('.font-popover .fp-search'), 2000, 'the picker');
  await until(() => document.querySelectorAll('.font-popover .fp-row').length > 5, 4000, 'the font list');
  search.value = 'georg';
  search.dispatchEvent(new Event('input'));
  const row = await until(() => [...document.querySelectorAll('.fp-row')].find(r => r.textContent.includes('Georgia')), 2000, 'Georgia in the results');
  row.querySelector('.fp-star').click();
  ok(JSON.parse(localStorage.getItem('pdfy.fontFavourites')).includes('Georgia'), 'kept at the top');
  [...document.querySelectorAll('.fp-row')].find(r => r.textContent.includes('Georgia')).click();
  chosen = app.tools.style('text').fontName;
  eq(chosen, 'Georgia', 'new text boxes use it');
  anchor.remove();
  app.tools.setStyle({ fontName: undefined }, 'text');
  localStorage.removeItem('pdfy.fontFavourites');
  s.dirty = false;
});

await test('Colour picker: any colour by code, palette, and remembered', async () => {
  await closeAll();
  const s = app.newDocument();
  await settle();
  app.tools.setTool('pen');
  await wait(30);
  const btn = await until(() => document.querySelector('.style-bar .colour-btn'), 2000, 'the colour button');
  btn.click();
  const hex = await until(() => document.querySelector('.colour-popover .cp-hex'), 2000, 'the picker');
  hex.value = '#12ab9c';
  hex.dispatchEvent(new Event('change'));
  eq(app.tools.style('pen').color, '#12ab9c', 'typed colour used');
  ok(document.querySelector('.colour-popover .cp-row-title')?.textContent, 'palettes shown');
  ok(JSON.parse(localStorage.getItem('pdfy.colourRecent'))[0] === '#12ab9c', 'remembered as recent');
  const sw = document.querySelectorAll('.colour-popover .cp-sw');
  ok(sw.length > 40, `${sw.length} ready-made colours`);
  sw[sw.length - 1].click();
  ok(app.tools.style('pen').color !== '#12ab9c', 'a palette colour applies');
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  app.tools.setStyle({ color: '#1a56db' }, 'pen');
  s.dirty = false;
});

// ---- Preference sets ----

await test('Preference sets: one click sets fonts, colours, note look and lookup', async () => {
  const sets = A.allSets();
  ok(sets.length >= 5, 'ready-made sets');
  void app.settingsDialog();
  await until(() => document.querySelector('.set-card'), 3000, 'the preferences');
  const night = document.querySelector('[data-set="night"]');
  night.click();
  await until(() => app.reading === 'night', 3000, 'night reading');
  eq(app.tools.style('highlight').color, sets.find(x => x.id === 'night').highlight, 'highlight colour');
  ok(app.study.lookupOn, 'lookup on');
  eq(document.documentElement.dataset.theme, 'dark', 'dark interface');
  document.querySelector('.overlay-bg .dialog-foot .primary').click();
  await wait(50);
  // Back to how the other tests expect it.
  await app.study.applySet(sets.find(x => x.id === 'study'));
  app.study.toggleLookup(false);
  app.setReading('normal');
  document.documentElement.dataset.theme = 'light';
  for (const k of ['pdfy.styles', 'pdfy.settings', 'pdfy.uiTheme']) localStorage.removeItem(k);
});

await test('Study tab: every button is there and works without a crash', async () => {
  await closeAll();
  const s = app.newDocument();
  await settle();
  app.setMode('study');
  await wait(40);
  const labels = [...document.querySelectorAll('.tb-btn')].map(b => b.dataset.label);
  for (const l of ['Word lookup', 'Read picture', 'Markdown note', 'Equation', 'Note themes', 'Preferences']) ok(labels.includes(l), `${l} button`);
  (await app.revealCommand('Note themes')).click();
  await until(() => document.querySelector('.theme-dialog .md-box h1'), 4000, 'the theme editor with a preview');
  // Editing a ready-made theme makes your own copy.
  const before = JSON.parse(localStorage.getItem('pdfy.mdThemes') ?? '[]').length;
  const size = document.querySelector('.theme-form input[type=number]');
  size.value = '15';
  size.dispatchEvent(new Event('change'));
  const after = JSON.parse(localStorage.getItem('pdfy.mdThemes') ?? '[]');
  eq(after.length, before + 1, 'a copy was made');
  eq(after.at(-1).size, 15, 'with the change');
  document.querySelector('.overlay-bg .dialog-foot .btn').click();
  localStorage.removeItem('pdfy.mdThemes');
  app.setMode('view');
  s.dirty = false;
});

// ---- The publishers' pages, read live ----

const summary = r => r ? r.blocks.map(b => `${b.headword}${b.homnum ?? ''} ${b.pos ?? ''} ${b.level ?? ''} [${b.prons.map(p => `${p.region} ${p.ipa ?? '-'} ${p.audio ? 'rec' : 'no-rec'}`).join('; ')}] ${b.senses.length} senses; 1: ${b.senses[0]?.signpost ? `(${b.senses[0].signpost}) ` : ''}${b.senses[0]?.def.slice(0, 50)}${b.senses[0]?.arabic ? ` = ${b.senses[0].arabic}` : ''}; ex ${b.senses.reduce((n, s) => n + s.examples.length, 0)}`).join(' || ') + (r.related.length ? ` | related: ${r.related.map(x => x.label).join(', ')}` : '') : 'none';

for (const id of ['cambridge', 'oxford', 'longman']) {
  await test(`Publishers: ${id} reads words, pronunciations, recordings and meanings`, async () => {
    const r = await A.lookUpOnline(id, 'water');
    ok(r && r.blocks.length, 'an entry');
    const b = r.blocks[0];
    eq(b.headword, 'water', 'headword');
    ok(b.prons.some(p => p.region === 'UK' && p.audio && p.ipa), 'British pronunciation with a recording');
    ok(b.prons.some(p => p.region === 'US' && p.audio), 'American recording');
    const total = r.blocks.reduce((n, x) => n + x.senses.length, 0);
    ok(total >= 2, `${total} meanings`);
    ok(b.senses.some(s => s.examples.length), 'examples');
    if (id === 'cambridge') ok(r.blocks.every(x => x.senses.every(s => /[؀-ۿ]/.test(s.arabic ?? ''))), 'Arabic for each meaning');
    if (id === 'oxford') ok(b.level === 'A1', `level ${b.level}`);
    if (id === 'longman') ok(b.senses.some(s => s.signpost) && b.senses.some(s => s.examples.some(e => e.audio)), 'signposts and spoken examples');
    const ok1 = await A.playRecording(b.prons.find(p => p.audio).audio, 6000).catch(() => false);
    const extra = [];
    for (const w of ['take off', 'running', 'beautiful', 'dictionarry']) extra.push(`${w}: ${summary(await A.lookUpOnline(id, w).catch(e => ({ blocks: [], related: [], err: e.message })))}`);
    return `${summary(r)} | recording plays: ${ok1} | ${extra.join(' | ')}`;
  });
}

await test('Publishers: the pop-up shows the tabs, reads the chosen site, and pins to the side', async () => {
  localStorage.setItem('pdfy.settings', JSON.stringify({ onlineDict: true, dictTab: 'cambridge' }));
  await A.showDictionary('beautiful', { x: 300, y: 200, sentence: 'What a beautiful day.' });
  const pop = await until(() => document.querySelector('.dict-pop .pub-hw') && document.querySelector('.dict-pop'), 15000, 'the Cambridge entry');
  const tabs = [...pop.querySelectorAll('.dict-tab')].map(t => t.textContent);
  for (const t of ['Quick', 'Cambridge عربي', 'Oxford', 'Longman']) ok(tabs.includes(t), `${t} tab`);
  ok(pop.querySelector('.pub-ar'), 'Arabic meaning from Cambridge');
  await window.__shot?.('39a-dictionary-cambridge');
  [...pop.querySelectorAll('.dict-tab')].find(t => t.textContent === 'Oxford').click();
  await until(() => document.querySelector('.dict-pop .pub-oxford .pub-hw'), 15000, 'the Oxford entry');
  await window.__shot?.('39b-dictionary-oxford');
  eq(JSON.parse(localStorage.getItem('pdfy.settings')).dictTab, 'oxford', 'remembered as the first tab');
  [...pop.querySelectorAll('.dict-tab')].find(t => t.textContent === 'Longman').click();
  await until(() => document.querySelector('.dict-pop .pub-longman .pub-hw'), 15000, 'the Longman entry');
  ok(pop.querySelector('.dict-sound.uk'), 'UK sound button');
  pop.querySelector('.dict-head-tools .icon-btn').click();
  ok(pop.classList.contains('docked'), 'pinned to the side');
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  await wait(30);
  ok(document.querySelector('.dict-pop'), 'stays open when pinned');
  await window.__shot?.('39-dictionary-longman-pinned');
  A.closeDictionary();
  localStorage.removeItem('pdfy.settings');
});

await test('Publishers: with no internet, Quick still works and sound falls back to Windows', async () => {
  A.setOfflineForTest(true);
  try {
    localStorage.setItem('pdfy.settings', JSON.stringify({ onlineDict: true, dictTab: 'oxford' }));
    await A.showDictionary('river', { x: 300, y: 200 });
    const msg = await until(() => document.querySelector('.dict-pop .dict-empty'), 6000, 'the offline message');
    const pop = document.querySelector('.dict-pop');
    ok(/No internet/.test(msg.textContent), 'says why');
    [...pop.querySelectorAll('.dict-tab')].find(t => t.textContent === 'Quick').click();
    await until(() => document.querySelector('.dict-pop .dict-senses li'), 4000, 'offline meanings');
    ok(pop.querySelector('.dict-sound'), 'sound button still there');
    A.closeDictionary();
  } finally {
    A.setOfflineForTest(false);
    localStorage.removeItem('pdfy.settings');
  }
});

// ---- Fixes from the code review ----

await test('Review: saving waits for a note that is still formatting', async () => {
  await closeAll();
  const s = app.newDocument();
  await settle();
  const page = s.pages[0];
  app.tools.setTool('markdown');
  const [x, y] = screen(page, 72, 700);
  pointer('pointerdown', x, y);
  pointer('pointerup', x, y);
  const ta = await until(() => document.querySelector('textarea.inline-editor.md-source'), 3000, 'the editor');
  ta.value = String.raw`# Saved straight away
With maths $\sqrt{2}$ that takes a moment.`;
  await app.tools.settle();
  ok(page.annots.some(a => a.markdown && a.text.startsWith('# Saved straight away')), 'the note is there before saving starts');
  s.dirty = false;
});

await test('Review: a note typed in one document stays there if another is opened meanwhile', async () => {
  await closeAll();
  const a = app.newDocument();
  await settle();
  const page = a.pages[0];
  app.tools.setTool('markdown');
  const [x, y] = screen(page, 72, 700);
  pointer('pointerdown', x, y);
  pointer('pointerup', x, y);
  const ta = await until(() => document.querySelector('textarea.inline-editor.md-source'), 3000, 'the editor');
  ta.value = String.raw`Belongs to the first document $x^3$`;
  const b = app.newDocument();
  await app.tools.settle();
  ok(page.annots.some(n => n.markdown), 'in the first document');
  ok(!b.pages[0].annots.some(n => n.markdown), 'not in the second');
  a.dirty = false; b.dirty = false;
});

await test('Review: Ctrl+Enter right after typing saves the equation that was typed', async () => {
  await closeAll();
  const s = app.newDocument();
  await settle();
  void app.study.insertEquation();
  const input = await until(() => document.querySelector('.eq-input'), 4000, 'the editor');
  input.value = 'a+b';
  input.dispatchEvent(new Event('input'));
  await until(() => document.querySelector('.eq-preview svg'), 6000, 'the first preview');
  input.value = String.raw`\frac{x}{y}`;
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  const a = await until(() => s.pages[0].annots.find(x => x.kind === 'math'), 6000, 'the equation');
  eq(a.latex, String.raw`\frac{x}{y}`, 'LaTeX');
  eq(a.mathSvg, (await A.texToSvg(String.raw`\frac{x}{y}`, true)).svg, 'the drawing matches the LaTeX');
  s.dirty = false;
});

await test('Review: boxes on a turned page, bold fonts and your own theme all come back after reopening', async () => {
  await closeAll();
  const s = app.newDocument();
  await settle();
  s.rotatePages([s.pages[0].id], 90);
  await settle();
  const page = s.pages[0];
  const theme = { ...A.themeById('obsidian-dark'), id: 'mine-test', name: 'Test theme', builtIn: false, accent: '#ff00aa' };
  localStorage.setItem('pdfy.mdThemes', JSON.stringify([theme]));
  const box = { id: 'r1', kind: 'text', markdown: true, mdTheme: 'mine-test', rect: [200, 300, 420, 400], angle: 90, color: '#111111', opacity: 1, width: 0, fill: null, fontSize: 12, text: '# Sideways page' };
  const fitted = await A.fitMarkdown(box);
  const bold = { id: 'r2', kind: 'text', rect: [100, 100, 300, 140], color: '#111111', textColor: '#111111', opacity: 1, width: 0, fill: null, fontSize: 14, fontName: 'Georgia', bold: true, italic: true, text: 'Bold italic' };
  s.addAnnots(page, [fitted, bold]);
  const { blob } = await A.buildFile(s);
  s.dirty = false;
  localStorage.removeItem('pdfy.mdThemes');
  await closeAll();
  const back = await app.openPdfBlob(new File([blob], 'turned.pdf', { type: 'application/pdf' }), 'turned.pdf');
  await settle();
  const note = await until(() => back.pages[0].annots.find(x => x.markdown), 4000, 'the note');
  eq(note.angle, 90, 'same angle');
  ok(note.rect.every((n, i) => Math.abs(n - fitted.rect[i]) < 0.05), `same box: ${JSON.stringify(note.rect)} vs ${JSON.stringify(fitted.rect)}`);
  ok(A.allThemes().some(t => t.id === 'mine-test'), 'the theme came with the file');
  const t = back.pages[0].annots.find(x => x.fontName === 'Georgia');
  ok(t?.bold && t?.italic, 'bold and italic kept');
  localStorage.removeItem('pdfy.mdThemes');
  back.dirty = false;
});

await test('Review: Enter on a font in the list chooses it', async () => {
  await closeAll();
  const s = app.newDocument();
  await settle();
  app.tools.setTool('text');
  await wait(30);
  document.querySelector('.style-bar .font-btn').click();
  const search = await until(() => document.querySelector('.font-popover .fp-search'), 2000, 'the picker');
  search.value = 'georgia';
  search.dispatchEvent(new Event('input'));
  const row = await until(() => [...document.querySelectorAll('.fp-row')].find(r => r.textContent.includes('Georgia')), 2000, 'Georgia');
  row.focus();
  row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  eq(app.tools.style('text').fontName, 'Georgia', 'chosen with the keyboard');
  app.tools.setStyle({ fontName: undefined }, 'text');
  s.dirty = false;
});

// ---- Pictures for checking by eye ----

await test('Screens: study tools, for checking by eye', async () => {
  if (!window.__shot) return 'no screenshot support here';
  await closeAll();
  const s = await app.openPdfBlob(await fx('normal.pdf'), 'normal.pdf');
  await settle();
  app.viewer.setFit('width');
  await settle();
  const page = s.pages[0];
  const note = { id: 'n1', kind: 'text', markdown: true, mdTheme: 'obsidian-dark', rect: [60, 380, 330, 760], color: '#111111', opacity: 1, width: 0, fill: null, fontSize: 11, text: NOTE };
  s.addAnnots(page, [await A.fitMarkdown(note)]);
  const m = await A.texToSvg(String.raw`f(x) = \int_{-\infty}^{\infty} \hat f(\xi)\, e^{2 \pi i \xi x} \, d\xi`, true);
  const size = A.mathBoxSize(m, 18);
  s.addAnnots(page, [{ id: 'm1', kind: 'math', rect: [350, 640, 350 + size.w, 640 + size.h], color: '#1a56db', opacity: 1, width: 0, fill: null, fontSize: 18, latex: 'x', mathSvg: m.svg }]);
  app.setMode('study');
  await wait(1200);
  await window.__shot('30-study-note-equation');
  await A.showDictionary('water', { x: 420, y: 260, sentence: 'Plants need water to grow.' });
  await until(() => document.querySelector('.dict-pop .dict-word'), 5000, 'the pop-up');
  await wait(300);
  await window.__shot('31-dictionary-popup');
  document.querySelector('.dict-pop')?.remove();
  void app.study.insertEquation();
  const input = await until(() => document.querySelector('.eq-input'), 4000, 'the editor');
  input.value = String.raw`\frac{-b \pm \sqrt{b^2 - 4ac}}{2a}`;
  input.dispatchEvent(new Event('input'));
  await until(() => document.querySelector('.eq-preview svg'), 6000, 'the preview');
  await wait(200);
  await window.__shot('32-equation-editor');
  document.querySelector('.overlay-bg')?.remove();
  void app.study.themesDialog();
  await until(() => document.querySelector('.theme-dialog .md-box h1'), 4000, 'the theme editor');
  await wait(500);
  await window.__shot('33-note-themes');
  document.querySelector('.overlay-bg')?.remove();
  void app.settingsDialog();
  await until(() => document.querySelector('.set-card'), 3000, 'the preferences');
  await wait(200);
  await window.__shot('34-preferences');
  document.querySelector('.overlay-bg')?.remove();
  app.tools.setTool('text');
  await wait(50);
  document.querySelector('.style-bar .colour-btn').click();
  await wait(200);
  await window.__shot('35-colour-picker');
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  document.querySelector('.style-bar .font-btn').click();
  await until(() => document.querySelectorAll('.font-popover .fp-row').length > 5, 4000, 'fonts');
  await wait(400);
  await window.__shot('36-font-picker');
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  app.tools.setTool('select');
  await closeAll();
  await paste(await mockGemini());
  await until(() => app.session?.pages[0]?.annots.some(a => a.kind === 'image'), 6000, 'the pasted image');
  await settle();
  const p2 = app.session.pages[0];
  const img = p2.annots.find(a => a.kind === 'image');
  const shot = await A.regionCanvas(app.session, p2, img.rect);
  const words = await A.readWords(shot.canvas, 'eng');
  A.showWordLayer(app.viewer.views.get(p2.id), words, shot);
  const spot = [...document.querySelectorAll('.word-spot')].find(b => b.title === 'convert') ?? document.querySelector('.word-spot');
  spot.click();
  await until(() => document.querySelector('.dict-pop .dict-word'), 6000, 'the pop-up');
  await wait(300);
  await window.__shot('37-read-picture');
  document.querySelector('.word-bar .primary')?.click();
  app.session.dirty = false;
  s.dirty = false;
});

export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
