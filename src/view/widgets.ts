// Things already inside the PDF: form fields, links and existing annotations.

import type { PDFPageProxy } from '../core/engine';
import { pointsBounds, toScreen, uid, type Annot, type Kind, type PageRef } from '../core/model';
import type { Session } from '../core/session';
import { readMarker } from '../study/markdown';
import { allThemes, customThemes, saveCustomThemes, type MdTheme } from '../study/mdthemes';
import { h } from '../ui/dom';
import type { PageView, Viewer } from './viewer';

/* eslint-disable @typescript-eslint/no-explicit-any */

const toHex = (c: ArrayLike<number> | null | undefined, fallback: string) => {
  if (!c || c.length < 3) return fallback;
  return '#' + [c[0], c[1], c[2]].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
};

const KIND_OF: Record<string, Kind> = {
  Highlight: 'highlight', Underline: 'underline', StrikeOut: 'strikeout', Squiggly: 'squiggly',
  Ink: 'ink', Square: 'rect', Circle: 'ellipse', Line: 'line', Polygon: 'polygon', PolyLine: 'polyline',
  FreeText: 'text', Text: 'note', Stamp: 'stamp', FileAttachment: 'attachment',
};

/** A theme saved inside a file, added here if this PC does not have it yet. Values are checked when drawn. */
function adoptTheme(raw: unknown) {
  if (!raw || typeof raw !== 'object') return;
  const t = raw as Partial<MdTheme>;
  if (typeof t.id !== 'string' || !/^[\w-]{1,60}$/.test(t.id) || allThemes().some(x => x.id === t.id)) return;
  const theme = { ...allThemes()[0], ...t, builtIn: false, name: `${String(t.name ?? 'Theme').slice(0, 60)} (from a file)` } as MdTheme;
  saveCustomThemes([...customThemes(), theme]);
}

/** Existing annotations become selectable ghosts. The PDF engine keeps drawing them until edited. */
export async function loadGhosts(session: Session, page: PageRef, pdfPage: PDFPageProxy) {
  if (page.ghostsLoaded) return;
  page.ghostsLoaded = true;
  let list: any[];
  try { list = await pdfPage.getAnnotations({ intent: 'display' }); } catch { return; }
  const added: Annot[] = [];
  // Replies and review states are attached to their parent, not shown as separate comments.
  const threads = new Map<string, any[]>();
  for (const d of list) if (d.inReplyTo) (threads.get(d.inReplyTo) ?? threads.set(d.inReplyTo, []).get(d.inReplyTo)!).push(d);
  for (const d of list) {
    if (d.inReplyTo) continue;
    const kind = KIND_OF[d.subtype];
    if (!kind || !d.rect || !d.id) continue;
    const a: Annot = {
      id: uid(), kind, ghost: true, importedFrom: d.id,
      rect: [Math.min(d.rect[0], d.rect[2]), Math.min(d.rect[1], d.rect[3]), Math.max(d.rect[0], d.rect[2]), Math.max(d.rect[1], d.rect[3])],
      color: toHex(d.color, '#000000'),
      opacity: d.opacity ?? 1,
      width: d.borderStyle?.width ?? 1,
      fill: d.interiorColor ? toHex(d.interiorColor, '#ffffff') : null,
      contents: d.contentsObj?.str || undefined,
      author: d.titleObj?.str || undefined,
    };
    if (d.quadPoints) {
      const q: number[][] = [];
      for (let i = 0; i + 7 < d.quadPoints.length; i += 8) q.push(Array.from(d.quadPoints.slice(i, i + 8)));
      a.quads = q;
    }
    if (d.inkLists) a.paths = d.inkLists.map((l: ArrayLike<number>) => Array.from(l));
    if (d.lineCoordinates) a.pts = Array.from(d.lineCoordinates);
    if (d.vertices) {
      a.pts = d.vertices[0]?.x !== undefined ? d.vertices.flatMap((v: any) => [v.x, v.y]) : Array.from(d.vertices);
    }
    if (kind === 'text') {
      a.text = d.textContent?.join?.('\n') ?? d.contentsObj?.str ?? '';
      a.fontSize = d.defaultAppearanceData?.fontSize || 12;
      a.textColor = toHex(d.defaultAppearanceData?.fontColor, '#000000');
    }
    const thread = threads.get(d.id);
    if (thread) {
      a.importedReplies = thread.map(t => t.id);
      a.replies = thread.filter(t => !t.stateModel).map(t => ({ id: t.id, author: t.titleObj?.str ?? '', text: t.contentsObj?.str ?? '', when: 0 }));
      const review = thread.filter(t => t.stateModel === 'Review').pop();
      if (review?.state) a.status = String(review.state).toLowerCase() as Annot['status'];
    }
    if (kind === 'stamp') a.text = d.contentsObj?.str || 'Stamp';
    // Boxes PDFy made itself keep what they need in the comment field, so they stay editable.
    const marked = readMarker(d.contentsObj?.str);
    if (marked) {
      a.contents = undefined;
      const r = marked.data.r;
      if (Array.isArray(r) && r.length === 4 && r.every(n => Number.isFinite(n)) && r[2] > r[0] && r[3] > r[1]) a.rect = r as Annot['rect'];
      if (Number.isFinite(marked.data.ang)) a.angle = Number(marked.data.ang);
      if (marked.data.math) {
        a.kind = 'math';
        a.latex = marked.text.replace(/^\$\$|\$\$$/g, '');
        a.mathDisplay = !!marked.data.display;
        a.fontSize = Number(marked.data.size) || 16;
      } else if (marked.data.md) {
        a.text = marked.text;
        a.markdown = true;
        a.mdTheme = String(marked.data.theme ?? '');
        adoptTheme(marked.data.td);
        a.fontSize = Number(marked.data.size) || 12;
      } else if (marked.data.font) {
        a.text = marked.text;
        a.fontName = String(marked.data.font);
        a.bold = !!marked.data.b;
        a.italic = !!marked.data.i;
      }
    }
    if (kind === 'attachment') {
      const name = d.file?.filename ?? 'attachment';
      const audio = /\.(webm|ogg|oga|opus|mp3|wav|m4a|aac)$/i.exec(name);
      a.attachment = {
        name, fileId: d.fileId, voice: d.name === 'Speaker' || !!audio,
        mime: audio ? `audio/${audio[1].toLowerCase().replace('mp3', 'mpeg').replace('m4a', 'mp4').replace('oga', 'ogg').replace('opus', 'ogg')}` : '',
      };
    }
    if (a.pts && kind !== 'text') {
      const b = pointsBounds(a.pts);
      if (!Number.isFinite(b[0])) delete a.pts;
    }
    added.push(a);
  }
  if (added.length) {
    page.annots.unshift(...added);
    session.emit({ kind: 'annots', pageIds: [page.id] });
  }
}

/**
 * Form fields made in PDFy, fillable straight away in Read, before the form is ever saved. Edit mode
 * shows them as boxes to move and resize instead. Controls are kept between redraws, so moving from
 * one field to the next with Tab never loses the cursor.
 */
export function buildOwnFields(viewer: Viewer, v: PageView) {
  const session = viewer.session;
  const fields = v.page.annots.filter(a => a.field && !a.ghost && a.field.type !== 'signature');
  let host = v.el.querySelector(':scope > .own-fields') as HTMLElement | null;
  if (!fields.length) { host?.remove(); return; }
  if (!host) { host = h('div', { class: 'own-fields' }); v.el.append(host); }
  const keep = new Set<string>();
  for (const a of fields) {
    const f = a.field!;
    keep.add(a.id);
    const p0 = toScreen(v.vp, a.rect[0], a.rect[1]), p1 = toScreen(v.vp, a.rect[2], a.rect[3]);
    const box = { left: `${Math.min(p0[0], p1[0])}px`, top: `${Math.min(p0[1], p1[1])}px`, width: `${Math.abs(p1[0] - p0[0])}px`, height: `${Math.abs(p1[1] - p0[1])}px` };
    const ht = Math.abs(p1[1] - p0[1]);
    const key = `${f.type}|${(f.options ?? []).join('\u0001')}`;
    let ctl = host.querySelector(`[data-field="${a.id}"]`) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    if (ctl && ctl.dataset.key !== key) { ctl.remove(); ctl = null; }
    const commit = (value: string | boolean | string[]) => {
      const page = v.page;
      const now = page.annots.find(x => x.id === a.id);
      if (!now?.field || !session) return;
      session.replaceAnnot(page, now, { ...now, field: { ...now.field, value } }, 'Fill in a field');
    };
    if (!ctl) {
      if (f.type === 'text') {
        ctl = ht > 40 ? h('textarea', { class: 'own-field-ctl' }) : h('input', { class: 'own-field-ctl', type: 'text' });
        ctl.addEventListener('change', () => commit(ctl!.value));
      } else if (f.type === 'radio') {
        ctl = h('input', { class: 'own-field-ctl check', type: 'radio', name: `own-radio-${f.name}` });
        ctl.addEventListener('change', () => {
          if (!(ctl as HTMLInputElement).checked || !session) return;
          // One answer per question: this choice on, every other choice with the same name off, as one undo step.
          const changes = session.pages.flatMap(pg => pg.annots
            .filter(x => x.field?.type === 'radio' && x.field.name === f.name && !x.ghost)
            .map(x => ({ page: pg, before: x, after: { ...x, field: { ...x.field!, value: x.id === a.id } } }))
            .filter(c => c.before.field!.value !== c.after.field.value));
          session.replaceAcross(changes, 'Fill in a field');
        });
      } else if (f.type === 'check') {
        ctl = h('input', { class: 'own-field-ctl check', type: 'checkbox' });
        ctl.addEventListener('change', () => commit((ctl as HTMLInputElement).checked));
      } else {
        const sel = h('select', { class: 'own-field-ctl', multiple: f.type === 'list' }, ...(f.options ?? []).map(o => h('option', { value: o }, o)));
        if (f.type === 'dropdown') sel.prepend(h('option', { value: '' }, ''));
        sel.addEventListener('change', () => commit(f.type === 'list' ? [...sel.selectedOptions].map(o => o.value) : sel.value));
        ctl = sel;
      }
      ctl.dataset.field = a.id;
      ctl.dataset.key = key;
      ctl.title = f.name;
      ctl.setAttribute('aria-label', f.name);
      host.append(ctl);
    }
    Object.assign(ctl.style, box, { fontSize: `${Math.max(9, Math.min(ht * 0.6, 16))}px` });
    if (ctl instanceof HTMLInputElement && (ctl.type === 'checkbox' || ctl.type === 'radio')) {
      // A focused choice must follow Undo too; only text edits need to keep their live value.
      ctl.checked = f.value === true || f.value === 'true';
    } else if (document.activeElement !== ctl) {
      if (ctl instanceof HTMLSelectElement && ctl.multiple) { const vals = Array.isArray(f.value) ? f.value : []; for (const o of ctl.options) o.selected = vals.includes(o.value); }
      else ctl.value = typeof f.value === 'string' ? f.value : '';
    }
  }
  for (const c of [...host.children] as HTMLElement[]) if (!keep.has(c.dataset.field ?? '')) c.remove();
}

/** Form controls and clickable links, placed over the page. */
export async function buildWidgets(viewer: Viewer, v: PageView, pdfPage?: PDFPageProxy) {
  const session = viewer.session;
  if (!session) return;
  const src = v.page.source ? session.sources.get(v.page.source) : null;
  if (!src) return;
  if (!pdfPage) pdfPage = (await session.pdfPage(v.page)) ?? undefined;
  if (!pdfPage) return;
  v.widgetsLoaded = true;
  let list: any[];
  try { list = await pdfPage.getAnnotations({ intent: 'display' }); } catch { return; }
  // Include choices on unmounted pages when clearing the earlier answer to a radio question.
  const fieldObjects = list.some(d => d.radioButton) ? await src.pdf.getFieldObjects().catch(() => null) : null;
  v.widgets.replaceChildren();
  for (const d of list) {
    if (!d.rect) continue;
    const a = toScreen(v.vp, d.rect[0], d.rect[1]), b = toScreen(v.vp, d.rect[2], d.rect[3]);
    const left = Math.min(a[0], b[0]), top = Math.min(a[1], b[1]);
    const w = Math.abs(a[0] - b[0]), ht = Math.abs(a[1] - b[1]);
    const box = { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${ht}px` };
    if (d.subtype === 'Link') {
      const link = h('a', { class: 'pdf-link', style: box, title: d.url || d.unsafeUrl || '' });
      link.addEventListener('click', e => {
        e.preventDefault();
        if (d.url) window.open(d.url, '_blank', 'noopener');
        else if (d.dest) void followDest(viewer, src.pdf, d.dest);
      });
      v.widgets.append(link);
    } else if (d.subtype === 'Widget' && !d.readOnly) {
      const radioIds = d.radioButton ? (fieldObjects?.get(d.fieldName) ?? list.filter(f => f.radioButton && f.fieldName === d.fieldName)).map((f: any) => f.id as string) : [];
      const ctl = buildField(viewer, v, src, d, box, ht, radioIds);
      if (ctl) { v.widgets.append(ctl); document.dispatchEvent(new CustomEvent('pdfy-form-found')); }
    }
  }
}

function buildField(viewer: Viewer, v: PageView, src: { pdf: any; formsEdited: boolean }, d: any, box: Record<string, string>, height: number, radioIds: string[]): HTMLElement | null {
  const storage = src.pdf.annotationStorage;
  const commit = (value: unknown) => {
    storage.setValue(d.id, { value });
    src.formsEdited = true;
    viewer.session?.markDirty();
    v.needsRender = true;
    viewer.schedule();
  };
  const saved = storage.getValue?.(d.id, { value: d.fieldValue })?.value ?? d.fieldValue;
  const size = `${Math.max(9, Math.min(height * 0.62, 16)) * viewer.scale}px`;

  if (d.fieldType === 'Tx') {
    const el = d.multiLine
      ? h('textarea', { class: 'field', style: { ...box, fontSize: `${12 * viewer.scale}px` }, value: saved ?? '', maxLength: d.maxLen || undefined })
      : h('input', { class: 'field', type: d.password ? 'password' : 'text', style: { ...box, fontSize: size }, value: saved ?? '', maxLength: d.maxLen || undefined });
    el.addEventListener('change', () => commit((el as HTMLInputElement).value));
    return el;
  }
  if (d.fieldType === 'Btn' && d.checkBox) {
    const el = h('input', { class: 'field check', type: 'checkbox', style: box, checked: saved && saved !== 'Off' });
    el.addEventListener('change', () => commit(el.checked));
    return el;
  }
  if (d.fieldType === 'Btn' && d.radioButton) {
    const el = h('input', { class: 'field check', type: 'radio', name: `r-${viewer.session?.id}-${v.page.source}-${d.fieldName}`, style: box, checked: typeof saved === 'boolean' ? saved : saved === d.buttonValue });
    el.addEventListener('change', () => {
      if (!el.checked) return;
      for (const id of radioIds) if (id !== d.id) storage.setValue(id, { value: false });
      // Visible siblings are unchecked by their shared input name; redraw their PDF appearances too.
      for (const view of viewer.views.values()) if (view.page.source === v.page.source) view.needsRender = true;
      commit(true);
    });
    return el;
  }
  if (d.fieldType === 'Ch') {
    const el = h('select', { class: 'field', style: { ...box, fontSize: size }, multiple: !!d.multiSelect, size: d.combo ? undefined : Math.max(1, Math.min(6, d.options?.length ?? 1)) },
      d.combo ? h('option', { value: '', selected: !saved || (Array.isArray(saved) && !saved.length) }, '') : null,
      ...(d.options ?? []).map((o: any) => h('option', { value: o.exportValue, selected: Array.isArray(saved) ? saved.includes(o.exportValue) : saved === o.exportValue }, o.displayValue)));
    el.addEventListener('change', () => commit(d.multiSelect ? [...el.selectedOptions].map(o => o.value) : el.value));
    return el;
  }
  return null;
}

export async function followDest(viewer: Viewer, pdf: any, dest: unknown) {
  const session = viewer.session;
  if (!session) return;
  try {
    const d = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(d)) return;
    const index = typeof d[0] === 'number' ? d[0] : await pdf.getPageIndex(d[0]);
    const srcId = [...session.sources.values()].find(s => s.pdf === pdf)?.id;
    const at = session.pages.findIndex(p => p.source === srcId && p.index === index);
    if (at >= 0) viewer.goTo(at);
  } catch (err) { console.warn('Link target', err); }
}
