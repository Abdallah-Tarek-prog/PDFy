// The main window: document tabs, ribbon, file handling, and all the commands.

import { zipSync, type Zippable } from 'fflate';
import { openPdf, PdfOpenError } from './core/engine';
import { annotBounds, noteRect, remapAnnot } from './core/geometry';
import { buildFile, inspectFile } from './core/jobs';
import { toPdf, uid, type Annot, type BuildOptions, type ImageAsset, type PageRef } from './core/model';
import { Session } from './core/session';
import { compareFiles, diffWords } from './features/compare';
import { exportDocx, exportHtml, exportImages, exportPptx, exportText, exportXlsx, linesOf, toParagraphs, withSavedPdf, type Progress } from './features/convert';
import { addBates, addHeaderFooter, addWatermark, type Pos } from './features/decor';
import { applyRedactions, applyTheme, assetFromBlob, convertAllImages, convertPages, cropImageAnnot, ensureAnalysis, fitSize, makeImageAnnot, pastePlacement, snipRegion } from './features/images';
import { convertImageFile, isDicom, isHeic, readableImage } from './features/decoders';
import { detectFields } from './features/detect';
import { runBatch } from './features/batch';
import { canPrintToPdf, OFFICE_ACCEPT, officeToPrint, printToPdf } from './features/office';
import { applySignature, createDigitalId, readDigitalId, type DigitalId } from './features/sign';
import { openDocxEditor } from './features/docx-editor';
import { runOcr } from './features/ocr';
import { printPdf } from './features/print';
import { addRecent, dropJournal, listJournals, loadAsset, rememberHandle, restoreAnnots, saveJournal, type Journal } from './features/recovery';
import { exportXfdf, importXfdf } from './features/xfdf';
import { confirmSameFile, locateFile, locateHandle, locationProblem, readableHandle } from './features/location';
import { THEME_STYLES } from './theme/presets';
import { alertDialog, askPassword, cameraDialog, confirmDialog, formDialog, openDialog, progressDialog, signatureDialog, type Field, type ProgressHandle } from './ui/dialogs';
import { $, baseName, clear, downloadBlob, h, icon, parseRanges, pickFiles, reportError, safe, toast } from './ui/dom';
import { ImageBar, pasteMode } from './ui/imagebar';
import { getSettings, lastPage, onSettings, rememberPage, saveSettings } from './core/settings';
import { closeMenu, showMenu, type MenuItem } from './ui/menu';
import { Study } from './study/ui';
import { fitMarkdown } from './study/box';
import { mathBoxSize, texToSvg } from './study/math';
import { closeDictionary } from './study/dictpopup';
import { closeWordLayer, reattachWordLayer } from './study/readpicture';
import { colourButton } from './ui/colorpicker';
import { fontButton } from './ui/fontpicker';
import { closeVoicePlayer, recordVoice, showVoicePlayer } from './ui/voice';
import { Panels, type PanelId } from './ui/panels';
import { closeDropdown, showDropdown, ToolRow, windowButtons, type ChromeHooks, type Cmd } from './ui/chrome';
import { createDocumentDialog, insertPageDialog, makePaperPdf } from './ui/createdoc';
import { PageEditor } from './ui/pageeditor';
import { Home, type HomeFile } from './ui/home';
import { openSettings, type SettingsSection } from './ui/settings';
import { maybeShowGuide, showGuide } from './ui/guide';
import { addClosed, listClosed, listCollections, listItems, moveCollectionFile, rememberTabOrder, removeClosed, updateCollection, type ClosedFile, type Collection } from './features/library';
import { keyLabel, match, shortcutsDialog } from './ui/shortcuts';
import { applyUiTheme, currentUiTheme, UI_THEMES } from './ui/themes';
import { isReadingTool, REST_TOOL, Tools, type Tool } from './view/tools';
import { installGestures } from './view/gestures';
import { toScreen, viewportFor } from './core/model';
import { Viewer, type PageView } from './view/viewer';


const COLOURS = ['#111111', '#d92d20', '#f79009', '#ffd400', '#0b8a4f', '#1a56db', '#7a5af8', '#ffffff'];
const STAMPS: [string, string][] = [['APPROVED', '#0b8a4f'], ['REJECTED', '#d92d20'], ['DRAFT', '#1a56db'], ['FINAL', '#0b8a4f'], ['CONFIDENTIAL', '#d92d20'], ['REVIEWED', '#7a5af8'], ['VOID', '#d92d20'], ['COPY', '#475467'], ['FOR COMMENT', '#b54708']];
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const PDF_TYPES: FilePickerType[] =[{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }];
interface PageSpot { session: Session; page: PageRef; point: [number, number] }

function supportsStyle(a: Annot, key: string): boolean {
  if (['whiteout', 'redact', 'link'].includes(a.kind)) return false;
  const text = (a.kind === 'text' || a.kind === 'callout') && !a.markdown;
  switch (key) {
    case 'color': return a.kind !== 'image';
    case 'opacity': return true;
    case 'width': return !['highlight', 'text', 'note', 'stamp', 'image', 'math'].includes(a.kind);
    case 'fill': return ['rect', 'ellipse', 'polygon', 'cloud', 'text', 'callout'].includes(a.kind) && !a.markdown;
    case 'fontSize': return text || !!a.markdown || a.kind === 'math';
    case 'font': case 'fontName': case 'bold': case 'italic': case 'textColor': return text;
    case 'mdTheme': return !!a.markdown;
    default: return false;
  }
}

function styleTool(a: Annot): Tool | null {
  if (a.markdown) return 'markdown';
  if (a.kind === 'ink') return a.marker ? 'marker' : 'pen';
  if (a.kind === 'measure') return a.measureType === 'area' ? 'area' : a.measureType === 'perimeter' ? 'perimeter' : 'distance';
  return ['image', 'math', 'attachment', 'whiteout', 'redact', 'link'].includes(a.kind) ? null : a.kind as Tool;
}
const TOOL_HINTS: Partial<Record<Tool, string>> = {
  hand: 'Drag over text to select it, or blank space to pan. Hold Space to pan anywhere; Ctrl+drag selects objects.',
  snip: 'Drag over any area of the page. It is converted to the opposite theme.',
  redact: 'Drag over what should go. Nothing is removed until you press Apply redactions.',
  crop: 'Drag the area to keep.',
  'cert-box': 'Drag where the signature box should appear.',
  'crop-image': 'Drag over the part of the image to keep.',
  'edit-text': 'Click a line of text. Press Enter when done. The old text stays underneath unless redacted.',
  eraser: 'Drag over pen or marker strokes to remove them.',
  'read-picture': 'Drag over an image, a scan or any part of the page. Each word found can then be clicked.',
  markdown: 'Click on the page, then type. It turns into formatted notes when you click away.',
  polygon: 'Click each corner. Double-click or press Enter to finish.',
  'field-text': 'Drag a box where the text field goes, then name it. Press Escape to go back to Read and type in it.',
  'field-check': 'Drag a small box for the tick box, then name it. In Read, click it to tick.',
  'field-radio': 'Drag a small box for this choice. Give choices of one question the same name.',
  'field-dropdown': 'Drag a box, then type the choices, one per line. In Read, click it to choose.',
  'field-list': 'Drag a box, then type the choices, one per line. In Read, several can be chosen.',
  'field-signature': 'Drag where the signature should go. Others can sign there in their PDF app.',
  polyline: 'Click each point. Double-click or press Enter to finish.',
  cloud: 'Click each corner. Double-click or press Enter to finish.',
  perimeter: 'Click each point. Double-click or press Enter to finish.',
  area: 'Click each corner. Double-click or press Enter to finish.',
};

export class App {
  sessions: Session[] = [];
  session: Session | null = null;
  private nextTabOrder = 0;
  private orderWrites: Promise<unknown> = Promise.resolve();
  private tabGroups = new Map<string, Collection>();
  private collectionRun = 0;
  private ungroupedTabs = new WeakSet<Session>();
  private saves = new Map<Session, { promise: Promise<boolean>; again: boolean; saveAs: boolean }>();
  private closing = new Map<Session, Promise<void>>();
  private reloads = new Map<Session, Promise<void>>();
  private styleChanges: Promise<void> = Promise.resolve();
  viewer!: Viewer;
  tools!: Tools;
  panels!: Panels;
  pageEditor!: PageEditor;
  imageBar!: ImageBar;

  private tabsEl = h('div', {
    class: 'doc-tabs', role: 'tablist',
    ondragover: (e: DragEvent) => this.dragTabOver(e),
    ondrop: (e: DragEvent) => this.dropTab(e),
    ondragleave: (e: DragEvent) => { if (!this.tabsEl.contains(e.relatedTarget as Node | null)) this.clearTabDrop(); },
  });
  private draggedTab: Session | null = null;
  private styleBar = h('div', { class: 'style-bar', 'aria-label': 'Style' });
  private startEl = h('div', { class: 'start' });
  home!: Home;
  /** The Home screen is showing over the open documents. */
  private showingHome = false;
  private homeBtn = h('button', { class: 'icon-btn tab-home', title: 'Home: recent files, recently closed and collections', 'aria-label': 'Home', onclick: () => this.toggleHome() }, icon('home', 15));
  private pageInput = h('input', { class: 'page-input', 'aria-label': 'Page number', inputmode: 'numeric' });
  private pageTotal = h('span', null, '');
  private bookmarkBtn = h('button', { class: 'icon-btn small bm-toggle', 'aria-label': 'Bookmark this page', onclick: () => this.toggleBookmark() }, icon('bookmark', 14));
  private zoomInput = h('input', { class: 'zoom-input', 'aria-label': 'Zoom', inputmode: 'numeric' });
  private memEl = h('span', { title: 'Memory the page is using right now' });
  private statusMsg = h('div', { class: 'status-pill', role: 'status', hidden: true });
  /** A short tip for the current tool, at the bottom, so it never covers the page. */
  private titleText = h('div', { class: 'title-text' });
  /** The + at the end of the document tabs: open a file or create a new document. */
  private addBtn: HTMLButtonElement = h('button', {
    class: 'icon-btn tab-add', title: 'Open or create a document', 'aria-label': 'Open or create a document',
    onclick: () => showDropdown(this.addBtn, { sections: [{ name: 'New tab', items: [
      { icon: 'open', label: 'Browse file', title: 'Open a PDF, picture or Office file', key: 'open', run: () => this.openDialog() },
      { icon: 'newDoc', label: 'Create document', title: 'Blank, lined, grid or dotted pages, or a PDF from pictures', key: 'new', run: () => this.createDocument() },
    ] }] }, this.chromeHooks),
  }, icon('plus', 15));
  private chromeHooks: ChromeHooks = { hasDoc: () => !!this.session, keyFor: id => keyLabel(id) };
  private row = new ToolRow(this.chromeHooks, 'Tools');
  private cmd!: Record<string, Cmd>;
  private journalTimers = new Map<Session, number>();
  private journalOff = new Map<Session, () => void>();
  private clip: { annots: Annot[]; pageId: string } | null = null;
  private stampLabel = 'APPROVED';
  private signature: Annot['image'] | null = null;
  private measure = this.loadMeasure();
  private speaking = false;
  /** Each Read aloud gets a number, so a stopped one never starts talking again when its page text arrives. */
  private speechRun = 0;
  /** The sentence being spoken now, so Stop can end its wait. */
  private speechWait: { run: number; done: () => void } | null = null;
  private speechBar = h('div', { class: 'status-pill speech-bar', role: 'status', hidden: true },
    icon('speak', 14), h('span', null, 'Reading aloud'),
    h('button', { class: 'btn small', title: 'Stop reading (Escape)', onclick: () => this.stopReading() }, 'Stop'));
  reading: 'normal' | 'night' | 'sepia' = 'normal';
  study!: Study;

  constructor(root: HTMLElement) {
    const viewerEl = h('div', { class: 'viewer', tabindex: 0, 'aria-label': 'Document' });
    this.viewer = new Viewer(viewerEl);
    this.tools = new Tools(this.viewer);
    this.panels = new Panels(this);
    this.pageEditor = new PageEditor(this);
    this.home = new Home(this);
    this.startEl.append(this.home.el);
    this.imageBar = new ImageBar(this.viewer, () => this.deleteSelection(), () => {
      this.cropTarget = this.viewer.selection;
      this.tools.setTool('crop-image');
    });
    this.study = new Study(this);
    this.cmd = this.defineCommands();

    // Like Xodo: the app's own title bar (the Windows one is gone), one toolbar row, then the documents.
    root.append(
      h('header', { class: 'titlebar' },
        h('div', { class: 'brand' }, h('img', { src: 'brand/app-icon.svg', width: 20, height: 20, alt: '' }), h('span', null, 'Meletiq PDF')),
        this.titleText,
        windowButtons()),
      h('div', { class: 'toolbar' }, this.row.el),
      h('div', { class: 'tabstrip' }, this.homeBtn, this.tabsEl,
        this.addBtn),
      h('main', { class: 'workspace' }, this.panels.host, h('div', { class: 'stage' }, viewerEl, this.startEl, this.styleBar,
        h('div', { class: 'page-pill', role: 'group', 'aria-label': 'Page' },
          h('button', { class: 'icon-btn small', title: 'Previous page', 'aria-label': 'Previous page', onclick: () => this.viewer.goTo(this.viewer.current - 1) }, icon('chevLeft', 14)),
          this.pageInput, h('span', { class: 'of' }, '/'), this.pageTotal,
          h('button', { class: 'icon-btn small', title: 'Next page', 'aria-label': 'Next page', onclick: () => this.viewer.goTo(this.viewer.current + 1) }, icon('chevRight', 14)),
          h('span', { class: 'pill-sep' }), this.bookmarkBtn),
        h('div', { class: 'zoom-pill', role: 'group', 'aria-label': 'Zoom' },
          h('button', { class: 'icon-btn small', title: 'Fit width', 'aria-label': 'Fit width', onclick: () => this.viewer.setFit('width') }, icon('fitWidth', 14)),
          h('button', { class: 'icon-btn small', title: `Zoom out (${keyLabel('zoom-out')})`, 'aria-label': 'Zoom out', onclick: () => this.zoomBy(0.85) }, icon('zoomOut', 14)),
          this.zoomInput,
          h('button', { class: 'icon-btn small', title: `Zoom in (${keyLabel('zoom-in')})`, 'aria-label': 'Zoom in', onclick: () => this.zoomBy(1.18) }, icon('zoomIn', 14))),
        this.statusMsg, this.speechBar), this.pageEditor.el),
    );

    this.setMode('view');
    // Catch up on redraws skipped while a number box was focused, once focus has really left the bar.
    // Moving within the bar keeps its controls, so Tab and clicks land where they were aimed.
    this.styleBar.addEventListener('focusout', e => {
      if (this.styleBar.contains(e.relatedTarget as Node | null)) return;
      setTimeout(() => { if (!this.styleBar.contains(document.activeElement)) this.drawStyleBar(); }, 0);
    });
    this.drawStyleBar();
    this.wire();
    this.buildSelBar();
    this.refresh();
    void this.drawStart();
    void this.checkRecovery().catch(err => console.warn('Recovery', err)).finally(() => { void maybeShowGuide(); void this.collectionsChanged(); });
    setInterval(() => this.updateMemory(), 3000);
  }

  // ---- Wiring ----

  private wire() {
    const v = this.viewer;
    v.hooks.onScale = s => { this.zoomInput.value = `${Math.round(s * 100)}%`; this.imageBar.sync(); this.tools.syncCursor(); };
    installGestures(v, { drawsWith: type => this.tools.drawsWith(type), cancelDrawing: () => this.tools.cancel() });
    onSettings(() => { this.tools.syncCursor(); this.syncRibbon(); });
    v.hooks.onPage = i => {
      this.pageInput.value = String(i + 1);
      this.panels.change('page');
      this.syncBookmarks();
      const s = this.session;
      if (s?.handle) {
        clearTimeout(this.pageTimer);
        this.pageTimer = window.setTimeout(() => rememberPage(`${s.name}:${s.pages.length}`, i), 800);
      }
    };
    v.hooks.drawMatches = pv => this.drawMatchesOn(pv);
    v.hooks.onMounted = pv => {
      this.drawMatchesOn(pv);
      this.imageBar.sync();
      reattachWordLayer(pv);
      pv.el.classList.toggle('bookmarked', !!this.session?.bookmarks.some(b => b.pageId === pv.page.id));
    };
    this.tools.hooks = {
      onTool: () => this.syncRibbon(),
      onSelection: () => this.onSelection(),
      snip: safe((page: PageRef, rect: Annot['rect']) => this.doSnip(page, rect), 'Theme snip'),
      readPicture: safe((page: PageRef, rect: Annot['rect']) => this.study.readPicture(page, rect), 'Reading the picture'),
      mdTheme: () => getSettings().mdTheme,
      editEquation: safe((v: PageView, a: Annot) => this.study.editEquation(v, a), 'Editing the equation'),
      crop: safe((page: PageRef, rect: Annot['rect']) => this.doCrop(page, rect), 'Crop'),
      certBox: safe((page: PageRef, rect: Annot['rect']) => this.signWithId(page, rect), 'Signing'),
      cropImage: safe((v: PageView, box: { x0: number; y0: number; x1: number; y1: number }) => this.doCropImage(v, box), 'Crop'),
      stampLabel: () => this.stampLabel,
      signatureAsset: () => this.signature,
      attachmentAsset: () => this.pendingAttachment,
      openAttachment: a => this.openAttachment(a),
      askLink: async () => {
        const f = await formDialog('Add link', [{ key: 'url', label: 'Web address', type: 'text', placeholder: 'https://example.com' }], 'Add');
        const url = f ? String(f.url).trim() : '';
        return url ? (/^[a-z]+:/i.test(url) ? url : `https://${url}`) : null;
      },
      askFieldName: type => this.askField(type),
      measure: () => this.measure,
      author: () => this.authorName(),
    };

    this.pageInput.addEventListener('change', () => {
      const n = parseInt(this.pageInput.value, 10);
      if (Number.isFinite(n)) v.goTo(n - 1);
      v.scroller.focus();
    });
    this.zoomInput.addEventListener('change', () => {
      const n = parseFloat(this.zoomInput.value);
      if (Number.isFinite(n)) v.setScale(n / 100);
      v.scroller.focus();
    });

    document.addEventListener('paste', e => safe((ev: ClipboardEvent) => this.onPaste(ev), 'Pasting')(e));
    document.addEventListener('keydown', e => safe((ev: KeyboardEvent) => this.onKey(ev), 'That shortcut')(e));
    document.addEventListener('dragover', e => {
      if ([...(e.dataTransfer?.types ?? [])].includes('Files')) { e.preventDefault(); document.body.classList.add('drag-over'); }
    });
    document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('drag-over'); });
    document.addEventListener('drop', e => safe((ev: DragEvent) => this.onDrop(ev), 'Opening')(e));
    window.addEventListener('beforeunload', e => {
      if (this.sessions.some(s => s.dirty)) {
        // Make sure the very latest edits are recoverable, then ask.
        for (const s of this.sessions) if (s.dirty) void saveJournal(s).catch(() => {});
        e.preventDefault();
      }
    });
    this.viewer.scroller.addEventListener('scroll', () => { this.imageBar.sync(); closeMenu(); }, { passive: true });
    this.viewer.scroller.addEventListener('contextmenu', e => safe((ev: MouseEvent) => this.onPageMenu(ev), 'That menu')(e));
    this.panels.thumbs.onMenu = (e, page) => this.thumbMenu(e, page);
  }

  authorName(): string { return getSettings().author; }

  async settingsDialog(section?: SettingsSection) {
    await openSettings(this, section);
  }

  /** The illustrated tour. Opens by itself the first time and after each update. */
  async showGuide() {
    await showGuide();
  }

  /** Something the study tools changed needs showing again. */
  refreshStudy() {
    this.syncRibbon();
    this.drawStyleBar();
  }

  /** The quick bar over selected text. */
  private selBar = h('div', { class: 'sel-bar', role: 'toolbar', 'aria-label': 'Selected text', hidden: true });

  private showSelBar() {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!sel || !text || !sel.rangeCount || this.tools.tool !== 'hand' || !this.viewer.scroller.contains(sel.anchorNode)) { this.selBar.hidden = true; return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect.width) { this.selBar.hidden = true; return; }
    this.selBar.hidden = false;
    const b = this.selBar.getBoundingClientRect();
    this.selBar.style.left = `${Math.max(6, Math.min(rect.left + rect.width / 2 - b.width / 2, innerWidth - b.width - 6))}px`;
    this.selBar.style.top = `${rect.top - b.height - 8 > 60 ? rect.top - b.height - 8 : rect.bottom + 8}px`;
  }

  private buildSelBar() {
    const act = (ic: string, title: string, run: () => void) => h('button', {
      class: 'ib-btn', title, 'aria-label': title,
      onmousedown: (e: Event) => e.preventDefault(), // Keeps the text selected while clicking.
      onclick: safe(() => { run(); this.selBar.hidden = true; }, title),
    }, icon(ic, 16));
    this.selBar.append(
      act('book', 'Look up this word (Ctrl+L)', () => this.study.lookupSelection()),
      act('highlight', 'Highlight', () => this.tools.markSelection('highlight')),
      act('underline', 'Underline', () => this.tools.markSelection('underline')),
      act('strike', 'Strikeout', () => this.tools.markSelection('strikeout')),
      act('squiggly', 'Squiggly', () => this.tools.markSelection('squiggly')),
      act('redact', 'Mark for redaction', () => this.tools.markSelection('redact')),
      act('copy', 'Copy (Ctrl+C)', () => { void navigator.clipboard?.writeText(window.getSelection()?.toString() ?? ''); }),
    );
    document.body.append(this.selBar);
    this.viewer.scroller.addEventListener('pointerup', () => setTimeout(() => this.showSelBar(), 0));
    this.viewer.scroller.addEventListener('scroll', () => { this.selBar.hidden = true; }, { passive: true });
    document.addEventListener('selectionchange', () => { if (window.getSelection()?.isCollapsed) this.selBar.hidden = true; });
  }

  /** Lines up the selected objects on their shared edge or middle. */
  private align(how: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') {
    const chosen = this.viewer.selectedAnnots();
    const s = this.session;
    if (!chosen || !s || chosen.annots.length < 2) return;
    const vp = viewportFor(chosen.page, 1);
    const boxes = chosen.annots.map(a => {
      const b = annotBounds(a);
      const p0 = toScreen(vp, b[0], b[1]), p1 = toScreen(vp, b[2], b[3]);
      return { a, x0: Math.min(p0[0], p1[0]), x1: Math.max(p0[0], p1[0]), y0: Math.min(p0[1], p1[1]), y1: Math.max(p0[1], p1[1]) };
    });
    const minX = Math.min(...boxes.map(b => b.x0)), maxX = Math.max(...boxes.map(b => b.x1));
    const minY = Math.min(...boxes.map(b => b.y0)), maxY = Math.max(...boxes.map(b => b.y1));
    const det = vp.m[0] * vp.m[3] - vp.m[1] * vp.m[2];
    const pairs = boxes.map(b => {
      const dx = how === 'left' ? minX - b.x0 : how === 'right' ? maxX - b.x1 : how === 'center' ? (minX + maxX) / 2 - (b.x0 + b.x1) / 2 : 0;
      const dy = how === 'top' ? minY - b.y0 : how === 'bottom' ? maxY - b.y1 : how === 'middle' ? (minY + maxY) / 2 - (b.y0 + b.y1) / 2 : 0;
      const px = (vp.m[3] * dx - vp.m[2] * dy) / det, py = (vp.m[0] * dy - vp.m[1] * dx) / det;
      const r = b.a.rect;
      const { ghost: _g, ...rest } = b.a;
      return { before: b.a, after: remapAnnot(rest as Annot, r, [r[0] + px, r[1] + py, r[2] + px, r[3] + py]) };
    });
    s.replaceMany(chosen.page, pairs, 'Align objects');
  }

  onSelection() {
    this.imageBar.sync();
    this.drawStyleBar();
    this.syncRibbon();
  }

  // ---- Ribbon ----

  // ---- Toolbars, laid out like Xodo: Read, Edit and Study modes, and one Actions menu ----

  /** Every command, once. Toolbars and menus pick from this list. */
  private defineCommands(): Record<string, Cmd> {
    const tool = (t: Tool, ic: string, label: string, key?: string, title?: string, aka?: string[]): Cmd => ({
      label, icon: ic, title: TOOL_HINTS[t] ?? title, key, aka, needsDoc: true,
      on: () => this.tools.tool === t,
      run: () => this.tools.setTool(this.tools.tool === t ? REST_TOOL : t),
    });
    const act = (ic: string, label: string, run: () => unknown, title?: string, needsDoc = true, extra: Partial<Cmd> = {}): Cmd => ({ icon: ic, label, run, title, needsDoc, ...extra });
    const panel = (id: PanelId, ic: string, label: string, title: string, key?: string): Cmd => ({
      icon: ic, label, title, key, needsDoc: false, on: () => this.panels.active === id, run: () => this.panels.toggle(id),
    });
    const C: Record<string, Cmd> = {
      // Files
      open: act('open', 'Open', () => this.openDialog(), 'Open a PDF, image or Office file', false, { key: 'open' }),
      new: act('newDoc', 'New', () => this.createDocument(), 'Create a document: blank, lined, grid or dotted pages, or a PDF from pictures', false, { key: 'new', aka: ['Create document'] }),
      save: act('save', 'Save', () => this.save(), undefined, true, { key: 'save' }),
      saveAs: act('saveas', 'Save as', () => this.save(true), 'Save a copy', true, { key: 'save-as' }),
      print: act('print', 'Print', () => this.print(), undefined, true, { key: 'print' }),
      undo: act('undo', 'Undo', () => this.session?.undo(), undefined, true, { key: 'undo', off: () => !this.session?.canUndo }),
      redo: act('redo', 'Redo', () => this.session?.redo(), undefined, true, { key: 'redo', off: () => !this.session?.canRedo }),
      // Modes
      editMode: act('edit', 'Edit', () => this.setMode(this.mode === 'edit' ? 'view' : 'edit'), 'Markup, drawing, Markdown notes, equations and word lookup', true, { key: 'edit-mode', on: () => this.mode === 'edit', aka: ['Study'] }),
      closeMode: act('winClose', 'Close', () => this.setMode('view'), 'Back to reading (Escape)', false),
      // Panels
      pagesPanel: {
        icon: 'thumbs', label: 'Pages', title: 'Arrange pages: rotate, delete, insert and drag to reorder', needsDoc: false,
        on: () => !!this.session && (this.pageEditor.isOpen || this.panels.active === 'thumbs'),
        run: () => { if (getSettings().pagesView === 'sidebar') this.panels.toggle('thumbs'); else this.pageEditor.toggle(); },
      },
      bookmarksPanel: panel('bookmarks', 'bookmark', 'Bookmarks', 'Your bookmarks in this document', 'bookmarks'),
      bookmarkPage: act('bookmarkAdd', 'Bookmark page', () => this.toggleBookmark(), 'Bookmark this page, or remove its bookmark', true, { key: 'bookmark', on: () => this.isBookmarked() }),
      outlinePanel: panel('outline', 'outline', 'Outline', 'Table of contents and bookmarks'),
      commentsPanel: panel('comments', 'comments', 'Comments', 'Every comment and markup in the document'),
      searchPanel: panel('search', 'search', 'Search', 'Find words in the document', 'find'),
      // Edit tools, in Xodo's order
      pan: tool('hand', 'hand', 'Pan', 'pan', 'Select text, move objects, or drag blank space to pan. Hold Space to pan over text'),
      sticky: tool('note', 'sticky', 'Sticky', 'sticky', 'Sticky note comment', ['Note']),
      highlight: tool('highlight', 'highlight', 'Highlight', 'highlight'),
      underline: tool('underline', 'underline', 'Underline', 'underline'),
      strikeout: tool('strikeout', 'strike', 'Strikeout', 'strikeout'),
      squiggly: tool('squiggly', 'squiggly', 'Squiggly', 'squiggly'),
      stamper: act('stamper', 'Stamper', () => this.insertImage(), 'Place an image from a file', true, { key: 'stamper', aka: ['Image file'] }),
      rubberStamp: act('rubberStamp', 'Rubber stamp', () => this.chooseStamp(), 'Choose a stamp, then click on the page to place it.', true, { aka: ['Stamp'], on: () => this.tools.tool === 'stamp' }),
      signature: act('signature', 'Signature', () => this.chooseSignature(), 'Draw, type or upload a signature, then click on the page to place it.', true, { key: 'signature', aka: ['Sign'], on: () => this.tools.tool === 'signature' }),
      ink: tool('pen', 'pen', 'Ink', 'ink', 'Draw freehand', ['Pen']),
      eraser: tool('eraser', 'eraser', 'Eraser', 'eraser', 'Removes ink and marker strokes'),
      marker: tool('marker', 'marker', 'Marker', 'marker'),
      textBox: tool('text', 'text', 'Text box', 'textbox'),
      callout: tool('callout', 'callout', 'Callout'),
      square: tool('rect', 'rect', 'Square', 'square', undefined, ['Rectangle']),
      oval: tool('ellipse', 'ellipse', 'Oval', 'oval', undefined, ['Ellipse']),
      line: tool('line', 'line', 'Line', 'line', 'Hold Shift for straight angles'),
      arrow: tool('arrow', 'arrow', 'Arrow', 'arrow'),
      multiselect: tool('multiselect', 'multiselect', 'Multi-select', 'multiselect', 'Drag a box around objects to select them all'),
      lasso: tool('lasso', 'lasso', 'Lasso', 'lasso', 'Draw around objects to select them'),
      editText: tool('edit-text', 'editText', 'Edit text', undefined, 'Click a line of text on the page to change it'),
      // Inside Edit's drop-downs
      distance: tool('distance', 'ruler', 'Distance'),
      perimeter: tool('perimeter', 'perimeter', 'Perimeter', undefined, 'Click points, double-click to finish'),
      area: tool('area', 'area', 'Area', undefined, 'Click points, double-click to finish'),
      scale: act('scale', 'Scale', () => this.setMeasureScale(), 'Set the real-world scale'),
      polygon: tool('polygon', 'polygon', 'Polygon', undefined, 'Click points, double-click to finish'),
      polyline: tool('polyline', 'polyline', 'Polyline', undefined, 'Click points, double-click to finish'),
      cloud: tool('cloud', 'cloud', 'Cloud', undefined, 'Click points, double-click to finish'),
      markRedact: tool('redact', 'redact', 'Mark redaction', undefined, 'Drag over what should be removed'),
      findRedact: act('searchRedact', 'Find & redact', () => this.panels.show('search'), 'Search, then mark all results'),
      applyRedact: act('check', 'Apply redactions', () => this.applyRedactionsCmd(), 'Permanently remove everything marked'),
      whiteout: tool('whiteout', 'whiteout', 'White-out', undefined, 'Cover part of the page'),
      link: tool('link', 'link', 'Link', undefined, 'Drag a box, then enter a web address'),
      attach: act('attach', 'Attach file', () => this.attachFileCmd(), 'Choose a file, then click on the page to pin it.'),
      voice: act('mic', 'Voice note', () => this.voiceNoteCmd(), 'Record a voice note, then click on the page to pin it. Click the note to play it.'),
      fieldText: tool('field-text', 'field', 'Text field'),
      fieldCheck: tool('field-check', 'checkbox', 'Checkbox'),
      fieldRadio: tool('field-radio', 'radio', 'Radio'),
      fieldDropdown: tool('field-dropdown', 'dropdown', 'Dropdown'),
      fieldList: tool('field-list', 'list', 'List'),
      fieldSign: tool('field-signature', 'signature', 'Signature field'),
      detectFields: act('search', 'Detect fields', () => this.detectFieldsCmd(), 'Find blank lines and boxes and turn them into fields'),
      flattenForms: act('flatten', 'Flatten forms', () => this.flatten(false, true), 'Make form values part of the page'),
      formsHelp: act('info', 'How forms work', () => this.formsHelp(), 'In Read, click a field to fill it in. In Edit, choose a field tool to create one. Save keeps the answers.', false),
      // Study tools
      lookup: act('book', 'Word lookup', () => this.study.toggleLookup(), 'When on, double-click a word on the page to see its meaning, sound and Arabic', false, { key: 'lookup-toggle', on: () => this.study.lookupOn, switch: true }),
      readPicture: tool('read-picture', 'ocr', 'Read picture', 'read-picture', 'Drag over an image or scan, then click any word in it'),
      markdown: tool('markdown', 'markdown', 'Markdown', 'markdown', 'Markdown note: click on the page and type Markdown. It formats when you click away', ['Markdown note']),
      equation: act('sigma', 'Equation', () => this.study.insertEquation(), 'Write an equation in LaTeX, with a live preview', true, { key: 'equation' }),
      pasteImage: act('paste', 'Paste image', () => this.pasteFromClipboard(), 'Paste a copied picture (Ctrl+V)', false),
      themeSnip: tool('snip', 'snip', 'Theme snip', undefined, 'Drag over any area of a page to turn it light or dark'),
      pageTheme: act('pageTheme', 'Page theme', () => this.convertPagesDialog(), 'Turn whole pages light or dark'),
      allImages: act('contrast', 'All images', () => this.convertAllDialog(), 'Convert every image in this document'),
      noteThemes: act('palette', 'Note themes', () => this.study.themesDialog(), 'Fonts, colours and spacing for Markdown notes', false),
      prefs: act('settings', 'Settings', () => this.settingsDialog(), 'Appearance, pen and tablet, study tools, files and every other setting', false, { aka: ['Preferences'] }),
      home: act('home', 'Home', () => this.toggleHome(), 'Recent files, recently closed and collections', false),
      addToCollection: act('folder', 'Add to collection', () => this.addToCollection(), 'Keep this document in a collection on the Home screen'),
      reopenClosed: act('history', 'Reopen closed', () => this.reopenClosed(), 'Open the document you closed last', false, { key: 'reopen-closed' }),
      guide: act('guide', 'Feature guide', () => this.showGuide(), 'A short tour of what Meletiq PDF can do', false),
      // Pages
      rotL: act('rotL', 'Rotate left', () => this.rotatePages(-90)),
      rotR: act('rotR', 'Rotate right', () => this.rotatePages(90)),
      delPages: act('trash', 'Delete', () => this.deletePages(), 'Delete the chosen pages'),
      dupPages: act('copy', 'Duplicate', () => this.duplicatePages(), 'Duplicate the chosen pages'),
      blank: act('plus', 'Blank page', () => this.insertBlank()),
      insertPage: act('newDoc', 'Insert pages', () => this.insertPagesDialog(), 'Blank, lined, grid, dotted or other paper, in any size'),
      pageEditor: act('grid', 'Page editor', () => this.pageEditor.open(), 'All pages full screen: select, rotate, delete, insert and drag to reorder'),
      fromFile: act('insertFile', 'From file', () => this.insertFromFile(), 'Insert pages from a PDF or image after this page'),
      merge: act('merge', 'Merge', () => this.mergeFiles(), 'Add other PDFs to the end', false),
      extract: act('extract', 'Extract', () => this.extractPages(), 'Save some pages as a new file'),
      split: act('split', 'Split', () => this.splitDialog(), 'Break into several files'),
      crop: tool('crop', 'crop', 'Crop', undefined, 'Drag a box to crop to'),
      numbers: act('numbers', 'Page numbers', () => this.pageNumbersDialog()),
      headerFooter: act('header', 'Header & footer', () => this.headerFooterDialog()),
      watermark: act('watermark', 'Watermark', () => this.watermarkDialog()),
      bates: act('bates', 'Bates numbers', () => this.batesDialog()),
      // Convert
      toImages: act('toImage', 'To images', () => this.exportImagesDialog()),
      toText: act('toText', 'To text', () => this.exportAs('txt')),
      toHtml: act('toHtml', 'To HTML', () => this.exportAs('html')),
      toWord: act('word', 'To Word', () => this.exportAs('docx')),
      toExcel: act('excel', 'To Excel', () => this.exportAs('xlsx')),
      toPpt: act('ppt', 'To PowerPoint', () => this.exportAs('pptx')),
      wordEditor: act('word', 'Word editor', () => this.wordEditorCmd(), 'Open and change a Word file, or start a new one', false),
      imagesToPdf: act('imagesToPdf', 'Images to PDF', () => this.imagesToPdf(), undefined, false),
      officeToPdf: act('file', 'Office to PDF', () => this.officeToPdf(), 'Word, Excel or PowerPoint to PDF', false),
      webToPdf: act('link', 'Web to PDF', () => this.webToPdf(), 'Turn a web page into a PDF', false),
      scan: act('camera', 'Scan', () => this.scanCmd(), 'Take pictures with the camera', false),
      convertImage: act('image', 'Convert image', () => this.convertImageCmd(), 'HEIC or DICOM to JPG or PNG', false),
      ocr: act('ocr', 'OCR', () => this.ocrDialog(), 'Make scanned pages searchable'),
      // Protect
      addPassword: act('lock', 'Add password', () => this.passwordDialog()),
      removePassword: act('unlock', 'Remove password', () => this.removePassword()),
      certSign: act('signature', 'Digital signature', () => this.certSignDialog(), 'Sign with a digital ID, which proves the file has not changed. Choose an ID, then drag on the page to place a visible signature.'),
      createId: act('plus', 'Create digital ID', () => this.createIdDialog(), 'Make your own digital ID', false),
      cleanMeta: act('broom', 'Clean metadata', () => this.cleanMetadata(), 'Remove author, dates and other hidden information'),
      properties: act('info', 'Properties', () => this.propertiesDialog()),
      check: act('check', 'Check file', () => this.checkDocument(), 'PDF/A and accessibility check'),
      pdfa: act('file', 'Save as PDF/A', () => this.savePdfA(), 'Archive format'),
      // Tools
      compress: act('compress', 'Compress', () => this.compressDialog()),
      flatten: act('flatten', 'Flatten', () => this.flatten(true, true), 'Make all annotations part of the page'),
      compare: act('compare', 'Compare', () => this.compareDialog(), 'Compare with another PDF'),
      textCompare: act('toText', 'Text compare', () => this.textCompareDialog(), 'Compare two pieces of text', false),
      batch: act('batch', 'Batch', () => this.batchDialog(), 'Do the same job on many PDFs', false),
      exportNotes: act('xfdfOut', 'Export notes', () => this.exportXfdfCmd(), 'Save annotations to an XFDF file'),
      importNotes: act('xfdfIn', 'Import notes', () => this.importXfdfCmd(), 'Load annotations from an XFDF file'),
      // View
      fitWidth: act('fitWidth', 'Fit width', () => this.viewer.setFit('width')),
      fitPage: act('fitPage', 'Fit page', () => this.viewer.setFit('page'), 'Fit whole page', true, { key: 'fit-page' }),
      zoomIn: act('zoomIn', 'Zoom in', () => this.zoomBy(1.18), undefined, true, { key: 'zoom-in' }),
      zoomOut: act('zoomOut', 'Zoom out', () => this.zoomBy(0.85), undefined, true, { key: 'zoom-out' }),
      scroll: act('continuous', 'Scroll', () => this.viewer.setLayout('continuous'), 'Continuous pages', true, { on: () => this.viewer.layout === 'continuous' }),
      onePage: act('single', 'One page', () => this.viewer.setLayout('single'), undefined, true, { on: () => this.viewer.layout === 'single' }),
      twoPages: act('facing', 'Two pages', () => this.viewer.setLayout('facing'), undefined, true, { on: () => this.viewer.layout === 'facing' }),
      normal: act('sun', 'Normal', () => this.setReading('normal'), 'Normal page colours', true, { on: () => this.reading === 'normal' }),
      night: act('moon', 'Night', () => this.setReading('night'), 'Dark pages for reading at night', true, { on: () => this.reading === 'night' }),
      sepia: act('book', 'Sepia', () => this.setReading('sepia'), 'Warm pages for long reading', true, { on: () => this.reading === 'sepia' }),
      reflow: act('reflow', 'Reflow', () => this.reflow(), 'Read as plain text that fits the window'),
      readAloud: act('speak', 'Read aloud', () => this.readAloud(), 'Read from this page, or stop reading', true, { key: 'speech', on: () => this.speaking, switch: true }),
      fullscreen: act('fullscreen', 'Full screen', () => this.fullscreen(), undefined, false, { key: 'fullscreen' }),
      // More
      shortcuts: act('keyboard', 'Keyboard shortcuts', () => this.showHelp(), 'Xodo’s keys, and your own', false, { key: 'help' }),
      about: act('info', 'About and memory', () => this.aboutDialog(), 'Version, and how much memory Meletiq PDF is using', false),
    };
    C.actions = {
      icon: 'actions', label: 'Actions', title: 'Every document tool in one place, with search', key: 'actions', needsDoc: false,
      menu: () => ({
        search: true, wide: true, sections: [
          { name: 'Pages', items: [C.pageEditor, C.rotL, C.rotR, C.delPages, C.dupPages, C.blank, C.insertPage, C.fromFile, C.merge, C.extract, C.split, C.crop, C.numbers, C.headerFooter, C.watermark, C.bates] },
          { name: 'Convert', items: [C.toImages, C.toText, C.toHtml, C.toWord, C.toExcel, C.toPpt, C.wordEditor, C.imagesToPdf, C.officeToPdf, C.webToPdf, C.scan, C.convertImage, C.ocr] },
          { name: 'Protect and sign', items: [C.addPassword, C.removePassword, C.certSign, C.createId, C.findRedact, C.applyRedact, C.cleanMeta, C.properties, C.check, C.pdfa] },
          { name: 'Forms', items: [C.fieldText, C.fieldCheck, C.fieldRadio, C.fieldDropdown, C.fieldList, C.fieldSign, C.detectFields, C.flattenForms, C.formsHelp] },
          { name: 'Tools', items: [C.compress, C.flatten, C.compare, C.textCompare, C.batch, C.exportNotes, C.importNotes, C.pageTheme, C.allImages] },
        ],
      }),
    };
    C.viewMenu = {
      icon: 'view', label: 'View', title: 'Page layout, zoom, page colours, reading and theme', needsDoc: false,
      menu: () => ({
        grouped: true, sections: [
          { name: 'Layout', items: [C.scroll, C.onePage, C.twoPages] },
          { name: 'Zoom', items: [C.fitWidth, C.fitPage, C.zoomIn, C.zoomOut] },
          { name: 'Page colours', items: [C.normal, C.night, C.sepia] },
          { name: 'Reading', items: [C.reflow, C.readAloud, C.fullscreen] },
          { name: 'Interface theme', grid: true, items: UI_THEMES.map(t => ({ icon: t.dark ? 'moon' : 'sun', label: t.name, title: `${t.name} interface theme`, run: () => { applyUiTheme(t.id); this.syncRibbon(); }, on: () => currentUiTheme() === t.id })) },
        ],
      }),
    };
    C.moreMenu = {
      icon: 'more', label: 'More', title: 'Home, collections, settings, shortcuts and the guide', needsDoc: false,
      menu: () => ({ sections: [{ name: 'Meletiq PDF', items: [C.new, C.home, C.addToCollection, C.reopenClosed, C.prefs, C.noteThemes, C.shortcuts, C.guide, C.about] }] }),
    };
    C.measureMenu = { icon: 'measure', label: 'Measure', title: 'Distance, perimeter and area', needsDoc: true, on: () => ['distance', 'perimeter', 'area'].includes(this.tools.tool), menu: () => ({ sections: [{ name: 'Measure', items: [C.distance, C.perimeter, C.area, C.scale] }] }) };
    C.shapesMenu = { icon: 'shapes', label: 'Shapes', title: 'Polygon, polyline and cloud', needsDoc: true, aka: ['Shape to...'], on: () => ['polygon', 'polyline', 'cloud'].includes(this.tools.tool), menu: () => ({ sections: [{ name: 'Shapes', items: [C.polygon, C.polyline, C.cloud] }] }) };
    C.redactMenu = { icon: 'redact', label: 'Redaction', title: 'Remove text and pictures for good', needsDoc: true, on: () => ['redact', 'whiteout'].includes(this.tools.tool), menu: () => ({ sections: [{ name: 'Redaction', items: [C.markRedact, C.findRedact, C.applyRedact, C.whiteout] }] }) };
    C.imageMenu = { icon: 'contrast', label: 'Image theme', title: 'Paste a picture and turn it light or dark', needsDoc: true, aka: ['Theme'], on: () => this.tools.tool === 'snip', menu: () => ({ sections: [{ name: 'Pictures and themes', items: [C.pasteImage, C.themeSnip, C.pageTheme, C.allImages] }] }) };
    C.insertMenu = { icon: 'plus', label: 'Insert', title: 'Links, files and voice notes', needsDoc: true, menu: () => ({ sections: [{ name: 'Insert', items: [C.link, C.attach, C.voice, C.pasteImage, C.stamper] }] }) };
    C.formsMenu = { icon: 'forms', label: 'Forms', title: 'Make form fields. Fill them in from Read', needsDoc: true, on: () => this.tools.tool.startsWith('field-'), menu: () => ({ sections: [{ name: 'Make form fields', items: [C.fieldText, C.fieldCheck, C.fieldRadio, C.fieldDropdown, C.fieldList, C.fieldSign] }, { name: 'More', items: [C.detectFields, C.flattenForms, C.formsHelp] }] }) };
    return C;
  }

  mode: 'view' | 'edit' = 'view';

  /**
   * The toolbar for each mode. Edit follows Xodo's annotation bar, with PDFy's study tools placed
   * beside the text tools, because notes and look-ups are made while marking up.
   */
  private layoutFor(mode: 'view' | 'edit'): { left: (Cmd | '|')[]; right: (Cmd | '|')[] } {
    const C = this.cmd;
    if (mode === 'edit') {
      return {
        left: [C.closeMode, '|', C.pan, '|', C.sticky, C.highlight, C.underline, C.strikeout, C.squiggly, '|', C.ink, C.eraser, C.marker, C.textBox, C.callout, '|',
          C.markdown, C.equation, C.readPicture, C.lookup, '|', C.square, C.oval, C.line, C.arrow, C.measureMenu, C.shapesMenu, '|',
          C.imageMenu, C.stamper, C.rubberStamp, C.signature, '|', C.multiselect, C.lasso, C.redactMenu, C.insertMenu, C.formsMenu, C.editText],
        right: [C.undo, C.redo],
      };
    }
    return {
      left: [C.open, C.save, C.saveAs, C.print, '|', C.actions, '|', C.pan],
      right: [C.undo, C.redo, '|', C.editMode, '|', C.pagesPanel, C.outlinePanel, C.bookmarksPanel, C.commentsPanel, C.searchPanel, '|', C.viewMenu, C.moreMenu],
    };
  }

  /** 'study' is the old name for Edit, from when the study tools had their own toolbar. */
  setMode(asked: 'view' | 'edit' | 'study') {
    const mode = asked === 'study' ? 'edit' : asked;
    closeDropdown();
    if (mode === 'edit') this.pageEditor?.close();
    if (mode !== this.mode) {
      this.tools.finishClickShape();
      this.tools.useReadingTool();
    }
    this.mode = mode;
    document.documentElement.dataset.mode = mode;
    const l = this.layoutFor(mode);
    this.row.set(l.left, l.right);
    this.syncRibbon();
  }

  /**
   * Finds a command by its name wherever it lives (toolbar, a drop-down, or More) and makes it
   * visible, ready to click. Used by the tests, which click the real buttons.
   */
  async revealCommand(label: string): Promise<HTMLButtonElement | null> {
    closeDropdown();
    const startMode = this.mode;
    const found = await this.findCommand(label);
    if (!found && this.mode !== startMode) this.setMode(startMode);
    return found;
  }

  private async findCommand(label: string): Promise<HTMLButtonElement | null> {
    const same = (c: Cmd) => c.label === label || !!c.aka?.includes(label);
    const visible = (root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>('.tb-btn, .dd-item')]
      .find(b => !b.hidden && b.offsetParent !== null && (b.dataset.label === label || (b.dataset.aka ?? '').split('|').includes(label))) ?? null;
    const tick = () => new Promise(r => setTimeout(r, 0));
    for (const mode of [this.mode, 'view', 'edit'] as const) {
      if (mode !== this.mode) this.setMode(mode);
      await tick();
      const direct = visible(this.row.el);
      if (direct) return direct;
      const row = this.row.commands();
      const inRow = row.find(same);
      if (inRow && this.row.isHidden(inRow)) { this.row.overflow().click(); await tick(); const b = visible(document.body); if (b) return b; closeDropdown(); }
      for (const owner of row.filter(c => c.menu)) {
        if (!owner.menu!().sections.some(s => s.items.some(same))) continue;
        if (this.row.isHidden(owner)) {
          // The menu's own button is under More: open More, then that menu.
          this.row.overflow().click();
          await tick();
          [...document.querySelectorAll<HTMLButtonElement>('.dropdown .dd-item')].find(x => x.dataset.label === owner.label)?.click();
        } else {
          this.row.buttonFor(owner)?.click();
        }
        await tick();
        const b = [...document.querySelectorAll<HTMLButtonElement>('.dropdown .dd-item')].find(x => x.dataset.label === label || (x.dataset.aka ?? '').split('|').includes(label));
        if (b) return b;
        closeDropdown();
      }
    }
    return null;
  }

  /** Brings every toolbar button's on/off state in line with the tool, panel and mode in use. */
  syncRibbon() {
    this.row?.sync();
    this.drawStyleBar();
  }

  async aboutDialog() {
    this.updateMemory();
    await openDialog('About Meletiq PDF', h('div', { class: 'form' },
      h('p', null, 'Meletiq PDF: a PDF editor with study tools.'),
      h('p', { class: 'muted' }, this.memEl.textContent || 'Memory figures appear once a document is open.'),
      h('p', { class: 'muted' }, 'Keyboard shortcuts follow Xodo 6.3.4. Offline dictionary from Wiktionary (CC BY-SA).')),
    [{ label: 'Close', value: true, primary: true }], true);
  }

  private drawStyleBar() {
    const sel = this.styleSelection();
    const context = JSON.stringify([this.session?.id, this.tools.tool, this.viewer.selection, [...this.viewer.extra], sel?.annot.kind, !!sel?.annot.markdown]);
    const focused = document.activeElement;
    if (this.styleBar.dataset.context === context && focused instanceof HTMLInputElement && focused.type === 'number' && this.styleBar.contains(focused)) return;
    this.styleBar.dataset.context = context;
    this.drawStyleBarInner();
    this.styleBar.classList.toggle('quiet', !this.styleBar.childElementCount);
  }

  /** A mixed selection uses the most common type; ties follow the main selected object. */
  private styleSelection(): ReturnType<Viewer['selectedAnnot']> {
    const chosen = this.viewer.selectedAnnots();
    if (!chosen) return null;
    const type = (a: Annot) => a.markdown ? 'markdown' : a.kind;
    const counts = new Map<string, number>();
    for (const a of chosen.annots) counts.set(type(a), (counts.get(type(a)) ?? 0) + 1);
    let annot = chosen.annots[0];
    for (const a of chosen.annots) if (counts.get(type(a))! > counts.get(type(annot))!) annot = a;
    return { page: chosen.page, annot };
  }

  private mixedStyle(key: keyof Annot, fallback?: unknown): boolean {
    const values = this.viewer.selectedAnnots()?.annots.filter(a => supportsStyle(a, key)).map(a => a[key] ?? fallback) ?? [];
    return values.some(v => v !== values[0]);
  }

  private drawStyleBarInner() {
    const bar = this.styleBar;
    clear(bar);
    const sel = this.styleSelection();
    const tool = this.tools.tool;
    // Reading with nothing chosen needs no style row, so it stays out of the way, as in Xodo.
    bar.classList.toggle('quiet', this.mode === 'view' && !sel && !this.viewer.extra.size && tool === 'hand');
    if (this.viewer.extra.size) {
      bar.append(h('span', { class: 'style-hint', title: 'Properties follow the most common selected type. Changes apply to selected objects that support that property.' }, `${this.viewer.extra.size + 1} selected`));
      bar.append(h('button', { class: 'btn small', title: 'Align selected objects', onclick: (e: MouseEvent) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        showMenu(r.left, r.bottom, ([['left', 'Left'], ['center', 'Centre'], ['right', 'Right'], ['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']] as const)
          .map(([how, label]) => ({ label, run: () => this.align(how) })));
      } }, 'Align'));
    }
    if (sel && ['image', 'whiteout', 'redact', 'link'].includes(sel.annot.kind)) return;
    if (tool === 'markdown' || sel?.annot.markdown) { this.drawNoteBar(bar, sel); return; }
    if (sel?.annot.kind === 'math') { this.drawEquationBar(bar, sel); return; }
    const showStyle = !!sel || (!['select', 'hand', 'snip', 'read-picture', 'crop', 'crop-image', 'cert-box', 'edit-text', 'eraser', 'redact', 'whiteout', 'link'].includes(tool) && !tool.startsWith('field-'));
    if (!showStyle) return;

    const style = sel ? { color: sel.annot.color, width: sel.annot.width, opacity: sel.annot.opacity, fill: sel.annot.fill ?? null, fontSize: sel.annot.fontSize ?? 12 } : this.tools.style(tool);
    const kind = sel?.annot.kind ?? tool;
    const apply = (patch: Partial<Annot>) => { void this.applyStyle(patch).catch(err => reportError('Changing style', err)); };

    const swatches = h('div', { class: 'swatches', role: 'group', 'aria-label': 'Colour' }, ...COLOURS.map(c => h('button', {
      class: `swatch-btn${!this.mixedStyle('color') && style.color.toLowerCase() === c ? ' active' : ''}`, style: { background: c }, title: c, 'aria-label': `Colour ${c}`,
      onclick: () => apply({ color: c, ...(kind === 'text' || kind === 'callout' ? { textColor: c } : {}) }),
    })));
    swatches.append(colourButton(style.color, c => apply({ color: c, ...(kind === 'text' || kind === 'callout' ? { textColor: c } : {}) }), 'Any colour'));
    bar.append(swatches);

    const isStroke = !['highlight', 'text', 'note', 'stamp'].includes(kind);
    if (isStroke) {
      const w = h('input', { type: 'number', min: 0.25, max: 40, step: 0.25, value: this.mixedStyle('width') ? '' : style.width, placeholder: 'Mixed', style: { width: '58px' } });
      w.addEventListener('change', () => apply({ width: Math.max(0.25, +w.value || 1) }));
      bar.append(h('label', null, 'Thickness', w));
    }
    const op = h('select', null, ...[100, 80, 60, 40, 25].map(p => h('option', { value: p / 100, selected: Math.abs(style.opacity - p / 100) < 0.11 }, `${p}%`)));
    if (this.mixedStyle('opacity')) { op.prepend(h('option', { value: '', selected: true }, 'Mixed')); op.value = ''; }
    op.addEventListener('change', () => apply({ opacity: +op.value }));
    bar.append(h('label', null, 'Opacity', op));
    if (kind === 'text' || kind === 'callout') {
      const cur = sel?.annot ?? this.tools.style(tool);
      const font = fontButton({ fontName: cur.fontName, font: cur.font }, c => apply({ fontName: c.fontName, font: c.font ?? cur.font }));
      if (this.mixedStyle('fontName') || this.mixedStyle('font', 'helvetica')) font.textContent = 'Mixed';
      bar.append(h('label', null, 'Font', font));
      const bold = !!cur.bold && !this.mixedStyle('bold', false), italic = !!cur.italic && !this.mixedStyle('italic', false);
      bar.append(h('button', { class: `style-toggle${bold ? ' active' : ''}`, title: 'Bold', 'aria-pressed': this.mixedStyle('bold', false) ? 'mixed' : String(bold), onclick: () => apply({ bold: !bold }) }, h('b', null, 'B')));
      bar.append(h('button', { class: `style-toggle${italic ? ' active' : ''}`, title: 'Italic', 'aria-pressed': this.mixedStyle('italic', false) ? 'mixed' : String(italic), onclick: () => apply({ italic: !italic }) }, h('i', null, 'I')));
      const fs = h('input', { type: 'number', min: 4, max: 200, step: 1, value: this.mixedStyle('fontSize', 12) ? '' : style.fontSize, placeholder: 'Mixed', style: { width: '58px' } });
      fs.addEventListener('change', () => apply({ fontSize: Math.max(4, +fs.value || 12) }));
      bar.append(h('label', null, 'Size', fs));
    }
    if (['rect', 'ellipse', 'polygon', 'cloud', 'text', 'callout'].includes(kind)) {
      const on = h('input', { type: 'checkbox', checked: !!style.fill });
      on.indeterminate = this.mixedStyle('fill', null);
      let fillNow = style.fill ?? '#ffffff';
      on.addEventListener('change', () => apply({ fill: on.checked ? fillNow : null }));
      bar.append(h('label', null, on, 'Fill'), colourButton(fillNow, c => { fillNow = c; apply({ fill: c }); }, 'Fill colour'));
    }
  }

  /** Controls for a Markdown note: its theme and text size. */
  private drawNoteBar(bar: HTMLElement, sel: ReturnType<Viewer['selectedAnnot']>) {
    const note = sel?.annot;
    const change = (patch: Partial<Annot>) => {
      if (sel && note) void this.applyStyle(patch).catch(err => reportError('Changing the note', err));
    };
    bar.append(h('label', null, 'Theme', this.study.themeSelect(note?.mdTheme, id => {
      if (note) change({ mdTheme: id });
      else { saveSettings({ mdTheme: id }); }
    })));
    const size = h('input', { type: 'number', min: 6, max: 72, step: 1, value: note?.fontSize ?? this.tools.style('markdown').fontSize, style: { width: '58px' } });
    size.addEventListener('change', () => {
      const v = Math.max(6, +size.value || 12);
      if (note) change({ fontSize: v }); else this.tools.setStyle({ fontSize: v }, 'markdown');
    });
    bar.append(h('label', null, 'Size', size));
    bar.append(h('button', { class: 'btn small', onclick: safe(() => this.study.themesDialog(note?.mdTheme), 'Themes') }, 'Edit themes…'));
    if (note && !this.viewer.extra.size) {
      const v = this.viewer.views.get(sel!.page.id);
      if (v) bar.append(h('button', { class: 'btn small', onclick: () => this.tools.openEditor(v, note, false) }, 'Edit Markdown'));
    }
  }

  /** Controls for a selected equation. */
  private drawEquationBar(bar: HTMLElement, sel: NonNullable<ReturnType<Viewer['selectedAnnot']>>) {
    const a = sel.annot;
    const change = (patch: Partial<Annot>) => { void this.applyStyle(patch).catch(err => reportError('Changing the equation', err)); };
    bar.append(h('label', null, 'Colour', colourButton(a.color, c => change({ color: c }), 'Equation colour')));
    const size = h('input', { type: 'number', min: 6, max: 96, step: 1, value: a.fontSize ?? 18, style: { width: '58px' } });
    size.addEventListener('change', () => change({ fontSize: Math.max(6, +size.value || 18) }));
    bar.append(h('label', null, 'Size', size));
    const v = this.viewer.views.get(sel.page.id);
    if (v && !this.viewer.extra.size) bar.append(h('button', { class: 'btn small', onclick: safe(() => this.study.editEquation(v, a), 'Editing the equation') }, 'Edit equation'));
  }

  private applyStyle(patch: Partial<Annot>): Promise<void> {
    const chosen = this.viewer.selectedAnnots(), session = this.session;
    const tool = this.tools.tool;
    const next = this.styleChanges.then(() => this.changeStyle(patch, session, chosen, tool));
    this.styleChanges = next.catch(() => {});
    return next;
  }

  private async changeStyle(patch: Partial<Annot>, session: Session | null, chosen: ReturnType<Viewer['selectedAnnots']>, tool: Tool) {
    if (chosen && session) {
      if (!this.sessions.includes(session) || !session.pages.includes(chosen.page)) return;
      const annots = chosen.annots.map(a => chosen.page.annots.find(current => current.id === a.id)).filter((a): a is Annot => !!a);
      const pairs = await Promise.all(annots.map(async before => {
        const changes = Object.fromEntries(Object.entries(patch).filter(([key]) => supportsStyle(before, key))) as Partial<Annot>;
        if (!Object.keys(changes).length) return null;
        if (changes.color && supportsStyle(before, 'textColor')) changes.textColor = changes.color;
        const { ghost: _g, ...rest } = before;
        let after: Annot = { ...rest, ...changes };
        if (after.markdown && (changes.fontSize !== undefined || changes.mdTheme !== undefined)) after = await fitMarkdown(after);
        if (after.kind === 'math' && changes.fontSize !== undefined) {
          const math = await texToSvg(after.latex ?? '', after.mathDisplay !== false), size = mathBoxSize(math, changes.fontSize);
          const cx = (before.rect[0] + before.rect[2]) / 2, cy = (before.rect[1] + before.rect[3]) / 2;
          after = { ...after, mathSvg: math.svg, rect: [cx - size.w / 2, cy - size.h / 2, cx + size.w / 2, cy + size.h / 2] };
        }
        return { before, after, changes };
      }));
      const edits = pairs.filter(p => p !== null);
      if (!edits.length || !this.sessions.includes(session) || !session.pages.includes(chosen.page) || edits.some(p => chosen.page.annots.find(a => a.id === p.before.id) !== p.before)) { this.drawStyleBar(); return; }
      session.replaceMany(chosen.page, edits, 'Change style');
      // Selection edits also become the defaults for the next item of each affected type.
      const remembered = new Set<Tool>();
      for (const { after, changes } of edits) {
        const tool = styleTool(after);
        if (tool && !remembered.has(tool)) {
          remembered.add(tool);
          const { textColor: _tc, mdTheme: _md, ...defaults } = changes;
          this.tools.setStyle(defaults as never, tool);
        }
      }
      if (patch.mdTheme !== undefined) saveSettings({ mdTheme: patch.mdTheme });
    } else {
      this.tools.setStyle(patch as never, tool);
    }
    this.drawStyleBar();
  }

  // ---- Documents and tabs ----

  private drawTabs() {
    const scroll = this.tabsEl.scrollLeft;
    const focusedGroup = document.activeElement?.closest<HTMLElement>('.tab-group')?.dataset.collectionId;
    clear(this.tabsEl);
    const containers = new Map<string, HTMLElement>();
    for (const s of this.sessions) {
      let container: HTMLElement = this.tabsEl;
      const group = s.collectionId ? this.tabGroups.get(s.collectionId) : undefined;
      if (group) {
        let existing = containers.get(group.id);
        if (!existing) {
          const members = this.sessions.filter(item => item.collectionId === group.id);
          const toggle = h('button', {
            class: 'tab-group-toggle', type: 'button', 'aria-expanded': String(!group.collapsed),
            'aria-label': `${group.collapsed ? 'Expand' : 'Collapse'} ${group.name}, ${members.length} document${members.length === 1 ? '' : 's'}`,
            title: `${group.name}: click to ${group.collapsed ? 'expand' : 'collapse'}. Right-click for group actions.`,
            onclick: () => { group.collapsed = !group.collapsed; void updateCollection(group); this.drawTabs(); },
            oncontextmenu: (e: MouseEvent) => { e.preventDefault(); this.collectionMenu(e, group); },
          }, icon(group.collapsed ? 'chevRight' : 'chevDown', 12), h('span', { class: 'tab-group-name' }, group.name), h('span', { class: 'tab-group-count' }, String(members.length)));
          existing = h('div', { class: `tab-group${group.collapsed ? ' collapsed' : ''}${members.includes(this.session!) ? ' has-active' : ''}`, role: 'group', 'aria-label': group.name, 'data-collection-id': group.id }, toggle);
          existing.style.setProperty('--group-colour', group.colour);
          containers.set(group.id, existing);
          this.tabsEl.append(existing);
        }
        container = existing;
      }
      const tab = h('div', {
        class: `doc-tab${s === this.session ? ' active' : ''}`, role: 'tab', 'aria-selected': String(s === this.session), tabindex: 0,
        'data-session-id': s.id, draggable: true, title: `${s.name}\nDrag to reorder. Ctrl+Shift+Left/Right moves this tab.`,
        onclick: () => { this.hideHome(); this.activate(s); },
        oncontextmenu: (e: MouseEvent) => { e.preventDefault(); this.tabMenu(e, s); },
        onpointerdown: (e: PointerEvent) => { tab.draggable = !(e.target as Element).closest('button'); },
        ondragstart: (e: DragEvent) => {
          if (!e.dataTransfer) return;
          this.draggedTab = s;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('application/x-pdfy-tab', s.id);
          tab.classList.add('dragging');
        },
        ondragend: () => {
          this.draggedTab = null;
          tab.classList.remove('dragging');
          this.clearTabDrop();
        },
        onkeydown: (e: KeyboardEvent) => {
          if (e.target !== tab || !e.ctrlKey || !e.shiftKey || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
          e.preventDefault();
          e.stopPropagation();
          this.moveTab(s, this.sessions.indexOf(s) + (e.key === 'ArrowLeft' ? -1 : 1));
        },
      },
      s.dirty ? h('span', { class: 'dot', title: 'Unsaved changes' }) : null,
      h('span', { class: 'name' }, s.name),
      h('button', { class: 'icon-btn small', draggable: false, title: 'Close', 'aria-label': `Close ${s.name}`, onclick: safe((e: Event) => { e.stopPropagation(); return this.closeSession(s); }, 'Closing') }, icon('close', 13)));
      container.append(tab);
    }
    this.tabsEl.scrollLeft = scroll;
    if (focusedGroup) this.tabsEl.querySelector<HTMLButtonElement>(`[data-collection-id="${CSS.escape(focusedGroup)}"] .tab-group-toggle`)?.focus({ preventScroll: true });
  }

  private clearTabDrop() {
    for (const tab of this.tabsEl.querySelectorAll('.drop-before, .drop-after')) tab.classList.remove('drop-before', 'drop-after');
    for (const group of this.tabsEl.querySelectorAll('.drop-target')) group.classList.remove('drop-target');
  }

  private tabDropIndex(x: number) {
    const next = [...this.tabsEl.querySelectorAll<HTMLElement>('.doc-tab')].find(tab => {
      const box = tab.getBoundingClientRect(); return box.width > 0 && x < box.left + box.width / 2;
    });
    return next ? this.sessions.findIndex(s => s.id === next.dataset.sessionId) : this.sessions.length;
  }

  private dragTabOver(e: DragEvent) {
    if (!this.draggedTab) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    this.clearTabDrop();
    const group = (e.target as Element).closest<HTMLElement>('.tab-group');
    if (group) group.classList.add('drop-target');
    const slot = this.tabDropIndex(e.clientX);
    const target = this.sessions[Math.min(slot, this.sessions.length - 1)];
    this.tabsEl.querySelector(`[data-session-id="${target?.id}"]`)?.classList.add(slot === this.sessions.length ? 'drop-after' : 'drop-before');
  }

  private dropTab(e: DragEvent) {
    const source = this.draggedTab;
    if (!source) return;
    e.preventDefault();
    e.stopPropagation();
    const from = this.sessions.indexOf(source), slot = this.tabDropIndex(e.clientX);
    this.draggedTab = null;
    this.clearTabDrop();
    const group = (e.target as Element).closest<HTMLElement>('.tab-group')?.dataset.collectionId ?? null;
    if ((source.collectionId ?? null) !== group) {
      void this.moveToCollection(source, group).then(moved => { if (moved) this.moveTab(source, slot - (from < slot ? 1 : 0)); }).catch(err => reportError('Moving tab', err));
      return;
    }
    this.moveTab(source, slot - (from < slot ? 1 : 0));
  }

  private moveTab(session: Session, index: number) {
    const from = this.sessions.indexOf(session);
    if (from < 0) return;
    const to = Math.max(0, Math.min(this.sessions.length - 1, index));
    if (from === to) return;
    const focused = this.tabsEl.contains(document.activeElement);
    this.sessions.splice(from, 1);
    this.sessions.splice(to, 0, session);
    this.keepCollectionTabsTogether();
    this.updateTabOrder();
    void this.rememberOpenTabs().then(() => { if (this.showingHome) void this.home.draw(); });
    this.drawTabs();
    if (focused) {
      const moved = this.tabsEl.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(session.id)}"]`);
      moved?.focus({ preventScroll: true });
      moved?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  private updateTabOrder() {
    for (const s of this.sessions) s.tabOrder = this.nextTabOrder = Math.max(Date.now(), this.nextTabOrder + 1);
  }

  /** Every opening route uses the same natural A–Z order; collection members stay together. */
  private sortOpenedTabs() {
    this.sessions.sort((a, b) => byName.compare(a.name, b.name));
    this.keepCollectionTabsTogether();
    this.updateTabOrder();
  }

  private keepCollectionTabsTogether() {
    const groups = new Map<string, Session[]>();
    for (const s of this.sessions) if (s.collectionId) {
      const members = groups.get(s.collectionId) ?? [];
      members.push(s); groups.set(s.collectionId, members);
    }
    const placed = new Set<string>();
    this.sessions = this.sessions.flatMap(s => {
      if (!s.collectionId) return [s];
      if (placed.has(s.collectionId)) return [];
      placed.add(s.collectionId);
      return groups.get(s.collectionId)!;
    });
  }

  /** Refresh saved group names, colours and membership after library changes. */
  async collectionsChanged() {
    const run = ++this.collectionRun;
    const groups = await listCollections();
    const items = (await Promise.all(groups.map(c => listItems(c.id)))).flat();
    const assignments = await Promise.all(this.sessions.map(async session => {
      const ids: string[] = [];
      if (session.handle && !this.ungroupedTabs.has(session)) {
        for (const item of items) {
          if (item.name === session.handle.name && await session.handle.isSameEntry(item.handle).catch(() => false)) ids.push(item.collection);
        }
      }
      return { session, id: session.collectionId && ids.includes(session.collectionId) ? session.collectionId : ids[0] ?? null };
    }));
    if (run !== this.collectionRun) return;
    const previousGroup = this.session?.collectionId;
    this.tabGroups = new Map(groups.map(c => [c.id, c]));
    for (const { session, id } of assignments) if (this.sessions.includes(session)) session.collectionId = id;
    const activeGroup = this.session?.collectionId ? this.tabGroups.get(this.session.collectionId) : undefined;
    if (activeGroup?.collapsed && activeGroup.id !== previousGroup) {
      activeGroup.collapsed = false; void updateCollection(activeGroup);
    }
    this.keepCollectionTabsTogether();
    this.drawTabs();
  }

  private async moveToCollection(session: Session, id: string | null): Promise<boolean> {
    if (!this.sessions.includes(session)) return false;
    if (!session.handle) { toast('Save the document first to put it in a collection.', 'info'); return false; }
    if (id && !this.tabGroups.has(id)) return false;
    if (!await moveCollectionFile(session.name, session.handle, session.collectionId, id, session.pages.length)) {
      toast('The tab could not be moved. Try again.', 'error'); return false;
    }
    session.collectionId = id;
    if (id) this.ungroupedTabs.delete(session); else this.ungroupedTabs.add(session);
    await this.collectionsChanged();
    this.updateTabOrder();
    await this.rememberOpenTabs();
    return true;
  }

  private collectionMenu(e: MouseEvent, group: Collection) {
    showMenu(e.clientX, e.clientY, [
      { label: group.collapsed ? 'Expand group' : 'Collapse group', icon: group.collapsed ? 'chevRight' : 'chevDown', run: () => {
        group.collapsed = !group.collapsed; void updateCollection(group); this.drawTabs();
      } },
      { label: 'Rename or colour…', icon: 'edit', run: () => this.home.editCollection(group) },
      { label: 'Close group', icon: 'close', run: async () => {
        for (const s of this.sessions.filter(s => s.collectionId === group.id)) {
          await this.closeSession(s);
          if (this.sessions.includes(s)) break;
        }
      } },
    ]);
  }

  rememberOpenTabs(): Promise<unknown> {
    const order = this.sessions.filter(s => s.handle).map(s => ({ handle: s.handle!, order: s.tabOrder }));
    this.orderWrites = this.orderWrites.then(() => rememberTabOrder(order));
    return this.orderWrites;
  }

  private refresh() {
    const s = this.session;
    if (!s) this.showingHome = false;
    this.startEl.hidden = !!s && !this.showingHome;
    // Home fills the whole area, so the side lists step aside while it shows.
    this.panels.host.classList.toggle('behind-home', !this.startEl.hidden);
    this.homeBtn.classList.toggle('active', !this.startEl.hidden);
    this.viewer.scroller.style.visibility = s ? 'visible' : 'hidden';
    this.drawTabs();
    this.syncRibbon();
    this.pageInput.value = s ? String(this.viewer.current + 1) : '';
    this.pageTotal.textContent = s ? String(s.pages.length) : '–';
    this.pageInput.disabled = !s;
    this.zoomInput.disabled = !s;
    this.bookmarkBtn.disabled = !s;
    this.syncBookmarks();
    document.title = s ? `${s.name}${s.dirty ? ' •' : ''} – Meletiq PDF` : 'Meletiq PDF';
    this.titleText.textContent = s ? `${s.name}${s.dirty ? ' •' : ''}` : '';
    this.updateMemory();
  }

  private updateMemory() {
    const m = performance.memory;
    const mb = m ? Math.round(m.usedJSHeapSize / 1048576) : 0;
    const pages = this.viewer.views.size;
    this.memEl.textContent = m && this.session ? `Meletiq PDF is using ${mb} MB of memory, with ${pages} page${pages === 1 ? '' : 's'} drawn.`
      : m ? `Meletiq PDF is using ${mb} MB of memory.` : '';
  }

  add(session: Session) {
    this.showingHome = false;
    session.tabOrder = this.nextTabOrder = Math.max(Date.now(), this.nextTabOrder + 1);
    this.sessions.push(session);
    this.sortOpenedTabs();
    this.listen(session);
    this.activate(session);
  }

  /** Keeps the screen and the recovery copy in step with one document's changes. */
  private listen(session: Session) {
    this.journalOff.set(session, session.on(c => {
      if (session === this.session) {
        if (c.kind !== 'meta') this.panels.change(c.kind);
        if (c.kind === 'structure') {
          const sel = this.viewer.selectedAnnot();
          if (!sel) this.viewer.select(null);
        }
        this.refresh();
        this.imageBar.sync();
      }
      this.scheduleJournal(session);
    }));
  }

  /** Stops following a document that is leaving its tab, and drops its recovery copy. */
  private unlisten(session: Session) {
    this.journalOff.get(session)?.();
    this.journalOff.delete(session);
    clearTimeout(this.journalTimers.get(session));
    this.journalTimers.delete(session);
    void dropJournal(session.id);
  }

  activate(session: Session | null) {
    const group = session?.collectionId ? this.tabGroups.get(session.collectionId) : undefined;
    if (group?.collapsed) {
      group.collapsed = false; void updateCollection(group);
      if (session === this.session) this.drawTabs();
    }
    if (session === this.session && session) return;
    this.stopReading();
    this.tools.cancel();
    this.tools.commitEdit();
    closeWordLayer();
    closeDictionary();
    closeVoicePlayer();
    this.session = session;
    this.viewer.attach(session);
    this.panels.attach(session);
    this.pageEditor.attach();
    this.imageBar.sync();
    this.refresh();
    if (session) this.zoomInput.value = `${Math.round(this.viewer.scale * 100)}%`;
    void this.drawStart();
  }

  private scheduleJournal(session: Session) {
    clearTimeout(this.journalTimers.get(session));
    this.journalTimers.set(session, window.setTimeout(() => {
      this.journalTimers.delete(session);
      if (!this.sessions.includes(session)) return;
      if (session.dirty) saveJournal(session).catch(err => console.warn('Recovery save', err));
      else void dropJournal(session.id);
    }, 2500));
  }

  closeSession(session: Session): Promise<void> {
    const current = this.closing.get(session);
    if (current) return current;
    if (!this.sessions.includes(session)) return Promise.resolve();
    const closing = this.closeSessionOnce(session).finally(() => this.closing.delete(session));
    this.closing.set(session, closing);
    return closing;
  }

  private async closeSessionOnce(session: Session) {
    if (this.session === session) await this.tools.settle();
    await this.styleChanges;
    await this.saves.get(session)?.promise;
    if (!this.sessions.includes(session)) return;
    if (this.session === session) await this.tools.settle();
    if (session.dirty) {
      this.activate(session);
      const choice = await openDialog<'save' | 'discard' | 'cancel'>('Unsaved changes', h('p', null, `Save your changes to "${session.name}" before closing?`),
        [{ label: 'Cancel', value: 'cancel' }, { label: "Don't save", value: 'discard' }, { label: 'Save', value: 'save', primary: true }], 'cancel');
      if (choice === 'cancel') return;
      if (choice === 'save') {
        const ok = await this.saveSession(session);
        if (this.session === session) await this.tools.settle();
        if (!ok || session.dirty) return;
      }
    }
    // File/drop/clipboard opens can provide a File without a persistent disk handle.
    // Remember its name and position too; reopening will ask the user to choose that file.
    const openedFile = [...session.sources.values()].some(source => source.fileBacked || source.blob instanceof File);
    if (session.handle || openedFile) {
      const recorded = await addClosed(session.name, session.handle, session === this.session ? this.viewer.current : lastPage(`${session.name}:${session.pages.length}`), session.pages.length, session.tabOrder);
      if (!recorded) toast(`“${session.name}” closed, but its history entry could not be saved.`, 'error');
    }
    const i = this.sessions.indexOf(session);
    if (i < 0) return;
    this.sessions.splice(i, 1);
    this.unlisten(session);
    const next = this.sessions[Math.min(i, this.sessions.length - 1)] ?? null;
    if (this.session === session) this.activate(next);
    await session.close();
    this.refresh();
  }

  /** The window is closing. Offers to save each unsaved document. False means the user cancelled. */
  async closeAllForExit(): Promise<boolean> {
    await Promise.all([...this.saves.values()].map(job => job.promise));
    for (const s of [...this.sessions]) {
      await this.closeSession(s);
      if (this.sessions.includes(s)) return false;
    }
    return true;
  }

  // ---- Opening ----

  async openDialog() {
    if (window.showOpenFilePicker) {
      let handles: FileSystemFileHandle[];
      try {
        handles = await window.showOpenFilePicker({
          multiple: true,
          types: [{ description: 'PDF, images and Office files', accept: { 'application/pdf': ['.pdf'], 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.heic', '.heif'], 'application/dicom': ['.dcm'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'], 'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'] } }],
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        throw err;
      }
      for (const handle of handles.sort((a, b) => byName.compare(a.name, b.name))) await this.openHandle(handle);
      return;
    }
    const files = await pickFiles('.pdf,image/*', true);
    for (const f of files.sort((a, b) => byName.compare(a.name, b.name))) await this.openFile(f);
  }

  async openHandle(handle: FileSystemFileHandle, page?: number) {
    const allowed = await readableHandle(handle);
    if (!allowed) { toast(`File access was not granted for “${handle.name}”.`, 'info'); return; }
    handle = allowed;
    let file: File;
    try { file = await handle.getFile(); }
    catch { toast(`"${handle.name}" could not be read. It may have moved.`, 'error'); return; }
    rememberHandle(file, handle);
    this.hideHome();
    await this.openFile(file, handle);
    if (page !== undefined && this.session?.handle && this.session.name === handle.name && page < this.session.pages.length) this.viewer.goTo(page);
  }

  async openFile(file: File, handle: FileSystemFileHandle | null = null) {
    if (/\.(docx|xlsx|pptx)$/i.test(file.name)) {
      await this.openOffice(file);
      return;
    }
    if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name) || isHeic(file) || isDicom(file)) {
      await this.pasteImages([file], file.name);
      return;
    }
    await this.openPdfBlob(file, file.name, handle);
  }

  async openPdfBlob(blob: Blob, name: string, handle: FileSystemFileHandle | null = null): Promise<Session | null> {
    if (handle) {
      for (const existing of this.sessions) {
        if (!existing.handle) continue;
        const sameFile = existing.handle === handle || await existing.handle.isSameEntry(handle).catch(() => false);
        if (sameFile) { this.hideHome(); this.activate(existing); return existing; }
      }
    }
    const session = new Session(name);
    session.handle = handle;
    try {
      this.setStatus(`Opening ${name}…`);
      session.pages = await session.addSource(blob, name, retry => askPassword(name, retry));
    } catch (err) {
      await session.close();
      if (err instanceof PdfOpenError && err.kind === 'password-cancelled') return null;
      await alertDialog('Could not open', `${name}\n\n${(err as Error).message}`);
      return null;
    } finally {
      this.setStatus('');
    }
    await this.importBookmarks(session);
    this.add(session);
    if (handle) await this.collectionsChanged();
    if (handle) {
      void addRecent(name, handle, session.pages.length);
      const at = getSettings().reopenAtLastPage ? lastPage(`${name}:${session.pages.length}`) : 0;
      if (at > 0 && at < session.pages.length) this.viewer.goTo(at);
    }
    return session;
  }

  setStatus(t: string) { this.statusMsg.textContent = t; this.statusMsg.hidden = !t; }

  newDocument(): Session {
    const s = new Session('Untitled.pdf');
    s.pages = [s.blankPage(595, 842)];
    this.add(s);
    return s;
  }

  /** The Create document window, then the new document opens in its own tab. */
  async createDocument() {
    const r = await createDocumentDialog();
    if (!r) return;
    const name = /\.pdf$/i.test(r.title) ? r.title : `${r.title}.pdf`;
    if (r.kind === 'blank') {
      const s = await this.openPdfBlob(makePaperPdf(r), name);
      if (s) { s.markDirty(); }
      return;
    }
    const s = new Session(name);
    const pages: PageRef[] = [];
    await this.withProgress('Making the PDF', async p => {
      for (let i = 0; i < r.files.length; i++) {
        if (p.cancelled()) break;
        p.set(i / r.files.length, `Picture ${i + 1} of ${r.files.length}`);
        try { pages.push(await this.imagePage(s, r.files[i], r.fit === 'image' ? null : r.fit, r.margin)); }
        catch { toast(`${r.files[i].name} could not be read.`, 'error'); }
      }
    });
    if (!pages.length) { await s.close(); return; }
    s.pages = pages;
    s.markDirty();
    this.add(s);
    toast(`Made ${pages.length} page${pages.length > 1 ? 's' : ''}.`, 'ok');
  }

  /** New pages of any paper, from the page editor's + button or the Pages menu. */
  async insertPagesDialog(at = this.viewer.current) {
    const s = this.session;
    if (!s) return;
    const cur = s.pages[Math.min(at, s.pages.length - 1)];
    const vp = cur ? viewportFor(cur, 1) : { width: 595, height: 842 };
    const r = await insertPageDialog({ w: vp.width, h: vp.height }, at + 1);
    if (!r) return;
    const added = await s.addSource(makePaperPdf({ title: 'Pages', ...r }), 'New pages.pdf');
    const pos = r.where === 'end' ? s.pages.length : r.where === 'before' ? at : at + 1;
    const next = [...s.pages];
    next.splice(pos, 0, ...added);
    s.setPages(next, added.length > 1 ? 'Insert pages' : 'Insert page');
    this.viewer.goTo(pos);
    toast(`Added ${added.length} page${added.length > 1 ? 's' : ''}.`, 'ok');
  }

  private async onDrop(e: DragEvent) {
    document.body.classList.remove('drag-over');
    const dt = e.dataTransfer;
    if (!dt || ![...dt.types].includes('Files')) return;
    e.preventDefault();
    const items = [...dt.items].filter(i => i.kind === 'file');
    // Read handles right away. The browser clears drag data once the event ends.
    const handles = items.map(i => i.getAsFileSystemHandle?.() ?? Promise.resolve(null));
    // Tabs open in A–Z order, the way Explorer sorts names ("Part 2" before "Part 10").
    const dropped = [...dt.files].map((file, i) => ({ file, handle: handles[i] }))
      .sort((a, b) => byName.compare(a.file.name, b.file.name));
    for (const { file, handle: pending } of dropped) {
      const handle = await pending?.catch(() => null);
      if (handle?.kind === 'file') {
        // Only the dropped file itself can tell the Windows app where it is; the handle's file cannot.
        void locateFile(file);
        await this.openHandle(handle as FileSystemFileHandle);
      } else await this.openFile(file);
    }
  }

  // ---- Pasting images ----

  private async onPaste(e: ClipboardEvent) {
    const target = e.target as HTMLElement;
    if (target.closest?.('input, textarea, select, [contenteditable=true]')) return;
    const data = e.clipboardData;
    if (!data) return;
    const files = [...data.files];
    const images = files.filter(f => f.type.startsWith('image/'));
    const pdf = files.find(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (images.length) { e.preventDefault(); await this.pasteImages(images); return; }
    if (pdf) { e.preventDefault(); await this.openFile(pdf); return; }
    // Some apps copy an image only inside rich text.
    const html = data.getData('text/html');
    const src = html && /<img[^>]+src=["'](data:image\/[^"']+)["']/i.exec(html)?.[1];
    if (src) {
      e.preventDefault();
      await this.pasteImages([await (await fetch(src)).blob()]);
      return;
    }
    if (this.clip && this.session) { e.preventDefault(); this.pasteClip(); return; }
    const text = data.getData('text/plain');
    if (text.trim()) {
      e.preventDefault();
      if (!this.session) this.newDocument();
      this.pasteText(text);
    }
  }

  /** Ribbon button version of paste, for people who do not use Ctrl+V. */
  async pasteFromClipboard() {
    if (!navigator.clipboard?.read) { toast('Press Ctrl+V to paste.', 'info'); return; }
    try {
      const items = await navigator.clipboard.read();
      const blobs: Blob[] = [];
      for (const item of items) {
        const type = item.types.find(t => t.startsWith('image/'));
        if (type) blobs.push(await item.getType(type));
      }
      if (!blobs.length) { toast('There is no image on the clipboard. Copy one first, for example with Win+Shift+S.', 'info'); return; }
      await this.pasteImages(blobs);
    } catch (err) {
      if ((err as Error).name === 'NotAllowedError') toast('Clipboard access was blocked. Press Ctrl+V instead.', 'info');
      else throw err;
    }
  }

  async pasteImages(blobs: Blob[], newDocName?: string, spot?: PageSpot) {
    const style = this.preferredStyle();
    const assets: ImageAsset[] = [];
    for (const blob of blobs) {
      try { assets.push(await assetFromBlob(await readableImage(blob), style)); }
      catch (err) { toast(`That image could not be read. ${(err as Error).message ?? ''}`, 'error'); }
    }
    if (!assets.length) return;
    let session = spot?.session ?? this.session;
    if (spot && (!this.sessions.includes(spot.session) || !spot.session.pages.includes(spot.page))) return;
    if (!session) {
      session = new Session(newDocName ? `${baseName(newDocName)}.pdf` : 'Pasted images.pdf');
      session.pages = [session.blankPage(595, 842)];
      this.add(session);
    }
    let last: { page: PageRef; annot: Annot } | null = null;
    for (const [i, asset] of assets.entries()) {
      const canGrow = session.sources.size === 0;
      let place;
      if (spot) {
        const vp = viewportFor(spot.page, 1), [x, y] = toScreen(vp, ...spot.point);
        const size = fitSize(asset, vp.width - 24, vp.height - 24);
        place = { page: spot.page, x: Math.max(12, Math.min(x + i * 14, vp.width - size.w - 12)), y: Math.max(12, Math.min(y + i * 14, vp.height - size.h - 12)), ...size, added: false };
      } else place = pastePlacement(session, Math.max(this.viewer.current, last ? session.pages.indexOf(last.page) : 0), asset, canGrow);
      if (place.added) session.setPages([...session.pages, place.page], 'Add page');
      const annot = makeImageAnnot(place.page, asset, place.x, place.y, place.w, place.h, this.authorName());
      session.addAnnots(place.page, [annot], 'Paste image');
      last = { page: place.page, annot };
    }
    if (!last) return;
    const { page, annot } = last;
    if (this.session === session) {
      this.tools.useReadingTool();
      this.viewer.goTo(session.pages.indexOf(page));
      // Wait a frame so the page exists on screen before selecting.
      requestAnimationFrame(() => requestAnimationFrame(() => { if (this.session === session && session.pages.includes(page)) { this.viewer.select(page.id, annot.id); this.onSelection(); } }));
    }
    const auto = pasteMode();
    ensureAnalysis(annot.image!).then(async () => {
      if (!this.sessions.includes(session!) || !session!.pages.includes(page)) return;
      if (auto === 'off') { if (this.session === session) { this.imageBar.hintAfterPaste(annot); this.imageBar.sync(); } return; }
      await this.autoConvert(session!, page, annot, auto);
    }).catch(err => console.warn('Image check', err));
  }

  /** The user chose to have every pasted image converted straight away. */
  private async autoConvert(session: Session, page: PageRef, annot: Annot, mode: 'match' | 'light' | 'dark') {
    await applyTheme(session, page, annot, { mode, style: this.preferredStyle(), keepPhotos: true });
    this.imageBar.sync();
  }

  preferredStyle(): string {
    try {
      const s = localStorage.getItem('pdfy.imageStyle');
      if (s && THEME_STYLES.some(x => x.id === s)) return s;
    } catch { /* Storage may be off. */ }
    return 'gemini';
  }

  private pasteText(text: string) {
    const session = this.session!;
    const page = session.pages[this.viewer.current];
    const vp = viewportFor(page, 1);
    const w = Math.min(360, vp.width - 72);
    const lines = Math.ceil(text.length / 55) + (text.match(/\n/g)?.length ?? 0);
    const a = makeImageAnnot(page, { blob: new Blob(), original: new Blob(), width: 1, height: 1, theme: 'original', style: 'neutral', keepPhotos: true }, (vp.width - w) / 2, vp.height / 3, w, Math.min(vp.height / 2, lines * 17 + 12));
    const annot: Annot = { ...a, kind: 'text', image: undefined, text, contents: text, fontSize: 12, color: '#111111', textColor: '#111111', author: this.authorName() };
    session.addAnnots(page, [annot], 'Paste text');
    this.tools.useReadingTool();
    this.viewer.select(page.id, annot.id);
    this.onSelection();
  }

  private pasteClip() {
    const session = this.session!;
    const page = session.pages[this.viewer.current];
    const copies = this.clip!.annots.map(annot => {
      const r = annot.rect;
      return remapAnnot({ ...annot, id: uid(), ghost: undefined, importedFrom: undefined }, r, [r[0] + 14, r[1] - 14, r[2] + 14, r[3] - 14]);
    });
    session.addAnnots(page, copies, copies.length > 1 ? 'Paste objects' : 'Paste');
    copies.forEach((c, i) => (i ? this.viewer.toggleSelect(page.id, c.id) : this.viewer.select(page.id, c.id)));
    this.clip = { annots: copies, pageId: page.id };
    this.onSelection();
  }

  async insertImage(spot?: PageSpot) {
    const files = await pickFiles('image/*', true);
    if (files.length) await this.pasteImages(files, undefined, spot);
  }

  private insertNote(spot: PageSpot) {
    if (!this.sessions.includes(spot.session) || !spot.session.pages.includes(spot.page)) return;
    const style = this.tools.style('note');
    const a: Annot = { ...style, id: uid(), kind: 'note', rect: noteRect(...spot.point), fill: style.color, author: this.authorName(), created: Date.now() };
    spot.session.addAnnots(spot.page, [a], 'Add note');
    if (this.session === spot.session) {
      this.tools.useReadingTool(); this.viewer.select(spot.page.id, a.id); this.onSelection();
      const v = this.viewer.views.get(spot.page.id);
      if (v) this.tools.openCommentEditor(v, a);
    }
  }

  // ---- Right-click menus ----

  private onPageMenu(e: MouseEvent) {
    const session = this.session;
    if (!session) return;
    const target = e.target as Element;
    const pageEl = target.closest('.page') as HTMLElement | null;
    const page = pageEl ? session.pageById(pageEl.dataset.pageId!) : null;
    if (!page || target.closest('input, textarea, select')) return;
    const selected = window.getSelection()?.toString();
    e.preventDefault();
    const node = target.closest('[data-id]');
    const annot = node ? page.annots.find(a => a.id === node.getAttribute('data-id')) : null;
    const items: (MenuItem | null)[] = [];
    if (annot) {
      this.tools.useReadingTool();
      this.viewer.select(page.id, annot.id);
      this.onSelection();
      const v = this.viewer.views.get(page.id);
      if ((annot.kind === 'text' || annot.kind === 'callout') && v) items.push({ label: annot.markdown ? 'Edit Markdown' : 'Edit text', icon: 'text', run: () => this.tools.openEditor(v, annot, false) });
      if (annot.kind === 'math' && v) items.push({ label: 'Edit equation', icon: 'sigma', run: safe(() => this.study.editEquation(v, annot), 'Editing the equation') });
      if (annot.kind !== 'image' && v) items.push({ label: annot.contents ? 'Edit comment' : 'Add comment', icon: 'comments', run: () => this.tools.openCommentEditor(v, annot) });
      items.push(
        { label: 'Duplicate', icon: 'copy', key: 'Ctrl+D', run: () => { this.clip = { annots: [annot], pageId: page.id }; this.pasteClip(); } },
        { label: 'Bring to front', icon: 'layers', run: () => session.reorderAnnot(page, annot, true), disabled: annot.ghost },
        { label: 'Send to back', icon: 'layers', run: () => session.reorderAnnot(page, annot, false), disabled: annot.ghost },
        null,
        { label: 'Delete', icon: 'trash', key: 'Del', danger: true, run: () => this.deleteSelection() },
      );
    } else {
      if (selected) {
        items.push(
          { label: 'Look up', icon: 'book', key: 'Ctrl+L', run: () => this.study.lookupSelection() },
          { label: 'Copy text', icon: 'copy', key: 'Ctrl+C', run: () => navigator.clipboard?.writeText(selected) },
          null,
        );
      }
      const at = session.pages.indexOf(page);
      const v = this.viewer.views.get(page.id)!;
      const r = pageEl!.getBoundingClientRect();
      const spot: PageSpot = { session, page, point: toPdf(v.vp, e.clientX - r.left, e.clientY - r.top) };
      items.push(
        { label: 'Insert image…', icon: 'stamper', run: safe(() => this.insertImage(spot), 'Inserting the image') },
        { label: 'Insert note', icon: 'note', run: () => this.insertNote(spot) },
        { label: 'Insert voice note…', icon: 'mic', run: safe(() => this.voiceNoteCmd(spot), 'Recording the voice note') },
        null,
        { label: 'Paste', icon: 'paste', key: 'Ctrl+V', run: () => this.pasteFromClipboard() },
        null,
        { label: 'Rotate page right', icon: 'rotR', run: () => session.rotatePages([page.id], 90) },
        { label: 'Rotate page left', icon: 'rotL', run: () => session.rotatePages([page.id], -90) },
        { label: 'Bookmark this page', icon: 'bookmark', run: () => { session.bookmarks.push({ id: uid(), pageId: page.id, title: `Page ${at + 1}` }); session.markDirty(); toast('Bookmarked.', 'ok'); } },
        null,
        { label: 'Delete page', icon: 'trash', danger: true, disabled: session.pages.length < 2, run: () => session.setPages(session.pages.filter(p => p !== page), 'Delete page') },
      );
    }
    showMenu(e.clientX, e.clientY, items);
  }

  private thumbMenu(e: MouseEvent, page: PageRef) {
    e.preventDefault();
    const thumbs = this.panels.thumbs;
    if (!thumbs.selected.has(page.id)) { thumbs.selected.clear(); thumbs.selected.add(page.id); thumbs.schedule(); }
    const n = thumbs.selected.size;
    const word = n > 1 ? `${n} pages` : 'page';
    showMenu(e.clientX, e.clientY, [
      { label: `Rotate ${word} right`, icon: 'rotR', run: () => this.rotatePages(90) },
      { label: `Rotate ${word} left`, icon: 'rotL', run: () => this.rotatePages(-90) },
      { label: `Duplicate ${word}`, icon: 'copy', run: () => this.duplicatePages() },
      { label: `Extract ${word} to a file`, icon: 'extract', run: safe(() => this.extractPages(), 'Extracting') },
      null,
      { label: 'Insert blank page after', icon: 'plus', run: () => this.insertBlank() },
      { label: 'Insert from file after', icon: 'insertFile', run: safe(() => this.insertFromFile(), 'Inserting') },
      null,
      { label: `Delete ${word}`, icon: 'trash', danger: true, run: safe(() => this.deletePages(), 'Deleting') },
    ]);
  }

  async showHelp() {
    await shortcutsDialog();
    this.syncRibbon();
  }

  // ---- Keyboard ----

  private onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    // Only boxes that take typed letters block the one-letter shortcuts. A Thickness number box,
    // a drop-down or a tick box still lets I pick the pen.
    const field = target.closest?.('input, textarea, select, [contenteditable=true]');
    const typing = !!field && field.matches('textarea, [contenteditable=true], input:not([type=number]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=button])');
    const ctrl = e.ctrlKey || e.metaKey;
    if (document.querySelector('.overlay-bg')) return;

    // Ctrl+1 to 9 jumps to that document, as in Xodo.
    if (ctrl && !e.shiftKey && !e.altKey && /^(Digit|Numpad)[1-9]$/.test(e.code)) {
      const s = this.sessions[+e.code.slice(-1) - 1];
      if (s) { e.preventDefault(); this.activate(s); }
      return;
    }
    const sc = match(e);
    const printable = !ctrl && !e.altKey && !/^F\d{1,2}$/.test(e.code) && !['Escape', 'Tab'].includes(e.key);
    // A Thickness box or a drop-down lets the one-letter tool keys through (I for the pen), but not
    // editing keys such as Ctrl+Z or Ctrl+X, which must not act on the document from inside a box.
    const allowed = !field || (!typing && (!ctrl || sc?.global)) || (typing && sc?.global && !printable);
    if (sc && allowed) {
      e.preventDefault();
      safe(() => this.runShortcut(sc.id), sc.label)();
      return;
    }
    // Delete, the arrows and Space belong to whatever box has the keyboard.
    if (field) return;
    if (ctrl && e.code === 'KeyA' && this.session) {
      // Select the words on the current page, not the whole window.
      e.preventDefault();
      const host = this.viewer.views.get(this.session.pages[this.viewer.current]?.id)?.textHost;
      if (host) window.getSelection()?.selectAllChildren(host);
      return;
    }
    if (e.key === ' ' && this.session && !e.repeat && !target.closest?.('button, a[href], [role=button]')) {
      e.preventDefault();
      const back = this.tools.tool;
      this.tools.setTool('hand');
      this.tools.holdPan(true);
      // Space released, or the window left while it was held: the tool from before comes back.
      const up = (u: Event) => {
        if (u instanceof KeyboardEvent && u.key !== ' ') return;
        document.removeEventListener('keyup', up);
        window.removeEventListener('blur', up);
        this.tools.holdPan(false);
        if (this.tools.tool === 'hand') this.tools.setTool(back);
      };
      document.addEventListener('keyup', up);
      window.addEventListener('blur', up);
      return;
    }
    if (ctrl && e.code === 'KeyC') {
      const chosen = this.viewer.selectedAnnots();
      if (chosen && !window.getSelection()?.toString()) { this.clip = { annots: [...chosen.annots], pageId: chosen.page.id }; e.preventDefault(); }
      return;
    }
    if (ctrl) return;
    if (e.key === 'Escape' && this.pageEditor.isOpen) { this.pageEditor.close(); return; }
    if (e.key === 'Escape') {
      this.tools.cancel();
      if (this.speaking) this.stopReading();
      else if (this.tools.tool !== REST_TOOL) this.tools.setTool(REST_TOOL);
      else if (this.viewer.selection) { this.viewer.select(null); this.onSelection(); }
      else if (this.mode !== 'view') this.setMode('view');
      return;
    }
    // Left and right step through search results while the search panel is open, as in Xodo.
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && this.panels.active === 'search' && !this.viewer.selection) {
      e.preventDefault();
      this.panels.search.step(e.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter' && this.tools.finishClickShape()) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.viewer.selection) { e.preventDefault(); this.deleteSelection(); }
      return;
    }
    const sel = this.viewer.selectedAnnot();
    if (sel && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1);
      const vp = viewportFor(sel.page, 1);
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      // Screen direction to page direction, which differs on rotated pages.
      const det = vp.m[0] * vp.m[3] - vp.m[1] * vp.m[2];
      const px = (vp.m[3] * dx - vp.m[2] * dy) / det, py = (vp.m[0] * dy - vp.m[1] * dx) / det;
      const r = sel.annot.rect;
      const { ghost: _g, ...rest } = sel.annot;
      this.session!.replaceAnnot(sel.page, sel.annot, remapAnnot(rest as Annot, r, [r[0] + px, r[1] + py, r[2] + px, r[3] + py]), 'Move');
      return;
    }
    if (!this.session) return;
    if (e.key === 'PageDown' && this.viewer.layout === 'single') { e.preventDefault(); this.viewer.goTo(this.viewer.current + 1); }
    else if (e.key === 'PageUp' && this.viewer.layout === 'single') { e.preventDefault(); this.viewer.goTo(this.viewer.current - 1); }
  }

  /** What each shortcut does. The keys themselves live in the shortcuts list. */
  runShortcut(id: string) {
    const s = this.session;
    const toolIn = (mode: 'edit', t: Tool) => {
      if (!s) return;
      this.pageEditor.close();
      if (this.mode !== mode) this.setMode(mode);
      this.tools.setTool(this.tools.tool === t ? REST_TOOL : t);
    };
    switch (id) {
      case 'next-tab': case 'prev-tab':
        if (this.sessions.length > 1) {
          const i = this.sessions.indexOf(this.session!);
          this.activate(this.sessions[(i + (id === 'prev-tab' ? -1 : 1) + this.sessions.length) % this.sessions.length]);
        }
        return;
      case 'first-page': if (s) this.viewer.goTo(0); return;
      case 'last-page': if (s) this.viewer.goTo(s.pages.length - 1); return;
      case 'zoom-in': this.zoomBy(1.18); return;
      case 'zoom-out': this.zoomBy(0.85); return;
      case 'fit-page': if (s) this.viewer.setFit('page'); return;
      case 'close-tab': if (s) void this.closeSession(s).catch(err => reportError('Closing', err)); return;
      case 'pan': if (s) this.tools.setTool('hand'); return;
      case 'sticky': toolIn('edit', 'note'); return;
      case 'highlight': toolIn('edit', 'highlight'); return;
      case 'underline': toolIn('edit', 'underline'); return;
      case 'strikeout': toolIn('edit', 'strikeout'); return;
      case 'squiggly': toolIn('edit', 'squiggly'); return;
      case 'ink': toolIn('edit', 'pen'); return;
      case 'eraser': toolIn('edit', 'eraser'); return;
      case 'marker': toolIn('edit', 'marker'); return;
      case 'textbox': toolIn('edit', 'text'); return;
      case 'square': toolIn('edit', 'rect'); return;
      case 'oval': toolIn('edit', 'ellipse'); return;
      case 'line': toolIn('edit', 'line'); return;
      case 'arrow': toolIn('edit', 'arrow'); return;
      case 'multiselect': toolIn('edit', 'multiselect'); return;
      case 'lasso': toolIn('edit', 'lasso'); return;
      case 'stamper': if (s) { if (this.mode !== 'edit') this.setMode('edit'); void this.insertImage().catch(err => reportError('Stamper', err)); } return;
      case 'signature': if (s) { if (this.mode !== 'edit') this.setMode('edit'); void this.chooseSignature().catch(err => reportError('Signature', err)); } return;
      case 'cut': {
        const chosen = this.viewer.selectedAnnots();
        if (chosen && s) { this.clip = { annots: [...chosen.annots], pageId: chosen.page.id }; this.deleteSelection(); }
        return;
      }
      case 'undo': s?.undo(); return;
      case 'redo': s?.redo(); return;
      case 'duplicate': {
        const chosen = this.viewer.selectedAnnots();
        if (chosen && s) { this.clip = { annots: [...chosen.annots], pageId: chosen.page.id }; this.pasteClip(); }
        return;
      }
      case 'lookup': this.study.lookupSelection(); return;
      case 'lookup-toggle': this.study.toggleLookup(); return;
      case 'markdown': toolIn('edit', 'markdown'); return;
      case 'read-picture': toolIn('edit', 'read-picture'); return;
      case 'bookmark': if (s) this.toggleBookmark(); return;
      case 'bookmarks': this.panels.toggle('bookmarks'); return;
      case 'reopen-closed': void this.reopenClosed().catch(err => reportError('Reopening', err)); return;
      case 'equation': if (s) void this.study.insertEquation().catch(err => reportError('The equation', err)); return;
      case 'open': void this.openDialog().catch(err => reportError('Opening', err)); return;
      case 'new': void this.createDocument().catch(err => reportError('Creating the document', err)); return;
      case 'save': case 'save-as': if (s) void this.save(id === 'save-as').catch(err => reportError('Saving', err)); return;
      case 'fullscreen': void this.fullscreen(); return;
      case 'find': if (s) this.panels.show('search'); return;
      case 'next-result': this.panels.search.step(1); return;
      case 'prev-result': this.panels.search.step(-1); return;
      case 'print': if (s) void this.print().catch(err => reportError('Printing', err)); return;
      case 'speech': if (s) void this.readAloud(); return;
      case 'edit-mode': if (s) this.setMode(this.mode === 'edit' ? 'view' : 'edit'); return;
      case 'actions': {
        if (this.mode !== 'view') this.setMode('view');
        this.row.buttonFor(this.cmd.actions)?.click();
        return;
      }
      case 'help': void this.showHelp(); return;
    }
  }

  deleteSelection() {
    const chosen = this.viewer.selectedAnnots();
    if (!chosen || !this.session) return;
    this.viewer.select(null);
    if (chosen.annots.length > 1) this.session.removeMany(chosen.page, chosen.annots);
    else this.session.removeAnnot(chosen.page, chosen.annots[0]);
    this.onSelection();
  }

  // ---- Bookmarks ----

  isBookmarked(index = this.viewer.current): boolean {
    const s = this.session;
    const page = s?.pages[index];
    return !!page && !!s?.bookmarks.some(b => b.pageId === page.id);
  }

  /**
   * Bookmarks PDFy saved earlier are in the file's contents list, drawn in rgb(1, 2, 3). They come
   * back as bookmarks, so the ribbons and the list survive saving and reopening.
   */
  async importBookmarks(session: Session) {
    const src = [...session.sources.values()][0];
    if (!src) return;
    type Entry = { title: string; dest: unknown; color?: ArrayLike<number> };
    let items: Entry[] | null = null;
    try { items = (await src.pdf.getOutline()) as unknown as Entry[] | null; } catch { return; }
    const marks: { id: string; pageId: string; title: string }[] = [];
    for (const it of items ?? []) {
      const c = it.color;
      if (!c || c[0] !== 1 || c[1] !== 2 || c[2] !== 3 || !it.dest) continue;
      try {
        const d = typeof it.dest === 'string' ? await src.pdf.getDestination(it.dest) : it.dest;
        if (!Array.isArray(d)) continue;
        const index = typeof d[0] === 'number' ? d[0] : await src.pdf.getPageIndex(d[0]);
        const page = session.pages.find(p => p.source === src.id && p.index === index);
        if (page && !marks.some(m => m.pageId === page.id)) marks.push({ id: uid(), pageId: page.id, title: it.title || `Page ${session.pages.indexOf(page) + 1}` });
      } catch { /* A broken entry is skipped. */ }
    }
    session.bookmarks = marks;
  }

  /** Adds a bookmark for the page on screen, or takes it away if there is one. */
  toggleBookmark() {
    const s = this.session;
    const page = s?.pages[this.viewer.current];
    if (!s || !page) return;
    const had = s.bookmarks.find(b => b.pageId === page.id);
    if (had) {
      s.bookmarks = s.bookmarks.filter(b => b !== had);
      toast(`Bookmark on page ${this.viewer.current + 1} removed.`, 'info');
    } else {
      s.bookmarks.push({ id: uid(), pageId: page.id, title: `Page ${this.viewer.current + 1}` });
      toast(`Page ${this.viewer.current + 1} bookmarked. Ctrl+Shift+B lists your bookmarks.`, 'ok');
    }
    s.markDirty();
    this.panels.change('bookmarks');
    this.syncBookmarks();
  }

  /** The ribbon on bookmarked pages and the button beside the page number. */
  syncBookmarks() {
    const s = this.session;
    const marked = new Set(s?.bookmarks.map(b => b.pageId) ?? []);
    for (const v of this.viewer.views.values()) v.el.classList.toggle('bookmarked', marked.has(v.page.id));
    const on = this.isBookmarked();
    this.bookmarkBtn.classList.toggle('active', on);
    this.bookmarkBtn.setAttribute('aria-pressed', String(on));
    this.bookmarkBtn.title = on ? `Remove the bookmark (${keyLabel('bookmark')})` : `Bookmark this page (${keyLabel('bookmark')})`;
    this.row.sync();
  }

  zoomBy(k: number) {
    if (!this.session) return;
    const host = this.viewer.scroller.getBoundingClientRect();
    this.viewer.zoomAt(this.viewer.scale * k, host.left + host.width / 2, host.top + host.height / 2);
  }

  setReading(mode: 'normal' | 'night' | 'sepia') {
    this.reading = mode;
    this.viewer.scroller.dataset.reading = mode;
    this.syncRibbon();
  }

  async fullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  }

  // ---- Saving ----

  /** Asks where to save first, because the browser only allows that right after a click. */
  private async destination(name: string, types = PDF_TYPES): Promise<FileSystemFileHandle | null | 'download'> {
    if (!window.showSaveFilePicker) return 'download';
    try {
      return await window.showSaveFilePicker({ suggestedName: name, types });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return null;
      if ((err as Error).name === 'SecurityError') return 'download';
      throw err;
    }
  }

  private async writeTo(dest: FileSystemFileHandle | 'download', blob: Blob, name: string) {
    if (dest === 'download') { downloadBlob(blob, name); return; }
    // Written to a side file and swapped in on close, so a failure leaves the old file intact.
    const w = await dest.createWritable();
    try { await w.write(blob); await w.close(); }
    catch (err) { await w.abort().catch(() => {}); throw err; }
  }

  async save(saveAs = false): Promise<boolean> {
    const session = this.session;
    if (!session) return false;
    return this.saveSession(session, saveAs);
  }

  private saveSession(session: Session, saveAs = false): Promise<boolean> {
    const current = this.saves.get(session);
    if (current) { current.again = true; current.saveAs ||= saveAs; return current.promise; }
    const job = { promise: Promise.resolve(false), again: false, saveAs: false };
    this.saves.set(session, job);
    this.setStatus(this.saves.size > 1 ? `Saving ${this.saves.size} documents…` : `Saving ${session.name}…`);
    job.promise = (async () => {
      let result: boolean;
      do {
        job.again = false;
        result = await this.saveOnce(session, saveAs).catch(err => { reportError('Saving', err); return false; });
        saveAs = job.saveAs;
        job.saveAs = false;
      } while (result && job.again && this.sessions.includes(session));
      return result;
    })().finally(() => {
      this.saves.delete(session);
      this.setStatus(this.saves.size ? `Saving ${this.saves.size} document${this.saves.size > 1 ? 's' : ''}…` : '');
    });
    return job.promise;
  }

  private async saveOnce(session: Session, saveAs: boolean): Promise<boolean> {
    if (this.session === session) await this.tools.settle();
    await this.styleChanges;
    // A form answer still being typed counts: leaving the box hands it to the document.
    const typingIn = document.activeElement as HTMLElement | null;
    if (this.session === session && typingIn?.matches?.('.own-field-ctl, .widgets .field')) typingIn.blur();
    let dest: FileSystemFileHandle | 'download' | null = saveAs ? null : session.handle;
    if (dest && !saveAs) {
      const ok = (await dest.queryPermission?.({ mode: 'readwrite' })) === 'granted' || (await dest.requestPermission?.({ mode: 'readwrite' })) === 'granted';
      if (!ok) dest = null;
    }
    if (!dest) {
      dest = await this.destination(session.name);
      if (!dest) return false;
    }
    try {
      const revision = session.revision;
      const [snapshot] = await Promise.all([session.snapshotForSave(), session.preserveSources()]);
      const { blob, warnings } = await buildFile(snapshot, snapshot.pendingOptions);
      try {
        await this.writeTo(dest, blob, session.name);
      } catch (err) {
        const next = await this.rescueSave(blob, session.name, err as Error);
        if (!next) return false;
        dest = next;
      }
      if (dest !== 'download') await this.afterSave(session, dest, revision);
      else { session.dirty = session.revision !== revision; session.emit({ kind: 'meta' }); }
      if (!session.dirty) void dropJournal(session.id);
      toast(`Saved ${session.name} (${formatSize(blob.size)}).${session.dirty ? ' Newer edits remain unsaved.' : ''}`, 'ok');
      if (warnings.length) toast(warnings.slice(0, 3).join(' '), 'info', 8000);
      return true;
    } catch (err) {
      reportError('Saving', err);
      return false;
    }
  }

  /** The file could not be written, for example it is read-only. The work is safe, so offer elsewhere. */
  private async rescueSave(blob: Blob, name: string, err: Error): Promise<FileSystemFileHandle | 'download' | null> {
    console.warn('Save failed', err);
    const again = await openDialog<boolean>('Could not save there',
      h('p', null, `Windows did not allow writing to "${name}". It may be read-only, open in another app, or in a protected folder. Your work is safe. Choose another place to save it.`),
      [{ label: 'Cancel', value: false }, { label: 'Save elsewhere…', value: true, primary: true }], false);
    if (!again) return null;
    const next = await this.destination(name);
    if (!next) return null;
    await this.writeTo(next, blob, name);
    return next;
  }

  /** Saving keeps the working document and its undo/redo history intact. */
  private async afterSave(session: Session, handle: FileSystemFileHandle, revision: number) {
    session.handle = handle;
    session.name = handle.name;
    session.dirty = session.revision !== revision;
    session.emit({ kind: 'meta' });
    this.refresh();
    void addRecent(handle.name, handle, session.pages.length);
  }

  private async withProgress<T>(title: string, job: (p: ProgressHandle) => Promise<T>): Promise<T | undefined> {
    const prog = progressDialog(title);
    try { return await job(prog); }
    catch (err) {
      if ((err as Error).message !== 'cancelled') reportError(title, err);
      return undefined;
    } finally {
      prog.close();
    }
  }

  /** Picks a destination, builds the output, writes it. Used by every export. */
  private async exportFile(name: string, types: FilePickerType[], title: string, make: (p: ProgressHandle) => Promise<Blob>): Promise<boolean> {
    const dest = await this.destination(name, types);
    if (!dest) return false;
    const blob = await this.withProgress(title, make);
    if (!blob) return false;
    await this.writeTo(dest, blob, name);
    toast(`Saved ${name} (${formatSize(blob.size)}).`, 'ok');
    return true;
  }

  private savedPassword(): string | undefined {
    return [...(this.session?.sources.values() ?? [])].find(s => s.password)?.password;
  }

  private selectedPages(): PageRef[] { return this.panels.thumbs.selectedPages(); }

  // ---- Page commands ----

  rotatePages(delta: number) {
    const s = this.session;
    if (s) s.rotatePages(this.selectedPages().map(p => p.id), delta);
  }

  async deletePages() {
    const s = this.session;
    if (!s) return;
    const doomed = new Set(this.selectedPages());
    if (doomed.size >= s.pages.length) { toast('A document must keep at least one page.', 'info'); return; }
    if (doomed.size > 1 && !(await confirmDialog('Delete pages', `Delete ${doomed.size} pages? You can undo this.`, 'Delete', true))) return;
    s.setPages(s.pages.filter(p => !doomed.has(p)), doomed.size > 1 ? 'Delete pages' : 'Delete page');
    this.panels.thumbs.selected.clear();
  }

  duplicatePages() {
    const s = this.session;
    if (!s) return;
    const chosen = new Set(this.selectedPages());
    const next: PageRef[] = [];
    for (const p of s.pages) {
      next.push(p);
      if (chosen.has(p)) {
        next.push({
          ...p, id: uid(), ghostsLoaded: p.ghostsLoaded,
          annots: p.annots.filter(a => !a.ghost).map(a => ({ ...a, id: uid() })), removed: [...p.removed],
        });
      }
    }
    s.setPages(next, 'Duplicate page');
  }

  insertBlank() {
    const s = this.session;
    if (!s) return;
    const at = this.viewer.current;
    const cur = s.pages[at];
    const vp = viewportFor(cur, 1);
    const next = [...s.pages];
    next.splice(at + 1, 0, s.blankPage(vp.width, vp.height));
    s.setPages(next, 'Insert blank page');
    this.viewer.goTo(at + 1);
  }

  /** The page editor opened or closed. */
  onPagesView() { this.syncRibbon(); }

  /** Pages from PDFs or pictures, inserted at this position. */
  async insertFilesAt(accept: string, at: number) {
    const s = this.session;
    if (!s) return;
    const files = await pickFiles(accept, true);
    if (files.length && await this.addFilesToSession(s, files, at)) this.viewer.goTo(at);
  }

  async insertFromFile() {
    const s = this.session;
    if (!s) return;
    const files = await pickFiles('.pdf,image/*', true);
    if (files.length) await this.addFilesToSession(s, files, this.viewer.current + 1);
  }

  async mergeFiles() {
    const files = await pickFiles('.pdf,image/*', true);
    if (!files.length) return;
    const s = this.session ?? (() => { const n = new Session('Merged.pdf'); n.pages = []; return n; })();
    const fresh = !this.session;
    const ok = await this.addFilesToSession(s, files, s.pages.length);
    if (fresh && ok) this.add(s);
  }

  private async addFilesToSession(s: Session, files: File[], at: number): Promise<boolean> {
    const added: PageRef[] = [];
    for (const f of files) {
      try {
        if (f.type.startsWith('image/') || isHeic(f) || isDicom(f)) added.push(await this.imagePage(s, f));
        else added.push(...await s.addSource(f, f.name, retry => askPassword(f.name, retry)));
      } catch (err) {
        if (err instanceof PdfOpenError && err.kind === 'password-cancelled') continue;
        toast(`${f.name}: ${(err as Error).message}`, 'error');
      }
    }
    if (!added.length) return false;
    const next = [...s.pages];
    next.splice(at, 0, ...added);
    s.setPages(next, added.length > 1 ? 'Insert pages' : 'Insert page');
    toast(`Added ${added.length} page${added.length > 1 ? 's' : ''}.`, 'ok');
    return true;
  }

  /** A page with the picture drawn in: the picture's own size, or fitted on an A4 or Letter page. */
  private async imagePage(s: Session, blob: Blob, paper: 'a4' | 'letter' | null = null, margin = false): Promise<PageRef> {
    const asset = await assetFromBlob(await readableImage(blob), this.preferredStyle());
    const size = fitSize(asset, 14400, 14400);
    if (paper) {
      const portrait = size.h >= size.w;
      const [a, b] = paper === 'a4' ? [595.28, 841.89] : [612, 792];
      const pw = portrait ? a : b, ph = portrait ? b : a;
      const pad = margin ? 28 : 0;
      const k = Math.min((pw - pad * 2) / size.w, (ph - pad * 2) / size.h);
      const w = size.w * k, ht = size.h * k;
      const page = s.blankPage(pw, ph);
      const annot = makeImageAnnot(page, asset, (pw - w) / 2, (ph - ht) / 2, w, ht, this.authorName());
      annot.burn = true;
      page.annots = [annot];
      return page;
    }
    const page = s.blankPage(size.w, size.h);
    const annot = makeImageAnnot(page, asset, 0, 0, size.w, size.h, this.authorName());
    annot.burn = true;
    page.annots = [annot];
    return page;
  }

  async imagesToPdf() {
    const files = await pickFiles('image/*', true);
    if (!files.length) return;
    const s = new Session(`${baseName(files[0].name)}.pdf`);
    const pages: PageRef[] = [];
    for (const f of files) {
      try { pages.push(await this.imagePage(s, f)); }
      catch { toast(`${f.name} could not be read.`, 'error'); }
    }
    if (!pages.length) return;
    s.pages = pages;
    s.markDirty();
    this.add(s);
    toast(`Made ${pages.length} page${pages.length > 1 ? 's' : ''}.`, 'ok');
  }

  async extractPages() {
    const s = this.session;
    if (!s) return;
    const chosen = this.selectedPages();
    const defaultRange = chosen.map(p => s.pages.indexOf(p) + 1).join(', ');
    const f = await formDialog('Extract pages', [{ key: 'range', label: 'Pages', type: 'text', value: defaultRange, hint: `For example 1-3, 5, 8-. This document has ${s.pages.length} pages.` }], 'Extract');
    if (!f) return;
    const pages = parseRanges(String(f.range), s.pages.length).map(i => s.pages[i]);
    if (!pages.length) { toast('No valid pages in that range.', 'info'); return; }
    await this.exportFile(`${baseName(s.name)}-extract.pdf`, PDF_TYPES, 'Extracting', async p =>
      (await buildFile(s, { dropDocLevel: true }, pages, x => p.set(x, 'Building the file…'))).blob);
  }

  async splitDialog() {
    const s = this.session;
    if (!s) return;
    const f = await formDialog('Split into files', [
      { key: 'mode', label: 'How to split', type: 'select', value: 'every', options: [{ value: 'every', label: 'Every N pages' }, { value: 'ranges', label: 'By page ranges' }] },
      { key: 'n', label: 'Pages per file', type: 'number', value: 1, min: 1, max: s.pages.length },
      { key: 'ranges', label: 'Ranges (only for "By page ranges")', type: 'text', placeholder: '1-3; 4-10; 11-', hint: 'Use a semicolon between files.' },
    ], 'Split', `This document has ${s.pages.length} pages. The result is one zip file.`);
    if (!f) return;
    const parts: PageRef[][] = [];
    if (f.mode === 'every') {
      const n = Math.max(1, +f.n | 0);
      for (let i = 0; i < s.pages.length; i += n) parts.push(s.pages.slice(i, i + n));
    } else {
      for (const r of String(f.ranges).split(';')) {
        const list = parseRanges(r, s.pages.length).map(i => s.pages[i]);
        if (list.length) parts.push(list);
      }
    }
    if (!parts.length) { toast('No valid ranges.', 'info'); return; }
    const base = baseName(s.name);
    await this.exportFile(`${base}-split.zip`, [{ description: 'Zip file', accept: { 'application/zip': ['.zip'] } }], 'Splitting', async p => {
      const files: Zippable = {};
      for (let i = 0; i < parts.length; i++) {
        if (p.cancelled()) throw new Error('cancelled');
        p.set(i / parts.length, `File ${i + 1} of ${parts.length}`);
        const { blob } = await buildFile(s, { dropDocLevel: true }, parts[i]);
        files[`${base}-${String(i + 1).padStart(String(parts.length).length, '0')}.pdf`] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }];
      }
      return new Blob([zipSync(files) as BlobPart], { type: 'application/zip' });
    });
  }

  private async doCrop(page: PageRef, rect: Annot['rect']) {
    const s = this.session;
    if (!s) return;
    const scope = await openDialog<'one' | 'all' | null>('Crop', h('p', null, 'Which pages should be cropped? The hidden parts stay in the file, so this can be undone.'),
      [{ label: 'Cancel', value: null }, { label: 'All pages', value: 'all' }, { label: 'This page', value: 'one', primary: true }], null);
    if (!scope) return;
    const targets = scope === 'one' ? [page.id] : s.pages.map(p => p.id);
    s.setCrop(targets, () => [...rect] as PageRef['crop']);
  }

  // ---- Theme tools ----

  /** The image selected when Crop was pressed is the one to crop. */
  private cropTarget: { pageId: string; annotId: string } | null = null;
  private pageTimer = 0;

  private async doCropImage(v: PageView, box: { x0: number; y0: number; x1: number; y1: number }) {
    const s = this.session;
    const t = this.cropTarget;
    this.cropTarget = null;
    if (!s || !t || t.pageId !== v.page.id) { toast('Drag inside the image that is being cropped.', 'info'); return; }
    const a = v.page.annots.find(x => x.id === t.annotId);
    if (!a) return;
    const b = annotBounds(a);
    const p = [toScreen(v.vp, b[0], b[1]), toScreen(v.vp, b[2], b[3])];
    const bounds = { x0: Math.min(p[0][0], p[1][0]), y0: Math.min(p[0][1], p[1][1]), x1: Math.max(p[0][0], p[1][0]), y1: Math.max(p[0][1], p[1][1]) };
    await cropImageAnnot(s, v.page, a, box, bounds, this.viewer.scale);
    this.viewer.select(v.page.id, a.id);
    this.onSelection();
  }

  private async doSnip(page: PageRef, rect: Annot['rect']) {
    const s = this.session;
    if (!s) return;
    this.setStatus('Converting the area…');
    try {
      const annot = await snipRegion(s, page, rect, this.preferredStyle(), this.authorName());
      this.viewer.select(page.id, annot.id);
      this.onSelection();
    } finally {
      this.setStatus('');
    }
  }

  async convertPagesDialog() {
    const s = this.session;
    if (!s) return;
    const f = await formDialog('Convert page theme', [
      { key: 'mode', label: 'Convert to', type: 'select', value: 'dark', options: [{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }] },
      { key: 'style', label: 'Colours', type: 'select', value: this.preferredStyle(), options: THEME_STYLES.map(x => ({ value: x.id, label: x.name })) },
      { key: 'range', label: 'Pages', type: 'text', value: String(this.viewer.current + 1), hint: 'For example 1-3, 5, or leave empty for all pages.' },
    ], 'Convert', 'A converted picture is laid over each page. The original text stays underneath, so search still works.');
    if (!f) return;
    const range = String(f.range).trim();
    const pages = range ? parseRanges(range, s.pages.length).map(i => s.pages[i]) : s.pages;
    if (!pages.length) { toast('No valid pages in that range.', 'info'); return; }
    const made = await this.withProgress('Converting pages', p => convertPages(s, pages, f.mode as 'light' | 'dark', String(f.style), i => {
      p.set(i / pages.length, `Page ${i + 1} of ${pages.length}`);
      return !p.cancelled();
    }));
    if (made) toast(`Converted ${made} page${made > 1 ? 's' : ''}. Undo brings them back.`, 'ok');
  }

  /** Opening an Office file shows it as a PDF, ready to read, mark up and save. */
  async openOffice(file: File) {
    if (!canPrintToPdf()) { toast('Office files open in the Meletiq PDF desktop app.', 'info'); return; }
    const blob = await this.withProgress(`Converting ${file.name}`, async p => {
      p.set(0.3, 'Reading the file…');
      const job = await officeToPrint(file);
      p.set(0.6, 'Laying out the pages…');
      return printToPdf(job);
    });
    if (!blob) return;
    const s = await this.openPdfBlob(blob, `${baseName(file.name)}.pdf`);
    if (s) { s.markDirty(); }
  }

  async officeToPdf() {
    const files = await pickFiles(OFFICE_ACCEPT, true);
    for (const f of files) await this.openOffice(f);
  }

  async webToPdf() {
    if (!canPrintToPdf()) { toast('This works in the Meletiq PDF desktop app.', 'info'); return; }
    const f = await formDialog('Web page to PDF', [
      { key: 'url', label: 'Web address', type: 'text', placeholder: 'https://example.com' },
      { key: 'size', label: 'Page size', type: 'select', value: 'a4', options: [{ value: 'a4', label: 'A4' }, { value: 'letter', label: 'Letter' }, { value: 'wide', label: 'A4 landscape' }] },
    ], 'Create PDF');
    if (!f || !String(f.url).trim()) return;
    const raw = String(f.url).trim();
    const url = /^https?:/i.test(raw) ? raw : `https://${raw}`;
    const size = { a4: [8.27, 11.69], letter: [8.5, 11], wide: [11.69, 8.27] }[f.size as 'a4'];
    const blob = await this.withProgress('Loading the page', async p => {
      p.set(0.4, 'This can take a few seconds…');
      return printToPdf({ url, widthIn: size[0], heightIn: size[1], marginIn: 0.4 });
    });
    if (!blob) return;
    let name = 'Web page';
    try { name = new URL(url).hostname; } catch { /* Keeps the plain name. */ }
    const s = await this.openPdfBlob(blob, `${name}.pdf`);
    if (s) { s.markDirty(); }
  }

  private pendingAttachment: Annot['attachment'] | null = null;

  async attachFileCmd() {
    const [f] = await pickFiles('*/*');
    if (!f) return;
    this.pendingAttachment = { name: f.name, mime: f.type, blob: f };
    this.tools.setTool('attach');
  }

  /** Records from the microphone, lets you listen back, then the voice note is pinned like any file. */
  async voiceNoteCmd(spot?: PageSpot) {
    const blob = await recordVoice();
    if (!blob) return;
    const when = new Date();
    const stamp = `${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
    const attachment = { name: `Voice note ${stamp.replace(/[\\/:*?"<>|]/g, '-')}.webm`, mime: blob.type, blob, voice: true };
    if (spot) {
      if (!this.sessions.includes(spot.session) || !spot.session.pages.includes(spot.page)) return;
      const [x, y] = spot.point;
      const a: Annot = { id: uid(), kind: 'attachment', rect: [x - 10, y - 12, x + 10, y + 12], attachment, contents: attachment.name, opacity: 1, width: .75, color: '#c9e4ff', author: this.authorName(), created: Date.now() };
      spot.session.addAnnots(spot.page, [a], 'Add voice note');
      if (this.session === spot.session) { this.tools.useReadingTool(); this.viewer.select(spot.page.id, a.id); this.onSelection(); }
      return;
    }
    this.pendingAttachment = attachment;
    this.tools.setTool('attach');
  }

  /** The bytes of a pinned file, whether it was added now or was already in the PDF. */
  private async attachmentBlob(a: Annot): Promise<Blob | null> {
    const f = a.attachment;
    if (!f) return null;
    if (f.blob) return f.blob;
    const s = this.session;
    if (!s || !f.fileId) return null;
    const page = s.pages.find(p => p.annots.includes(a));
    const src = page?.source ? s.sources.get(page.source) : null;
    if (!src) return null;
    const got = await src.pdf.getAttachmentContent(f.fileId) as unknown as { content?: Uint8Array } | Uint8Array | null;
    const bytes = got instanceof Uint8Array ? got : got?.content;
    if (!bytes) return null;
    // Kept on the note, so it plays at once next time and is saved again if the note is moved.
    f.blob = new Blob([bytes as BlobPart], { type: f.mime || (f.voice ? 'audio/webm' : '') });
    return f.blob;
  }

  openAttachment(a: Annot) {
    void (async () => {
      const f = a.attachment;
      const blob = await this.attachmentBlob(a);
      if (!f || !blob) { toast('This file could not be read from the PDF. The Attachments panel lists files saved with the document.', 'info'); this.panels.show('attachments'); return; }
      if (!f.voice) { downloadBlob(blob, f.name); return; }
      const s = this.session;
      const page = s?.pages.find(p => p.annots.includes(a));
      const v = page ? this.viewer.views.get(page.id) : undefined;
      const node = v?.annotsG.querySelector(`[data-id="${a.id}"]`)?.getBoundingClientRect();
      const at = node ? { x: node.left, y: node.bottom } : { x: innerWidth / 2 - 140, y: innerHeight / 2 };
      showVoicePlayer(blob, f.name.replace(/\.[^.]+$/, ''), at, {
        save: () => downloadBlob(blob, f.name),
        remove: () => { if (s && page) { const now = page.annots.find(x => x.id === a.id); if (now) { this.viewer.select(null); s.removeAnnot(page, now); this.onSelection(); } } },
      });
    })().catch(err => reportError('Opening the note', err));
  }

  async wordEditorCmd() {
    const choice = await openDialog<'open' | 'new' | null>('Word editor', h('p', null, 'Edit an everyday Word document: text, headings, lists, tables and pictures. Page headers, footnotes and tracked changes are not kept.'),
      [{ label: 'Cancel', value: null }, { label: 'New document', value: 'new' }, { label: 'Open a Word file', value: 'open', primary: true }], null);
    if (!choice) return;
    let file: File | null = null;
    if (choice === 'open') {
      [file] = await pickFiles('.docx');
      if (!file) return;
    }
    await openDocxEditor(file, {
      save: (blob, name) => this.exportFile(name, [{ description: 'Word document', accept: { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] } }], 'Saving', async () => blob),
      toPdf: async (html, page, name) => {
        const blob = await this.withProgress('Making the PDF', async p => { p.set(0.5, 'Laying out the pages…'); return printToPdf({ html, ...page }); });
        if (blob) {
          const s = await this.openPdfBlob(blob, name);
          if (s) { s.markDirty(); toast('Opened as a PDF behind this window.', 'ok'); }
        }
      },
      pickImage: async () => (await pickFiles('image/*'))[0],
    });
  }

  async convertAllDialog() {
    const s = this.session;
    if (!s) return;
    const count = s.pages.reduce((n, p) => n + p.annots.filter(a => a.kind === 'image' && !a.burn).length, 0);
    if (!count) { toast('There are no images to convert yet.', 'info'); return; }
    const f = await formDialog('Convert all images', [
      { key: 'mode', label: 'Convert to', type: 'select', value: 'match', options: [{ value: 'match', label: 'Match each page' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'original', label: 'Back to original' }] },
      { key: 'style', label: 'Colours', type: 'select', value: this.preferredStyle(), options: THEME_STYLES.map(x => ({ value: x.id, label: x.name })) },
    ], 'Convert', `This document has ${count} image${count > 1 ? 's' : ''}.`);
    if (!f) return;
    const n = await this.withProgress('Converting images', p => convertAllImages(s, { mode: f.mode as 'match', style: String(f.style), keepPhotos: true }, (i, total) => {
      p.set(i / total, `Image ${i + 1} of ${total}`);
      return !p.cancelled();
    }));
    if (n) toast(`Converted ${n} image${n > 1 ? 's' : ''}. Undo brings them back.`, 'ok');
  }

  async scanCmd() {
    const shots = await cameraDialog();
    if (!shots.length) return;
    const s = this.session ?? this.newDocumentEmpty('Scan.pdf');
    const pages: PageRef[] = [];
    for (const b of shots) pages.push(await this.imagePage(s, b));
    s.setPages([...s.pages, ...pages], 'Add scanned pages');
    if (!this.sessions.includes(s)) this.add(s);
    this.viewer.goTo(s.pages.length - pages.length);
  }

  private newDocumentEmpty(name: string): Session {
    const s = new Session(name);
    s.pages = [];
    return s;
  }

  async convertImageCmd() {
    const [file] = await pickFiles('image/*,.heic,.heif,.dcm');
    if (!file) return;
    const f = await formDialog('Convert image', [
      { key: 'to', label: 'Save as', type: 'select', value: 'png', options: [{ value: 'png', label: 'PNG' }, { value: 'jpg', label: 'JPG' }] },
    ], 'Convert');
    if (!f) return;
    const ext = String(f.to), type = ext === 'png' ? 'image/png' as const : 'image/jpeg' as const;
    await this.exportFile(`${baseName(file.name)}.${ext}`, [{ description: ext.toUpperCase(), accept: { [type]: [`.${ext}`] } }], 'Converting image', async () => convertImageFile(await readableImage(file), type));
  }

  async detectFieldsCmd() {
    const s = this.session;
    if (!s) return;
    const n = await this.withProgress('Finding form fields', p => detectFields(s, (i, total) => {
      p.set(i / total, `Page ${i + 1} of ${total}`);
      return !p.cancelled();
    }));
    toast(n ? `Found ${n} field${n > 1 ? 's' : ''}. Select one to move or resize it. Undo removes them all.` : 'No blank lines or boxes were found.', n ? 'ok' : 'info', 5000);
  }

  async textCompareDialog() {
    const a = h('textarea', { rows: 8, placeholder: 'First text', style: { width: '100%' } });
    const b = h('textarea', { rows: 8, placeholder: 'Second text', style: { width: '100%' } });
    const out = h('p', { class: 'cmp-words', dir: 'auto' });
    const run = () => {
      clear(out);
      const ops = diffWords(a.value, b.value);
      const added = ops.filter(o => o.type === 'add').length, removed = ops.filter(o => o.type === 'del').length;
      out.append(...ops.map(o => (o.type === 'same' ? h('span', null, ` ${o.text} `) : h(o.type === 'add' ? 'ins' : 'del', null, ` ${o.text} `))));
      if (!added && !removed && a.value) out.prepend(h('strong', null, 'They match. '));
    };
    await openDialog('Text compare', h('div', { class: 'form' }, h('div', { class: 'text-cmp' }, a, b), h('button', { class: 'btn', onclick: run }, 'Compare'), out),
      [{ label: 'Close', value: true, primary: true }], true, undefined, true);
  }

  async batchDialog() {
    const files = await pickFiles('.pdf', true);
    if (!files.length) return;
    const f = await formDialog('Batch', [
      { key: 'job', label: 'What to do to each file', type: 'select', value: 'compress', options: [
        { value: 'compress', label: 'Compress' }, { value: 'flatten', label: 'Flatten annotations and forms' }, { value: 'clean', label: 'Clean metadata' },
        { value: 'password', label: 'Add a password' }, { value: 'numbers', label: 'Add page numbers' }, { value: 'text', label: 'Convert to text' },
      ] },
      { key: 'password', label: 'Password (only for "Add a password")', type: 'password' },
    ], 'Start', `${files.length} file${files.length > 1 ? 's' : ''} chosen. The results go into one zip file. The originals are not changed.`);
    if (!f) return;
    if (f.job === 'password' && !String(f.password)) { toast('Enter a password first.', 'info'); return; }
    let summary = '';
    const ok = await this.exportFile('batch-results.zip', [{ description: 'Zip file', accept: { 'application/zip': ['.zip'] } }], 'Batch', async p => {
      const r = await runBatch(files, String(f.job), String(f.password), (i, t) => { p.set(i / files.length, `${t} (${i + 1} of ${files.length})`); return !p.cancelled(); });
      summary = r.failed.length ? `${r.done} done. Could not process: ${r.failed.join(', ')}` : `${r.done} files done.`;
      return r.blob;
    });
    if (ok) toast(summary, 'ok', 6000);
  }

  async checkDocument() {
    const s = this.session;
    if (!s) return;
    const report = await this.withProgress('Checking', async p => {
      const { blob } = await buildFile(s, {}, s.pages, x => p.set(x * 0.7, 'Reading…'));
      return inspectFile(blob, this.savedPassword());
    });
    if (!report) return;
    const missing = report.fonts.filter(x => !x.embedded);
    const row = (ok: boolean | null, title: string, detail: string) => h('tr', null,
      h('td', { class: ok === null ? 'chk-info' : ok ? 'chk-ok' : 'chk-bad' }, ok === null ? 'Info' : ok ? 'Pass' : 'Fix'), h('td', null, h('strong', null, title), h('div', { class: 'muted' }, detail)));
    const table = h('table', { class: 'chk-table' },
      row(!!report.pdfa, 'PDF/A label', report.pdfa ? `Marked as PDF/A-${report.pdfa}.` : 'Not marked as PDF/A. Use Save as PDF/A.'),
      row(report.outputIntent, 'Colour profile', report.outputIntent ? 'Has an output colour profile.' : 'No colour profile. PDF/A needs one.'),
      row(!missing.length, 'Fonts embedded', missing.length ? `Not embedded: ${missing.map(x => x.name).slice(0, 8).join(', ')}. PDF/A needs every font inside the file.` : `All ${report.fonts.length} fonts are inside the file.`),
      row(!report.encrypted, 'No encryption', report.encrypted ? 'Has a password. PDF/A does not allow this.' : 'Not encrypted.'),
      row(!report.javascript, 'No scripts', report.javascript ? 'Contains JavaScript. PDF/A does not allow this.' : 'No scripts found.'),
      row(report.tagged, 'Tagged for screen readers', report.tagged ? 'Has a structure tree.' : 'No tags, so screen readers read it poorly.'),
      row(!!report.title, 'Title', report.title ? `"${report.title}"` : 'No title. Set one in Properties.'),
      row(!!report.language, 'Language', report.language ?? 'No language set.'),
      row(null, 'Transparency', report.transparency ? 'Uses transparency. Fine for PDF/A-2 and 3, not allowed in PDF/A-1.' : 'None found.'),
      row(null, 'Attachments', `${report.attachments}. Only PDF/A-3 allows general attachments.`));
    await openDialog('Check results', h('div', null, h('p', { class: 'muted' }, 'A quick check of the most common requirements. For a formal PDF/A certificate, use a dedicated validator such as veraPDF.'), table),
      [{ label: 'Close', value: true, primary: true }], true);
  }

  async savePdfA() {
    const s = this.session;
    if (!s) return;
    const f = await formDialog('Save as PDF/A', [
      { key: 'level', label: 'Level', type: 'select', value: '2B', options: [{ value: '1B', label: 'PDF/A-1b (oldest, strictest)' }, { value: '2B', label: 'PDF/A-2b (recommended)' }, { value: '3B', label: 'PDF/A-3b (allows attachments)' }] },
    ], 'Save', 'Adds the archive label and colour profile. Text you added in Meletiq PDF uses standard fonts that are not embedded, so strict validators may flag those. Check the result with Check file.');
    if (!f) return;
    await this.exportFile(`${baseName(s.name)}-pdfa.pdf`, PDF_TYPES, 'Saving as PDF/A', async p =>
      (await buildFile(s, { pdfa: f.level as '1B', removePassword: true }, s.pages, x => p.set(x, 'Building the file…'))).blob);
  }

  // ---- Redaction ----

  async applyRedactionsCmd() {
    const s = this.session;
    if (!s) return;
    const marked = s.pages.filter(p => p.annots.some(a => a.kind === 'redact'));
    if (!marked.length) { toast('Nothing is marked yet. Use Mark redaction first.', 'info'); return; }
    const ok = await confirmDialog('Apply redactions',
      `This turns ${marked.length} page${marked.length > 1 ? 's' : ''} into pictures with the marked areas painted over. The text under them is gone from the saved file. Other text on those pages stops being selectable until you run OCR.`, 'Apply', true);
    if (!ok) return;
    const n = await this.withProgress('Applying redactions', async () => applyRedactions(s, marked));
    if (n) toast(`Redacted ${n} page${n > 1 ? 's' : ''}. Save to make it final.`, 'ok');
  }

  tellRedactionsMarked(n: number) { toast(`Marked ${n} result${n > 1 ? 's' : ''}.`, 'ok'); }

  // ---- Stamps and signatures ----

  async chooseStamp() {
    let chosen: string | null = null;
    const custom = h('input', { type: 'text', placeholder: 'Your own wording', style: { width: '100%', height: '30px', padding: '0 8px', marginTop: '8px' } });
    const ok = await openDialog<boolean>('Choose a stamp',
      h('div', null,
        h('div', { class: 'stamp-grid' }, ...STAMPS.map(([label, c]) => h('button', {
          class: 'stamp-opt', style: { color: c },
          onclick: (e: Event) => { chosen = label; (e.currentTarget as HTMLElement).closest('.overlay-bg')!.querySelector<HTMLButtonElement>('.dialog-foot .primary')!.click(); },
        }, label))),
        custom),
      [{ label: 'Cancel', value: false }, { label: 'Use', value: true, primary: true }], false);
    if (!ok) return;
    const text = custom.value.trim() || chosen;
    if (!text) return;
    this.stampLabel = text;
    const colour = STAMPS.find(x => x[0] === text)?.[1];
    if (colour) this.tools.setStyle({ color: colour }, 'stamp');
    this.tools.setTool('stamp');
  }

  async chooseSignature() {
    const blob = await signatureDialog();
    if (!blob) return;
    this.signature = await assetFromBlob(blob);
    this.tools.setTool('signature');
  }

  private loadMeasure(): { unit: string; scale: number } {
    try { return JSON.parse(localStorage.getItem('pdfy.measure') ?? '') as { unit: string; scale: number }; }
    catch { return { unit: 'in', scale: 1 / 72 }; }
  }

  async setMeasureScale() {
    const f = await formDialog('Measurement scale', [
      { key: 'real', label: 'One inch on the page equals', type: 'number', value: +(this.measure.scale * 72).toFixed(4), min: 0.0001, step: 0.1 },
      { key: 'unit', label: 'Unit', type: 'select', value: this.measure.unit, options: ['in', 'ft', 'yd', 'mm', 'cm', 'm', 'km', 'mi'].map(u => ({ value: u, label: u })) },
    ], 'Set scale', 'New measurements use this. Existing ones keep their value.');
    if (!f) return;
    this.measure = { unit: String(f.unit), scale: (+f.real || 1) / 72 };
    try { localStorage.setItem('pdfy.measure', JSON.stringify(this.measure)); } catch { /* Storage may be off. */ }
  }

  private async askField(type: string): Promise<{ name: string; options?: string[] } | null> {
    const fields: Field[] = [{ key: 'name', label: 'Field name', type: 'text', value: `${type}_${Date.now().toString(36).slice(-4)}`, hint: 'Must be unique in the document.' }];
    if (type === 'dropdown' || type === 'list') fields.push({ key: 'options', label: 'Choices, one per line', type: 'textarea', value: 'Option 1\nOption 2' });
    if (type === 'radio') fields.push({ key: 'options', label: 'Value when chosen', type: 'text', value: 'Yes' });
    const f = await formDialog('Add form field', fields, 'Add');
    if (!f) return null;
    return { name: String(f.name).trim() || `field_${uid()}`, options: f.options ? String(f.options).split('\n').map(x => x.trim()).filter(Boolean) : undefined };
  }

  /** Plain words on filling in forms and making your own. */
  async formsHelp() {
    const step = (title: string, text: string) => h('div', { class: 'help-step' }, h('strong', null, title), h('p', null, text));
    await openDialog('How forms work', h('div', { class: 'help-steps' },
      step('Filling in a form', 'Stay in Read, not Edit. Fields show a light blue box. Click one and type, tick or choose. Save keeps what you filled in, and any PDF app can read it.'),
      step('Making your own form', 'Open Edit, then Forms, and choose a kind of field: text, tick box, choice, drop-down or list. Drag a box where it goes and give it a name. Press Escape to go back to Read: the field is ready to fill in.'),
      step('Moving or resizing a field', 'In Edit, click the field’s box to move it or drag its corners. In Read, clicking a field fills it in instead.'),
      step('A printed or scanned form', 'Detect fields finds blank lines and boxes on the page and turns them into fields for you.'),
      step('When the form is finished', 'Flatten forms makes the answers part of the page, so they can no longer be changed.')),
    [{ label: 'Close', value: true, primary: true }], true);
  }

  // ---- Decorations ----

  private rangePages(text: string): PageRef[] {
    const s = this.session!;
    const t = text.trim();
    return t ? parseRanges(t, s.pages.length).map(i => s.pages[i]) : s.pages;
  }

  async watermarkDialog() {
    if (!this.session) return;
    const f = await formDialog('Watermark', [
      { key: 'text', label: 'Text', type: 'text', value: 'CONFIDENTIAL' },
      { key: 'size', label: 'Size', type: 'number', value: 60, min: 8, max: 300 },
      { key: 'color', label: 'Colour', type: 'color', value: '#888888' },
      { key: 'opacity', label: 'Opacity %', type: 'number', value: 25, min: 5, max: 100 },
      { key: 'angle', label: 'Angle', type: 'number', value: 45, min: -90, max: 90 },
      { key: 'range', label: 'Pages (empty for all)', type: 'text' },
    ], 'Add');
    if (!f || !String(f.text).trim()) return;
    addWatermark(this.session, this.rangePages(String(f.range)), { text: String(f.text), size: +f.size, color: String(f.color), opacity: +f.opacity / 100, angle: +f.angle });
  }

  async headerFooterDialog() {
    if (!this.session) return;
    const f = await formDialog('Header and footer', [
      { key: 'tl', label: 'Header left', type: 'text' }, { key: 'tc', label: 'Header centre', type: 'text' }, { key: 'tr', label: 'Header right', type: 'text' },
      { key: 'bl', label: 'Footer left', type: 'text' }, { key: 'bc', label: 'Footer centre', type: 'text', value: 'Page {page} of {pages}' }, { key: 'br', label: 'Footer right', type: 'text' },
      { key: 'size', label: 'Size', type: 'number', value: 10, min: 5, max: 48 }, { key: 'color', label: 'Colour', type: 'color', value: '#444444' },
      { key: 'range', label: 'Pages (empty for all)', type: 'text' },
    ], 'Add', 'You can use {page}, {pages}, {date} and {file}.');
    if (!f) return;
    const slots: Partial<Record<Pos, string>> = {};
    for (const k of ['tl', 'tc', 'tr', 'bl', 'bc', 'br'] as Pos[]) if (String(f[k]).trim()) slots[k] = String(f[k]);
    addHeaderFooter(this.session, this.rangePages(String(f.range)), { slots, size: +f.size, color: String(f.color), margin: 24, start: 1 });
  }

  async pageNumbersDialog() {
    if (!this.session) return;
    const f = await formDialog('Page numbers', [
      { key: 'pos', label: 'Position', type: 'select', value: 'bc', options: [{ value: 'bc', label: 'Bottom centre' }, { value: 'br', label: 'Bottom right' }, { value: 'bl', label: 'Bottom left' }, { value: 'tc', label: 'Top centre' }, { value: 'tr', label: 'Top right' }, { value: 'tl', label: 'Top left' }] },
      { key: 'format', label: 'Format', type: 'select', value: '{page}', options: [{ value: '{page}', label: '1' }, { value: 'Page {page}', label: 'Page 1' }, { value: '{page} / {pages}', label: '1 / 10' }, { value: 'Page {page} of {pages}', label: 'Page 1 of 10' }] },
      { key: 'start', label: 'Start at', type: 'number', value: 1, min: 0 },
      { key: 'size', label: 'Size', type: 'number', value: 10, min: 5, max: 48 },
      { key: 'range', label: 'Pages (empty for all)', type: 'text' },
    ], 'Add');
    if (!f) return;
    addHeaderFooter(this.session, this.rangePages(String(f.range)), { slots: { [String(f.pos)]: String(f.format) } as never, size: +f.size, color: '#333333', margin: 22, start: +f.start }, 'Add page numbers');
  }

  async batesDialog() {
    if (!this.session) return;
    const f = await formDialog('Bates numbers', [
      { key: 'prefix', label: 'Before the number', type: 'text', value: 'DOC-' }, { key: 'suffix', label: 'After the number', type: 'text' },
      { key: 'start', label: 'Start at', type: 'number', value: 1, min: 0 }, { key: 'digits', label: 'Digits', type: 'number', value: 6, min: 1, max: 12 },
      { key: 'pos', label: 'Position', type: 'select', value: 'br', options: [{ value: 'br', label: 'Bottom right' }, { value: 'bl', label: 'Bottom left' }, { value: 'bc', label: 'Bottom centre' }, { value: 'tr', label: 'Top right' }] },
    ], 'Add');
    if (!f) return;
    addBates(this.session, this.session.pages, { prefix: String(f.prefix), suffix: String(f.suffix), start: +f.start, digits: +f.digits, pos: f.pos as Pos, size: 9, color: '#111111', margin: 18 });
  }

  // ---- Protection ----

  async passwordDialog() {
    const s = this.session;
    if (!s) return;
    const f = await formDialog('Add password', [
      { key: 'user', label: 'Password to open', type: 'password', hint: 'Leave empty if anyone may open it.' },
      { key: 'owner', label: 'Password to change permissions', type: 'password', hint: 'Leave empty to use the same password.' },
      { key: 'print', label: 'Allow printing', type: 'check', value: true },
      { key: 'copy', label: 'Allow copying text', type: 'check', value: true },
      { key: 'edit', label: 'Allow editing', type: 'check', value: true },
    ], 'Save protected copy', 'Saved with AES-256 encryption. If the password is lost, the file cannot be opened.');
    if (!f) return;
    const user = String(f.user), owner = String(f.owner) || user;
    if (!user && !owner) { toast('Enter a password first.', 'info'); return; }
    await this.exportFile(`${baseName(s.name)}-protected.pdf`, PDF_TYPES, 'Protecting', async p =>
      (await buildFile(s, {
        encrypt: {
          userPassword: user, ownerPassword: owner,
          permissions: { printing: f.print ? 'highResolution' : false, copying: !!f.copy, modifying: !!f.edit, annotating: !!f.edit, fillingForms: true, contentAccessibility: true, documentAssembly: !!f.edit },
        },
      }, s.pages, x => p.set(x, 'Encrypting…'))).blob);
  }

  private pendingSign: { id: DigitalId; reason: string; location: string } | null = null;

  async certSignDialog() {
    const s = this.session;
    if (!s) return;
    const [file] = await pickFiles('.p12,.pfx');
    if (!file) return;
    const f = await formDialog('Digital signature', [
      { key: 'password', label: `Password for ${file.name}`, type: 'password' },
      { key: 'reason', label: 'Reason (optional)', type: 'text', placeholder: 'I approve this document' },
      { key: 'location', label: 'Location (optional)', type: 'text' },
      { key: 'visible', label: 'Show a signature box on the page', type: 'check', value: true },
    ], 'Continue', 'Signing saves a new copy. Any later change to that copy shows up as a broken signature, so sign last.');
    if (!f) return;
    const id = await readDigitalId(await file.arrayBuffer(), String(f.password));
    if (id.expires < new Date()) toast(`This digital ID expired on ${id.expires.toLocaleDateString()}.`, 'error');
    this.pendingSign = { id, reason: String(f.reason), location: String(f.location) };
    if (f.visible) {
      this.tools.setTool('cert-box');
    } else {
      await this.signWithId(s.pages[this.viewer.current], null);
    }
  }

  private async signWithId(page: PageRef, rect: Annot['rect'] | null) {
    const s = this.session, sign = this.pendingSign;
    this.pendingSign = null;
    if (!s || !sign) return;
    const pageIndex = s.pages.indexOf(page);
    await this.exportFile(`${baseName(s.name)}-signed.pdf`, PDF_TYPES, 'Signing', async p => {
      const { blob } = await buildFile(s, {
        removePassword: true,
        signature: { name: sign.id.name, reason: sign.reason, location: sign.location, pageIndex, rect },
      }, s.pages, x => p.set(x * 0.8, 'Building the file…'));
      p.set(0.9, 'Signing…');
      return applySignature(new Uint8Array(await blob.arrayBuffer()), sign.id);
    });
  }

  async createIdDialog() {
    const f = await formDialog('Create digital ID', [
      { key: 'name', label: 'Your name', type: 'text' },
      { key: 'email', label: 'Email (optional)', type: 'text' },
      { key: 'password', label: 'Password to protect it', type: 'password' },
      { key: 'years', label: 'Valid for (years)', type: 'number', value: 5, min: 1, max: 30 },
    ], 'Create', 'This proves a signed file has not changed. Others can only trust that it is really you if they already trust this ID. For legal use, get one from a certificate authority.');
    if (!f) return;
    if (!String(f.name).trim() || !String(f.password)) { toast('Enter a name and a password.', 'info'); return; }
    const name = `${String(f.name).trim().replace(/[^\p{L}\p{N} _-]/gu, '') || 'digital-id'}.p12`;
    await this.exportFile(name, [{ description: 'Digital ID', accept: { 'application/x-pkcs12': ['.p12'] } }], 'Creating your digital ID', async p => {
      p.set(0.3, 'This takes a few seconds…');
      return createDigitalId(String(f.name).trim(), String(f.email).trim(), String(f.password), +f.years || 5);
    });
  }

  async removePassword() {
    const s = this.session;
    if (!s) return;
    if (!this.savedPassword()) { toast('This document does not need a password to open.', 'info'); return; }
    await this.exportFile(`${baseName(s.name)}-unlocked.pdf`, PDF_TYPES, 'Removing password', async p =>
      (await buildFile(s, { removePassword: true }, s.pages, x => p.set(x, 'Building the file…'))).blob);
  }

  async cleanMetadata() {
    const s = this.session;
    if (!s) return;
    await this.exportFile(`${baseName(s.name)}-clean.pdf`, PDF_TYPES, 'Cleaning', async p =>
      (await buildFile(s, { stripMetadata: true }, s.pages, x => p.set(x, 'Building the file…'))).blob);
  }

  async propertiesDialog() {
    const s = this.session;
    if (!s) return;
    const src = [...s.sources.values()][0];
    let info: Record<string, unknown> = {};
    try { info = ((await src?.pdf.getMetadata())?.info ?? {}) as Record<string, unknown>; } catch { /* Shown as empty. */ }
    const size = [...s.sources.values()].reduce((n, x) => n + x.blob.size, 0);
    const f = await formDialog('Document properties', [
      { key: 'title', label: 'Title', type: 'text', value: String(s.pendingOptions.metadata?.title ?? info.Title ?? '') },
      { key: 'author', label: 'Author', type: 'text', value: String(s.pendingOptions.metadata?.author ?? info.Author ?? '') },
      { key: 'subject', label: 'Subject', type: 'text', value: String(s.pendingOptions.metadata?.subject ?? info.Subject ?? '') },
      { key: 'keywords', label: 'Keywords', type: 'text', value: String(s.pendingOptions.metadata?.keywords ?? info.Keywords ?? '') },
    ], 'Keep changes', `${s.pages.length} pages. File size ${formatSize(size)}. PDF version ${info.PDFFormatVersion ?? 'unknown'}. Made by ${info.Producer ?? 'unknown'}. Changes apply on the next save.`);
    if (!f) return;
    s.pendingOptions.metadata = { title: String(f.title), author: String(f.author), subject: String(f.subject), keywords: String(f.keywords) };
    s.markDirty();
  }

  async flatten(annots: boolean, forms: boolean) {
    const s = this.session;
    if (!s) return;
    await this.exportFile(`${baseName(s.name)}-flat.pdf`, PDF_TYPES, 'Flattening', async p =>
      (await buildFile(s, { flattenAnnots: annots, flattenForms: forms }, s.pages, x => p.set(x, 'Building the file…'))).blob);
  }

  // ---- Convert ----

  /** The document as it would be saved, opened just long enough for the job. */
  private async withBuilt<T>(p: ProgressHandle, fn: (pdf: import('./core/engine').PDFDocumentProxy) => Promise<T>): Promise<T> {
    const s = this.session!;
    await this.tools.settle();
    const { blob } = await buildFile(s, {}, s.pages, x => p.set(x * 0.2, 'Preparing…'));
    return withSavedPdf(blob, this.savedPassword(), fn);
  }

  private tick(p: ProgressHandle): Progress {
    return (f, t) => { p.set(0.2 + f * 0.8, t); return !p.cancelled(); };
  }

  async exportAs(kind: 'txt' | 'html' | 'docx' | 'xlsx' | 'pptx') {
    const s = this.session;
    if (!s) return;
    const base = baseName(s.name);
    const meta = {
      txt: { d: 'Text', m: 'text/plain' }, html: { d: 'Web page', m: 'text/html' },
      docx: { d: 'Word document', m: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      xlsx: { d: 'Excel workbook', m: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      pptx: { d: 'PowerPoint', m: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
    }[kind];
    await this.exportFile(`${base}.${kind}`, [{ description: meta.d, accept: { [meta.m]: [`.${kind}`] } }], `Converting to ${meta.d}`, p => this.withBuilt(p, pdf => {
      const t = this.tick(p);
      if (kind === 'txt') return exportText(pdf, t);
      if (kind === 'html') return exportHtml(pdf, base, t);
      if (kind === 'docx') return exportDocx(pdf, t);
      if (kind === 'xlsx') return exportXlsx(pdf, t);
      return exportPptx(pdf, t);
    }));
  }

  async exportImagesDialog() {
    const s = this.session;
    if (!s) return;
    const f = await formDialog('Export as images', [
      { key: 'format', label: 'Format', type: 'select', value: 'png', options: [{ value: 'png', label: 'PNG (sharpest)' }, { value: 'jpg', label: 'JPG (smallest)' }] },
      { key: 'dpi', label: 'Quality', type: 'select', value: '150', options: [{ value: '96', label: 'Screen (96 dpi)' }, { value: '150', label: 'Good (150 dpi)' }, { value: '300', label: 'Print (300 dpi)' }] },
    ], 'Export');
    if (!f) return;
    const base = baseName(s.name), fmt = f.format as 'png' | 'jpg';
    const single = s.pages.length === 1;
    const name = single ? `${base}.${fmt}` : `${base}-images.zip`;
    const type = single ? [{ description: fmt.toUpperCase(), accept: { [fmt === 'png' ? 'image/png' : 'image/jpeg']: [`.${fmt}`] } }] : [{ description: 'Zip file', accept: { 'application/zip': ['.zip'] } }];
    await this.exportFile(name, type, 'Exporting images', async p => (await this.withBuilt(p, pdf => exportImages(pdf, base, +f.dpi, fmt, this.tick(p)))).blob);
  }

  async compressDialog() {
    const s = this.session;
    if (!s) return;
    const f = await formDialog('Compress', [
      { key: 'level', label: 'Level', type: 'select', value: 'medium', options: [{ value: 'light', label: 'Light: best quality' }, { value: 'medium', label: 'Medium: balanced' }, { value: 'strong', label: 'Strong: smallest file' }] },
    ], 'Compress', 'Shrinks pictures inside the PDF and removes unused data. Text stays sharp.');
    if (!f) return;
    const levels = { light: { quality: 0.85, maxSide: 2600 }, medium: { quality: 0.72, maxSide: 1800 }, strong: { quality: 0.55, maxSide: 1200 } };
    const before = [...s.sources.values()].reduce((n, x) => n + x.blob.size, 0);
    let after = 0;
    const ok = await this.exportFile(`${baseName(s.name)}-compressed.pdf`, PDF_TYPES, 'Compressing', async p => {
      const { blob } = await buildFile(s, { compress: levels[f.level as keyof typeof levels] }, s.pages, x => p.set(x, 'Working…'));
      after = blob.size;
      return blob;
    });
    if (ok && before) toast(`${formatSize(before)} → ${formatSize(after)} (${Math.max(0, Math.round((1 - after / before) * 100))}% smaller).`, 'ok', 6000);
  }

  async ocrDialog() {
    const s = this.session;
    if (!s) return;
    const f = await formDialog('OCR: make pages searchable', [
      { key: 'range', label: 'Pages', type: 'text', value: String(this.viewer.current + 1), hint: `For example 1-3, or leave empty for all ${s.pages.length} pages.` },
      { key: 'lang', label: 'Language', type: 'select', value: 'eng', options: [
        { value: 'eng', label: 'English' }, { value: 'ara', label: 'Arabic' }, { value: 'ara+eng', label: 'Arabic and English' },
        { value: 'fra', label: 'French' }, { value: 'deu', label: 'German' }, { value: 'spa', label: 'Spanish' },
      ] },
    ], 'Start', 'Words are found in Search straight away and saved as invisible text. It takes a few seconds a page.');
    if (!f) return;
    const pages = this.rangePages(String(f.range));
    if (!pages.length) return;
    const result = await this.withProgress('OCR', p => runOcr(s, pages, String(f.lang), (x, t) => { p.set(x, t); return !p.cancelled(); }));
    if (result) toast(`Read ${result.words.toLocaleString()} words on ${result.pages} page${result.pages > 1 ? 's' : ''}. Save to keep them.`, 'ok', 6000);
  }

  async compareDialog() {
    const s = this.session;
    if (!s) return;
    const [other] = await pickFiles('.pdf');
    if (!other) return;
    const mine = await this.withProgress('Preparing', async p => (await buildFile(s, {}, s.pages, x => p.set(x, 'Preparing…'))).blob);
    if (mine) await compareFiles(mine, s.name, other, other.name);
  }

  exportXfdfCmd() {
    const s = this.session;
    if (!s) return;
    downloadBlob(new Blob([exportXfdf(s)], { type: 'application/vnd.adobe.xfdf' }), `${baseName(s.name)}.xfdf`);
  }

  async importXfdfCmd() {
    const s = this.session;
    if (!s) return;
    const [f] = await pickFiles('.xfdf,.xml');
    if (!f) return;
    const n = importXfdf(s, await f.text());
    toast(n ? `Imported ${n} annotation${n > 1 ? 's' : ''}.` : 'No annotations were found in that file.', n ? 'ok' : 'info');
  }

  async print() {
    const s = this.session;
    if (!s) return;
    await this.withProgress('Preparing to print', p => this.withBuilt(p, pdf => printPdf(pdf, this.tick(p))));
  }

  // ---- Reading ----

  async reflow() {
    const s = this.session;
    if (!s) return;
    const body = h('div', { class: 'reflow', dir: 'auto' });
    let size = 16;
    const setSize = () => { body.style.fontSize = `${size}px`; };
    setSize();
    let next = this.viewer.current;
    const more = h('button', { class: 'btn small', onclick: safe(() => loadMore(), 'Reading') }, 'Load more pages');
    const loadMore = async () => {
      for (let n = 0; n < 5 && next < s.pages.length; n++, next++) {
        const page = s.pages[next];
        const src = page.source ? s.sources.get(page.source) : null;
        if (!src) continue;
        const lines = await linesOf(src.pdf, page.index);
        const sizes = lines.map(l => Math.round(l.size)).sort((a, b) => a - b);
        const bodySize = sizes[Math.floor(sizes.length / 2)] ?? 11;
        for (const p of toParagraphs(lines, next, bodySize)) body.append(p.heading ? h('h3', { dir: 'auto' }, p.text) : h('p', { dir: 'auto' }, p.text));
        body.append(h('hr'));
      }
      more.hidden = next >= s.pages.length;
    };
    await loadMore();
    if (!body.textContent?.trim()) body.append(h('p', null, 'No text was found. Run OCR first if these pages are scanned.'));
    await openDialog('Reflow', h('div', null,
      h('div', { class: 'reflow-bar' },
        h('button', { class: 'btn small', onclick: () => { size = Math.max(11, size - 1); setSize(); } }, 'A−'),
        h('button', { class: 'btn small', onclick: () => { size = Math.min(34, size + 1); setSize(); } }, 'A+'),
        more),
      body), [{ label: 'Close', value: true, primary: true }], true, undefined, true);
  }

  async readAloud() {
    const s = this.session;
    if (!s) return;
    if (!('speechSynthesis' in window)) { toast('Read aloud is not available on this PC.', 'info'); return; }
    if (this.speaking) { this.stopReading(); return; }
    const run = ++this.speechRun;
    const live = () => run === this.speechRun && this.session === s;
    this.setSpeaking(true);
    try {
      for (let i = this.viewer.current; i < s.pages.length && live(); i++) {
        const page = s.pages[i];
        const src = page.source ? s.sources.get(page.source) : null;
        if (!src) continue;
        const lines = await linesOf(src.pdf, page.index);
        // Stopped, or another document opened, while the page text was being read.
        if (!live()) return;
        const text = lines.map(l => l.text).join(' ').trim();
        if (!text) continue;
        this.viewer.goTo(i);
        await new Promise<void>(res => {
          const u = new SpeechSynthesisUtterance(text);
          // Stop ends this wait itself: Windows does not always report a cancelled voice.
          const done = () => {
            u.onend = u.onerror = null;
            if (this.speechWait?.done === done) this.speechWait = null;
            res();
          };
          u.onend = done;
          u.onerror = done;
          this.speechWait = { run, done };
          speechSynthesis.speak(u);
        });
      }
    } finally {
      if (run === this.speechRun) this.setSpeaking(false);
    }
  }

  /** Stops Read aloud at once, including a reading still waiting for its page text. */
  stopReading() {
    if (!this.speaking) return;
    const wait = this.speechWait?.run === this.speechRun ? this.speechWait : null;
    this.speechRun++;
    speechSynthesis.cancel();
    wait?.done();
    this.setSpeaking(false);
  }

  private setSpeaking(on: boolean) {
    this.speaking = on;
    this.speechBar.hidden = !on;
    this.syncRibbon();
  }

  // ---- Search highlights ----

  private drawMatchesOn(v: PageView) {
    const search = this.panels.search;
    const list = search.matchesFor(v.page.id);
    const cur = search.matches[search.current];
    v.matches.replaceChildren(...list.flatMap(m => m.boxes.map(b => {
      const p0 = toScreen(v.vp, b.x, b.y), p1 = toScreen(v.vp, b.x + b.w, b.y + b.h);
      return h('div', {
        class: `match${m === cur ? ' current' : ''}`,
        style: {
          left: `${Math.min(p0[0], p1[0])}px`, top: `${Math.min(p0[1], p1[1])}px`,
          width: `${Math.abs(p1[0] - p0[0])}px`, height: `${Math.abs(p1[1] - p0[1])}px`,
        },
      });
    })));
  }

  redrawMatches() { for (const v of this.viewer.views.values()) this.drawMatchesOn(v); }

  redrawAllPages() {
    for (const v of this.viewer.views.values()) v.needsRender = true;
    this.viewer.schedule();
  }

  // ---- Start screen and recovery ----

  /** Draws the Home screen when it is showing. */
  private async drawStart() {
    if (this.session && !this.showingHome) return;
    await this.home.draw();
  }

  toggleHome() { if (this.showingHome) this.hideHome(); else if (this.session) { this.showingHome = true; this.refresh(); void this.drawStart(); } }

  hideHome() { if (this.showingHome) { this.showingHome = false; this.refresh(); } }

  /** Right-click on a document tab. */
  private tabMenu(e: MouseEvent, s: Session) {
    showMenu(e.clientX, e.clientY, [
      { label: 'Reload from disk', icon: 'rotR', run: () => this.reloadFromDisk(s) },
      { label: 'Copy file path', icon: 'copy', run: () => this.copyFilePath(s) },
      { label: 'Add to collection…', icon: 'folder', run: () => this.addToCollection(s) },
      s.collectionId ? { label: 'Remove from group', icon: 'folder', run: () => this.moveToCollection(s, null) } : null,
      { label: 'Close', icon: 'close', key: keyLabel('close-tab'), run: () => this.closeSession(s) },
      this.sessions.length > 1 ? { label: 'Close the others', icon: 'close', run: async () => { for (const o of [...this.sessions]) if (o !== s) await this.closeSession(o); } } : null,
    ].filter(Boolean) as MenuItem[]);
  }

  /** The file on disk a tab came from: its handle, or the dropped or pasted file itself. Never a generated or converted one. */
  private diskFile(s: Session): FileSystemFileHandle | File | null {
    if (s.handle) return s.handle;
    if (s.reloadHandle) return s.reloadHandle;
    const first = [...s.sources.values()][0];
    return first?.blob instanceof File && first.name === s.name ? first.blob : null;
  }

  /** Puts the full path of the tab's file on the clipboard. */
  async copyFilePath(s = this.session) {
    if (!s) return;
    const of = this.diskFile(s);
    if (!of) { toast(`“${s.name}” is not on disk yet. Save it first.`, 'info', 5000); return; }
    let r = of instanceof File ? await locateFile(of) : await locateHandle(of);
    // Opened before PDFy kept locations: the user points at the same file once.
    if (r.error === 'unknown' && !(of instanceof File)) {
      toast(`Meletiq PDF does not know where “${s.name}” is yet. Choose that same file once in the window that opens.`, 'info', 7000);
      r = await confirmSameFile(of);
    }
    if (r.error === 'cancelled') return;
    if (!r.ok || !r.path) { toast(locationProblem(r, s.name), r.error === 'unsupported' ? 'info' : 'error', 6000); return; }
    try { await navigator.clipboard.writeText(r.path); }
    catch {
      // Right after a file window closes the page may not have focus back yet.
      window.focus();
      await new Promise(done => setTimeout(done, 100));
      try { await navigator.clipboard.writeText(r.path); }
      catch { toast(`The path could not be copied. It is: ${r.path}`, 'error', 10000); return; }
    }
    toast(`Copied: ${r.path}`, 'ok');
  }

  /** Reads the tab's file again, for changes another program made. Clicking again while it runs does nothing more. */
  reloadFromDisk(s = this.session): Promise<void> {
    if (!s) return Promise.resolve();
    const current = this.reloads.get(s);
    if (current) return current;
    const job = this.reloadOnce(s).catch(err => reportError('Reloading', err)).finally(() => this.reloads.delete(s));
    this.reloads.set(s, job);
    return job;
  }

  private async reloadOnce(s: Session) {
    if (this.session === s) await this.tools.settle();
    await this.styleChanges;
    await this.saves.get(s)?.promise;
    if (this.session === s) await this.tools.settle();
    if (!this.sessions.includes(s) || this.closing.has(s)) return;
    const originalHandle = s.handle, originalName = s.name;
    let handle = s.handle ?? s.reloadHandle;
    if (!handle) {
      const of = this.diskFile(s);
      if (!(of instanceof File)) { toast(`“${s.name}” has no file on disk to reload from. Save it first.`, 'info', 5000); return; }
      // A dropped or pasted file: the Windows app finds it and hands back a handle to read it again.
      const r = await locateFile(of);
      if (!r.ok || !r.handle) { toast(locationProblem(r, s.name), r.error === 'unsupported' ? 'info' : 'error', 6000); return; }
      handle = r.handle;
    }
    if (s.dirty && !await confirmDialog(`Reload “${s.name}”?`, 'Your unsaved changes to this document will be lost, and Undo starts afresh.', 'Reload', true)) return;
    const revision = s.revision;
    const allowed = await readableHandle(handle);
    if (!allowed) { toast(`File access was not granted for “${s.name}”. The tab was left as it was.`, 'info'); return; }
    handle = allowed;
    let file: File;
    try { file = await handle.getFile(); }
    catch { toast(`“${s.name}” could not be read. It may have been moved or deleted.`, 'error'); return; }
    // A separate document, so opening the same file again is not mistaken for the open tab.
    const fresh = new Session(s.name);
    try {
      this.setStatus(`Reloading ${s.name}…`);
      fresh.pages = await fresh.addSource(file, file.name, retry => askPassword(s.name, retry));
      await this.importBookmarks(fresh);
    } catch (err) {
      await fresh.close();
      if (!(err instanceof PdfOpenError && err.kind === 'password-cancelled')) await alertDialog('Could not reload', `${s.name}\n\n${(err as Error).message}`);
      return;
    } finally {
      this.setStatus('');
    }
    if (this.session === s) await this.tools.settle();
    await this.styleChanges;
    let sameFile = false;
    try {
      const now = await handle.getFile();
      sameFile = now.lastModified === file.lastModified && now.size === file.size;
    } catch { /* A moved or changed backing file must not replace the working document. */ }
    // Closed, saved, moved or edited meanwhile: the tab keeps what it has.
    const i = this.sessions.indexOf(s);
    if (i < 0 || this.closing.has(s) || this.saves.has(s) || s.revision !== revision || s.handle !== originalHandle || s.name !== originalName || !sameFile) {
      await fresh.close();
      if (i >= 0) toast(`“${s.name}” changed while reloading, so it was left as it was.`, 'info');
      return;
    }
    rememberHandle(file, handle);
    fresh.handle = originalHandle ? handle : null;
    fresh.reloadHandle = originalHandle ? null : handle;
    fresh.tabOrder = s.tabOrder;
    fresh.collectionId = s.collectionId;
    this.sessions[i] = fresh;
    this.unlisten(s);
    this.listen(fresh);
    if (this.session === s) {
      const page = this.viewer.current;
      this.activate(fresh);
      this.viewer.goTo(Math.min(page, fresh.pages.length - 1));
    } else this.drawTabs();
    await s.close();
    void addRecent(fresh.name, handle, fresh.pages.length);
    toast(`Reloaded ${fresh.name}.`, 'ok');
  }

  /** Puts the document into one or more collections on the Home screen. */
  async addToCollection(s = this.session) {
    if (!s) return;
    if (!s.handle) { toast('Save the document first. A collection keeps a link to the file on disk.', 'info', 5000); return; }
    const collection = await this.home.chooseCollectionFor({ name: s.name, handle: s.handle });
    if (collection !== undefined) {
      s.collectionId = collection;
      if (collection) this.ungroupedTabs.delete(s); else this.ungroupedTabs.add(s);
      await this.collectionsChanged();
    }
  }

  /** Open a library selection A–Z; failures stay available for retry. */
  async openLibraryFiles(files: HomeFile[]): Promise<string[]> {
    if (!files.length) return [];
    await this.orderWrites;
    const entries = [...files].sort((a, b) => byName.compare(a.name, b.name));
    const collection = entries[0]?.collection;
    // Ask for every stored file's access first, while the click that started this still counts.
    const allowed = new Set<HomeFile>();
    for (const entry of entries) {
      const handle = entry.handle;
      if (!handle) continue;
      try {
        const readable = await readableHandle(handle);
        if (readable) { entry.handle = readable; allowed.add(entry); }
      } catch { /* Counted as failed below; the entry is kept. */ }
    }
    const located = new Map<string, { file: File; handle: FileSystemFileHandle | null }>();
    if (entries.some(file => !file.handle)) {
      try {
        if (window.showOpenFilePicker) {
          const handles = await window.showOpenFilePicker({ multiple: true, types: PDF_TYPES });
          for (const handle of handles) {
            try { const file = await handle.getFile(); located.set(file.name, { file, handle }); }
            catch { /* Other selected files can still open. */ }
          }
        } else {
          for (const file of await pickFiles('.pdf', true)) located.set(file.name, { file, handle: null });
        }
      } catch (error) { if ((error as Error).name === 'AbortError') return []; throw error; }
    }
    const ids: string[] = [], opened: Session[] = [], failed: string[] = [];
    for (const entry of entries) {
      try {
        if (entry.handle && !allowed.has(entry)) { failed.push(entry.name); continue; }
        const found = entry.handle ? { file: await entry.handle.getFile(), handle: entry.handle } : located.get(entry.name);
        if (!found) { failed.push(entry.name); continue; }
        let session: Session | null | undefined;
        if (entry.closed) session = await this.reopenClosedFile(entry.closed, found);
        else {
          if (found.handle) rememberHandle(found.file, found.handle);
          session = await this.openPdfBlob(found.file, found.file.name, found.handle);
        }
        if (session) { ids.push(entry.id); if (!opened.includes(session)) opened.push(session); }
        else failed.push(entry.name);
      } catch { failed.push(entry.name); }
    }
    // Reuse already-open documents; a tab closed while later files loaded stays closed.
    const live = opened.filter(s => this.sessions.includes(s));
    if (live.length) {
      if (collection) {
        for (const s of live) { s.collectionId = collection; this.ungroupedTabs.delete(s); }
        const group = this.tabGroups.get(collection);
        if (group) { group.collapsed = false; void updateCollection(group); }
      }
      this.sortOpenedTabs(); this.drawTabs();
    }
    if (failed.length) toast(`Could not open ${failed.slice(0, 3).map(name => `“${name}”`).join(', ')}${failed.length > 3 ? ` and ${failed.length - 3} more` : ''}. Their entries were kept.`, 'error', 6000);
    return ids;
  }

  /** Opens the document closed most recently, at the page it was on. */
  async reopenClosed() {
    const [last] = await listClosed();
    if (!last) { toast('No recently closed documents.', 'info'); return; }
    await this.reopenClosedFile(last);
  }

  /** A closed entry stays in the list until its document has actually opened. */
  async reopenClosedFile(last: ClosedFile, located?: { file: File; handle: FileSystemFileHandle | null }) {
    let handle = last.handle;
    let file: File;
    if (located) { file = located.file; handle = located.handle; }
    else if (!handle) {
      toast(`Choose “${last.name}” to reopen it.`, 'info');
      try {
        if (window.showOpenFilePicker) {
          [handle] = await window.showOpenFilePicker({ multiple: false, types: PDF_TYPES });
          if (!handle) return;
          file = await handle.getFile();
        } else {
          [file] = await pickFiles('.pdf', false);
          if (!file) return;
        }
      } catch (error) {
        if ((error as Error).name === 'AbortError') return;
        throw error;
      }
      if (file.name !== last.name) { toast(`Choose “${last.name}” to reopen this entry.`, 'info'); return; }
    } else {
      const allowed = await readableHandle(handle);
      if (!allowed) { toast(`File access was not granted for “${last.name}”. Its history entry is still available.`, 'info'); return; }
      handle = allowed;
      try { file = await handle.getFile(); }
      catch { toast(`“${last.name}” could not be opened. It may have moved or been deleted.`, 'error'); return; }
    }
    if (handle) rememberHandle(file, handle);
    this.hideHome();
    const opened = await this.openPdfBlob(file, last.name, handle);
    if (!opened) return;
    this.viewer.goTo(Math.min(last.page, opened.pages.length - 1));
    await removeClosed(last.id);
    return opened;
  }

  private async checkRecovery() {
    const journals = await listJournals();
    if (!journals.length) return;
    const ok = await openDialog('Recover your work?',
      h('div', null, h('p', null, 'Meletiq PDF did not close normally. These documents have unsaved changes:'),
        h('ul', { class: 'plain-list' }, ...journals.map(j => h('li', null, j.name)))),
      [{ label: 'Discard', value: false }, { label: 'Recover', value: true, primary: true }], false);
    for (const j of journals) {
      if (!ok) { await dropJournal(j.id); continue; }
      try {
        await this.recover(j);
        await dropJournal(j.id);
      } catch (err) {
        // Keep the data, so it is offered again next time.
        reportError(`Recovering ${j.name}`, err);
      }
    }
  }

  private async recover(j: Journal) {
    const session = new Session(j.name);
    session.handle = j.handle;
    for (const attachment of j.attachments ?? []) {
      const blob = await loadAsset(attachment.asset);
      if (!blob) throw new Error(`The recovered attachment "${attachment.name}" could not be read.`);
      session.attachments.push({ name: attachment.name, blob });
    }
    session.ocrWords = new Map(j.ocrWords ?? []);
    session.pendingOptions = j.pendingOptions ?? {};
    const map = new Map<string, string>();
    const missing: string[] = [];
    for (const src of j.sources) {
      let blob: Blob | undefined;
      if (src.handle) {
        try {
          const ok = (await src.handle.queryPermission?.({ mode: 'read' })) === 'granted' || (await src.handle.requestPermission?.({ mode: 'read' })) === 'granted';
          if (ok) { blob = await src.handle.getFile(); rememberHandle(blob, src.handle); }
        } catch (err) { console.warn('Could not reach', src.name, err); }
      } else if (src.copy) {
        blob = await loadAsset(src.copy);
      }
      if (!blob) { missing.push(src.name); continue; }
      const before = new Set(session.sources.keys());
      await session.addSource(blob, src.name, retry => askPassword(src.name, retry));
      const id = [...session.sources.keys()].find(k => !before.has(k))!;
      map.set(src.id, id);
      const made = session.sources.get(id)!;
      if (src.forms) {
        const storage = made.pdf.annotationStorage as unknown as { setValue(k: string, v: unknown): void };
        for (const [k, v] of Object.entries(src.forms)) storage.setValue(k, v);
        made.formsEdited = true;
      }
    }
    const pages: PageRef[] = [];
    for (const p of j.pages) {
      const annots = await restoreAnnots(p.annots);
      const source = p.source ? map.get(p.source) ?? null : null;
      pages.push({ ...p, source, annots });
      // Existing annotations that had been edited or deleted must stay hidden from the engine.
      if (source) {
        const storage = session.sources.get(source)!.pdf.annotationStorage as unknown as { setValue(k: string, v: unknown): void };
        for (const id of p.removed) storage.setValue(id, { noView: true });
        for (const a of annots) if (a.importedFrom) storage.setValue(a.importedFrom, { noView: true });
      }
    }
    session.pages = pages;
    session.bookmarks = j.bookmarks;
    session.markDirty();
    this.add(session);
    if (missing.length) toast(`Could not find: ${missing.join(', ')}. Those pages are blank, and your edits on them were kept.`, 'error', 9000);
    else toast(`Recovered ${j.name}.`, 'ok');
    await saveJournal(session).catch(() => {});
  }
}

export const formatSize = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export { $, annotBounds, openPdf };
