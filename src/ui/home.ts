// The Home screen: recent files, recently closed documents and your collections. Shown when no
// document is open, and any time from the house button beside the document tabs.

import { listRecent, removeRecent, type RecentFile } from '../features/recovery';
import {
  addToCollection, ago, clearClosed, CLOSED_DAYS, COLLECTION_COLOURS, collectionsOf, countItems, createCollection, deleteCollection,
  listClosed, listCollections, listItems, removeClosed, removeItem, updateCollection, type ClosedFile, type Collection,
} from '../features/library';
import { confirmDialog, openDialog } from './dialogs';
import { clear, h, icon, safe, toast } from './dom';
import { showMenu } from './menu';
import { readableHandle } from '../features/location';

export interface HomeHost {
  openLibraryFiles(files: HomeFile[]): Promise<string[]>;
  openHandle(handle: FileSystemFileHandle): Promise<void>;
  rememberOpenTabs(): Promise<unknown>;
  collectionsChanged(): Promise<void>;
  openDialog(): Promise<void>;
  createDocument(): Promise<void>;
  imagesToPdf(): Promise<void>;
}

type View = { kind: 'recent' } | { kind: 'closed' } | { kind: 'collection'; id: string };

export interface HomeFile { id: string; name: string; handle: FileSystemFileHandle | null; order: number; closed?: ClosedFile; collection?: string }
interface Row extends HomeFile { detail: string; remove?: () => Promise<unknown>; removeLabel?: string }

export class Home {
  readonly el = h('div', { class: 'home' });
  private view: View = { kind: 'recent' };
  private nav = h('nav', { class: 'home-nav', 'aria-label': 'Library' });
  private main = h('div', { class: 'home-main' });
  private drawing = 0;
  private rows: Row[] = [];
  private selected = new Set<string>();
  private anchor: string | null = null;
  private opening = false;
  private batchBar = h('div', { class: 'home-batch', role: 'group', 'aria-label': 'Open files' });

  constructor(private host: HomeHost) {
    this.el.append(this.nav, this.main);
    this.el.addEventListener('keydown', e => {
      if (this.view.kind === 'recent') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !(e.target as Element).matches('input:not([type=checkbox]),textarea')) {
        e.preventDefault(); e.stopPropagation();
        if (!this.opening) { this.rows.forEach(r => this.selected.add(r.id)); this.syncSelection(); }
      }
    });
  }

  /** Draws the screen again from the stored lists. */
  async draw() {
    const run = ++this.drawing;
    const [collections, counts, closed, recent] = await Promise.all([listCollections(), countItems(), listClosed(), listRecent().catch(() => [] as RecentFile[])]);
    if (run !== this.drawing) return;
    if (this.view.kind === 'collection' && !collections.some(c => c.id === (this.view as { id: string }).id)) this.view = { kind: 'recent' };
    this.drawNav(collections, counts, closed.length, recent.length);
    let rows: Row[] = [];
    let heading = '', note = '';
    let actions: HTMLElement | null = null;
    if (this.view.kind === 'recent') {
      heading = 'Recent files';
      note = recent.length ? 'The files you opened last.' : 'Files you open appear here.';
      rows = recent.map(r => ({ id: r.name, name: r.name, handle: r.handle, order: r.when, detail: `${r.pages} page${r.pages === 1 ? '' : 's'}, opened ${ago(r.when)}`, remove: () => removeRecent(r.name), removeLabel: 'Remove from this list' }));
    } else if (this.view.kind === 'closed') {
      heading = 'Recently closed';
      note = `Documents you closed in the last ${CLOSED_DAYS} days. They reopen at the page you left. Older ones are forgotten automatically. Ctrl+Shift+T reopens the last one.`;
      rows = closed.map(c => ({ id: c.id, name: c.name, handle: c.handle, order: c.order ?? c.closedAt, closed: c, detail: `Closed ${ago(c.closedAt)}, at page ${c.page + 1} of ${c.pages}.${c.handle ? '' : ' Choose file to reopen.'}`, remove: () => removeClosed(c.id), removeLabel: 'Forget' }));
      if (closed.length) actions = h('button', { class: 'btn small', onclick: safe(async () => { if (await confirmDialog('Clear the list?', 'The files themselves stay where they are.', 'Clear')) { await clearClosed(); void this.draw(); } }) }, 'Clear the list');
    } else {
      const c = collections.find(x => x.id === (this.view as { id: string }).id)!;
      const items = await listItems(c.id);
      if (run !== this.drawing) return;
      heading = c.name;
      note = items.length ? 'Only a link to each file is kept here. Removing one from the collection never deletes the file.' : 'This collection is empty. Use “Add to collection” on an open document, or Add files here.';
      rows = items.map(it => ({ id: it.id, name: it.name, handle: it.handle, order: it.order ?? it.added, collection: c.id, detail: `Added ${ago(it.added)}`, remove: () => removeItem(it.id), removeLabel: 'Remove from collection' }));
      actions = h('div', { class: 'row-gap' },
        h('button', { class: 'btn small', onclick: safe(() => this.addFiles(c)) }, icon('plus', 13), ' Add files'),
        h('button', { class: 'btn small', onclick: safe(() => this.editCollection(c)) }, 'Rename or colour'),
        h('button', { class: 'btn small', onclick: safe(async () => {
          if (!await confirmDialog(`Delete “${c.name}”?`, 'Only the collection goes. The files stay where they are.', 'Delete', true)) return;
          await deleteCollection(c.id);
          await this.host.collectionsChanged();
          this.view = { kind: 'recent' };
          void this.draw();
        }) }, 'Delete collection'));
    }
    this.rows = rows;
    for (const id of this.selected) if (!rows.some(r => r.id === id)) this.selected.delete(id);
    if (this.anchor && !rows.some(r => r.id === this.anchor)) this.anchor = null;
    this.drawBatchBar();
    clear(this.main);
    this.main.append(
      h('div', { class: 'home-hero' },
        h('div', null, h('h1', null, 'Meletiq PDF'), h('p', { class: 'muted' }, 'Open a PDF, or paste a screenshot with Ctrl+V and turn it light or dark.')),
        h('div', { class: 'home-quick' },
          this.quick('open', 'Open file', 'PDF, pictures, Word, Excel, PowerPoint', () => this.host.openDialog()),
          this.quick('newDoc', 'Create document', 'Blank, lined, grid or dotted', () => this.host.createDocument()),
          this.quick('imagesToPdf', 'Pictures to PDF', 'One page per picture', () => this.host.imagesToPdf()))),
      h('div', { class: 'home-head' }, h('div', null, h('h2', null, heading), h('p', { class: 'muted' }, note)), actions),
      ...(rows.length && this.view.kind !== 'recent' ? [this.batchBar] : []),
      rows.length ? h('div', { class: 'home-list' }, ...rows.map(r => this.row(r, collections))) : h('div', { class: 'home-empty' }, icon(this.view.kind === 'collection' ? 'folder' : 'file', 34), h('p', null, 'Nothing here yet.')));
    this.syncSelection();
  }

  private quick(ic: string, title: string, sub: string, run: () => unknown) {
    return h('button', { class: 'home-card', onclick: safe(run, title) }, h('span', { class: 'home-card-icon' }, icon(ic, 22)), h('span', { class: 'home-card-text' }, h('strong', null, title), h('small', null, sub)));
  }

  private drawNav(collections: Collection[], counts: Map<string, number>, closed: number, recent: number) {
    clear(this.nav);
    const item = (v: View, ic: string | HTMLElement, label: string, count?: number) => {
      const on = v.kind === this.view.kind && (v.kind !== 'collection' || (this.view.kind === 'collection' && v.id === this.view.id));
      return h('button', { class: `home-nav-item${on ? ' on' : ''}`, onclick: () => { this.view = v; this.selected.clear(); this.anchor = null; void this.draw(); } },
        typeof ic === 'string' ? icon(ic, 16) : ic, h('span', null, label), count ? h('small', null, String(count)) : null);
    };
    this.nav.append(
      item({ kind: 'recent' }, 'home', 'Recent', recent),
      item({ kind: 'closed' }, 'history', 'Recently closed', closed),
      h('div', { class: 'home-nav-title' }, 'Collections'),
      ...collections.map(c => item({ kind: 'collection', id: c.id }, h('span', { class: 'coll-dot', style: { background: c.colour } }), c.name, counts.get(c.id))),
      h('button', { class: 'home-nav-item add', onclick: safe(() => this.newCollection()) }, icon('folderPlus', 16), h('span', null, 'New collection')));
  }

  private row(r: Row, collections: Collection[]): HTMLElement {
    const selectable = this.view.kind !== 'recent';
    const box = h('input', { class: 'home-select', type: 'checkbox', 'aria-label': `Select ${r.name}`, onclick: (e: MouseEvent) => {
      e.stopPropagation(); this.choose(r.id, box.checked, e.shiftKey);
    } });
    const more = h('button', { class: 'icon-btn small', title: 'More', 'aria-label': `More for ${r.name}` }, icon('more', 14));
    more.addEventListener('click', e => {
      e.stopPropagation();
      const b = more.getBoundingClientRect();
      const file = r.handle ? { name: r.name, handle: r.handle } : null;
      showMenu(b.left, b.bottom, [
        { label: 'Open', icon: 'open', run: () => this.openRows([r]) },
        ...(file ? collections.map(c => ({ label: `Add to ${c.name}`, icon: 'folder', run: () => this.addTo(c, file) })) : []),
        ...(file ? [{ label: 'Add to a new collection…', icon: 'folderPlus', run: () => this.newCollection(file) }] : []),
        ...(r.remove ? [{ label: r.removeLabel ?? 'Remove', icon: 'close', run: async () => { await r.remove!(); if (r.collection) await this.host.collectionsChanged(); void this.draw(); } }] : []),
      ]);
    });
    return h('div', { class: 'home-row recent-row', role: 'button', tabindex: 0, dataset: { rowId: r.id }, title: `Open ${r.name}`,
      onclick: safe((e: MouseEvent) => {
        if (selectable && (e.ctrlKey || e.metaKey || e.shiftKey)) this.choose(r.id, e.shiftKey || !this.selected.has(r.id), e.shiftKey);
        else return this.openRows([r]);
      }, 'Opening'), onkeydown: (e: KeyboardEvent) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        if (selectable && e.key === ' ') this.choose(r.id, !this.selected.has(r.id), e.shiftKey);
        else safe(() => this.openRows([r]), 'Opening')();
      } },
      selectable ? box : null,
      h('span', { class: 'home-row-icon' }, icon('file', 18)),
      h('span', { class: 'home-row-text' }, h('span', { class: 'name' }, r.name), h('small', { class: 'muted' }, r.detail)),
      more);
  }

  private drawBatchBar() {
    clear(this.batchBar);
    const all = h('input', { type: 'checkbox', 'aria-label': 'Select all files', onchange: () => {
      for (const r of this.rows) { if (all.checked) this.selected.add(r.id); else this.selected.delete(r.id); }
      this.syncSelection();
    } });
    this.batchBar.append(h('label', { class: 'home-select-all' }, all, 'Select all'),
      h('span', { class: 'home-selection-count', 'aria-live': 'polite' }),
      h('button', { class: 'btn small primary home-open-selected', title: 'Open selected files in their original tab order', onclick: safe(() => this.openRows(this.rows.filter(r => this.selected.has(r.id))), 'Opening files') }, 'Open selected'),
      h('button', { class: 'btn small home-open-all', title: 'Open all files in their original tab order', onclick: safe(() => this.openRows(this.rows), 'Opening files') }, 'Open all'));
  }

  private choose(id: string, checked: boolean, range = false) {
    if (this.opening) return;
    const a = this.rows.findIndex(r => r.id === this.anchor), b = this.rows.findIndex(r => r.id === id);
    const rows = range && a >= 0 ? this.rows.slice(Math.min(a, b), Math.max(a, b) + 1) : this.rows.filter(r => r.id === id);
    for (const r of rows) { if (checked) this.selected.add(r.id); else this.selected.delete(r.id); }
    if (!range || !this.anchor) this.anchor = id;
    this.syncSelection();
  }

  private syncSelection() {
    const count = this.rows.filter(r => this.selected.has(r.id)).length;
    const all = this.batchBar.querySelector<HTMLInputElement>('input');
    if (all) { all.checked = !!this.rows.length && count === this.rows.length; all.indeterminate = count > 0 && count < this.rows.length; all.disabled = this.opening; }
    const countEl = this.batchBar.querySelector('.home-selection-count');
    if (countEl) countEl.textContent = count ? `${count} selected` : '';
    const selected = this.batchBar.querySelector<HTMLButtonElement>('.home-open-selected');
    if (selected) selected.disabled = this.opening || !count;
    const openAll = this.batchBar.querySelector<HTMLButtonElement>('.home-open-all');
    if (openAll) openAll.disabled = this.opening;
    this.main.setAttribute('aria-busy', String(this.opening));
    for (const row of this.main.querySelectorAll<HTMLElement>('.home-row')) {
      const on = this.selected.has(row.dataset.rowId!); row.classList.toggle('selected', on);
      const box = row.querySelector<HTMLInputElement>('.home-select');
      if (box) { box.checked = on; box.disabled = this.opening; }
      const more = row.querySelector<HTMLButtonElement>('button');
      if (more) more.disabled = this.opening;
    }
  }

  /** A recent file opens on its own; one that has gone is taken off the list. */
  private async openRecent(r: Row) {
    const handle = await readableHandle(r.handle!);
    if (!handle) return;
    try { await handle.getFile(); }
    catch {
      toast(`“${r.name}” could not be found. It may have been moved or deleted.`, 'error');
      await removeRecent(r.name);
      void this.draw();
      return;
    }
    await this.host.openHandle(handle);
  }

  private async openRows(rows: Row[]) {
    if (rows.length === 1 && !rows[0].closed && !rows[0].collection) { await this.openRecent(rows[0]); return; }
    if (this.opening || !rows.length) return;
    this.opening = true; rows.forEach(r => this.selected.add(r.id)); this.syncSelection();
    try {
      const opened = await this.host.openLibraryFiles([...rows]);
      opened.forEach(id => this.selected.delete(id));
    } finally { this.opening = false; await this.draw(); }
  }

  private async addTo(c: Collection, r: { name: string; handle: FileSystemFileHandle }) {
    const added = await addToCollection(c.id, r.name, r.handle);
    await this.host.rememberOpenTabs();
    await this.host.collectionsChanged();
    toast(added ? `Added to ${c.name}.` : `Already in ${c.name}.`, added ? 'ok' : 'info');
    void this.draw();
  }

  private async addFiles(c: Collection) {
    if (!window.showOpenFilePicker) { toast('Adding files here needs the desktop app.', 'info'); return; }
    let handles: FileSystemFileHandle[] = [];
    try { handles = await window.showOpenFilePicker({ multiple: true, types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }] }); }
    catch (err) { if ((err as Error).name === 'AbortError') return; throw err; }
    let n = 0;
    for (const hd of handles) if (await addToCollection(c.id, hd.name, hd)) n++;
    await this.host.rememberOpenTabs();
    await this.host.collectionsChanged();
    toast(n ? `Added ${n} file${n === 1 ? '' : 's'} to ${c.name}.` : 'Those files were already there.', n ? 'ok' : 'info');
    void this.draw();
  }

  /** Asks for a name and colour. Adds the file to it, if one is given. */
  async newCollection(file?: { name: string; handle: FileSystemFileHandle }): Promise<Collection | null> {
    const r = await collectionDialog('New collection', '', COLLECTION_COLOURS[Math.floor(Math.random() * COLLECTION_COLOURS.length)], 'Create');
    if (!r) return null;
    const c = await createCollection(r.name, r.colour);
    if (file) await addToCollection(c.id, file.name, file.handle);
    await this.host.rememberOpenTabs();
    await this.host.collectionsChanged();
    this.view = { kind: 'collection', id: c.id };
    this.selected.clear(); this.anchor = null;
    void this.draw();
    return c;
  }

  async editCollection(c: Collection) {
    const r = await collectionDialog('Rename collection', c.name, c.colour, 'Save');
    if (!r) return;
    await updateCollection({ ...c, name: r.name, colour: r.colour });
    await this.host.collectionsChanged();
    void this.draw();
  }

  /** Add an open document to a collection: pick one, or make a new one. */
  async chooseCollectionFor(file: { name: string; handle: FileSystemFileHandle }) {
    const collections = await listCollections();
    const inside = await collectionsOf(file.handle);
    if (!collections.length) {
      const created = await this.newCollection(file);
      if (created) toast(`“${file.name}” is in the new collection.`, 'ok');
      return created?.id;
    }
    const list = h('div', { class: 'coll-pick' }, ...collections.map(c => {
      const box = h('input', { type: 'checkbox', checked: inside.has(c.id), 'data-id': c.id });
      return h('label', { class: 'coll-pick-row' }, box, h('span', { class: 'coll-dot', style: { background: c.colour } }), c.name);
    }));
    const newBtn = h('button', { class: 'btn small' }, icon('folderPlus', 13), ' New collection');
    const ok = await openDialog<boolean | 'new'>(`Add “${file.name}” to`, h('div', null, list, h('div', { class: 'row-gap', style: { marginTop: '10px' } }, newBtn)),
      [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }], false, close => newBtn.addEventListener('click', () => close('new')));
    if (ok === 'new') return (await this.newCollection(file))?.id;
    if (!ok) return;
    const items = await Promise.all(collections.map(async c => ({ c, items: await listItems(c.id) })));
    for (const box of list.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) {
      const c = collections.find(x => x.id === box.dataset.id)!;
      if (box.checked && !inside.has(c.id)) await addToCollection(c.id, file.name, file.handle);
      if (!box.checked && inside.has(c.id)) {
        for (const it of items.find(x => x.c === c)?.items ?? []) if (await it.handle.isSameEntry(file.handle).catch(() => false)) await removeItem(it.id);
      }
    }
    await this.host.rememberOpenTabs();
    await this.host.collectionsChanged();
    toast('Collections updated.', 'ok');
    void this.draw();
    return list.querySelector<HTMLInputElement>('input:checked')?.dataset.id ?? null;
  }
}

async function collectionDialog(title: string, name: string, colour: string, ok: string): Promise<{ name: string; colour: string } | null> {
  let chosen = colour;
  const nameIn = h('input', { type: 'text', value: name, placeholder: 'For example: Exam revision', 'aria-label': 'Name' });
  const swatches = h('div', { class: 'coll-colours' }, ...COLLECTION_COLOURS.map(c => {
    const b = h('button', { class: `coll-colour${c === chosen ? ' on' : ''}`, style: { background: c }, title: c, 'aria-label': `Colour ${c}`, onclick: () => {
      chosen = c;
      swatches.querySelectorAll('.coll-colour').forEach(x => x.classList.toggle('on', x === b));
    } });
    return b;
  }));
  const go = await openDialog(title, h('div', { class: 'form' }, h('div', { class: 'field-row' }, h('label', null, 'Name'), nameIn), h('div', { class: 'field-row' }, h('label', null, 'Colour'), swatches)),
    [{ label: 'Cancel', value: false }, { label: ok, value: true, primary: true }], false);
  const n = nameIn.value.trim();
  return go && n ? { name: n, colour: chosen } : null;
}

