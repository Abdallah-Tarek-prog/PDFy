// Reproduce a broken IndexedDB manifest in an isolated native profile; never touch the user's app.
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, 'tests', 'output');
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(join(output, 'storage-host-'));
const sample = join(profile, 'native-save.pdf');
copyFileSync(join(root, 'tests', 'fixtures', 'normal.pdf'), sample);
const database = join(profile, 'engine', 'EBWebView', 'Default', 'IndexedDB', 'https_pdfy.local_0.indexeddb.leveldb');
mkdirSync(database, { recursive: true });
writeFileSync(join(database, 'CURRENT'), 'MANIFEST-000001\n');
writeFileSync(join(database, 'LOG'), '');
writeFileSync(join(database, 'LOG.old'), '');
const port = 9338;
const wait = ms => new Promise(r => setTimeout(r, ms));
const launched = spawnSync('powershell', ['-NoProfile', '-Command',
  'Start-Process -FilePath $env:PDFY_STORAGE_EXE -ArgumentList (\'"\' + $env:PDFY_STORAGE_SAMPLE + \'"\') -WindowStyle Hidden -PassThru | Select-Object -ExpandProperty Id',
], { encoding: 'utf8', windowsHide: true, env: { ...process.env,
  PDFY_STORAGE_EXE: process.env.PDFY_STORAGE_EXE ?? join(root, 'app', 'PDFy.exe'), PDFY_STORAGE_SAMPLE: sample, PDFY_DEV: '1', PDFY_DEBUG_PORT: String(port), PDFY_TEST_DATA_DIR: profile } });
if (launched.status !== 0) throw new Error(launched.stderr || 'Could not launch the isolated app');
const pid = Number(launched.stdout.trim());
if (!Number.isInteger(pid) || pid <= 0) throw new Error('The test app did not return a PID');
let ws;
try {
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page' && t.url.includes('pdfy.local')); } catch {}
    if (!target) await wait(150);
  }
  if (!target) throw new Error('The isolated native app did not start');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let next = 0; const pending = new Map();
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 15000);
    pending.set(id, response => { clearTimeout(timeout); response.error ? reject(new Error(response.error.message)) : resolve(response.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  };
  async function ready() {
    for (let i = 0; i < 100; i++) {
      if (await evaluate('!!window.__api?.createCollection').catch(() => false)) return;
      await wait(100);
    }
    throw new Error('The isolated app did not become ready');
  }
  await ready();
  const before = await evaluate(`(async () => {
    try { await __api.createCollection('Before repair'); return {saved:true}; }
    catch (e) { return {saved:false,error:e.message}; }
  })()`);
  console.log('Broken manifest:', JSON.stringify(before));
  assert.equal(before.saved, false, 'the corrupt manifest must reproduce the reported failure');
  const repair = (data = profile) => spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'repair-storage.ps1'), '-DataDir', data], { encoding: 'utf8', windowsHide: true });
  const repaired = repair();
  assert.equal(repaired.status, 0, repaired.stderr);
  const backups = readdirSync(join(profile, 'storage-backups'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(profile, 'storage-backups', backups[0], 'CURRENT'), 'utf8'), 'MANIFEST-000001\n');
  const after = await evaluate(`(async () => {
    const collection = await __api.createCollection('After repair');
    const history = await __api.addClosed('storage-test.pdf', null, 2, 5);
    return {collection:collection.name,history,collections:(await __api.listCollections()).length,closed:(await __api.listClosed()).length};
  })()`);
  console.log('After repair:', JSON.stringify(after));
  assert.equal(after.history, true);
  assert.equal(after.collections, 1);
  assert.equal(after.closed, 1);
  for (let i = 0; i < 100 && !await evaluate('!!__pdfy.session?.handle'); i++) await wait(100);
  const nativeSave = await evaluate(`(async () => {
    const s = __pdfy.session, p = s.pages[0];
    s.addAnnots(p, [{id:'native-undo',kind:'text',rect:[30,300,250,350],text:'Native undo',color:'#111111',textColor:'#111111',fontSize:12,width:0,opacity:1}]);
    __pdfy.viewer.select(p.id,'native-undo');
    await __pdfy.applyStyle({color:'#d92d20',fontName:'Arial',fontSize:24,bold:true});
    const saved = await __pdfy.save(), undo = s.canUndo;
    s.undo(); s.undo();
    const savedUndo = await __pdfy.save();
    const reopened = await __api.openPdf(await s.handle.getFile());
    try {
      const annots = await (await reopened.pdf.getPage(1)).getAnnotations();
      return {saved,undo,savedUndo,redo:s.canRedo,removed:!annots.some(a=>a.contentsObj?.str==='Native undo'),snapshot:![...s.sources.values()].some(s=>s.blob instanceof File)};
    } finally { await reopened.close(); }
  })()`);
  assert.deepEqual(nativeSave, {saved:true,undo:true,savedUndo:true,redo:true,removed:true,snapshot:true});
  console.log('ok Native Windows file overwrite preserves undo/redo and original source bytes across repeated saves');
  await send('Page.reload'); await ready();
  const persisted = await evaluate('(async () => ({collections:(await __api.listCollections()).length,closed:(await __api.listClosed()).length}))()');
  assert.deepEqual(persisted, { collections: 1, closed: 1 });
  const defaults = await evaluate('(() => { const s=__pdfy.tools.style("text");return {color:s.color,font:s.fontName,size:s.fontSize,bold:s.bold}; })()');
  assert.deepEqual(defaults, {color:'#d92d20',font:'Arial',size:24,bold:true});
  console.log('ok Selected text defaults persist across a native WebView2 reload');
  const healthy = repair();
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.equal(readdirSync(join(profile, 'storage-backups')).length, 1, 'a healthy database must not be moved');
  const protectedData = join(profile, 'protected-data');
  const protectedDb = join(protectedData, 'engine', 'EBWebView', 'Default', 'IndexedDB', 'https_pdfy.local_0.indexeddb.leveldb');
  mkdirSync(protectedDb, { recursive: true }); writeFileSync(join(protectedDb, 'CURRENT'), 'MANIFEST-000001\n');
  writeFileSync(join(protectedDb, '000003.ldb'), 'Keep this data');
  assert.notEqual(repair(protectedData).status, 0, 'a database with data files must require separate recovery');
  assert.equal(readFileSync(join(protectedDb, '000003.ldb'), 'utf8'), 'Keep this data');
  const blobData = join(profile, 'blob-data');
  const blobDb = join(blobData, 'engine', 'EBWebView', 'Default', 'IndexedDB', 'https_pdfy.local_0.indexeddb.leveldb');
  mkdirSync(blobDb, { recursive: true }); writeFileSync(join(blobDb, 'CURRENT'), 'MANIFEST-000001\n');
  const blobFolder = blobDb.replace(/\.leveldb$/, '.blob'); mkdirSync(blobFolder); writeFileSync(join(blobFolder, 'asset'), 'Keep this asset');
  assert.notEqual(repair(blobData).status, 0, 'a database with stored assets must require separate recovery');
  assert.equal(readFileSync(join(blobFolder, 'asset'), 'utf8'), 'Keep this asset');
  console.log('ok Storage repair leaves healthy databases, data files, and stored blob assets intact');
  console.log('ok Collections and recently closed files survive reload after a non-destructive storage repair');
} finally {
  ws?.close();
  spawnSync('powershell', ['-NoProfile', '-Command', 'Stop-Process -Id $env:PDFY_STORAGE_PID -ErrorAction SilentlyContinue'],
    { windowsHide: true, stdio: 'ignore', env: { ...process.env, PDFY_STORAGE_PID: String(pid) } });
}
