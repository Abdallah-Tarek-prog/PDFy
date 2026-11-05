// One open document: its sources, pages, annotations and undo history.

import { openPdf, type AskPassword, type PDFDocumentProxy, type PDFPageProxy } from './engine';
import { uid, type Annot, type Bookmark, type BuildOptions, type PageRef } from './model';

export interface Source {
  id: string;
  name: string;
  blob: Blob;
  pdf: PDFDocumentProxy;
  password?: string;
  close(): Promise<void>;
  formsEdited: boolean;
  /** Which layers are showing. Set only once the user changes a layer. */
  ocg?: Promise<unknown>;
}

export interface Command { label: string; undo(): void; redo(): void }

export type ChangeKind = 'structure' | 'annots' | 'meta';
export interface Change { kind: ChangeKind; pageIds?: string[] }
type Listener = (c: Change) => void;

const MAX_HISTORY = 300;
export const DEFAULT_PAGE: [number, number, number, number] = [0, 0, 612, 792];

export class Session {
  readonly id = uid();
  name: string;
  handle: FileSystemFileHandle | null = null;
  sources = new Map<string, Source>();
  pages: PageRef[] = [];
  bookmarks: Bookmark[] = [];
  /** Files to attach on the next save. */
  attachments: { name: string; blob: Blob }[] = [];
  dirty = false;
  /** Choices that apply on the next save, such as edited properties. */
  pendingOptions: BuildOptions = {};
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private listeners = new Set<Listener>();
  /** Words found by OCR, per page id. */
  ocrWords = new Map<string, { x: number; y: number; w: number; h: number; text: string }[]>();

  constructor(name: string) { this.name = name; }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(c: Change) {
    if (c.kind === 'annots') {
      for (const id of c.pageIds ?? []) {
        const p = this.pageById(id);
        if (p) p.rev = (p.rev ?? 0) + 1;
      }
    }
    for (const fn of this.listeners) { try { fn(c); } catch (err) { console.error(err); } }
  }

  /** Adds a PDF file as a source and returns the new page entries. Does not place them. */
  async addSource(blob: Blob, name: string, ask?: AskPassword): Promise<PageRef[]> {
    const opened = await openPdf(blob, ask);
    const src: Source = {
      id: uid(), name, blob, pdf: opened.pdf, password: opened.password, close: opened.close, formsEdited: false,
    };
    this.sources.set(src.id, src);
    // Real page sizes load as pages come into view. The first page's size is the placeholder.
    const first = await src.pdf.getPage(1);
    const out: PageRef[] = [];
    for (let i = 0; i < src.pdf.numPages; i++) {
      out.push({
        id: uid(), source: src.id, index: i,
        view: [...first.view] as PageRef['view'],
        baseRotate: first.rotate, rotate: 0, crop: null, annots: [], removed: [], sized: i === 0,
      });
    }
    return out;
  }

  blankPage(w = 612, h = 792): PageRef {
    return {
      id: uid(), source: null, index: -1, view: [0, 0, w, h], baseRotate: 0, rotate: 0, crop: null,
      annots: [], removed: [], sized: true,
    };
  }

  async pdfPage(p: PageRef): Promise<PDFPageProxy | null> {
    if (!p.source) return null;
    const src = this.sources.get(p.source);
    if (!src) return null;
    const page = await src.pdf.getPage(p.index + 1);
    if (!p.sized) {
      p.view = [...page.view] as PageRef['view'];
      p.baseRotate = page.rotate;
      p.sized = true;
    }
    return page;
  }

  pageById(id: string): PageRef | undefined { return this.pages.find(p => p.id === id); }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack[this.undoStack.length - 1]?.label; }
  get redoLabel() { return this.redoStack[this.redoStack.length - 1]?.label; }

  /** Records an edit that has already been applied. */
  record(cmd: Command) {
    this.undoStack.push(cmd);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
    this.dirty = true;
    this.emit({ kind: 'meta' });
  }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    cmd.undo();
    this.redoStack.push(cmd);
    this.dirty = true;
    this.emit({ kind: 'meta' });
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    cmd.redo();
    this.undoStack.push(cmd);
    this.dirty = true;
    this.emit({ kind: 'meta' });
  }

  // ---- Annotation edits ----

  addAnnots(page: PageRef, annots: Annot[], label = 'Add annotation') {
    const apply = () => { page.annots.push(...annots); this.emit({ kind: 'annots', pageIds: [page.id] }); };
    const undo = () => {
      const ids = new Set(annots.map(a => a.id));
      page.annots = page.annots.filter(a => !ids.has(a.id));
      this.emit({ kind: 'annots', pageIds: [page.id] });
    };
    apply();
    this.record({ label, undo, redo: apply });
  }

  /** Swaps an annotation for a changed copy. An unedited existing annotation becomes ours here. */
  replaceAnnot(page: PageRef, before: Annot, after: Annot, label = 'Edit annotation') {
    const swap = (from: Annot, to: Annot) => {
      const i = page.annots.findIndex(a => a.id === from.id);
      if (i >= 0) page.annots[i] = to;
      this.syncGhost(page, to);
      this.emit({ kind: 'annots', pageIds: [page.id] });
    };
    swap(before, after);
    this.record({ label, undo: () => swap(after, before), redo: () => swap(before, after) });
  }

  /** Puts an annotation on top of the others or underneath them. */
  reorderAnnot(page: PageRef, annot: Annot, toFront: boolean) {
    const before = page.annots;
    const others = before.filter(a => a !== annot);
    const after = toFront ? [...others, annot] : [annot, ...others];
    const apply = (list: Annot[]) => { page.annots = list; this.emit({ kind: 'annots', pageIds: [page.id] }); };
    apply(after);
    this.record({ label: toFront ? 'Bring to front' : 'Send to back', undo: () => apply(before), redo: () => apply(after) });
  }

  /** Several objects changed together, as one undo step. */
  replaceMany(page: PageRef, pairs: { before: Annot; after: Annot }[], label: string) {
    const swap = (from: 'before' | 'after', to: 'before' | 'after') => {
      for (const p of pairs) {
        const i = page.annots.findIndex(a => a.id === p[from].id);
        if (i >= 0) page.annots[i] = p[to];
        this.syncGhost(page, p[to]);
      }
      this.emit({ kind: 'annots', pageIds: [page.id] });
    };
    swap('before', 'after');
    this.record({ label, undo: () => swap('after', 'before'), redo: () => swap('before', 'after') });
  }

  removeMany(page: PageRef, annots: Annot[]) {
    const before = page.annots;
    const removedBefore = page.removed;
    const set = new Set(annots);
    const imported = annots.filter(a => a.importedFrom);
    const apply = () => {
      page.annots = before.filter(a => !set.has(a));
      page.removed = [...removedBefore, ...imported.map(a => a.importedFrom!), ...imported.flatMap(a => a.importedReplies ?? [])];
      for (const a of imported) this.hideInEngine(page, a.importedFrom!, true);
      this.emit({ kind: 'annots', pageIds: [page.id] });
    };
    const undo = () => {
      page.annots = before;
      page.removed = removedBefore;
      for (const a of imported) if (a.ghost) this.hideInEngine(page, a.importedFrom!, false);
      this.emit({ kind: 'annots', pageIds: [page.id] });
    };
    apply();
    this.record({ label: annots.length > 1 ? 'Delete objects' : 'Delete annotation', undo, redo: apply });
  }

  removeAnnot(page: PageRef, annot: Annot) {
    const index = page.annots.findIndex(a => a.id === annot.id);
    if (index < 0) return;
    const wasGhost = annot.ghost;
    const apply = () => {
      page.annots = page.annots.filter(a => a.id !== annot.id);
      if (annot.importedFrom) {
        page.removed.push(annot.importedFrom, ...(annot.importedReplies ?? []));
        this.hideInEngine(page, annot.importedFrom, true);
      }
      this.emit({ kind: 'annots', pageIds: [page.id] });
    };
    const undo = () => {
      page.annots.splice(index, 0, annot);
      if (annot.importedFrom) {
        page.removed = page.removed.filter(r => r !== annot.importedFrom && !annot.importedReplies?.includes(r));
        if (wasGhost) this.hideInEngine(page, annot.importedFrom, false);
      }
      this.emit({ kind: 'annots', pageIds: [page.id] });
    };
    apply();
    this.record({ label: 'Delete annotation', undo, redo: apply });
  }

  /** Once an existing annotation is edited, we draw it, so the engine must stop drawing it. */
  private syncGhost(page: PageRef, a: Annot) {
    if (a.importedFrom) this.hideInEngine(page, a.importedFrom, !a.ghost);
  }

  private hideInEngine(page: PageRef, id: string, hidden: boolean) {
    const src = page.source ? this.sources.get(page.source) : null;
    if (!src) return;
    // Every page view of this source redraws the change.
    (src.pdf.annotationStorage as unknown as { setValue(k: string, v: unknown): void }).setValue(id, { noView: hidden });
    this.emit({ kind: 'annots', pageIds: [page.id, `render:${page.id}`] });
  }

  // ---- Page edits ----

  /** Page list changes share one undo shape, so deleting and reordering cost almost nothing. */
  setPages(next: PageRef[], label: string) {
    const before = this.pages;
    const apply = (list: PageRef[]) => { this.pages = list; this.emit({ kind: 'structure' }); };
    apply(next);
    this.record({ label, undo: () => apply(before), redo: () => apply(next) });
  }

  rotatePages(ids: string[], delta: number) {
    const targets = this.pages.filter(p => ids.includes(p.id));
    const apply = (d: number) => {
      for (const p of targets) p.rotate = (((p.rotate + d) % 360) + 360) % 360;
      this.emit({ kind: 'structure' });
    };
    apply(delta);
    this.record({ label: 'Rotate page', undo: () => apply(-delta), redo: () => apply(delta) });
  }

  setCrop(ids: string[], crop: (p: PageRef) => PageRef['crop']) {
    const targets = this.pages.filter(p => ids.includes(p.id));
    const before = targets.map(p => p.crop);
    const after = targets.map(crop);
    const apply = (list: PageRef['crop'][]) => {
      targets.forEach((p, i) => { p.crop = list[i]; });
      this.emit({ kind: 'structure' });
    };
    apply(after);
    this.record({ label: 'Crop page', undo: () => apply(before), redo: () => apply(after) });
  }

  clearHistory() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  markDirty() {
    this.dirty = true;
    this.emit({ kind: 'meta' });
  }

  async close() {
    for (const s of this.sources.values()) {
      try { await s.close(); } catch { /* Already gone. */ }
    }
    this.sources.clear();
    this.pages = [];
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.listeners.clear();
  }
}
