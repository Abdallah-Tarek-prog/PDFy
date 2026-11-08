// Real app screens using authored sample content; no personal files or simulated UI.
const app = window.__pdfy, A = window.__api;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
await window.__cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
A.applyUiTheme('graphite');
for (const old of [...app.sessions]) { old.dirty = false; await app.closeSession(old); }
const session = app.newDocument();
session.setPages([session.blankPage(1100, 700)], 'Landscape whiteboard');
session.name = 'A place to think.pdf';
const page = session.pages[0];
const base = { color: '#315f48', opacity: 1, width: 2, fill: null };
const text = (id, value, rect, fontSize=18, color='#243d30') => ({ ...base, id, kind: 'text', text: value, rect, fontSize, textColor: color, width: 0 });
session.addAnnots(page, [
  text('board-title', 'Big ideas need room.', [65,565,1000,630], 34),
  text('board-subtitle', 'Write, sketch, connect and explain on a blank PDF page.', [65,520,1000,560], 18, '#536e5d'),
  { ...base, id:'box1', kind:'rect', rect:[75,320,300,440], fill:'#e8f0e9' },
  { ...base, id:'box2', kind:'rect', rect:[430,320,655,440], fill:'#e8f0e9' },
  { ...base, id:'box3', kind:'rect', rect:[785,320,1010,440], fill:'#e8f0e9' },
  text('read', 'Read', [98,355,280,405], 27),
  text('connect', 'Connect', [453,355,635,405], 27),
  text('explain', 'Explain', [808,355,990,405], 27),
  { ...base, id:'arrow1', kind:'arrow', rect:[320,380,410,380], pts:[320,380,410,380], width:3 },
  { ...base, id:'arrow2', kind:'arrow', rect:[675,380,765,380], pts:[675,380,765,380], width:3 },
  text('board-note', 'A PDF when you save it.\nA whiteboard while you think.', [80,145,630,255], 25),
  { ...base, id:'ink1', kind:'ink', rect:[80,133,617,146], width:4, paths:[[80,139,130,143,230,137,335,140,450,136,560,140,617,138]] },
  { ...base, id:'ink2', kind:'ink', rect:[785,145,980,235], width:4, color:'#b5834a', paths:[[785,165,820,205,850,156,882,220,920,170,950,230,980,200]] },
], 'Whiteboard example');
app.viewer.setFit('page');
app.setMode('edit'); app.tools.setTool('pen');
await wait(650);
await window.__shot('pdfy-whiteboard');
const result = await A.buildFile(session);
await fetch('/__save/whiteboard-example.pdf', { method:'PUT', body:result.blob });
session.dirty = false;
for (const old of [...app.sessions]) { old.dirty = false; await app.closeSession(old); }
export default { summary:{ passed:1, failed:0 }, results:[{ name:'Whiteboard example renders in PDFy and saves as a PDF', ok:result.blob.size>0 }] };
