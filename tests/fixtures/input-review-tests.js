// Regressions for pen ownership and the transition from pinching back to panning.
const app = window.__pdfy;
const results = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (value, message) => { if (!value) throw new Error(message); };
const closeAll = async () => {
  app.tools.cancel();
  window.dispatchEvent(new Event('blur'));
  for (const session of [...app.sessions]) { session.dirty = false; await app.closeSession(session); }
};
async function openFixture() {
  await closeAll();
  const response = await fetch('/fixtures/normal.pdf');
  await app.openFile(new File([await response.blob()], 'normal.pdf', { type: 'application/pdf' }));
  app.viewer.setScale(2);
  for (let i = 0; i < 100; i++) {
    if (app.viewer.views.size && [...app.viewer.views.values()].every(v => !v.needsRender && !v.task)) break;
    await wait(40);
  }
  app.viewer.scroller.scrollTop = 300;
  await wait(60);
  return app.session.pages[0];
}
function point(page) {
  const box = app.viewer.views.get(page.id).el.getBoundingClientRect();
  const view = app.viewer.scroller.getBoundingClientRect();
  return {
    x: (Math.max(box.left, view.left) + Math.min(box.right, view.right)) / 2,
    y: (Math.max(box.top, view.top) + Math.min(box.bottom, view.bottom)) / 2,
  };
}
function pointer(type, id, kind, x, y, target, button = 0) {
  (target ?? window).dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: id, pointerType: kind,
    clientX: x, clientY: y, button, buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0,
  }));
}
async function test(name, run) {
  console.log('TEST', name);
  try { await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: String(error.message ?? error) }); }
  finally { app.tools.cancel(); window.dispatchEvent(new Event('blur')); }
  await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({
    done: results.length, passed: results.filter(r => r.ok).length,
    heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), results,
  }) });
}

await test('A second pointer cannot change or finish an active pen stroke', async () => {
  const page = await openFixture();
  app.setMode('edit'); app.tools.setTool('pen');
  const { x, y } = point(page);
  const target = document.elementFromPoint(x, y);
  pointer('pointerdown', 71, 'pen', x, y, target);
  pointer('pointermove', 71, 'pen', x + 20, y + 5);
  pointer('pointermove', 72, 'mouse', x + 240, y + 100);
  pointer('pointerup', 72, 'mouse', x + 240, y + 100);
  check(page.annots.filter(a => a.kind === 'ink').length === 0, 'the foreign pointer finished the stroke');
  pointer('pointermove', 71, 'pen', x + 40, y + 10);
  pointer('pointerup', 71, 'pen', x + 40, y + 10);
  const ink = page.annots.find(a => a.kind === 'ink');
  check(ink, 'the pen stroke was lost');
  const xs = ink.paths[0].filter((_, i) => i % 2 === 0);
  check(Math.max(...xs) - Math.min(...xs) < 30, 'the foreign pointer added a stray line');
  check(Math.max(...xs) - Math.min(...xs) > 15, 'the pen stopped before its own release');
});

await test('Cancelling another pointer leaves the pen working; cancelling the pen clears it', async () => {
  const page = await openFixture();
  app.setMode('edit'); app.tools.setTool('pen');
  const { x, y } = point(page);
  const target = document.elementFromPoint(x, y);
  pointer('pointerdown', 81, 'pen', x, y, target);
  pointer('pointermove', 81, 'pen', x + 20, y);
  pointer('pointercancel', 82, 'mouse', x, y);
  pointer('pointermove', 81, 'pen', x + 40, y);
  pointer('pointerup', 81, 'pen', x + 40, y);
  check(page.annots.filter(a => a.kind === 'ink').length === 1, 'another pointer cancelled the pen');
  pointer('pointerdown', 83, 'pen', x, y, target);
  pointer('pointermove', 83, 'pen', x + 40, y + 15);
  pointer('pointercancel', 83, 'pen', x + 40, y + 15);
  pointer('pointerup', 83, 'pen', x + 40, y + 15);
  check(page.annots.filter(a => a.kind === 'ink').length === 1, 'a cancelled stroke was committed');
});

await test('A finger continues panning after a pinch without jumping', async () => {
  const page = await openFixture();
  app.setMode('view'); app.tools.setTool('select');
  const { x, y } = point(page), sc = app.viewer.scroller;
  pointer('pointerdown', 91, 'touch', x - 40, y, sc);
  pointer('pointermove', 91, 'touch', x - 40, y - 20);
  pointer('pointerdown', 92, 'touch', x + 40, y - 20, sc);
  pointer('pointermove', 91, 'touch', x - 40, y - 100);
  pointer('pointermove', 92, 'touch', x + 40, y - 100);
  pointer('pointerup', 92, 'touch', x + 40, y - 100);
  const before = sc.scrollTop;
  pointer('pointermove', 91, 'touch', x - 40, y - 110);
  check(Math.abs(sc.scrollTop - before - 10) < 3, `the page jumped by ${sc.scrollTop - before}px`);
  pointer('pointercancel', 91, 'touch', x - 40, y - 110);
  const stopped = sc.scrollTop;
  await wait(80);
  check(Math.abs(sc.scrollTop - stopped) < 2, 'a cancelled touch started inertia');
});

await test('Losing focus ends panning so the next drag starts normally', async () => {
  const page = await openFixture();
  app.setMode('view'); app.tools.setTool('select');
  const { x, y } = point(page), sc = app.viewer.scroller;
  pointer('pointerdown', 101, 'mouse', x, y, sc, 1);
  pointer('pointermove', 101, 'mouse', x, y - 30);
  window.dispatchEvent(new Event('blur'));
  const before = sc.scrollTop;
  pointer('pointermove', 101, 'mouse', x, y - 100);
  check(sc.scrollTop === before, 'the stale drag continued after the window lost focus');
  check(!sc.classList.contains('panning'), 'the panning cursor stayed active');
  pointer('pointerdown', 102, 'mouse', x, y, sc, 1);
  pointer('pointermove', 102, 'mouse', x, y - 20);
  pointer('pointerup', 102, 'mouse', x, y - 20, window, 1);
  check(Math.abs(sc.scrollTop - before - 20) < 3, 'the next drag did not work');
});

await test('Read picture reports clipboard failure without claiming the words were copied', async () => {
  const page = await openFixture();
  const view = app.viewer.views.get(page.id);
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  document.querySelectorAll('.toast').forEach(t => t.remove());
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async () => { throw new DOMException('Clipboard access denied', 'NotAllowedError'); },
    } });
    window.__api.showWordLayer(view, [{ text: 'Readable', x0: 10, y0: 10, x1: 100, y1: 30, line: 1 }], { left: 0, top: 0, scale: 1 });
    document.querySelector('.word-bar .btn').click();
    await wait(80);
    check([...document.querySelectorAll('.toast.error')].some(t => t.textContent.includes('could not be copied')), 'clipboard denial was not explained');
    check(![...document.querySelectorAll('.toast.ok')].some(t => t.textContent.includes('were copied')), 'the interface claimed success');
  } finally {
    document.querySelector('.word-bar .primary')?.click();
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else delete navigator.clipboard;
  }
});

await test('Voice recording releases the microphone when audio setup fails', async () => {
  const originalGetUserMedia = navigator.mediaDevices.getUserMedia;
  const OriginalAudioContext = window.AudioContext;
  let stopped = false;
  try {
    navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop: () => { stopped = true; } }] });
    window.AudioContext = class { constructor() { throw new Error('Audio device unavailable'); } };
    await app.voiceNoteCmd();
    check(stopped, 'the microphone remained active after recording failed to start');
    check(!document.querySelector('.rec-box'), 'a recording dialog stayed open');
  } finally {
    navigator.mediaDevices.getUserMedia = originalGetUserMedia;
    window.AudioContext = OriginalAudioContext;
  }
});

await closeAll();
export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
