// Every font on this PC, plus any added from a file. Added fonts are kept in a small local database, so
// they are still there next time and work in saved files on any computer, because PDFy embeds them.

const FAV = 'pdfy.fontFavourites';
const RECENT = 'pdfy.fontRecent';
const DB = 'pdfy-fonts';
const STORE = 'files';

/** Good starting choices. Only the ones actually installed are shown. */
export const RECOMMENDED_FONTS = ['Segoe UI', 'Calibri', 'Cambria', 'Georgia', 'Arial', 'Times New Roman', 'Consolas', 'Sakkal Majalla', 'Dubai', 'Traditional Arabic', 'Tahoma'];

/** The three built into every PDF, which keep files smallest. */
export const STANDARD_FONTS = [
  { id: 'helvetica' as const, label: 'Standard sans (smallest file)' },
  { id: 'times' as const, label: 'Standard serif (smallest file)' },
  { id: 'courier' as const, label: 'Standard mono (smallest file)' },
];

/** Font names can come from a saved file, so only letters, digits, spaces and a few marks get through. */
export const safeFontName = (name: string) => name.replace(/[^\p{L}\p{N} ._&+-]/gu, '').trim().slice(0, 80);

export const fontCss = (name: string) => `'${safeFontName(name)}', 'Segoe UI', Tahoma, sans-serif`;

function readList(key: string): string[] {
  try { return JSON.parse(localStorage.getItem(key) ?? '[]') as string[]; } catch { return []; }
}
function writeList(key: string, v: string[]) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* Storage may be off. */ }
}

export const favouriteFonts = () => readList(FAV);
export const recentFonts = () => readList(RECENT);

export function toggleFavouriteFont(name: string): boolean {
  const list = favouriteFonts();
  const on = !list.includes(name);
  writeList(FAV, on ? [name, ...list] : list.filter(x => x !== name));
  return on;
}

export function touchRecentFont(name: string) {
  writeList(RECENT, [name, ...recentFonts().filter(x => x !== name)].slice(0, 8));
}

// ---- What is installed ----

let installed: Promise<string[]> | null = null;
let hostReply: ((names: string[]) => void) | null = null;

/** Called with messages from the Windows app. */
export function onFontMessage(data: { type?: string; names?: string[] }) {
  if (data.type === 'font-list' && data.names) hostReply?.(data.names);
}

const FALLBACK = ['Arial', 'Calibri', 'Cambria', 'Consolas', 'Courier New', 'Georgia', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Verdana'];

export function installedFonts(): Promise<string[]> {
  if (installed) return installed;
  installed = (async () => {
    const webview = window.chrome?.webview;
    if (webview) {
      const names = await new Promise<string[]>(res => {
        hostReply = res;
        webview.postMessage({ type: 'font-list' });
        setTimeout(() => res(FALLBACK), 4000);
      });
      hostReply = null;
      return names;
    }
    // Outside the app, such as during testing, the browser may or may not be allowed to list them.
    const query = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
    if (query) {
      try {
        const all = await query();
        if (all.length) return [...new Set(all.map(f => f.family))].sort((a, b) => a.localeCompare(b));
      } catch { /* Not allowed. */ }
    }
    return FALLBACK;
  })();
  return installed;
}

// ---- Added from files ----

interface StoredFont { family: string; file: string; bytes: ArrayBuffer }

function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'family' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

const added = new Map<string, ArrayBuffer>();

export const addedFontNames = () => [...added.keys()].sort((a, b) => a.localeCompare(b));

/** Brings added fonts back at start. Costs nothing if there are none. */
export async function restoreAddedFonts() {
  try {
    const d = await db();
    const all = await new Promise<StoredFont[]>((res, rej) => {
      const r = d.transaction(STORE).objectStore(STORE).getAll();
      r.onsuccess = () => res(r.result as StoredFont[]);
      r.onerror = () => rej(r.error);
    });
    d.close();
    for (const f of all) await register(f.family, f.bytes);
  } catch (err) {
    console.warn('Added fonts could not be restored', err);
  }
}

async function register(family: string, bytes: ArrayBuffer) {
  const face = new FontFace(family, bytes);
  await face.load();
  document.fonts.add(face);
  added.set(family, bytes);
}

/** The family name inside a font file, read from its name table. Null for compressed web fonts. */
export function familyNameOf(bytes: ArrayBuffer): string | null {
  try {
    const v = new DataView(bytes);
    const sig = v.getUint32(0);
    if (sig !== 0x00010000 && sig !== 0x4f54544f && sig !== 0x74727565) return null;
    const count = v.getUint16(4);
    for (let i = 0; i < count; i++) {
      const at = 12 + i * 16;
      if (String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3)) !== 'name') continue;
      const base = v.getUint32(at + 8);
      const n = v.getUint16(base + 2), strings = base + v.getUint16(base + 4);
      let best: string | null = null;
      for (let j = 0; j < n; j++) {
        const r = base + 6 + j * 12;
        const platform = v.getUint16(r), lang = v.getUint16(r + 4), id = v.getUint16(r + 6), len = v.getUint16(r + 8), off = v.getUint16(r + 10);
        if (id !== 1 && id !== 16) continue;
        let s = '';
        if (platform === 3 || platform === 0) {
          for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(v.getUint16(strings + off + k));
        } else {
          for (let k = 0; k < len; k++) s += String.fromCharCode(v.getUint8(strings + off + k));
        }
        if (id === 16 && s) return s; // The "typographic family" is the cleanest name.
        if (!best || (platform === 3 && lang === 0x409)) best = s || best;
      }
      return best;
    }
  } catch { /* Not a font we can read. */ }
  return null;
}

/** Adds fonts from files. Returns the names added, and throws only if none worked. */
export async function addFontFiles(files: File[]): Promise<string[]> {
  const names: string[] = [];
  let failure: Error | null = null;
  for (const file of files) {
    try {
      const bytes = await file.arrayBuffer();
      const family = safeFontName(familyNameOf(bytes) ?? file.name.replace(/\.[^.]+$/, '')) || 'Added font';
      await register(family, bytes);
      const d = await db();
      await new Promise<void>((res, rej) => {
        const tx = d.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ family, file: file.name, bytes } satisfies StoredFont);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      d.close();
      names.push(family);
    } catch (err) {
      failure = err as Error;
      console.warn('Font file', file.name, err);
    }
  }
  if (!names.length && failure) throw new Error('That file is not a font PDFy can read.');
  return names;
}

function toBase64(bytes: ArrayBuffer): string {
  const u = new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < u.length; i += 32768) out += String.fromCharCode(...u.subarray(i, i + 32768));
  return btoa(out);
}

/** Added fonts spelled out in full, because the print engine has no other way to see them. */
export async function fontFaceCss(names: string[]): Promise<string> {
  let css = '';
  for (const n of new Set(names)) {
    const b = added.get(n);
    if (b) css += `@font-face{font-family:'${safeFontName(n)}';src:url(data:font/ttf;base64,${toBase64(b)});font-display:block}`;
  }
  return css;
}
