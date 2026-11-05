// Shape outlines, shared by the on-screen overlay and the saved PDF so both look the same.

import { NOTE_SIZE, pointsBounds, type Annot } from './model';

export type Seg =
  | ['M', number, number]
  | ['L', number, number]
  | ['C', number, number, number, number, number, number]
  | ['Z'];

const KAPPA = 0.5522847498;

export function rectPath(r: number[]): Seg[] {
  return [['M', r[0], r[1]], ['L', r[2], r[1]], ['L', r[2], r[3]], ['L', r[0], r[3]], ['Z']];
}

export function ellipsePath(r: number[]): Seg[] {
  const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
  const rx = (r[2] - r[0]) / 2, ry = (r[3] - r[1]) / 2;
  const kx = rx * KAPPA, ky = ry * KAPPA;
  return [
    ['M', cx - rx, cy],
    ['C', cx - rx, cy + ky, cx - kx, cy + ry, cx, cy + ry],
    ['C', cx + kx, cy + ry, cx + rx, cy + ky, cx + rx, cy],
    ['C', cx + rx, cy - ky, cx + kx, cy - ry, cx, cy - ry],
    ['C', cx - kx, cy - ry, cx - rx, cy - ky, cx - rx, cy],
    ['Z'],
  ];
}

export function polyPath(pts: number[], close: boolean): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) out.push([i === 0 ? 'M' : 'L', pts[i], pts[i + 1]] as Seg);
  if (close && out.length) out.push(['Z']);
  return out;
}

/** Smooth pen stroke through midpoints, using cubic curves that PDF understands natively. */
export function smoothPath(p: number[]): Seg[] {
  if (p.length < 4) return p.length === 2 ? [['M', p[0], p[1]], ['L', p[0] + 0.01, p[1]]] : [];
  const out: Seg[] = [['M', p[0], p[1]]];
  if (p.length === 4) { out.push(['L', p[2], p[3]]); return out; }
  let cx = p[0], cy = p[1];
  for (let i = 2; i + 3 < p.length; i += 2) {
    const qx = p[i], qy = p[i + 1];
    const ex = (p[i] + p[i + 2]) / 2, ey = (p[i + 1] + p[i + 3]) / 2;
    out.push(['C', cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey]);
    cx = ex; cy = ey;
  }
  out.push(['L', p[p.length - 2], p[p.length - 1]]);
  return out;
}

/** Drops points that barely change the line, so long strokes stay light. */
export function simplify(p: number[], tol = 0.35): number[] {
  const n = p.length / 2;
  if (n < 3) return p;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = p[a * 2], ay = p[a * 2 + 1], dx = p[b * 2] - ax, dy = p[b * 2 + 1] - ay;
    const len = dx * dx + dy * dy || 1;
    let best = 0, at = -1;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1, ((p[i * 2] - ax) * dx + (p[i * 2 + 1] - ay) * dy) / len));
      const ex = p[i * 2] - (ax + t * dx), ey = p[i * 2 + 1] - (ay + t * dy);
      const d = ex * ex + ey * ey;
      if (d > best) { best = d; at = i; }
    }
    if (best > t2 && at > 0) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i * 2], p[i * 2 + 1]);
  return out;
}

export function arrowHead(x0: number, y0: number, x1: number, y1: number, size: number): Seg[] {
  const a = Math.atan2(y1 - y0, x1 - x0), s = 0.45;
  return [
    ['M', x1, y1],
    ['L', x1 - size * Math.cos(a - s), y1 - size * Math.sin(a - s)],
    ['L', x1 - size * Math.cos(a + s), y1 - size * Math.sin(a + s)],
    ['Z'],
  ];
}

export function cloudPath(pts: number[]): Seg[] {
  if (pts.length < 6) return polyPath(pts, true);
  const out: Seg[] = [];
  const count = pts.length / 2;
  const bump = 9;
  for (let e = 0; e < count; e++) {
    const x0 = pts[e * 2], y0 = pts[e * 2 + 1];
    const x1 = pts[((e + 1) % count) * 2], y1 = pts[((e + 1) % count) * 2 + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.round(len / bump));
    const ux = (x1 - x0) / n, uy = (y1 - y0) / n;
    const nx = -uy * 0.75, ny = ux * 0.75;
    if (e === 0) out.push(['M', x0, y0]);
    for (let i = 0; i < n; i++) {
      const ax = x0 + ux * i, ay = y0 + uy * i, bx = ax + ux, by = ay + uy;
      out.push(['C', ax + nx, ay + ny, bx + nx, by + ny, bx, by]);
    }
  }
  out.push(['Z']);
  return out;
}

function squiggle(x0: number, y0: number, x1: number, y1: number, amp: number): Seg[] {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(2, Math.round(len / (amp * 2)));
  const ux = (x1 - x0) / n, uy = (y1 - y0) / n;
  const nx = (-uy / (Math.hypot(ux, uy) || 1)) * amp, ny = (ux / (Math.hypot(ux, uy) || 1)) * amp;
  const out: Seg[] = [['M', x0, y0]];
  for (let i = 1; i <= n; i++) {
    const s = i % 2 ? 1 : 0;
    out.push(['L', x0 + ux * i + nx * s, y0 + uy * i + ny * s]);
  }
  return out;
}

export interface Shape { fill: Seg[]; stroke: Seg[] }

/** What to draw for an annotation, in PDF coordinates. */
export function shapeOf(a: Annot): Shape {
  const r = a.rect;
  switch (a.kind) {
    case 'highlight': {
      const fill: Seg[] = [];
      for (const q of a.quads ?? []) {
        fill.push(['M', q[0], q[1]], ['L', q[2], q[3]], ['L', q[6], q[7]], ['L', q[4], q[5]], ['Z']);
      }
      return { fill, stroke: [] };
    }
    case 'underline':
    case 'strikeout':
    case 'squiggly': {
      const stroke: Seg[] = [];
      for (const q of a.quads ?? []) {
        if (a.kind === 'underline') stroke.push(['M', q[4], q[5]], ['L', q[6], q[7]]);
        else if (a.kind === 'strikeout') {
          stroke.push(['M', (q[0] + q[4]) / 2, (q[1] + q[5]) / 2], ['L', (q[2] + q[6]) / 2, (q[3] + q[7]) / 2]);
        } else stroke.push(...squiggle(q[4], q[5], q[6], q[7], Math.max(1, a.width)));
      }
      return { fill: [], stroke };
    }
    case 'ink': {
      const stroke: Seg[] = [];
      for (const p of a.paths ?? []) stroke.push(...smoothPath(p));
      return { fill: [], stroke };
    }
    case 'rect':
    case 'redact':
    case 'whiteout': {
      const p = rectPath(r);
      return { fill: p, stroke: p };
    }
    case 'ellipse': {
      const p = ellipsePath(r);
      return { fill: p, stroke: p };
    }
    case 'line': return { fill: [], stroke: polyPath(a.pts ?? [], false) };
    case 'arrow': {
      const p = a.pts ?? [];
      if (p.length < 4) return { fill: [], stroke: [] };
      return {
        fill: arrowHead(p[0], p[1], p[2], p[3], 8 + a.width * 2.2),
        stroke: polyPath(p, false),
      };
    }
    case 'polygon': {
      const p = polyPath(a.pts ?? [], true);
      return { fill: p, stroke: p };
    }
    case 'polyline': return { fill: [], stroke: polyPath(a.pts ?? [], false) };
    case 'cloud': {
      const p = cloudPath(a.pts ?? []);
      return { fill: p, stroke: p };
    }
    case 'measure': {
      const p = polyPath(a.pts ?? [], a.measureType === 'area');
      return { fill: a.measureType === 'area' ? p : [], stroke: p };
    }
    case 'callout': return { fill: [], stroke: calloutLeader(a) };
    case 'note': return notePath(r);
    case 'attachment': return tabPath(r);
    default: return { fill: [], stroke: [] };
  }
}

export function calloutLeader(a: Annot): Seg[] {
  const tip = a.pts;
  if (!tip || tip.length < 2) return [];
  const [x0, y0, x1, y1] = a.rect;
  const px = Math.max(x0, Math.min(x1, tip[0])), py = Math.max(y0, Math.min(y1, tip[1]));
  return [['M', px, py], ['L', tip[0], tip[1]]];
}

function tabPath(r: number[]): Shape {
  const x = r[0], y = r[1], w = r[2] - r[0], h = r[3] - r[1];
  const body: Seg[] = [['M', x + w * 0.2, y], ['L', x + w * 0.8, y], ['L', x + w * 0.8, y + h * 0.7], ['L', x + w * 0.5, y + h], ['L', x + w * 0.2, y + h * 0.7], ['Z']];
  return { fill: body, stroke: body };
}

function notePath(r: number[]): Shape {
  const x = r[0], y = r[1], w = r[2] - r[0], h = r[3] - r[1];
  const body: Seg[] = [
    ['M', x, y + h * 0.28], ['L', x, y + h], ['L', x + w, y + h], ['L', x + w, y + h * 0.28],
    ['L', x + w * 0.5, y + h * 0.28], ['L', x + w * 0.22, y], ['L', x + w * 0.26, y + h * 0.28], ['Z'],
  ];
  return { fill: body, stroke: body };
}

export function segsToSvg(segs: Seg[]): string {
  let out = '';
  for (const s of segs) {
    if (s[0] === 'Z') out += 'Z';
    else out += s[0] + s.slice(1).map(n => +(n as number).toFixed(2)).join(' ');
  }
  return out;
}

const f2 = (n: number) => +n.toFixed(3);

export function segsToPdf(segs: Seg[]): string {
  let out = '';
  for (const s of segs) {
    if (s[0] === 'M') out += `${f2(s[1])} ${f2(s[2])} m\n`;
    else if (s[0] === 'L') out += `${f2(s[1])} ${f2(s[2])} l\n`;
    else if (s[0] === 'C') out += `${f2(s[1])} ${f2(s[2])} ${f2(s[3])} ${f2(s[4])} ${f2(s[5])} ${f2(s[6])} c\n`;
    else out += 'h\n';
  }
  return out;
}

/** Tightest box around a set of quads, used as the annotation's rect. */
export function quadsBounds(quads: number[][]): [number, number, number, number] {
  return pointsBounds(quads.flat());
}

/** Corners of rect after rotation, for selection frames and saved bounds. */
export function rotatedCorners(a: Pick<Annot, 'rect' | 'angle'>): number[] {
  const [x0, y0, x1, y1] = a.rect;
  const ang = ((a.angle ?? 0) * Math.PI) / 180;
  if (!ang) return [x0, y0, x1, y0, x1, y1, x0, y1];
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const c = Math.cos(ang), s = Math.sin(ang);
  const out: number[] = [];
  for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
    out.push(cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c);
  }
  return out;
}

export function annotBounds(a: Annot): [number, number, number, number] {
  let pad = 0;
  if (a.kind === 'ink' || a.kind === 'line' || a.kind === 'polyline' || a.kind === 'polygon') pad = Math.max(a.width, 1);
  else if (a.kind === 'arrow') pad = 8 + a.width * 2.2;
  else if (a.kind === 'cloud') pad = 8;
  else if (a.kind === 'measure') pad = Math.max(a.width, 1) + 14;
  else if (a.kind === 'rect' || a.kind === 'ellipse' || a.kind === 'callout' || a.kind === 'stamp') pad = a.width / 2 + 0.5;
  const pts: number[] = rotatedCorners(a);
  if (a.pts && a.kind === 'callout') pts.push(...a.pts);
  const b = pointsBounds(pts);
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
}

/** Moves and scales an annotation between two rects. Used for dragging and resizing. */
export function remapAnnot(a: Annot, from: number[], to: number[]): Annot {
  const sx = (to[2] - to[0]) / ((from[2] - from[0]) || 1);
  const sy = (to[3] - to[1]) / ((from[3] - from[1]) || 1);
  const mx = (x: number) => to[0] + (x - from[0]) * sx;
  const my = (y: number) => to[1] + (y - from[1]) * sy;
  const mapList = (p: number[]) => p.map((v, i) => (i % 2 ? my(v) : mx(v)));
  const out: Annot = { ...a };
  out.rect = [mx(a.rect[0]), my(a.rect[1]), mx(a.rect[2]), my(a.rect[3])];
  if (a.quads) out.quads = a.quads.map(mapList);
  if (a.paths) out.paths = a.paths.map(mapList);
  if (a.pts) out.pts = mapList(a.pts);
  return out;
}

export function noteRect(x: number, y: number): [number, number, number, number] {
  return [x, y - NOTE_SIZE, x + NOTE_SIZE, y];
}

export function polygonArea(p: number[]): number {
  let s = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return Math.abs(s) / 2;
}

export function polylineLength(p: number[], close = false): number {
  let s = 0;
  for (let i = 2; i + 1 < p.length; i += 2) s += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  if (close && p.length >= 6) s += Math.hypot(p[0] - p[p.length - 2], p[1] - p[p.length - 1]);
  return s;
}

export function measureLabel(a: Annot): string {
  const p = a.pts ?? [];
  const k = a.measureScale ?? 1 / 72;
  const unit = a.measureUnit ?? 'in';
  const fmt = (n: number) => (n >= 100 ? n.toFixed(1) : n.toFixed(2));
  if (a.measureType === 'area') return `${fmt(polygonArea(p) * k * k)} ${unit}²`;
  return `${fmt(polylineLength(p) * k)} ${unit}`;
}

/** Moves an annotation onto a new page layout, for pages rebuilt from pictures. */
export function transformAnnot(a: Annot, map: (x: number, y: number) => number[], rotation: number): Annot {
  const flat = (p: number[]) => { const out: number[] = []; for (let i = 0; i + 1 < p.length; i += 2) out.push(...map(p[i], p[i + 1])); return out; };
  const c0 = map(a.rect[0], a.rect[1]), c1 = map(a.rect[2], a.rect[3]);
  const out: Annot = { ...a };
  const cx = (c0[0] + c1[0]) / 2, cy = (c0[1] + c1[1]) / 2;
  const w = a.rect[2] - a.rect[0], ht = a.rect[3] - a.rect[1];
  if (a.angle !== undefined && a.angle % 360 === rotation) {
    out.rect = [cx - w / 2, cy - ht / 2, cx + w / 2, cy + ht / 2];
    out.angle = 0;
  } else {
    out.rect = [Math.min(c0[0], c1[0]), Math.min(c0[1], c1[1]), Math.max(c0[0], c1[0]), Math.max(c0[1], c1[1])];
  }
  if (a.quads) out.quads = a.quads.map(flat);
  if (a.paths) out.paths = a.paths.map(flat);
  if (a.pts) out.pts = flat(a.pts);
  return out;
}
