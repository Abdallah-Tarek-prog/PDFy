const app=window.__pdfy,results=[],wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(value,message)=>{if(!value)throw new Error(message);};
async function until(fn){for(let i=0;i<160;i++){const value=fn();if(value)return value;await wait(25);}throw new Error('Timed out');}
const root=()=>document.querySelector('.markdown-editor');
async function click(el){const r=el.getBoundingClientRect();for(const type of ['mousePressed','mouseReleased'])await window.__cdp('Input.dispatchMouseEvent',{type,x:r.left+r.width/2,y:r.top+r.height/2,button:'left',clickCount:1});}
async function closeAll(){await app.tools.settle();for(const s of [...app.sessions]){s.dirty=false;await app.closeSession(s);}}
async function open(text){await closeAll();const s=app.newDocument();app.viewer.setScale(1);await until(()=>app.viewer.views.has(s.pages[0].id));const p=s.pages[0];app.setMode('edit');app.tools.setTool('markdown');app.tools.openEditor(app.viewer.views.get(p.id),{...app.tools.base('text','markdown'),rect:[30,420,330,650],markdown:true,mdTheme:'obsidian-light',text},true);await until(()=>root()?.querySelector('[contenteditable=true]')===document.activeElement);return {s,p};}
async function selectWord(){const p=root().querySelector('.md-editable p'),text=p.firstChild,range=document.createRange();range.setStart(text,7);range.setEnd(text,13);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);await wait(50);check(selection.toString()==='target','Test did not select the target word');}
async function test(name,run){console.log('TEST',name);try{await run();results.push({name,ok:true});}catch(e){results.push({name,ok:false,error:String(e.message??e)});}await fetch('/__save/test-progress.json',{method:'PUT',body:JSON.stringify({done:results.length,passed:results.filter(r=>r.ok).length,heapMB:0,results})});}
try{
  await test('Choosing a palette colour with the mouse applies only to the selected Markdown word',async()=>{
    const {p}=await open('Before target after');await selectWord();const colour=root().querySelector('[aria-label="Text colour"]');await click(colour);await wait(100);check(root(),'Clicking the colour control closed the editor');await window.__shot('markdown-colour-click');
    const palette=await until(()=>document.querySelector('.colour-popover'));await click(palette.querySelector('[aria-label="Colour #d92d20"]'));await wait(50);
    const span=root()?.querySelector('.md-color');check(span?.textContent==='target',`The chosen colour missed the selection: ${root()?.querySelector('.md-editable').innerHTML}`);
    check(getComputedStyle(span).color==='rgb(217, 45, 32)','The selected text did not show the chosen colour');
    root().querySelector('.md-done').click();await app.tools.settle();check(p.annots[0].text.includes('#d92d20'),'The colour was lost on Done');
  });
  await test('Typing a custom colour code keeps the editor open and survives preview and re-editing',async()=>{
    const {p}=await open('Before target after');await selectWord();await click(root().querySelector('[aria-label="Text colour"]'));
    const hex=await until(()=>document.querySelector('.colour-popover [aria-label="Colour code"]'));await click(hex);
    for(const type of ['keyDown','keyUp'])await window.__cdp('Input.dispatchKeyEvent',{type,key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});
    await window.__cdp('Input.insertText',{text:'#12ab9c'});
    for(const type of ['keyDown','keyUp'])await window.__cdp('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    check(root(),'The colour-code field prematurely closed the editor');check(root().querySelector('.md-color')?.textContent==='target','The colour-code field lost the selected word');
    root().querySelector('.md-done').click();await app.tools.settle();const note=p.annots[0];
    const preview=await until(()=>document.querySelector(`[data-id="${note.id}"] .md-color`));check(getComputedStyle(preview).color==='rgb(18, 171, 156)','The preview lost the chosen colour');
    app.tools.openEditor(app.viewer.views.get(p.id),note,false);check(getComputedStyle(root().querySelector('.md-color')).color==='rgb(18, 171, 156)','Re-editing lost the chosen colour');
  });
  await test('Choosing a colour before typing colours the new text and Escape only dismisses the palette',async()=>{
    await open('');await click(root().querySelector('[aria-label="Text colour"]'));
    const palette=await until(()=>document.querySelector('.colour-popover'));await click(palette.querySelector('[aria-label="Colour #1a56db"]'));
    for(const type of ['keyDown','keyUp'])await window.__cdp('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    check(root()&&!document.querySelector('.colour-popover'),'Escape did not dismiss only the palette');
    await window.__cdp('Input.insertText',{text:'New blue text'});
    const span=root().querySelector('.md-color');check(span?.textContent==='New blue text'&&getComputedStyle(span).color==='rgb(26, 86, 219)','The chosen typing colour was lost');
  });
  await test('A colour palette in the right pane commits to its own PDF and closes when switching documents',async()=>{
    const {s,p}=await open('Before target after');root().querySelector('.md-done').click();await app.tools.settle();const other=app.newDocument();app.moveSessionToPane(s,1);
    try{
      app.tools.openEditor(await until(()=>app.viewer.views.get(p.id)),p.annots[0],false);await until(()=>root()?.querySelector('[contenteditable=true]')===document.activeElement);await selectWord();
      await click(root().querySelector('[aria-label="Text colour"]'));const palette=await until(()=>document.querySelector('.colour-popover'));await click(palette.querySelector('[aria-label="Colour #0b8a4f"]'));await click(palette.querySelector('.cp-hex'));
      app.activate(other);await app.panes[1].tools.settle();check(!root()&&!document.querySelector('.colour-popover'),'Changing documents left an orphan editor or palette');
      check(p.annots[0].text.includes('#0b8a4f')&&other.pages[0].annots.length===0,'Colour was applied to the wrong PDF');
    }finally{if(app.splitView)app.toggleSplitView();}
  });
}finally{await closeAll();}
export default{summary:{passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length},results};
