// The page viewer. Only the pages near the screen exist at all, so scrolling a 10,000-page file
// costs the same memory as scrolling a 10-page one.

import { isCancelled, renderToCanvas, type RenderHandle, type PDFPageProxy } from '../core/engine';
import { toScreen, viewportFor, type Annot, type PageRef, type Viewport } from '../core/model';
import type { Change, Session } from '../core/session';
import { h, s } from '../ui/dom';
import { annotNode, selectionNode } from './overlay';
import { buildWidgets, loadGhosts } from './widgets';
import { TextLayer } from 'pdfjs-dist';

const GAP = 14;
const MAX_CANVAS_PIXELS = 12_000_000; // About 48 MB for one page. Above this, a detail view takes over.
const MAX_DETAIL_PIXELS = 10_000_000;
const OVERSCAN_ROWS = 1;

export type LayoutMode = 'continuous' | 'facing' | 'single';
export type FitMode = 'width' | 'page' | 'none';

interface Row { y: number; h: number; w: number; pages: { index: number; x: number; w: number; h: number }[] }

export class PageView {
  el: HTMLElement;
  canvas: HTMLCanvasElement | null = null;
  detail: HTMLCanvasElement | null = null;
  detailBox: { x: number; y: number; w: number; h: number } | null = null;
  textHost: HTMLElement;
  svg: SVGSVGElement;
  annotsG: SVGElement;
  selG: SVGElement;
  previewG: SVGElement;
  widgets: HTMLElement;
  matches: HTMLElement;
  renderedAt = 0;
  needsRender = true;
  needsDetail = false;
  textLoaded = false;
  textLayer: TextLayer | null = null;
  widgetsLoaded = false;
  task: RenderHandle | null = null;
  failed = false;
  vp!: Viewport;

  constructor(readonly page: PageRef) {
    this.el = h('div', { class: 'page', dataset: { pageId: page.id } });
    this.textHost = h('div', { class: 'textLayer' });
    this.svg = s('svg', { class: 'overlay' }) as SVGSVGElement;
    this.annotsG = s('g');
    this.previewG = s('g', { class: 'preview' });
    this.selG = s('g');
    this.svg.append(this.annotsG, this.selG);
    this.widgets = h('div', { class: 'widgets' });
    this.matches = h('div', { class: 'matches' });
    this.el.append(this.textHost, this.matches, this.svg, this.widgets);
  }

  dispose() {
    this.task?.cancel();
    this.task = null;
    this.releaseCanvas();
    this.textLayer?.cancel();
    this.textLayer = null;
    this.el.remove();
  }

  /** Setting a canvas to zero size returns its memory straight away. */
  releaseCanvas() {
    for (const c of [this.canvas, this.detail]) {
      if (c) { c.width = 0; c.height = 0; c.remove(); }
    }
    this.canvas = null;
    this.detail = null;
    this.detailBox = null;
  }
}

export interface ViewerHooks {
  onScale?(scale: number): void;
  onPage?(index: number): void;
  onMounted?(v: PageView): void;
  drawMatches?(v: PageView): void;
}

export class Viewer {
  readonly scroller: HTMLElement;
  readonly sizer: HTMLElement;
  session: Session | null = null;
  scale = 1;
  fit: FitMode = 'width';
  layout: LayoutMode = 'continuous';
  rows: Row[] = [];
  rowOf: number[] = [];
  views = new Map<string, PageView>();
  current = 0;
  selection: { pageId: string; annotId: string } | null = null;
  hooks: ViewerHooks = {};
  private frame = 0;
  private rendering: PageView | null = null;
  private rerenderTimer = 0;
  private detailTimer = 0;
  private off: (() => void) | null = null;
  private ro: ResizeObserver;
  private sizeLoader = 0;

  constructor(host: HTMLElement) {
    this.scroller = host;
    this.sizer = h('div', { class: 'sizer' });
    host.append(this.sizer);
    host.addEventListener('scroll', () => this.schedule(), { passive: true });
    this.ro = new ResizeObserver(() => { if (this.session) this.relayout(true); });
    this.ro.observe(host);
    host.addEventListener('wheel', e => {
      if (!e.ctrlKey || !this.session) return;
      e.preventDefault();
      this.zoomAt(this.scale * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    }, { passive: false });
  }

  attach(session: Session | null) {
    this.off?.();
    this.off = null;
    this.clearViews();
    this.session = session;
    this.current = 0;
    this.selection = null;
    this.scroller.scrollTop = 0;
    if (session) {
      this.off = session.on(c => this.onChange(c));
      this.relayout(true);
      this.startSizeLoader();
    } else {
      this.rows = [];
      this.sizer.style.height = '0';
    }
  }

  private clearViews() {
    for (const v of this.views.values()) v.dispose();
    this.views.clear();
    this.rendering = null;
  }

  private onChange(c: Change) {
    if (c.kind === 'structure') {
      for (const v of this.views.values()) { v.dispose(); }
      this.views.clear();
      this.rendering = null;
      this.relayout(false);
      this.startSizeLoader();
    } else if (c.kind === 'annots') {
      for (const id of c.pageIds ?? []) {
        if (id.startsWith('render:')) {
          const v = this.views.get(id.slice(7));
          if (v) { v.needsRender = true; this.pump(); }
          continue;
        }
        const v = this.views.get(id);
        if (v) this.drawAnnots(v);
      }
    }
  }

  private fitScale(): number {
    const pages = this.session?.pages;
    if (!pages?.length) return 1;
    const p = pages[Math.min(this.current, pages.length - 1)];
    const vp = viewportFor(p, 1);
    const availW = this.scroller.clientWidth - GAP * 2 - 4;
    const availH = this.scroller.clientHeight - GAP * 2;
    const columnW = this.layout === 'facing' ? vp.width * 2 + GAP : vp.width;
    const byW = availW / (columnW || 1);
    return this.fit === 'width' ? byW : Math.min(byW, availH / (vp.height || 1));
  }

  /** Rebuilds the layout, keeping the same spot on screen. */
  relayout(fitChanged: boolean) {
    const session = this.session;
    if (!session) return;
    const anchor = this.anchor();
    if (fitChanged && this.fit !== 'none') {
      this.scale = Math.max(0.1, Math.min(8, this.fitScale()));
      this.hooks.onScale?.(this.scale);
    }
    const pages = session.pages;
    const rows: Row[] = [];
    this.rowOf = new Array(pages.length);
    let y = GAP, maxW = 0;
    const step = this.layout === 'facing' ? 2 : 1;
    for (let i = 0; i < pages.length; i += step) {
      const items: Row['pages'] = [];
      let rowW = 0, rowH = 0;
      for (let j = i; j < Math.min(i + step, pages.length); j++) {
        const vp = viewportFor(pages[j], this.scale);
        items.push({ index: j, x: rowW, w: vp.width, h: vp.height });
        rowW += vp.width + (j < i + step - 1 ? GAP : 0);
        rowH = Math.max(rowH, vp.height);
        this.rowOf[j] = rows.length;
      }
      rows.push({ y, h: rowH, w: rowW, pages: items });
      if (rowW > maxW) maxW = rowW;
      if (this.layout !== 'single') y += rowH + GAP;
      else y = GAP;
    }
    this.rows = rows;
    const singleH = this.layout === 'single' ? (rows[this.rowOf[this.current]]?.h ?? 0) + GAP * 2 : y;
    this.sizer.style.height = `${singleH}px`;
    this.sizer.style.width = `${maxW + GAP * 2}px`;
    for (const v of this.views.values()) { this.placeView(v); v.needsRender = v.renderedAt !== this.scale || v.needsRender; }
    this.restoreAnchor(anchor);
    this.schedule();
  }

  private anchor(): { index: number; dy: number } | null {
    if (!this.rows.length) return null;
    const top = this.scroller.scrollTop;
    const r = this.findRow(top);
    const row = this.rows[r];
    if (!row) return null;
    return { index: row.pages[0].index, dy: (top - row.y) / (row.h || 1) };
  }

  private restoreAnchor(a: { index: number; dy: number } | null) {
    if (!a || this.layout === 'single') return;
    const row = this.rows[this.rowOf[a.index]];
    if (row) this.scroller.scrollTop = row.y + a.dy * row.h;
  }

  private findRow(y: number): number {
    let lo = 0, hi = this.rows.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.rows[mid].y + this.rows[mid].h + GAP > y) { ans = mid; hi = mid - 1; } else lo = mid + 1;
    }
    return ans;
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.update(); });
  }

  private update() {
    const session = this.session;
    if (!session || !this.rows.length) return;
    let first: number, last: number;
    if (this.layout === 'single') {
      first = last = this.rowOf[this.current] ?? 0;
    } else {
      const top = this.scroller.scrollTop, bottom = top + this.scroller.clientHeight;
      first = this.findRow(top);
      last = first;
      while (last + 1 < this.rows.length && this.rows[last + 1].y < bottom) last++;
      // The page closest to the middle of the screen counts as current.
      const mid = (top + bottom) / 2;
      let best = first, bestD = Infinity;
      for (let r = first; r <= last; r++) {
        const d = Math.abs(this.rows[r].y + this.rows[r].h / 2 - mid);
        if (d < bestD) { bestD = d; best = r; }
      }
      const idx = this.rows[best].pages[0].index;
      if (idx !== this.current) { this.current = idx; this.hooks.onPage?.(idx); }
    }

    const keep = new Set<string>();
    const lo = Math.max(0, first - OVERSCAN_ROWS), hi = Math.min(this.rows.length - 1, last + OVERSCAN_ROWS);
    for (let r = lo; r <= hi; r++) {
      if (this.layout === 'single' && r !== first) continue;
      for (const item of this.rows[r].pages) {
        const page = session.pages[item.index];
        keep.add(page.id);
        if (!this.views.has(page.id)) this.mount(page);
      }
    }
    for (const [id, v] of this.views) {
      if (!keep.has(id)) {
        if (this.rendering === v) this.rendering = null;
        v.dispose();
        this.views.delete(id);
      }
    }
    this.pump();
    clearTimeout(this.detailTimer);
    this.detailTimer = window.setTimeout(() => this.refreshDetails(), 140);
  }

  private mount(page: PageRef) {
    const v = new PageView(page);
    this.views.set(page.id, v);
    this.placeView(v);
    this.sizer.append(v.el);
    this.drawAnnots(v);
    this.hooks.onMounted?.(v);
  }

  private placeView(v: PageView) {
    const session = this.session!;
    const index = session.pages.indexOf(v.page);
    if (index < 0) return;
    const row = this.rows[this.rowOf[index]];
    const item = row.pages.find(p => p.index === index)!;
    const centred = Math.max(GAP, (Math.max(this.scroller.clientWidth, row.w + GAP * 2) - row.w) / 2);
    v.vp = viewportFor(v.page, this.scale);
    const st = v.el.style;
    st.left = `${centred + item.x}px`;
    st.top = `${row.y + (row.h - item.h) / 2}px`;
    st.width = `${item.w}px`;
    st.height = `${item.h}px`;
    v.svg.setAttribute('width', String(item.w));
    v.svg.setAttribute('height', String(item.h));
    v.annotsG.setAttribute('transform', `matrix(${v.vp.m.join(' ')})`);
    v.textHost.style.setProperty('--total-scale-factor', String(this.scale));
    this.positionTextLayer(v);
    this.drawSelection(v);
    this.hooks.drawMatches?.(v);
    if (v.widgetsLoaded) buildWidgets(this, v);
  }

  /** Text and widgets are laid out against the full page, so a cropped page shifts them. */
  private positionTextLayer(v: PageView) {
    const p = v.page;
    const full = viewportFor({ ...p, crop: null }, this.scale);
    const [cx, cy] = toScreen(v.vp, 0, 0);
    const [fx, fy] = toScreen(full, 0, 0);
    const st = v.textHost.style;
    st.left = `${cx - fx}px`;
    st.top = `${cy - fy}px`;
    st.width = `${full.width}px`;
    st.height = `${full.height}px`;
  }

  drawAnnots(v: PageView) {
    v.annotsG.replaceChildren(...v.page.annots.map(annotNode));
    this.drawSelection(v);
  }

  replaceAnnotNode(v: PageView, a: Annot) {
    const old = v.annotsG.querySelector(`[data-id="${a.id}"]`);
    const node = annotNode(a);
    if (old) old.replaceWith(node); else v.annotsG.append(node);
    this.drawSelection(v, a);
  }

  drawSelection(v: PageView, live?: Annot) {
    v.selG.replaceChildren();
    const sel = this.selection;
    if (!sel || sel.pageId !== v.page.id) return;
    const a = live ?? v.page.annots.find(x => x.id === sel.annotId);
    if (a) v.selG.append(selectionNode(a, v.page, v.vp, this.extra.size === 0));
    for (const id of this.extra) {
      const other = v.page.annots.find(x => x.id === id);
      if (other) v.selG.append(selectionNode(other, v.page, v.vp, false));
    }
  }

  /** Other selected objects on the same page, alongside the main one. */
  extra = new Set<string>();

  /** Adds to or takes away from the selection, as Ctrl+click does. */
  toggleSelect(pageId: string, annotId: string) {
    if (!this.selection || this.selection.pageId !== pageId) { this.select(pageId, annotId); return; }
    if (this.selection.annotId === annotId) {
      const next = [...this.extra][0];
      this.extra.delete(next);
      this.selection = next ? { pageId, annotId: next } : null;
    } else if (this.extra.has(annotId)) this.extra.delete(annotId);
    else this.extra.add(annotId);
    const v = this.views.get(pageId);
    if (v) this.drawSelection(v);
  }

  selectedAnnots(): { page: PageRef; annots: Annot[] } | null {
    const main = this.selectedAnnot();
    if (!main) return null;
    const annots = [main.annot, ...[...this.extra].map(id => main.page.annots.find(a => a.id === id)).filter(Boolean) as Annot[]];
    return { page: main.page, annots };
  }

  select(pageId: string | null, annotId?: string) {
    const prev = this.selection;
    this.extra.clear();
    this.selection = pageId && annotId ? { pageId, annotId } : null;
    if (prev) { const v = this.views.get(prev.pageId); if (v) this.drawSelection(v); }
    if (pageId) { const v = this.views.get(pageId); if (v) this.drawSelection(v); }
  }

  selectedAnnot(): { page: PageRef; annot: Annot } | null {
    if (!this.selection || !this.session) return null;
    const page = this.session.pageById(this.selection.pageId);
    const annot = page?.annots.find(a => a.id === this.selection!.annotId);
    return page && annot ? { page, annot } : null;
  }

  /** Draws the page nearest the middle of the screen first. Only one render runs at a time. */
  private pump() {
    if (this.rendering || !this.session) return;
    const mid = this.scroller.scrollTop + this.scroller.clientHeight / 2;
    let best: PageView | null = null, bestD = Infinity;
    for (const v of this.views.values()) {
      if (!v.needsRender) continue;
      const top = parseFloat(v.el.style.top);
      const d = Math.abs(top + parseFloat(v.el.style.height) / 2 - mid);
      if (d < bestD) { bestD = d; best = v; }
    }
    if (best) void this.renderView(best);
  }

  private async renderView(v: PageView) {
    const session = this.session!;
    this.rendering = v;
    v.needsRender = false;
    const scale = this.scale;
    let canvas: HTMLCanvasElement | null = null;
    try {
      const pdfPage = await session.pdfPage(v.page);
      if (!this.views.has(v.page.id)) return;
      this.applyRealSize(v);

      const css = viewportFor(v.page, scale);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      let pixelScale = scale * dpr;
      const area = css.width * css.height * dpr * dpr;
      v.needsDetail = area > MAX_CANVAS_PIXELS;
      if (v.needsDetail) pixelScale *= Math.sqrt(MAX_CANVAS_PIXELS / area);

      const target = viewportFor(v.page, pixelScale);
      canvas = h('canvas', { class: 'base' });
      canvas.width = Math.max(1, Math.floor(target.width));
      canvas.height = Math.max(1, Math.floor(target.height));

      const ocg = v.page.source ? session.sources.get(v.page.source)?.ocg : undefined;
      const handle = renderToCanvas(pdfPage, v.page, canvas, pixelScale, undefined, ocg);
      v.task = handle;
      await handle.promise;
      v.task = null;
      if (!this.views.has(v.page.id) || this.session !== session) { canvas.width = 0; return; }

      // Swap only when the new picture is ready, so zooming never flashes blank.
      const old = v.canvas;
      v.el.insertBefore(canvas, v.el.firstChild);
      v.canvas = canvas;
      if (old) { old.width = 0; old.height = 0; old.remove(); }
      v.renderedAt = scale;
      v.failed = false;
      v.el.classList.remove('failed');
      if (scale !== this.scale) v.needsRender = true;

      if (pdfPage) {
        void this.loadText(v, pdfPage);
        if (!v.page.ghostsLoaded) await loadGhosts(session, v.page, pdfPage).then(() => { if (this.views.has(v.page.id)) this.drawAnnots(v); });
        if (!v.widgetsLoaded) await buildWidgets(this, v, pdfPage);
      }
    } catch (err) {
      if (canvas) { canvas.width = 0; }
      if (!isCancelled(err)) {
        console.error('Page render failed', v.page.index, err);
        v.failed = true;
        v.el.classList.add('failed');
      } else if (this.views.has(v.page.id)) {
        v.needsRender = true;
      }
    } finally {
      if (this.rendering === v) this.rendering = null;
      this.pump();
      if (v.needsDetail && this.views.has(v.page.id)) this.refreshDetail(v);
    }
  }

  /** A page may turn out to be a different size from the placeholder. Fix the layout if so. */
  private applyRealSize(v: PageView) {
    const vp = viewportFor(v.page, this.scale);
    if (Math.abs(vp.width - parseFloat(v.el.style.width)) > 0.5 || Math.abs(vp.height - parseFloat(v.el.style.height)) > 0.5) {
      this.relayout(false);
    }
  }

  private async loadText(v: PageView, pdfPage: PDFPageProxy) {
    if (v.textLoaded) return;
    v.textLoaded = true;
    try {
      const layer = new TextLayer({
        textContentSource: pdfPage.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
        container: v.textHost,
        viewport: pdfPage.getViewport({ scale: this.scale, rotation: (v.page.baseRotate + v.page.rotate) % 360 }),
      });
      v.textLayer = layer;
      await layer.render();
      v.textHost.append(h('div', { class: 'endOfContent' }));
    } catch (err) {
      if ((err as Error)?.name !== 'AbortException') console.warn('Text layer', err);
    }
  }

  private refreshDetails() {
    for (const v of this.views.values()) if (v.needsDetail) this.refreshDetail(v);
  }

  /** At very high zoom a whole-page canvas would be enormous, so only the visible part is sharp. */
  private async refreshDetail(v: PageView) {
    if (!this.session || v.renderedAt !== this.scale) return;
    const pageRect = v.el.getBoundingClientRect();
    const host = this.scroller.getBoundingClientRect();
    const x0 = Math.max(0, host.left - pageRect.left - 100), y0 = Math.max(0, host.top - pageRect.top - 100);
    const x1 = Math.min(pageRect.width, host.right - pageRect.left + 100), y1 = Math.min(pageRect.height, host.bottom - pageRect.top + 100);
    if (x1 <= x0 || y1 <= y0) return;
    const b = v.detailBox;
    const hostW = host.right - host.left, hostH = host.bottom - host.top;
    if (b && x0 >= b.x && y0 >= b.y && x1 <= b.x + b.w && y1 <= b.y + b.h && b.w >= Math.min(hostW, pageRect.width)) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let k = dpr;
    if ((x1 - x0) * (y1 - y0) * k * k > MAX_DETAIL_PIXELS) k = Math.sqrt(MAX_DETAIL_PIXELS / ((x1 - x0) * (y1 - y0)));

    const canvas = h('canvas', { class: 'detail' });
    canvas.width = Math.ceil((x1 - x0) * k);
    canvas.height = Math.ceil((y1 - y0) * k);
    canvas.style.left = `${x0}px`;
    canvas.style.top = `${y0}px`;
    canvas.style.width = `${x1 - x0}px`;
    canvas.style.height = `${y1 - y0}px`;
    try {
      const pdfPage = await this.session.pdfPage(v.page);
      const ocg = v.page.source ? this.session.sources.get(v.page.source)?.ocg : undefined;
      const handle = renderToCanvas(pdfPage, v.page, canvas, this.scale * k, { x: x0 * k, y: y0 * k }, ocg);
      await handle.promise;
      if (!this.views.has(v.page.id) || v.renderedAt !== this.scale) { canvas.width = 0; return; }
      const old = v.detail;
      v.canvas?.after(canvas);
      v.detail = canvas;
      v.detailBox = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      if (old) { old.width = 0; old.remove(); }
    } catch (err) {
      canvas.width = 0;
      if (!isCancelled(err)) console.warn('Detail render', err);
    }
  }

  // ---- Navigation and zoom ----

  setScale(scale: number, keepFit = false) {
    if (!keepFit) this.fit = 'none';
    this.scale = Math.max(0.1, Math.min(8, scale));
    this.hooks.onScale?.(this.scale);
    this.relayoutSoon();
  }

  setFit(mode: FitMode) {
    this.fit = mode;
    this.relayout(true);
  }

  /** Stretches what is on screen right away, then redraws sharp once zooming pauses. */
  private relayoutSoon() {
    this.relayoutNoRender();
    clearTimeout(this.rerenderTimer);
    this.rerenderTimer = window.setTimeout(() => {
      for (const v of this.views.values()) {
        if (v.renderedAt !== this.scale) {
          v.needsRender = true;
          if (v.detail) { v.detail.width = 0; v.detail.remove(); v.detail = null; v.detailBox = null; }
        }
      }
      this.pump();
    }, 130);
  }

  private relayoutNoRender() {
    const views = [...this.views.values()];
    const rendering = this.rendering;
    this.rendering = rendering;
    this.relayout(false);
    for (const v of views) v.needsRender = false;
  }

  zoomAt(next: number, clientX: number, clientY: number) {
    const host = this.scroller.getBoundingClientRect();
    const px = clientX - host.left + this.scroller.scrollLeft;
    const py = clientY - host.top + this.scroller.scrollTop;
    const k = Math.max(0.1, Math.min(8, next)) / this.scale;
    this.setScale(next);
    this.scroller.scrollLeft = px * k - (clientX - host.left);
    this.scroller.scrollTop = py * k - (clientY - host.top);
  }

  goTo(index: number, offsetTop = 0) {
    const pages = this.session?.pages;
    if (!pages?.length) return;
    const i = Math.max(0, Math.min(pages.length - 1, index));
    this.current = i;
    this.hooks.onPage?.(i);
    if (this.layout === 'single') {
      this.relayout(this.fit !== 'none');
      this.scroller.scrollTop = 0;
      this.schedule();
      return;
    }
    const row = this.rows[this.rowOf[i]];
    if (row) this.scroller.scrollTop = Math.max(0, row.y - GAP + offsetTop);
  }

  setLayout(mode: LayoutMode) {
    const at = this.current;
    this.layout = mode;
    for (const v of this.views.values()) v.dispose();
    this.views.clear();
    this.rendering = null;
    this.relayout(this.fit !== 'none');
    this.goTo(at);
  }

  /** Loads real page sizes in the background, a few at a time, so the scrollbar settles. */
  private startSizeLoader() {
    const session = this.session;
    if (!session) return;
    const run = ++this.sizeLoader;
    const pending = session.pages.filter(p => !p.sized);
    if (!pending.length || pending.length > 2000) return;
    let i = 0, changed = false;
    const step = async () => {
      if (run !== this.sizeLoader || this.session !== session) return;
      const end = Math.min(i + 12, pending.length);
      for (; i < end; i++) {
        const p = pending[i];
        const w = p.view[2] - p.view[0], ht = p.view[3] - p.view[1];
        try { await session.pdfPage(p); } catch { /* Shown as a failed page when it scrolls in. */ }
        if (w !== p.view[2] - p.view[0] || ht !== p.view[3] - p.view[1]) changed = true;
      }
      if (changed) { changed = false; this.relayout(false); }
      if (i < pending.length) setTimeout(step, 30);
    };
    setTimeout(step, 200);
  }

  /** Called when the document goes to the background. Returns its image memory. */
  releaseAll() {
    for (const v of this.views.values()) v.dispose();
    this.views.clear();
    this.rendering = null;
  }

  liveCanvasCount(): number {
    let n = 0, px = 0;
    for (const v of this.views.values()) {
      if (v.canvas) { n++; px += v.canvas.width * v.canvas.height; }
      if (v.detail) { n++; px += v.detail.width * v.detail.height; }
    }
    this.lastPixels = px;
    return n;
  }
  lastPixels = 0;
}
