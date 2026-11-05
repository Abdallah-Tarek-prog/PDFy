// Theme conversion engine. Pure pixel logic with no browser dependencies, so it runs
// in a worker and can be unit tested in Node.
//
// What makes this different from "invert colours":
//  - Only lightness flips. Hue is kept, so blue links stay blue and red stays red.
//  - The source background, surface and text colours are detected, then mapped exactly onto
//    the target palette. A Gemini dark screenshot ends up on Gemini's real light colours.
//  - Anti-aliased text edges are blends, so neutrals interpolate between the same anchors.
//  - Photos inside the screenshot are detected and left untouched.

export interface Palette { bg: string; surface: string; text: string }
export type Rgb = [number, number, number];
export interface Rect { x: number; y: number; w: number; h: number }

export interface Analysis {
  bg: Rgb;
  surface: Rgb | null;
  text: Rgb | null;
  isDark: boolean;
  photos: Rect[];
}

export interface ConvertOptions {
  target: Palette;
  keepPhotos: boolean;
  analysis?: Analysis;
}

const SRGB_TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linToSrgb(c: number): number {
  if (c <= 0) return 0;
  if (c >= 1) return 255;
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(v * 255);
}

interface Lab { L: number; a: number; b: number }

function rgbToOklab(r: number, g: number, b: number): Lab {
  const lr = SRGB_TO_LIN[r], lg = SRGB_TO_LIN[g], lb = SRGB_TO_LIN[b];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = L + 0.3963377774 * a + 0.2158037573 * b;
  const m = L - 0.1055613458 * a - 0.0638541728 * b;
  const s = L - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l * l * l, m3 = m * m * m, s3 = s * s * s;
  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}

const inGamut = (c: [number, number, number]) =>
  c[0] >= -0.0005 && c[0] <= 1.0005 && c[1] >= -0.0005 && c[1] <= 1.0005 && c[2] >= -0.0005 && c[2] <= 1.0005;

/** OKLab to packed RGB. Pulls chroma in until the colour fits sRGB, so hue never shifts. */
function labToPacked(L: number, a: number, b: number): number {
  let lin = oklabToLinear(L, a, b);
  if (!inGamut(lin)) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 7; i++) {
      const k = (lo + hi) / 2;
      if (inGamut(oklabToLinear(L, a * k, b * k))) lo = k; else hi = k;
    }
    lin = oklabToLinear(L, a * lo, b * lo);
  }
  return (linToSrgb(lin[0]) << 16) | (linToSrgb(lin[1]) << 8) | linToSrgb(lin[2]);
}

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: Rgb): string {
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

const labOf = (c: Rgb) => rgbToOklab(c[0], c[1], c[2]);
const chroma = (l: Lab) => Math.hypot(l.a, l.b);

/** Finds what the screenshot is made of. Sampled, so a 4K image costs about the same as 1080p. */
export function analyze(data: Uint8ClampedArray, width: number, height: number): Analysis {
  const total = width * height;
  const step = Math.max(1, Math.floor(Math.sqrt(total / 400000)));
  const bins = new Uint32Array(32768);
  const sumR = new Float64Array(32768), sumG = new Float64Array(32768), sumB = new Float64Array(32768);
  const edge = Math.max(2, Math.round(Math.min(width, height) * 0.03));

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 128) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      // The background almost always touches the outer edge, so edges count extra.
      const w = x < edge || y < edge || x >= width - edge || y >= height - edge ? 4 : 1;
      bins[k] += w; sumR[k] += r * w; sumG[k] += g * w; sumB[k] += b * w;
    }
  }

  const used: number[] = [];
  let weight = 0;
  for (let k = 0; k < 32768; k++) if (bins[k]) { used.push(k); weight += bins[k]; }
  used.sort((a, b) => bins[b] - bins[a]);
  const colour = (k: number): Rgb => [
    Math.round(sumR[k] / bins[k]), Math.round(sumG[k] / bins[k]), Math.round(sumB[k] / bins[k]),
  ];

  const bg: Rgb = used.length ? colour(used[0]) : [255, 255, 255];
  const bgLab = labOf(bg);
  const isDark = bgLab.L < 0.55;

  // The main text colour is the strongest neutral that appears often enough to be text. Going by the most
  // common one would pick grey secondary text, and then real body text would have nothing left to map to.
  let surface: Rgb | null = null;
  let text: Rgb | null = null;
  let textContrast = 0;
  const limit = Math.min(used.length, 800);
  for (let n = 1; n < limit; n++) {
    const k = used[n];
    if (bins[k] / weight < 0.0012) break;
    const lab = labOf(colour(k));
    const dL = Math.abs(lab.L - bgLab.L);
    if (dL > 0.3 && chroma(lab) < 0.06 && dL > textContrast) { textContrast = dL; text = colour(k); }
  }
  // A surface is a panel or code block. It sits between the background and the text, so a shade on the
  // far side of the background is not one.
  const towardText = text ? Math.sign(labOf(text).L - bgLab.L) : (isDark ? 1 : -1);
  for (let n = 1; n < limit; n++) {
    const k = used[n];
    if (bins[k] / weight <= 0.012) break;
    const c = colour(k);
    const lab = labOf(c);
    const delta = (lab.L - bgLab.L) * towardText;
    if (delta > 0.012 && delta < 0.2 && chroma(lab) < 0.05) { surface = c; break; }
  }

  return { bg, surface, text, isDark, photos: findPhotos(data, width, height) };
}

/**
 * Finds photo regions. Flat interface colours repeat exactly, even between lines of dense text.
 * In a photo, exact repeats are rare, even in smooth areas like sky.
 */
export function findPhotos(data: Uint8ClampedArray, width: number, height: number): Rect[] {
  const tile = Math.max(16, Math.round(Math.min(width, height) / 70));
  const cols = Math.ceil(width / tile), rows = Math.ceil(height / tile);
  const hot = new Uint8Array(cols * rows);
  // A small hash table, reused for every tile, so nothing is allocated per tile.
  const SIZE = 1024;
  const keys = new Int32Array(SIZE);
  const counts = new Uint16Array(SIZE);
  const stamps = new Int32Array(SIZE).fill(-1);
  const luma = new Uint16Array(16);

  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const id = ty * cols + tx;
      let distinct = 0, top = 0, n = 0;
      let sumRG = 0, sumBG = 0, sqRG = 0, sqBG = 0;
      let rough = 0, roughN = 0;
      luma.fill(0);
      const x1 = Math.min(width, (tx + 1) * tile), y1 = Math.min(height, (ty + 1) * tile);
      for (let y = ty * tile; y < y1; y += 2) {
        let pr = -1, pg = 0, pb = 0;
        for (let x = tx * tile; x < x1; x += 2) {
          const i = (y * width + x) * 4;
          const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
          let slot = (key ^ (key >>> 11)) & (SIZE - 1);
          while (stamps[slot] === id && keys[slot] !== key) slot = (slot + 1) & (SIZE - 1);
          if (stamps[slot] !== id) { stamps[slot] = id; keys[slot] = key; counts[slot] = 0; distinct++; }
          if (++counts[slot] > top) top = counts[slot];
          n++;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          luma[((r * 77 + g * 150 + b * 29) >> 8) >> 4]++;
          if (pr >= 0) { rough += (Math.abs(r - pr) + Math.abs(g - pg) + Math.abs(b - pb)) / 3; roughN++; }
          pr = r; pg = g; pb = b;
          const rg = r - g, bg = b - g;
          sumRG += rg; sumBG += bg; sqRG += rg * rg; sqBG += bg * bg;
        }
      }
      if (n < 8 || top / n >= 0.5) continue;
      // Interface glows and gradients are perfectly smooth, however many colours they use. Photos
      // always carry some grain or detail. This is what keeps Gemini's blue glow from being "a photo".
      if (roughN && rough / roughN < 1.6) continue;
      // Text on a flat background: one brightness dominates, with a few pixels far from it.
      // This shape survives JPEG noise, and it is what separates text from a photo.
      let peak = 0;
      for (let k = 1; k < 16; k++) if (luma[k] > luma[peak]) peak = k;
      let far = 0;
      for (let k = 0; k < 16; k++) if (Math.abs(k - peak) >= 3) far += luma[k];
      const peakShare = luma[peak] / n;
      if (peakShare >= 0.45 && far / n >= 0.04) continue;
      // Grey areas need stronger proof, because compressed interface elements are grey too.
      const spread = Math.max(Math.sqrt(Math.max(0, sqRG / n - (sumRG / n) ** 2)), Math.sqrt(Math.max(0, sqBG / n - (sumBG / n) ** 2)));
      const busy = distinct >= n * 0.35 && top / n < 0.25;
      // Soft, colourful areas such as sky have few distinct colours in a small tile but no flat one.
      const soft = Math.abs(sumRG / n) + Math.abs(sumBG / n) > 12 && distinct >= 5;
      if (!busy && !soft) continue;
      if (!soft && spread < 5 && (distinct < n * 0.6 || peakShare >= 0.35)) continue;
      hot[id] = 1;
    }
  }

  // Group touching tiles and keep only blocks large enough to be a real picture.
  const out: Rect[] = [];
  const stack: number[] = [];
  for (let start = 0; start < hot.length; start++) {
    if (hot[start] !== 1) continue;
    let minX = cols, maxX = 0, minY = rows, maxY = 0, area = 0;
    stack.push(start);
    hot[start] = 2;
    while (stack.length) {
      const id = stack.pop()!;
      const x = id % cols, y = (id - x) / cols;
      area++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      const push = (nx: number, ny: number) => {
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) return;
        const nid = ny * cols + nx;
        if (hot[nid] === 1) { hot[nid] = 2; stack.push(nid); }
      };
      push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1);
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const pxW = bw * tile, pxH = bh * tile;
    if (pxW < 64 || pxH < 64 || area / (bw * bh) < 0.55) continue;
    out.push({ x: minX * tile, y: minY * tile, w: Math.min(pxW, width - minX * tile), h: Math.min(pxH, height - minY * tile) });
  }
  return out;
}

interface Anchor { src: number; lab: Lab }

/**
 * Builds a colour function for one conversion. Neutrals land exactly on the target palette,
 * chromatic colours keep hue and get the same lightness move.
 */
function buildMapper(a: Analysis, target: Palette) {
  const tBg = labOf(hexToRgb(target.bg));
  const tSurface = labOf(hexToRgb(target.surface));
  const tText = labOf(hexToRgb(target.text));
  const sBg = labOf(a.bg);
  const targetDark = tBg.L < tText.L;
  // Assume a typical text colour if none was found, for example a screenshot with only an icon.
  const sTextL = a.text ? labOf(a.text).L : (a.isDark ? 0.92 : 0.2);

  const anchors: Anchor[] = [{ src: sBg.L, lab: tBg }];
  if (a.surface) {
    const sL = labOf(a.surface).L;
    // A surface on the far side of the background from the text has no slot in the ramp.
    if (Math.abs(sL - sBg.L) < Math.abs(sTextL - sBg.L) && (sL - sBg.L) * (sTextL - sBg.L) > 0) {
      anchors.push({ src: sL, lab: tSurface });
    }
  }
  const textFrom: Anchor = { src: sTextL, lab: tText };
  anchors.push(textFrom);
  anchors.sort((p, q) => p.src - q.src);
  const crossing = a.isDark !== (tBg.L < tText.L);

  const dir = sTextL >= sBg.L ? 1 : -1; // Source lightness direction from background to text.
  const lerpLab = (p: Lab, q: Lab, t: number): Lab => ({
    L: p.L + (q.L - p.L) * t, a: p.a + (q.a - p.a) * t, b: p.b + (q.b - p.b) * t,
  });

  const neutral = (L: number): Lab => {
    const first = anchors[0], last = anchors[anchors.length - 1];
    if (L <= first.src || L >= last.src) {
      const end = L <= first.src ? first : last;
      const beyond = Math.abs(L - end.src);
      const isBgSide = (L - sBg.L) * dir < 0;
      if (isBgSide) {
        // Darker than a dark background, or brighter than a light one, such as an inset code
        // block. Reflect it inward so the block stays visible instead of vanishing.
        const pull = Math.min(1, beyond * 5);
        return lerpLab(tBg, tSurface, pull);
      }
      // Past the text colour, such as pure white headings on a dark theme.
      const extreme = targetDark ? 1 : 0.1;
      return { L: end.lab.L + (extreme - end.lab.L) * Math.min(1, beyond * 1.6), a: end.lab.a, b: end.lab.b };
    }
    for (let i = 1; i < anchors.length; i++) {
      if (L <= anchors[i].src) {
        const p = anchors[i - 1], q = anchors[i];
        let u = (L - p.src) / (q.src - p.src || 1);
        // Soft text edges are blends. Flipped from light on dark to dark on light they look too heavy,
        // and text comes out too thin going the other way. This curve holds the weight steady.
        if (crossing && (p === textFrom || q === textFrom)) {
          const towardText = q === textFrom ? u : 1 - u;
          const eased = Math.pow(towardText, targetDark ? 1 / TEXT_WEIGHT : TEXT_WEIGHT);
          u = q === textFrom ? eased : 1 - eased;
        }
        return lerpLab(p.lab, q.lab, u);
      }
    }
    return last.lab;
  };

  const chromaScale = !crossing ? 1 : targetDark ? 0.88 : 1.22;
  const sText = a.text ? labOf(a.text) : { L: sTextL, a: 0, b: 0 };
  const smooth = (e0: number, e1: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };

  return (r: number, g: number, b: number): number => {
    const lab = rgbToOklab(r, g, b);
    const n = neutral(lab.L);
    // Colour is measured against the theme's own tint. GitHub's dark greys lean blue, for example,
    // and that lean is part of the grey, not an accent colour.
    const t = Math.max(0, Math.min(1, (lab.L - sBg.L) / ((sText.L - sBg.L) || 1)));
    const ra = lab.a - (sBg.a + (sText.a - sBg.a) * t);
    const rb = lab.b - (sBg.b + (sText.b - sBg.b) * t);
    const C = Math.hypot(ra, rb);
    if (C < 0.012) return labToPacked(n.L, n.a, n.b);

    let L = n.L;
    let k = chromaScale;
    if (crossing) {
      // How far this colour sits from the background toward the text. Colours near the background
      // are tinted panels and stay near the new background. Colours near the text are foreground.
      const fg = smooth(0.32, 0.55, t);
      // Vivid colours such as logos and status colours look much the same in both themes, so they
      // move less. Pale colours are made for dark backgrounds, so they move the full way.
      L += (lab.L - L) * smooth(0.06, 0.2, C) * 0.75 * fg;
      // Keep foreground accents readable on the new background.
      const limited = targetDark ? Math.max(L, 0.68) : Math.min(L, 0.62);
      L += (limited - L) * smooth(0.03, 0.08, C) * fg;
      // Tinted panels and glows need a little room from the background to show their colour at all.
      L += (targetDark ? 1 : -1) * Math.min(0.08, C * 0.45) * (1 - fg);
      // A pale accent on dark becomes a rich one on light, as real light themes do.
      if (!targetDark && lab.L > 0.7 && C < 0.12) k = Math.max(k, Math.min(0.15, C * 2.1) / C);
    }
    const blend = smooth(0.012, 0.03, C);
    return labToPacked(L, n.a + ra * k * blend, n.b + rb * k * blend);
  };
}

/**
 * Decides which pixels in a photo's box are really the picture. A box always overshoots a little and
 * rounded corners show the old background. So plain background reachable from the box's edge gets
 * converted, and everything else is kept. One extra pixel removes the soft edge between the two.
 */
function photoMask(data: Uint8ClampedArray, width: number, p: Rect, a: Analysis): Uint8Array {
  const keep = new Uint8Array(p.w * p.h).fill(1);
  const flats = [labOf(a.bg), ...(a.surface ? [labOf(a.surface)] : [])];
  const isFlat = (x: number, y: number) => {
    const i = ((p.y + y) * width + p.x + x) * 4;
    const l = rgbToOklab(data[i], data[i + 1], data[i + 2]);
    return flats.some(f => Math.abs(l.L - f.L) + Math.abs(l.a - f.a) + Math.abs(l.b - f.b) < 0.04);
  };
  const stack: number[] = [];
  const visit = (x: number, y: number) => {
    const at = y * p.w + x;
    if (keep[at] && isFlat(x, y)) { keep[at] = 0; stack.push(at); }
  };
  for (let x = 0; x < p.w; x++) { visit(x, 0); visit(x, p.h - 1); }
  for (let y = 0; y < p.h; y++) { visit(0, y); visit(p.w - 1, y); }
  while (stack.length) {
    const at = stack.pop()!;
    const x = at % p.w, y = (at - x) / p.w;
    if (x > 0) visit(x - 1, y);
    if (x + 1 < p.w) visit(x + 1, y);
    if (y > 0) visit(x, y - 1);
    if (y + 1 < p.h) visit(x, y + 1);
  }
  // Grow the converted area by one pixel to take in the blended edge.
  const edge: number[] = [];
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
    if (!keep[y * p.w + x]) continue;
    if ((x > 0 && !keep[y * p.w + x - 1]) || (x + 1 < p.w && !keep[y * p.w + x + 1]) || (y > 0 && !keep[(y - 1) * p.w + x]) || (y + 1 < p.h && !keep[(y + 1) * p.w + x])) edge.push(y * p.w + x);
  }
  for (const at of edge) keep[at] = 0;
  return keep;
}

const CACHE_BITS = 16;
const TEXT_WEIGHT = 1.25;
const CACHE_SIZE = 1 << CACHE_BITS;

/**
 * Converts pixels in place. Screenshots have few unique colours, so a small colour cache and a
 * same-as-last-pixel shortcut make this fast and allocation-free per pixel.
 */
export function convertPixels(data: Uint8ClampedArray, width: number, height: number, opts: ConvertOptions): Analysis {
  const analysis = opts.analysis ?? analyze(data, width, height);
  const map = buildMapper(analysis, opts.target);
  const keys = new Int32Array(CACHE_SIZE).fill(-1);
  const vals = new Int32Array(CACHE_SIZE);
  const photos = opts.keepPhotos ? analysis.photos : [];
  const keepMasks = photos.map(p => photoMask(data, width, p, analysis));

  let lastKey = -1, lastVal = 0;
  for (let y = 0; y < height; y++) {
    // Photos on this row, so pictures are skipped without a per-pixel test.
    let spans: number[] | null = null;
    for (let n = 0; n < photos.length; n++) if (y >= photos[n].y && y < photos[n].y + photos[n].h) (spans ??= []).push(n);

    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (spans) {
        let keep = false;
        for (const n of spans) {
          const p = photos[n];
          if (x >= p.x && x < p.x + p.w && keepMasks[n][(y - p.y) * p.w + (x - p.x)]) { keep = true; break; }
        }
        if (keep) continue;
      }
      if (data[i + 3] === 0) continue;
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      let v: number;
      if (key === lastKey) v = lastVal;
      else {
        const slot = (key ^ (key >>> CACHE_BITS) ^ (key >>> 7)) & (CACHE_SIZE - 1);
        if (keys[slot] === key) v = vals[slot];
        else {
          v = map(data[i], data[i + 1], data[i + 2]);
          keys[slot] = key; vals[slot] = v;
        }
        lastKey = key; lastVal = v;
      }
      data[i] = v >> 16; data[i + 1] = (v >> 8) & 255; data[i + 2] = v & 255;
    }
  }
  return analysis;
}

/** Quick light or dark check on a single colour, used for "match page". */
export function isDarkColour(c: Rgb): boolean {
  return labOf(c).L < 0.55;
}

/** Builds a palette around any background, keeping the style's relationships. */
export function paletteForBackground(bg: Rgb, base: Palette): Palette {
  const dark = isDarkColour(bg);
  const lab = labOf(bg);
  const surfaceL = lab.L + (dark ? 0.05 : -0.035);
  const packed = labToPacked(surfaceL, lab.a, lab.b);
  return {
    bg: rgbToHex(bg),
    surface: rgbToHex([packed >> 16, (packed >> 8) & 255, packed & 255]),
    text: base.text,
  };
}
