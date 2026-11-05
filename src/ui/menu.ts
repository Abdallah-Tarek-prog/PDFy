// A right-click menu. It closes on any click elsewhere, on Escape, or when the page scrolls.

import { h, icon } from './dom';

export interface MenuItem { label: string; icon?: string; run: () => unknown; danger?: boolean; disabled?: boolean; key?: string }

let open: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

export function closeMenu() {
  open?.remove();
  open = null;
  cleanup?.();
  cleanup = null;
}

export function showMenu(x: number, y: number, items: (MenuItem | null)[]) {
  closeMenu();
  const el = h('div', { class: 'ctx-menu', role: 'menu' });
  for (const it of items) {
    if (!it) { el.append(h('div', { class: 'ctx-sep', role: 'separator' })); continue; }
    el.append(h('button', {
      class: `ctx-item${it.danger ? ' danger' : ''}`, role: 'menuitem', disabled: it.disabled,
      onclick: () => { closeMenu(); it.run(); },
    }, it.icon ? icon(it.icon, 15) : h('span', { class: 'ctx-space' }), h('span', { class: 'ctx-label' }, it.label), it.key ? h('kbd', null, it.key) : null));
  }
  document.body.append(el);
  // Keep it on screen.
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 6))}px`;
  el.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 6))}px`;
  open = el;
  const away = (e: Event) => { if (!el.contains(e.target as Node)) closeMenu(); };
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } };
  document.addEventListener('pointerdown', away, true);
  document.addEventListener('keydown', key, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);
  cleanup = () => {
    document.removeEventListener('pointerdown', away, true);
    document.removeEventListener('keydown', key, true);
    window.removeEventListener('blur', closeMenu);
    window.removeEventListener('resize', closeMenu);
  };
  (el.querySelector('button:not(:disabled)') as HTMLElement | null)?.focus();
}
