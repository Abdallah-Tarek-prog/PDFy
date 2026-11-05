// The left side panels. Lists only build what is on screen, so a huge file stays smooth.

import { isCancelled, renderToCanvas, type PDFDocumentProxy } from '../core/engine';
import { segsToSvg, shapeOf } from '../core/geometry';
import { uid, viewportFor, type Annot, type PageRef } from '../core/model';
import type { Session } from '../core/session';
import { searchDocument, type Match } from '../features/search';
import { followDest, loadGhosts } from '../view/widgets';
import type { App } from '../app';
import { clear, downloadBlob, h, icon, pickFiles, safe } from './dom';

export type PanelId = 'thumbs' | 'outline' | 'comments' | 'bookmarks' | 'search' | 'layers' | 'attachments';

interface Panel { el: HTMLElement; show(): void; hide?(): void; attach?(s: Session | null): void; change?(kind: string): void }

const PANELS: { id: PanelId; icon: string; label: string }[] = [
  { id: 'thumbs', icon: 'thumbs', label: 'Pages' },
  { id: 'outline', icon: 'outline', label: 'Contents' },
  { id: 'comments', icon: 'comments', label: 'Comments' },
  { id: 'bookmarks', icon: 'bookmark', label: 'Bookmarks' },
  { id: 'search', icon: 'search', label: 'Search' },
  { id: 'layers', icon: 'layers', label: 'Layers' },
  { id: 'attachments', icon: 'attach', label: 'Attachments' },
];

export class Panels {
  readonly rail: HTMLElement;
  readonly host: HTMLElement;
  private panels: Record<PanelId, Panel>;
  active: PanelId | null = 'thumbs';
  private buttons = new Map<PanelId, HTMLButtonElement>();
  search: SearchPanel;
  thumbs: ThumbPanel;

  constructor(private app: App) {
    this.thumbs = new ThumbPanel(app);
    this.search = new SearchPanel(app);
    this.panels = {
      thumbs: this.thumbs, outline: new OutlinePanel(app), comments: new CommentsPanel(app),
      bookmarks: new BookmarksPanel(app), search: this.search, layers: new LayersPanel(app), attachments: new AttachmentsPanel(app),
    };
    this.rail = h('nav', { class: 'rail', 'aria-label': 'Side panels' }, ...PANELS.map(p => {
      const b = h('button', { class: 'rail-btn', title: p.label, 'aria-label': p.label, onclick: () => this.toggle(p.id) }, icon(p.icon, 20));
      this.buttons.set(p.id, b);
      return b;
    }));
    this.host = h('aside', { class: 'side' }, ...Object.values(this.panels).map(p => p.el));
    this.sync();
  }

  toggle(id: PanelId) { this.show(this.active === id ? null : id); }

  show(id: PanelId | null) {
    if (this.active && this.active !== id) this.panels[this.active].hide?.();
    this.active = id;
    this.sync();
    if (id) this.panels[id].show();
    this.app.viewer.relayout(this.app.viewer.fit !== 'none');
  }

  private sync() {
    for (const [id, p] of Object.entries(this.panels) as [PanelId, Panel][]) p.el.hidden = id !== this.active;
    for (const [id, b] of this.buttons) {
      b.classList.toggle('active', id === this.active);
      b.setAttribute('aria-pressed', String(id === this.active));
    }
    this.host.hidden = !this.active;
  }

  attach(s: Session | null) {
    for (const p of Object.values(this.panels)) p.attach?.(s);
    if (this.active) this.panels[this.active].show();
  }

  change(kind: string) { if (this.active) this.panels[this.active].change?.(kind); }
}

// ---- Thumbnails ----

/** Paints edits onto a thumbnail, so pasted images and markups show in the page list. */
async function drawAnnotsOnCanvas(c: HTMLCanvasElement, page: PageRef, k: number) {
  const ctx = c.getContext('2d');
  if (!ctx) return;
  const [a0, b0, c0, d0, e0, f0] = viewportFor(page, k).m;
  for (const a of page.annots) {
    if (a.ghost) continue;
    ctx.save();
    ctx.setTransform(a0, b0, c0, d0, e0, f0);
    ctx.globalAlpha = a.opacity;
    if (a.kind === 'image' && a.image) {
      try {
        const bmp = await createImageBitmap(a.image.blob, { resizeWidth: Math.max(8, Math.min(260, a.image.width)), resizeQuality: 'low' });
        const [x0, y0, x1, y1] = a.rect;
        const w = x1 - x0, ht = y1 - y0;
        ctx.translate(x0 + w / 2, y0 + ht / 2);
        ctx.rotate(((a.angle ?? 0) * Math.PI) / 180);
        ctx.scale(1, -1);
        ctx.drawImage(bmp, -w / 2, -ht / 2, w, ht);
        bmp.close();
      } catch { /* A thumbnail can live without it. */ }
    } else {
      const shape = shapeOf(a);
      if (shape.fill.length && (a.kind === 'highlight' || a.kind === 'arrow' || a.kind === 'note' || a.fill)) {
        ctx.fillStyle = a.kind === 'highlight' || a.kind === 'arrow' || a.kind === 'note' ? a.color : a.fill!;
        ctx.fill(new Path2D(segsToSvg(shape.fill)));
      }
      if (shape.stroke.length) {
        ctx.strokeStyle = a.color;
        ctx.lineWidth = Math.max(a.width, 1 / k);
        ctx.stroke(new Path2D(segsToSvg(shape.stroke)));
      }
      if ((a.kind === 'text' || a.kind === 'callout' || a.kind === 'stamp') && a.text) {
        const [x0, y0, x1, y1] = a.rect;
        const w = x1 - x0, ht = y1 - y0;
        ctx.translate(x0 + w / 2, y0 + ht / 2);
        ctx.rotate(((a.angle ?? 0) * Math.PI) / 180);
        ctx.scale(1, -1);
        const size = a.kind === 'stamp' ? ht * 0.55 : a.fontSize ?? 12;
        ctx.font = `${a.bold || a.kind === 'stamp' ? 'bold ' : ''}${size}px Arial, sans-serif`;
        ctx.fillStyle = a.textColor ?? a.color;
        ctx.textBaseline = 'middle';
        if (a.kind === 'stamp') {
          ctx.textAlign = 'center';
          ctx.fillText(a.text, 0, 0, w);
          ctx.strokeStyle = a.color;
          ctx.lineWidth = Math.max(1.5, a.width);
          ctx.strokeRect(-w / 2, -ht / 2, w, ht);
        } else {
          a.text.split('\n').slice(0, 12).forEach((line, i) => ctx.fillText(line, -w / 2 + 4, -ht / 2 + 4 + size * (i + 0.6) * 1.2, w - 8));
        }
      }
    }
    ctx.restore();
  }
}

const CELL_H = 196;
const THUMB_W = 132;
const THUMB_H = 164;
const THUMB_CACHE = 64; // About 20 MB at most, however long the document.

class ThumbPanel implements Panel {
  el: HTMLElement;
  private scroll: HTMLElement;
  private sizer: HTMLElement;
  private cache = new Map<string, HTMLCanvasElement>();
  private cells = new Map<string, HTMLElement>();
  private queue: { page: PageRef; key: string; holder: HTMLElement }[] = [];
  private busy = false;
  private frame = 0;
  selected = new Set<string>();
  onMenu?: (e: MouseEvent, page: PageRef) => void;
  private anchor = -1;
  private dropLine: HTMLElement;
  private dragging = false;

  constructor(private app: App) {
    this.scroll = h('div', { class: 'thumbs-scroll', tabindex: 0, 'aria-label': 'Page thumbnails' });
    this.sizer = h('div', { class: 'thumbs-sizer' });
    this.dropLine = h('div', { class: 'drop-line', hidden: true });
    this.sizer.append(this.dropLine);
    this.scroll.append(this.sizer);
    const tb = (i: string, t: string, f: () => void) => h('button', { class: 'icon-btn', title: t, 'aria-label': t, onclick: safe(f) }, icon(i, 16));
    this.el = h('section', { class: 'panel' },
      h('header', { class: 'panel-head' }, h('h3', null, 'Pages'),
        h('div', { class: 'panel-tools' },
          tb('rotL', 'Rotate selected left', () => app.rotatePages(-90)),
          tb('rotR', 'Rotate selected right', () => app.rotatePages(90)),
          tb('copy', 'Duplicate selected', () => app.duplicatePages()),
          tb('extract', 'Extract selected to a new file', () => app.extractPages()),
          tb('trash', 'Delete selected', () => app.deletePages()))),
      this.scroll);
    this.scroll.addEventListener('scroll', () => this.schedule(), { passive: true });
    this.scroll.addEventListener('dragover', e => this.dragOver(e));
    this.scroll.addEventListener('drop', e => this.drop(e));
    this.scroll.addEventListener('dragleave', () => { this.dropLine.hidden = true; });
    new ResizeObserver(() => { if (!this.el.hidden) this.schedule(); }).observe(this.scroll);
  }

  attach() { this.clear(); this.selected.clear(); this.anchor = -1; }

  private clear() {
    for (const c of this.cache.values()) { c.width = 0; }
    this.cache.clear();
    for (const c of this.cells.values()) c.remove();
    this.cells.clear();
    this.queue.length = 0;
  }

  show() { this.schedule(); }

  hide() {
    this.clear();
  }

  change(kind: string) {
    if (kind === 'structure') { for (const c of this.cells.values()) c.remove(); this.cells.clear(); }
    if (kind === 'structure' || kind === 'page' || kind === 'annots') this.schedule();
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
  }

  private draw() {
    const session = this.app.session;
    if (!session || this.el.hidden) return;
    const pages = session.pages;
    this.sizer.style.height = `${pages.length * CELL_H + 8}px`;
    const top = this.scroll.scrollTop, height = this.scroll.clientHeight;
    const first = Math.max(0, Math.floor(top / CELL_H) - 2);
    const last = Math.min(pages.length - 1, Math.ceil((top + height) / CELL_H) + 2);
    const keep = new Set<string>();
    this.queue.length = 0;
    for (let i = first; i <= last; i++) {
      const page = pages[i];
      keep.add(page.id);
      let cell = this.cells.get(page.id);
      if (!cell) { cell = this.makeCell(page); this.cells.set(page.id, cell); this.sizer.append(cell); }
      cell.style.top = `${i * CELL_H + 6}px`;
      (cell.querySelector('.thumb-num') as HTMLElement).textContent = String(i + 1);
      cell.classList.toggle('current', i === this.app.viewer.current);
      cell.classList.toggle('selected', this.selected.has(page.id));
      this.fill(page, cell.querySelector('.thumb-holder') as HTMLElement);
    }
    for (const [id, c] of this.cells) if (!keep.has(id)) { c.remove(); this.cells.delete(id); }
    void this.pump();
  }

  private key(p: PageRef) { return `${p.id}:${p.rotate}:${p.crop?.join() ?? ''}:${p.sized}:${p.rev ?? 0}`; }

  private fill(page: PageRef, holder: HTMLElement) {
    const key = this.key(page);
    if (holder.dataset.key === key) return;
    const hit = this.cache.get(key);
    if (hit) {
      holder.replaceChildren(hit);
      holder.dataset.key = key;
      this.cache.delete(key);
      this.cache.set(key, hit);
      return;
    }
    this.queue.push({ page, key, holder });
  }

  private async pump() {
    if (this.busy) return;
    const session = this.app.session;
    const job = this.queue.shift();
    if (!job || !session) return;
    this.busy = true;
    try {
      const pdfPage = await session.pdfPage(job.page);
      const vp1 = viewportFor(job.page, 1);
      const k = Math.min(THUMB_W / vp1.width, THUMB_H / vp1.height) * Math.min(window.devicePixelRatio || 1, 2);
      const c = h('canvas', { class: 'thumb' });
      const vp = viewportFor(job.page, k);
      c.width = Math.max(1, Math.round(vp.width));
      c.height = Math.max(1, Math.round(vp.height));
      await renderToCanvas(pdfPage, job.page, c, k, undefined, job.page.source ? session.sources.get(job.page.source)?.ocg : undefined).promise;
      await drawAnnotsOnCanvas(c, job.page, k);
      this.cache.set(job.key, c);
      if (this.cache.size > THUMB_CACHE) {
        const oldest = this.cache.keys().next().value!;
        const old = this.cache.get(oldest)!;
        if (!old.isConnected) old.width = 0;
        this.cache.delete(oldest);
      }
      if (job.holder.isConnected) { job.holder.replaceChildren(c); job.holder.dataset.key = job.key; }
    } catch (err) {
      if (!isCancelled(err)) job.holder.textContent = '!';
    } finally {
      this.busy = false;
      void this.pump();
    }
  }

  private indexOf(page: PageRef) { return this.app.session?.pages.indexOf(page) ?? -1; }

  private makeCell(page: PageRef): HTMLElement {
    const cell = h('div', { class: 'thumb-cell', draggable: true, role: 'button', tabindex: 0 },
      h('div', { class: 'thumb-holder' }), h('div', { class: 'thumb-num' }));
    cell.addEventListener('click', e => this.click(page, e));
    cell.addEventListener('contextmenu', e => this.onMenu?.(e, page));
    cell.addEventListener('dragstart', e => {
      if (!this.selected.has(page.id)) { this.selected.clear(); this.selected.add(page.id); this.schedule(); }
      this.dragging = true;
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('application/x-pdfy-pages', '1');
    });
    cell.addEventListener('dragend', () => { this.dragging = false; this.dropLine.hidden = true; });
    return cell;
  }

  private click(page: PageRef, e: MouseEvent) {
    const session = this.app.session!;
    const i = this.indexOf(page);
    if (e.shiftKey && this.anchor >= 0) {
      this.selected.clear();
      for (let j = Math.min(i, this.anchor); j <= Math.max(i, this.anchor); j++) this.selected.add(session.pages[j].id);
    } else if (e.ctrlKey || e.metaKey) {
      if (this.selected.has(page.id)) this.selected.delete(page.id); else this.selected.add(page.id);
      this.anchor = i;
    } else {
      this.selected.clear();
      this.selected.add(page.id);
      this.anchor = i;
      this.app.viewer.goTo(i);
    }
    this.schedule();
  }

  private dropIndex(e: DragEvent): number {
    const r = this.scroll.getBoundingClientRect();
    const y = e.clientY - r.top + this.scroll.scrollTop;
    const count = this.app.session?.pages.length ?? 0;
    return Math.max(0, Math.min(count, Math.round(y / CELL_H)));
  }

  private dragOver(e: DragEvent) {
    if (!this.dragging) return;
    e.preventDefault();
    const r = this.scroll.getBoundingClientRect();
    // Scroll when dragging near the top or bottom edge.
    if (e.clientY - r.top < 30) this.scroll.scrollTop -= 14;
    else if (r.bottom - e.clientY < 30) this.scroll.scrollTop += 14;
    this.dropLine.hidden = false;
    this.dropLine.style.top = `${this.dropIndex(e) * CELL_H + 2}px`;
  }

  private drop(e: DragEvent) {
    if (!this.dragging) return;
    e.preventDefault();
    this.dropLine.hidden = true;
    const session = this.app.session;
    if (!session) return;
    const at = this.dropIndex(e);
    const moving = session.pages.filter(p => this.selected.has(p.id));
    const before = session.pages.slice(0, at).filter(p => !this.selected.has(p.id));
    const after = session.pages.slice(at).filter(p => !this.selected.has(p.id));
    const next = [...before, ...moving, ...after];
    if (next.some((p, i) => p !== session.pages[i])) session.setPages(next, 'Move page');
  }

  selectedPages(): PageRef[] {
    const session = this.app.session;
    if (!session) return [];
    const list = session.pages.filter(p => this.selected.has(p.id));
    if (list.length) return list;
    const cur = session.pages[this.app.viewer.current];
    return cur ? [cur] : [];
  }
}

// ---- Outline ----

/* eslint-disable @typescript-eslint/no-explicit-any */

class OutlinePanel implements Panel {
  el: HTMLElement;
  private body = h('div', { class: 'panel-body' });
  private loadedFor: Session | null = null;

  constructor(private app: App) {
    this.el = h('section', { class: 'panel' }, h('header', { class: 'panel-head' }, h('h3', null, 'Contents')), this.body);
  }

  attach() { this.loadedFor = null; clear(this.body); }

  async show() {
    const session = this.app.session;
    if (!session || this.loadedFor === session) return;
    this.loadedFor = session;
    clear(this.body);
    const src = [...session.sources.values()][0];
    let items: any[] | null = null;
    try { items = src ? await src.pdf.getOutline() : null; } catch { /* Shown as empty. */ }
    if (!items?.length) { this.body.append(h('p', { class: 'empty' }, 'This document has no contents list.')); return; }
    this.body.append(this.list(items, src.pdf));
  }

  private list(items: any[], pdf: PDFDocumentProxy): HTMLElement {
    return h('ul', { class: 'tree' }, ...items.map(it => {
      const link = h('button', {
        class: 'tree-link', title: it.title,
        onclick: safe(() => {
          if (it.dest) return followDest(this.app.viewer, pdf, it.dest);
          if (it.url) window.open(it.url, '_blank', 'noopener');
        }),
      }, it.title || 'Untitled');
      if (!it.items?.length) return h('li', null, link);
      const kids = this.list(it.items, pdf);
      const toggle = h('button', { class: 'tree-toggle', 'aria-label': 'Expand', onclick: () => { kids.hidden = !kids.hidden; toggle.classList.toggle('closed', kids.hidden); } }, icon('chevDown', 14));
      return h('li', null, h('div', { class: 'tree-row' }, toggle, link), kids);
    }));
  }
}

// ---- Comments ----

const KIND_NAMES: Record<string, string> = {
  highlight: 'Highlight', underline: 'Underline', strikeout: 'Strikeout', squiggly: 'Squiggly', ink: 'Drawing', rect: 'Rectangle',
  ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow', polygon: 'Polygon', polyline: 'Polyline', cloud: 'Cloud', text: 'Text', callout: 'Callout',
  attachment: 'File', note: 'Note', stamp: 'Stamp', image: 'Image', measure: 'Measurement', redact: 'Redaction', whiteout: 'White-out', link: 'Link',
};

class CommentsPanel implements Panel {
  el: HTMLElement;
  private body = h('div', { class: 'panel-body' });
  private timer = 0;
  private token = 0;

  constructor(private app: App) {
    this.el = h('section', { class: 'panel' }, h('header', { class: 'panel-head' }, h('h3', null, 'Comments')), this.body);
  }

  show() { void this.loadAll(); }

  change(kind: string) {
    if (kind !== 'annots' && kind !== 'structure') return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.draw(), 120);
  }

  /** Reads annotations from pages not visited yet, a few at a time so nothing freezes. */
  private async loadAll() {
    const session = this.app.session;
    const run = ++this.token;
    this.draw();
    if (!session || session.pages.length > 2000) return;
    for (let i = 0; i < session.pages.length; i++) {
      if (run !== this.token || this.el.hidden || this.app.session !== session) return;
      const p = session.pages[i];
      if (p.ghostsLoaded || !p.source) continue;
      try {
        const pdfPage = await session.pdfPage(p);
        if (pdfPage) await loadGhosts(session, p, pdfPage);
      } catch { /* A damaged page is just skipped here. */ }
      if (i % 25 === 24) { this.draw(); await new Promise(r => setTimeout(r, 0)); }
    }
    this.draw();
  }

  private draw() {
    const session = this.app.session;
    clear(this.body);
    if (!session) return;
    const rows: HTMLElement[] = [];
    session.pages.forEach((page, i) => {
      for (const a of page.annots) {
        if (a.burn || (a.kind === 'whiteout')) continue;
        rows.push(this.row(page, i, a));
        if (rows.length > 2000) return;
      }
    });
    if (!rows.length) { this.body.append(h('p', { class: 'empty' }, 'No comments or markups yet.')); return; }
    this.body.append(...rows);
  }

  private row(page: PageRef, index: number, a: Annot): HTMLElement {
    const open = () => {
      this.app.viewer.goTo(index);
      this.app.tools.setTool('select');
      requestAnimationFrame(() => { this.app.viewer.select(page.id, a.id); this.app.onSelection(); });
    };
    return h('div', { class: 'comment', role: 'button', tabindex: 0, onclick: open },
      h('div', { class: 'comment-head' },
        h('span', { class: 'swatch', style: { background: a.color } }),
        h('strong', null, KIND_NAMES[a.kind] ?? a.kind),
        h('span', { class: 'muted' }, `Page ${index + 1}`),
        h('button', {
          class: 'icon-btn small', title: 'Delete', 'aria-label': 'Delete',
          onclick: (e: Event) => { e.stopPropagation(); this.app.session?.removeAnnot(page, a); },
        }, icon('trash', 14))),
      a.contents || a.text ? h('p', { dir: 'auto' }, (a.contents || a.text || '').slice(0, 280)) : null,
      a.author ? h('small', { class: 'muted' }, a.author) : null,
      ...(a.replies ?? []).map(r => h('div', { class: 'reply' }, h('p', { dir: 'auto' }, r.text), r.author ? h('small', { class: 'muted' }, r.author) : null)),
      this.threadControls(page, a));
  }

  /** Reply box and review status, which sit under each comment. */
  private threadControls(page: PageRef, a: Annot): HTMLElement {
    const status = h('select', { class: 'status-select', 'aria-label': 'Review status', onclick: (e: Event) => e.stopPropagation() },
      ...[['none', 'No status'], ['accepted', 'Accepted'], ['rejected', 'Rejected'], ['completed', 'Completed'], ['cancelled', 'Cancelled']].map(([v, t]) => h('option', { value: v, selected: (a.status ?? 'none') === v }, t)));
    status.addEventListener('change', () => {
      const current = page.annots.find(x => x.id === a.id) ?? a;
      const { ghost: _g, ...rest } = current;
      this.app.session?.replaceAnnot(page, current, { ...rest, status: status.value as Annot['status'] }, 'Set review status');
    });
    const reply = h('input', { class: 'reply-input', placeholder: 'Reply…', 'aria-label': 'Reply', onclick: (e: Event) => e.stopPropagation() });
    reply.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key !== 'Enter' || !reply.value.trim()) return;
      const current = page.annots.find(x => x.id === a.id) ?? a;
      const { ghost: _g, ...rest } = current;
      const entry = { id: uid(), author: this.app.authorName(), text: reply.value.trim(), when: Date.now() };
      this.app.session?.replaceAnnot(page, current, { ...rest, replies: [...(current.replies ?? []), entry] }, 'Reply');
    });
    return h('div', { class: 'thread-tools' }, reply, status);
  }
}

// ---- Bookmarks ----

class BookmarksPanel implements Panel {
  el: HTMLElement;
  private body = h('div', { class: 'panel-body' });

  constructor(private app: App) {
    this.el = h('section', { class: 'panel' },
      h('header', { class: 'panel-head' }, h('h3', null, 'Bookmarks'),
        h('div', { class: 'panel-tools' }, h('button', { class: 'icon-btn', title: 'Bookmark this page', 'aria-label': 'Bookmark this page', onclick: () => this.add() }, icon('plus', 16)))),
      this.body);
  }

  show() { this.draw(); }
  change(kind: string) { if (kind === 'structure') this.draw(); }

  private add() {
    const s = this.app.session;
    if (!s) return;
    const page = s.pages[this.app.viewer.current];
    if (!page) return;
    s.bookmarks.push({ id: uid(), pageId: page.id, title: `Page ${this.app.viewer.current + 1}` });
    s.markDirty();
    this.draw();
  }

  private draw() {
    const s = this.app.session;
    clear(this.body);
    if (!s?.bookmarks.length) { this.body.append(h('p', { class: 'empty' }, 'No bookmarks yet. Use + to bookmark the current page.')); return; }
    for (const b of s.bookmarks) {
      const index = s.pages.findIndex(p => p.id === b.pageId);
      if (index < 0) continue;
      const title = h('input', { class: 'bm-title', value: b.title, 'aria-label': 'Bookmark name' });
      title.addEventListener('change', () => { b.title = title.value; s.markDirty(); });
      this.body.append(h('div', { class: 'bm-row' },
        h('button', { class: 'icon-btn small', title: `Go to page ${index + 1}`, 'aria-label': `Go to page ${index + 1}`, onclick: () => this.app.viewer.goTo(index) }, icon('bookmark', 14)),
        title,
        h('button', {
          class: 'icon-btn small', title: 'Remove', 'aria-label': 'Remove',
          onclick: () => { s.bookmarks = s.bookmarks.filter(x => x !== b); s.markDirty(); this.draw(); },
        }, icon('close', 14))));
    }
  }
}

// ---- Search ----

class SearchPanel implements Panel {
  el: HTMLElement;
  input: HTMLInputElement;
  private body = h('div', { class: 'panel-body' });
  private status = h('div', { class: 'search-status', 'aria-live': 'polite' });
  private caseBox = h('input', { type: 'checkbox' });
  private wordBox = h('input', { type: 'checkbox' });
  matches: Match[] = [];
  private byPage = new Map<string, Match[]>();
  current = -1;
  private run = 0;
  private redactBtn: HTMLButtonElement;

  constructor(private app: App) {
    this.input = h('input', { class: 'search-input', type: 'search', placeholder: 'Search this document', 'aria-label': 'Search this document' });
    let timer = 0;
    this.input.addEventListener('input', () => { clearTimeout(timer); timer = window.setTimeout(() => this.start(), 260); });
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this.step(e.shiftKey ? -1 : 1); }
      e.stopPropagation();
    });
    this.caseBox.addEventListener('change', () => this.start());
    this.wordBox.addEventListener('change', () => this.start());
    this.redactBtn = h('button', { class: 'btn small', hidden: true, onclick: () => this.markRedactions() }, 'Mark all for redaction');
    this.el = h('section', { class: 'panel' },
      h('header', { class: 'panel-head' }, h('h3', null, 'Search')),
      h('div', { class: 'search-box' }, this.input,
        h('div', { class: 'search-opts' },
          h('label', null, this.caseBox, 'Match case'),
          h('label', null, this.wordBox, 'Whole word')),
        h('div', { class: 'search-nav' },
          this.status,
          h('button', { class: 'icon-btn small', title: 'Previous (Shift+Enter)', 'aria-label': 'Previous', onclick: () => this.step(-1) }, icon('chevLeft', 14)),
          h('button', { class: 'icon-btn small', title: 'Next (Enter)', 'aria-label': 'Next', onclick: () => this.step(1) }, icon('chevRight', 14))),
        this.redactBtn),
      this.body);
  }

  attach() { this.input.value = ''; this.reset(); }
  show() { this.input.focus(); this.input.select(); }

  private reset() {
    this.run++;
    this.matches = [];
    this.byPage.clear();
    this.current = -1;
    clear(this.body);
    this.status.textContent = '';
    this.redactBtn.hidden = true;
    this.app.redrawMatches();
  }

  start() {
    const q = this.input.value.trim();
    const session = this.app.session;
    this.reset();
    if (!q || !session) return;
    const run = this.run;
    void searchDocument(session, q, { caseSensitive: this.caseBox.checked, wholeWord: this.wordBox.checked }, (found, done, total) => {
      if (run !== this.run) return;
      for (const m of found) {
        this.matches.push(m);
        (this.byPage.get(m.pageId) ?? this.byPage.set(m.pageId, []).get(m.pageId)!).push(m);
        if (this.matches.length <= 800) this.body.append(this.row(m, this.matches.length - 1));
      }
      this.status.textContent = done < total ? `Searching… ${done}/${total}` : `${this.matches.length} found`;
      this.redactBtn.hidden = !this.matches.length;
      if (this.current < 0 && this.matches.length) this.step(1);
      if (found.length) this.app.redrawMatches();
    }, () => run !== this.run);
  }

  private row(m: Match, index: number): HTMLElement {
    const lower = m.context.toLowerCase(), at = lower.indexOf(m.text.toLowerCase());
    return h('button', { class: 'result', onclick: () => this.goto(index) },
      h('small', { class: 'muted' }, `Page ${m.pageIndex + 1}`),
      h('span', { dir: 'auto' }, at >= 0 ? [m.context.slice(0, at), h('mark', null, m.context.slice(at, at + m.text.length)), m.context.slice(at + m.text.length)] : m.context));
  }

  step(d: number) {
    if (!this.matches.length) return;
    this.goto((this.current + d + this.matches.length) % this.matches.length);
  }

  private goto(i: number) {
    this.current = i;
    const m = this.matches[i];
    const session = this.app.session;
    if (!session) return;
    const at = session.pages.findIndex(p => p.id === m.pageId);
    if (at < 0) return;
    this.app.viewer.goTo(at);
    this.status.textContent = `${i + 1} of ${this.matches.length}`;
    this.app.redrawMatches();
    requestAnimationFrame(() => {
      const hit = this.app.viewer.views.get(m.pageId)?.matches.querySelector('.match.current');
      hit?.scrollIntoView({ block: 'center', inline: 'nearest' });
    });
  }

  matchesFor(pageId: string) { return this.byPage.get(pageId) ?? []; }

  private markRedactions() {
    const session = this.app.session;
    if (!session) return;
    const byPage = new Map<string, Annot[]>();
    for (const m of this.matches) {
      for (const b of m.boxes) {
        const list = byPage.get(m.pageId) ?? [];
        list.push({ id: uid(), kind: 'redact', rect: [b.x, b.y, b.x + b.w, b.y + b.h], color: '#000000', opacity: 1, width: 0, contents: m.text, created: Date.now() });
        byPage.set(m.pageId, list);
      }
    }
    for (const [id, annots] of byPage) {
      const page = session.pageById(id);
      if (page) session.addAnnots(page, annots, 'Mark for redaction');
    }
    this.app.tellRedactionsMarked(this.matches.length);
  }
}

// ---- Attachments ----

class AttachmentsPanel implements Panel {
  el: HTMLElement;
  private body = h('div', { class: 'panel-body' });

  constructor(private app: App) {
    this.el = h('section', { class: 'panel' },
      h('header', { class: 'panel-head' }, h('h3', null, 'Attachments'),
        h('div', { class: 'panel-tools' }, h('button', { class: 'icon-btn', title: 'Attach a file', 'aria-label': 'Attach a file', onclick: safe(() => this.add(), 'Attaching') }, icon('plus', 16)))),
      this.body);
  }

  attach() { clear(this.body); }

  private async add() {
    const s = this.app.session;
    if (!s) return;
    const files = await pickFiles('*/*', true);
    for (const f of files) s.attachments.push({ name: f.name, blob: f });
    if (files.length) { s.markDirty(); void this.show(); }
  }

  async show() {
    const s = this.app.session;
    clear(this.body);
    if (!s) return;
    const row = (name: string, size: number, get: () => Blob, remove?: () => void) => h('div', { class: 'bm-row' },
      h('button', { class: 'icon-btn small', title: 'Save a copy', 'aria-label': `Save ${name}`, onclick: () => downloadBlob(get(), name) }, icon('xfdfOut', 14)),
      h('span', { class: 'attach-name', title: name }, name),
      h('small', { class: 'muted' }, size > 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.ceil(size / 1024)} KB`),
      remove ? h('button', { class: 'icon-btn small', title: 'Remove', 'aria-label': `Remove ${name}`, onclick: remove }, icon('close', 14)) : null);
    let any = false;
    for (const src of s.sources.values()) {
      let list: { id: string; filename: string }[] = [];
      try {
        const map = await src.pdf.getAttachments();
        list = [...(map?.entries() ?? [])].map(([id, a]) => ({ id, filename: (a as { filename: string }).filename }));
      } catch { /* Shown as empty. */ }
      for (const a of list) {
        any = true;
        // The file's bytes are only read when someone asks for them.
        this.body.append(h('div', { class: 'bm-row' },
          h('button', {
            class: 'icon-btn small', title: 'Save a copy', 'aria-label': `Save ${a.filename}`,
            onclick: safe(async () => {
              const got = await src.pdf.getAttachmentContent(a.id) as unknown as { content?: Uint8Array } | Uint8Array;
              const bytes = got instanceof Uint8Array ? got : got.content;
              if (bytes) downloadBlob(new Blob([bytes as BlobPart]), a.filename);
            }, 'Saving the attachment'),
          }, icon('xfdfOut', 14)),
          h('span', { class: 'attach-name', title: a.filename }, a.filename)));
      }
    }
    for (const a of s.attachments) {
      any = true;
      this.body.append(row(a.name, a.blob.size, () => a.blob, () => {
        s.attachments = s.attachments.filter(x => x !== a);
        void this.show();
      }));
    }
    if (!any) this.body.append(h('p', { class: 'empty' }, 'No attached files. Use + to attach one.'));
  }
}

// ---- Layers ----

class LayersPanel implements Panel {
  el: HTMLElement;
  private body = h('div', { class: 'panel-body' });

  constructor(private app: App) {
    this.el = h('section', { class: 'panel' }, h('header', { class: 'panel-head' }, h('h3', null, 'Layers')), this.body);
  }

  async show() {
    const session = this.app.session;
    clear(this.body);
    if (!session) return;
    let any = false;
    for (const src of session.sources.values()) {
      let config: any;
      try { config = await (src.ocg ?? src.pdf.getOptionalContentConfig()); } catch { continue; }
      const groups: [string, any][] = config?.getGroup ? [...config] : [];
      for (const [id, g] of groups) {
        any = true;
        const box = h('input', { type: 'checkbox', checked: g.visible });
        box.addEventListener('change', () => {
          config.setVisibility(id, box.checked);
          src.ocg = Promise.resolve(config);
          this.app.redrawAllPages();
        });
        this.body.append(h('label', { class: 'layer-row' }, box, g.name || 'Layer'));
      }
    }
    if (!any) this.body.append(h('p', { class: 'empty' }, 'This document has no layers.'));
  }
}
