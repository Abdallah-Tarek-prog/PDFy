// The floating bar on a selected image. This is where the theme conversion is used.

import { annotBounds } from '../core/geometry';
import { toScreen, type Annot, type PageRef, type ThemeMode } from '../core/model';
import { applyTheme, ensureAnalysis, rotateImageAnnot, type ThemeChoice } from '../features/images';
import { customStyle, saveCustomStyle, THEME_STYLES } from '../theme/presets';
import { formDialog } from './dialogs';
import type { Viewer } from '../view/viewer';
import { blobUrl } from '../view/overlay';
import { h, icon, reportError, toast } from './dom';

const MODES: { id: ThemeMode; label: string; title: string }[] = [
  { id: 'original', label: 'Original', title: 'Show the image as it was pasted' },
  { id: 'light', label: 'Light', title: 'Convert to a light theme' },
  { id: 'dark', label: 'Dark', title: 'Convert to a dark theme' },
  { id: 'match', label: 'Match page', title: 'Convert to fit the page behind the image' },
];

export function pasteMode(): 'off' | 'match' | 'light' | 'dark' {
  try {
    const v = localStorage.getItem('pdfy.pasteMode');
    if (v === 'match' || v === 'light' || v === 'dark') return v;
  } catch { /* Storage may be off. */ }
  return 'off';
}

export class ImageBar {
  readonly el: HTMLElement;
  private info: HTMLElement;
  private modeBtns = new Map<ThemeMode, HTMLButtonElement>();
  private styleSel: HTMLSelectElement;
  private photos: HTMLInputElement;
  private run = 0;
  private busy = false;

  private autoSel: HTMLSelectElement;

  constructor(private viewer: Viewer, onDelete: () => void, onCrop: () => void) {
    this.autoSel = h('select', { class: 'ib-select', title: 'What happens to images you paste from now on', 'aria-label': 'When pasting' },
      ...[['off', 'On paste: keep'], ['match', 'On paste: match page'], ['light', 'On paste: light'], ['dark', 'On paste: dark']].map(([v, t]) => h('option', { value: v, selected: pasteMode() === v }, t)));
    this.autoSel.addEventListener('change', () => {
      try { localStorage.setItem('pdfy.pasteMode', this.autoSel.value); } catch { /* Storage may be off. */ }
    });
    this.info = h('span', { class: 'ib-info' });
    this.styleSel = h('select', { class: 'ib-select', title: 'Colour style', 'aria-label': 'Colour style' },
      ...THEME_STYLES.map(s => h('option', { value: s.id }, s.name)), h('option', { value: 'custom' }, 'Custom…'));
    this.photos = h('input', { type: 'checkbox', checked: true });
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Image theme' });
    for (const m of MODES) {
      const b = h('button', { class: 'seg-btn', title: m.title, onclick: () => this.choose({ mode: m.id }) }, m.label);
      this.modeBtns.set(m.id, b);
      seg.append(b);
    }
    this.styleSel.addEventListener('change', () => void this.styleChanged());
    this.photos.addEventListener('change', () => this.choose({ keepPhotos: this.photos.checked }));

    const compare = h('button', { class: 'ib-btn', title: 'Hold to see the original' }, icon('compareHold', 16));
    const swap = (show: boolean) => {
      const sel = this.viewer.selectedAnnot();
      const img = sel?.annot.image;
      const v = sel && this.viewer.views.get(sel.page.id);
      if (!img || !v) return;
      const node = v.annotsG.querySelector(`[data-id="${sel.annot.id}"] image`);
      node?.setAttribute('href', blobUrl(show ? img.original : img.blob));
    };
    compare.addEventListener('pointerdown', () => swap(true));
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) compare.addEventListener(ev, () => swap(false));

    this.el = h('div', { class: 'image-bar', role: 'toolbar', 'aria-label': 'Image options', style: { display: 'none' } },
      seg,
      this.styleSel,
      h('label', { class: 'ib-check', title: 'Leave photos inside the image unchanged' }, this.photos, 'Keep photos'),
      compare,
      h('button', { class: 'ib-btn', title: 'Rotate 90°', onclick: () => this.rotate() }, icon('rotateImage', 16)),
      h('button', { class: 'ib-btn', title: 'Crop: drag over the part to keep', onclick: () => onCrop() }, icon('crop', 16)),
      this.autoSel,
      h('button', { class: 'ib-btn danger', title: 'Delete', onclick: onDelete }, icon('trash', 16)),
      this.info,
    );
    viewer.sizer.append(this.el);
    this.el.addEventListener('pointerdown', e => e.stopPropagation());
  }

  private async styleChanged() {
    let value = this.styleSel.value;
    if (value === 'custom') {
      const c = customStyle();
      const f = await formDialog('Custom colours', [
        { key: 'lb', label: 'Light theme: background', type: 'color', value: c.light.bg },
        { key: 'ls', label: 'Light theme: panels and code blocks', type: 'color', value: c.light.surface },
        { key: 'lt', label: 'Light theme: text', type: 'color', value: c.light.text },
        { key: 'db', label: 'Dark theme: background', type: 'color', value: c.dark.bg },
        { key: 'ds', label: 'Dark theme: panels and code blocks', type: 'color', value: c.dark.surface },
        { key: 'dt', label: 'Dark theme: text', type: 'color', value: c.dark.text },
      ], 'Use these');
      if (!f) { this.sync(); return; }
      saveCustomStyle({ bg: String(f.lb), surface: String(f.ls), text: String(f.lt) }, { bg: String(f.db), surface: String(f.ds), text: String(f.dt) });
    }
    try { localStorage.setItem('pdfy.imageStyle', value); } catch { /* Storage may be off. */ }
    value = this.styleSel.value;
    void this.choose({ style: value });
  }

  private rotate() {
    const sel = this.viewer.selectedAnnot();
    if (sel && this.viewer.session) rotateImageAnnot(this.viewer.session, sel.page, sel.annot);
  }

  private current(): { page: PageRef; annot: Annot } | null {
    const sel = this.viewer.selectedAnnot();
    return sel?.annot.kind === 'image' && sel.annot.image ? sel : null;
  }

  async choose(change: Partial<ThemeChoice>) {
    const sel = this.current();
    const session = this.viewer.session;
    if (!sel || !session) return;
    const img = sel.annot.image!;
    const choice: ThemeChoice = {
      mode: change.mode ?? img.theme,
      style: change.style ?? this.styleSel.value,
      keepPhotos: change.keepPhotos ?? this.photos.checked,
    };
    // Picking a style while on Original is a clear request for that style's opposite theme.
    if (change.style && img.theme === 'original') {
      choice.mode = img.analysis?.isDark ? 'light' : 'dark';
    }
    if (change.mode === undefined && change.style === undefined && choice.mode === 'original') {
      img.keepPhotos = choice.keepPhotos;
      return;
    }
    const token = ++this.run;
    this.busy = true;
    this.setInfo('Converting…');
    const started = performance.now();
    try {
      await applyTheme(session, sel.page, sel.annot, choice);
      if (token === this.run) this.setInfo(this.describe(this.current()?.annot, performance.now() - started));
    } catch (err) {
      reportError('Converting the image', err);
      if (token === this.run) this.setInfo('');
    } finally {
      if (token === this.run) this.busy = false;
      this.sync();
    }
  }

  private setInfo(t: string) { this.info.textContent = t; }

  private describe(a: Annot | undefined, ms?: number): string {
    const an = a?.image?.analysis;
    if (!an) return '';
    const pics = an.photos.length;
    const img = a!.image!;
    const covered = an.photos.reduce((n, p) => n + p.w * p.h, 0) / (img.width * img.height || 1);
    if (covered > 0.6 && img.keepPhotos) return 'This looks like a photo, so it stays as it is. Untick Keep photos to convert it.';
    const photos = pics ? `, and ${pics} photo${pics > 1 ? 's' : ''} inside ${pics > 1 ? 'are' : 'is'} left as ${pics > 1 ? 'they are' : 'it is'}` : '';
    const time = ms !== undefined ? ` Converted in ${Math.round(ms)} ms.` : '';
    return `This image is ${an.isDark ? 'dark' : 'light'}${photos}.${time}`;
  }

  /** Shows the bar for the selected image and updates its state. */
  sync() {
    const sel = this.current();
    if (!sel) { this.el.style.display = 'none'; return; }
    const v = this.viewer.views.get(sel.page.id);
    if (!v) { this.el.style.display = 'none'; return; }
    const img = sel.annot.image!;
    for (const [id, b] of this.modeBtns) b.classList.toggle('active', id === img.theme);
    if (img.theme !== 'original' || !this.styleSel.dataset.touched) this.styleSel.value = img.style;
    this.photos.checked = img.keepPhotos;

    const b = annotBounds(sel.annot);
    const pts = [toScreen(v.vp, b[0], b[1]), toScreen(v.vp, b[2], b[3])];
    const top = Math.min(pts[0][1], pts[1][1]);
    const left = Math.min(pts[0][0], pts[1][0]);
    const px = parseFloat(v.el.style.left) + left, py = parseFloat(v.el.style.top) + top;
    this.el.style.display = 'flex';
    const barH = this.el.offsetHeight || 44;
    const barW = this.el.offsetWidth || 560;
    const maxLeft = Math.max(8, this.viewer.sizer.offsetWidth - barW - 8);
    this.el.style.left = `${Math.max(8, Math.min(px, maxLeft))}px`;
    this.el.style.top = `${Math.max(4, py - barH - 10)}px`;

    if (!img.analysis) {
      void ensureAnalysis(img).then(() => { if (this.current()?.annot.image === img && !this.busy) this.setInfo(this.describe(this.current()?.annot)); this.sync(); }).catch(() => {});
    } else if (!this.busy) {
      this.setInfo(this.describe(sel.annot));
    }
  }

  hintAfterPaste(a: Annot) {
    const an = a.image?.analysis;
    if (an) toast(`Pasted. It looks ${an.isDark ? 'dark' : 'light'}.`, 'ok');
  }
}
