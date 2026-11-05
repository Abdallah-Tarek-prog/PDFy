// The main window: document tabs, ribbon, file handling, and all the commands.

import { zipSync, type Zippable } from 'fflate';
import { openPdf, PdfOpenError } from './core/engine';
import { annotBounds, remapAnnot } from './core/geometry';
import { buildFile, inspectFile } from './core/jobs';
import { uid, type Annot, type BuildOptions, type ImageAsset, type PageRef } from './core/model';
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
import { addRecent, dropJournal, listJournals, listRecent, loadAsset, rememberHandle, removeRecent, restoreAnnots, saveJournal, type Journal, type RecentFile } from './features/recovery';
import { exportXfdf, importXfdf } from './features/xfdf';
import { THEME_STYLES } from './theme/presets';
import { alertDialog, askPassword, cameraDialog, confirmDialog, formDialog, openDialog, progressDialog, signatureDialog, type Field, type ProgressHandle } from './ui/dialogs';
import { $, baseName, clear, downloadBlob, h, icon, parseRanges, pickFiles, reportError, safe, toast } from './ui/dom';
import { ImageBar, pasteMode } from './ui/imagebar';
import { getSettings, lastPage, rememberPage, saveSettings } from './core/settings';
import { closeMenu, showMenu, type MenuItem } from './ui/menu';
import { Study } from './study/ui';
import { closeDictionary } from './study/dictpopup';
import { closeWordLayer } from './study/readpicture';
import { colourButton } from './ui/colorpicker';
import { fontButton } from './ui/fontpicker';
import { Panels } from './ui/panels';
import { Tools, type Tool } from './view/tools';
import { toScreen, viewportFor } from './core/model';
import { Viewer, type PageView } from './view/viewer';

type RItem = { icon: string; label: string; title?: string; tool?: Tool; run?: () => unknown; needsDoc?: boolean; id?: string };
type RTab = { id: string; label: string; groups: RItem[][] };

const COLOURS = ['#111111', '#d92d20', '#f79009', '#ffd400', '#0b8a4f', '#1a56db', '#7a5af8', '#ffffff'];
const STAMPS: [string, string][] = [['APPROVED', '#0b8a4f'], ['REJECTED', '#d92d20'], ['DRAFT', '#1a56db'], ['FINAL', '#0b8a4f'], ['CONFIDENTIAL', '#d92d20'], ['REVIEWED', '#7a5af8'], ['VOID', '#d92d20'], ['COPY', '#475467'], ['FOR COMMENT', '#b54708']];
const PDF_TYPES: FilePickerType[] = [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }];

export class App {
  sessions: Session[] = [];
  session: Session | null = null;
  viewer!: Viewer;
  tools!: Tools;
  panels!: Panels;
  imageBar!: ImageBar;

  private tabsEl = h('div', { class: 'doc-tabs', role: 'tablist' });
  private ribbonTabs = h('div', { class: 'ribbon-tabs', role: 'tablist' });
  private ribbonEl = h('div', { class: 'ribbon', role: 'toolbar', 'aria-label': 'Tools' });
  private styleBar = h('div', { class: 'style-bar', 'aria-label': 'Style' });
  private startEl = h('div', { class: 'start' });
  private pageInput = h('input', { class: 'page-input', 'aria-label': 'Page number', inputmode: 'numeric' });
  private pageTotal = h('span', null, '');
  private zoomInput = h('input', { class: 'zoom-input', 'aria-label': 'Zoom', inputmode: 'numeric' });
  private memEl = h('span', { title: 'Memory the page is using right now' });
  private statusMsg = h('span', { class: 'grow' });
  private activeTab = 'home';
  private tabs: RTab[] = [];
  private buttons = new Map<RItem, HTMLButtonElement>();
  private journalTimer = 0;
  private journalOff = new Map<Session, () => void>();
  private clip: { annot: Annot; pageId: string } | null = null;
  private stampLabel = 'APPROVED';
  private signature: Annot['image'] | null = null;
  private measure = this.loadMeasure();
  private speaking = false;
  reading: 'normal' | 'night' | 'sepia' = 'normal';
  study!: Study;

  constructor(root: HTMLElement) {
    const viewerEl = h('div', { class: 'viewer', tabindex: 0, 'aria-label': 'Document' });
    this.viewer = new Viewer(viewerEl);
    this.tools = new Tools(this.viewer);
    this.panels = new Panels(this);
    this.imageBar = new ImageBar(this.viewer, () => this.deleteSelection(), () => {
      this.cropTarget = this.viewer.selection;
      this.tools.setTool('crop-image');
    });
    this.study = new Study(this);
    this.tabs = this.defineTabs();

    const themeBtn = h('button', { class: 'icon-btn', title: 'Light or dark interface', 'aria-label': 'Switch interface theme', onclick: () => this.toggleUiTheme() }, icon('contrast', 16));
    root.append(
      h('header', { class: 'titlebar' },
        h('div', { class: 'brand' }, icon('contrast', 18), h('span', null, 'PDFy')),
        this.tabsEl,
        h('div', { class: 'title-actions' },
          h('button', { class: 'icon-btn', title: 'Open (Ctrl+O)', 'aria-label': 'Open', onclick: safe(() => this.openDialog(), 'Opening') }, icon('plus', 16)),
          h('button', { class: 'icon-btn', title: 'Shortcuts (F1)', 'aria-label': 'Shortcuts', onclick: safe(() => this.showHelp(), 'Help') }, icon('info', 16)),
          h('button', { class: 'icon-btn', title: 'Preferences', 'aria-label': 'Preferences', onclick: safe(() => this.settingsDialog(), 'Preferences') }, icon('settings', 16)),
          themeBtn)),
      h('div', { class: 'ribbon-wrap' }, this.ribbonTabs, this.ribbonEl, this.styleBar),
      h('main', { class: 'workspace' }, this.panels.rail, this.panels.host, h('div', { style: { flex: '1', position: 'relative', display: 'flex', minWidth: '0' } }, viewerEl, this.startEl)),
      h('footer', { class: 'statusbar' },
        h('div', { class: 'status-group' },
          h('button', { class: 'icon-btn small', title: 'Previous page', 'aria-label': 'Previous page', onclick: () => this.viewer.goTo(this.viewer.current - 1) }, icon('chevLeft', 14)),
          'Page', this.pageInput, 'of', this.pageTotal,
          h('button', { class: 'icon-btn small', title: 'Next page', 'aria-label': 'Next page', onclick: () => this.viewer.goTo(this.viewer.current + 1) }, icon('chevRight', 14))),
        h('div', { class: 'status-group' },
          h('button', { class: 'icon-btn small', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => this.zoomBy(0.85) }, icon('zoomOut', 14)),
          this.zoomInput,
          h('button', { class: 'icon-btn small', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => this.zoomBy(1.18) }, icon('zoomIn', 14))),
        this.statusMsg,
        this.memEl),
    );

    this.drawTabsRibbon();
    this.drawStyleBar();
    this.wire();
    this.buildSelBar();
    this.refresh();
    void this.drawStart();
    void this.checkRecovery();
    setInterval(() => this.updateMemory(), 3000);
  }

  // ---- Wiring ----

  private wire() {
    const v = this.viewer;
    v.hooks.onScale = s => { this.zoomInput.value = `${Math.round(s * 100)}%`; this.imageBar.sync(); };
    v.hooks.onPage = i => {
      this.pageInput.value = String(i + 1);
      this.panels.change('page');
      const s = this.session;
      if (s?.handle) {
        clearTimeout(this.pageTimer);
        this.pageTimer = window.setTimeout(() => rememberPage(`${s.name}:${s.pages.length}`, i), 800);
      }
    };
    v.hooks.drawMatches = pv => this.drawMatchesOn(pv);
    v.hooks.onMounted = pv => { this.drawMatchesOn(pv); this.imageBar.sync(); };
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

  async settingsDialog() {
    await this.study.preferencesDialog();
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
    if (!sel || !text || !sel.rangeCount || this.tools.tool !== 'select' || !this.viewer.scroller.contains(sel.anchorNode)) { this.selBar.hidden = true; return; }
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

  private defineTabs(): RTab[] {
    const t = (tool: Tool, ic: string, label: string, title?: string): RItem => ({ tool, icon: ic, label, title, needsDoc: true });
    const a = (ic: string, label: string, run: () => unknown, title?: string, needsDoc = true): RItem => ({ icon: ic, label, run, title, needsDoc });
    return [
      {
        id: 'home', label: 'Home', groups: [
          [a('open', 'Open', () => this.openDialog(), 'Open a PDF or image (Ctrl+O)', false), a('file', 'New', () => this.newDocument(), 'New blank document', false),
            a('save', 'Save', () => this.save(), 'Save (Ctrl+S)'), a('saveas', 'Save as', () => this.save(true), 'Save a copy (Ctrl+Shift+S)'), a('print', 'Print', () => this.print(), 'Print (Ctrl+P)')],
          [a('undo', 'Undo', () => this.session?.undo(), 'Undo (Ctrl+Z)'), a('redo', 'Redo', () => this.session?.redo(), 'Redo (Ctrl+Y)')],
          [t('hand', 'hand', 'Hand', 'Drag to move around (H)'), t('select', 'cursor', 'Select', 'Select text and objects (V)')],
          [a('fitWidth', 'Fit width', () => this.viewer.setFit('width')), a('fitPage', 'Fit page', () => this.viewer.setFit('page'), 'Fit whole page (Ctrl+0)')],
          [a('continuous', 'Scroll', () => this.viewer.setLayout('continuous'), 'Continuous pages'), a('facing', 'Two pages', () => this.viewer.setLayout('facing')), a('single', 'One page', () => this.viewer.setLayout('single'))],
          [a('sun', 'Normal', () => this.setReading('normal'), 'Normal page colours'), a('moon', 'Night', () => this.setReading('night'), 'Dark pages for reading at night'), a('book', 'Sepia', () => this.setReading('sepia'), 'Warm pages for long reading')],
          [a('reflow', 'Reflow', () => this.reflow(), 'Read as plain text that fits the window'), a('speak', 'Read aloud', () => this.readAloud()), a('fullscreen', 'Full screen', () => this.fullscreen(), 'Full screen (F11)', false)],
        ],
      },
      {
        id: 'study', label: 'Study', groups: [
          [a('book', 'Word lookup', () => this.study.toggleLookup(), 'Turn word lookup on or off. When on, double-click or select a word to see its meaning, sound and Arabic', false), t('read-picture', 'ocr', 'Read picture', 'Drag over an image or scan, then click any word in it to look it up')],
          [t('markdown', 'text', 'Markdown note', 'Click on the page and type Markdown. It turns into formatted notes when you click away (Ctrl+Shift+M)'), a('sigma', 'Equation', () => this.study.insertEquation(), 'Write an equation in LaTeX, with a live preview (Ctrl+Shift+E)')],
          [a('palette', 'Note themes', () => this.study.themesDialog(), 'Fonts, colours and spacing for Markdown notes', false), a('settings', 'Preferences', () => this.settingsDialog(), 'One-click preference sets, and every other setting', false)],
        ],
      },
      {
        id: 'comment', label: 'Comment', groups: [
          [t('highlight', 'highlight', 'Highlight'), t('underline', 'underline', 'Underline'), t('strikeout', 'strike', 'Strikeout'), t('squiggly', 'squiggly', 'Squiggly')],
          [t('pen', 'pen', 'Pen'), t('marker', 'marker', 'Marker'), t('eraser', 'eraser', 'Eraser', 'Removes pen and marker strokes')],
          [t('text', 'text', 'Text box'), t('callout', 'callout', 'Callout'), t('note', 'note', 'Note')],
          [a('stamp', 'Stamp', () => this.chooseStamp()), a('signature', 'Sign', () => this.chooseSignature(), 'Draw, type or upload a signature')],
          [a('attach', 'Attach file', () => this.attachFileCmd(), 'Pin a file to a spot on the page'), a('speak', 'Voice note', () => this.voiceNoteCmd(), 'Record a short voice note and pin it to the page')],
        ],
      },
      {
        id: 'shapes', label: 'Shapes', groups: [
          [t('rect', 'rect', 'Rectangle'), t('ellipse', 'ellipse', 'Ellipse'), t('line', 'line', 'Line', 'Hold Shift for straight angles'), t('arrow', 'arrow', 'Arrow')],
          [t('polygon', 'polygon', 'Polygon', 'Click points, double-click to finish'), t('polyline', 'polyline', 'Polyline', 'Click points, double-click to finish'), t('cloud', 'cloud', 'Cloud', 'Click points, double-click to finish')],
          [t('distance', 'ruler', 'Distance'), t('perimeter', 'perimeter', 'Perimeter', 'Click points, double-click to finish'), t('area', 'area', 'Area', 'Click points, double-click to finish'), a('scale', 'Scale', () => this.setMeasureScale(), 'Set the real-world scale')],
        ],
      },
      {
        id: 'insert', label: 'Insert', groups: [
          [a('paste', 'Paste image', () => this.pasteFromClipboard(), 'Paste a copied image (Ctrl+V)', false), a('image', 'Image file', () => this.insertImage()),
            t('snip', 'snip', 'Theme snip', 'Drag over any area of a page to convert its theme'), a('pageTheme', 'Page theme', () => this.convertPagesDialog(), 'Convert whole pages to light or dark'),
            a('contrast', 'All images', () => this.convertAllDialog(), 'Convert every image in this document')],
          [t('markdown', 'text', 'Markdown note', 'Click on the page and type Markdown'), a('sigma', 'Equation', () => this.study.insertEquation(), 'Write an equation in LaTeX'), t('link', 'link', 'Link', 'Drag a box, then enter a web address')],
          [a('watermark', 'Watermark', () => this.watermarkDialog()), a('header', 'Header & footer', () => this.headerFooterDialog()), a('numbers', 'Page numbers', () => this.pageNumbersDialog()), a('bates', 'Bates numbers', () => this.batesDialog())],
        ],
      },
      {
        id: 'edit', label: 'Edit', groups: [
          [t('edit-text', 'editText', 'Edit text', 'Click a line of text on the page to change it'), t('whiteout', 'whiteout', 'White-out', 'Cover part of the page')],
          [t('redact', 'redact', 'Mark redaction', 'Drag over what should be removed'), a('searchRedact', 'Find & redact', () => this.panels.show('search'), 'Search, then mark all results'), a('check', 'Apply redactions', () => this.applyRedactionsCmd(), 'Permanently remove everything marked')],
        ],
      },
      {
        id: 'pages', label: 'Pages', groups: [
          [a('rotL', 'Rotate left', () => this.rotatePages(-90)), a('rotR', 'Rotate right', () => this.rotatePages(90)), a('trash', 'Delete', () => this.deletePages()), a('copy', 'Duplicate', () => this.duplicatePages())],
          [a('plus', 'Blank page', () => this.insertBlank()), a('insertFile', 'From file', () => this.insertFromFile(), 'Insert pages from a PDF or image after this page'), a('merge', 'Merge', () => this.mergeFiles(), 'Add other PDFs to the end', false)],
          [a('extract', 'Extract', () => this.extractPages(), 'Save some pages as a new file'), a('split', 'Split', () => this.splitDialog(), 'Break into several files'), t('crop', 'crop', 'Crop', 'Drag a box to crop to')],
        ],
      },
      {
        id: 'forms', label: 'Forms', groups: [
          [t('field-text', 'field', 'Text field'), t('field-check', 'checkbox', 'Checkbox'), t('field-radio', 'radio', 'Radio'), t('field-dropdown', 'dropdown', 'Dropdown'), t('field-list', 'list', 'List'), t('field-signature', 'signature', 'Signature field')],
          [a('search', 'Detect fields', () => this.detectFieldsCmd(), 'Find blank lines and boxes and turn them into fields'), a('flatten', 'Flatten forms', () => this.flatten(false, true), 'Make form values part of the page')],
        ],
      },
      {
        id: 'protect', label: 'Protect', groups: [
          [a('lock', 'Add password', () => this.passwordDialog()), a('unlock', 'Remove password', () => this.removePassword())],
          [a('signature', 'Digital signature', () => this.certSignDialog(), 'Sign with a digital ID, which proves the file has not changed'), a('plus', 'Create digital ID', () => this.createIdDialog(), 'Make your own digital ID', false)],
          [a('broom', 'Clean metadata', () => this.cleanMetadata(), 'Remove author, dates and other hidden information'), a('info', 'Properties', () => this.propertiesDialog())],
          [a('check', 'Check file', () => this.checkDocument(), 'PDF/A and accessibility check'), a('file', 'Save as PDF/A', () => this.savePdfA(), 'Archive format')],
        ],
      },
      {
        id: 'convert', label: 'Convert', groups: [
          [a('toImage', 'To images', () => this.exportImagesDialog()), a('toText', 'To text', () => this.exportAs('txt')), a('toHtml', 'To HTML', () => this.exportAs('html')), a('word', 'To Word', () => this.exportAs('docx')), a('excel', 'To Excel', () => this.exportAs('xlsx')), a('ppt', 'To PowerPoint', () => this.exportAs('pptx'))],
          [a('word', 'Word editor', () => this.wordEditorCmd(), 'Open and change a Word file, or start a new one', false)],
          [a('imagesToPdf', 'Images to PDF', () => this.imagesToPdf(), undefined, false), a('file', 'Office to PDF', () => this.officeToPdf(), 'Word, Excel or PowerPoint to PDF', false), a('link', 'Web to PDF', () => this.webToPdf(), 'Turn a web page into a PDF', false), a('camera', 'Scan', () => this.scanCmd(), 'Take pictures with the camera', false), a('image', 'Convert image', () => this.convertImageCmd(), 'HEIC or DICOM to JPG or PNG', false), a('ocr', 'OCR', () => this.ocrDialog(), 'Make scanned pages searchable')],
          [a('compress', 'Compress', () => this.compressDialog()), a('flatten', 'Flatten', () => this.flatten(true, true), 'Make all annotations part of the page')],
          [a('compare', 'Compare', () => this.compareDialog(), 'Compare with another PDF'), a('toText', 'Text compare', () => this.textCompareDialog(), 'Compare two pieces of text', false), a('batch', 'Batch', () => this.batchDialog(), 'Do the same job on many PDFs', false)],
          [a('xfdfOut', 'Export notes', () => this.exportXfdfCmd(), 'Save annotations to an XFDF file'), a('xfdfIn', 'Import notes', () => this.importXfdfCmd(), 'Load annotations from an XFDF file')],
        ],
      },
    ];
  }

  private drawTabsRibbon() {
    clear(this.ribbonTabs);
    for (const tab of this.tabs) {
      this.ribbonTabs.append(h('button', {
        class: `ribbon-tab${tab.id === this.activeTab ? ' active' : ''}`, role: 'tab', 'aria-selected': String(tab.id === this.activeTab),
        onclick: () => { this.activeTab = tab.id; this.drawTabsRibbon(); },
      }, tab.label));
    }
    clear(this.ribbonEl);
    this.buttons.clear();
    const tab = this.tabs.find(x => x.id === this.activeTab)!;
    for (const group of tab.groups) {
      const g = h('div', { class: 'r-group' });
      for (const item of group) {
        const b = h('button', {
          class: 'r-btn', title: item.title ?? item.label,
          onclick: safe(() => {
            if (item.tool) this.tools.setTool(this.tools.tool === item.tool && item.tool !== 'select' ? 'select' : item.tool);
            else return item.run?.();
          }, item.label),
        }, icon(item.icon, 19), h('span', null, item.label));
        this.buttons.set(item, b);
        g.append(b);
      }
      this.ribbonEl.append(g);
    }
    this.syncRibbon();
  }

  private syncRibbon() {
    const has = !!this.session;
    for (const [item, b] of this.buttons) {
      b.disabled = !!item.needsDoc && !has;
      if (item.tool) {
        const on = this.tools.tool === item.tool;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      }
      if (item.label === 'Undo') { b.disabled = !this.session?.canUndo; b.title = this.session?.undoLabel ? `Undo: ${this.session.undoLabel}` : 'Undo (Ctrl+Z)'; }
      if (item.label === 'Redo') { b.disabled = !this.session?.canRedo; b.title = this.session?.redoLabel ? `Redo: ${this.session.redoLabel}` : 'Redo (Ctrl+Y)'; }
      if (item.label === 'Word lookup') { b.classList.toggle('active', this.study.lookupOn); b.setAttribute('aria-pressed', String(this.study.lookupOn)); }
      if (item.label === 'Normal') b.classList.toggle('active', this.reading === 'normal');
      if (item.label === 'Night') b.classList.toggle('active', this.reading === 'night');
      if (item.label === 'Sepia') b.classList.toggle('active', this.reading === 'sepia');
      if (item.label === 'Scroll') b.classList.toggle('active', this.viewer.layout === 'continuous');
      if (item.label === 'Two pages') b.classList.toggle('active', this.viewer.layout === 'facing');
      if (item.label === 'One page') b.classList.toggle('active', this.viewer.layout === 'single');
    }
    this.drawStyleBar();
  }

  private drawStyleBar() {
    const bar = this.styleBar;
    clear(bar);
    const sel = this.viewer.selectedAnnot();
    const tool = this.tools.tool;
    const hints: Partial<Record<Tool, string>> = {
      select: 'Select text or click an object. Double-click to edit. Press Delete to remove.',
      hand: 'Drag the page to move around.',
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
      polyline: 'Click each point. Double-click or press Enter to finish.',
      cloud: 'Click each corner. Double-click or press Enter to finish.',
      perimeter: 'Click each point. Double-click or press Enter to finish.',
      area: 'Click each corner. Double-click or press Enter to finish.',
    };

    if (this.viewer.extra.size) {
      bar.append(h('span', { class: 'style-hint' }, `${this.viewer.extra.size + 1} objects selected. Drag to move them together.`));
      for (const [how, label] of [['left', 'Left'], ['center', 'Centre'], ['right', 'Right'], ['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']] as const) {
        bar.append(h('button', { class: 'btn small', title: `Align ${label.toLowerCase()}`, onclick: () => this.align(how) }, label));
      }
      return;
    }
    if (sel?.annot.kind === 'image') { bar.append(h('span', { class: 'style-hint' }, 'Image selected. Use the bar above it to convert the theme.')); return; }
    if (tool === 'markdown' || sel?.annot.markdown) { this.drawNoteBar(bar, sel); return; }
    if (sel?.annot.kind === 'math') { this.drawEquationBar(bar, sel); return; }
    const showStyle = !!sel || (!['select', 'hand', 'snip', 'read-picture', 'crop', 'crop-image', 'cert-box', 'edit-text', 'eraser', 'redact', 'whiteout', 'link'].includes(tool) && !tool.startsWith('field-'));
    if (!showStyle) { bar.append(h('span', { class: 'style-hint' }, hints[tool] ?? '')); return; }

    const style = sel ? { color: sel.annot.color, width: sel.annot.width, opacity: sel.annot.opacity, fill: sel.annot.fill ?? null, fontSize: sel.annot.fontSize ?? 12 } : this.tools.style(tool);
    const kind = sel?.annot.kind ?? tool;
    const apply = (patch: Partial<Annot>) => this.applyStyle(patch);

    const swatches = h('div', { class: 'swatches', role: 'group', 'aria-label': 'Colour' }, ...COLOURS.map(c => h('button', {
      class: `swatch-btn${style.color.toLowerCase() === c ? ' active' : ''}`, style: { background: c }, title: c, 'aria-label': `Colour ${c}`,
      onclick: () => apply({ color: c, ...(kind === 'text' || kind === 'callout' ? { textColor: c } : {}) }),
    })));
    swatches.append(colourButton(style.color, c => apply({ color: c, ...(kind === 'text' || kind === 'callout' ? { textColor: c } : {}) }), 'Any colour'));
    bar.append(swatches);

    const isStroke = !['highlight', 'text', 'note', 'stamp'].includes(kind);
    if (isStroke) {
      const w = h('input', { type: 'number', min: 0.25, max: 40, step: 0.25, value: style.width, style: { width: '58px' } });
      w.addEventListener('change', () => apply({ width: Math.max(0.25, +w.value || 1) }));
      bar.append(h('label', null, 'Thickness', w));
    }
    const op = h('select', null, ...[100, 80, 60, 40, 25].map(p => h('option', { value: p / 100, selected: Math.abs(style.opacity - p / 100) < 0.11 }, `${p}%`)));
    op.addEventListener('change', () => apply({ opacity: +op.value }));
    bar.append(h('label', null, 'Opacity', op));
    if (kind === 'text' || kind === 'callout') {
      const cur = sel?.annot ?? this.tools.style(tool);
      bar.append(h('label', null, 'Font', fontButton({ fontName: cur.fontName, font: cur.font }, c => apply({ fontName: c.fontName, font: c.font ?? cur.font }))));
      bar.append(h('button', { class: `style-toggle${cur.bold ? ' active' : ''}`, title: 'Bold', 'aria-pressed': String(!!cur.bold), onclick: () => apply({ bold: !cur.bold }) }, h('b', null, 'B')));
      bar.append(h('button', { class: `style-toggle${cur.italic ? ' active' : ''}`, title: 'Italic', 'aria-pressed': String(!!cur.italic), onclick: () => apply({ italic: !cur.italic }) }, h('i', null, 'I')));
      const fs = h('input', { type: 'number', min: 4, max: 200, step: 1, value: style.fontSize, style: { width: '58px' } });
      fs.addEventListener('change', () => apply({ fontSize: Math.max(4, +fs.value || 12) }));
      bar.append(h('label', null, 'Size', fs));
    }
    if (['rect', 'ellipse', 'polygon', 'cloud', 'text', 'callout'].includes(kind)) {
      const on = h('input', { type: 'checkbox', checked: !!style.fill });
      let fillNow = style.fill ?? '#ffffff';
      on.addEventListener('change', () => apply({ fill: on.checked ? fillNow : null }));
      bar.append(h('label', null, on, 'Fill'), colourButton(fillNow, c => { fillNow = c; apply({ fill: c }); }, 'Fill colour'));
    }
    if (hints[tool] && !sel) bar.append(h('span', { class: 'style-hint' }, hints[tool]));
  }

  /** Controls for a Markdown note: its theme and text size. */
  private drawNoteBar(bar: HTMLElement, sel: ReturnType<Viewer['selectedAnnot']>) {
    const note = sel?.annot;
    const change = (patch: Partial<Annot>) => {
      if (sel && note) void this.study.restyleNote(sel.page, note, patch).catch(err => reportError('Changing the note', err));
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
    if (note) {
      const v = this.viewer.views.get(sel!.page.id);
      if (v) bar.append(h('button', { class: 'btn small', onclick: () => this.tools.openEditor(v, note, false) }, 'Edit Markdown'));
    } else {
      bar.append(h('span', { class: 'style-hint' }, 'Click on the page, then type. It turns into formatted notes when you click away.'));
    }
  }

  /** Controls for a selected equation. */
  private drawEquationBar(bar: HTMLElement, sel: NonNullable<ReturnType<Viewer['selectedAnnot']>>) {
    const a = sel.annot;
    const change = (patch: Partial<Annot>) => { void this.study.restyleEquation(sel.page, a, patch).catch(err => reportError('Changing the equation', err)); };
    bar.append(h('label', null, 'Colour', colourButton(a.color, c => change({ color: c }), 'Equation colour')));
    const size = h('input', { type: 'number', min: 6, max: 96, step: 1, value: a.fontSize ?? 18, style: { width: '58px' } });
    size.addEventListener('change', () => change({ fontSize: Math.max(6, +size.value || 18) }));
    bar.append(h('label', null, 'Size', size));
    const v = this.viewer.views.get(sel.page.id);
    if (v) bar.append(h('button', { class: 'btn small', onclick: safe(() => this.study.editEquation(v, a), 'Editing the equation') }, 'Edit equation'));
  }

  private applyStyle(patch: Partial<Annot>) {
    const sel = this.viewer.selectedAnnot();
    if (sel && this.session) {
      const { ghost: _g, ...rest } = sel.annot;
      this.session.replaceAnnot(sel.page, sel.annot, { ...rest, ...patch }, 'Change style');
    } else {
      this.tools.setStyle(patch as never);
    }
    this.drawStyleBar();
  }

  // ---- Documents and tabs ----

  private drawTabs() {
    clear(this.tabsEl);
    for (const s of this.sessions) {
      this.tabsEl.append(h('div', {
        class: `doc-tab${s === this.session ? ' active' : ''}`, role: 'tab', 'aria-selected': String(s === this.session), tabindex: 0, title: s.name,
        onclick: () => this.activate(s),
      },
      s.dirty ? h('span', { class: 'dot', title: 'Unsaved changes' }) : null,
      h('span', { class: 'name' }, s.name),
      h('button', { class: 'icon-btn small', title: 'Close', 'aria-label': `Close ${s.name}`, onclick: safe((e: Event) => { e.stopPropagation(); return this.closeSession(s); }, 'Closing') }, icon('close', 13))));
    }
  }

  private refresh() {
    const s = this.session;
    this.startEl.hidden = !!s;
    this.viewer.scroller.style.visibility = s ? 'visible' : 'hidden';
    this.drawTabs();
    this.syncRibbon();
    this.pageInput.value = s ? String(this.viewer.current + 1) : '';
    this.pageTotal.textContent = s ? String(s.pages.length) : '–';
    this.pageInput.disabled = !s;
    this.zoomInput.disabled = !s;
    document.title = s ? `${s.name}${s.dirty ? ' •' : ''} – PDFy` : 'PDFy';
    this.updateMemory();
  }

  private updateMemory() {
    const m = performance.memory;
    const parts: string[] = [];
    if (m) parts.push(`Memory ${Math.round(m.usedJSHeapSize / 1048576)} MB`);
    if (this.session) parts.push(`${this.viewer.views.size} pages loaded`);
    this.memEl.textContent = parts.join(' · ');
  }

  add(session: Session) {
    this.sessions.push(session);
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
    this.activate(session);
  }

  activate(session: Session | null) {
    if (session === this.session && session) return;
    this.tools.cancel();
    this.tools.commitEdit();
    closeWordLayer();
    closeDictionary();
    this.session = session;
    this.viewer.attach(session);
    this.panels.attach(session);
    this.imageBar.sync();
    this.refresh();
    if (session) this.zoomInput.value = `${Math.round(this.viewer.scale * 100)}%`;
    void this.drawStart();
  }

  private scheduleJournal(session: Session) {
    clearTimeout(this.journalTimer);
    this.journalTimer = window.setTimeout(() => {
      if (!this.sessions.includes(session)) return;
      if (session.dirty) saveJournal(session).catch(err => console.warn('Recovery save', err));
      else void dropJournal(session.id);
    }, 2500);
  }

  async closeSession(session: Session) {
    await this.tools.settle();
    if (session.dirty) {
      this.activate(session);
      const choice = await openDialog<'save' | 'discard' | 'cancel'>('Unsaved changes', h('p', null, `Save your changes to "${session.name}" before closing?`),
        [{ label: 'Cancel', value: 'cancel' }, { label: "Don't save", value: 'discard' }, { label: 'Save', value: 'save', primary: true }], 'cancel');
      if (choice === 'cancel') return;
      if (choice === 'save') {
        const ok = await this.save();
        if (!ok) return;
      }
    }
    const i = this.sessions.indexOf(session);
    this.sessions.splice(i, 1);
    this.journalOff.get(session)?.();
    this.journalOff.delete(session);
    void dropJournal(session.id);
    const next = this.sessions[Math.min(i, this.sessions.length - 1)] ?? null;
    this.activate(next);
    await session.close();
    this.refresh();
  }

  /** The window is closing. Offers to save each unsaved document. False means the user cancelled. */
  async closeAllForExit(): Promise<boolean> {
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
      for (const handle of handles) await this.openHandle(handle);
      return;
    }
    const files = await pickFiles('.pdf,image/*', true);
    for (const f of files) await this.openFile(f);
  }

  async openHandle(handle: FileSystemFileHandle) {
    let file: File;
    try { file = await handle.getFile(); }
    catch { toast(`"${handle.name}" could not be read. It may have moved.`, 'error'); return; }
    rememberHandle(file, handle);
    await this.openFile(file, handle);
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
    const existing = handle && this.sessions.find(s => s.name === name && s.handle && !s.dirty);
    if (existing) { this.activate(existing); return existing; }
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
    this.add(session);
    if (handle) {
      void addRecent(name, handle, session.pages.length);
      const at = getSettings().reopenAtLastPage ? lastPage(`${name}:${session.pages.length}`) : 0;
      if (at > 0 && at < session.pages.length) this.viewer.goTo(at);
    }
    return session;
  }

  setStatus(t: string) { this.statusMsg.textContent = t; }

  newDocument(): Session {
    const s = new Session('Untitled.pdf');
    s.pages = [s.blankPage(595, 842)];
    this.add(s);
    return s;
  }

  private async onDrop(e: DragEvent) {
    document.body.classList.remove('drag-over');
    const dt = e.dataTransfer;
    if (!dt || ![...dt.types].includes('Files')) return;
    e.preventDefault();
    const items = [...dt.items].filter(i => i.kind === 'file');
    // Read handles right away. The browser clears drag data once the event ends.
    const handles = items.map(i => i.getAsFileSystemHandle?.() ?? Promise.resolve(null));
    const files = [...dt.files];
    for (let i = 0; i < files.length; i++) {
      const handle = await handles[i]?.catch(() => null);
      if (handle?.kind === 'file') await this.openHandle(handle as FileSystemFileHandle);
      else await this.openFile(files[i]);
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

  async pasteImages(blobs: Blob[], newDocName?: string) {
    const style = this.preferredStyle();
    const assets: ImageAsset[] = [];
    for (const blob of blobs) {
      try { assets.push(await assetFromBlob(await readableImage(blob), style)); }
      catch (err) { toast(`That image could not be read. ${(err as Error).message ?? ''}`, 'error'); }
    }
    if (!assets.length) return;
    let session = this.session;
    if (!session) {
      session = new Session(newDocName ? `${baseName(newDocName)}.pdf` : 'Pasted images.pdf');
      session.pages = [session.blankPage(595, 842)];
      this.add(session);
    }
    let last: { page: PageRef; annot: Annot } | null = null;
    for (const asset of assets) {
      const canGrow = session.sources.size === 0;
      const place = pastePlacement(session, Math.max(this.viewer.current, last ? session.pages.indexOf(last.page) : 0), asset, canGrow);
      if (place.added) session.setPages([...session.pages, place.page], 'Add page');
      const annot = makeImageAnnot(place.page, asset, place.x, place.y, place.w, place.h, this.authorName());
      session.addAnnots(place.page, [annot], 'Paste image');
      last = { page: place.page, annot };
    }
    if (!last) return;
    this.tools.setTool('select');
    const { page, annot } = last;
    this.viewer.goTo(session.pages.indexOf(page));
    // Wait a frame so the page exists on screen before selecting.
    requestAnimationFrame(() => requestAnimationFrame(() => { this.viewer.select(page.id, annot.id); this.onSelection(); }));
    const auto = pasteMode();
    ensureAnalysis(annot.image!).then(async () => {
      if (auto === 'off') { this.imageBar.hintAfterPaste(annot); this.imageBar.sync(); return; }
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
    this.tools.setTool('select');
    this.viewer.select(page.id, annot.id);
    this.onSelection();
  }

  private pasteClip() {
    const session = this.session!;
    const { annot } = this.clip!;
    const page = session.pages[this.viewer.current];
    const r = annot.rect;
    const copy = remapAnnot({ ...annot, id: uid(), ghost: undefined, importedFrom: undefined }, r, [r[0] + 14, r[1] - 14, r[2] + 14, r[3] - 14]);
    session.addAnnots(page, [copy], 'Paste');
    this.viewer.select(page.id, copy.id);
    this.clip = { annot: copy, pageId: page.id };
    this.onSelection();
  }

  async insertImage() {
    const files = await pickFiles('image/*', true);
    if (files.length) await this.pasteImages(files);
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
      this.tools.setTool('select');
      this.viewer.select(page.id, annot.id);
      this.onSelection();
      const v = this.viewer.views.get(page.id);
      if ((annot.kind === 'text' || annot.kind === 'callout') && v) items.push({ label: annot.markdown ? 'Edit Markdown' : 'Edit text', icon: 'text', run: () => this.tools.openEditor(v, annot, false) });
      if (annot.kind === 'math' && v) items.push({ label: 'Edit equation', icon: 'sigma', run: safe(() => this.study.editEquation(v, annot), 'Editing the equation') });
      if (annot.kind !== 'image' && v) items.push({ label: annot.contents ? 'Edit comment' : 'Add comment', icon: 'comments', run: () => this.tools.openCommentEditor(v, annot) });
      items.push(
        { label: 'Duplicate', icon: 'copy', key: 'Ctrl+D', run: () => { this.clip = { annot, pageId: page.id }; this.pasteClip(); } },
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
      items.push(
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
    const row = (keys: string, what: string) => h('tr', null, h('td', null, ...keys.split(' + ').flatMap((k, i) => [i ? ' + ' : '', h('kbd', null, k)])), h('td', null, what));
    await openDialog('Shortcuts', h('table', { class: 'help-table' },
      row('Ctrl + V', 'Paste an image, words or a copied object'),
      row('Ctrl + O', 'Open'), row('Ctrl + N', 'New document'), row('Ctrl + W', 'Close document'), row('Ctrl + Tab', 'Next document'), row('Ctrl + S', 'Save'), row('Ctrl + Shift + S', 'Save as'), row('Ctrl + P', 'Print'),
      row('Ctrl + Z', 'Undo'), row('Ctrl + Y', 'Redo'),
      row('Ctrl + F', 'Search'), row('F3', 'Next search result'),
      row('Ctrl + L', 'Look up the selected word'), row('Ctrl + Shift + M', 'New Markdown note'), row('Ctrl + Shift + E', 'New equation'),
      row('Ctrl + Wheel', 'Zoom'), row('Ctrl + 0', 'Fit the whole page'),
      row('V', 'Select'), row('H', 'Hand'), row('Space', 'Hold to drag the page'),
      row('Home', 'First page'), row('End', 'Last page'),
      row('Ctrl + Click', 'Select several objects'), row('Shift + Drag', 'Select everything in a box'),
      row('Ctrl + D', 'Duplicate the selected object'), row('Delete', 'Delete the selected object'),
      row('Arrow keys', 'Move the selected object. Hold Shift for bigger steps'),
      row('Escape', 'Stop the current tool'), row('F1', 'This list')),
    [{ label: 'Close', value: true, primary: true }], true);
  }

  // ---- Keyboard ----

  private onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    const typing = target.closest?.('input, textarea, select, [contenteditable=true]');
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (document.querySelector('.overlay-bg')) return;

    if (ctrl && k === 'o') { e.preventDefault(); void this.openDialog().catch(err => reportError('Opening', err)); return; }
    if (ctrl && k === 's') { e.preventDefault(); if (this.session) void this.save(e.shiftKey).catch(err => reportError('Saving', err)); return; }
    if (ctrl && k === 'p') { e.preventDefault(); if (this.session) void this.print().catch(err => reportError('Printing', err)); return; }
    if (ctrl && k === 'f') { e.preventDefault(); if (this.session) this.panels.show('search'); return; }
    if (ctrl && k === 'n') { e.preventDefault(); this.newDocument(); return; }
    if (ctrl && k === 'w') { e.preventDefault(); if (this.session) void this.closeSession(this.session).catch(err => reportError('Closing', err)); return; }
    if (ctrl && e.key === 'Tab' && this.sessions.length > 1) {
      e.preventDefault();
      const i = this.sessions.indexOf(this.session!);
      this.activate(this.sessions[(i + (e.shiftKey ? -1 : 1) + this.sessions.length) % this.sessions.length]);
      return;
    }
    if (ctrl && k === 'l') { e.preventDefault(); this.study.lookupSelection(); return; }
    if (ctrl && e.shiftKey && k === 'm' && this.session) { e.preventDefault(); this.tools.setTool('markdown'); return; }
    if (ctrl && e.shiftKey && k === 'e' && this.session) { e.preventDefault(); void this.study.insertEquation().catch(err => reportError('The equation', err)); return; }
    if (e.key === 'F1') { e.preventDefault(); void this.showHelp(); return; }
    if (e.key === 'F3') { e.preventDefault(); this.panels.search.step(e.shiftKey ? -1 : 1); return; }
    if (typing) return;
    if (ctrl && k === 'a' && this.session) {
      // Select the words on the current page, not the whole window.
      e.preventDefault();
      const host = this.viewer.views.get(this.session.pages[this.viewer.current]?.id)?.textHost;
      if (host) window.getSelection()?.selectAllChildren(host);
      return;
    }
    if (e.key === ' ' && this.session && this.tools.tool !== 'hand' && !e.repeat) {
      e.preventDefault();
      const back = this.tools.tool;
      this.tools.setTool('hand');
      const up = (u: KeyboardEvent) => {
        if (u.key !== ' ') return;
        document.removeEventListener('keyup', up);
        this.tools.setTool(back);
      };
      document.addEventListener('keyup', up);
      return;
    }
    if (e.key === 'Home' && this.session) { e.preventDefault(); this.viewer.goTo(0); return; }
    if (e.key === 'End' && this.session) { e.preventDefault(); this.viewer.goTo(this.session.pages.length - 1); return; }
    if (ctrl && k === 'z') { e.preventDefault(); if (e.shiftKey) this.session?.redo(); else this.session?.undo(); return; }
    if (ctrl && k === 'y') { e.preventDefault(); this.session?.redo(); return; }
    if (ctrl && k === '0') { e.preventDefault(); this.viewer.setFit('page'); return; }
    if (ctrl && (k === '=' || k === '+')) { e.preventDefault(); this.zoomBy(1.18); return; }
    if (ctrl && k === '-') { e.preventDefault(); this.zoomBy(0.85); return; }
    if (ctrl && k === 'c') {
      const sel = this.viewer.selectedAnnot();
      if (sel && !window.getSelection()?.toString()) { this.clip = { annot: sel.annot, pageId: sel.page.id }; e.preventDefault(); }
      return;
    }
    if (ctrl && k === 'd') {
      const sel = this.viewer.selectedAnnot();
      if (sel && this.session) {
        e.preventDefault();
        this.clip = { annot: sel.annot, pageId: sel.page.id };
        this.pasteClip();
      }
      return;
    }
    if (ctrl) return;
    if (e.key === 'F11') { e.preventDefault(); void this.fullscreen(); return; }
    if (e.key === 'Escape') {
      this.tools.cancel();
      if (this.tools.tool !== 'select') this.tools.setTool('select');
      else if (this.viewer.selection) { this.viewer.select(null); this.onSelection(); }
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
    if (k === 'h') this.tools.setTool('hand');
    else if (k === 'v') this.tools.setTool('select');
    else if (e.key === 'PageDown' && this.viewer.layout === 'single') { e.preventDefault(); this.viewer.goTo(this.viewer.current + 1); }
    else if (e.key === 'PageUp' && this.viewer.layout === 'single') { e.preventDefault(); this.viewer.goTo(this.viewer.current - 1); }
  }

  deleteSelection() {
    const chosen = this.viewer.selectedAnnots();
    if (!chosen || !this.session) return;
    this.viewer.select(null);
    if (chosen.annots.length > 1) this.session.removeMany(chosen.page, chosen.annots);
    else this.session.removeAnnot(chosen.page, chosen.annots[0]);
    this.onSelection();
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

  toggleUiTheme() {
    const root = document.documentElement;
    const isDark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = isDark ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('pdfy.uiTheme', next); } catch { /* Storage may be off. */ }
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
    await this.tools.settle();
    let dest: FileSystemFileHandle | 'download' | null = saveAs ? null : session.handle;
    if (dest && !saveAs) {
      const ok = (await dest.queryPermission?.({ mode: 'readwrite' })) === 'granted' || (await dest.requestPermission?.({ mode: 'readwrite' })) === 'granted';
      if (!ok) dest = null;
    }
    if (!dest) {
      dest = await this.destination(session.name);
      if (!dest) return false;
    }
    const prog = progressDialog('Saving', false);
    try {
      const options: BuildOptions = { ...session.pendingOptions };
      const { blob, warnings } = await buildFile(session, options, session.pages, p => prog.set(p, 'Building the file…'));
      prog.set(1, 'Writing to disk…');
      try {
        await this.writeTo(dest, blob, session.name);
      } catch (err) {
        prog.close();
        const next = await this.rescueSave(blob, session.name, err as Error);
        if (!next) return false;
        dest = next;
      }
      if (dest !== 'download') await this.afterSave(session, dest);
      else { session.dirty = false; session.emit({ kind: 'meta' }); }
      void dropJournal(session.id);
      toast(`Saved ${session.name} (${formatSize(blob.size)}).`, 'ok');
      if (warnings.length) void alertDialog('Saved, with notes', warnings.slice(0, 12).join('\n'));
      return true;
    } catch (err) {
      reportError('Saving', err);
      return false;
    } finally {
      prog.close();
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

  /** Re-opens from disk. Edits are now in the file, and memory for them is released. */
  private async afterSave(session: Session, handle: FileSystemFileHandle) {
    const file = await handle.getFile();
    rememberHandle(file, handle);
    const page = this.viewer.current;
    const scale = this.viewer.scale, fit = this.viewer.fit;
    const oldPassword = session.pendingOptions.removePassword ? undefined : session.pendingOptions.encrypt?.userPassword ?? [...session.sources.values()].find(s => s.password)?.password;
    this.viewer.attach(null);
    for (const s of session.sources.values()) await s.close();
    session.sources.clear();
    session.handle = handle;
    session.name = handle.name;
    session.pendingOptions = {};
    session.ocrWords.clear();
    session.bookmarks = [];
    session.attachments = [];
    session.pages = await session.addSource(file, handle.name, async retry => (retry ? askPassword(handle.name, true) : oldPassword ?? askPassword(handle.name, false)));
    session.clearHistory();
    session.dirty = false;
    this.viewer.fit = fit;
    this.viewer.scale = scale;
    this.viewer.attach(session);
    this.viewer.goTo(page);
    this.panels.attach(session);
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

  /** A page the same size as the picture, with the picture drawn in. */
  private async imagePage(s: Session, blob: Blob): Promise<PageRef> {
    const asset = await assetFromBlob(await readableImage(blob), this.preferredStyle());
    const size = fitSize(asset, 14400, 14400);
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
    s.dirty = true;
    this.add(s);
    toast(`Made ${pages.length} page${pages.length > 1 ? 's' : ''}. Press Save to keep them.`, 'ok');
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
    if (!canPrintToPdf()) { toast('Office files open in the PDFy desktop app.', 'info'); return; }
    const blob = await this.withProgress(`Converting ${file.name}`, async p => {
      p.set(0.3, 'Reading the file…');
      const job = await officeToPrint(file);
      p.set(0.6, 'Laying out the pages…');
      return printToPdf(job);
    });
    if (!blob) return;
    const s = await this.openPdfBlob(blob, `${baseName(file.name)}.pdf`);
    if (s) { s.dirty = true; s.emit({ kind: 'meta' }); }
  }

  async officeToPdf() {
    const files = await pickFiles(OFFICE_ACCEPT, true);
    for (const f of files) await this.openOffice(f);
  }

  async webToPdf() {
    if (!canPrintToPdf()) { toast('This works in the PDFy desktop app.', 'info'); return; }
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
    if (s) { s.dirty = true; s.emit({ kind: 'meta' }); }
  }

  private pendingAttachment: Annot['attachment'] | null = null;

  async attachFileCmd() {
    const [f] = await pickFiles('*/*');
    if (!f) return;
    this.pendingAttachment = { name: f.name, mime: f.type, blob: f };
    this.tools.setTool('attach');
    toast(`Click where "${f.name}" should be pinned.`, 'info');
  }

  /** Records from the microphone, then the voice note is pinned like any file. */
  async voiceNoteCmd() {
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (err) { toast(`The microphone could not be used. ${(err as Error).message}`, 'error'); return; }
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const ended = new Promise<void>(res => { rec.onstop = () => res(); });
    rec.start();
    const started = Date.now();
    const timer = h('p', { class: 'rec-time' }, 'Recording… 0 s');
    const tick = window.setInterval(() => { timer.textContent = `Recording… ${Math.round((Date.now() - started) / 1000)} s`; }, 500);
    const keep = await openDialog('Voice note', timer, [{ label: 'Cancel', value: false }, { label: 'Stop and keep', value: true, primary: true }], false);
    clearInterval(tick);
    rec.stop();
    await ended;
    stream.getTracks().forEach(t => t.stop());
    if (!keep) return;
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    this.pendingAttachment = { name: `Voice note ${new Date().toLocaleTimeString().replace(/[: ]/g, '-')}.webm`, mime: blob.type, blob, voice: true };
    this.tools.setTool('attach');
    toast('Click where the voice note should be pinned.', 'info');
  }

  private openAttachment(a: Annot) {
    const f = a.attachment;
    if (!f?.blob) { toast('Files saved in a PDF are listed in the Attachments panel.', 'info'); this.panels.show('attachments'); return; }
    if (f.voice) { void new Audio(URL.createObjectURL(f.blob)).play().catch(err => reportError('Playing the voice note', err)); return; }
    downloadBlob(f.blob, f.name);
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
          if (s) { s.dirty = true; s.emit({ kind: 'meta' }); toast('Opened as a PDF behind this window.', 'ok'); }
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
    ], 'Save', 'Adds the archive label and colour profile. Text you added in PDFy uses standard fonts that are not embedded, so strict validators may flag those. Check the result with Check file.');
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

  tellRedactionsMarked(n: number) { toast(`Marked ${n} result${n > 1 ? 's' : ''}. Press Apply redactions on the Edit tab to remove them.`, 'ok'); }

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
    toast('Click where the stamp should go.', 'info');
  }

  async chooseSignature() {
    const blob = await signatureDialog();
    if (!blob) return;
    this.signature = await assetFromBlob(blob);
    this.tools.setTool('signature');
    toast('Click where the signature should go.', 'info');
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
      toast('Drag where the signature box should appear.', 'info', 5000);
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
    if (this.speaking) { speechSynthesis.cancel(); this.speaking = false; toast('Stopped reading.', 'info'); return; }
    this.speaking = true;
    toast('Reading from this page. Press Read aloud again to stop.', 'info');
    for (let i = this.viewer.current; i < s.pages.length && this.speaking; i++) {
      const page = s.pages[i];
      const src = page.source ? s.sources.get(page.source) : null;
      if (!src) continue;
      const lines = await linesOf(src.pdf, page.index);
      const text = lines.map(l => l.text).join(' ').trim();
      if (!text) continue;
      this.viewer.goTo(i);
      await new Promise<void>(res => {
        const u = new SpeechSynthesisUtterance(text);
        u.onend = () => res();
        u.onerror = () => res();
        speechSynthesis.speak(u);
      });
    }
    this.speaking = false;
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

  private async drawStart() {
    if (this.session) return;
    let recent: RecentFile[] = [];
    try { recent = await listRecent(); } catch { /* Shown without the list. */ }
    if (this.session) return;
    clear(this.startEl);
    this.startEl.append(h('div', { class: 'start-card' },
      h('h1', null, 'PDFy'),
      h('p', { class: 'lead' }, 'Open a PDF, or paste a screenshot and turn it light or dark.'),
      h('div', { class: 'drop-zone' },
        h('p', null, 'Drop a PDF or image here, or press ', h('span', { class: 'keys' }, 'Ctrl'), ' ', h('span', { class: 'keys' }, 'V'), ' to paste an image.'),
        h('div', { class: 'start-actions' },
          h('button', { class: 'btn primary', onclick: safe(() => this.openDialog(), 'Opening') }, 'Open file'),
          h('button', { class: 'btn', onclick: safe(() => this.newDocument(), 'New document') }, 'New blank document'),
          h('button', { class: 'btn', onclick: safe(() => this.imagesToPdf(), 'Images to PDF') }, 'Images to PDF'))),
      recent.length ? h('div', { class: 'recent' }, h('h2', null, 'Recent files'),
        ...recent.slice(0, 8).map(r => h('button', { class: 'recent-row', onclick: safe(() => this.openRecent(r), 'Opening') },
          icon('file', 15), h('span', { class: 'name' }, r.name), h('small', { class: 'muted' }, `${r.pages} pages`)))) : null));
  }

  private async openRecent(r: RecentFile) {
    const ok = (await r.handle.queryPermission?.({ mode: 'read' })) === 'granted' || (await r.handle.requestPermission?.({ mode: 'read' })) === 'granted';
    if (!ok) return;
    try { await r.handle.getFile(); }
    catch {
      toast(`"${r.name}" is no longer there.`, 'error');
      await removeRecent(r.name);
      void this.drawStart();
      return;
    }
    await this.openHandle(r.handle);
  }

  private async checkRecovery() {
    const journals = await listJournals();
    if (!journals.length) return;
    const names = journals.map(j => `• ${j.name}`).join('\n');
    const ok = await openDialog('Recover your work?',
      h('p', { style: { whiteSpace: 'pre-wrap' } }, `PDFy did not close normally. These documents have unsaved changes:\n\n${names}`),
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
    session.dirty = true;
    this.add(session);
    if (missing.length) toast(`Could not find: ${missing.join(', ')}. Those pages are blank, and your edits on them were kept.`, 'error', 9000);
    else toast(`Recovered ${j.name}.`, 'ok');
    await saveJournal(session).catch(() => {});
  }
}

export const formatSize = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export { $, annotBounds, openPdf };
