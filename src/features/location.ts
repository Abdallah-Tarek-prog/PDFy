// Where an open file lives on disk. A web page never sees full paths, so in the Windows app PDFy's own
// Open and Save windows report the path of each file they hand over, "Open with" says which file it
// opened, and a dropped or pasted file is located from the very file the page passes over. Each file and
// its path are kept, so the path can still be copied after a restart. A file is only ever matched by
// asking the browser whether two handles are the same file, never by its name or by searching.

import { toast } from '../ui/dom';

export interface Located {
  ok: boolean;
  path?: string;
  error?: 'missing' | 'unsupported' | 'unknown' | 'different' | 'cancelled' | 'timeout' | 'failed';
  handle?: FileSystemFileHandle;
}

interface Reply { type?: string; id?: number; ok?: boolean; path?: unknown; paths?: unknown; error?: string }
interface Place { key: string; path: string; handle: FileSystemFileHandle; at: number }
interface PickerOptions { multiple?: boolean; types?: FilePickerType[]; excludeAcceptAllOption?: boolean; suggestedName?: string }

const DB = 'pdfy-locations';
const STORE = 'places';
const LIMIT = 2000;

const waiting = new Map<number, (m: Reply, objects: unknown[]) => void>();
let nextId = 0;
let places: Promise<Map<string, Place>> | null = null;
const pending = new Set<Promise<unknown>>();

/** The PDFy Windows app, not a plain browser. */
export const isDesktop = () => typeof window.chrome?.webview?.postMessageWithAdditionalObjects === 'function';

const isPath = (p: unknown): p is string => typeof p === 'string' && p.length < 32768 && !p.includes('\0') && /^(?:[A-Za-z]:\\|\\\\[^\\])/.test(p);
const baseOf = (path: string) => path.slice(path.lastIndexOf('\\') + 1);

/** Replies from the Windows app. Other messages are ignored. */
export function onLocationMessage(data: unknown, objects?: unknown[]) {
  const m = data as Reply | null;
  if (!['file-location', 'file-picker', 'file-access'].includes(m?.type ?? '') || typeof m?.id !== 'number') return;
  waiting.get(m.id)?.(m, objects ?? []);
}

/** One request to the Windows app and its reply. No time limit while a file window may be open. */
function ask(message: Record<string, unknown>, objects: unknown[] | null, timeout = 0): Promise<{ m: Reply; objects: unknown[] }> {
  const view = window.chrome!.webview!;
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    let timer = 0;
    waiting.set(id, (m, got) => { clearTimeout(timer); waiting.delete(id); resolve({ m, objects: got }); });
    if (timeout) timer = window.setTimeout(() => { waiting.delete(id); reject(new DOMException('Meletiq PDF did not answer in time.', 'TimeoutError')); }, timeout);
    try {
      if (objects) view.postMessageWithAdditionalObjects!({ ...message, id }, objects);
      else view.postMessage({ ...message, id });
    } catch (err) {
      clearTimeout(timer);
      waiting.delete(id);
      reject(err);
    }
  });
}

/** Lets a lookup wait for locations still being written down, for example right after a drop. */
function track<T>(job: Promise<T>): Promise<T> {
  const settled = job.catch(() => undefined);
  pending.add(settled);
  void settled.finally(() => pending.delete(settled));
  return job;
}

// ---- The kept locations ----

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'key' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function load(): Promise<Map<string, Place>> {
  places ??= (async () => {
    const map = new Map<string, Place>();
    try {
      const db = await openDb();
      try {
        const all = await new Promise<Place[]>((resolve, reject) => {
          const req = db.transaction(STORE).objectStore(STORE).getAll();
          req.onsuccess = () => resolve(req.result as Place[]);
          req.onerror = () => reject(req.error);
        });
        for (const p of all) if (p && typeof p.key === 'string' && isPath(p.path) && p.handle?.kind === 'file') map.set(p.key, p);
      } finally { db.close(); }
    } catch (err) {
      console.warn('Kept file locations could not be read', err);
    }
    return map;
  })();
  return places;
}

async function write(change: (store: IDBObjectStore) => void) {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      change(tx.objectStore(STORE));
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

/** Keeps a file's path with its handle. One record per path; the oldest are dropped past the limit. */
export function rememberLocation(handle: FileSystemFileHandle, path: string): Promise<void> {
  if (handle?.kind !== 'file' || !isPath(path) || baseOf(path).toLowerCase() !== handle.name.toLowerCase()) return Promise.resolve();
  return track((async () => {
    const map = await load();
    const place: Place = { key: path.toLowerCase(), path, handle, at: Date.now() };
    map.set(place.key, place);
    const old = map.size > LIMIT ? [...map.values()].sort((a, b) => a.at - b.at).slice(0, map.size - LIMIT) : [];
    for (const o of old) map.delete(o.key);
    await write(store => {
      store.put(place);
      for (const o of old) store.delete(o.key);
    });
  })().catch(err => console.warn('A file location could not be kept', err)));
}

/** The kept path of this very file, if PDFy has seen where it is. */
async function knownPath(handle: FileSystemFileHandle): Promise<string | null> {
  await Promise.all(pending);
  const name = handle.name.toLowerCase();
  for (const p of (await load()).values()) {
    // Only records with the same name can be the same file; the browser decides whether it is.
    if (baseOf(p.path).toLowerCase() !== name) continue;
    if (p.handle === handle || await p.handle.isSameEntry(handle).catch(() => false)) return p.path;
  }
  return null;
}

/** Restored native handles lose browser permission; renew only a file previously granted to PDFy. */
export async function readableHandle(handle: FileSystemFileHandle): Promise<FileSystemFileHandle | null> {
  if (!handle.queryPermission) return handle;
  try { if (await handle.queryPermission({ mode: 'read' }) === 'granted') return handle; } catch { /* Try native renewal. */ }
  if (isDesktop()) {
    const path = await knownPath(handle);
    if (path) {
      try {
        const { m, objects } = await ask({ type: 'file-access', path }, null, 10000);
        const fresh = objects[0] as FileSystemFileHandle | undefined;
        if (m.ok && m.path === path && fresh?.kind === 'file' && await fresh.isSameEntry(handle)) {
          await rememberLocation(fresh, path);
          return fresh;
        }
      } catch { /* The caller keeps the entry if access cannot be renewed. */ }
    }
    // A link created before locations were recorded needs one explicit choice of the original file.
    toast(`Choose “${handle.name}” once to restore its file link.`, 'info', 6000);
    const picked = await confirmSameFile(handle);
    return picked.ok ? picked.handle ?? null : null;
  }
  try { return await handle.requestPermission?.({ mode: 'read' }) === 'granted' ? handle : null; }
  catch { return null; }
}

// ---- Finding a file's path ----

/** A file with a handle: its kept path, checked to still be there. */
export async function locateHandle(handle: FileSystemFileHandle): Promise<Located> {
  const path = await knownPath(handle);
  if (!path) return { ok: false, error: isDesktop() ? 'unknown' : 'unsupported' };
  try { await handle.getFile(); }
  catch (err) { if ((err as Error).name === 'NotFoundError') return { ok: false, error: 'missing' }; }
  return { ok: true, path, handle };
}

/** A dropped or pasted file: the Windows app reads its path from the file itself and hands back a fresh handle. */
export function locateFile(file: File): Promise<Located> {
  if (!isDesktop()) return Promise.resolve({ ok: false, error: 'unsupported' });
  return track((async (): Promise<Located> => {
    let reply: { m: Reply; objects: unknown[] };
    // Throws for a file that is not on disk, such as one made by the page.
    try { reply = await ask({ type: 'file-location' }, [file], 10000); }
    catch (err) { return { ok: false, error: (err as Error).name === 'TimeoutError' ? 'timeout' : 'unsupported' }; }
    const { m, objects } = reply;
    const handle = objects[0] as FileSystemFileHandle | undefined;
    if (!m.ok || !isPath(m.path) || handle?.kind !== 'file') {
      return { ok: false, error: m.error === 'missing' || m.error === 'unsupported' ? m.error : 'failed' };
    }
    await rememberLocation(handle, m.path);
    return { ok: true, path: m.path, handle };
  })());
}

/**
 * A file opened before PDFy kept locations: the user picks it once in the Windows Open window. Only the
 * very same file counts; anything else changes nothing.
 */
export async function confirmSameFile(original: FileSystemFileHandle): Promise<Located> {
  if (!isDesktop()) return { ok: false, error: 'unsupported' };
  const ext = /\.[A-Za-z0-9_+-]{1,16}$/.exec(original.name)?.[0];
  let picked: { handles: FileSystemFileHandle[]; paths: string[] };
  try {
    picked = await pick('open', { multiple: false, suggestedName: original.name, types: ext ? [{ description: original.name, accept: { 'application/octet-stream': [ext] } }] : [] });
  } catch (err) {
    return { ok: false, error: (err as Error).name === 'AbortError' ? 'cancelled' : 'failed' };
  }
  const [handle] = picked.handles, [path] = picked.paths;
  if (!await handle.isSameEntry(original).catch(() => false)) return { ok: false, error: 'different' };
  await rememberLocation(handle, path);
  return { ok: true, path, handle };
}

// ---- Windows' own Open and Save windows ----

/** Shows the Windows file window and returns the chosen files' handles with their paths. */
async function pick(kind: 'open' | 'save', o: PickerOptions): Promise<{ handles: FileSystemFileHandle[]; paths: string[] }> {
  const types = (Array.isArray(o.types) ? o.types : []).slice(0, 20).map(t => ({
    description: typeof t?.description === 'string' ? t.description.slice(0, 100) : '',
    extensions: Object.values((t?.accept ?? {}) as Record<string, unknown>).flatMap(v => Array.isArray(v) ? v as unknown[] : [v])
      .filter((e): e is string => typeof e === 'string' && /^\.[A-Za-z0-9_+-]{1,16}$/.test(e)).slice(0, 30),
  })).filter(t => t.extensions.length);
  const { m, objects } = await ask({
    type: 'file-picker', kind, multiple: kind === 'open' && !!o.multiple, types,
    acceptAll: !o.excludeAcceptAllOption, suggestedName: typeof o.suggestedName === 'string' ? o.suggestedName.slice(0, 255) : '',
  }, null);
  if (m.error === 'cancelled') throw new DOMException('The user aborted a request.', 'AbortError');
  if (m.error === 'busy') throw new DOMException('A file window is already open.', 'NotAllowedError');
  const paths = Array.isArray(m.paths) ? m.paths : [];
  const handles = objects as FileSystemFileHandle[];
  if (!m.ok || !handles.length || handles.length !== paths.length || !paths.every(isPath) || handles.some(h => h?.kind !== 'file')) {
    throw new DOMException('The file window could not be used.', 'NotAllowedError');
  }
  return { handles, paths };
}

async function nativePicker(kind: 'open' | 'save', o: PickerOptions = {}): Promise<FileSystemFileHandle[]> {
  const { handles, paths } = await pick(kind, o);
  await Promise.all(handles.map((h, i) => rememberLocation(h, paths[i])));
  return handles;
}

/** In the Windows app, the page's Open and Save windows become Windows' own, which report each file's path. A plain browser keeps its own. */
export function installNativePickers() {
  if (!isDesktop()) return;
  window.showOpenFilePicker = o => nativePicker('open', o);
  window.showSaveFilePicker = async o => (await nativePicker('save', o))[0];
}

/** What went wrong, in words for the user. */
export function locationProblem(r: Located, name: string): string {
  switch (r.error) {
    case 'missing': return `“${name}” is no longer where it was opened from. It may have been moved, renamed or deleted.`;
    case 'unsupported': return `The location of “${name}” is not available. This works in the Meletiq PDF desktop app, for files opened from disk.`;
    case 'unknown': return `Meletiq PDF does not know where “${name}” is yet.`;
    case 'different': return `That was a different file, so nothing changed. Choose “${name}” itself, the file this tab came from.`;
    case 'timeout': return 'Meletiq PDF did not answer in time. Try again.';
    default: return `The location of “${name}” could not be read.`;
  }
}
