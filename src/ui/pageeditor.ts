// The full-screen page editor, like Xodo's: every page as a large picture with a tick box, drag to
// reorder, and a floating + to insert a PDF, a picture or new pages. Only the pictures on screen
// are drawn, and at most a fixed number are kept, so a long document stays light.

import { isCancelled, renderToCanvas } from '../core/engine';
import { viewportFor, type PageRef } from '../core/model';
import { getSettings, saveSettings } from '../core/settings';
import type { App } from '../app';
import { showDropdown } from './chrome';
import { h, icon, safe } from './dom';
import { drawAnnotsOnCanvas } from './panels';

const CACHE = 90;
const GAP = 22;
const LABEL = 30;

export class PageEditor {
  readonly el: HTMLElement;
  isOpen = false;
  private scroll: HTMLElement;
  private sizer: HTMLElement;
  private countEl = h('span', { class: 'pe-count' });
  private cells = new Map<string, HTMLElement>();
  private cache = new Map<string, HTMLCanvasElement>();
  private queue: { page: PageRef; key: string; holder: HTMLElement }[] = [];
  private busy = false;
  private frame = 0;
  private anchor = -1;
  private cols = 1;
  private cellW = 200;
  private cellH = 260;
  private dropMark = h('div', { class: 'pe-drop', hidden: true });
  private dragging = false;
  private addBtn: HTMLButtonElement;
  private size: HTMLInputElement;
  private off: (() => void) | null = null;
  private ro: ResizeObserver;

  constructor(private app: App) {
    this.scroll = h('div', { class: 'pe-scroll', tabindex: 0, 'aria-label': 'Pages' });
    this.sizer = h('div', { class: 'pe-sizer' }, this.dropMark);
    this.scroll.append(this.sizer);
    const btn = (ic: string, label: string, run: () => unknown, title = label) =>
      h('button', { class: 'pe-btn', title, 'aria-label': label, onclick: safe(run, label) }, icon(ic, 17), h('span', null, label));
    this.size = h('input', { type: 'range', class: 'pe-size', min: 120, max: 360, step: 10, value: getSettings().editorThumb, 'aria-label': 'Picture size', title: 'Picture size' });
    this.size.addEventListener('input', () => { this.layout(); });
    this.size.addEventListener('change', () => saveSettings({ editorThumb: +this.size.value }));
    this.addBtn = h('button', { class: 'pe-fab', title: 'Insert', 'aria-label': 'Insert pages' }, icon('plus', 26));
    this.addBtn.addEventListener('click', () => showDropdown(this.addBtn, { sections: [{ name: 'Insert', items: [
      { icon: 'insertFile', label: 'Insert PDF', title: 'Pages from another PDF, after the last selected page', run: () => this.insertFiles('.pdf') },
      { icon: 'image', label: 'Insert Image', title: 'A picture as a new page', run: () => this.insertFiles('image/*,.heic,.heif') },
      { icon: 'newDoc', label: 'Insert Page', title: 'Blank, lined, grid or dotted pages', run: () => this.app.insertPagesDialog(this.insertAt() - 1) },
    ] }] }, { hasDoc: () => true, keyFor: () => '' }));
    this.el = h('section', { class: 'page-editor', hidden: true, 'aria-label': 'Page editor' },
      h('header', { class: 'pe-bar' },
        h('div', { class: 'pe-title' }, icon('grid', 18), h('strong', null, 'Pages'), this.countEl),
        h('div', { class: 'pe-actions' },
          btn('check2', 'Select all', () => this.selectAll(), 'Select every page (Ctrl+A)'),
          btn('rotL', 'Rotate left', () => this.app.rotatePages(-90)),
          btn('rotR', 'Rotate right', () => this.app.rotatePages(90)),
          btn('copy', 'Duplicate', () => this.app.duplicatePages()),
          btn('extract', 'Extract', () => this.app.extractPages(), 'Save the selected pages as a new file'),
          btn('trash', 'Delete', () => this.app.deletePages(), 'Delete the selected pages (Delete)')),
        h('div', { class: 'pe-end' }, icon('zoomOut', 14), this.size, icon('zoomIn', 14),
          h('button', { class: 'btn primary small pe-done', onclick: () => this.close() }, 'Done'))),
      this.scroll, this.addBtn);

    this.scroll.addEventListener('scroll', () => this.schedule(), { passive: true });
    this.scroll.addEventListener('dragover', e => this.dragOver(e));
    this.scroll.addEventListener('drop', e => this.drop(e));
    this.scroll.addEventListener('dragleave', e => { if (!this.scroll.contains(e.relatedTarget as Node)) this.dropMark.hidden = true; });
    this.el.addEventListener('keydown', e => this.onKey(e));
    this.ro = new ResizeObserver(() => { if (this.isOpen) this.layout(); });
    this.ro.observe(this.scroll);
  }

  toggle() { if (this.isOpen) this.close(); else this.open(); }

  open() {
    const s = this.app.session;
    if (!s) return;
    this.isOpen = true;
    this.el.hidden = false;
    document.documentElement.classList.add('page-editor-open');
    this.off?.();
    // Pages moved or removed: the Shift+click starting point no longer means the same page.
    this.off = s.on(c => { if (c.kind === 'structure' || c.kind === 'annots') { if (c.kind === 'structure') { this.dropCells(); this.anchor = -1; } this.layout(); } });
    this.layout();
    // Start with the page being read in view.
    const at = this.app.viewer.current;
    const row = Math.floor(at / this.cols);
    this.scroll.scrollTop = Math.max(0, row * (this.cellH + GAP) - 40);
    this.scroll.focus({ preventScroll: true });
    this.app.onPagesView();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.hidden = true;
    document.documentElement.classList.remove('page-editor-open');
    this.off?.();
    this.off = null;
    this.dropCells();
    for (const c of this.cache.values()) c.width = 0;
    this.cache.clear();
    this.queue.length = 0;
    this.app.onPagesView();
    this.app.viewer.scroller.focus({ preventScroll: true });
  }

  /** Another document became active, or saving replaced the pages. */
  attach() {
    this.anchor = -1; if (this.isOpen) { if (this.app.session) { this.close(); this.open(); } else this.close(); } }

  private dropCells() { for (const c of this.cells.values()) c.remove(); this.cells.clear(); }

  private get selected() { return this.app.panels.thumbs.selected; }

  private layout() {
    const s = this.app.session;
    if (!s || !this.isOpen) return;
    this.cellW = +this.size.value;
    this.cellH = Math.round(this.cellW * 1.3) + LABEL;
    const width = this.scroll.clientWidth - GAP * 2;
    this.cols = Math.max(1, Math.floor((width + GAP) / (this.cellW + GAP)));
    const rows = Math.ceil(s.pages.length / this.cols);
    this.sizer.style.height = `${rows * (this.cellH + GAP) + GAP + 90}px`;
    const n = this.selected.size;
    this.countEl.textContent = n ? `${s.pages.length} pages, ${n} selected` : `${s.pages.length} page${s.pages.length === 1 ? '' : 's'}`;
    for (const c of this.cells.values()) c.remove();
    this.cells.clear();
    this.draw();
  }

  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
  }

  private pos(i: number) {
    const used = this.cols * this.cellW + (this.cols - 1) * GAP;
    const left = Math.max(GAP, (this.scroll.clientWidth - used) / 2);
    return { x: left + (i % this.cols) * (this.cellW + GAP), y: GAP + Math.floor(i / this.cols) * (this.cellH + GAP) };
  }

  private draw() {
    const s = this.app.session;
    if (!s || !this.isOpen) return;
    const top = this.scroll.scrollTop, bottom = top + this.scroll.clientHeight;
    const rowH = this.cellH + GAP;
    const first = Math.max(0, (Math.floor(top / rowH) - 1) * this.cols);
    const last = Math.min(s.pages.length - 1, (Math.ceil(bottom / rowH) + 1) * this.cols - 1);
    const keep = new Set<string>();
    this.queue.length = 0;
    for (let i = first; i <= last; i++) {
      const page = s.pages[i];
      keep.add(page.id);
      let cell = this.cells.get(page.id);
      if (!cell) { cell = this.makeCell(page); this.cells.set(page.id, cell); this.sizer.append(cell); }
      const p = this.pos(i);
      cell.style.transform = `translate(${p.x}px, ${p.y}px)`;
      cell.style.width = `${this.cellW}px`;
      cell.style.height = `${this.cellH}px`;
      (cell.querySelector('.pe-num') as HTMLElement).textContent = String(i + 1);
      const sel = this.selected.has(page.id);
      cell.classList.toggle('selected', sel);
      cell.classList.toggle('current', i === this.app.viewer.current);
      (cell.querySelector('.pe-check') as HTMLInputElement).checked = sel;
      this.fill(page, cell.querySelector('.pe-holder') as HTMLElement);
    }
    for (const [id, c] of this.cells) if (!keep.has(id)) { c.remove(); this.cells.delete(id); }
    void this.pump();
  }

  private cacheKey(p: PageRef) { return `${p.id}:${p.rotate}:${p.crop?.join() ?? ''}:${p.sized}:${p.rev ?? 0}:${p.annots.length}:${this.cellW}`; }

  private fill(page: PageRef, holder: HTMLElement) {
    const key = this.cacheKey(page);
    if (holder.dataset.key === key) return;
    const hit = this.cache.get(key);
    if (hit) { holder.replaceChildren(hit); holder.dataset.key = key; this.cache.delete(key); this.cache.set(key, hit); return; }
    this.queue.push({ page, key, holder });
  }

  private async pump() {
    if (this.busy) return;
    const s = this.app.session;
    const job = this.queue.shift();
    if (!job || !s) return;
    this.busy = true;
    try {
      const pdfPage = await s.pdfPage(job.page);
      const vp1 = viewportFor(job.page, 1);
      const boxH = this.cellH - LABEL;
      const k = Math.min(this.cellW / vp1.width, boxH / vp1.height) * Math.min(window.devicePixelRatio || 1, 2);
      const c = h('canvas', { class: 'pe-canvas' });
      const vp = viewportFor(job.page, k);
      c.width = Math.max(1, Math.round(vp.width));
      c.height = Math.max(1, Math.round(vp.height));
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      if (pdfPage) await renderToCanvas(pdfPage, job.page, c, k, undefined, job.page.source ? s.sources.get(job.page.source)?.ocg : undefined).promise;
      await drawAnnotsOnCanvas(c, job.page, k);
      this.cache.set(job.key, c);
      while (this.cache.size > CACHE) {
        const oldest = this.cache.keys().next().value!;
        const old = this.cache.get(oldest)!;
        if (!old.isConnected) old.width = 0;
        this.cache.delete(oldest);
      }
      if (job.holder.isConnected) { job.holder.replaceChildren(c); job.holder.dataset.key = job.key; }
    } catch (err) {
      if (!isCancelled(err)) job.holder.textContent = 'This page could not be drawn';
    } finally {
      this.busy = false;
      if (this.isOpen) void this.pump();
    }
  }

  private indexOf(page: PageRef) { return this.app.session?.pages.indexOf(page) ?? -1; }

  private makeCell(page: PageRef): HTMLElement {
    const check = h('input', { type: 'checkbox', class: 'pe-check', 'aria-label': 'Select this page', tabindex: -1 });
    const cell = h('div', { class: 'pe-cell', draggable: true, role: 'button', tabindex: -1 },
      h('div', { class: 'pe-holder' }), check, h('div', { class: 'pe-num' }));
    check.addEventListener('click', e => {
      e.stopPropagation();
      if (check.checked) this.selected.add(page.id); else this.selected.delete(page.id);
      this.anchor = this.indexOf(page);
      this.refreshMarks();
    });
    cell.addEventListener('click', e => this.click(page, e));
    cell.addEventListener('dblclick', () => { const i = this.indexOf(page); this.close(); this.app.viewer.goTo(i); });
    cell.addEventListener('contextmenu', e => { if (!this.selected.has(page.id)) { this.selected.clear(); this.selected.add(page.id); this.refreshMarks(); } this.app.panels.thumbs.onMenu?.(e, page); });
    cell.addEventListener('dragstart', e => {
      if (!this.selected.has(page.id)) { this.selected.clear(); this.selected.add(page.id); this.refreshMarks(); }
      this.dragging = true;
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('application/x-pdfy-pages', '1');
    });
    cell.addEventListener('dragend', () => { this.dragging = false; this.dropMark.hidden = true; });
    return cell;
  }

  private refreshMarks() {
    const s = this.app.session;
    if (!s) return;
    const n = this.selected.size;
    this.countEl.textContent = n ? `${s.pages.length} pages, ${n} selected` : `${s.pages.length} page${s.pages.length === 1 ? '' : 's'}`;
    this.draw();
    this.app.panels.thumbs.schedule();
  }

  private click(page: PageRef, e: MouseEvent) {
    const s = this.app.session!;
    const i = this.indexOf(page);
    if (this.anchor >= s.pages.length) this.anchor = -1;
    if (e.shiftKey && this.anchor >= 0 && i >= 0) {
      for (let j = Math.min(i, this.anchor); j <= Math.max(i, this.anchor); j++) this.selected.add(s.pages[j].id);
    } else if (e.ctrlKey || e.metaKey) {
      if (this.selected.has(page.id)) this.selected.delete(page.id); else this.selected.add(page.id);
      this.anchor = i;
    } else {
      const only = this.selected.size === 1 && this.selected.has(page.id);
      this.selected.clear();
      if (!only) this.selected.add(page.id);
      this.anchor = i;
      this.app.viewer.goTo(i);
    }
    this.refreshMarks();
  }

  private selectAll() {
    const s = this.app.session;
    if (!s) return;
    const all = this.selected.size === s.pages.length;
    this.selected.clear();
    if (!all) for (const p of s.pages) this.selected.add(p.id);
    this.refreshMarks();
  }

  /** New pages go after the last selected page, or after the page being read. */
  private insertAt(): number {
    const s = this.app.session;
    if (!s) return 0;
    let last = -1;
    s.pages.forEach((p, i) => { if (this.selected.has(p.id)) last = i; });
    return (last >= 0 ? last : this.app.viewer.current) + 1;
  }

  private async insertFiles(accept: string) {
    const s = this.app.session;
    if (!s) return;
    await this.app.insertFilesAt(accept, this.insertAt());
  }

  /** Where a drop would land: between which pages, and on which row the mark is drawn. */
  private dropSpot(e: DragEvent): { at: number; row: number; col: number } {
    const s = this.app.session;
    const count = s?.pages.length ?? 0;
    const r = this.scroll.getBoundingClientRect();
    const x = e.clientX - r.left + this.scroll.scrollLeft - this.pos(0).x, y = e.clientY - r.top + this.scroll.scrollTop;
    const rows = Math.max(1, Math.ceil(count / this.cols));
    const row = Math.max(0, Math.min(rows - 1, Math.floor((y - GAP / 2) / (this.cellH + GAP))));
    let col = Math.max(0, Math.min(this.cols, Math.floor((x + this.cellW / 2 + GAP) / (this.cellW + GAP))));
    let at = row * this.cols + col;
    if (at > count) { at = count; col = count - row * this.cols; }
    return { at, row, col };
  }

  private dragOver(e: DragEvent) {
    if (!this.dragging) return;
    e.preventDefault();
    const r = this.scroll.getBoundingClientRect();
    if (e.clientY - r.top < 40) this.scroll.scrollTop -= 16;
    else if (r.bottom - e.clientY < 40) this.scroll.scrollTop += 16;
    const spot = this.dropSpot(e);
    const p = this.pos(spot.row * this.cols);
    const x = p.x + spot.col * (this.cellW + GAP) - GAP / 2;
    this.dropMark.hidden = false;
    this.dropMark.style.transform = `translate(${x - 2}px, ${p.y}px)`;
    this.dropMark.style.height = `${this.cellH - LABEL}px`;
  }

  private drop(e: DragEvent) {
    if (!this.dragging) return;
    e.preventDefault();
    this.dropMark.hidden = true;
    const s = this.app.session;
    if (!s) return;
    const at = this.dropSpot(e).at;
    const moving = s.pages.filter(p => this.selected.has(p.id));
    const before = s.pages.slice(0, at).filter(p => !this.selected.has(p.id));
    const after = s.pages.slice(at).filter(p => !this.selected.has(p.id));
    const next = [...before, ...moving, ...after];
    if (next.some((p, i) => p !== s.pages[i])) s.setPages(next, moving.length > 1 ? 'Move pages' : 'Move page');
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); return; }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyA') { e.preventDefault(); e.stopPropagation(); this.selectAll(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); void this.app.deletePages(); }
  }

}
