// Choices that stay between sessions. Stored on this PC only.

const KEY = 'pdfy.settings';

export interface Settings {
  author: string;
  reopenAtLastPage: boolean;
  /** Double-clicking or selecting a word opens the dictionary. */
  lookup: boolean;
  /** Look of new Markdown boxes. */
  mdTheme: string;
  /** Language for reading text out of pictures. */
  ocrLang: string;
  /** The preference set last applied. */
  prefSet: string;
}

const DEFAULTS: Settings = { author: 'PDFy user', reopenAtLastPage: true, lookup: false, mdTheme: 'obsidian-light', ocrLang: 'eng', prefSet: '' };

export function getSettings(): Settings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; }
  catch { return { ...DEFAULTS }; }
}

export function saveSettings(patch: Partial<Settings>) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...getSettings(), ...patch })); } catch { /* Storage may be off. */ }
}

const POSITIONS = 'pdfy.positions';
const MAX_POSITIONS = 200;

/** Where each document was left, so it reopens at the same page. */
export function lastPage(key: string): number {
  try { return JSON.parse(localStorage.getItem(POSITIONS) ?? '{}')[key] ?? 0; }
  catch { return 0; }
}

export function rememberPage(key: string, page: number) {
  try {
    const all: Record<string, number> = JSON.parse(localStorage.getItem(POSITIONS) ?? '{}');
    delete all[key];
    all[key] = page;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_POSITIONS))) delete all[k];
    localStorage.setItem(POSITIONS, JSON.stringify(all));
  } catch { /* Not important enough to bother anyone. */ }
}
