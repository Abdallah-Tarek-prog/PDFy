// Collections of PDFs and the list of recently closed documents. Only handles and file metadata are
// kept, never PDF copies. Files without a disk handle can be chosen again when reopening history.
// Recently closed documents are forgotten after 7 days.

const DB = 'pdfy-library';
const COLLECTIONS = 'collections';
const ITEMS = 'items';
const CLOSED = 'closed';
export const CLOSED_DAYS = 7;
const MAX_CLOSED = 40;
const DAY = 86_400_000;

export interface Collection { id: string; name: string; colour: string; created: number; collapsed?: boolean }
export interface CollectionItem { id: string; collection: string; name: string; handle: FileSystemFileHandle; added: number; pages?: number; order?: number }
export interface ClosedFile { id: string; name: string; handle: FileSystemFileHandle | null; closedAt: number; page: number; pages: number; order?: number }

export const COLLECTION_COLOURS = ['#4f8cf7', '#e5534b', '#f0a33a', '#3fb27f', '#a371f7', '#e86bb4', '#3db8c5', '#8b949e'];

const id = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore(COLLECTIONS, { keyPath: 'id' });
      db.createObjectStore(ITEMS, { keyPath: 'id' }).createIndex('collection', 'collection');
      db.createObjectStore(CLOSED, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

function finished(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error); });
}

/** Opens the database for one job and always closes it, so nothing stays held in memory. */
async function use<T>(job: (db: IDBDatabase) => Promise<T>, fallback: T): Promise<T> {
  let db: IDBDatabase | null = null;
  try {
    db = await open();
    return await job(db);
  } catch (err) {
    console.warn('Library', err);
    return fallback;
  } finally {
    db?.close();
  }
}

/** True when both point at the same file on disk. */
async function same(a: FileSystemFileHandle, b: FileSystemFileHandle): Promise<boolean> {
  try { return await a.isSameEntry(b); } catch { return false; }
}

// ---- Collections ----

export const listCollections = () => use(async db => (await done<Collection[]>(db.transaction(COLLECTIONS).objectStore(COLLECTIONS).getAll())).sort((a, b) => a.created - b.created), [] as Collection[]);

export async function createCollection(name: string, colour = COLLECTION_COLOURS[0]): Promise<Collection> {
  const c: Collection = { id: id(), name: name.trim() || 'New collection', colour, created: Date.now() };
  const saved = await use(async db => {
    const t = db.transaction(COLLECTIONS, 'readwrite');
    t.objectStore(COLLECTIONS).put(c);
    await finished(t);
    return true;
  }, false);
  if (!saved) throw new Error('The collection could not be saved. Please try again.');
  return c;
}

export const updateCollection = (c: Collection) => use(db => done(db.transaction(COLLECTIONS, 'readwrite').objectStore(COLLECTIONS).put(c)).then(() => true), false);

/** Removes the collection and its list. The files themselves are not touched. */
export const deleteCollection = (cid: string) => use(async db => {
  const t = db.transaction([COLLECTIONS, ITEMS], 'readwrite');
  t.objectStore(COLLECTIONS).delete(cid);
  const keys = await done(t.objectStore(ITEMS).index('collection').getAllKeys(cid));
  for (const k of keys) t.objectStore(ITEMS).delete(k);
  await finished(t);
  return true;
}, false);

export const listItems = (cid: string) => use(async db => (await done<CollectionItem[]>(db.transaction(ITEMS).objectStore(ITEMS).index('collection').getAll(cid))).sort((a, b) => (a.order ?? a.added) - (b.order ?? b.added)), [] as CollectionItem[]);

export const countItems = () => use(async db => {
  const all = await done<CollectionItem[]>(db.transaction(ITEMS).objectStore(ITEMS).getAll());
  const out = new Map<string, number>();
  for (const it of all) out.set(it.collection, (out.get(it.collection) ?? 0) + 1);
  return out;
}, new Map<string, number>());

/** Adds a file to a collection. Returns false if it was already there. */
export const addToCollection = (cid: string, name: string, handle: FileSystemFileHandle, pages?: number) => use(async db => {
  const existing = await done<CollectionItem[]>(db.transaction(ITEMS).objectStore(ITEMS).index('collection').getAll(cid));
  for (const it of existing) if (await same(it.handle, handle)) return false;
  const order = Math.max(-1, ...existing.map(item => item.order ?? item.added)) + 1;
  await done(db.transaction(ITEMS, 'readwrite').objectStore(ITEMS).put({ id: id(), collection: cid, name, handle, added: Date.now(), pages, order } satisfies CollectionItem));
  return true;
}, false);

/** Keep collection order in step with the user's open tabs, without changing membership. */
export const rememberTabOrder = (files: { handle: FileSystemFileHandle; order: number }[]) => use(async db => {
  if (!files.length) return true;
  const items = await done<CollectionItem[]>(db.transaction(ITEMS).objectStore(ITEMS).getAll());
  const ranks = new Map<string, number>();
  for (const item of items) {
    for (const file of files) {
      if (item.name === file.handle.name && await same(item.handle, file.handle)) {
        ranks.set(item.id, file.order); break;
      }
    }
  }
  const groups = new Map<string, CollectionItem[]>();
  for (const item of items) {
    let group = groups.get(item.collection);
    if (!group) { group = []; groups.set(item.collection, group); }
    group.push(item);
  }
  const changed: CollectionItem[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => (a.order ?? a.added) - (b.order ?? b.added));
    const moving = group.filter(item => ranks.has(item.id)).sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)!);
    if (moving.length < 2) continue;
    let at = 0;
    const ordered = group.map(item => ranks.has(item.id) ? moving[at++] : item);
    ordered.forEach((item, order) => { if (item.order !== order) changed.push({ ...item, order }); });
  }
  if (changed.length) {
    const t = db.transaction(ITEMS, 'readwrite');
    for (const item of changed) t.objectStore(ITEMS).put(item);
    await finished(t);
  }
  return true;
}, false);

export const removeItem = (itemId: string) => use(db => done(db.transaction(ITEMS, 'readwrite').objectStore(ITEMS).delete(itemId)).then(() => true), false);

/** Move a file between tab groups in one transaction, keeping its other collection links. */
export const moveCollectionFile = (name: string, handle: FileSystemFileHandle, from: string | null, to: string | null, pages: number) => use(async db => {
  const items = await done<CollectionItem[]>(db.transaction(ITEMS).objectStore(ITEMS).getAll());
  const matches: CollectionItem[] = [];
  for (const item of items) if (item.name === handle.name && await same(item.handle, handle)) matches.push(item);
  const t = db.transaction(ITEMS, 'readwrite');
  const store = t.objectStore(ITEMS);
  if (from && from !== to) for (const item of matches) if (item.collection === from) store.delete(item.id);
  if (to && !matches.some(item => item.collection === to)) {
    const order = Math.max(-1, ...items.filter(item => item.collection === to).map(item => item.order ?? item.added)) + 1;
    store.put({ id: id(), collection: to, name, handle, added: Date.now(), pages, order } satisfies CollectionItem);
  }
  await finished(t);
  return true;
}, false);

/** The collections a file is in. */
export const collectionsOf = (handle: FileSystemFileHandle) => use(async db => {
  const all = await done<CollectionItem[]>(db.transaction(ITEMS).objectStore(ITEMS).getAll());
  const ids = new Set<string>();
  for (const it of all) if (await same(it.handle, handle)) ids.add(it.collection);
  return ids;
}, new Set<string>());

// ---- Recently closed ----

/** Forgets what was closed more than 7 days ago, and keeps the list short. */
export const pruneClosed = () => use(async db => {
  const t = db.transaction(CLOSED, 'readwrite');
  const all = await done<ClosedFile[]>(t.objectStore(CLOSED).getAll());
  const cutoff = Date.now() - CLOSED_DAYS * DAY;
  const sorted = all.sort((a, b) => b.closedAt - a.closedAt);
  let removed = 0;
  sorted.forEach((c, i) => { if (c.closedAt < cutoff || i >= MAX_CLOSED) { t.objectStore(CLOSED).delete(c.id); removed++; } });
  await finished(t);
  return removed;
}, 0);

export async function listClosed(): Promise<ClosedFile[]> {
  await pruneClosed();
  return use(async db => (await done<ClosedFile[]>(db.transaction(CLOSED).objectStore(CLOSED).getAll())).sort((a, b) => b.closedAt - a.closedAt), [] as ClosedFile[]);
}

/** Remembers a document that was just closed. An older entry for the same file is replaced. */
export const addClosed = (name: string, handle: FileSystemFileHandle | null, page: number, pages: number, order?: number) => use(async db => {
  const all = await done<ClosedFile[]>(db.transaction(CLOSED).objectStore(CLOSED).getAll());
  // Compared first: a write must not wait on anything else, or the database closes it early.
  const old = new Set<string>();
  for (const c of all) {
    if (c.name !== name) continue;
    if (c.handle && handle ? await same(c.handle, handle) : !c.handle && !handle) old.add(c.id);
  }
  const now = Date.now();
  const remaining = all.filter(c => !old.has(c.id)).sort((a, b) => b.closedAt - a.closedAt);
  remaining.forEach((c, i) => { if (c.closedAt < now - CLOSED_DAYS * DAY || i >= MAX_CLOSED - 1) old.add(c.id); });
  const t = db.transaction(CLOSED, 'readwrite');
  for (const k of old) t.objectStore(CLOSED).delete(k);
  t.objectStore(CLOSED).put({ id: id(), name, handle, closedAt: now, page, pages, order } satisfies ClosedFile);
  await finished(t);
  return true;
}, false);

export const removeClosed = (cid: string) => use(db => done(db.transaction(CLOSED, 'readwrite').objectStore(CLOSED).delete(cid)).then(() => true), false);
export const clearClosed = () => use(db => done(db.transaction(CLOSED, 'readwrite').objectStore(CLOSED).clear()).then(() => true), false);

/** "2 minutes ago", "yesterday", "3 days ago". */
export function ago(when: number): string {
  const s = Math.max(0, (Date.now() - when) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) { const m = Math.round(s / 60); return `${m} minute${m === 1 ? '' : 's'} ago`; }
  if (s < 86400) { const hr = Math.round(s / 3600); return `${hr} hour${hr === 1 ? '' : 's'} ago`; }
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
