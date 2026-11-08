const app=window.__pdfy, api=window.__api, locations=window.__fileLocations, results=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const ok=(v,m)=>{if(!v)throw new Error(m)};
const normal=await(await fetch('/fixtures/normal.pdf')).blob(), root=await navigator.storage.getDirectory();
let serial=0, response, lastRequest, copied=[];
const oldView=window.chrome?.webview, oldOpen=window.showOpenFilePicker, oldSave=window.showSaveFilePicker, oldWrite=navigator.clipboard.writeText;
window.chrome??={};
function reply(message) {
  lastRequest=message; const next=response;
  queueMicrotask(()=>locations.onLocationMessage({type:'file-picker',id:message.id,ok:!next?.error,error:next?.error,paths:next?.paths??[]},next?.handles??[]));
}
window.chrome.webview={postMessage:reply,postMessageWithAdditionalObjects:()=>{throw new Error('Only real native tests may transfer disk files')},addEventListener:()=>{}};
navigator.clipboard.writeText=async text=>{copied.push(text)};
locations.installNativePickers();
async function handle() {
  const d=await root.getDirectoryHandle(`locations-${++serial}`,{create:true}),h=await d.getFileHandle('same.pdf',{create:true}),w=await h.createWritable();
  await w.write(normal);await w.close();return h;
}
async function reset() {await app.tools.settle();for(const s of [...app.sessions]){s.dirty=false;await app.closeSession(s)}copied=[];}
async function test(name,run) {
  console.log('TEST',name);
  try{await run();results.push({name,ok:true})}catch(e){results.push({name,ok:false,error:String(e.message??e)})}
  await fetch('/__save/test-progress.json',{method:'PUT',body:JSON.stringify({done:results.length,passed:results.filter(r=>r.ok).length,results})});
}
try {
  await test('Native Open preserves multiple/filter options and matches full paths by handle rather than basename',async()=>{
    await reset();const a=await handle(),b=await handle();response={handles:[a,b],paths:['C:\\First folder\\same.pdf','C:\\Second \u0643\u062a\u0627\u0628\\same.pdf']};
    const chosen=await showOpenFilePicker({multiple:true,excludeAcceptAllOption:true,types:[{description:'PDF',accept:{'application/pdf':['.pdf']}}]});
    ok(chosen.length===2&&lastRequest.kind==='open'&&lastRequest.multiple&&lastRequest.acceptAll===false&&lastRequest.types[0].extensions[0]==='.pdf','native picker lost its options or files');
    await app.openHandle(structuredClone(b));const target=app.session,other=app.newDocument();await app.copyFilePath(target);
    ok(copied.at(-1)==='C:\\Second \u0643\u062a\u0627\u0628\\same.pdf'&&app.session===other,'Copy file path used the current tab or the wrong same-name file');
  });
  await test('Native Save keeps the suggested name and registers its returned location',async()=>{
    await reset();const h=await handle();response={handles:[h],paths:['C:\\Saved files\\same.pdf']};
    const chosen=await showSaveFilePicker({suggestedName:'same.pdf',types:[{description:'PDF',accept:{'application/pdf':['.pdf']}}]});
    ok(chosen===h&&lastRequest.kind==='save'&&lastRequest.suggestedName==='same.pdf'&&!lastRequest.multiple,'Save picker lost its target or options');
    await app.openHandle(h);await app.copyFilePath(app.session);ok(copied.at(-1)==='C:\\Saved files\\same.pdf','saved target location was not registered');
  });
  await test('Canceling a native file window rejects with AbortError',async()=>{
    response={error:'cancelled'};let aborted=false;try{await showOpenFilePicker({multiple:true})}catch(e){aborted=e.name==='AbortError'}ok(aborted,'Cancel was not an AbortError');
  });
  await test('Legacy handles accept only the original file; cancel and a same-name different file keep the tab intact',async()=>{
    await reset();const original=await handle(),wrong=await handle();await app.openHandle(original);const target=app.session;
    response={handles:[wrong],paths:['C:\\Wrong folder\\same.pdf']};await app.copyFilePath(target);ok(!copied.length&&app.session===target,'a different same-name file was accepted');
    response={error:'cancelled'};await app.copyFilePath(target);ok(!copied.length&&app.session===target,'cancel changed the target');
    response={handles:[original],paths:['C:\\Original folder\\same.pdf']};await app.copyFilePath(target);ok(copied.at(-1)==='C:\\Original folder\\same.pdf'&&app.session===target,'the original file was not linked');
  });
  await test('An inaccessible legacy link can be opened after choosing its original file once',async()=>{
    await reset();const original=await handle(),wrong=await handle();original.queryPermission=async()=>'prompt';original.requestPermission=async()=>'prompt';
    response={handles:[wrong],paths:['C:\\Another file\\same.pdf']};await app.openHandle(original);ok(!app.sessions.length,'a different legacy file was opened');
    response={error:'cancelled'};await app.openHandle(original);ok(!app.sessions.length,'cancel opened a legacy file');
    response={handles:[original],paths:['C:\\Legacy original\\same.pdf']};await app.openHandle(original);ok(app.session?.handle===original&&app.sessions.length===1,'the confirmed legacy file did not open');
  });
} finally {
  await reset();window.chrome.webview=oldView;window.showOpenFilePicker=oldOpen;window.showSaveFilePicker=oldSave;navigator.clipboard.writeText=oldWrite;
}
export default {summary:{passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length},results};
