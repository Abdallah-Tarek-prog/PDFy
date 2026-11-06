// Modal windows. Each returns a promise, and all of them can be closed with Escape.

import { clear, h, icon } from './dom';

export interface DialogButton<T> { label: string; value: T; primary?: boolean; danger?: boolean }

export function openDialog<T>(title: string, body: Node, buttons: DialogButton<T>[], dismissValue: T, onOpen?: (close: (v: T) => void) => void, wide = false): Promise<T> {
  return new Promise<T>(resolve => {
    const previous = document.activeElement as HTMLElement | null;
    const close = (v: T) => {
      overlay.remove();
      document.removeEventListener('keydown', key, true);
      previous?.focus?.();
      resolve(v);
    };
    const key = (e: KeyboardEvent) => {
      // Only the window on top answers, so Escape in a window opened from another closes just that one.
      if (overlay !== [...document.querySelectorAll('.overlay-bg')].pop()) return;
      if (e.key === 'Escape') { e.stopPropagation(); close(dismissValue); }
      if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
        const p = buttons.find(b => b.primary);
        if (p) { e.preventDefault(); close(p.value); }
      }
    };
    const panel = h('div', { class: `dialog${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'dialog-head' },
        h('h2', null, title),
        h('button', { class: 'icon-btn', title: 'Close', 'aria-label': 'Close', onclick: () => close(dismissValue) }, icon('close', 16))),
      h('div', { class: 'dialog-body' }, body),
      buttons.length ? h('div', { class: 'dialog-foot' }, ...buttons.map(b =>
        h('button', { class: `btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}`, onclick: () => close(b.value) }, b.label))) : null);
    const overlay = h('div', { class: 'overlay-bg', onpointerdown: (e: Event) => { if (e.target === overlay) close(dismissValue); } }, panel);
    document.body.append(overlay);
    document.addEventListener('keydown', key, true);
    const first = panel.querySelector<HTMLElement>('input, select, textarea, .dialog-foot .primary');
    first?.focus();
    onOpen?.(close);
  });
}

export const confirmDialog = (title: string, text: string, ok = 'OK', danger = false) =>
  openDialog(title, h('p', null, text), [{ label: 'Cancel', value: false }, { label: ok, value: true, primary: true, danger }], false);

export function alertDialog(title: string, text: string) {
  return openDialog(title, h('p', { style: { whiteSpace: 'pre-wrap' } }, text), [{ label: 'OK', value: true, primary: true }], true);
}

export type Field =
  | { key: string; label: string; type: 'text' | 'password' | 'number'; value?: string | number; placeholder?: string; min?: number; max?: number; step?: number; hint?: string }
  | { key: string; label: string; type: 'textarea'; value?: string; hint?: string }
  | { key: string; label: string; type: 'select'; value?: string; options: { value: string; label: string }[]; hint?: string }
  | { key: string; label: string; type: 'check'; value?: boolean; hint?: string }
  | { key: string; label: string; type: 'color'; value?: string; hint?: string };

export type FormValues = Record<string, string | number | boolean>;

/** A form window. Returns the values, or null if cancelled. */
export async function formDialog(title: string, fields: Field[], okLabel = 'OK', intro?: string): Promise<FormValues | null> {
  const inputs = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
  const rows = fields.map(f => {
    let ctl: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (f.type === 'select') {
      ctl = h('select', { id: `f-${f.key}` }, ...f.options.map(o => h('option', { value: o.value, selected: o.value === f.value }, o.label)));
    } else if (f.type === 'textarea') {
      ctl = h('textarea', { id: `f-${f.key}`, value: f.value ?? '', rows: 3 });
    } else if (f.type === 'check') {
      ctl = h('input', { id: `f-${f.key}`, type: 'checkbox', checked: !!f.value });
    } else if (f.type === 'color') {
      ctl = h('input', { id: `f-${f.key}`, type: 'color', value: f.value ?? '#000000' });
    } else {
      ctl = h('input', {
        id: `f-${f.key}`, type: f.type, value: f.value ?? '', placeholder: f.placeholder ?? '',
        min: f.type === 'number' ? f.min : undefined, max: f.type === 'number' ? f.max : undefined, step: f.type === 'number' ? f.step : undefined,
      });
    }
    inputs.set(f.key, ctl);
    if (f.type === 'check') return h('label', { class: 'field-row check-row' }, ctl, f.label, f.hint ? h('small', null, f.hint) : null);
    return h('div', { class: 'field-row' }, h('label', { for: `f-${f.key}` }, f.label), ctl, f.hint ? h('small', null, f.hint) : null);
  });
  const body = h('div', { class: 'form' }, intro ? h('p', null, intro) : null, ...rows);
  const ok = await openDialog(title, body, [{ label: 'Cancel', value: false }, { label: okLabel, value: true, primary: true }], false);
  if (!ok) return null;
  const out: FormValues = {};
  for (const f of fields) {
    const el = inputs.get(f.key)!;
    if (f.type === 'check') out[f.key] = (el as HTMLInputElement).checked;
    else if (f.type === 'number') out[f.key] = +(el as HTMLInputElement).value;
    else out[f.key] = el.value;
  }
  return out;
}

export function askPassword(name: string, retry: boolean): Promise<string | null> {
  const input = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Password' });
  const body = h('div', { class: 'form' },
    h('p', null, retry ? 'That password is not correct. Try again.' : `"${name}" is protected by a password.`), input);
  return openDialog<string | null>('Password needed', body, [{ label: 'Cancel', value: null }, { label: 'Open', value: '\u0000ok', primary: true }], null)
    .then(v => (v === '\u0000ok' ? input.value : null));
}

export interface ProgressHandle { set(fraction: number, text?: string): void; cancelled(): boolean; close(): void }

/** Long jobs show this. The interface stays responsive and most jobs can be cancelled. */
export function progressDialog(title: string, cancellable = true): ProgressHandle {
  let cancelled = false;
  const bar = h('div', { class: 'progress-fill' });
  const label = h('div', { class: 'progress-label' }, 'Starting…');
  const panel = h('div', { class: 'dialog', role: 'dialog', 'aria-label': title },
    h('div', { class: 'dialog-head' }, h('h2', null, title)),
    h('div', { class: 'dialog-body' }, h('div', { class: 'progress' }, bar), label),
    cancellable ? h('div', { class: 'dialog-foot' }, h('button', { class: 'btn', onclick: () => { cancelled = true; label.textContent = 'Stopping…'; } }, 'Cancel')) : null);
  const overlay = h('div', { class: 'overlay-bg' }, panel);
  document.body.append(overlay);
  return {
    set(f, text) {
      bar.style.width = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`;
      if (text && !cancelled) label.textContent = text;
    },
    cancelled: () => cancelled,
    close: () => overlay.remove(),
  };
}

/** Takes pictures with the PC's camera. Each one becomes a page. */
export async function cameraDialog(): Promise<Blob[]> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 2560 }, height: { ideal: 1440 } } });
  } catch (err) {
    await alertDialog('Camera', `No camera could be used. ${(err as Error).message}`);
    return [];
  }
  const video = h('video', { class: 'scan-video', autoplay: true, playsInline: true, muted: true });
  video.srcObject = stream;
  const shots: Blob[] = [];
  const strip = h('div', { class: 'scan-strip' });
  const take = h('button', {
    class: 'btn', onclick: () => {
      const c = document.createElement('canvas');
      c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext('2d')!.drawImage(video, 0, 0);
      c.toBlob(b => {
        if (!b) return;
        shots.push(b);
        strip.append(h('img', { src: URL.createObjectURL(b), alt: `Scan ${shots.length}` }));
      }, 'image/jpeg', 0.9);
    },
  }, 'Take picture');
  const ok = await openDialog('Scan with camera', h('div', null, video, h('div', { class: 'scan-actions' }, take), strip),
    [{ label: 'Cancel', value: false }, { label: 'Add pages', value: true, primary: true }], false);
  stream.getTracks().forEach(t => t.stop());
  return ok ? shots : [];
}

const SIG_KEY = 'pdfy.signatures';

export function savedSignatures(): string[] {
  try { return JSON.parse(localStorage.getItem(SIG_KEY) ?? '[]'); } catch { return []; }
}

function storeSignature(dataUrl: string) {
  const list = [dataUrl, ...savedSignatures().filter(s => s !== dataUrl)].slice(0, 6);
  try { localStorage.setItem(SIG_KEY, JSON.stringify(list)); } catch { /* Storage full: it still works for now. */ }
}

const dataUrlToBlob = async (u: string) => (await fetch(u)).blob();

/** Draw, type, upload or reuse a signature. Saved ones stay on this PC only. */
export function signatureDialog(): Promise<Blob | null> {
  const draw = h('canvas', { class: 'sig-pad', width: 560, height: 180 });
  const ctx = draw.getContext('2d')!;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 2.4; ctx.strokeStyle = '#10204b';
  let drawn = false, last: [number, number] | null = null;
  const at = (e: PointerEvent): [number, number] => {
    const r = draw.getBoundingClientRect();
    return [(e.clientX - r.left) * (draw.width / r.width), (e.clientY - r.top) * (draw.height / r.height)];
  };
  draw.addEventListener('pointerdown', e => { draw.setPointerCapture(e.pointerId); last = at(e); });
  draw.addEventListener('pointermove', e => {
    if (!last) return;
    const p = at(e);
    ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
    last = p; drawn = true;
  });
  draw.addEventListener('pointerup', () => { last = null; });

  const typed = h('input', { type: 'text', placeholder: 'Type your name', class: 'sig-typed' });
  const typedPreview = h('div', { class: 'sig-preview' });
  typed.addEventListener('input', () => { typedPreview.textContent = typed.value; });

  let uploaded: Blob | null = null;
  const file = h('input', { type: 'file', accept: 'image/*' });
  file.addEventListener('change', () => { uploaded = file.files?.[0] ?? null; });

  const savedHost = h('div', { class: 'sig-saved' });
  const panes: Record<string, HTMLElement> = {
    draw: h('div', null, draw, h('button', { class: 'btn small', onclick: () => { ctx.clearRect(0, 0, draw.width, draw.height); drawn = false; } }, 'Clear')),
    type: h('div', { class: 'form' }, typed, typedPreview),
    upload: h('div', { class: 'form' }, h('p', null, 'Choose a picture of your signature.'), file),
    saved: savedHost,
  };
  let active = savedSignatures().length ? 'saved' : 'draw';
  const pane = h('div', { class: 'sig-pane' });
  const tabs = h('div', { class: 'seg' });
  const render = () => {
    clear(tabs);
    for (const id of ['draw', 'type', 'upload', 'saved']) {
      tabs.append(h('button', { class: `seg-btn${active === id ? ' active' : ''}`, onclick: () => { active = id; render(); } }, id[0].toUpperCase() + id.slice(1)));
    }
    clear(pane);
    pane.append(panes[active]);
  };

  return new Promise<Blob | null>(resolve => {
    let done: ((v: boolean) => void) | null = null;
    const list = savedSignatures();
    savedHost.append(list.length ? h('div', { class: 'sig-list' }, ...list.map(u => h('button', {
      class: 'sig-item', title: 'Use this signature',
      onclick: async () => { const b = await dataUrlToBlob(u); resolve(b); done?.(false); },
    }, h('img', { src: u, alt: 'Saved signature' })))) : h('p', null, 'No saved signatures yet.'));
    render();
    void openDialog('Your signature', h('div', null, tabs, pane), [{ label: 'Cancel', value: false }, { label: 'Use signature', value: true, primary: true }], false, close => { done = close; })
      .then(async ok => {
        if (!ok) { resolve(null); return; }
        let blob: Blob | null = null;
        if (active === 'draw' && drawn) blob = await trimmedCanvas(draw);
        else if (active === 'type' && typed.value.trim()) blob = await typedSignature(typed.value.trim());
        else if (active === 'upload') blob = uploaded;
        if (blob && active !== 'upload') {
          const reader = new FileReader();
          reader.onload = () => storeSignature(String(reader.result));
          reader.readAsDataURL(blob);
        }
        resolve(blob);
      });
  });
}

async function trimmedCanvas(c: HTMLCanvasElement): Promise<Blob> {
  const ctx = c.getContext('2d')!;
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  const out = new OffscreenCanvas(Math.max(1, x1 - x0 + 8), Math.max(1, y1 - y0 + 8));
  out.getContext('2d')!.drawImage(c, x0 - 4, y0 - 4, out.width, out.height, 0, 0, out.width, out.height);
  return out.convertToBlob({ type: 'image/png' });
}

async function typedSignature(text: string): Promise<Blob> {
  const size = 64;
  const font = `italic ${size}px "Segoe Script", "Lucida Handwriting", cursive`;
  const probe = new OffscreenCanvas(10, 10).getContext('2d')!;
  probe.font = font;
  const canvas = new OffscreenCanvas(Math.ceil(probe.measureText(text).width) + 24, Math.ceil(size * 1.6));
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  ctx.fillStyle = '#10204b';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 12, canvas.height / 2);
  return canvas.convertToBlob({ type: 'image/png' });
}
