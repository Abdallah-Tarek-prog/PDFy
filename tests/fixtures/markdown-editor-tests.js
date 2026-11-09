const app=window.__pdfy,api=window.__api,results=[],wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(value,message)=>{if(!value)throw new Error(message);};
async function until(fn){for(let i=0;i<160;i++){const value=fn();if(value)return value;await wait(25);}throw new Error('Timed out');}
const root=()=>document.querySelector('.markdown-editor');
const button=label=>root().querySelector(`[aria-label="${label}"]`);
const selectAll=async()=>{root().querySelector('[contenteditable=true]').focus();for(const type of ['keyDown','keyUp'])await window.__cdp('Input.dispatchKeyEvent',{type,key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});};
const type=async text=>window.__cdp('Input.insertText',{text});
async function closeAll(){await app.tools.settle();for(const s of [...app.sessions]){s.dirty=false;await app.closeSession(s);}}
async function open(text=''){
  await closeAll();const session=app.newDocument();app.viewer.setScale(1);await wait(100);
  const page=session.pages[0],a={id:crypto.randomUUID(),kind:'text',rect:[30,420,330,650],color:'#111111',textColor:'#111111',width:0,opacity:1,fill:null,fontSize:13,text,markdown:true,mdTheme:'obsidian-light'};
  app.setMode('edit');app.tools.setTool('markdown');app.tools.openEditor(app.viewer.views.get(page.id),a,true);await until(()=>root()?.querySelector('[contenteditable=true]'));
  return{session,page,a};
}
async function finish(){root().querySelector('.md-done').click();await app.tools.settle();return app.session.pages[0].annots.find(n=>n.markdown);}
async function test(name,run){console.log('TEST',name);try{await run();results.push({name,ok:true});}catch(e){results.push({name,ok:false,error:String(e.message??e)});}await fetch('/__save/test-progress.json',{method:'PUT',body:JSON.stringify({done:results.length,passed:results.filter(r=>r.ok).length,heapMB:0,results})});}
try{
  await test('Markdown opens as formatted text with toolbar and coloured headings',async()=>{
    await open('# Heading\n\nA **bold** and *italic* note.');
    check(root().querySelector('h1')?.textContent==='Heading'&&root().querySelector('strong')?.textContent==='bold','Markdown was not shown as formatted text');
    check(button('Bold (Ctrl+B)')&&button('Bulleted list')&&button('Numbered list'),'Formatting tools missing');
    const heading=getComputedStyle(root().querySelector('h1')),text=getComputedStyle(root().querySelector('.md-editable'));check(heading.color!==text.color,'Heading colours are missing');await window.__shot('markdown-formatted-editor');
  });
  await test('Bold, italic, underline and colour survive closing and reopening the note',async()=>{
    const {page}=await open('Colourful');await selectAll();button('Bold (Ctrl+B)').click();button('Italic (Ctrl+I)').click();button('Underline (Ctrl+U)').click();
    const colour=button('Text colour');colour.value='#b93b12';colour.dispatchEvent(new Event('input',{bubbles:true}));
    check(root().querySelector('strong')&&root().querySelector('em')&&root().querySelector('u'),'Formatting did not reach the selection');
    const saved=await finish();check(saved.text.includes('#b93b12')&&saved.text.includes('<u>'),'Formatting was not kept as Markdown');
    const rendered=await until(()=>document.querySelector(`[data-id="${saved.id}"] .md-color`));check(rendered.style.color==='rgb(185, 59, 18)','Text colour did not render after editing');
    app.tools.openEditor(app.viewer.views.get(page.id),saved,false);check(root().querySelector('strong')&&root().querySelector('u'),`Reopening lost formatting: ${saved.text} / ${root().querySelector('.md-editable').innerHTML}`);
  });
  await test('Bullets and numbered lists work through the real toolbar and Enter key',async()=>{
    await open();button('Bulleted list').click();await type('First');for(const type of ['keyDown','keyUp'])await window.__cdp('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await type('Second');
    check(root().querySelectorAll('.md-editable ul li').length===2,'Enter did not create a new bullet');button('Numbered list').click();check(root().querySelectorAll('.md-editable ol li').length===2,'Numbered list conversion failed');
    const saved=await finish();check(/1\. First/.test(saved.text)&&/2\. Second/.test(saved.text),'List Markdown was not saved');
  });
  await test('Source mode accepts .md content and retains equations, tables, tasks, wiki links and comments after rich edits',async()=>{
    const note='# Source\n\nA ==highlight== and $x_1^2$. [[Chapter|Wiki]] %%private%%\n\n> [!tip] Remember\n> Useful notes.\n\n- [x] Done\n- [ ] Next\n\n| A | B |\n|---|---|\n| 1 | 2 |';
    await open(note);const sourceButton=root().querySelector('.md-editor-action[title="Edit the Markdown source"]');sourceButton.click();check(root().querySelector('textarea').value===note,`Source text changed before editing: ${JSON.stringify(root().querySelector('textarea').value)}`);sourceButton.click();
    root().querySelector('[contenteditable=true]').focus();await window.__cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End',modifiers:2,windowsVirtualKeyCode:35});await window.__cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'End',code:'End',windowsVirtualKeyCode:35});await type(' more');
    const saved=await finish();check(saved.text.includes('$x_1^2$')&&saved.text.includes('[[Chapter|Wiki]]')&&saved.text.includes('%%private%%'),'Rich editing lost special Markdown');
    const html=await api.markdownToHtml(saved.text);check(html.includes('<table')&&html.includes('md-callout')&&html.includes('md-check')&&html.includes('<mark>'),'Formatted Markdown features were lost');
  });
  await test('Import .md files loads formatted text and preserves the original source',async()=>{
    await open();const text='## Imported note\n\n**Readable** with a list.\n\n- One\n- Two';const data=new DataTransfer();data.items.add(new File([text],'notes.md',{type:'text/markdown'}));const input=root().querySelector('input[type=file]');Object.defineProperty(input,'files',{value:data.files});input.dispatchEvent(new Event('change'));
    await until(()=>root().querySelector('h2')?.textContent==='Imported note');check((await finish()).text===text,'Import did not preserve Markdown');
  });
  await test('Untrusted Markdown cannot run HTML or load remote pictures while editing or rendering',async()=>{
    window.__mdUnsafe=0;const text='<script>window.__mdUnsafe=1</script>\n\n<img src="https://example.invalid/tracker" onerror="window.__mdUnsafe=2">\n\n[bad](javascript:alert(1)) ![image](https://example.invalid/image)\n\n<span style="color:#123456" onclick="window.__mdUnsafe=3">bad</span>';
    await open(text);check(!root().querySelector('script,img[src],iframe')&&!root().querySelector('a[href^="javascript:"]')&&window.__mdUnsafe===0,`Unsafe content reached the editor DOM: ${root().querySelector('script,img[src],iframe,a[href^="javascript:"]')?.outerHTML} executed=${window.__mdUnsafe}`);
    const saved=await finish(),host=document.createElement('div');await api.renderMarkdownInto(host,saved.text);check(!host.querySelector('script,img,[onclick],[onerror]')&&window.__mdUnsafe===0,'Unsafe content reached the preview');
  });
  await test('Theme changes are local to the note and source/toolbar focus does not prematurely commit',async()=>{
    await open('A note');const chosen=document.documentElement.dataset.uiTheme;const select=button('Note theme');select.value='tokyo-night';select.dispatchEvent(new Event('change'));
    button('Bold (Ctrl+B)').focus();await wait(30);check(root(),'Toolbar focus closed the editor');check(document.documentElement.dataset.uiTheme===chosen,'The note theme changed the chosen interface');
    const saved=await finish();check(saved.mdTheme==='tokyo-night','Note theme did not save');
  });
  await test('Ctrl+S commits a formatted draft into a real PDF and reopening preserves its formatting',async()=>{
    const {session}=await open('Saved formatting');const directory=await navigator.storage.getDirectory();const filename='markdown-save-'+Date.now()+'.pdf';
    try{
      session.handle=await directory.getFileHandle(filename,{create:true});await selectAll();button('Bold (Ctrl+B)').click();
      const colour=button('Text colour');colour.value='#b93b12';colour.dispatchEvent(new Event('input',{bubbles:true}));
      root().querySelector('[contenteditable=true]').focus();
      for(const type of ['keyDown','keyUp'])await window.__cdp('Input.dispatchKeyEvent',{type,key:'s',code:'KeyS',modifiers:2,windowsVirtualKeyCode:83});
      await until(()=>!root()&&!session.dirty);const file=await session.handle.getFile();check(file.size>1000,'Save did not write a PDF');
      await closeAll();const reopened=await app.openPdfBlob(file,'Saved note.pdf'),note=await until(()=>reopened.pages[0].annots.find(a=>a.markdown));
      check(note?.text.includes('Saved formatting')&&note.text.includes('#b93b12'),'PDF reopening lost the Markdown source');
      app.setMode('edit');app.tools.openEditor(app.viewer.views.get(reopened.pages[0].id),note,false);
      check(root().querySelector('strong')?.textContent==='Saved formatting'&&root().querySelector('.md-color'),'PDF reopening lost formatted editing');
    }finally{await closeAll();await directory.removeEntry(filename);}
  });
  await test('A narrow split pane fits the toolbar and switching panes commits size and text to the original document',async()=>{
    const {session,page}=await open('Left note');await finish();const other=app.newDocument();app.moveSessionToPane(other,1);app.activate(session);
    await window.__cdp('Emulation.setDeviceMetricsOverride',{width:780,height:760,deviceScaleFactor:1,mobile:false});await wait(100);
    try{
      app.tools.openEditor(app.viewer.views.get(page.id),page.annots[0],false);await selectAll();await type('Left changed');
      const size=button('Note text size');size.focus();size.value='19';
      const box=root().getBoundingClientRect(),pane=app.viewer.scroller.getBoundingClientRect();
      check(box.left>=pane.left&&box.right<=pane.right,'Editor escaped the split pane');
      check([...root().querySelectorAll('.md-formatbar button,.md-editor-top button')].every(b=>b.getBoundingClientRect().right<=box.right),'Toolbar is clipped');
      await window.__shot('markdown-split-editor');app.activate(other);await app.panes[0].tools.settle();
      check(!root()&&page.annots[0].text==='Left changed'&&page.annots[0].fontSize===19,'Pane switch lost the draft or pending text size');
      check(other.pages[0].annots.length===0,'Draft was sent to the other document');
    }finally{await window.__cdp('Emulation.clearDeviceMetricsOverride');if(app.splitView)app.toggleSplitView();}
  });
}finally{await closeAll();}
export default{summary:{passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length},results};
