// Tests for the logic that needs no browser: the theme engine, geometry, page ranges and diff.
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = await mkdtemp(join(tmpdir(), 'pdfy-test-'));
const out = join(dir, 'bundle.mjs');
await build({
  stdin: {
    contents: `export * from './src/theme/engine.ts'; export * from './src/core/geometry.ts'; export * from './src/core/model.ts'; export { THEME_STYLES, styleById } from './src/theme/presets.ts';`,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'error',
});
const m = await import(pathToFileURL(out).href);

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (err) { failed++; console.log(`  FAIL  ${name}\n        ${err.message}`); }
};

const hex = s => m.hexToRgb(s);

/** A little "screenshot" painter. */
function makeImage(w, h, bg) {
  const data = new Uint8ClampedArray(w * h * 4);
  const fill = (x0, y0, x1, y1, c) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
    }
  };
  fill(0, 0, w, h, hex(bg));
  return { data, w, h, fill, at: (x, y) => { const i = (y * w + x) * 4; return [data[i], data[i + 1], data[i + 2]]; } };
}

function geminiDark() {
  const im = makeImage(800, 600, '#131314');
  im.fill(0, 0, 180, 600, hex('#1e1f20'));       // Sidebar surface.
  for (let y = 60; y < 300; y += 26) {           // Lines of text, as thin bars.
    im.fill(220, y, 700, y + 8, hex('#e3e3e3'));
  }
  im.fill(220, 320, 500, 330, hex('#a8c7fa'));    // A blue link.
  im.fill(520, 320, 700, 330, hex('#f28b82'));    // A red accent.
  // A photo: smooth noise with no dominant colour.
  for (let y = 380; y < 560; y++) for (let x = 220; x < 520; x++) {
    const i = (y * 800 + x) * 4;
    const n = (x * 7 + y * 13) % 97;
    im.data[i] = (x * 255 / 800 + n) & 255; im.data[i + 1] = (y * 255 / 600 + n * 2) & 255; im.data[i + 2] = ((x + y) % 255 + n * 3) & 255;
  }
  return im;
}

const near = (a, b, tol, label) => {
  const d = Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  assert.ok(d <= tol, `${label}: got ${a} expected ${b} (off by ${d}, allowed ${tol})`);
};

const hue = ([r, g, b]) => {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return null;
  let h;
  if (max === r) h = ((g - b) / (max - min)) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  return (h * 60 + 360) % 360;
};

const gemini = m.styleById('gemini');

console.log('Theme engine');
test('detects a dark screenshot and its colours', () => {
  const im = geminiDark();
  const a = m.analyze(im.data, im.w, im.h);
  assert.equal(a.isDark, true);
  near(a.bg, hex('#131314'), 4, 'background');
  assert.ok(a.surface, 'found a surface colour');
  near(a.surface, hex('#1e1f20'), 4, 'surface');
  assert.ok(a.text, 'found a text colour');
  near(a.text, hex('#e3e3e3'), 6, 'text');
});

test('detects a light screenshot', () => {
  const im = makeImage(400, 300, '#ffffff');
  for (let y = 30; y < 200; y += 20) im.fill(30, y, 350, y + 6, hex('#1f1f1f'));
  const a = m.analyze(im.data, im.w, im.h);
  assert.equal(a.isDark, false);
});

test('Gemini dark becomes exact Gemini light colours', () => {
  const im = geminiDark();
  m.convertPixels(im.data, im.w, im.h, { target: gemini.light, keepPhotos: true });
  near(im.at(790, 10), hex(gemini.light.bg), 2, 'page background');
  near(im.at(50, 300), hex(gemini.light.surface), 2, 'sidebar');
  near(im.at(300, 62), hex(gemini.light.text), 2, 'text');
});

test('hue is kept: blue stays blue and red stays red', () => {
  const before = geminiDark();
  const blue0 = hue(before.at(300, 325)), red0 = hue(before.at(600, 325));
  const im = geminiDark();
  m.convertPixels(im.data, im.w, im.h, { target: gemini.light, keepPhotos: true });
  const blue1 = hue(im.at(300, 325)), red1 = hue(im.at(600, 325));
  assert.ok(Math.abs(blue1 - blue0) < 18, `blue moved from ${blue0} to ${blue1}`);
  const diff = Math.min(Math.abs(red1 - red0), 360 - Math.abs(red1 - red0));
  assert.ok(diff < 18, `red moved from ${red0} to ${red1}`);
  const [r, g, b] = im.at(300, 325);
  assert.ok(b > r && b > g, `link is no longer blue: ${[r, g, b]}`);
});

test('accents stay readable on the new background', () => {
  const im = geminiDark();
  m.convertPixels(im.data, im.w, im.h, { target: gemini.light, keepPhotos: true });
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const bg = hex(gemini.light.bg);
  assert.ok(contrast(im.at(300, 325), bg) >= 4.5, `blue link contrast ${contrast(im.at(300, 325), bg).toFixed(2)}`);
  assert.ok(contrast(im.at(600, 325), bg) >= 3, `red accent contrast ${contrast(im.at(600, 325), bg).toFixed(2)}`);
  assert.ok(contrast(im.at(300, 62), bg) >= 7, `text contrast ${contrast(im.at(300, 62), bg).toFixed(2)}`);
});

test('vivid logo colours stay vivid and pale accents become rich', () => {
  const im = geminiDark();
  im.fill(720, 20, 760, 60, [242, 80, 34]);   // A vivid logo red.
  m.convertPixels(im.data, im.w, im.h, { target: gemini.light, keepPhotos: true });
  const [lr, lg, lb] = im.at(740, 40);
  assert.ok(lr > 150 && lr > lg * 1.8 && lr > lb * 1.8, `logo red stays strong: ${[lr, lg, lb]}`);
  const [r, g, b] = im.at(300, 325);
  assert.ok(b - r > 80, `pale blue link becomes a rich blue: ${[r, g, b]}`);
});

test('a tinted dark theme lands on exact target colours', () => {
  const im = makeImage(400, 300, '#0d1117');   // GitHub's blue-leaning dark background.
  im.fill(0, 0, 100, 300, hex('#161b22'));
  for (let y = 30; y < 200; y += 20) im.fill(120, y, 380, y + 6, hex('#e6edf3'));
  const github = m.styleById('github');
  m.convertPixels(im.data, im.w, im.h, { target: github.light, keepPhotos: true });
  near(im.at(390, 290), hex(github.light.bg), 2, 'background');
  near(im.at(50, 100), hex(github.light.surface), 2, 'panel');
  near(im.at(200, 32), hex(github.light.text), 2, 'text');
});

test('photos stay untouched', () => {
  const original = geminiDark();
  const im = geminiDark();
  const a = m.convertPixels(im.data, im.w, im.h, { target: gemini.light, keepPhotos: true });
  assert.ok(a.photos.length >= 1, 'found the photo');
  for (const [x, y] of [[300, 450], [400, 500], [350, 420]]) near(im.at(x, y), original.at(x, y), 0, 'photo pixel');
});

test('background inside a photo box still converts, and rounded corners stay clean', () => {
  const im = makeImage(800, 600, '#131314');
  // A photo with rounded corners. The corner pixels are the background colour.
  for (let y = 100; y < 400; y++) for (let x = 100; x < 500; x++) {
    const cx = x < 120 ? 120 : x >= 480 ? 479 : x, cy = y < 120 ? 120 : y >= 380 ? 379 : y;
    if (Math.hypot(x - cx, y - cy) > 20) continue;
    const i = (y * 800 + x) * 4;
    const n = (x * 7 + y * 13) % 53;
    im.data[i] = 100 + n; im.data[i + 1] = 150 - n; im.data[i + 2] = 60 + n * 2;
  }
  const original = im.data.slice();
  const a = m.convertPixels(im.data, 800, 600, { target: gemini.light, keepPhotos: true });
  assert.ok(a.photos.length >= 1, 'found the photo');
  const px = (d, x, y) => [d[(y * 800 + x) * 4], d[(y * 800 + x) * 4 + 1], d[(y * 800 + x) * 4 + 2]];
  near(px(im.data, 102, 102), [255, 255, 255], 3, 'rounded corner turned light');
  near(px(im.data, 300, 250), px(original, 300, 250), 0, 'middle of the photo unchanged');
});

test('turning photo protection off converts them too', () => {
  const original = geminiDark();
  const im = geminiDark();
  m.convertPixels(im.data, im.w, im.h, { target: gemini.light, keepPhotos: false });
  let changed = 0;
  for (const [x, y] of [[300, 450], [400, 500], [350, 420]]) if (im.at(x, y).some((v, i) => v !== original.at(x, y)[i])) changed++;
  assert.ok(changed >= 2, 'photo pixels changed');
});

test('text-heavy screenshots are not mistaken for photos', () => {
  const im = makeImage(800, 600, '#131314');
  // Dense anti-aliased text: rows of mixed greys on a solid background.
  for (let y = 10; y < 590; y += 12) for (let x = 10; x < 790; x++) {
    if ((x * 3 + y) % 7 < 2) continue;
    const g = 40 + ((x * 11 + y * 5) % 190);
    im.fill(x, y, x + 1, y + 6, [g, g, g]);
  }
  const a = m.analyze(im.data, im.w, im.h);
  assert.equal(a.photos.length, 0, `found ${a.photos.length} photos in plain text`);
});

test('JPEG noise around text is not mistaken for a photo', () => {
  const im = makeImage(800, 600, '#131314');
  let seed = 7;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed % (2 * n + 1)) - n; };
  // Rows of text-like marks, with compression noise over the whole picture.
  for (let y = 20; y < 580; y += 16) for (let x = 20; x < 780; x += 3) if ((x * 7 + y) % 11 < 6) im.fill(x, y, x + 2, y + 9, [226, 226, 226]);
  for (let i = 0; i < im.data.length; i += 4) {
    const n = rnd(3);
    im.data[i] += n; im.data[i + 1] += n + rnd(1); im.data[i + 2] += n + rnd(1);
  }
  const a = m.analyze(im.data, im.w, im.h);
  assert.equal(a.photos.length, 0, `found ${JSON.stringify(a.photos)}`);
  assert.equal(a.isDark, true);
});

test('a real-looking photo with soft areas is still found', () => {
  const im = makeImage(800, 600, '#131314');
  for (let y = 200; y < 500; y++) for (let x = 200; x < 600; x++) {
    const i = (y * 800 + x) * 4;
    const n = ((x * 31 + y * 17) % 7) - 3;
    im.data[i] = 90 + x * 0.2 + n; im.data[i + 1] = 120 + y * 0.15 + n; im.data[i + 2] = 200 - y * 0.1 + n;
  }
  const a = m.analyze(im.data, im.w, im.h);
  assert.equal(a.photos.length, 1, `found ${JSON.stringify(a.photos)}`);
  const p = a.photos[0];
  assert.ok(p.x <= 208 && p.x + p.w >= 590 && p.y <= 208 && p.y + p.h >= 490, `box ${JSON.stringify(p)}`);
});

test('a soft interface glow is not a photo', () => {
  // Like Gemini's start page: a dark background with a big, smooth blue glow, slightly dithered.
  const im = makeImage(1280, 860, '#131314');
  let seed = 3;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % 2; };
  for (let y = 0; y < 860; y++) for (let x = 300; x < 1280; x++) {
    const d = Math.hypot((x - 800) / 500, (y - 520) / 380);
    const k = Math.max(0, 1 - d);
    const i = (y * 1280 + x) * 4;
    im.data[i] = 19 + k * 6 + rnd(); im.data[i + 1] = 19 + k * 22 + rnd(); im.data[i + 2] = 20 + k * 80 + rnd();
  }
  const a = m.convertPixels(im.data, 1280, 860, { target: gemini.light, keepPhotos: true });
  assert.equal(a.photos.length, 0, `found ${JSON.stringify(a.photos)}`);
  const [r, g, b] = im.at(800, 520);
  assert.ok(r > 170 && g > 170 && b > 200 && b >= r, `glow centre becomes a light tint: ${[r, g, b]}`);
});

test('anti-aliased text edges stay a clean blend', () => {
  const im = makeImage(100, 100, '#131314');
  // A blend halfway between background and text.
  const mid = [Math.round((0x13 + 0xe3) / 2), Math.round((0x13 + 0xe3) / 2), Math.round((0x14 + 0xe3) / 2)];
  im.fill(10, 10, 90, 12, hex('#e3e3e3'));
  im.fill(10, 20, 90, 22, mid);
  m.convertPixels(im.data, im.w, im.h, { target: gemini.light, keepPhotos: true });
  const got = im.at(50, 21);
  assert.ok(got[0] > 50 && got[0] < 230, `edge pixel should be mid grey, got ${got}`);
  assert.ok(Math.abs(got[0] - got[1]) < 12 && Math.abs(got[1] - got[2]) < 12, `edge pixel should stay neutral, got ${got}`);
});

test('light to dark works too', () => {
  const im = makeImage(400, 300, '#ffffff');
  im.fill(0, 0, 80, 300, hex('#f0f4f9'));
  for (let y = 30; y < 200; y += 20) im.fill(100, y, 350, y + 6, hex('#1f1f1f'));
  im.fill(100, 240, 300, 246, hex('#0b57d0'));
  m.convertPixels(im.data, im.w, im.h, { target: gemini.dark, keepPhotos: true });
  near(im.at(390, 290), hex(gemini.dark.bg), 2, 'background');
  near(im.at(40, 100), hex(gemini.dark.surface), 2, 'surface');
  near(im.at(200, 32), hex(gemini.dark.text), 2, 'text');
  const [r, g, b] = im.at(200, 243);
  assert.ok(b > r && b > g, `link is no longer blue: ${[r, g, b]}`);
  assert.ok(b > 150, `link is too dark on a dark page: ${[r, g, b]}`);
});

test('there and back returns close to the start', () => {
  const start = geminiDark();
  const im = geminiDark();
  m.convertPixels(im.data, im.w, im.h, { target: gemini.light, keepPhotos: true });
  m.convertPixels(im.data, im.w, im.h, { target: gemini.dark, keepPhotos: true });
  near(im.at(790, 10), start.at(790, 10), 3, 'background');
  near(im.at(50, 300), start.at(50, 300), 3, 'surface');
  near(im.at(300, 62), start.at(300, 62), 3, 'text');
});

test('transparent pixels stay transparent', () => {
  const im = makeImage(50, 50, '#131314');
  const i = (10 * 50 + 10) * 4;
  im.data[i + 3] = 0;
  m.convertPixels(im.data, im.w, im.h, { target: gemini.light, keepPhotos: true });
  assert.equal(im.data[i + 3], 0);
});

test('odd inputs do not throw', () => {
  for (const [w, h] of [[1, 1], [2, 1], [1, 300]]) {
    const im = makeImage(w, h, '#808080');
    m.convertPixels(im.data, w, h, { target: gemini.light, keepPhotos: true });
  }
  const empty = new Uint8ClampedArray(0);
  m.convertPixels(empty, 0, 0, { target: gemini.light, keepPhotos: true });
  const clear = new Uint8ClampedArray(40 * 40 * 4);
  m.convertPixels(clear, 40, 40, { target: gemini.dark, keepPhotos: true });
});

test('every style has distinct readable colours', () => {
  for (const s of m.THEME_STYLES) for (const p of [s.light, s.dark]) {
    assert.notEqual(p.bg, p.text);
    const [bg, tx] = [hex(p.bg), hex(p.text)];
    assert.ok(Math.abs(bg[0] - tx[0]) > 100, `${s.name} has low contrast`);
  }
});

test('speed: a 4K screenshot converts in under 3 seconds', () => {
  const w = 3840, h = 2160;
  const im = makeImage(w, h, '#131314');
  im.fill(0, 0, 500, h, hex('#1e1f20'));
  for (let y = 40; y < h - 40; y += 28) {
    for (let x = 560; x < w - 100; x += 1) {
      const v = (x * 13 + y) % 5 === 0 ? 0x13 : 0xe3;
      im.fill(x, y, x + 1, y + 14, [v, v, v]);
    }
  }
  const t0 = performance.now();
  m.convertPixels(im.data, w, h, { target: gemini.light, keepPhotos: true });
  const ms = performance.now() - t0;
  console.log(`        ${w}x${h}: ${Math.round(ms)} ms`);
  assert.ok(ms < 3000, `took ${Math.round(ms)} ms`);
});

console.log('Geometry');
test('viewport round trip at all rotations', () => {
  for (const rot of [0, 90, 180, 270]) {
    const vp = m.makeViewport([0, 0, 612, 792], rot, 1.5);
    for (const [x, y] of [[0, 0], [100, 200], [612, 792]]) {
      const s = m.toScreen(vp, x, y);
      const p = m.toPdf(vp, s[0], s[1]);
      near(p, [x, y], 0.0001, `rotation ${rot}`);
    }
  }
});

test('viewport size swaps when rotated', () => {
  const vp = m.makeViewport([0, 0, 612, 792], 90, 1);
  assert.equal(vp.width, 792);
  assert.equal(vp.height, 612);
});

test('simplify keeps the ends and drops straight points', () => {
  const p = [];
  for (let i = 0; i <= 100; i++) p.push(i, 0);
  const s = m.simplify(p, 0.3);
  assert.equal(s.length, 4);
  assert.deepEqual(s, [0, 0, 100, 0]);
});

test('resizing scales points with the box', () => {
  const a = { kind: 'line', rect: [0, 0, 10, 10], pts: [0, 0, 10, 10], color: '#000', opacity: 1, width: 1, id: 'a' };
  const b = m.remapAnnot(a, [0, 0, 10, 10], [10, 10, 30, 30]);
  assert.deepEqual(b.pts, [10, 10, 30, 30]);
  assert.deepEqual(b.rect, [10, 10, 30, 30]);
});

test('measurements use the scale', () => {
  const a = { kind: 'measure', measureType: 'distance', pts: [0, 0, 72, 0], measureScale: 1 / 72, measureUnit: 'in', rect: [0, 0, 72, 0] };
  assert.equal(m.measureLabel(a), '1.00 in');
  const b = { kind: 'measure', measureType: 'area', pts: [0, 0, 72, 0, 72, 72, 0, 72], measureScale: 1 / 72, measureUnit: 'in', rect: [0, 0, 72, 72] };
  assert.equal(m.measureLabel(b), '1.00 in²');
});

await rm(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
