export const DEFAULT_DARK = 'slate';
export const DEFAULT_LIGHT = 'daylight';

/** Picker swatches: chrome, canvas, accent. Keep in sync with public/themes.css. */
export const UI_THEMES: { id: string; name: string; dark: boolean; swatch: [string, string, string] }[] = [
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

/** Unknown ids use Slate. Applying a palette also updates the legacy dark/light flag. */
export function applyUiTheme(id: string): void {
  const theme = UI_THEMES.find(t => t.id === id) ?? UI_THEMES[0];
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
  if (saved) return UI_THEMES.some(t => t.id === saved) ? saved : DEFAULT_DARK;
  return matchMedia('(prefers-color-scheme: dark)').matches ? DEFAULT_DARK : DEFAULT_LIGHT;
}
