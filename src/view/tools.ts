// What happens when the user clicks and drags on a page, for every tool.

import { annotBounds, measureLabel, noteRect, quadsBounds, remapAnnot, segsToSvg, simplify, smoothPath } from '../core/geometry';
import { FONT_CSS, placeBox, pointsBounds, toPdf, toScreen, uid, viewportFor, type Annot, type FontFamily, type Kind, type PageRef } from '../core/model';
import { fitMarkdown } from '../study/box';
import { fontCss } from '../study/fonts';
import { h, reportError, s, safe } from '../ui/dom';
import type { PageView, Viewer } from './viewer';

export type Tool =
  | 'hand' | 'select' | 'highlight' | 'underline' | 'strikeout' | 'squiggly'
  | 'pen' | 'marker' | 'eraser' | 'text' | 'callout' | 'note' | 'stamp' | 'signature'
  | 'rect' | 'ellipse' | 'line' | 'arrow' | 'polygon' | 'polyline' | 'cloud'
  | 'distance' | 'perimeter' | 'area' | 'link' | 'whiteout' | 'redact' | 'edit-text' | 'snip' | 'crop' | 'crop-image' | 'cert-box' | 'attach'
  | 'markdown' | 'read-picture'
  | 'field-text' | 'field-check' | 'field-radio' | 'field-dropdown' | 'field-list' | 'field-signature';

export interface ToolStyle { color: string; width: number; opacity: number; fill: string | null; fontSize: number; font?: FontFamily; fontName?: string; bold?: boolean; italic?: boolean }

const MARKUP = new Set<Tool>(['highlight', 'underline', 'strikeout', 'squiggly']);
const DRAG_BOX = new Set<Tool>(['rect', 'ellipse', 'whiteout', 'redact', 'link', 'snip', 'read-picture', 'crop', 'crop-image', 'cert-box', 'field-text', 'field-check', 'field-radio', 'field-dropdown', 'field-list', 'field-signature']);
const DRAG_LINE = new Set<Tool>(['line', 'arrow', 'distance']);
const MULTI_CLICK = new Set<Tool>(['polygon', 'polyline', 'cloud', 'perimeter', 'area']);
/** These stay active after use, because people usually do several in a row. */
const STICKY = new Set<Tool>(['pen', 'marker', 'eraser', 'highlight', 'underline', 'strikeout', 'squiggly', 'redact', 'whiteout', 'edit-text']);

export const DEFAULT_STYLES: Partial<Record<Tool, Partial<ToolStyle>>> = {
  highlight: { color: '#ffd400', opacity: 0.55, width: 1 },
  underline: { color: '#0b8a4f', width: 1.25 },
  strikeout: { color: '#d92d20', width: 1.25 },
  squiggly: { color: '#d92d20', width: 1 },
  pen: { color: '#1a56db', width: 1.75 },
  marker: { color: '#ffd400', width: 11, opacity: 0.45 },
  text: { color: '#111111', fontSize: 13, width: 0 },
  callout: { color: '#1f2937', fontSize: 12, width: 1, fill: '#ffffff' },
  note: { color: '#ffe066', width: 0.75 },
  rect: { color: '#d92d20', width: 1.5 },
  ellipse: { color: '#d92d20', width: 1.5 },
  line: { color: '#d92d20', width: 1.5 },
  arrow: { color: '#d92d20', width: 1.5 },
  polygon: { color: '#d92d20', width: 1.5 },
  polyline: { color: '#d92d20', width: 1.5 },
  cloud: { color: '#d92d20', width: 1.25 },
  distance: { color: '#1a56db', width: 1 },
  perimeter: { color: '#1a56db', width: 1 },
  area: { color: '#1a56db', width: 1, fill: '#1a56db', opacity: 0.25 },
  stamp: { color: '#d92d20', width: 2 },
};

const BASE: ToolStyle = { color: '#d92d20', width: 1.5, opacity: 1, fill: null, fontSize: 12 };

export interface ToolHooks {
  onTool?(t: Tool): void;
  onSelection?(): void;
  snip?(page: PageRef, rect: Annot['rect']): void;
  readPicture?(page: PageRef, rect: Annot['rect']): void;
  mdTheme?(): string;
  editEquation?(v: PageView, a: Annot): void;
  crop?(page: PageRef, rect: Annot['rect']): void;
  certBox?(page: PageRef, rect: Annot['rect']): void;
  cropImage?(v: PageView, box: { x0: number; y0: number; x1: number; y1: number }, pageRect: DOMRect): void;
  stampLabel?(): string;
  signatureAsset?(): Annot['image'] | null;
  attachmentAsset?(): Annot['attachment'] | null;
  openAttachment?(a: Annot): void;
  askLink?(): Promise<string | null>;
  askFieldName?(type: string): Promise<{ name: string; options?: string[] } | null>;
  measure?(): { unit: string; scale: number };
  author?(): string;
}

function loadStyles(): Record<string, ToolStyle> {
  try { return JSON.parse(localStorage.getItem('pdfy.styles') ?? '{}'); } catch { return {}; }
}

export class Tools {
  tool: Tool = 'select';
  hooks: ToolHooks = {};
  private custom = loadStyles();
  private gesture: { move(e: PointerEvent): void; up(e: PointerEvent): void; cancel(): void } | null = null;
  private clickPts: { v: PageView; pts: number[]; node: SVGElement } | null = null;
  private editing: { commit(): void } | null = null;
  /** Edits still being finished, such as a note waiting for its equations. Saving waits for them. */
  private pending = new Set<Promise<unknown>>();

  constructor(private viewer: Viewer) {
    const root = viewer.sizer;
    root.addEventListener('pointerdown', e => safe((ev: PointerEvent) => this.down(ev), 'Drawing')(e));
    root.addEventListener('dblclick', e => safe((ev: MouseEvent) => this.dbl(ev), 'Editing')(e));
    window.addEventListener('pointermove', e => { try { this.gesture?.move(e); } catch (err) { console.error(err); } });
    window.addEventListener('pointerup', e => {
      const g = this.gesture;
      this.gesture = null;
      if (g) safe(() => g.up(e), 'Drawing')();
      else if (MARKUP.has(this.tool)) safe(() => this.finishMarkup(), 'Marking text')();
    });
    window.addEventListener('pointercancel', () => { this.gesture?.cancel(); this.gesture = null; });
    this.applyMode();
  }

  style(t: Tool = this.tool): ToolStyle {
    return { ...BASE, ...DEFAULT_STYLES[t], ...this.custom[t] };
  }

  setStyle(patch: Partial<ToolStyle>, t: Tool = this.tool) {
    this.custom[t] = { ...this.custom[t], ...patch } as ToolStyle;
    try { localStorage.setItem('pdfy.styles', JSON.stringify(this.custom)); } catch { /* Storage may be off. */ }
  }

  setTool(t: Tool) {
    this.cancel();
    this.commitEdit();
    this.tool = t;
    if (t !== 'select') { this.viewer.select(null); this.hooks.onSelection?.(); }
    window.getSelection()?.removeAllRanges();
    this.applyMode();
    this.hooks.onTool?.(t);
  }

  private applyMode() {
    const t = this.tool;
    const mode = t === 'hand' ? 'hand'
      : t === 'select' ? 'select'
      : MARKUP.has(t) ? 'markup'
      : t === 'edit-text' ? 'edit'
      : 'draw';
    this.viewer.scroller.dataset.mode = mode;
  }

  cancel() {
    this.gesture?.cancel();
    this.gesture = null;
    if (this.clickPts) { this.clickPts.node.remove(); this.clickPts = null; }
  }

  commitEdit() { this.editing?.commit(); }

  /** Finishes the open editor and waits for anything still being formatted. */
  async settle() {
    this.commitEdit();
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private track(job: Promise<unknown>) {
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
  }

  /** Enter finishes a polygon. Returns true if there was one. */
  finishClickShape(): boolean {
    if (!this.clickPts) return false;
    this.endClickShape();
    return true;
  }

  private viewAt(e: Event): PageView | null {
    const el = (e.target as Element).closest?.('.page') as HTMLElement | null;
    return el ? this.viewer.views.get(el.dataset.pageId!) ?? null : null;
  }

  private local(v: PageView, e: { clientX: number; clientY: number }): [number, number] {
    const r = v.el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private pdfAt(v: PageView, e: { clientX: number; clientY: number }): [number, number] {
    const [x, y] = this.local(v, e);
    return toPdf(v.vp, x, y);
  }

  private base(kind: Kind, t: Tool): Annot {
    const st = this.style(t);
    return {
      id: uid(), kind, rect: [0, 0, 0, 0], color: st.color, opacity: st.opacity, width: st.width, fill: st.fill,
      fontSize: st.fontSize, font: st.font, fontName: st.fontName, bold: st.bold, italic: st.italic,
      author: this.hooks.author?.() ?? 'PDFy', created: Date.now(),
    };
  }

  private add(v: PageView, a: Annot, label?: string) {
    this.viewer.session!.addAnnots(v.page, [a], label);
  }

  private afterCreate(v: PageView, a: Annot) {
    if (!STICKY.has(this.tool)) {
      this.tool = 'select';
      this.applyMode();
      this.hooks.onTool?.('select');
      this.viewer.select(v.page.id, a.id);
      this.hooks.onSelection?.();
    }
  }

  // ---- Pointer down ----

  private down(e: PointerEvent) {
    const session = this.viewer.session;
    if (!session || e.button !== 0) return;
    const target = e.target as Element;
    if (target.closest('.image-bar, .inline-editor')) return;
    this.commitEdit();

    if (this.tool === 'hand') { this.startPan(e); return; }

    const v = this.viewAt(e);
    if (!v) {
      if (this.tool === 'select') { this.viewer.select(null); this.hooks.onSelection?.(); }
      return;
    }

    switch (true) {
      case this.tool === 'select': this.downSelect(e, v); return;
      case MARKUP.has(this.tool): this.downMarkup(e, v); return;
      case this.tool === 'pen' || this.tool === 'marker': this.startInk(e, v); return;
      case this.tool === 'eraser': this.startEraser(e, v); return;
      case DRAG_BOX.has(this.tool): this.startBox(e, v); return;
      case DRAG_LINE.has(this.tool): this.startLine(e, v); return;
      case MULTI_CLICK.has(this.tool): this.clickShape(e, v); return;
      case this.tool === 'text': this.placeText(e, v); return;
      case this.tool === 'markdown': this.placeMarkdown(e, v); return;
      case this.tool === 'callout': this.placeCallout(e, v); return;
      case this.tool === 'note': this.placeNote(e, v); return;
      case this.tool === 'stamp': this.placeStamp(e, v); return;
      case this.tool === 'signature': this.placeSignature(e, v); return;
      case this.tool === 'edit-text': this.startEditText(e, v); return;
      case this.tool === 'attach': this.placeAttachment(e, v); return;
    }
  }

  private startPan(e: PointerEvent) {
    const sc = this.viewer.scroller;
    const sx = e.clientX, sy = e.clientY, l = sc.scrollLeft, t = sc.scrollTop;
    sc.classList.add('panning');
    e.preventDefault();
    this.gesture = {
      move: m => { sc.scrollLeft = l - (m.clientX - sx); sc.scrollTop = t - (m.clientY - sy); },
      up: () => sc.classList.remove('panning'),
      cancel: () => sc.classList.remove('panning'),
    };
  }

  // ---- Select, move, resize ----

  private downSelect(e: PointerEvent, v: PageView) {
    const target = e.target as Element;
    const handle = target.closest('.sel-handle') as SVGElement | null;
    if (handle) { e.preventDefault(); this.startResize(e, v, handle); return; }
    const node = target.closest('[data-id]') as SVGElement | null;
    if (!node) {
      if (e.shiftKey) { this.startMarquee(e, v); return; }
      if (this.viewer.selection) { this.viewer.select(null); this.hooks.onSelection?.(); }
      return;
    }
    const a = v.page.annots.find(x => x.id === node.getAttribute('data-id'));
    if (!a) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      this.viewer.toggleSelect(v.page.id, a.id);
      this.hooks.onSelection?.();
      return;
    }
    const chosen = this.viewer.selectedAnnots();
    if (chosen && chosen.page === v.page && chosen.annots.includes(a) && chosen.annots.length > 1) {
      this.startGroupMove(e, v, chosen.annots);
      return;
    }
    this.viewer.select(v.page.id, a.id);
    this.hooks.onSelection?.();
    this.startMove(e, v, a);
  }

  private startGroupMove(e: PointerEvent, v: PageView, annots: Annot[]) {
    const start = this.pdfAt(v, e);
    let live: Annot[] = annots;
    let moved = false;
    this.gesture = {
      move: m => {
        const p = this.pdfAt(v, m);
        const dx = p[0] - start[0], dy = p[1] - start[1];
        if (!moved && Math.hypot(dx, dy) * this.viewer.scale < 3) return;
        moved = true;
        live = annots.map(a => {
          const r = a.rect;
          return remapAnnot(this.adopt(a), r, [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]);
        });
        for (const a of live) this.viewer.replaceAnnotNode(v, a);
      },
      up: () => {
        if (moved) this.viewer.session!.replaceMany(v.page, annots.map((before, i) => ({ before, after: live[i] })), 'Move objects');
      },
      cancel: () => this.viewer.drawAnnots(v),
    };
  }

  /** Shift+drag on the page draws a box and selects everything inside it. */
  private startMarquee(e: PointerEvent, v: PageView) {
    e.preventDefault();
    const [sx, sy] = this.local(v, e);
    const node = s('rect', { class: 'rubber', x: sx, y: sy, width: 0, height: 0 });
    v.selG.append(node);
    let end: [number, number] = [sx, sy];
    this.gesture = {
      move: m => {
        end = this.local(v, m);
        node.setAttribute('x', String(Math.min(sx, end[0])));
        node.setAttribute('y', String(Math.min(sy, end[1])));
        node.setAttribute('width', String(Math.abs(end[0] - sx)));
        node.setAttribute('height', String(Math.abs(end[1] - sy)));
      },
      up: () => {
        node.remove();
        const x0 = Math.min(sx, end[0]), x1 = Math.max(sx, end[0]), y0 = Math.min(sy, end[1]), y1 = Math.max(sy, end[1]);
        const inside = v.page.annots.filter(a => {
          const b = annotBounds(a);
          const p0 = toScreen(v.vp, b[0], b[1]), p1 = toScreen(v.vp, b[2], b[3]);
          return Math.min(p0[0], p1[0]) < x1 && Math.max(p0[0], p1[0]) > x0 && Math.min(p0[1], p1[1]) < y1 && Math.max(p0[1], p1[1]) > y0;
        });
        this.viewer.select(null);
        inside.forEach((a, i) => {
          if (i === 0) this.viewer.select(v.page.id, a.id);
          else this.viewer.toggleSelect(v.page.id, a.id);
        });
        this.hooks.onSelection?.();
      },
      cancel: () => node.remove(),
    };
  }

  /** The first edit of an existing annotation turns it into one of ours. */
  private adopt(a: Annot): Annot {
    if (!a.ghost) return a;
    const { ghost: _g, ...rest } = a;
    return { ...rest };
  }

  private startMove(e: PointerEvent, v: PageView, a: Annot) {
    const start = this.pdfAt(v, e);
    let live: Annot = a;
    let moved = false;
    this.gesture = {
      move: m => {
        const p = this.pdfAt(v, m);
        const dx = p[0] - start[0], dy = p[1] - start[1];
        if (!moved && Math.hypot(dx, dy) * this.viewer.scale < 3) return;
        moved = true;
        const r = a.rect;
        live = remapAnnot(this.adopt(a), r, [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]);
        this.viewer.replaceAnnotNode(v, live);
      },
      up: () => {
        if (moved) this.viewer.session!.replaceAnnot(v.page, a, live, 'Move');
      },
      cancel: () => this.viewer.drawAnnots(v),
    };
  }

  private startResize(e: PointerEvent, v: PageView, handle: SVGElement) {
    const sel = this.viewer.selectedAnnot();
    if (!sel) return;
    const a = sel.annot;
    const fx = +handle.getAttribute('data-fx')!, fy = +handle.getAttribute('data-fy')!;
    const b = annotBounds(a);
    // Which sides of the box in page terms move, worked out from the screen, so rotation is fine.
    const corner = (cx: number, cy: number) => {
      const p = toScreen(v.vp, cx, cy);
      return p;
    };
    const sa = corner(b[0], b[1]), sb = corner(b[2], b[3]);
    const left = Math.min(sa[0], sb[0]), right = Math.max(sa[0], sb[0]);
    const top = Math.min(sa[1], sb[1]), bottom = Math.max(sa[1], sb[1]);
    const keepAspect = a.kind === 'image' || a.kind === 'stamp' || a.kind === 'math';
    let live = a;
    this.gesture = {
      move: m => {
        const [mx, my] = this.local(v, m);
        let x0 = left, x1 = right, y0 = top, y1 = bottom;
        if (fx === 0) x0 = Math.min(mx, right - 4); else if (fx === 1) x1 = Math.max(mx, left + 4);
        if (fy === 0) y0 = Math.min(my, bottom - 4); else if (fy === 1) y1 = Math.max(my, top + 4);
        if (keepAspect && !m.shiftKey && fx !== 0.5 && fy !== 0.5) {
          const k = Math.max((x1 - x0) / (right - left), (y1 - y0) / (bottom - top));
          const nw = (right - left) * k, nh = (bottom - top) * k;
          if (fx === 0) x0 = x1 - nw; else x1 = x0 + nw;
          if (fy === 0) y0 = y1 - nh; else y1 = y0 + nh;
        }
        const p0 = toPdf(v.vp, x0, y0), p1 = toPdf(v.vp, x1, y1);
        const nb = pointsBounds([p0[0], p0[1], p1[0], p1[1]]);
        live = this.scaleInto(this.adopt(a), b, nb);
        this.viewer.replaceAnnotNode(v, live);
      },
      up: () => {
        if (live === a) return;
        const session = this.viewer.session!, page = v.page, sized = live;
        if (!sized.markdown) { session.replaceAnnot(page, a, sized, 'Resize'); return; }
        // A note keeps its text size. A new width changes how tall it needs to be.
        this.track(fitMarkdown(sized).then(done => {
          // Something newer happened to this note meanwhile, so that wins.
          if (page.annots.find(x => x.id === a.id) !== a) return;
          session.replaceAnnot(page, a, done, 'Resize');
        }).catch(err => reportError('Resizing', err)));
      },
      cancel: () => this.viewer.drawAnnots(v),
    };
  }

  private scaleInto(a: Annot, from: number[], to: number[]): Annot {
    const ang = (a.angle ?? 0) % 180;
    if (!ang) return remapAnnot(a, from, to);
    // Rotated boxes keep their shape, so scale them evenly about the new centre.
    const k = (to[2] - to[0]) / ((from[2] - from[0]) || 1);
    const w = (a.rect[2] - a.rect[0]) * k, ht = (a.rect[3] - a.rect[1]) * k;
    const cx = (to[0] + to[2]) / 2, cy = (to[1] + to[3]) / 2;
    return { ...a, rect: [cx - w / 2, cy - ht / 2, cx + w / 2, cy + ht / 2] };
  }

  // ---- Text markup ----

  private downMarkup(e: PointerEvent, v: PageView) {
    const target = e.target as Element;
    // Dragging over text selects it natively. Dragging on a scan draws a box instead.
    if (target.closest('.textLayer span')) return;
    const has = v.textHost.querySelector('span');
    if (has) return;
    this.startBox(e, v);
  }

  /** Marks the selected text with any kind, from the quick bar over a selection. */
  markSelection(kind: Tool) {
    const before = this.tool;
    this.tool = kind;
    try { this.finishMarkup(); } finally { this.tool = before; }
  }

  private finishMarkup() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !this.viewer.session) return;
    const rects = [...sel.getRangeAt(0).getClientRects()].filter(r => r.width > 1 && r.height > 1);
    const made = new Map<PageView, number[][]>();
    for (const v of this.viewer.views.values()) {
      const box = v.el.getBoundingClientRect();
      const lines: { x0: number; x1: number; y0: number; y1: number }[] = [];
      for (const r of rects) {
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cx < box.left || cx > box.right || cy < box.top || cy > box.bottom) continue;
        const x0 = r.left - box.left, x1 = r.right - box.left, y0 = r.top - box.top, y1 = r.bottom - box.top;
        const same = lines.find(l => Math.abs((l.y0 + l.y1) / 2 - (y0 + y1) / 2) < (y1 - y0) * 0.5);
        if (same) {
          same.x0 = Math.min(same.x0, x0); same.x1 = Math.max(same.x1, x1);
          same.y0 = Math.min(same.y0, y0); same.y1 = Math.max(same.y1, y1);
        } else lines.push({ x0, x1, y0, y1 });
      }
      if (lines.length) made.set(v, lines.map(l => this.quad(v, l.x0, l.y0, l.x1, l.y1)));
    }
    const text = sel.toString().trim();
    sel.removeAllRanges();
    for (const [v, quads] of made) this.addMarkup(v, quads, text);
  }

  private quad(v: PageView, x0: number, y0: number, x1: number, y1: number): number[] {
    return [...toPdf(v.vp, x0, y0), ...toPdf(v.vp, x1, y0), ...toPdf(v.vp, x0, y1), ...toPdf(v.vp, x1, y1)];
  }

  private addMarkup(v: PageView, quads: number[][], text: string) {
    if (this.tool === 'redact') {
      // A redaction covers each line separately.
      const annots = quads.map(q => {
        const r = this.base('redact', 'redact');
        r.rect = quadsBounds([q]);
        r.width = 0;
        r.opacity = 1;
        return r;
      });
      this.viewer.session!.addAnnots(v.page, annots, 'Mark for redaction');
      return;
    }
    const a = this.base(this.tool as Kind, this.tool);
    a.quads = quads;
    a.rect = quadsBounds(quads);
    if (text) a.contents = text;
    this.add(v, a, 'Mark text');
  }

  // ---- Ink ----

  private startInk(e: PointerEvent, v: PageView) {
    e.preventDefault();
    const st = this.style();
    const pts: number[] = [...this.pdfAt(v, e)];
    const node = s('path', { fill: 'none', stroke: st.color, 'stroke-width': st.width, opacity: st.opacity, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    v.annotsG.append(node);
    let raf = 0;
    const redraw = () => { raf = 0; node.setAttribute('d', segsToSvg(smoothPath(pts))); };
    this.gesture = {
      move: m => {
        const list = m.getCoalescedEvents?.() ?? [m];
        for (const ev of (list.length ? list : [m])) {
          const p = this.pdfAt(v, ev);
          const dx = p[0] - pts[pts.length - 2], dy = p[1] - pts[pts.length - 1];
          if (dx * dx + dy * dy * 1 > 0.04) pts.push(p[0], p[1]);
        }
        if (!raf) raf = requestAnimationFrame(redraw);
      },
      up: () => {
        cancelAnimationFrame(raf);
        node.remove();
        const a = this.base('ink', this.tool);
        const path = simplify(pts, 0.25);
        a.paths = [path];
        a.rect = pointsBounds(path, st.width / 2);
        this.add(v, a, 'Draw');
      },
      cancel: () => node.remove(),
    };
  }

  private startEraser(e: PointerEvent, v: PageView) {
    e.preventDefault();
    const hit = (m: { clientX: number; clientY: number }) => {
      const [x, y] = this.pdfAt(v, m);
      const r = 6 / this.viewer.scale;
      for (const a of [...v.page.annots]) {
        if (a.kind !== 'ink' || !a.paths) continue;
        for (const path of a.paths) {
          // Measure to each straight piece, because a long straight stroke keeps only its two ends.
          for (let i = 0; i + 1 < path.length; i += 2) {
            const x0 = path[i], y0 = path[i + 1];
            const x1 = path[i + 2] ?? x0, y1 = path[i + 3] ?? y0;
            const dx = x1 - x0, dy = y1 - y0;
            const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy || 1)));
            if (Math.hypot(x0 + dx * t - x, y0 + dy * t - y) < r + a.width / 2) {
              this.viewer.session!.removeAnnot(v.page, a);
              return;
            }
          }
        }
      }
    };
    hit(e);
    this.gesture = { move: hit, up: () => {}, cancel: () => {} };
  }

  // ---- Boxes ----

  private startBox(e: PointerEvent, v: PageView) {
    e.preventDefault();
    const [sx, sy] = this.local(v, e);
    const node = s('rect', { class: 'rubber', x: sx, y: sy, width: 0, height: 0 });
    v.selG.append(node);
    let end: [number, number] = [sx, sy];
    this.gesture = {
      move: m => {
        end = this.local(v, m);
        node.setAttribute('x', String(Math.min(sx, end[0])));
        node.setAttribute('y', String(Math.min(sy, end[1])));
        node.setAttribute('width', String(Math.abs(end[0] - sx)));
        node.setAttribute('height', String(Math.abs(end[1] - sy)));
      },
      up: () => {
        node.remove();
        if (Math.abs(end[0] - sx) < 4 || Math.abs(end[1] - sy) < 4) return;
        void this.finishBox(v, sx, sy, end[0], end[1]);
      },
      cancel: () => node.remove(),
    };
  }

  private async finishBox(v: PageView, sx: number, sy: number, ex: number, ey: number) {
    const p0 = toPdf(v.vp, sx, sy), p1 = toPdf(v.vp, ex, ey);
    const rect = pointsBounds([p0[0], p0[1], p1[0], p1[1]]);
    const t = this.tool;

    if (MARKUP.has(t)) { this.addMarkup(v, [this.quad(v, sx, sy, ex, ey)], ''); return; }
    if (t === 'snip') { this.hooks.snip?.(v.page, rect); this.setTool('select'); return; }
    if (t === 'read-picture') { this.setTool('select'); this.hooks.readPicture?.(v.page, rect); return; }
    if (t === 'crop') { this.hooks.crop?.(v.page, rect); this.setTool('select'); return; }
    if (t === 'cert-box') { this.setTool('select'); this.hooks.certBox?.(v.page, rect); return; }
    if (t === 'crop-image') {
      const b = v.el.getBoundingClientRect();
      this.hooks.cropImage?.(v, { x0: Math.min(sx, ex), y0: Math.min(sy, ey), x1: Math.max(sx, ex), y1: Math.max(sy, ey) }, b);
      this.setTool('select');
      return;
    }

    if (t === 'link') {
      const url = await this.hooks.askLink?.();
      if (!url) return;
      const a = this.base('link', t);
      a.rect = rect; a.url = url;
      this.add(v, a, 'Add link');
      this.afterCreate(v, a);
      return;
    }
    if (t.startsWith('field-')) {
      const type = t.slice(6) as NonNullable<Annot['field']>['type'];
      const info = await this.hooks.askFieldName?.(type);
      if (!info) return;
      const a = this.base('rect', t);
      a.rect = rect;
      a.color = '#0b57d0';
      a.field = { type, name: info.name, options: info.options };
      this.add(v, a, 'Add form field');
      this.afterCreate(v, a);
      return;
    }
    const a = this.base(t as Kind, t);
    a.rect = rect;
    if (t === 'whiteout') { a.fill = '#ffffff'; a.width = 0; a.burn = true; a.opacity = 1; }
    if (t === 'redact') { a.width = 0; a.opacity = 1; }
    this.add(v, a, t === 'redact' ? 'Mark for redaction' : 'Add shape');
    this.afterCreate(v, a);
  }

  private startLine(e: PointerEvent, v: PageView) {
    e.preventDefault();
    const st = this.style();
    const start = this.pdfAt(v, e);
    const node = s('path', { fill: 'none', stroke: st.color, 'stroke-width': st.width });
    v.annotsG.append(node);
    let end = start;
    this.gesture = {
      move: m => {
        end = this.pdfAt(v, m);
        if (m.shiftKey) {
          // Shift keeps the line straight, at 45° steps.
          const ang = Math.round(Math.atan2(end[1] - start[1], end[0] - start[0]) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(end[0] - start[0], end[1] - start[1]);
          end = [start[0] + len * Math.cos(ang), start[1] + len * Math.sin(ang)];
        }
        node.setAttribute('d', `M${start[0]} ${start[1]}L${end[0]} ${end[1]}`);
      },
      up: () => {
        node.remove();
        if (Math.hypot(end[0] - start[0], end[1] - start[1]) * this.viewer.scale < 4) return;
        const t = this.tool;
        const a = this.base(t === 'distance' ? 'measure' : (t as Kind), t);
        a.pts = [start[0], start[1], end[0], end[1]];
        a.rect = pointsBounds(a.pts);
        if (t === 'distance') this.applyMeasure(a, 'distance');
        this.add(v, a, t === 'distance' ? 'Measure' : 'Add line');
        this.afterCreate(v, a);
      },
      cancel: () => node.remove(),
    };
  }

  private applyMeasure(a: Annot, type: NonNullable<Annot['measureType']>) {
    const m = this.hooks.measure?.() ?? { unit: 'in', scale: 1 / 72 };
    a.measureType = type;
    a.measureUnit = m.unit;
    a.measureScale = m.scale;
    a.contents = measureLabel(a);
  }

  private clickShape(e: PointerEvent, v: PageView) {
    e.preventDefault();
    const p = this.pdfAt(v, e);
    const st = this.style();
    if (!this.clickPts || this.clickPts.v !== v) {
      this.cancel();
      const node = s('path', { fill: 'none', stroke: st.color, 'stroke-width': st.width });
      v.annotsG.append(node);
      this.clickPts = { v, pts: [p[0], p[1]], node };
      const onMove = (m: PointerEvent) => {
        if (!this.clickPts) { window.removeEventListener('pointermove', onMove); return; }
        const q = this.pdfAt(v, m);
        const all = this.clickPts.pts;
        let d = '';
        for (let i = 0; i + 1 < all.length; i += 2) d += `${i ? 'L' : 'M'}${all[i]} ${all[i + 1]}`;
        node.setAttribute('d', `${d}L${q[0]} ${q[1]}`);
      };
      window.addEventListener('pointermove', onMove);
      return;
    }
    const c = this.clickPts.pts;
    // Clicking near the first point closes the shape.
    if (c.length >= 6 && Math.hypot(p[0] - c[0], p[1] - c[1]) * this.viewer.scale < 10) { this.endClickShape(); return; }
    c.push(p[0], p[1]);
  }

  private endClickShape() {
    const c = this.clickPts;
    if (!c) return;
    this.clickPts = null;
    c.node.remove();
    const min = this.tool === 'polyline' || this.tool === 'perimeter' ? 4 : 6;
    if (c.pts.length < min) return;
    const t = this.tool;
    const isMeasure = t === 'perimeter' || t === 'area';
    const a = this.base(isMeasure ? 'measure' : (t as Kind), t);
    a.pts = c.pts;
    a.rect = pointsBounds(a.pts);
    if (isMeasure) this.applyMeasure(a, t);
    this.add(c.v, a, isMeasure ? 'Measure' : 'Add shape');
    this.afterCreate(c.v, a);
  }

  private dbl(e: MouseEvent) {
    if (MULTI_CLICK.has(this.tool)) { this.endClickShape(); return; }
    if (this.tool !== 'select') return;
    const v = this.viewAt(e);
    const node = (e.target as Element).closest('[data-id]');
    if (!v || !node) return;
    const a = v.page.annots.find(x => x.id === node.getAttribute('data-id'));
    if (!a) return;
    if (a.kind === 'attachment') this.hooks.openAttachment?.(a);
    else if (a.kind === 'math') this.hooks.editEquation?.(v, a);
    else if (a.kind === 'text' || a.kind === 'callout') this.openEditor(v, a, false);
    else if (a.kind === 'note' || a.kind !== 'image') this.openCommentEditor(v, a);
  }

  // ---- Text boxes ----

  private placeText(e: PointerEvent, v: PageView) {
    e.preventDefault();
    const [x, y] = this.local(v, e);
    const st = this.style();
    const box = placeBox(v.page, x / this.viewer.scale, y / this.viewer.scale, x / this.viewer.scale + 200, y / this.viewer.scale + st.fontSize * 1.8);
    const a = this.base('text', 'text');
    a.rect = box.rect; a.angle = box.angle; a.text = ''; a.textColor = st.color; a.width = 0;
    this.openEditor(v, a, true);
  }

  /** A box for Markdown. You type the marks, and it turns into formatted notes when you click away. */
  private placeMarkdown(e: PointerEvent, v: PageView) {
    e.preventDefault();
    const [x, y] = this.local(v, e);
    const k = this.viewer.scale;
    const box = placeBox(v.page, x / k, y / k, x / k + 300, y / k + 120);
    const a = this.base('text', 'markdown');
    a.rect = box.rect; a.angle = box.angle; a.text = ''; a.textColor = '#111111'; a.width = 0; a.fill = null; a.opacity = 1;
    a.markdown = true;
    a.mdTheme = this.hooks.mdTheme?.();
    this.openEditor(v, a, true);
  }

  private placeCallout(e: PointerEvent, v: PageView) {
    e.preventDefault();
    const tip = this.pdfAt(v, e);
    const [x, y] = this.local(v, e);
    const k = this.viewer.scale;
    const box = placeBox(v.page, x / k + 34, y / k - 60, x / k + 214, y / k - 20);
    const a = this.base('callout', 'callout');
    a.rect = box.rect; a.angle = box.angle; a.pts = [tip[0], tip[1]]; a.text = ''; a.textColor = '#111111';
    this.openEditor(v, a, true);
  }

  private placeNote(e: PointerEvent, v: PageView) {
    e.preventDefault();
    const [x, y] = this.pdfAt(v, e);
    const a = this.base('note', 'note');
    a.rect = noteRect(x, y);
    a.fill = a.color;
    this.add(v, a, 'Add note');
    this.afterCreate(v, a);
    this.openCommentEditor(v, a);
  }

  /** The file was chosen or recorded before the click, so this is only about where it goes. */
  private placeAttachment(e: PointerEvent, v: PageView) {
    e.preventDefault();
    const file = this.hooks.attachmentAsset?.();
    if (!file) return;
    const [x, y] = this.pdfAt(v, e);
    const a = this.base('attachment', 'note');
    a.rect = [x - 10, y - 12, x + 10, y + 12];
    a.attachment = file;
    a.contents = file.name;
    a.opacity = 1;
    a.width = 0.75;
    a.color = file.voice ? '#c9e4ff' : '#ffe066';
    this.add(v, a, file.voice ? 'Add voice note' : 'Attach file');
    this.afterCreate(v, a);
  }

  private placeStamp(e: PointerEvent, v: PageView) {
    e.preventDefault();
    const [x, y] = this.local(v, e);
    const k = this.viewer.scale;
    const label = this.hooks.stampLabel?.() ?? 'APPROVED';
    const w = Math.max(110, label.length * 13), ht = 38;
    const box = placeBox(v.page, x / k - w / 2, y / k - ht / 2, x / k + w / 2, y / k + ht / 2);
    const a = this.base('stamp', 'stamp');
    a.rect = box.rect; a.angle = box.angle; a.text = label; a.contents = label;
    this.add(v, a, 'Add stamp');
    this.afterCreate(v, a);
  }

  private placeSignature(e: PointerEvent, v: PageView) {
    e.preventDefault();
    const asset = this.hooks.signatureAsset?.();
    if (!asset) return;
    const [x, y] = this.local(v, e);
    const k = this.viewer.scale;
    const w = 170, ht = (w * asset.height) / (asset.width || 1);
    const box = placeBox(v.page, x / k - w / 2, y / k - ht / 2, x / k + w / 2, y / k + ht / 2);
    const a = this.base('image', 'signature');
    a.rect = box.rect; a.angle = box.angle; a.image = asset; a.opacity = 1; a.contents = 'Signature';
    this.add(v, a, 'Sign');
    this.afterCreate(v, a);
  }

  // ---- Inline editors ----

  /** Places a text area over the box, at the size the text will have on the page. */
  openEditor(v: PageView, a: Annot, isNew: boolean) {
    this.commitEdit();
    const b = annotBounds({ ...a, pts: undefined, kind: 'text' });
    const p0 = toScreen(v.vp, b[0], b[1]), p1 = toScreen(v.vp, b[2], b[3]);
    const k = this.viewer.scale;
    const left = Math.min(p0[0], p1[0]), top = Math.min(p0[1], p1[1]);
    const ta = h('textarea', {
      class: 'inline-editor', dir: 'auto', value: a.text ?? '', spellcheck: false,
      style: {
        left: `${left}px`, top: `${top}px`,
        width: `${Math.max(60, Math.abs(p1[0] - p0[0]))}px`,
        minHeight: `${Math.max(24, Math.abs(p1[1] - p0[1]))}px`,
        fontSize: `${(a.fontSize ?? 12) * k}px`, color: a.textColor ?? a.color,
        fontWeight: a.bold ? '700' : '400', fontStyle: a.italic ? 'italic' : 'normal',
        fontFamily: a.fontName ? fontCss(a.fontName) : FONT_CSS[a.font ?? 'helvetica'],
      },
    });
    if (a.markdown) {
      // While typing it is plain marks, in an easy-to-read fixed font.
      ta.classList.add('md-source');
      ta.placeholder = '# Title\n**bold**  ==highlight==  $x^2$\n- [ ] task\n\nClick away to format.';
      ta.style.fontFamily = 'Consolas, "Cascadia Code", monospace';
      ta.style.fontSize = `${Math.max(11, 12) * k}px`;
      ta.style.minHeight = `${Math.max(120 * k, Math.abs(p1[1] - p0[1]))}px`;
      ta.style.width = `${Math.max(240 * k, Math.abs(p1[0] - p0[0]))}px`;
    }
    const grow = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 2}px`; };
    ta.addEventListener('input', grow);
    v.el.append(ta);
    grow();
    ta.focus();
    let done = false;
    const commit = (keep = true) => {
      if (done) return;
      done = true;
      const text = ta.value;
      const hPt = (ta.scrollHeight + 4) / k;
      ta.remove();
      this.editing = null;
      if (!keep) return;
      if (!text.trim()) {
        if (!isNew) this.viewer.session!.removeAnnot(v.page, a);
        return;
      }
      const r = a.rect;
      const newH = Math.max(r[3] - r[1], hPt);
      const updated: Annot = { ...this.adopt(a), text, contents: text };
      if (a.markdown) {
        // Kept for the document this was typed in, even if another one is opened meanwhile.
        const session = this.viewer.session!, page = v.page;
        this.track((async () => {
          const fitted = await fitMarkdown(updated);
          if (isNew) {
            session.addAnnots(page, [fitted], 'Add Markdown');
            if (this.viewer.session === session) this.afterCreate(v, fitted);
            return;
          }
          const now = page.annots.find(x => x.id === a.id);
          if (!now) return; // Deleted meanwhile.
          const { ghost: _g, ...plain } = now;
          const next = now === a ? fitted : await fitMarkdown({ ...plain, text, contents: text });
          session.replaceAnnot(page, now, next, 'Edit Markdown');
        })().catch(err => reportError('Formatting the note', err)));
        return;
      }
      if (!a.angle) updated.rect = [r[0], r[3] - newH, r[2], r[3]];
      if (isNew) { this.add(v, updated, 'Add text'); this.afterCreate(v, updated); }
      else this.viewer.session!.replaceAnnot(v.page, a, updated, 'Edit text');
    };
    this.editing = { commit: () => commit(true) };
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') commit(false);
      if (e.key === 'Enter' && e.ctrlKey) commit(true);
    });
    ta.addEventListener('blur', () => setTimeout(() => commit(true), 0));
  }

  openCommentEditor(v: PageView, a: Annot) {
    this.commitEdit();
    const b = annotBounds(a);
    const p = toScreen(v.vp, b[2], b[3]);
    const q = toScreen(v.vp, b[0], b[1]);
    const ta = h('textarea', {
      class: 'inline-editor comment', value: a.contents ?? '', placeholder: 'Add a comment…',
      style: { left: `${Math.max(p[0], q[0]) + 6}px`, top: `${Math.min(p[1], q[1])}px` },
    });
    v.el.append(ta);
    ta.focus();
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const text = ta.value;
      ta.remove();
      this.editing = null;
      if (text !== (a.contents ?? '')) {
        const current = v.page.annots.find(x => x.id === a.id) ?? a;
        this.viewer.session!.replaceAnnot(v.page, current, { ...this.adopt(current), contents: text }, 'Edit comment');
      }
    };
    this.editing = { commit };
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && e.ctrlKey)) commit();
    });
    ta.addEventListener('blur', () => setTimeout(commit, 0));
  }

  // ---- Edit existing page text ----

  /**
   * Covers a line of the page's text with its own background and types the new text on top.
   * Fonts cannot always be matched, and the old text stays underneath unless redacted.
   */
  private startEditText(e: PointerEvent, v: PageView) {
    const span = (e.target as Element).closest('.textLayer span') as HTMLElement | null;
    if (!span || !span.textContent?.trim()) return;
    e.preventDefault();
    const box = v.el.getBoundingClientRect();
    const r = span.getBoundingClientRect();
    const x0 = r.left - box.left, y0 = r.top - box.top, x1 = r.right - box.left, y1 = r.bottom - box.top;
    const { bg, fg } = sampleColours(v, x0, y0, x1, y1);
    const k = this.viewer.scale;
    const page = v.page;
    const whiteBox = placeBox(page, x0 / k - 0.5, y0 / k - 0.5, x1 / k + 0.5, y1 / k + 0.5);

    const cover: Annot = {
      ...this.base('whiteout', 'whiteout'), rect: whiteBox.rect, angle: whiteBox.angle, fill: bg, width: 0, opacity: 1, burn: true,
    };
    const textA: Annot = {
      ...this.base('text', 'text'), rect: whiteBox.rect, angle: whiteBox.angle, text: span.textContent ?? '',
      textColor: fg, color: fg, width: 0, fontSize: Math.max(4, (y1 - y0) / k * 0.82), burn: true,
      font: familyOf(span), bold: false, italic: false,
    };
    // Widen the box so a longer replacement fits, and pad it so text lands in the same spot.
    textA.rect = [textA.rect[0] - 4, textA.rect[1] - 2, textA.rect[2] + 40, textA.rect[3] + 2];

    const ta = h('textarea', {
      class: 'inline-editor edit-line', value: textA.text, spellcheck: false,
      style: {
        left: `${x0 - 2}px`, top: `${y0 - 2}px`, width: `${x1 - x0 + 40 * k}px`, height: `${y1 - y0 + 6}px`,
        fontSize: `${textA.fontSize! * k}px`, color: fg, background: bg,
      },
    });
    v.el.append(ta);
    ta.focus();
    ta.select();
    let done = false;
    const original = textA.text;
    const commit = (keep = true) => {
      if (done) return;
      done = true;
      const text = ta.value;
      ta.remove();
      this.editing = null;
      if (!keep || text === original) return;
      this.viewer.session!.addAnnots(page, [cover, { ...textA, text, contents: text }], 'Edit page text');
    };
    this.editing = { commit: () => commit(true) };
    ta.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Escape') commit(false);
      if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
    });
    ta.addEventListener('blur', () => setTimeout(() => commit(true), 0));
  }

  viewportOf(p: PageRef) { return viewportFor(p, this.viewer.scale); }
}

/** The closest built-in font to the one on the page. */
function familyOf(span: HTMLElement): FontFamily {
  const f = getComputedStyle(span).fontFamily.toLowerCase();
  if (/mono|courier|consolas/.test(f)) return 'courier';
  if (/sans/.test(f)) return 'helvetica';
  if (/serif|times|georgia|garamond|cambria/.test(f)) return 'times';
  return 'helvetica';
}

function sampleColours(v: PageView, x0: number, y0: number, x1: number, y1: number): { bg: string; fg: string } {
  const c = v.canvas;
  if (!c) return { bg: '#ffffff', fg: '#000000' };
  const kx = c.width / parseFloat(v.el.style.width), ky = c.height / parseFloat(v.el.style.height);
  try {
    const ctx = c.getContext('2d')!;
    const data = ctx.getImageData(Math.max(0, x0 * kx), Math.max(0, y0 * ky), Math.max(1, (x1 - x0) * kx), Math.max(1, (y1 - y0) * ky)).data;
    const counts = new Map<number, number>();
    for (let i = 0; i < data.length; i += 4) {
      const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 32767;
    const px = (k: number): [number, number, number] => [((k >> 10) & 31) * 8 + 4, ((k >> 5) & 31) * 8 + 4, (k & 31) * 8 + 4];
    const bgRgb = px(top);
    let fgRgb = bgRgb, best = -1;
    for (const k of counts.keys()) {
      const q = px(k);
      const d = Math.abs(q[0] - bgRgb[0]) + Math.abs(q[1] - bgRgb[1]) + Math.abs(q[2] - bgRgb[2]);
      if (d > best) { best = d; fgRgb = q; }
    }
    const hex = (q: number[]) => '#' + q.map(n => Math.min(255, n).toString(16).padStart(2, '0')).join('');
    // Exact black and white are by far the most common, so snap to them when close.
    const snap = (q: [number, number, number]): number[] => (q.every(n => n > 240) ? [255, 255, 255] : q.every(n => n < 24) ? [0, 0, 0] : q);
    return { bg: hex(snap(bgRgb)), fg: hex(snap(fgRgb)) };
  } catch {
    return { bg: '#ffffff', fg: '#000000' };
  }
}
