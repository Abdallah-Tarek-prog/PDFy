// The Home screen: recent files, recently closed documents and your collections. Shown when no
// document is open, and any time from the house button beside the document tabs.

import { listRecent, removeRecent, type RecentFile } from '../features/recovery';
import {
  addToCollection, ago, clearClosed, CLOSED_DAYS, COLLECTION_COLOURS, collectionsOf, countItems, createCollection, deleteCollection,
  listClosed, listCollections, listItems, removeClosed, removeItem, updateCollection, type Collection,
} from '../features/library';
import { confirmDialog, openDialog } from './dialogs';
import { clear, h, icon, safe, toast } from './dom';
import { showMenu } from './menu';

export interface HomeHost {
  openHandle(handle: FileSystemFileHandle, page?: number): Promise<void>;
  openDialog(): Promise<void>;
  createDocument(): Promise<void>;
  imagesToPdf(): Promise<void>;
}

type View = { kind: 'recent' } | { kind: 'closed' } | { kind: 'collection'; id: string };

interface Row { name: string; handle: FileSystemFileHandle; detail: string; page?: number; remove?: () => Promise<unknown>; removeLabel?: string }

export class Home {
  readonly el = h('div', { class: 'home' });
  private view: View = { kind: 'recent' };
  private nav = h('nav', { class: 'home-nav', 'aria-label': 'Library' });
  private main = h('div', { class: 'home-main' });
  private drawing = 0;

  constructor(private host: HomeHost) {
    this.el.append(this.nav, this.main);
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
      rows = recent.map(r => ({ name: r.name, handle: r.handle, detail: `${r.pages} page${r.pages === 1 ? '' : 's'}, opened ${ago(r.when)}`, remove: () => removeRecent(r.name), removeLabel: 'Remove from this list' }));
    } else if (this.view.kind === 'closed') {
      heading = 'Recently closed';
      note = `Documents you closed in the last ${CLOSED_DAYS} days. They reopen at the page you left. Older ones are forgotten automatically. Ctrl+Shift+T reopens the last one.`;
      rows = closed.map(c => ({ name: c.name, handle: c.handle, page: c.page, detail: `Closed ${ago(c.closedAt)}, at page ${c.page + 1} of ${c.pages}`, remove: () => removeClosed(c.id), removeLabel: 'Forget' }));
      if (closed.length) actions = h('button', { class: 'btn small', onclick: safe(async () => { if (await confirmDialog('Clear the list?', 'The files themselves stay where they are.', 'Clear')) { await clearClosed(); void this.draw(); } }) }, 'Clear the list');
    } else {
      const c = collections.find(x => x.id === (this.view as { id: string }).id)!;
      const items = await listItems(c.id);
      if (run !== this.drawing) return;
      heading = c.name;
      note = items.length ? 'Only a link to each file is kept here. Removing one from the collection never deletes the file.' : 'This collection is empty. Use “Add to collection” on an open document, or Add files here.';
      rows = items.map(it => ({ name: it.name, handle: it.handle, detail: `Added ${ago(it.added)}`, remove: () => removeItem(it.id), removeLabel: 'Remove from collection' }));
      actions = h('div', { class: 'row-gap' },
        h('button', { class: 'btn small', onclick: safe(() => this.addFiles(c)) }, icon('plus', 13), ' Add files'),
        h('button', { class: 'btn small', onclick: safe(() => this.editCollection(c)) }, 'Rename or colour'),
        h('button', { class: 'btn small', onclick: safe(async () => {
          if (!await confirmDialog(`Delete “${c.name}”?`, 'Only the collection goes. The files stay where they are.', 'Delete', true)) return;
          await deleteCollection(c.id);
          this.view = { kind: 'recent' };
          void this.draw();
        }) }, 'Delete collection'));
    }
    clear(this.main);
    this.main.append(
      h('div', { class: 'home-hero' },
        h('div', null, h('h1', null, 'PDFy'), h('p', { class: 'muted' }, 'Open a PDF, or paste a screenshot with Ctrl+V and turn it light or dark.')),
        h('div', { class: 'home-quick' },
          this.quick('open', 'Open file', 'PDF, pictures, Word, Excel, PowerPoint', () => this.host.openDialog()),
          this.quick('newDoc', 'Create document', 'Blank, lined, grid or dotted', () => this.host.createDocument()),
          this.quick('imagesToPdf', 'Pictures to PDF', 'One page per picture', () => this.host.imagesToPdf()))),
      h('div', { class: 'home-head' }, h('div', null, h('h2', null, heading), h('p', { class: 'muted' }, note)), actions),
      rows.length ? h('div', { class: 'home-list' }, ...rows.map(r => this.row(r, collections))) : h('div', { class: 'home-empty' }, icon(this.view.kind === 'collection' ? 'folder' : 'file', 34), h('p', null, 'Nothing here yet.')));
  }

  private quick(ic: string, title: string, sub: string, run: () => unknown) {
    return h('button', { class: 'home-card', onclick: safe(run, title) }, h('span', { class: 'home-card-icon' }, icon(ic, 22)), h('span', { class: 'home-card-text' }, h('strong', null, title), h('small', null, sub)));
  }

  private drawNav(collections: Collection[], counts: Map<string, number>, closed: number, recent: number) {
    clear(this.nav);
    const item = (v: View, ic: string | HTMLElement, label: string, count?: number) => {
      const on = v.kind === this.view.kind && (v.kind !== 'collection' || (this.view.kind === 'collection' && v.id === this.view.id));
      return h('button', { class: `home-nav-item${on ? ' on' : ''}`, onclick: () => { this.view = v; void this.draw(); } },
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
    const more = h('button', { class: 'icon-btn small', title: 'More', 'aria-label': `More for ${r.name}` }, icon('more', 14));
    more.addEventListener('click', e => {
      e.stopPropagation();
      const b = more.getBoundingClientRect();
      showMenu(b.left, b.bottom, [
        { label: 'Open', icon: 'open', run: () => this.open(r) },
        ...collections.map(c => ({ label: `Add to ${c.name}`, icon: 'folder', run: () => this.addTo(c, r) })),
        { label: 'Add to a new collection…', icon: 'folderPlus', run: () => this.newCollection(r) },
        ...(r.remove ? [{ label: r.removeLabel ?? 'Remove', icon: 'close', run: async () => { await r.remove!(); void this.draw(); } }] : []),
      ]);
    });
    return h('div', { class: 'home-row recent-row', role: 'button', tabindex: 0, title: `Open ${r.name}`,
      onclick: safe(() => this.open(r), 'Opening'), onkeydown: (e: KeyboardEvent) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        safe(() => this.open(r), 'Opening')();
      } },
      h('span', { class: 'home-row-icon' }, icon('file', 18)),
      h('span', { class: 'home-row-text' }, h('span', { class: 'name' }, r.name), h('small', { class: 'muted' }, r.detail)),
      more);
  }

  private async open(r: Row) {
    const ok = (await r.handle.queryPermission?.({ mode: 'read' })) === 'granted' || (await r.handle.requestPermission?.({ mode: 'read' })) === 'granted';
    if (!ok) return;
    try { await r.handle.getFile(); }
    catch {
      toast(`“${r.name}” is no longer there. It may have been moved or deleted.`, 'error');
      if (r.remove) { await r.remove(); void this.draw(); }
      return;
    }
    await this.host.openHandle(r.handle, r.page);
  }

  private async addTo(c: Collection, r: { name: string; handle: FileSystemFileHandle }) {
    const added = await addToCollection(c.id, r.name, r.handle);
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
    toast(n ? `Added ${n} file${n === 1 ? '' : 's'} to ${c.name}.` : 'Those files were already there.', n ? 'ok' : 'info');
    void this.draw();
  }

  /** Asks for a name and colour. Adds the file to it, if one is given. */
  async newCollection(file?: { name: string; handle: FileSystemFileHandle }): Promise<Collection | null> {
    const r = await collectionDialog('New collection', '', COLLECTION_COLOURS[Math.floor(Math.random() * COLLECTION_COLOURS.length)], 'Create');
    if (!r) return null;
    const c = await createCollection(r.name, r.colour);
    if (file) await addToCollection(c.id, file.name, file.handle);
    this.view = { kind: 'collection', id: c.id };
    void this.draw();
    return c;
  }

  private async editCollection(c: Collection) {
    const r = await collectionDialog('Rename collection', c.name, c.colour, 'Save');
    if (!r) return;
    await updateCollection({ ...c, name: r.name, colour: r.colour });
    void this.draw();
  }

  /** Add an open document to a collection: pick one, or make a new one. */
  async chooseCollectionFor(file: { name: string; handle: FileSystemFileHandle }) {
    const collections = await listCollections();
    const inside = await collectionsOf(file.handle);
    if (!collections.length) {
      if (await this.newCollection(file)) toast(`“${file.name}” is in the new collection.`, 'ok');
      return;
    }
    const list = h('div', { class: 'coll-pick' }, ...collections.map(c => {
      const box = h('input', { type: 'checkbox', checked: inside.has(c.id), 'data-id': c.id });
      return h('label', { class: 'coll-pick-row' }, box, h('span', { class: 'coll-dot', style: { background: c.colour } }), c.name);
    }));
    const newBtn = h('button', { class: 'btn small' }, icon('folderPlus', 13), ' New collection');
    const ok = await openDialog<boolean | 'new'>(`Add “${file.name}” to`, h('div', null, list, h('div', { class: 'row-gap', style: { marginTop: '10px' } }, newBtn)),
      [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }], false, close => newBtn.addEventListener('click', () => close('new')));
    if (ok === 'new') { await this.newCollection(file); return; }
    if (!ok) return;
    const items = await Promise.all(collections.map(async c => ({ c, items: await listItems(c.id) })));
    for (const box of list.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) {
      const c = collections.find(x => x.id === box.dataset.id)!;
      if (box.checked && !inside.has(c.id)) await addToCollection(c.id, file.name, file.handle);
      if (!box.checked && inside.has(c.id)) {
        for (const it of items.find(x => x.c === c)?.items ?? []) if (await it.handle.isSameEntry(file.handle).catch(() => false)) await removeItem(it.id);
      }
    }
    toast('Collections updated.', 'ok');
    void this.draw();
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

