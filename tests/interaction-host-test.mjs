// Exercises native WebView2 touchpad gestures and persistent recently-closed file handles.
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, 'tests', 'output');
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(join(output, 'input-host-'));
const sampleFolder = join(profile, 'folder with spaces \u0643\u062a\u0627\u0628');
mkdirSync(sampleFolder);
const sample = join(sampleFolder, 'native-history.pdf');
copyFileSync(join(root, 'tests', 'fixtures', 'normal.pdf'), sample);
const ungranted = join(profile, 'not-opened-in-pdfy.pdf');
copyFileSync(join(root, 'tests', 'fixtures', 'normal.pdf'), ungranted);
const port = 9339;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const exe = resolve(process.env.PDFY_INPUT_EXE ?? join(root, 'app', 'PDFy.exe'));
const launched = spawnSync('powershell', ['-NoProfile', '-Command',
  'Start-Process -FilePath $env:PDFY_INPUT_EXE -ArgumentList (\'"\' + $env:PDFY_INPUT_SAMPLE + \'"\') -WindowStyle Hidden -PassThru | Select-Object -ExpandProperty Id',
], { encoding: 'utf8', windowsHide: true, env: { ...process.env, PDFY_INPUT_EXE: exe,
  PDFY_INPUT_SAMPLE: sample, PDFY_DEV: '1', PDFY_DEBUG_PORT: String(port), PDFY_TEST_DATA_DIR: profile } });
if (launched.status !== 0) throw new Error(launched.stderr || 'Could not launch the test app');
let pid = Number(launched.stdout.trim());
if (!Number.isInteger(pid) || pid <= 0) throw new Error('The test app did not return its process ID');
let ws;
try {
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page' && t.url.includes('pdfy.local')); } catch { /* Starting. */ }
    if (!target) await wait(200);
  }
  if (!target) throw new Error('Native app did not expose its test page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let next = 0;
  const pending = new Map();
  const onMessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
  };
  ws.onmessage = onMessage;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 15000);
    pending.set(id, message => { clearTimeout(timer); message.error ? reject(new Error(message.error.message)) : resolve(message.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  };
  await send('Runtime.enable');
  for (let i = 0; i < 100; i++) {
    if (await evaluate('!!window.__pdfy?.session && __pdfy.viewer.views.size > 0').catch(() => false)) break;
    await wait(150);
  }
  assert.equal(await evaluate('__pdfy.session?.name'), 'native-history.pdf');
  assert.equal(await evaluate('!!__pdfy.session?.handle'), true);
  await evaluate(`window.__locationReplies = new Map(); chrome.webview.addEventListener('message', e => {
    if(['file-location','file-access'].includes(e.data?.type)) __locationReplies.set(e.data.id, { data:e.data, handle:e.additionalObjects?.[0] });
  }); window.__originalSession = __pdfy.session;`);
  const copied = await evaluate(`(async()=>{
    const write = navigator.clipboard.writeText;
    navigator.clipboard.writeText = async text => { window.__copiedFilePath = text; };
    try { await __pdfy.copyFilePath(__pdfy.session); return window.__copiedFilePath; }
    finally { navigator.clipboard.writeText = write; }
  })()`);
  assert.equal(copied, sample, 'Copy file path did not resolve the actual Open with location');
  console.log('ok Copy file path sends the absolute path with spaces and Unicode to the clipboard API');
  async function location(of, id) {
    await evaluate(`chrome.webview.postMessageWithAdditionalObjects({type:'file-location',id:${id},want:'handle'}, [${of}]);`);
    for(let i=0;i<100 && !await evaluate(`__locationReplies.has(${id})`);i++) await wait(50);
    return evaluate(`__locationReplies.get(${id})?.data`);
  }
  await evaluate(`window.__fileInput = document.createElement('input'); __fileInput.type='file'; __fileInput.id='native-location-input'; __fileInput.hidden=true; document.body.append(__fileInput);`);
  const document = await send('DOM.getDocument');
  const input = await send('DOM.querySelector',{nodeId:document.root.nodeId,selector:'#native-location-input'});
  await send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[sample]});
  await evaluate('window.__nativeFile = __fileInput.files[0]');
  const handleLocation = await location('__nativeFile', 9001);
  assert.equal(handleLocation.ok, true, JSON.stringify(handleLocation));
  assert.equal(handleLocation.path, sample);
  assert.equal(await evaluate('__locationReplies.get(9001).handle.isSameEntry(__pdfy.session.handle)'), true);
  const fileLocation = await location('__nativeFile', 9002);
  assert.equal(fileLocation.ok, true, JSON.stringify(fileLocation));
  assert.equal(fileLocation.path, sample);
  console.log('ok Native file paths preserve spaces and Unicode for real dropped/pasted File objects');
  await evaluate(`chrome.webview.postMessage({type:'file-location',id:9003,want:'handle',path:${JSON.stringify(sample)}})`);
  for(let i=0;i<100 && !await evaluate('__locationReplies.has(9003)');i++) await wait(50);
  assert.equal(await evaluate('__locationReplies.get(9003)?.data.error'), 'unsupported');
  console.log('ok Native location requests require a real transferred file; arbitrary path strings are rejected');
  await evaluate(`chrome.webview.postMessage({type:'file-access',id:9004,path:${JSON.stringify(ungranted)}})`);
  for(let i=0;i<100&&!await evaluate('__locationReplies.has(9004)');i++)await wait(50);
  assert.equal(await evaluate('__locationReplies.get(9004)?.data.error'),'unsupported');
  assert.equal(await evaluate('!!__locationReplies.get(9004)?.handle'),false);
  console.log('ok Native access renewal rejects a file that was never opened through PDFy');
  const dropped = await evaluate(`(async()=>{
    await __pdfy.openPdfBlob(__nativeFile,'native-history.pdf'); const old=__pdfy.session;
    await __pdfy.reloadFromDisk(old);
    const result={replaced:__pdfy.session!==old,handle:!!__pdfy.session.handle,reloadHandle:!!__pdfy.session.reloadHandle,pages:__pdfy.session.pages.length};
    await __pdfy.closeSession(__pdfy.session); await __api.clearClosed(); return result;
  })()`);
  assert.equal(dropped.replaced,true); assert.equal(dropped.handle,false); assert.equal(dropped.reloadHandle,true); assert.ok(dropped.pages>1);
  console.log('ok A disk PDF without a persistent handle reloads through its original File location');
  await evaluate('(async()=>{__pdfy.viewer.goTo(3); __pdfy.viewer.setScale(1.3); await __pdfy.session.preserveSources()})()');
  copyFileSync(join(root, 'tests', 'fixtures', 'form.pdf'), sample);
  const reloaded = await evaluate(`(async () => {
    await __pdfy.reloadFromDisk(__originalSession);
    return {pages:__pdfy.session.pages.length,count:__pdfy.sessions.length,page:__pdfy.viewer.current,scale:__pdfy.viewer.scale,replaced:__pdfy.session!==__originalSession,history:(await __api.listClosed()).length};
  })()`);
  assert.deepEqual(reloaded,{pages:1,count:1,page:0,scale:1.3,replaced:true,history:0});
  await evaluate('__pdfy.session.preserveSources()');
  copyFileSync(join(root, 'tests', 'fixtures', 'normal.pdf'), sample);
  await evaluate('__pdfy.reloadFromDisk(__pdfy.session)');
  console.log('ok Native reload reads external file changes in the existing tab, preserves zoom, clamps the page, and leaves history untouched');
  await evaluate(`window.__nativeWheelLog = []; window.addEventListener('wheel', e => __nativeWheelLog.push({ ctrl: e.ctrlKey, y: e.deltaY }), { capture: true, passive: true }); __pdfy.viewer.setScale(1);`);
  const point = await evaluate(`(() => { const r = __pdfy.viewer.scroller.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const before = await evaluate('({pdf: __pdfy.viewer.scale, viewport: visualViewport.scale, width: innerWidth})');
  await send('Input.synthesizePinchGesture', { ...point, scaleFactor: 1.4, relativeSpeed: 400, gestureSourceType: 'mouse' });
  await wait(300);
  const after = await evaluate('({pdf: __pdfy.viewer.scale, viewport: visualViewport.scale, width: innerWidth, wheels: __nativeWheelLog})');
  assert.ok(after.pdf > 1.38 && after.pdf < 1.42, `Native pinch did not zoom the PDF: ${after.pdf}`);
  assert.ok(after.wheels.length > 1, 'Native pinch never reached the page');
  assert.equal(after.viewport, 1, 'Pinch magnified the whole browser viewport');
  assert.equal(after.width, before.width, 'Pinch resized the application chrome');
  await send('Input.synthesizePinchGesture', { ...point, scaleFactor: 0.7, relativeSpeed: 400, gestureSourceType: 'mouse' });
  await wait(300);
  const zoomedOut = await evaluate('({pdf: __pdfy.viewer.scale, viewport: visualViewport.scale, width: innerWidth})');
  assert.ok(zoomedOut.pdf > 0.96 && zoomedOut.pdf < 1, `Native pinch did not zoom back out: ${zoomedOut.pdf}`);
  assert.equal(zoomedOut.viewport, 1);
  console.log(`ok Native touchpad pinch changes PDF scale: 100% → ${Math.round(after.pdf * 100)}% → ${Math.round(zoomedOut.pdf * 100)}%; application scale stays 100%`);
  const toolbarPoint = await evaluate(`(() => { const r = document.querySelector('.toolbar').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  await send('Input.synthesizePinchGesture', { ...toolbarPoint, scaleFactor: 1.3, relativeSpeed: 400, gestureSourceType: 'mouse' });
  assert.equal(await evaluate('visualViewport.scale'), 1, 'Pinching the toolbar magnified the app');
  assert.equal(await evaluate('__pdfy.viewer.scale'), zoomedOut.pdf, 'Pinching the toolbar changed document zoom');
  await evaluate('__pdfy.viewer.goTo(3)');
  const closePoint = await evaluate(`(() => { const r = document.querySelector('.doc-tab button').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...closePoint, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...closePoint, button: 'left', buttons: 0, clickCount: 1 });
  for (let i = 0; i < 100 && await evaluate('!!__pdfy.session'); i++) await wait(50);
  const closed = await evaluate('(async () => (await __api.listClosed()).map(c => ({name:c.name,page:c.page,handle:!!c.handle})))()');
  assert.ok(closed.some(c => c.name === 'native-history.pdf' && c.page === 3 && c.handle), 'Closing the native file did not commit its history entry');
  await send('Page.reload');
  for (let i = 0; i < 100; i++) {
    if (await evaluate('!!window.__pdfy && !!window.__api').catch(() => false)) break;
    await wait(100);
  }
  const persisted = await evaluate('(async () => (await __api.listClosed()).map(c => ({name:c.name,page:c.page,handle:!!c.handle})))()');
  assert.deepEqual(persisted, closed, 'Native file history changed or disappeared after a page reload');
  console.log('ok Native tab close records the file handle and page; its history survives reload');
  const copiedAfterReload=await evaluate(`(async()=>{
    const entry=(await __api.listClosed()).find(f=>f.name==='native-history.pdf');
    await __pdfy.reopenClosedFile(entry);const write=navigator.clipboard.writeText;let path;
    navigator.clipboard.writeText=async value=>{path=value};
    try{await __pdfy.copyFilePath(__pdfy.session);return {path,page:__pdfy.viewer.current}}
    finally{navigator.clipboard.writeText=write}
  })()`);
  assert.deepEqual(copiedAfterReload,{path:sample,page:3});
  console.log('ok File locations persist and resolve cloned Recently closed handles after a full page reload');
  await evaluate('__pdfy.closeSession(__pdfy.session)');
  await send('Input.synthesizePinchGesture', { ...point, scaleFactor: 1.3, relativeSpeed: 400, gestureSourceType: 'mouse' });
  assert.equal(await evaluate('visualViewport.scale'), 1, 'Pinching Home magnified the app');
  console.log('ok Pinching the toolbar or Home does not magnify the application');
  ws.close();
  spawnSync('powershell',['-NoProfile','-Command','Stop-Process -Id $env:PDFY_INPUT_PID -ErrorAction SilentlyContinue'],{windowsHide:true,env:{...process.env,PDFY_INPUT_PID:String(pid)},stdio:'ignore'});
  const restarted=spawnSync('powershell',['-NoProfile','-Command','Start-Process -FilePath $env:PDFY_INPUT_EXE -WindowStyle Hidden -PassThru | Select-Object -ExpandProperty Id'],{encoding:'utf8',windowsHide:true,env:{...process.env,PDFY_INPUT_EXE:exe,PDFY_DEV:'1',PDFY_DEBUG_PORT:String(port),PDFY_TEST_DATA_DIR:profile}});
  assert.equal(restarted.status,0,restarted.stderr);pid=Number(restarted.stdout.trim());assert.ok(Number.isInteger(pid)&&pid>0);
  let restartedTarget;
  for(let i=0;i<100&&!restartedTarget;i++){
    try{restartedTarget=(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t=>t.type==='page'&&t.url.includes('pdfy.local'))}catch{}
    if(!restartedTarget)await wait(150);
  }
  assert.ok(restartedTarget,'Restarted native host did not expose its test page');
  ws=new WebSocket(restartedTarget.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});ws.onmessage=onMessage;
  for(let i=0;i<100&&!await evaluate('!!window.__pdfy && !!window.__api').catch(()=>false);i++)await wait(100);
  const afterProcessRestart=await evaluate(`(async()=>{
    const entry=(await __api.listClosed()).find(f=>f.name==='native-history.pdf');await __pdfy.reopenClosedFile(entry);
    const write=navigator.clipboard.writeText;let path;navigator.clipboard.writeText=async text=>{path=text};
    try{await __pdfy.copyFilePath(__pdfy.session);return {path,page:__pdfy.viewer.current,count:__pdfy.sessions.length}}
    finally{navigator.clipboard.writeText=write}
  })()`);
  assert.deepEqual(afterProcessRestart,{path:sample,page:3,count:1});
  console.log('ok A complete native process restart renews access only to an already-opened file and restores its history page and path');
} finally {
  ws?.close();
  // This PID belongs only to the isolated app started above, never the user's app.
  spawnSync('powershell', ['-NoProfile', '-Command', 'Stop-Process -Id $env:PDFY_INPUT_PID -ErrorAction SilentlyContinue'],
    { windowsHide: true, env: { ...process.env, PDFY_INPUT_PID: String(pid) }, stdio: 'ignore' });
}
