// Run: node scripts/check-themes.mjs (Node 22.18+; native TypeScript support, no packages).
import { readFileSync } from 'node:fs';
import { BUILT_IN_THEMES } from '../src/study/mdthemes.ts';
import { UI_THEMES } from '../src/ui/themes.ts';

const css = readFileSync(new URL('../public/themes.css', import.meta.url), 'utf8');
const required = [
  'bg', 'surface', 'surface-2', 'surface-3', 'border', 'text', 'muted',
  'accent', 'accent-ink', 'accent-soft', 'accent-text', 'focus',
  'chrome', 'chrome-2', 'chrome-text', 'chrome-muted', 'chrome-hover', 'chrome-active', 'chrome-border', 'tab-active',
  'canvas-bg', 'page-shadow', 'shadow', 'ok', 'warn', 'danger',
];
const palettes = new Map();
for (const [, id, body] of css.matchAll(/\[data-ui-theme="([^"]+)"\]\s*\{([^}]+)\}/g)) {
  if (palettes.has(id)) throw new Error(`Duplicate UI theme: ${id}`);
  const values = Object.fromEntries([...body.matchAll(/(--[\w-]+|color-scheme):\s*([^;]+);/g)]
    .map(([, key, value]) => [key.replace(/^--/, ''), value.trim()]));
  for (const key of required) {
    if (!values[key]) throw new Error(`${id}: missing --${key}`);
    if (!['page-shadow', 'shadow'].includes(key)) luminance(values[key]);
  }
  palettes.set(id, values);
}
if (palettes.size !== UI_THEMES.length) throw new Error('CSS and picker theme counts differ.');

function luminance(hex) {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error(`Expected an opaque #rrggbb colour, got ${hex}`);
  const [r, g, b] = hex.slice(1).match(/../g).map(channel => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

let count = 0;
let failures = 0;
let lowest = { ratio: Infinity, label: '' };
function check(label, foreground, background, minimum = 4.5) {
  const a = luminance(foreground), b = luminance(background);
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const pass = ratio >= minimum; // Compare full precision; rounding must never hide a failure.
  count++;
  if (!pass) failures++;
  if (ratio < lowest.ratio) lowest = { ratio, label };
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: ${ratio.toFixed(3)}:1 (min ${minimum}:1)`);
}

for (const theme of UI_THEMES) {
  const p = palettes.get(theme.id);
  if (!p) throw new Error(`Missing CSS for ${theme.id}`);
  if (p['color-scheme'] !== (theme.dark ? 'dark' : 'light')) throw new Error(`${theme.id}: wrong color-scheme`);
  if (theme.swatch.some((colour, i) => colour !== p[['chrome', 'canvas-bg', 'accent'][i]])) {
    throw new Error(`${theme.id}: picker swatches do not match CSS`);
  }
  console.log(`\nUI: ${theme.name}`);
  // Include selected and hover backgrounds as well as the required resting surfaces.
  for (const bg of ['surface', 'bg', 'surface-2', 'surface-3', 'accent-soft']) {
    for (const fg of ['text', 'muted']) check(`${theme.id} ${fg} / ${bg}`, p[fg], p[bg]);
  }
  for (const bg of ['chrome', 'chrome-2', 'chrome-hover', 'chrome-active', 'tab-active']) {
    check(`${theme.id} chrome-text / ${bg}`, p['chrome-text'], p[bg]);
    check(`${theme.id} chrome-muted / ${bg}`, p['chrome-muted'], p[bg]);
  }
  check(`${theme.id} accent-ink / accent`, p['accent-ink'], p.accent);
  for (const bg of ['surface', 'surface-2', 'surface-3', 'accent-soft']) {
    check(`${theme.id} accent-text / ${bg}`, p['accent-text'], p[bg]);
  }
  for (const fg of ['ok', 'warn', 'danger']) check(`${theme.id} ${fg} / surface`, p[fg], p.surface);
  for (const bg of ['surface', 'surface-2', 'surface-3', 'accent-soft', 'chrome', 'chrome-hover', 'chrome-active', 'tab-active']) {
    check(`${theme.id} focus / ${bg}`, p.focus, p[bg], 3);
  }
}

for (const theme of BUILT_IN_THEMES) {
  // Transparent notes sit on white PDF pages; dark notes keep their solid card.
  const background = theme.showBackground ? theme.background : '#ffffff';
  console.log(`\nNote: ${theme.name} (${theme.id})`);
  for (const fg of ['text', 'heading', 'link', 'strong', 'quoteText', 'accent']) {
    check(`${theme.id} ${fg} / background`, theme[fg], background);
  }
  check(`${theme.id} codeFg / codeBg`, theme.codeFg, theme.codeBg);
  check(`${theme.id} text / codeBg (table headers)`, theme.text, theme.codeBg);
  check(`${theme.id} accent / codeBg (code keywords)`, theme.accent, theme.codeBg);
  check(`${theme.id} markFg / markBg`, theme.markFg, theme.markBg);
}

console.log(`\n${UI_THEMES.length} UI themes, ${BUILT_IN_THEMES.length} note themes; ${count} pairs; ${failures} failures.`);
console.log(`Lowest contrast: ${lowest.ratio.toFixed(3)}:1 (${lowest.label}).`);
process.exitCode = failures ? 1 : 0;
