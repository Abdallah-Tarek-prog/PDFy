// Choosing a font from everything on this PC. Each name is shown in its own font, drawn only when it
// scrolls into view, so a list of a thousand fonts opens instantly and uses little memory.

import { addFontFiles, addedFontNames, favouriteFonts, fontCss, installedFonts, recentFonts, RECOMMENDED_FONTS, STANDARD_FONTS, toggleFavouriteFont, touchRecentFont } from '../study/fonts';
import type { FontFamily } from '../core/model';
import { placeNear } from './colorpicker';
import { clear, h, pickFiles, reportError, toast } from './dom';

export interface FontChoice { fontName?: string; font?: FontFamily }

let open: { close(): void } | null = null;

const SAMPLE_LIMIT = 400;

export async function openFontPicker(anchor: HTMLElement, current: FontChoice, onPick: (c: FontChoice) => void, standard = true) {
  open?.close();
  const search = h('input', { class: 'fp-search', placeholder: 'Search fonts', 'aria-label': 'Search fonts', spellcheck: false });
  const list = h('div', { class: 'fp-list', role: 'listbox', 'aria-label': 'Fonts' });
  const count = h('span', { class: 'muted' }, 'Loading…');
  const addBtn = h('button', {
    class: 'btn small',
    onclick: async () => {
      try {
        const files = await pickFiles('.ttf,.otf,.woff,.woff2', true);
        if (!files.length) return;
        const names = await addFontFiles(files);
        toast(`Added ${names.join(', ')}.`, 'ok');
        all = await everything();
        draw();
      } catch (err) { reportError('Adding the font', err); }
    },
  }, 'Add font file…');
  const panel = h('div', { class: 'popover font-popover', role: 'dialog', 'aria-label': 'Choose a font' },
    search, list, h('div', { class: 'fp-foot' }, count, addBtn));

  const seen = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target as HTMLElement;
      el.style.fontFamily = fontCss(el.dataset.font!);
      seen.unobserve(el);
    }
  }, { root: list, rootMargin: '120px' });

  const everything = async () => [...new Set([...addedFontNames(), ...await installedFonts()])].sort((a, b) => a.localeCompare(b));
  let all: string[] = [];

  const row = (name: string) => {
    const label = h('span', { class: 'fp-name', dataset: { font: name } }, name);
    seen.observe(label);
    const star = h('button', {
      class: 'fp-star', title: 'Keep at the top', 'aria-label': `Keep ${name} at the top`,
      onclick: (e: Event) => { e.stopPropagation(); toggleFavouriteFont(name); draw(); },
    }, favouriteFonts().includes(name) ? '★' : '☆');
    return h('div', {
      class: `fp-row${current.fontName === name ? ' on' : ''}`, role: 'option', 'aria-selected': String(current.fontName === name), tabindex: 0,
      onclick: () => pick({ fontName: name }),
      onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') pick({ fontName: name }); },
    }, label, star);
  };

  const section = (title: string, names: string[]) => (names.length ? [h('div', { class: 'fp-section' }, title), ...names.map(row)] : []);

  function draw() {
    clear(list);
    const q = search.value.trim().toLowerCase();
    const have = new Set(all);
    if (q) {
      const hits = all.filter(n => n.toLowerCase().includes(q));
      list.append(...hits.slice(0, SAMPLE_LIMIT).map(row));
      count.textContent = `${hits.length} of ${all.length} fonts`;
      if (!hits.length) list.append(h('div', { class: 'fp-empty' }, 'No font has that name.'));
      return;
    }
    if (standard) {
      list.append(h('div', { class: 'fp-section' }, 'Built into every PDF'), ...STANDARD_FONTS.map(f => h('div', {
        class: `fp-row${!current.fontName && (current.font ?? 'helvetica') === f.id ? ' on' : ''}`, role: 'option', tabindex: 0,
        onclick: () => pick({ font: f.id }),
      }, h('span', { class: 'fp-name' }, f.label))));
    }
    const fav = favouriteFonts().filter(n => have.has(n));
    const recent = recentFonts().filter(n => have.has(n) && !fav.includes(n));
    const yours = addedFontNames().filter(n => !fav.includes(n) && !recent.includes(n));
    const rec = RECOMMENDED_FONTS.filter(n => have.has(n) && !fav.includes(n) && !recent.includes(n));
    list.append(...section('Kept', fav), ...section('Recent', recent), ...section('Added by you', yours), ...section('Good starting points', rec), ...section('All fonts', all));
    count.textContent = `${all.length} fonts`;
  }

  function pick(c: FontChoice) {
    if (c.fontName) touchRecentFont(c.fontName);
    onPick(c);
    close();
  }
  function close() {
    seen.disconnect();
    panel.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key, true);
    open = null;
  }
  const outside = (e: Event) => { if (!panel.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  panel.addEventListener('keydown', e => e.stopPropagation());
  open = { close };

  search.addEventListener('input', draw);
  document.body.append(panel);
  placeNear(panel, anchor);
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key, true);
  search.focus();
  all = await everything();
  if (panel.isConnected) { draw(); placeNear(panel, anchor); }
}

/** A button showing the current font in that font. */
export function fontButton(current: FontChoice, onPick: (c: FontChoice) => void, standard = true): HTMLButtonElement {
  const standardLabel = (f?: FontFamily) => ({ helvetica: 'Sans', times: 'Serif', courier: 'Mono' })[f ?? 'helvetica'];
  const btn: HTMLButtonElement = h('button', {
    class: 'font-btn', title: 'Choose a font', 'aria-label': 'Choose a font',
    style: current.fontName ? { fontFamily: fontCss(current.fontName) } : null,
    onclick: () => { void openFontPicker(btn, current, onPick, standard).catch(err => reportError('Opening the fonts', err)); },
  }, current.fontName ?? standardLabel(current.font));
  return btn;
}
