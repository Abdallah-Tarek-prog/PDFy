import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { Highlight } from '@tiptap/extension-highlight';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { h, icon, reportError } from '../ui/dom';
import { openColourPicker } from '../ui/colorpicker';
import { allThemes, ensureRichCss, themeById, themeVars } from './mdthemes';
import { preservedMarkdown } from './md-editor-schema';

interface Options {
  text: string; theme?: string; size: number; scale: number;
  onInput(): void; onDone(backToReading: boolean): void; onResize(): void;
}

/** Formatted editing and the original Markdown source share one document. PDF storage stays Markdown. */
export function createMarkdownEditor(options: Options) {
  ensureRichCss();
  let editor: Editor, sourceMode = false, dirty = false, original = options.text, fontSize = options.size;
  let picker: ReturnType<typeof openColourPicker> | undefined, textColour = '#1a56db';
  const host = h('div', { class: 'inline-editor markdown-editor', 'aria-label': 'Markdown note editor' });
  const top = h('div', { class: 'md-editor-top' });
  const toolbar = h('div', { class: 'md-formatbar', role: 'toolbar', 'aria-label': 'Markdown formatting' });
  const rich = h('div', { class: 'md-editor-rich' });
  const source = h('textarea', { class: 'md-editor-source', hidden: true, value: original, spellcheck: false, dir: 'auto', 'aria-label': 'Markdown source' });
  const theme = h('select', { class: 'md-note-theme', 'aria-label': 'Note theme' }, ...allThemes().map(t => h('option', { value: t.id, selected: t.id === (options.theme ?? themeById().id) }, t.name)));
  const readText = () => sourceMode ? source.value : dirty ? editor.getMarkdown() : original;
  const paint = () => {
    rich.style.cssText = themeVars(themeById(theme.value), fontSize * options.scale);
    // Transparent note themes still need a solid editing surface.
    rich.style.background = themeById(theme.value).background;
    options.onResize();
  };
  theme.onchange = () => { options.onInput(); paint(); };
  const mode = h('button', { class: 'md-editor-action', title: 'Edit the Markdown source', 'aria-pressed': 'false' }, icon('markdown', 15), 'Source');
  const toggleSource = () => {
    const text = readText();
    sourceMode = !sourceMode; mode.setAttribute('aria-pressed', String(sourceMode));
    source.hidden = !sourceMode; rich.hidden = sourceMode; toolbar.hidden = sourceMode;
    if (sourceMode) { source.value = text; source.focus(); }
    else { original = source.value; dirty = false; editor.commands.setContent(original, { contentType: 'markdown', emitUpdate: false }); editor.commands.focus(); }
    options.onResize();
  };
  mode.onclick = toggleSource;
  const file = h('input', { type: 'file', accept: '.md,.markdown,text/markdown', hidden: true });
  const load = h('button', { class: 'md-editor-action', title: 'Import a Markdown (.md) file', 'aria-label': 'Import Markdown file', onclick: () => file.click() }, icon('open', 15));
  file.onchange = () => {
    const picked = file.files?.[0]; if (!picked) return;
    void picked.text().then(text => {
      if (!host.isConnected || editor.isDestroyed) return;
      original = text; source.value = text; dirty = false;
      editor.commands.setContent(text, { contentType: 'markdown', emitUpdate: false });
      options.onInput(); options.onResize();
    }).catch(error => reportError('Importing Markdown', error));
  };
  const done = h('button', { class: 'md-editor-action md-done', onclick: () => options.onDone(true) }, icon('check', 14), 'Done');
  top.append(theme, mode, load, done);
  const buttons: { button: HTMLButtonElement; active: () => boolean }[] = [];
  const action = (label: string, image: string, run: () => void, active?: () => boolean) => {
    const button = h('button', { type: 'button', class: 'md-format', title: label, 'aria-label': label,
      onmousedown: (e: MouseEvent) => e.preventDefault(), onclick: run }, icon(image, 16));
    if (active) buttons.push({ button, active });
    toolbar.append(button); return button;
  };
  const paragraph = h('select', { class: 'md-block-type', 'aria-label': 'Paragraph style' },
    ...[['p','Paragraph'],...Array.from({length:6},(_,i)=>[String(i+1),`Heading ${i+1}`])].map(([value,label]) => h('option', { value }, label)));
  paragraph.onchange = () => {
    if (paragraph.value === 'p') editor.chain().focus().setParagraph().run();
    else editor.chain().focus().setHeading({ level: +paragraph.value as 1|2|3|4|5|6 }).run();
  };
  const size = h('input', { type: 'number', min: 2, max: 200, value: fontSize, class: 'md-note-size', title: 'Note text size', 'aria-label': 'Note text size' });
  size.onchange = () => { const value=Number(size.value); if(!Number.isFinite(value))return; fontSize=Math.min(200,Math.max(2,value));size.value=String(fontSize);options.onInput();paint(); };
  toolbar.append(paragraph,size);
  action('Bold (Ctrl+B)', 'bold', () => { editor.chain().focus().toggleBold().run(); }, () => editor.isActive('bold'));
  action('Italic (Ctrl+I)', 'italic', () => { editor.chain().focus().toggleItalic().run(); }, () => editor.isActive('italic'));
  action('Underline (Ctrl+U)', 'underline', () => { editor.chain().focus().toggleUnderline().run(); }, () => editor.isActive('underline'));
  action('Strikethrough', 'strike', () => { editor.chain().focus().toggleStrike().run(); }, () => editor.isActive('strike'));
  action('Highlight', 'highlight', () => { editor.chain().focus().toggleHighlight().run(); }, () => editor.isActive('highlight'));
  const colour = h('button', { type: 'button', class: 'md-text-colour', title: 'Select text, then choose its colour', 'aria-label': 'Text colour', 'aria-haspopup': 'dialog', style: { background: textColour },
    onmousedown: (e: MouseEvent) => e.preventDefault(),
    onclick: () => {
      const { from, to } = editor.state.selection;
      picker = openColourPicker(colour, textColour, color => {
        if (editor.isDestroyed) return;
        // Keep the selected words while the palette or its code fields have focus.
        editor.chain().setTextSelection({ from, to }).setMark('noteColor', { color }).run();
        textColour = color; colour.style.background = color;
        // Palette swatches are redrawn after choosing; keep focus in the editor before removal.
        if (picker?.el.contains(document.activeElement) && document.activeElement?.tagName === 'BUTTON') colour.focus({ preventScroll: true });
      }, () => { if (!editor.isDestroyed) editor.view.focus(); });
      picker.el.addEventListener('focusout', finishIfLeft);
    },
  });
  toolbar.append(colour);
  action('Bulleted list', 'bulletList', () => { editor.chain().focus().toggleBulletList().run(); }, () => editor.isActive('bulletList'));
  action('Numbered list', 'numberedList', () => { editor.chain().focus().toggleOrderedList().run(); }, () => editor.isActive('orderedList'));
  action('Task list', 'check', () => { editor.chain().focus().toggleTaskList().run(); }, () => editor.isActive('taskList'));
  action('Quote', 'quote', () => { editor.chain().focus().toggleBlockquote().run(); }, () => editor.isActive('blockquote'));
  action('Code', 'code', () => { editor.chain().focus().toggleCode().run(); }, () => editor.isActive('code'));
  action('Undo', 'undo', () => { editor.chain().focus().undo().run(); });
  action('Redo', 'redo', () => { editor.chain().focus().redo().run(); });
  host.append(top, toolbar, rich, source, file);
  const updateButtons = () => {
    for (const { button, active } of buttons) { const on = active(); button.classList.toggle('on', on); button.setAttribute('aria-pressed', String(on)); }
    paragraph.value = editor.isActive('heading') ? String(editor.getAttributes('heading').level) : 'p';
    const current = editor.getAttributes('noteColor').color;
    if (typeof current === 'string') { textColour = current; colour.style.background = current; }
  };
  editor = new Editor({
    element: rich,
    extensions: [StarterKit.configure({ link: { openOnClick: false, autolink: false, linkOnPaste: false } }),
      Highlight, TaskList, TaskItem.configure({ nested: true }), TableKit, ...preservedMarkdown,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } })],
    content: original, contentType: 'markdown',
    editorProps: {
      attributes: { class: 'md-box md-editable', role: 'textbox', 'aria-label': 'Formatted Markdown', 'aria-multiline': 'true', dir: 'auto' },
      handlePaste(_view, event) {
        const text = event.clipboardData?.getData('text/plain'); if (!text) return false;
        event.preventDefault(); editor.commands.insertContent(text, { contentType: 'markdown' }); return true;
      },
    },
    onUpdate: ({ transaction }) => { if (transaction.docChanged) { dirty = true; options.onInput(); } options.onResize(); },
    onSelectionUpdate: updateButtons,
    onTransaction: () => { if (editor) updateButtons(); },
  });
  source.oninput = () => { options.onInput(); options.onResize(); };
  host.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') return;
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); options.onDone(true); }
  });
  function finishIfLeft() {
    setTimeout(() => {
      if (host.isConnected && !host.contains(document.activeElement) && !picker?.el.contains(document.activeElement)) options.onDone(false);
    }, 0);
  }
  host.addEventListener('focusout', finishIfLeft);
  host.addEventListener('dblclick', e => {
    const target = (e.target as Element).closest<HTMLElement>('.md-preserved');
    if (!target || sourceMode) return;
    e.preventDefault(); e.stopPropagation(); const raw = target.dataset.noteRaw ?? ''; toggleSource();
    const at = source.value.indexOf(raw); if (at >= 0) source.setSelectionRange(at, at + raw.length);
  });
  paint(); updateButtons();
  return {
    el: host,
    focus: () => editor.commands.focus('end'),
    value: () => ({ text: readText(), mdTheme: theme.value, fontSize: Number.isFinite(Number(size.value)) ? Math.min(200,Math.max(2,Number(size.value))) : fontSize }),
    resize(maxHeight: number) {
      const controls = top.offsetHeight + (sourceMode ? 0 : toolbar.offsetHeight);
      const room = Math.max(60, maxHeight - controls - 4);
      rich.style.maxHeight = `${room}px`; source.style.height = `${room}px`;
    },
    destroy: () => { picker?.close(); editor.destroy(); host.remove(); },
  };
}
