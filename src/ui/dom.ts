import { ICONS } from './icons';

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k in el && k !== 'list') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function s(tag: string, attrs?: Record<string, string | number | null | undefined>, ...children: (Node | null)[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  for (const c of children) if (c) el.append(c);
  return el as SVGElement;
}

export function icon(name: string, size = 18): SVGElement {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '1.75');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = ICONS[name] ?? ICONS.square;
  return el as unknown as SVGElement;
}

export const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document): T => root.querySelector(sel) as T;

export function clear(el: Element) { el.replaceChildren(); }

/** Runs a user action. Any failure becomes a message on screen and never takes the app down. */
export function safe<A extends unknown[]>(fn: (...a: A) => unknown, what = 'That action'): (...a: A) => void {
  return (...a: A) => {
    try {
      const r = fn(...a);
      if (r instanceof Promise) r.catch(err => reportError(what, err));
    } catch (err) { reportError(what, err); }
  };
}

export function reportError(what: string, err: unknown) {
  console.error(what, err);
  toast(`${what} failed: ${(err as Error)?.message ?? err}`, 'error');
}

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: 'info' | 'error' | 'ok' = 'info', ms = kind === 'error' ? 7000 : 3200) {
  if (!toastHost) { toastHost = h('div', { class: 'toasts', 'aria-live': 'polite' }); document.body.append(toastHost); }
  const t = h('div', { class: `toast ${kind}` }, message);
  toastHost.append(t);
  while (toastHost.children.length > 4) toastHost.firstElementChild!.remove();
  setTimeout(() => t.remove(), ms);
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise(resolve => {
    const input = h('input', { type: 'file', accept, multiple });
    input.addEventListener('change', () => resolve([...(input.files ?? [])]));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

export const baseName = (n: string) => n.replace(/\.[^.]+$/, '');

/** Parses "1-3, 5, 8-" into zero-based page indexes. Invalid numbers are ignored. */
export function parseRanges(text: string, total: number): number[] {
  const out: number[] = [];
  for (const part of text.split(',')) {
    const m = part.trim().match(/^(\d*)\s*-?\s*(\d*)$/);
    if (!m || (!m[1] && !m[2])) continue;
    const hasDash = part.includes('-');
    const a = m[1] ? +m[1] : 1;
    const b = hasDash ? (m[2] ? +m[2] : total) : a;
    for (let i = Math.max(1, Math.min(a, b)); i <= Math.min(total, Math.max(a, b)); i++) out.push(i - 1);
  }
  return out;
}
