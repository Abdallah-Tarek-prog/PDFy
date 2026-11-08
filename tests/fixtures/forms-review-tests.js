// Regression checks for choices after Undo, redrawing, and saving across pages.
const app = window.__pdfy, A = window.__api;
const results = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const ok = (value, message) => { if (!value) throw new Error(message); };
const eq = (actual, expected, message) => { if (actual !== expected) throw new Error(`${message}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); };
const closeAll = async () => { for (const session of [...app.sessions]) { session.dirty = false; await app.closeSession(session); } };
async function until(fn, message) {
  for (let i = 0; i < 120; i++) { const value = fn(); if (value) return value; await wait(50); }
  throw new Error(`Timed out: ${message}`);
}
async function openFixture(name) {
  await closeAll();
  const response = await fetch(`/fixtures/${name}`);
  await app.openFile(new File([await response.blob()], name, { type: 'application/pdf' }));
  app.setMode('view');
  app.tools.setTool('hand');
  await until(() => app.viewer.views.size, 'document views');
  await wait(150);
  return app.session;
}
async function test(name, run) {
  console.log('TEST', name);
  try { await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: String(error?.message ?? error) }); }
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), results }) });
}
function radio(id, name, option, selected = false) {
  return { id, kind: 'rect', rect: [72, 500, 90, 518], color: '#0b57d0', opacity: 1, width: 1, field: { type: 'radio', name, options: [option], value: selected } };
}

await test('Forms review: Undo clears a focused first radio answer', async () => {
  const session = await openFixture('normal.pdf');
  const page = session.pages[0];
  session.addAnnots(page, [radio('focused-choice', 'question', 'First')]);
  const choice = await until(() => document.querySelector('.own-field-ctl[type=radio]'), 'own radio');
  choice.focus();
  choice.checked = true;
  choice.dispatchEvent(new Event('change'));
  ok(choice.checked, 'the choice is selected');
  session.undo();
  eq(page.annots[0].field.value, false, 'Undo clears the stored answer');
  eq(choice.checked, false, 'Undo clears the focused control');
});

await test('Forms review: reopened radio state survives zoom and saves the new choice', async () => {
  const session = await openFixture('form.pdf');
  const choices = await until(() => { const inputs = [...document.querySelectorAll('.widgets input[type=radio]')]; return inputs.length === 2 && inputs; }, 'native radio controls');
  choices[0].checked = true;
  choices[0].dispatchEvent(new Event('change'));
  app.viewer.setScale(app.viewer.scale * 1.1);
  const first = await until(() => { const input = document.querySelector('.widgets input[type=radio]'); return input && input !== choices[0] && input; }, 'redrawn controls');
  ok(first.checked, 'the selected radio stays selected after zoom');
  const second = [...document.querySelectorAll('.widgets input[type=radio]')][1];
  second.checked = true;
  second.dispatchEvent(new Event('change'));
  const source = [...session.sources.values()][0];
  const annotations = (await (await source.pdf.getPage(1)).getAnnotations()).filter(a => a.radioButton);
  eq(source.pdf.annotationStorage.getValue(annotations[0].id, {}).value, false, 'the earlier option is cleared in storage');
  const built = await A.buildFile(session);
  const reopened = await A.openPdf(built.blob);
  try {
    const saved = (await (await reopened.pdf.getPage(1)).getAnnotations()).filter(a => a.radioButton);
    ok(saved.every(a => a.fieldValue === saved[1].buttonValue), 'the saved question has the second answer');
  } finally { await reopened.close(); }
});

await test('Forms review: answering on another page clears the offscreen choice', async () => {
  const original = await openFixture('normal.pdf');
  original.addAnnots(original.pages[0], [radio('page-one-radio', 'across-pages', 'First', true)]);
  original.addAnnots(original.pages[7], [radio('page-eight-radio', 'across-pages', 'Second')]);
  const created = (await A.buildFile(original)).blob;
  await closeAll();
  await app.openPdfBlob(created, 'Across pages.pdf');
  const session = app.session;
  app.setMode('view');
  app.viewer.goTo(7);
  const pageId = session.pages[7].id;
  const second = await until(() => app.viewer.views.get(pageId)?.widgets.querySelector('input[type=radio]'), 'second page radio');
  second.checked = true;
  second.dispatchEvent(new Event('change'));
  const source = [...session.sources.values()][0];
  const first = (await (await source.pdf.getPage(1)).getAnnotations()).find(a => a.radioButton);
  eq(source.pdf.annotationStorage.getValue(first.id, {}).value, false, 'the unmounted choice is cleared in storage');
  const built = await A.buildFile(session);
  const reopened = await A.openPdf(built.blob);
  try {
    const firstSaved = (await (await reopened.pdf.getPage(1)).getAnnotations()).find(a => a.radioButton);
    const secondSaved = (await (await reopened.pdf.getPage(8)).getAnnotations()).find(a => a.radioButton);
    eq(firstSaved.fieldValue, 'Second', 'the first page knows the second answer');
    eq(secondSaved.fieldValue, 'Second', 'the second page keeps its answer');
  } finally { await reopened.close(); }
});

await test('Forms review: blank dropdowns stay blank and saved lists keep multiple selection', async () => {
  const original = await openFixture('normal.pdf');
  const base = { kind: 'rect', rect: [72, 400, 260, 470], color: '#0b57d0', opacity: 1, width: 1 };
  original.addAnnots(original.pages[0], [
    { ...base, id: 'multi-list', field: { type: 'list', name: 'subjects', options: ['Math', 'Physics', 'Computers'], value: ['Math'] } },
    { ...base, id: 'blank-dropdown', rect: [72, 350, 260, 375], field: { type: 'dropdown', name: 'year', options: ['First', 'Second'] } },
  ]);
  const created = (await A.buildFile(original)).blob;
  await closeAll();
  await app.openPdfBlob(created, 'Choices.pdf');
  app.setMode('view');
  const controls = await until(() => { const inputs = [...document.querySelectorAll('.widgets select')]; return inputs.length === 2 && inputs; }, 'choice controls');
  const list = controls.find(input => input.multiple);
  ok(list, 'a list saved with one answer remains multiselect');
  eq([...list.selectedOptions].map(option => option.value).join(','), 'Math', 'the original list answer stays selected');
  const dropdown = controls.find(input => !input.multiple);
  eq(dropdown.value, '', 'an unanswered dropdown shows no answer');
});

await closeAll();
export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
