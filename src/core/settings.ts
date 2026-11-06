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
  /** Read the Cambridge, Oxford and Longman pages for a looked-up word. */
  onlineDict: boolean;
  /** The dictionary tab shown first. */
  dictTab: 'quick' | 'cambridge' | 'oxford' | 'longman';
  /** The dictionary stays open at the side of the window. */
  dictDocked: boolean;
  /** What the Pages button opens: the full-screen page editor or the narrow side list. */
  pagesView: 'editor' | 'sidebar';
  /** Size of the page pictures in the page editor, in pixels wide. */
  editorThumb: number;
  /** Pen and tablet. */
  pen: PenSettings;
  /** The mouse wheel zooms without holding Ctrl. */
  wheelZooms: boolean;
  /** The last guide version shown, so the guide appears once after each update. */
  guideSeen: string;
}

export interface PenSettings {
  /** Who can draw: everything, or only a pen, so fingers and the mouse move the page. */
  drawWith: 'any' | 'pen';
  /** The pointer over the page while a drawing tool is chosen. */
  cursor: 'cross' | 'dot' | 'size' | 'arrow' | 'none';
  /** How much strokes are smoothed. */
  smoothing: 'off' | 'light' | 'strong';
  /** What the button on the side of the pen does while held. */
  sideButton: 'menu' | 'eraser' | 'select' | 'pan';
  /** The back end of the pen erases. */
  tailErases: boolean;
  /** Touching the page with the pen starts inking straight away, even in Read mode. */
  autoInk: boolean;
}

export const DEFAULT_PEN: PenSettings = { drawWith: 'any', cursor: 'dot', smoothing: 'light', sideButton: 'eraser', tailErases: true, autoInk: false };

const DEFAULTS: Settings = {
  author: 'PDFy user', reopenAtLastPage: true, lookup: false, mdTheme: 'obsidian-light', ocrLang: 'eng', prefSet: '', onlineDict: true, dictTab: 'cambridge', dictDocked: false,
  pagesView: 'editor', editorThumb: 200, pen: DEFAULT_PEN, wheelZooms: false, guideSeen: '',
};

// Read on every pointer move while drawing, so the parsed copy is kept until the stored text changes.
let cached: { raw: string | null; value: Settings } | null = null;

export function getSettings(): Settings {
  let raw: string | null = null;
  try { raw = localStorage.getItem(KEY); } catch { /* Storage may be off. */ }
  if (cached && cached.raw === raw) return cached.value;
  let value: Settings;
  try {
    const saved = JSON.parse(raw ?? '{}') as Partial<Settings>;
    value = { ...DEFAULTS, ...saved, pen: { ...DEFAULT_PEN, ...(saved.pen ?? {}) } };
  } catch { value = { ...DEFAULTS }; }
  cached = { raw, value };
  return value;
}

const listeners = new Set<(s: Settings) => void>();
/** Called after any setting changes, so screens can follow. */
export function onSettings(fn: (s: Settings) => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

export function saveSettings(patch: Partial<Settings>) {
  const next = { ...getSettings(), ...patch };
  if (patch.pen) next.pen = { ...getSettings().pen, ...patch.pen };
  const raw = JSON.stringify(next);
  cached = { raw, value: next };
  try { localStorage.setItem(KEY, raw); } catch { /* Storage may be off. */ }
  for (const fn of listeners) { try { fn(next); } catch (err) { console.warn('Settings listener', err); } }
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
