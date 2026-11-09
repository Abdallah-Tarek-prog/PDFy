// Any colour: a colour field, a hue bar, typed codes, an eyedropper that reads from anywhere on screen,
// ready-made palettes, and colours you starred or used recently.

import { clear, h, icon } from './dom';

const RECENT = 'pdfy.colourRecent';
const FAV = 'pdfy.colourFavourites';

const read = (k: string): string[] => { try { return JSON.parse(localStorage.getItem(k) ?? '[]') as string[]; } catch { return []; } };
const write = (k: string, v: string[]) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* Storage may be off. */ } };

export const PALETTES: { name: string; colours: string[] }[] = [
  { name: 'Highlighters', colours: ['#ffd400', '#ffe066', '#b2f2bb', '#8ce99a', '#a5d8ff', '#74c0fc', '#ffc9c9', '#ffa8a8', '#eebefa', '#d0bfff', '#ffd8a8', '#ffc078'] },
  { name: 'Ink', colours: ['#111111', '#343a40', '#1a56db', '#0b57d0', '#0b8a4f', '#2f9e44', '#d92d20', '#c2255c', '#7048e8', '#e8590c', '#0c8599', '#845ef7'] },
  { name: 'Soft', colours: ['#f8f9fa', '#e9ecef', '#dee2e6', '#f1e7d6', '#e7f5ff', '#ebfbee', '#fff9db', '#fff0f6', '#f3f0ff', '#fff4e6', '#e6fcf5', '#f4fce3'] },
  { name: 'Night', colours: ['#dcddde', '#f1f1f3', '#a8c7fa', '#82aaff', '#7fdbca', '#81c995', '#fdd663', '#ecc48d', '#f28b82', '#c58af9', '#8ab4f8', '#9aa0a6'] },
];

export function hexToHsv(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hue = 0;
  if (d) {
    if (max === r) hue = ((g - b) / d + 6) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
  }
  return [hue, max ? d / max : 0, max];
}

export function hsvToHex(hue: number, sat: number, val: number): string {
  const f = (k: number) => {
    const x = (k + hue / 60) % 6;
    return Math.round((val - val * sat * Math.max(0, Math.min(x, 4 - x, 1))) * 255);
  };
  return `#${[f(5), f(3), f(1)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

export function normaliseHex(text: string): string | null {
  let t = text.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(t)) t = [...t].map(c => c + c).join('');
  return /^[0-9a-f]{6}$/.test(t) ? `#${t}` : null;
}

let open: { close(): void } | null = null;

/** Opens the picker beside an element. onPick runs when a colour is settled on. */
export function openColourPicker(anchor: HTMLElement, value: string, onPick: (hex: string) => void, onDismiss?: () => void) {
  open?.close();
  let [hue, sat, val] = hexToHsv(normaliseHex(value) ?? '#000000');
  let current = normaliseHex(value) ?? '#000000';

  const field = h('div', { class: 'cp-field', role: 'slider', 'aria-label': 'Saturation and brightness', tabindex: 0 });
  const dot = h('div', { class: 'cp-dot' });
  field.append(dot);
  const hueBar = h('input', { class: 'cp-hue', type: 'range', min: 0, max: 360, step: 1, value: Math.round(hue), 'aria-label': 'Hue' });
  const swatch = h('div', { class: 'cp-now' });
  const hex = h('input', { class: 'cp-hex', value: current, spellcheck: false, 'aria-label': 'Colour code', maxlength: 7 });
  const rgb = ['R', 'G', 'B'].map(l => h('input', { class: 'cp-rgb', type: 'number', min: 0, max: 255, 'aria-label': l, title: l }));
  const favBtn = h('button', { class: 'icon-btn small cp-star', title: 'Keep this colour', 'aria-label': 'Keep this colour' }, '☆');
  const lists = h('div', { class: 'cp-lists' });

  const paint = () => {
    current = hsvToHex(hue, sat, val);
    field.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hue} 100% 50%))`;
    dot.style.left = `${sat * 100}%`;
    dot.style.top = `${(1 - val) * 100}%`;
    dot.style.background = current;
    swatch.style.background = current;
    if (document.activeElement !== hex) hex.value = current;
    const n = parseInt(current.slice(1), 16);
    [(n >> 16) & 255, (n >> 8) & 255, n & 255].forEach((c, i) => { if (document.activeElement !== rgb[i]) rgb[i].value = String(c); });
    favBtn.textContent = read(FAV).includes(current) ? '★' : '☆';
  };

  const choose = (colour: string, closeAfter = false) => {
    [hue, sat, val] = hexToHsv(colour);
    hueBar.value = String(Math.round(hue));
    paint();
    onPick(colour);
    write(RECENT, [colour, ...read(RECENT).filter(c => c !== colour)].slice(0, 12));
    drawLists();
    if (closeAfter) close(true);
  };

  const swatchRow = (title: string, colours: string[]) => (colours.length ? h('div', { class: 'cp-row' },
    h('div', { class: 'cp-row-title' }, title),
    h('div', { class: 'cp-swatches' }, ...colours.map(c => h('button', { class: `cp-sw${c === current ? ' on' : ''}`, style: { background: c }, title: c, 'aria-label': `Colour ${c}`, onclick: () => choose(c) })))) : null);

  function drawLists() {
    clear(lists);
    lists.append(...[
      swatchRow('Yours', read(FAV)),
      swatchRow('Recent', read(RECENT)),
      ...PALETTES.map(p => swatchRow(p.name, p.colours)),
    ].filter(Boolean) as HTMLElement[]);
  }

  const fromPoint = (e: PointerEvent) => {
    const r = field.getBoundingClientRect();
    sat = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    val = 1 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    paint();
  };
  field.addEventListener('pointerdown', e => {
    field.setPointerCapture(e.pointerId);
    fromPoint(e);
    const move = (m: PointerEvent) => fromPoint(m);
    const up = () => { field.removeEventListener('pointermove', move); field.removeEventListener('pointerup', up); choose(current); };
    field.addEventListener('pointermove', move);
    field.addEventListener('pointerup', up);
  });
  field.addEventListener('keydown', e => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === 'ArrowLeft') sat = Math.max(0, sat - step);
    else if (e.key === 'ArrowRight') sat = Math.min(1, sat + step);
    else if (e.key === 'ArrowUp') val = Math.min(1, val + step);
    else if (e.key === 'ArrowDown') val = Math.max(0, val - step);
    else return;
    e.preventDefault();
    paint();
    onPick(current);
  });
  hueBar.addEventListener('input', () => { hue = +hueBar.value; paint(); });
  hueBar.addEventListener('change', () => choose(current));
  hex.addEventListener('change', () => { const c = normaliseHex(hex.value); if (c) choose(c); else hex.value = current; });
  hex.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { const c = normaliseHex(hex.value); if (c) choose(c, true); } });
  rgb.forEach(input => {
    input.addEventListener('keydown', e => e.stopPropagation());
    input.addEventListener('change', () => {
      const [r, g, b] = rgb.map(x => Math.max(0, Math.min(255, +x.value || 0)));
      choose(`#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`);
    });
  });
  favBtn.addEventListener('click', () => {
    const list = read(FAV);
    write(FAV, list.includes(current) ? list.filter(c => c !== current) : [current, ...list].slice(0, 24));
    paint();
    drawLists();
  });

  const Dropper = (window as unknown as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper;
  const dropper = Dropper ? h('button', {
    class: 'icon-btn small', title: 'Pick a colour from anywhere on screen', 'aria-label': 'Pick a colour from the screen',
    onclick: async () => {
      try { const r = await new Dropper().open(); const c = normaliseHex(r.sRGBHex); if (c) choose(c); } catch { /* Cancelled. */ }
    },
  }, icon('marker', 14)) : null;

  const panel = h('div', { class: 'popover colour-popover', role: 'dialog', 'aria-label': 'Choose a colour' },
    field, hueBar,
    h('div', { class: 'cp-codes' }, swatch, hex, ...rgb, dropper, favBtn),
    lists);

  function close(returnFocus = false) {
    if (!panel.isConnected) return;
    panel.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key, true);
    open = null;
    if (returnFocus) onDismiss?.();
  }
  const outside = (e: Event) => { if (!panel.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(true); } };
  open = { close };

  document.body.append(panel);
  drawLists();
  paint();
  placeNear(panel, anchor);
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key, true);
  return { el: panel, close };
}

/** Puts a floating panel under an element, keeping it on screen. */
export function placeNear(panel: HTMLElement, anchor: HTMLElement) {
  const a = anchor.getBoundingClientRect(), p = panel.getBoundingClientRect();
  const left = Math.max(8, Math.min(a.left, innerWidth - p.width - 8));
  const top = a.bottom + 6 + p.height < innerHeight - 8 ? a.bottom + 6 : Math.max(8, a.top - p.height - 6);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

/** A small button showing a colour. Clicking it opens the picker. */
export function colourButton(value: string, onPick: (hex: string) => void, label = 'Choose a colour'): HTMLButtonElement {
  const btn: HTMLButtonElement = h('button', {
    class: 'colour-btn', title: label, 'aria-label': label, style: { background: value },
    onclick: () => openColourPicker(btn, btn.dataset.value ?? value, c => { btn.dataset.value = c; btn.style.background = c; onPick(c); }),
  });
  btn.dataset.value = value;
  return btn;
}
