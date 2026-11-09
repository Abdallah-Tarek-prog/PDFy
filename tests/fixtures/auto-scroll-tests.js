const app=window.__pdfy, results=[], wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(value,message)=>{if(!value)throw new Error(message);};
const blob=await(await fetch('/fixtures/normal.pdf')).blob();
const pointer=(target,type,x,y,button=1)=>target.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerType:'mouse',pointerId:7,button,buttons:type==='pointerdown'?4:0,clientX:x,clientY:y}));
const middle=(sc,x,y)=>{pointer(sc,'pointerdown',x,y);pointer(window,'pointerup',x,y);};
const move=(x,y)=>pointer(window,'pointermove',x,y,-1);
async function test(name,run){console.log('TEST',name);try{await run();results.push({name,ok:true});}catch(e){results.push({name,ok:false,error:String(e.message??e)});}await fetch('/__save/test-progress.json',{method:'PUT',body:JSON.stringify({done:results.length,passed:results.filter(r=>r.ok).length,heapMB:0,results})});}
for(const s of [...app.sessions]){s.dirty=false;await app.closeSession(s);}
const a=await app.openPdfBlob(blob,'A.pdf'), b=await app.openPdfBlob(blob,'B.pdf');app.activate(a);app.viewer.setScale(3);await wait(250);
const sc=app.viewer.scroller, box=sc.getBoundingClientRect(), x=box.left+box.width/2,y=box.top+box.height/2;
try{
  await test('Wheel click starts scrolling after release, based on pointer distance',async()=>{
    sc.scrollTop=700;sc.scrollLeft=100;middle(sc,x,y);check(sc.classList.contains('auto-scrolling'),'Scrolling mode did not start');
    move(x+110,y+100);await wait(220);const top=sc.scrollTop;
    check(top>730&&sc.scrollLeft>120,'Pointer movement did not scroll both axes');await wait(130);check(sc.scrollTop>top+20,'Scrolling required holding or moving the pointer again');
    await window.__shot('wheel-auto-scroll');
  });
  await test('The next wheel click stops scrolling even outside the document',async()=>{
    middle(document.body,x,y);const top=sc.scrollTop,left=sc.scrollLeft;move(x+200,y+180);await wait(140);
    check(!document.querySelector('.auto-scroll-origin')&&!sc.classList.contains('auto-scrolling'),'Scrolling marker remained');
    check(Math.abs(sc.scrollTop-top)<2&&Math.abs(sc.scrollLeft-left)<2,'Scrolling continued after the second click');
  });
  await test('The centre is stationary, and moving above or left reverses scrolling',async()=>{
    sc.scrollTop=1400;sc.scrollLeft=250;middle(sc,x,y);move(x+4,y-4);await wait(100);
    check(Math.abs(sc.scrollTop-1400)<2,'The centre should be a dead zone');move(x-110,y-100);await wait(220);
    check(sc.scrollTop<1370&&sc.scrollLeft<230,'Reverse scrolling did not work');middle(sc,x,y);
  });
  await test('Middle clicks do not draw or apply a selected markup tool',async()=>{
    app.setMode('edit');app.tools.setTool('highlight');
    const before=a.pages.reduce((n,p)=>n+p.annots.length,0);middle(sc,x,y);middle(sc,x,y);
    check(a.pages.reduce((n,p)=>n+p.annots.length,0)===before,'Middle clicks created an annotation');app.tools.useReadingTool();
  });
  await test('Tab changes, Escape and loss of focus cancel scrolling',async()=>{
    middle(sc,x,y);move(x,y+100);app.activate(b);await wait(60);check(!document.querySelector('.auto-scroll-origin'),'Scrolling leaked into another tab');
    middle(sc,x,y);window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));check(!document.querySelector('.auto-scroll-origin'),'Escape did not stop scrolling');
    middle(sc,x,y);window.dispatchEvent(new Event('blur'));check(!document.querySelector('.auto-scroll-origin'),'Loss of focus did not stop scrolling');
  });
  await test('Split-pane scrolling affects only its own PDF and the other pane can stop it',async()=>{
    app.activate(a);app.toggleSplitView();const left=app.panes[0].viewer,right=app.panes[1].viewer;right.setScale(2);await wait(150);
    left.scroller.scrollTop=500;right.scroller.scrollTop=600;const r=right.scroller.getBoundingClientRect(),rx=r.left+r.width/2,ry=r.top+200;
    middle(right.scroller,rx,ry);move(rx,ry+120);await wait(180);
    check(right.scroller.scrollTop>630&&Math.abs(left.scroller.scrollTop-500)<2,'Scrolling changed the other pane');middle(left.scroller,x,y);check(!document.querySelector('.auto-scroll-origin'),'The other pane did not stop scrolling');
    app.toggleSplitView();
  });
  await test('Editing fields ignore middle-click mode and wheel zoom still works',async()=>{
    const input=document.createElement('textarea');input.className='inline-editor';app.viewer.sizer.append(input);middle(input,x,y);check(!document.querySelector('.auto-scroll-origin'),'An editing field started auto-scroll');input.remove();
    const before=app.viewer.scale;sc.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:true,deltaY:-50,clientX:x,clientY:y}));check(app.viewer.scale>before,'Ctrl+wheel zoom broke');
  });
}finally{window.dispatchEvent(new Event('blur'));for(const s of [...app.sessions]){s.dirty=false;await app.closeSession(s);}if(app.splitView)app.toggleSplitView();}
export default{summary:{passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length},results};
