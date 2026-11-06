// The windows and controls for the study tools: the equation editor, Markdown themes, preferences,
// word lookup and reading text from pictures.

import { placeBox, uid, viewportFor, type Annot, type PageRef } from '../core/model';
import { getSettings, saveSettings } from '../core/settings';
import type { Session } from '../core/session';
import { colourButton } from '../ui/colorpicker';
import { confirmDialog, openDialog } from '../ui/dialogs';
import { clear, h, reportError, safe, toast } from '../ui/dom';
import { fontButton } from '../ui/fontpicker';
import type { Tool, Tools } from '../view/tools';
import type { PageView, Viewer } from '../view/viewer';
import { fitMarkdown } from './box';
import { closeDictionary, showDictionary } from './dictpopup';
import { installedFonts } from './fonts';
import { renderMarkdownInto } from './markdown';
import { MATH_GROUPS, mathBoxSize, texToSvg, type MathResult } from './math';
import { allThemes, customThemes, ensureRichCss, saveCustomThemes, themeById, themeVars, type MdTheme } from './mdthemes';
import { type PrefSet } from './prefsets';
import { closeWordLayer, readWords, regionCanvas, showWordLayer } from './readpicture';

export interface StudyHost {
  readonly session: Session | null;
  readonly viewer: Viewer;
  readonly tools: Tools;
  reading: 'normal' | 'night' | 'sepia';
  setReading(mode: 'normal' | 'night' | 'sepia'): void;
  setStatus(text: string): void;
  onSelection(): void;
  refreshStudy(): void;
}

export const OCR_LANGUAGES = [
  { value: 'eng', label: 'English' },
  { value: 'ara', label: 'Arabic' },
  { value: 'ara+eng', label: 'Arabic and English' },
  { value: 'fra', label: 'French' },
  { value: 'deu', label: 'German' },
  { value: 'spa', label: 'Spanish' },
];

const SAMPLE_NOTE = `# Chapter notes
A paragraph with **bold**, *italic*, ==highlighted== words and \`code\`.

## Key idea
> [!tip] Remember
> Energy and mass are linked: $E = mc^2$

- [x] Read the chapter
- [ ] Do the exercises

| Word | معنى |
|---|---|
| book | كتاب |
`;

export class Study {
  lookupOn = getSettings().lookup;
  private selAtDown = '';
  private readToken = 0;

  constructor(private host: StudyHost) {
    // Only a selection made by this click counts, not one left over from before.
    host.viewer.scroller.addEventListener('pointerdown', () => { this.selAtDown = window.getSelection()?.toString().trim() ?? ''; }, true);
    host.viewer.scroller.addEventListener('pointerup', () => setTimeout(() => this.afterSelect(), 0));
    host.viewer.scroller.addEventListener('scroll', () => closeDictionary(), { passive: true });
  }

  // ---- Word lookup ----

  toggleLookup(on = !this.lookupOn) {
    this.lookupOn = on;
    saveSettings({ lookup: on });
    if (!on) closeDictionary();
    this.host.refreshStudy();
    toast(on ? 'Word lookup is on. Double-click a word, or select a few.' : 'Word lookup is off.', 'info');
  }

  /** With lookup on, choosing a word or short phrase is enough. Longer selections are left alone. */
  private afterSelect() {
    if (!this.lookupOn || this.host.tools.tool !== 'select') return;
    const text = this.selectedText();
    if (!text || text === this.selAtDown || text.length > 60 || text.split(/\s+/).length > 5) return;
    this.lookupSelection();
  }

  private selectedText(): string {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !this.host.viewer.scroller.contains(sel.anchorNode)) return '';
    return sel.toString().trim();
  }

  /** The words around the selection, so the whole sentence can be translated. */
  private sentenceAround(word: string): string {
    const sel = window.getSelection();
    const el = sel?.anchorNode?.parentElement;
    const host = el?.closest('.textLayer, .read-layer');
    if (!el || !host) return '';
    const spans = [...host.querySelectorAll('span')].filter(s => !s.children.length);
    const at = spans.indexOf(el as HTMLSpanElement);
    if (at < 0) return el.textContent ?? '';
    const near = spans.slice(Math.max(0, at - 6), at + 7).map(s => s.textContent ?? '').join(' ').replace(/\s+/g, ' ');
    const i = near.indexOf(word);
    if (i < 0) return near;
    const before = near.slice(0, i), after = near.slice(i);
    const start = Math.max(before.lastIndexOf('. '), before.lastIndexOf('? '), before.lastIndexOf('! ')) + 2;
    const endHit = after.search(/[.?!](\s|$)/);
    return (before.slice(Math.max(0, start - (start === 1 ? 2 : 0))) + (endHit >= 0 ? after.slice(0, endHit + 1) : after)).trim();
  }

  lookupSelection() {
    const text = this.selectedText();
    if (!text) { toast('Select a word on the page first.', 'info'); return; }
    const r = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
    safe(() => showDictionary(text, { x: r.left, y: r.bottom, sentence: this.sentenceAround(text) }), 'Looking up')();
  }

  // ---- Reading words out of a picture ----

  async readPicture(page: PageRef, rect: Annot['rect']) {
    const s = this.host.session;
    const v = this.host.viewer.views.get(page.id);
    if (!s || !v) return;
    closeWordLayer();
    const mine = ++this.readToken;
    this.host.setStatus('Reading the words in that area…');
    try {
      const shot = await regionCanvas(s, page, rect);
      const words = await readWords(shot.canvas, getSettings().ocrLang);
      shot.canvas.width = 0;
      // A newer read, another document, or a page that scrolled away: this result is no longer wanted.
      if (mine !== this.readToken || this.host.session !== s || !v.el.isConnected) return;
      if (!words.length) { toast('No words could be read there. Try a larger area, or zoom into a sharper picture.', 'info'); return; }
      showWordLayer(v, words, shot, found => s.addPictureWords(page.id, found));
    } finally {
      this.host.setStatus('');
    }
  }

  // ---- Equations ----

  private centreOfView(): { v: PageView; x: number; y: number } | null {
    const s = this.host.session;
    if (!s) return null;
    const viewer = this.host.viewer;
    const page = s.pages[viewer.current];
    const v = page && viewer.views.get(page.id);
    if (!v) return null;
    const r = v.el.getBoundingClientRect(), sc = viewer.scroller.getBoundingClientRect();
    const k = viewer.scale;
    return { v, x: ((Math.max(r.left, sc.left) + Math.min(r.right, sc.right)) / 2 - r.left) / k, y: ((Math.max(r.top, sc.top) + Math.min(r.bottom, sc.bottom)) / 2 - r.top) / k };
  }

  /** Opens the editor. A selected equation is changed, otherwise a new one lands in the middle of the view. */
  async insertEquation() {
    const sel = this.host.viewer.selectedAnnot();
    if (sel?.annot.kind === 'math') {
      const v = this.host.viewer.views.get(sel.page.id);
      if (v) { await this.editEquation(v, sel.annot); return; }
    }
    const style = this.host.tools.style('text');
    const result = await equationDialog({ latex: '', fontSize: 18, color: style.color === '#111111' ? '#111111' : style.color, display: true }, 'Insert');
    if (!result) return;
    const at = this.centreOfView();
    if (!at) return;
    const size = mathBoxSize(result.math, result.fontSize);
    const box = placeBox(at.v.page, at.x - size.w / 2, at.y - size.h / 2, at.x + size.w / 2, at.y + size.h / 2);
    const a: Annot = {
      id: uid(), kind: 'math', rect: box.rect, angle: box.angle, color: result.color, opacity: 1, width: 0, fill: null,
      latex: result.latex, mathSvg: result.math.svg, mathDisplay: result.display, fontSize: result.fontSize,
      author: getSettings().author, created: Date.now(),
    };
    this.host.session!.addAnnots(at.v.page, [a], 'Add equation');
    this.host.tools.setTool('select');
    this.host.viewer.select(at.v.page.id, a.id);
    this.host.onSelection();
  }

  async editEquation(v: PageView, a: Annot) {
    const result = await equationDialog({ latex: a.latex ?? '', fontSize: a.fontSize ?? 18, color: a.color, display: a.mathDisplay !== false }, 'Update');
    if (!result) return;
    const size = mathBoxSize(result.math, result.fontSize);
    const cx = (a.rect[0] + a.rect[2]) / 2, cy = (a.rect[1] + a.rect[3]) / 2;
    const { ghost: _g, ...rest } = a;
    const updated: Annot = {
      ...rest, rect: [cx - size.w / 2, cy - size.h / 2, cx + size.w / 2, cy + size.h / 2], color: result.color,
      latex: result.latex, mathSvg: result.math.svg, mathDisplay: result.display, fontSize: result.fontSize,
    };
    this.host.session!.replaceAnnot(v.page, a, updated, 'Edit equation');
  }

  /** Changes an equation's size or colour from the bar above the page. */
  async restyleEquation(page: PageRef, a: Annot, patch: Partial<Annot>) {
    const session = this.host.session!;
    const { ghost: _g, ...rest } = a;
    const next: Annot = { ...rest, ...patch };
    if (patch.fontSize && patch.fontSize !== a.fontSize) {
      const math = await texToSvg(a.latex ?? '', a.mathDisplay !== false);
      const size = mathBoxSize(math, patch.fontSize);
      const cx = (a.rect[0] + a.rect[2]) / 2, cy = (a.rect[1] + a.rect[3]) / 2;
      next.rect = [cx - size.w / 2, cy - size.h / 2, cx + size.w / 2, cy + size.h / 2];
      next.mathSvg = math.svg;
    }
    if (page.annots.find(x => x.id === a.id) !== a) return;
    session.replaceAnnot(page, a, next, 'Change equation');
  }

  // ---- Markdown boxes ----

  /** Applies a new theme or text size to a note, then makes it fit again. */
  async restyleNote(page: PageRef, a: Annot, patch: Partial<Annot>) {
    const session = this.host.session!;
    const { ghost: _g, ...rest } = a;
    const next = await fitMarkdown({ ...rest, ...patch });
    if (page.annots.find(x => x.id === a.id) !== a) return;
    session.replaceAnnot(page, a, next, 'Change note style');
  }

  /** Shows a theme choice, for the bar above the page. */
  themeSelect(value: string | undefined, onChange: (id: string) => void): HTMLSelectElement {
    const sel = h('select', { 'aria-label': 'Note theme' }, ...allThemes().map(t => h('option', { value: t.id, selected: t.id === (value ?? getSettings().mdTheme) }, t.name)));
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  async themesDialog(startWith?: string) {
    await themesDialog(startWith ?? getSettings().mdTheme);
    this.host.refreshStudy();
    // A changed theme can change how tall notes are, so each one is fitted again, with undo.
    const s = this.host.session;
    if (s) {
      for (const page of s.pages) {
        for (const a of page.annots.filter(x => x.markdown && !x.ghost)) {
          const next = await fitMarkdown(a);
          if (Math.abs((next.rect[3] - next.rect[1]) - (a.rect[3] - a.rect[1])) > 0.5 && page.annots.includes(a)) s.replaceAnnot(page, a, next, 'Fit note to theme');
        }
      }
    }
    for (const v of this.host.viewer.views.values()) this.host.viewer.drawAnnots(v);
  }

  // ---- Quick setups ----

  async applySet(set: PrefSet) {
    const t = this.host.tools;
    const fonts = await installedFonts().catch(() => [] as string[]);
    const fontName = fonts.includes(set.textFont) ? set.textFont : undefined;
    const paint = (tool: Tool, patch: object) => t.setStyle(patch as never, tool);
    paint('text', { fontName, fontSize: set.textSize, color: set.textColor });
    paint('callout', { fontName, fontSize: set.textSize });
    paint('highlight', { color: set.highlight, opacity: set.highlightOpacity });
    paint('underline', { color: set.underline });
    paint('pen', { color: set.pen, width: set.penWidth });
    paint('marker', { color: set.marker });
    saveSettings({ mdTheme: set.mdTheme, lookup: set.lookup, prefSet: set.id });
    this.lookupOn = set.lookup;
    if (!set.lookup) closeDictionary();
    // Page colours only. The interface theme is never changed behind your back: that is in Appearance.
    this.host.setReading(set.reading);
    this.host.refreshStudy();
    toast(fontName ? `“${set.name}” is on.` : `“${set.name}” is on. Its font, ${set.textFont}, is not on this PC, so the standard one stays.`, 'ok');
  }

  currentAsSet(name: string): PrefSet {
    const t = this.host.tools;
    const text = t.style('text'), hl = t.style('highlight'), ul = t.style('underline'), pen = t.style('pen'), marker = t.style('marker');
    const s = getSettings();
    return {
      id: `mine-${uid()}`, name, about: 'Saved by you.',
      textFont: text.fontName ?? 'Segoe UI', textSize: text.fontSize, textColor: text.color,
      highlight: hl.color, highlightOpacity: hl.opacity, underline: ul.color,
      pen: pen.color, penWidth: pen.width, marker: marker.color, mdTheme: s.mdTheme,
      reading: this.host.reading,
      uiTheme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
      lookup: this.lookupOn,
    };
  }
}

// ---- The equation editor ----

interface EquationInput { latex: string; fontSize: number; color: string; display: boolean }
interface EquationResult extends EquationInput { math: MathResult }

function equationDialog(start: EquationInput, okLabel: string): Promise<EquationResult | null> {
  const box = h('textarea', { class: 'eq-input', rows: 3, spellcheck: false, dir: 'ltr', value: start.latex, placeholder: 'Type LaTeX, for example  E = mc^2  or  \\frac{a}{b}', 'aria-label': 'LaTeX' });
  const preview = h('div', { class: 'eq-preview', 'aria-live': 'polite' });
  const problem = h('div', { class: 'eq-problem' });
  const size = h('input', { type: 'number', min: 6, max: 96, step: 1, value: start.fontSize, 'aria-label': 'Size', style: { width: '64px' } });
  const display = h('input', { type: 'checkbox', checked: start.display });
  let colour = start.color;
  const colourBtn = colourButton(colour, c => { colour = c; preview.style.color = c; }, 'Equation colour');
  preview.style.color = colour;

  let last: MathResult | null = null;
  let token = 0;
  let timer = 0;
  const update = async () => {
    const mine = ++token;
    const tex = box.value.trim();
    if (!tex) { preview.replaceChildren(h('span', { class: 'muted' }, 'Your equation appears here.')); problem.textContent = ''; last = null; syncOk(); return; }
    try {
      const r = await texToSvg(tex, display.checked);
      if (mine !== token) return;
      last = r;
      preview.innerHTML = r.svg;
      const svg = preview.querySelector('svg');
      if (svg) { svg.setAttribute('width', `${r.width * 26}px`); svg.setAttribute('height', `${r.height * 26}px`); }
      problem.textContent = '';
    } catch (err) {
      if (mine !== token) return;
      last = null;
      problem.textContent = `Not readable yet: ${(err as Error).message}`;
    }
    syncOk();
  };
  const later = () => { clearTimeout(timer); timer = window.setTimeout(() => { void update(); }, 110); };
  box.addEventListener('input', later);
  display.addEventListener('change', later);

  /** Puts a snippet where the cursor is, and selects the first placeholder so it can be typed over. */
  const insert = (tex: string) => {
    const a = box.selectionStart, b = box.selectionEnd;
    box.setRangeText(tex, a, b, 'end');
    const hole = /\{([a-z])\}/.exec(tex);
    if (hole) { const at = a + hole.index + 1; box.setSelectionRange(at, at + 1); }
    box.focus();
    later();
  };

  const tabs = h('div', { class: 'eq-tabs', role: 'tablist' });
  const grid = h('div', { class: 'eq-grid' });
  const showGroup = (i: number) => {
    [...tabs.children].forEach((c, k) => c.classList.toggle('on', k === i));
    grid.replaceChildren(...MATH_GROUPS[i].items.map(item => h('button', {
      class: 'eq-key', title: `${item.title}: ${item.tex.trim()}`, 'aria-label': item.title,
      onmousedown: (e: Event) => e.preventDefault(),
      onclick: () => insert(item.tex),
    }, item.label)));
  };
  MATH_GROUPS.forEach((g, i) => tabs.append(h('button', { class: 'eq-tab', role: 'tab', onclick: () => showGroup(i) }, g.name)));
  showGroup(0);

  const body = h('div', { class: 'eq-dialog' },
    tabs, grid, box, problem, preview,
    h('div', { class: 'eq-options' },
      h('label', null, 'Size ', size),
      h('label', null, 'Colour ', colourBtn),
      h('label', null, display, ' Large layout, with limits above and below')));

  const okBtn = h('button', { class: 'btn primary' }, okLabel);
  const cancelBtn = h('button', { class: 'btn' }, 'Cancel');
  const syncOk = () => { okBtn.disabled = !last; };
  syncOk();

  return openDialog<EquationResult | null>('Equation', h('div', null, body, h('div', { class: 'dialog-foot eq-foot' }, cancelBtn, okBtn)), [], null, close => {
    const done = async () => {
      // Draw what is typed right now, so the picture and the LaTeX always match.
      clearTimeout(timer);
      await update();
      if (!last) return;
      close({ latex: box.value.trim(), fontSize: Math.max(4, +size.value || 18), color: colour, display: display.checked, math: last });
    };
    okBtn.addEventListener('click', () => { void done(); });
    cancelBtn.addEventListener('click', () => close(null));
    box.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); void done(); }
      if (e.key === 'Escape') close(null);
    });
    box.focus();
    void update().catch(err => reportError('The equation engine', err));
  }, true);
}

// ---- The theme editor ----

const COLOUR_FIELDS: [keyof MdTheme, string][] = [
  ['text', 'Text'], ['heading', 'Headings'], ['strong', 'Bold'], ['accent', 'Accent'], ['link', 'Links'],
  ['markBg', 'Highlight'], ['markFg', 'Highlight text'], ['codeBg', 'Code background'], ['codeFg', 'Code text'],
  ['quoteBar', 'Quote bar'], ['quoteText', 'Quote text'], ['border', 'Lines'], ['background', 'Card'],
];

function themesDialog(startId: string): Promise<boolean> {
  ensureRichCss();
  let editing: MdTheme = { ...themeById(startId) };
  const listBox = h('div', { class: 'theme-list', role: 'listbox', 'aria-label': 'Themes' });
  const form = h('div', { class: 'theme-form' });
  const sample = h('div', { class: 'md-box', dir: 'auto' });
  const stage = h('div', { class: 'theme-stage' }, sample);
  const textarea = h('textarea', { class: 'theme-sample', rows: 4, spellcheck: false, value: SAMPLE_NOTE, 'aria-label': 'Try your own Markdown' });

  const redrawSample = () => {
    sample.style.cssText = themeVars(editing);
    void renderMarkdownInto(sample, textarea.value).catch(err => console.warn(err));
  };

  /** Editing a ready-made theme makes your own copy, so the original is never lost. */
  const change = (patch: Partial<MdTheme>) => {
    if (editing.builtIn) {
      editing = { ...editing, builtIn: false, id: `mine-${uid()}`, name: `${editing.name} (mine)` };
      saveCustomThemes([...customThemes(), editing]);
      drawList();
    }
    editing = { ...editing, ...patch };
    saveCustomThemes(customThemes().map(t => (t.id === editing.id ? editing : t)));
    redrawSample();
    if (patch.name !== undefined) drawList();
  };

  function drawList() {
    clear(listBox);
    for (const t of allThemes()) {
      listBox.append(h('button', {
        class: `theme-item${t.id === editing.id ? ' on' : ''}`, role: 'option', 'aria-selected': String(t.id === editing.id),
        onclick: () => { editing = { ...t }; drawList(); drawForm(); redrawSample(); },
      }, h('span', { class: 'theme-dot', style: { background: t.showBackground ? t.background : '#ffffff', borderColor: t.accent, color: t.text } }, 'A'), t.name));
    }
    listBox.append(h('button', {
      class: 'btn small theme-new',
      onclick: () => {
        const copy: MdTheme = { ...editing, builtIn: false, id: `mine-${uid()}`, name: `${editing.name} copy` };
        saveCustomThemes([...customThemes(), copy]);
        editing = copy;
        drawList(); drawForm(); redrawSample();
      },
    }, 'New from this one'));
    if (!editing.builtIn) {
      listBox.append(h('button', {
        class: 'btn small theme-new',
        onclick: safe(async () => {
          if (!await confirmDialog('Delete this theme?', `"${editing.name}" will be removed. Notes using it switch to the default look.`, 'Delete', true)) return;
          saveCustomThemes(customThemes().filter(t => t.id !== editing.id));
          editing = { ...themeById() };
          drawList(); drawForm(); redrawSample();
        }, 'Deleting'),
      }, 'Delete'));
    }
  }

  function drawForm() {
    clear(form);
    const num = (label: string, key: keyof MdTheme, min: number, max: number, step: number) => {
      const input = h('input', { type: 'number', min, max, step, value: editing[key] as number, 'aria-label': label });
      input.addEventListener('change', () => change({ [key]: +input.value || min } as Partial<MdTheme>));
      return h('label', { class: 'theme-field' }, h('span', null, label), input);
    };
    const fontField = (label: string, key: 'font' | 'headingFont' | 'monoFont') => h('label', { class: 'theme-field' }, h('span', null, label),
      fontButton({ fontName: editing[key] }, c => { if (c.fontName) { change({ [key]: c.fontName } as Partial<MdTheme>); drawForm(); } }, false));

    const name = h('input', { type: 'text', value: editing.name, 'aria-label': 'Theme name' });
    name.addEventListener('change', () => change({ name: name.value.trim() || editing.name }));
    const showBg = h('input', { type: 'checkbox', checked: editing.showBackground });
    showBg.addEventListener('change', () => change({ showBackground: showBg.checked }));

    form.append(
      h('label', { class: 'theme-field wide' }, h('span', null, 'Name'), name),
      fontField('Text font', 'font'), fontField('Heading font', 'headingFont'), fontField('Code font', 'monoFont'),
      num('Text size', 'size', 6, 40, 0.5), num('Line spacing', 'lineHeight', 1, 2.5, 0.05), num('Heading weight', 'headingWeight', 300, 900, 50),
      num('Padding', 'padding', 0, 40, 1), num('Corners', 'radius', 0, 24, 1),
      h('label', { class: 'theme-field wide check-row' }, showBg, 'Show a card behind the note. Off lets the page show through'),
      h('div', { class: 'theme-colours' }, ...COLOUR_FIELDS.map(([key, label]) => h('div', { class: 'theme-colour' },
        colourButton(editing[key] as string, c => change({ [key]: c } as Partial<MdTheme>), label), h('span', null, label)))));
  }

  textarea.addEventListener('input', redrawSample);
  textarea.addEventListener('keydown', e => e.stopPropagation());
  drawList();
  drawForm();
  redrawSample();

  const body = h('div', { class: 'theme-dialog' },
    listBox,
    h('div', { class: 'theme-middle' }, form),
    h('div', { class: 'theme-right' }, stage, h('label', { class: 'muted' }, 'Try your own Markdown'), textarea));
  return openDialog('Markdown themes', body, [
    { label: 'Close', value: false },
    { label: 'Use for new notes', value: true, primary: true },
  ], false, undefined, true).then(useIt => {
    if (useIt) saveSettings({ mdTheme: editing.id });
    return useIt;
  });
}
