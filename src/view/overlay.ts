// Draws annotations over the page as SVG, in PDF coordinates.

import { annotBounds, measureLabel, segsToSvg, shapeOf } from '../core/geometry';
import { FONT_CSS, toScreen, type Annot, type PageRef, type Viewport } from '../core/model';
import { fontCss } from '../study/fonts';
import { renderMarkdownInto } from '../study/markdown';
import { texToSvg } from '../study/math';
import { ensureRichCss, themeById, themeVars } from '../study/mdthemes';
import { h, s } from '../ui/dom';

const urls = new WeakMap<Blob, string>();

export function blobUrl(b: Blob): string {
  let u = urls.get(b);
  if (!u) { u = URL.createObjectURL(b); urls.set(b, u); }
  return u;
}

/** A frame with its origin at the top-left of the box and y pointing down, so text stays upright. */
function localFrame(a: Annot): string {
  const [x0, y0, x1, y1] = a.rect;
  const w = x1 - x0, h2 = y1 - y0;
  const cx = x0 + w / 2, cy = y0 + h2 / 2;
  return `translate(${cx} ${cy}) rotate(${a.angle ?? 0}) translate(${-w / 2} ${h2 / 2}) scale(1 -1)`;
}

export function annotNode(a: Annot): SVGElement {
  const g = s('g', { 'data-id': a.id, class: `annot k-${a.kind}${a.kind === 'highlight' || a.marker ? ' highlighter' : ''}${a.ghost ? ' ghost' : ''}${a.field ? ' own-field' : ''}`, opacity: a.ghost ? null : a.opacity });

  if (a.ghost) {
    // The PDF engine still draws this one. All we need is something clickable.
    const b = annotBounds(a);
    g.append(s('rect', { x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1], fill: 'transparent' }));
    return g;
  }

  const shape = shapeOf(a);
  if (a.kind === 'highlight') {
    g.append(s('path', { d: segsToSvg(shape.fill), fill: a.color }));
    return g;
  }
  if (a.kind === 'redact') {
    const [x0, y0, x1, y1] = a.rect;
    g.append(s('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: 'rgba(0,0,0,.72)', stroke: '#e5484d', 'stroke-width': 1 }));
    return g;
  }
  if (a.kind === 'whiteout') {
    const [x0, y0, x1, y1] = a.rect;
    g.append(s('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: a.fill ?? '#ffffff' }));
    return g;
  }
  if (a.kind === 'link') {
    const [x0, y0, x1, y1] = a.rect;
    g.append(s('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: 'rgba(11,87,208,.08)', stroke: '#0b57d0', 'stroke-width': 0.75, 'stroke-dasharray': '3 2' }));
    return g;
  }
  if (a.field) {
    const [x0, y0, x1, y1] = a.rect;
    g.append(s('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: 'rgba(11,87,208,.08)', stroke: '#0b57d0', 'stroke-width': 0.75 }));
    const frame = s('g', { transform: localFrame(a) });
    const label = s('text', { class: 'field-label', x: 3, y: Math.min(11, y1 - y0 - 2), 'font-size': 8.5, fill: '#0b57d0', 'font-family': 'Arial, sans-serif' });
    label.textContent = `${a.field.type}: ${a.field.name}`;
    frame.append(label);
    g.append(frame);
    return g;
  }

  if (a.kind === 'attachment') {
    const [x0, y0, x1, y1] = a.rect;
    g.append(s('path', { d: segsToSvg(shape.fill), fill: a.color, stroke: '#5f5a2a', 'stroke-width': 0.75 }));
    const mark = s('text', { 'font-size': (y1 - y0) * 0.55, 'text-anchor': 'middle', transform: `translate(${(x0 + x1) / 2} ${y0 + (y1 - y0) * 0.3}) scale(1 -1)` });
    mark.textContent = a.attachment?.voice ? '♪' : '📎';
    g.append(mark);
    return g;
  }
  if (shape.fill.length) {
    const colour = a.kind === 'note' ? a.color : a.kind === 'arrow' ? a.color : a.fill ?? null;
    if (colour) g.append(s('path', { d: segsToSvg(shape.fill), fill: colour }));
  }
  if (shape.stroke.length) {
    g.append(s('path', {
      d: segsToSvg(shape.stroke), fill: 'none',
      stroke: a.kind === 'note' ? '#5f5a2a' : a.color,
      'stroke-width': a.kind === 'note' ? 0.75 : a.width,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }));
  }

  const [x0, y0, x1, y1] = a.rect;
  const w = x1 - x0, ht = y1 - y0;

  if (a.kind === 'image' && a.image) {
    const frame = s('g', { transform: localFrame(a) });
    const img = s('image', { width: w, height: ht, preserveAspectRatio: 'none' });
    img.setAttribute('href', blobUrl(a.image.blob));
    frame.append(img);
    g.append(frame);
  } else if (a.kind === 'stamp') {
    const frame = s('g', { transform: localFrame(a) });
    frame.append(s('rect', { x: 1, y: 1, width: w - 2, height: ht - 2, fill: 'none', stroke: a.color, 'stroke-width': Math.max(1.5, a.width), rx: 3 }));
    const fontSize = Math.min(ht * 0.55, (w * 0.86) / Math.max(1, (a.text ?? '').length * 0.62));
    const t = s('text', {
      x: w / 2, y: ht / 2 + fontSize * 0.36, 'text-anchor': 'middle', 'font-size': fontSize,
      'font-weight': 700, fill: a.color, 'font-family': 'Arial, Helvetica, sans-serif',
    });
    t.textContent = a.text ?? '';
    frame.append(t);
    g.append(frame);
  } else if (a.kind === 'math') {
    ensureRichCss();
    const frame = s('g', { transform: localFrame(a) });
    const fo = s('foreignObject', { width: w, height: ht });
    const div = h('div', { class: 'math-box', style: { color: a.color } });
    if (a.mathSvg && !/<(script|a|foreignObject|image)\b|\son\w+=|href=/i.test(a.mathSvg)) div.innerHTML = a.mathSvg;
    // An equation reopened from a saved file draws itself again from its LaTeX.
    else void texToSvg(a.latex ?? '', a.mathDisplay !== false).then(r => { div.innerHTML = r.svg; a.mathSvg = r.svg; }).catch(err => console.warn('Equation', err));
    fo.append(div);
    frame.append(fo);
    g.append(frame);
  } else if (a.markdown) {
    ensureRichCss();
    const frame = s('g', { transform: localFrame(a) });
    const fo = s('foreignObject', { width: w, height: ht });
    const div = h('div', { class: 'md-box', dir: 'auto' });
    div.style.cssText = themeVars(themeById(a.mdTheme), a.fontSize);
    void renderMarkdownInto(div, a.text ?? '').catch(err => console.warn('Equation in a note', err));
    fo.append(div);
    frame.append(fo);
    g.append(frame);
  } else if (a.kind === 'text' || a.kind === 'callout') {
    const frame = s('g', { transform: localFrame(a) });
    if (a.fill) frame.append(s('rect', { width: w, height: ht, fill: a.fill }));
    if (a.kind === 'callout') frame.append(s('rect', { width: w, height: ht, fill: 'none', stroke: a.color, 'stroke-width': Math.max(0.75, a.width) }));
    const fo = s('foreignObject', { width: w, height: ht });
    const div = h('div', {
      class: 'annot-text', dir: 'auto',
      style: {
        fontSize: `${a.fontSize ?? 12}px`,
        color: a.textColor ?? a.color,
        fontWeight: a.bold ? '700' : '400',
        fontStyle: a.italic ? 'italic' : 'normal',
        fontFamily: a.fontName ? fontCss(a.fontName) : FONT_CSS[a.font ?? 'helvetica'],
      },
    }, a.text ?? '');
    fo.append(div);
    frame.append(fo);
    g.append(frame);
  } else if (a.kind === 'measure') {
    const p = a.pts ?? [];
    const lx = (p[0] + (p[2] ?? p[0])) / 2, ly = (p[1] + (p[3] ?? p[1])) / 2 + 4;
    const t = s('text', { 'font-size': 9, 'font-weight': 700, fill: a.color, 'font-family': 'Arial, sans-serif', transform: `translate(${lx} ${ly}) scale(1 -1)` });
    t.textContent = measureLabel(a);
    g.append(t);
  }
  return g;
}

export const RESIZABLE = new Set(['math', 'image', 'stamp', 'text', 'callout', 'rect', 'ellipse', 'line', 'arrow', 'polygon', 'polyline', 'cloud', 'ink', 'whiteout', 'redact', 'link', 'measure']);

export interface HandleInfo { fx: 0 | 0.5 | 1; fy: 0 | 0.5 | 1 }

/** Lines, arrows and distances are changed by their two ends rather than a box. */
export const hasEnds = (a: Annot) => (a.kind === 'line' || a.kind === 'arrow' || (a.kind === 'measure' && a.measureType === 'distance')) && a.pts?.length === 4;

/** Selection frame and handles, in screen pixels, so their size does not change with zoom. */
export function selectionNode(a: Annot, p: PageRef, vp: Viewport, handles = true): SVGElement {
  if (handles && hasEnds(a)) {
    const g = s('g', { class: 'selection' });
    const [x0, y0] = toScreen(vp, a.pts![0], a.pts![1]), [x1, y1] = toScreen(vp, a.pts![2], a.pts![3]);
    g.append(s('line', { class: 'sel-frame', x1: x0, y1: y0, x2: x1, y2: y1 }));
    [[x0, y0], [x1, y1]].forEach(([x, y], end) => g.append(s('circle', { class: 'sel-handle sel-end', cx: x, cy: y, r: 5.5, 'data-end': end, style: 'cursor:move' })));
    return g;
  }
  const b = annotBounds(a);
  const pts = [toScreen(vp, b[0], b[1]), toScreen(vp, b[2], b[1]), toScreen(vp, b[2], b[3]), toScreen(vp, b[0], b[3])];
  const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const g = s('g', { class: 'selection' });
  g.append(s('rect', { class: 'sel-frame', x: x0 - 2, y: y0 - 2, width: x1 - x0 + 4, height: y1 - y0 + 4 }));
  if (handles && RESIZABLE.has(a.kind)) {
    const size = 9;
    for (const [fx, fy] of [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]]) {
      const hx = x0 + (x1 - x0) * fx, hy = y0 + (y1 - y0) * fy;
      const cur = fx === 0.5 ? 'ns' : fy === 0.5 ? 'ew' : fx === fy ? 'nwse' : 'nesw';
      g.append(s('rect', {
        class: 'sel-handle', x: hx - size / 2, y: hy - size / 2, width: size, height: size, rx: 2,
        'data-fx': fx, 'data-fy': fy, style: `cursor:${cur}-resize`,
      }));
    }
  }
  void p;
  return g;
}
