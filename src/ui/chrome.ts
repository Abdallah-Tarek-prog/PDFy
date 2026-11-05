// The top of the window, laid out the way Xodo does it:
//   1. a title bar with the logo and the window buttons (the Windows title bar is gone),
//   2. one toolbar row that changes with the mode: Read, Edit or Study,
//   3. the strip of open documents.
// Document tools that are not used every minute sit in one Actions menu with a search box,
// so everything can be found in one place instead of across many tabs.

import { clear, h, icon, safe } from './dom';

export interface Cmd {
  /** Shown under the icon and in menus. Also how the tests find a command. */
  label: string;
  icon: string;
  title?: string;
  run?: () => unknown;
  /** True when the command only makes sense with a document open. */
  needsDoc?: boolean;
  /** Lights up when this returns true, for tools and switches. */
  on?: () => boolean;
  /** Greyed out when this returns true. */
  off?: () => boolean;
  /** The id of its keyboard shortcut, so the key can be shown beside it. */
  key?: string;
  /** Other names it was known by, so older habits and tests still find it. */
  aka?: string[];
  /** A drop-down of more commands instead of a single action. */
  menu?: () => MenuSpec;
}

export interface MenuSection { name: string; items: Cmd[] }
export interface MenuSpec { sections: MenuSection[]; search?: boolean; wide?: boolean }

export interface ChromeHooks {
  hasDoc(): boolean;
  keyFor(id: string): string;
}

let openMenu: { close(refocus?: boolean): void; anchor: HTMLElement } | null = null;
export const closeDropdown = () => openMenu?.close();

/** One toolbar button: icon above a short label, like Xodo. */
export function toolButton(c: Cmd, hooks: ChromeHooks): HTMLButtonElement {
  const key = c.key ? hooks.keyFor(c.key) : '';
  const b = h('button', {
    class: `tb-btn${c.menu ? ' has-menu' : ''}`, 'data-label': c.label,
    title: `${c.title ?? c.label}${key ? ` (${key})` : ''}`, 'aria-label': c.label,
    onclick: safe(() => {
      if (c.menu) { showDropdown(b, c.menu(), hooks); return; }
      return c.run?.();
    }, c.label),
  }, icon(c.icon, 20), h('span', { class: 'tb-label' }, c.label, c.menu ? icon('chevDown', 10) : null)) as HTMLButtonElement;
  if (c.aka) b.dataset.aka = c.aka.join('|');
  syncButton(b, c, hooks);
  return b;
}

export function syncButton(b: HTMLButtonElement, c: Cmd, hooks: ChromeHooks) {
  b.disabled = (!!c.needsDoc && !hooks.hasDoc()) || !!c.off?.();
  if (c.on) {
    const on = c.on();
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

/**
 * A toolbar row. Buttons that do not fit move into a "More" menu at the end, so nothing is ever cut
 * off on a small screen.
 */
export class ToolRow {
  readonly el = h('div', { class: 'tb-row', role: 'toolbar' });
  private items: { c: Cmd; b: HTMLButtonElement; fixed: boolean }[] = [];
  private overflowBtn: HTMLButtonElement;
  private observer: ResizeObserver;

  constructor(private hooks: ChromeHooks, label: string) {
    this.el.setAttribute('aria-label', label);
    this.overflowBtn = toolButton({ label: 'More', icon: 'more', title: 'More tools', menu: () => ({ sections: [{ name: 'More tools', items: this.hidden() }] }) }, hooks);
    this.overflowBtn.classList.add('tb-overflow');
    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(this.el);
  }

  /** left: the commands, in order. right: kept at the far end and never moved into More. */
  set(left: (Cmd | '|')[], right: (Cmd | '|')[] = []) {
    clear(this.el);
    this.items = [];
    const add = (list: (Cmd | '|')[], into: HTMLElement, fixed: boolean) => {
      for (const c of list) {
        if (c === '|') { into.append(h('span', { class: 'tb-sep', role: 'separator' })); continue; }
        const b = toolButton(c, this.hooks);
        this.items.push({ c, b, fixed });
        into.append(b);
      }
    };
    const start = h('div', { class: 'tb-group tb-start' });
    const end = h('div', { class: 'tb-group tb-end' });
    add(left, start, false);
    start.append(this.overflowBtn);
    add(right, end, true);
    this.el.append(start, h('div', { class: 'tb-spacer' }), end);
    this.fit();
  }

  sync() { for (const it of this.items) syncButton(it.b, it.c, this.hooks); }

  private hidden(): Cmd[] { return this.items.filter(it => !it.fixed && it.b.hidden).map(it => it.c); }

  /** Shows as many buttons as fit, from the start, and puts the rest under More. */
  fit() {
    const movable = this.items.filter(it => !it.fixed);
    for (const it of movable) it.b.hidden = false;
    this.overflowBtn.hidden = true;
    if (!this.el.isConnected || this.el.scrollWidth <= this.el.clientWidth + 1) return;
    this.overflowBtn.hidden = false;
    for (let i = movable.length - 1; i >= 0 && this.el.scrollWidth > this.el.clientWidth + 1; i--) movable[i].b.hidden = true;
    // A separator left dangling at the end looks odd.
    this.el.querySelectorAll('.tb-group.tb-start .tb-sep').forEach(s => {
      const next = s.nextElementSibling as HTMLElement | null;
      (s as HTMLElement).hidden = !next || next.hidden || next === this.overflowBtn;
    });
  }

  /** Every command in the row, visible or under More. */
  commands(): Cmd[] { return this.items.map(it => it.c); }
  buttonFor(c: Cmd) { return this.items.find(it => it.c === c)?.b ?? null; }
  isHidden(c: Cmd) { return !!this.items.find(it => it.c === c)?.b.hidden; }
  overflow() { return this.overflowBtn; }
}

/** A drop-down under a toolbar button. Sections become columns when the menu is wide. */
export function showDropdown(anchor: HTMLElement, spec: MenuSpec, hooks: ChromeHooks): HTMLElement {
  if (openMenu?.anchor === anchor) { openMenu.close(); return document.createElement('div'); }
  const r = anchor.getBoundingClientRect();
  // A menu opened from inside another menu is opened from the same toolbar button, for focus.
  const opener = anchor.closest('.dropdown') ? (openMenu?.anchor ?? anchor) : anchor;
  openMenu?.close(false);
  const panel = h('div', { class: `dropdown${spec.wide ? ' wide' : ''}`, role: 'menu' });
  const body = h('div', { class: 'dd-body' });
  const search = spec.search ? h('input', { class: 'dd-search', placeholder: 'Find a tool…', 'aria-label': 'Find a tool', spellcheck: false }) : null;

  const draw = () => {
    clear(body);
    const q = search?.value.trim().toLowerCase() ?? '';
    let shown = 0;
    for (const sec of spec.sections) {
      const items = sec.items.filter(c => !q || c.label.toLowerCase().includes(q) || (c.title ?? '').toLowerCase().includes(q) || sec.name.toLowerCase().includes(q) || c.aka?.some(a => a.toLowerCase().includes(q)));
      if (!items.length) continue;
      shown += items.length;
      body.append(h('div', { class: 'dd-section' },
        h('div', { class: 'dd-title' }, sec.name),
        ...items.map(c => {
          const key = c.key ? hooks.keyFor(c.key) : '';
          const item = h('button', {
            class: `dd-item${c.on?.() ? ' on' : ''}`, role: 'menuitem', 'data-label': c.label, title: c.title ?? c.label,
            disabled: (!!c.needsDoc && !hooks.hasDoc()) || !!c.off?.(),
            onclick: safe(() => {
              if (c.menu) { showDropdown(item, c.menu(), hooks); return; }
              close(false);
              return c.run?.();
            }, c.label),
          }, icon(c.icon, 17), h('span', { class: 'dd-label' }, c.label), key ? h('kbd', null, key) : null, c.menu ? icon('chevRight', 12) : null);
          if (c.aka) item.dataset.aka = c.aka.join('|');
          return item;
        })));
    }
    if (!shown) body.append(h('div', { class: 'dd-empty' }, 'No tool has that name.'));
  };

  if (search) {
    search.addEventListener('input', draw);
    search.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') (body.querySelector('.dd-item:not(:disabled)') as HTMLButtonElement | null)?.click();
      if (e.key === 'Escape') close();
    });
    panel.append(search);
  }
  panel.append(body);
  draw();
  document.body.append(panel);

  const p = panel.getBoundingClientRect();
  panel.style.left = `${Math.max(6, Math.min(r.left, innerWidth - p.width - 6))}px`;
  panel.style.top = `${Math.min(r.bottom + 4, innerHeight - p.height - 6)}px`;

  const away = (e: Event) => { if (!panel.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); return; }
    if (!panel.contains(document.activeElement)) return;
    // Keys pressed in a menu belong to the menu, not to the document behind it.
    e.stopPropagation();
    const items = [...panel.querySelectorAll<HTMLButtonElement>('.dd-item:not(:disabled)')];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => { e.preventDefault(); items[(i + items.length) % items.length]?.focus(); };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? items.length - 1 : at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
  };
  const onResize = () => close();
  let closed = false;
  function close(refocus = true) {
    if (closed) return;
    closed = true;
    const hadFocus = panel.contains(document.activeElement);
    panel.remove();
    document.removeEventListener('pointerdown', away, true);
    document.removeEventListener('keydown', key, true);
    window.removeEventListener('resize', onResize);
    if (openMenu?.close === close) openMenu = null;
    if (refocus && hadFocus && opener.isConnected) opener.focus();
  }
  openMenu = { close, anchor };
  setTimeout(() => {
    if (closed) return;
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('resize', onResize);
  }, 0);
  (search ?? panel.querySelector('.dd-item:not(:disabled)') as HTMLElement | null)?.focus();
  return panel;
}

// ---- The window buttons, inside the app's own title bar ----

export function windowButtons(): HTMLElement | null {
  const webview = window.chrome?.webview;
  if (!webview) return null;
  const send = (action: string) => webview.postMessage({ type: 'win', action });
  const max = h('button', { class: 'win-btn', title: 'Maximise', 'aria-label': 'Maximise', onclick: () => send('toggle-maximize') }, icon('winMax', 14));
  const box = h('div', { class: 'win-buttons' },
    h('button', { class: 'win-btn', title: 'Minimise', 'aria-label': 'Minimise', onclick: () => send('minimize') }, icon('winMin', 14)),
    max,
    h('button', { class: 'win-btn close', title: 'Close', 'aria-label': 'Close', onclick: () => send('close') }, icon('winClose', 14)));
  webview.addEventListener('message', e => {
    const d = e.data as { type?: string; maximized?: boolean; focused?: boolean };
    if (d?.type !== 'win-state') return;
    max.replaceChildren(icon(d.maximized ? 'winRestore' : 'winMax', 14));
    max.title = d.maximized ? 'Restore' : 'Maximise';
    document.documentElement.classList.toggle('win-max', !!d.maximized);
    document.documentElement.classList.toggle('win-blur', d.focused === false);
  });
  return box;
}
