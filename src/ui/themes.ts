export const DEFAULT_DARK = 'slate';
export const DEFAULT_LIGHT = 'daylight';

export interface UiTheme { id: string; name: string; dark: boolean; swatch: [string, string, string]; custom?: CustomBase }

/** Picker swatches: chrome, canvas, accent. Keep in sync with public/themes.css. */
export const UI_THEMES: UiTheme[] = [
  { id: 'slate', name: 'Slate', dark: true, swatch: ['#2b3037', '#414955', '#79b7ef'] },
  { id: 'midnight', name: 'Midnight', dark: true, swatch: ['#1a2035', '#292f48', '#a89aff'] },
  { id: 'mocha', name: 'Mocha', dark: true, swatch: ['#302838', '#443a4d', '#e4a9dd'] },
  { id: 'dracula', name: 'Dracula', dark: true, swatch: ['#241f30', '#393245', '#f18fca'] },
  { id: 'nord', name: 'Nord', dark: true, swatch: ['#304054', '#435367', '#9ad8e1'] },
  { id: 'forest', name: 'Forest', dark: true, swatch: ['#173d2e', '#285343', '#e0f36a'] },
  { id: 'ember', name: 'Ember', dark: true, swatch: ['#332b26', '#4c4138', '#ffb273'] },
  { id: 'daylight', name: 'Daylight', dark: false, swatch: ['#535d6c', '#a7b1c0', '#285fb9'] },
  { id: 'paper', name: 'Paper', dark: false, swatch: ['#675743', '#b9a88c', '#80502f'] },
];

const KEY = 'pdfy.uiTheme';
const CUSTOM_KEY = 'pdfy.customUiThemes';

// ---- Your own themes, made from five colours ----

/** The five colours a person chooses. Every other shade is worked out from them. */
export interface CustomBase { chrome: string; surface: string; canvas: string; text: string; accent: string }

interface StoredCustom { id: string; name: string; base: CustomBase }

function storedCustom(): StoredCustom[] {
  try { return JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '[]') as StoredCustom[]; } catch { return []; }
}

const rgb = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const v = m ? parseInt(m[1], 16) : 0x808080;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
const toHex = (c: number[]) => `#${c.map(x => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('')}`;
/** Mixes a toward b: 0 keeps a, 1 gives b. */
export const mix = (a: string, b: string, t: number) => { const x = rgb(a), y = rgb(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); };
export function luminance(hex: string): number {
  const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = rgb(hex);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export const contrast = (a: string, b: string) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const inkFor = (bg: string) => (contrast(bg, '#ffffff') >= contrast(bg, '#111111') ? '#ffffff' : '#111111');

/** All the colours a theme needs, worked out from the five chosen ones. */
export function deriveVars(b: CustomBase): Record<string, string> {
  const dark = luminance(b.surface) < 0.3;
  const chromeText = inkFor(b.chrome) === '#ffffff' ? mix(b.chrome, '#ffffff', 0.92) : mix(b.chrome, '#000000', 0.88);
  const shade = dark ? '10 14 22' : '20 24 32';
  return {
    'color-scheme': dark ? 'dark' : 'light',
    '--bg': mix(b.surface, dark ? '#000000' : '#ffffff', dark ? 0.22 : 0.35),
    '--surface': b.surface,
    '--surface-2': mix(b.surface, b.text, 0.07),
    '--surface-3': mix(b.surface, b.text, 0.13),
    '--border': mix(b.surface, b.text, 0.22),
    '--text': b.text,
    '--muted': mix(b.text, b.surface, 0.3),
    '--accent': b.accent,
    '--accent-ink': inkFor(b.accent),
    '--accent-soft': mix(b.surface, b.accent, 0.2),
    '--accent-text': contrast(b.accent, b.surface) >= 4.5 ? b.accent : mix(b.accent, dark ? '#ffffff' : '#000000', 0.45),
    '--chrome': b.chrome,
    '--chrome-2': mix(b.chrome, '#000000', 0.18),
    '--chrome-text': chromeText,
    '--chrome-muted': mix(chromeText, b.chrome, 0.28),
    '--chrome-hover': mix(b.chrome, chromeText, 0.12),
    '--chrome-active': mix(b.chrome, b.accent, 0.32),
    '--chrome-border': mix(b.chrome, chromeText, 0.2),
    '--tab-active': mix(b.chrome, chromeText, 0.1),
    '--canvas-bg': b.canvas,
    '--page-shadow': `0 2px 5px rgb(${shade} / 0.28), 0 12px 30px rgb(${shade} / 0.32)`,
    '--shadow': `0 3px 8px rgb(${shade} / 0.22), 0 16px 40px rgb(${shade} / 0.34)`,
    '--ok': dark ? '#8ed3a8' : '#16794a',
    '--warn': dark ? '#f1c878' : '#9a5b00',
    '--danger': dark ? '#ff9d9b' : '#b42318',
  };
}

export function customUiThemes(): UiTheme[] {
  return storedCustom().map(c => ({ id: c.id, name: c.name, dark: luminance(c.base.surface) < 0.3, swatch: [c.base.chrome, c.base.canvas, c.base.accent], custom: c.base }));
}

export const allUiThemes = (): UiTheme[] => [...UI_THEMES, ...customUiThemes()];

/** Writes the colours of your own themes into the page, so they work like the built-in ones. */
export function ensureCustomThemeCss() {
  let el = document.getElementById('pdfy-custom-themes') as HTMLStyleElement | null;
  if (!el) { el = document.createElement('style'); el.id = 'pdfy-custom-themes'; document.head.append(el); }
  el.textContent = storedCustom().map(c => {
    const vars = deriveVars(c.base);
    return `:is(:root, .theme-scope)[data-ui-theme="${c.id}"] { ${Object.entries(vars).map(([k, v]) => `${k}: ${v};`).join(' ')} }`;
  }).join('\n');
}

export function saveCustomUiTheme(theme: { id?: string; name: string; base: CustomBase }): string {
  const list = storedCustom();
  const id = theme.id ?? `custom-${Date.now().toString(36)}`;
  const at = list.findIndex(c => c.id === id);
  const entry = { id, name: theme.name.trim() || 'My theme', base: theme.base };
  if (at >= 0) list[at] = entry; else list.push(entry);
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(list)); } catch { /* Storage may be off. */ }
  ensureCustomThemeCss();
  return id;
}

export function deleteCustomUiTheme(id: string) {
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(storedCustom().filter(c => c.id !== id))); } catch { /* Storage may be off. */ }
  ensureCustomThemeCss();
  if (currentUiTheme() === id) applyUiTheme(DEFAULT_DARK);
}

/** Unknown ids use Slate. Applying a palette also updates the legacy dark/light flag. */
export function applyUiTheme(id: string): void {
  ensureCustomThemeCss();
  const theme = allUiThemes().find(t => t.id === id) ?? UI_THEMES[0];
  document.documentElement.dataset.uiTheme = theme.id;
  document.documentElement.dataset.theme = theme.dark ? 'dark' : 'light';
  try { localStorage.setItem(KEY, theme.id); } catch { /* Storage may be off. */ }
  // The window's own thin top edge and loading colour follow the header.
  const chrome = theme.swatch[0];
  try { window.chrome?.webview?.postMessage({ type: 'win-color', color: chrome }); } catch { /* Not in the desktop app. */ }
}

/** Resolve stored ids, migrating the old dark/light setting to its default palette. */
export function currentUiTheme(): string {
  let saved: string | null = null;
  try { saved = localStorage.getItem(KEY); } catch { /* Storage may be off. */ }
  if (saved === 'dark' || saved === 'light') {
    const id = saved === 'dark' ? DEFAULT_DARK : DEFAULT_LIGHT;
    try { localStorage.setItem(KEY, id); } catch { /* Storage may be off. */ }
    return id;
  }
  if (saved) return allUiThemes().some(t => t.id === saved) ? saved : DEFAULT_DARK;
  return matchMedia('(prefers-color-scheme: dark)').matches ? DEFAULT_DARK : DEFAULT_LIGHT;
}
