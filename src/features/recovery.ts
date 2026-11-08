// Crash recovery. Edits are written to a small local database a few seconds after each change.
// If the app closes unexpectedly, the next start offers them back.

import type { Annot, Bookmark, BuildOptions, ImageAsset, PageRef } from '../core/model';
import type { Session } from '../core/session';

const DB = 'pdfy-recovery';
const JOURNAL = 'journal';
const ASSETS = 'assets';
const MAX_SOURCE_COPY = 100 * 1024 * 1024;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(JOURNAL, { keyPath: 'id' });
      req.result.createObjectStore(ASSETS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const blobIds = new WeakMap<Blob, string>();
const written = new Set<string>();
let nextBlob = 0;

function blobId(b: Blob): string {
  let id = blobIds.get(b);
  if (!id) { id = `${Date.now().toString(36)}-${nextBlob++}`; blobIds.set(b, id); }
  return id;
}

interface StoredAsset { blob: string; original: string; asset: Omit<ImageAsset, 'blob' | 'original'> }
type StoredAnnot = Omit<Annot, 'image'> & { image?: StoredAsset };
type StoredPage = Omit<PageRef, 'annots'> & { annots: StoredAnnot[] };

export interface Journal {
  id: string;
  name: string;
  when: number;
  handle: FileSystemFileHandle | null;
  sources: { id: string; name: string; handle: FileSystemFileHandle | null; copy: string | null; forms: Record<string, unknown> | null }[];
  pages: StoredPage[];
  bookmarks: Bookmark[];
  assetIds: string[];
  ocrWords?: [string, { x: number; y: number; w: number; h: number; text: string }[]][];
  attachments?: { name: string; asset: string }[];
  /** Passwords apply to immediate exports and are never written to the journal. */
  pendingOptions?: Omit<BuildOptions, 'encrypt'>;
}

const handles = new WeakMap<Blob, FileSystemFileHandle>();
export const rememberHandle = (blob: Blob, h: FileSystemFileHandle) => handles.set(blob, h);

const tx = <T,>(req: IDBRequest<T>) => new Promise<T>((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

/** Runs within the journal write, so concurrent writers cannot lose newly referenced blobs. */
function pruneAssets(t: IDBTransaction): Set<string> {
  const removed = new Set<string>();
  const journals = t.objectStore(JOURNAL).getAll();
  journals.onsuccess = () => {
    const keep = new Set((journals.result as Journal[]).flatMap(j => j.assetIds));
    const assets = t.objectStore(ASSETS);
    const keys = assets.getAllKeys();
    keys.onsuccess = () => {
      for (const key of keys.result) if (typeof key === 'string' && !keep.has(key)) {
        assets.delete(key);
        removed.add(key);
      }
    };
  };
  return removed;
}

/** Writes a session to the journal. Images are stored once, however often this runs. */
export async function saveJournal(session: Session): Promise<void> {
  const db = await openDb();
  try {
    const assetIds = new Set<string>();
    const blobs = new Map<string, Blob>();
    const storeBlob = (b: Blob) => {
      const id = blobId(b);
      assetIds.add(id);
      blobs.set(id, b);
      return id;
    };
    const sources: Journal['sources'] = [];
    for (const s of session.sources.values()) {
      const handle = handles.get(s.blob) ?? null;
      const copy = !handle && s.blob.size <= MAX_SOURCE_COPY ? storeBlob(s.blob) : null;
      const storage = s.formsEdited ? (s.pdf.annotationStorage as unknown as { getAll(): Record<string, unknown> | null }).getAll() : null;
      sources.push({ id: s.id, name: s.name, handle, copy, forms: storage });
    }
    const pages: StoredPage[] = session.pages.map(p => ({
      ...p,
      // Existing annotations are re-read from the file, so only our own need storing.
      annots: p.annots.filter(a => !a.ghost).map(a => {
        const { image, ...rest } = a;
        if (!image) return rest;
        const { blob, original, ...asset } = image;
        return { ...rest, image: { blob: storeBlob(blob), original: storeBlob(original), asset } };
      }),
      ghostsLoaded: false,
    }));
    const attachments = session.attachments.map(a => ({ name: a.name, asset: storeBlob(a.blob) }));
    const { encrypt: _encrypt, ...pendingOptions } = session.pendingOptions;
    const record: Journal = {
      id: session.id, name: session.name, when: Date.now(), handle: session.handle, sources, pages,
      bookmarks: session.bookmarks, assetIds: [...assetIds],
      ocrWords: [...session.ocrWords], attachments, pendingOptions,
    };
    const t = db.transaction([JOURNAL, ASSETS], 'readwrite');
    const assets = t.objectStore(ASSETS);
    for (const [id, blob] of blobs) {
      if (!written.has(id)) assets.put(blob, id);
      else {
        // Another transaction may have dropped the old journal since this save began.
        const existing = assets.getKey(id);
        existing.onsuccess = () => { if (existing.result === undefined) assets.put(blob, id); };
      }
    }
    t.objectStore(JOURNAL).put(record);
    const removed = pruneAssets(t);
    await new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
    for (const id of assetIds) written.add(id);
    for (const id of removed) written.delete(id);
  } finally {
    db.close();
  }
}

export async function listJournals(): Promise<Journal[]> {
  try {
    const db = await openDb();
    try { return await tx(db.transaction(JOURNAL).objectStore(JOURNAL).getAll()); }
    finally { db.close(); }
  } catch { return []; }
}

export async function loadAsset(id: string): Promise<Blob | undefined> {
  const db = await openDb();
  try { return await tx(db.transaction(ASSETS).objectStore(ASSETS).get(id)); }
  finally { db.close(); }
}

export async function restoreAnnots(stored: StoredAnnot[]): Promise<Annot[]> {
  const out: Annot[] = [];
  for (const a of stored) {
    if (!a.image) { out.push(a as Annot); continue; }
    const blob = await loadAsset(a.image.blob), original = await loadAsset(a.image.original);
    if (!blob || !original) continue;
    blobIds.set(blob, a.image.blob);
    blobIds.set(original, a.image.original);
    written.add(a.image.blob);
    written.add(a.image.original);
    out.push({ ...a, image: { ...a.image.asset, blob, original } });
  }
  return out;
}

/** Forgets a session and any images only it was using. */
export async function dropJournal(id: string): Promise<void> {
  try {
    const db = await openDb();
    try {
      const t = db.transaction([JOURNAL, ASSETS], 'readwrite');
      t.objectStore(JOURNAL).delete(id);
      const removed = pruneAssets(t);
      await new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
      for (const a of removed) written.delete(a);
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn('Could not clear recovery data', err);
  }
}

// ---- Recent files ----

const RECENT = 'recent';

function openRecentDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('pdfy-recent', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(RECENT, { keyPath: 'name' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export interface RecentFile { name: string; when: number; handle: FileSystemFileHandle; pages: number }

export async function addRecent(name: string, handle: FileSystemFileHandle, pages: number) {
  try {
    const db = await openRecentDb();
    try {
      await tx(db.transaction(RECENT, 'readwrite').objectStore(RECENT).put({ name, when: Date.now(), handle, pages } satisfies RecentFile));
      const all = await tx<RecentFile[]>(db.transaction(RECENT).objectStore(RECENT).getAll());
      if (all.length > 15) {
        const t = db.transaction(RECENT, 'readwrite');
        all.sort((a, b) => b.when - a.when).slice(15).forEach(r => t.objectStore(RECENT).delete(r.name));
      }
    } finally { db.close(); }
  } catch (err) { console.warn('Recent list', err); }
}

export async function listRecent(): Promise<RecentFile[]> {
  try {
    const db = await openRecentDb();
    try { return (await tx<RecentFile[]>(db.transaction(RECENT).objectStore(RECENT).getAll())).sort((a, b) => b.when - a.when); }
    finally { db.close(); }
  } catch { return []; }
}

export async function removeRecent(name: string) {
  try {
    const db = await openRecentDb();
    try { await tx(db.transaction(RECENT, 'readwrite').objectStore(RECENT).delete(name)); }
    finally { db.close(); }
  } catch { /* Nothing useful to do. */ }
}
