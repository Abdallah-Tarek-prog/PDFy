// The document model. Edits are non-destructive: pages point at a source file and annotations
// sit in memory until saved. Reordering a 5,000-page file only reorders a list.

import type { Analysis } from '../theme/engine';

export type Kind =
  | 'highlight' | 'underline' | 'strikeout' | 'squiggly'
  | 'ink' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'polygon' | 'polyline' | 'cloud'
  | 'text' | 'callout' | 'note' | 'stamp' | 'image' | 'measure' | 'redact' | 'whiteout' | 'link' | 'attachment' | 'math';

export type ThemeMode = 'original' | 'light' | 'dark' | 'match';
export type FontFamily = 'helvetica' | 'times' | 'courier';

export const FONT_CSS: Record<FontFamily, string> = {
  helvetica: 'Arial, Helvetica, sans-serif',
  times: '"Times New Roman", Times, serif',
  courier: '"Courier New", Courier, monospace',
};

export interface ImageAsset {
  blob: Blob;          // What is shown and saved now.
  original: Blob;      // The pasted image, kept so conversion can always be undone.
  width: number;
  height: number;
  theme: ThemeMode;
  style: string;
  keepPhotos: boolean;
  analysis?: Analysis;
}

export interface Annot {
  id: string;
  kind: Kind;
  rect: [number, number, number, number]; // PDF points, bottom-left origin, x0<x1 and y0<y1.
  color: string;
  opacity: number;
  width: number;
  fill?: string | null;
  contents?: string;
  author?: string;
  created?: number;
  quads?: number[][];   // Text markup: x1 y1 x2 y2 x3 y3 x4 y4 per line (TL TR BL BR).
  paths?: number[][];   // Ink: flat x,y lists.
  pts?: number[];       // Line and polygon family: flat x,y list.
  text?: string;
  fontSize?: number;
  font?: FontFamily;
  /** Any installed or added font, by name. When set, it wins over font. */
  fontName?: string;
  /** The text is Markdown, shown formatted once you click away. */
  markdown?: boolean;
  /** Look of a Markdown box. */
  mdTheme?: string;
  /** An equation, and its finished drawing. */
  latex?: string;
  mathSvg?: string;
  mathDisplay?: boolean;
  bold?: boolean;
  italic?: boolean;
  textColor?: string;
  image?: ImageAsset;
  /** A file or voice note pinned to this spot. */
  attachment?: { name: string; mime: string; blob?: Blob; voice?: boolean; /** Where pdf.js keeps the bytes of a file already in the PDF. */ fileId?: string };
  stamp?: string;
  measureUnit?: string;
  measureScale?: number; // Real units per point.
  measureType?: 'distance' | 'perimeter' | 'area';
  url?: string;
  /** Rotation in degrees, counter-clockwise, around the centre of rect. */
  angle?: number;
  /** Drawn into the page itself on save instead of staying a movable annotation. */
  burn?: boolean;
  field?: { type: 'text' | 'check' | 'radio' | 'dropdown' | 'list' | 'signature'; name: string; options?: string[]; /** What was filled in, before the form is saved. */ value?: string | boolean | string[] };
  /** Comment thread. */
  replies?: Reply[];
  status?: ReviewStatus;
  /** Reply and status annotations already in the file, which go when this one is rewritten. */
  importedReplies?: string[];
  /** PDF annotation this replaces, in pdf.js id form such as "12R". */
  importedFrom?: string;
  /** Existing annotation still drawn by the PDF engine. Only becomes ours when edited. */
  ghost?: boolean;
}

export interface Reply { id: string; author: string; text: string; when: number }
export type ReviewStatus = 'none' | 'accepted' | 'rejected' | 'completed' | 'cancelled';

export interface PageRef {
  id: string;
  source: string | null;   // null means a blank page.
  index: number;           // Page index in the source.
  view: [number, number, number, number]; // Page box in PDF points.
  baseRotate: number;      // Rotation stored in the file.
  rotate: number;          // Rotation added by the user.
  crop: [number, number, number, number] | null;
  annots: Annot[];
  /** Existing annotations the user deleted. */
  removed: string[];
  sized: boolean;          // False until the real size is known (first page size is assumed).
  ghostsLoaded?: boolean;  // Existing annotations have been read from the file.
  rev?: number;            // Goes up when annotations change, so thumbnails know to redraw.
}

export interface Bookmark { id: string; pageId: string; title: string }

export interface SaveAnnot extends Omit<Annot, 'image'> {
  imageBytes?: ArrayBuffer;
  imageType?: 'png' | 'jpg';
  attachmentBytes?: ArrayBuffer;
  /** Rasterised text for characters the built-in PDF font cannot encode. */
  textImage?: ArrayBuffer;
  /** Text runs in two directions, such as Arabic with numbers, which only a picture can lay out. */
  mixedDirection?: boolean;
  embedFonts?: boolean;
  /** A box printed to its own small PDF, placed as real vector text. */
  vectorPdf?: ArrayBuffer;
  /** Height of that small PDF's page, because the box sits at its top edge. */
  vectorHeight?: number;
}

export interface SavePage {
  source: string | null;
  index: number;
  view: [number, number, number, number];
  rotate: number;
  absoluteRotate: number;
  crop: [number, number, number, number] | null;
  annots: SaveAnnot[];
  removed: string[];
  /** Invisible words from OCR, so scanned pages become searchable. */
  hiddenText?: { x: number; y: number; w: number; h: number; text: string }[];
}

export interface BuildOptions {
  flattenAnnots?: boolean;
  flattenForms?: boolean;
  encrypt?: { userPassword?: string; ownerPassword?: string; permissions?: Record<string, unknown> };
  stripMetadata?: boolean;
  metadata?: { title?: string; author?: string; subject?: string; keywords?: string };
  compress?: { quality: number; maxSide: number };
  /** Set for extract and split, which should not carry the whole file's outline or forms. */
  dropDocLevel?: boolean;
  removePassword?: boolean;
  /** Where the PC's fonts can be read from, for embedding. */
  fontBase?: string;
  wholeFonts?: boolean;
  bookmarks?: { title: string; pageIndex: number }[];
  attachments?: { name: string; mime: string; bytes: ArrayBuffer }[];
  pdfa?: '1B' | '2B' | '3B';
  signature?: { name: string; reason: string; location: string; pageIndex: number; rect: number[] | null };
  author?: string;
}

export const uid = (): string => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);

export function clampRect(r: number[]): [number, number, number, number] {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

export function pointsBounds(pts: number[], pad = 0): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    if (pts[i] < x0) x0 = pts[i];
    if (pts[i] > x1) x1 = pts[i];
    if (pts[i + 1] < y0) y0 = pts[i + 1];
    if (pts[i + 1] > y1) y1 = pts[i + 1];
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

export function pageRotation(p: PageRef): number {
  return (((p.baseRotate + p.rotate) % 360) + 360) % 360;
}

export interface Viewport {
  width: number;
  height: number;
  /** PDF point to screen pixel. */
  m: [number, number, number, number, number, number];
}

/** The same maths pdf.js uses, extended so crop boxes work everywhere. */
export function viewportFor(p: PageRef, scale: number): Viewport {
  return makeViewport(p.crop ?? p.view, pageRotation(p), scale);
}

export function makeViewport(box: number[], rotation: number, scale: number): Viewport {
  const cx = (box[2] + box[0]) / 2, cy = (box[3] + box[1]) / 2;
  let a = 1, b = 0, c = 0, d = -1;
  if (rotation === 180) { a = -1; b = 0; c = 0; d = 1; }
  else if (rotation === 90) { a = 0; b = 1; c = 1; d = 0; }
  else if (rotation === 270) { a = 0; b = -1; c = -1; d = 0; }
  let ox: number, oy: number, width: number, height: number;
  if (a === 0) {
    ox = Math.abs(cy - box[1]) * scale; oy = Math.abs(cx - box[0]) * scale;
    width = (box[3] - box[1]) * scale; height = (box[2] - box[0]) * scale;
  } else {
    ox = Math.abs(cx - box[0]) * scale; oy = Math.abs(cy - box[1]) * scale;
    width = (box[2] - box[0]) * scale; height = (box[3] - box[1]) * scale;
  }
  return {
    width, height,
    m: [a * scale, b * scale, c * scale, d * scale,
      ox - a * scale * cx - c * scale * cy, oy - b * scale * cx - d * scale * cy],
  };
}

export const toScreen = (vp: Viewport, x: number, y: number): [number, number] =>
  [vp.m[0] * x + vp.m[2] * y + vp.m[4], vp.m[1] * x + vp.m[3] * y + vp.m[5]];

export function toPdf(vp: Viewport, sx: number, sy: number): [number, number] {
  const [a, b, c, d, e, f] = vp.m;
  const det = a * d - b * c;
  return [(d * (sx - e) - c * (sy - f)) / det, (a * (sy - f) - b * (sx - e)) / det];
}

/** A box as seen on screen (at scale 1), in page terms. Keeps new objects upright on rotated pages. */
export function placeBox(p: PageRef, sx0: number, sy0: number, sx1: number, sy1: number): { rect: Annot['rect']; angle: number } {
  const vp = viewportFor(p, 1);
  const [cx, cy] = toPdf(vp, (sx0 + sx1) / 2, (sy0 + sy1) / 2);
  const w = Math.abs(sx1 - sx0), h = Math.abs(sy1 - sy0);
  return { rect: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], angle: pageRotation(p) };
}

export const NOTE_SIZE = 20;
