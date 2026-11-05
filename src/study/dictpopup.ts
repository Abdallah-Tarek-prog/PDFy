// The pop-up beside a chosen word: how it sounds, what it means in Arabic, what it means in English,
// and one click to the real Longman, Oxford and Cambridge pages.

import { clear, h, icon, safe, toast } from '../ui/dom';
import { ONLINE_SOURCES, hasVoice, lookUp, posName, pronounce, speakWord, translateUrl, type DictEntry, type LookupResult } from './dictionary';

let current: { close(): void } | null = null;
const history: string[] = [];

/** Opens a page in PDFy's small reference window, or a browser tab outside the desktop app. */
export function openReference(url: string, title: string) {
  const webview = window.chrome?.webview;
  if (webview) webview.postMessage({ type: 'reference', url, title });
  else window.open(url, '_blank', 'noopener');
}

export function closeDictionary() { current?.close(); }
export const dictionaryOpen = () => !!current;

export interface PopupOptions {
  /** Where to appear, in window coordinates. */
  x: number;
  y: number;
  /** The sentence around the word, for translating it whole. */
  sentence?: string;
}

export async function showDictionary(text: string, opts: PopupOptions) {
  current?.close();
  const body = h('div', { class: 'dict-body' }, h('div', { class: 'dict-loading' }, 'Looking it up…'));
  const panel = h('div', { class: 'dict-pop', role: 'dialog', 'aria-label': 'Dictionary' }, body);

  const onDocDown = (e: Event) => { if (!panel.contains(e.target as Node)) close(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  function close() {
    panel.remove();
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    current = null;
  }
  current = { close };

  document.body.append(panel);
  place(panel, opts);
  // The click that opened this must not also close it.
  setTimeout(() => {
    if (!panel.isConnected) return;
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);

  const show = async (word: string) => {
    let result: LookupResult;
    try {
      result = await lookUp(word);
    } catch (err) {
      clear(body);
      body.append(h('div', { class: 'dict-empty' }, (err as Error).message));
      return;
    }
    if (!panel.isConnected) return;
    clear(body);
    await drawResult(body, result, { ...opts, close, show });
    if (panel.isConnected) place(panel, opts);
  };
  await show(text);
}

function place(panel: HTMLElement, o: { x: number; y: number }) {
  const r = panel.getBoundingClientRect();
  const left = Math.max(8, Math.min(o.x, innerWidth - r.width - 8));
  const below = o.y + 14;
  const top = below + r.height < innerHeight - 8 ? below : Math.max(8, o.y - r.height - 14);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

async function drawResult(body: HTMLElement, r: LookupResult, o: PopupOptions & { close(): void; show(word: string): Promise<void> }) {
  const word = r.entry?.word ?? r.query;
  if (history.at(-1) !== word) history.push(word);
  if (history.length > 40) history.shift();

  const head = h('div', { class: 'dict-head' },
    h('div', { class: 'dict-word', dir: 'auto' }, word),
    h('button', { class: 'icon-btn small', title: 'Close', 'aria-label': 'Close', onclick: () => o.close() }, icon('close', 14)));
  body.append(head);

  if (r.from && r.entry) body.append(h('div', { class: 'dict-note' }, `Showing the base word for “${r.from}”.`));

  if (!r.entry) {
    body.append(h('div', { class: 'dict-empty' }, `“${r.query}” is not in the offline dictionary. The pages below may have it.`));
    if (r.suggestions.length) {
      body.append(h('div', { class: 'dict-suggest' }, 'Did you mean: ', ...r.suggestions.flatMap((s, i) => [
        i ? ', ' : '',
        h('button', { class: 'link-btn', onclick: safe(() => o.show(s), 'Looking up') }, s),
      ])));
    }
  } else {
    body.append(await soundRow(r.entry));
    const arabic = arabicBlock(r.entry);
    if (arabic) body.append(arabic);
    else body.append(h('div', { class: 'dict-note' }, 'No Arabic meaning here yet. Cambridge عربي below has most words.'));
    body.append(meanings(r.entry));
    if (r.base) body.append(h('div', { class: 'dict-note' }, 'Also a form of ', h('button', { class: 'link-btn', onclick: safe(() => o.show(r.base!.word), 'Looking up') }, r.base.word), '.'));
  }

  const links = h('div', { class: 'dict-links' },
    ...ONLINE_SOURCES.map(s => h('button', {
      class: 'btn small', title: s.title,
      onclick: () => openReference(s.url(word), `${s.label}: ${word}`),
    }, s.label)));
  if (o.sentence && o.sentence.trim() !== word) {
    links.append(h('button', {
      class: 'btn small', title: `Translate the whole sentence with Google: ${o.sentence.slice(0, 90)}`,
      onclick: () => openReference(translateUrl(o.sentence!), 'Translate sentence'),
    }, 'Translate sentence'));
  }
  body.append(links);
  body.append(h('div', { class: 'dict-source' }, r.entry ? 'Offline meanings: Wiktionary, CC BY-SA. The buttons open the publishers’ own pages.' : 'The buttons open the publishers’ own pages.'));
}

async function soundRow(e: DictEntry) {
  const row = h('div', { class: 'dict-sounds' });
  const item = (label: string, ipa: string | undefined, file: string | undefined, lang: 'en-GB' | 'en-US') => h('button', {
    class: 'dict-sound', title: `Hear the ${label} pronunciation`, 'aria-label': `Hear the ${label} pronunciation`,
    onclick: safe(async () => {
      const how = await pronounce(e.word, file, lang);
      if (how === 'none') toast('No recording could be reached and this PC has no voice for this. The Longman page has recordings.', 'info');
    }, 'Playing'),
  }, icon('speak', 13), h('b', null, label), ipa ? h('span', { class: 'dict-ipa', dir: 'ltr' }, ipa) : null);
  if (e.ipaUk || e.audioUk) row.append(item('UK', e.ipaUk, e.audioUk, 'en-GB'));
  if (e.ipaUs || e.audioUs) row.append(item('US', e.ipaUs, e.audioUs, 'en-US'));
  if (!row.children.length) row.append(item('Say', e.ipa, undefined, 'en-GB'));
  return row;
}

function arabicBlock(e: DictEntry) {
  const direct = e.parts.flatMap(p => p.arabic.filter(a => !a.reversed && !a.dialect).map(a => ({ ...a, pos: p.pos })));
  const dialects = e.parts.flatMap(p => p.arabic.filter(a => a.dialect));
  const reversed = e.parts.flatMap(p => p.arabic.filter(a => a.reversed).map(a => ({ ...a, pos: p.pos })));
  const list = direct.length ? direct : reversed;
  if (!list.length && !dialects.length) return null;
  const canSpeak = hasVoice('ar');
  const groups = new Map<string, typeof list>();
  for (const a of list) {
    const k = a.sense || posName(a.pos);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(a);
  }
  const box = h('div', { class: 'dict-arabic' });
  for (const [sense, items] of groups) {
    box.append(h('div', { class: 'dict-ar-group' },
      h('div', { class: 'dict-ar-sense', dir: 'ltr' }, sense),
      h('div', { class: 'dict-ar-words', dir: 'rtl', lang: 'ar' }, ...items.slice(0, 5).map(a => {
        const b = h('button', {
          class: 'dict-ar', title: a.roman ? `${a.roman}. Click to hear it` : 'Click to hear it',
          onclick: safe(async () => {
            if (!await canSpeak || !await speakWord(a.word, 'ar')) toast('This PC has no Arabic voice. Add one in Windows: Settings, Time & language, Speech.', 'info');
          }, 'Playing'),
        }, h('span', { class: 'dict-ar-text' }, a.word), a.roman ? h('span', { class: 'dict-roman', dir: 'ltr' }, a.roman) : null);
        return b;
      }))));
  }
  if (dialects.length) {
    box.append(h('div', { class: 'dict-dialects' }, h('span', { class: 'dict-ar-sense', dir: 'ltr' }, 'In dialects: '),
      ...dialects.slice(0, 4).map(a => h('span', { class: 'dict-dialect', dir: 'rtl', lang: 'ar', title: a.roman }, a.word, h('small', { dir: 'ltr' }, ` ${a.dialect}`)))));
  }
  if (!direct.length && reversed.length) box.append(h('div', { class: 'dict-note' }, 'Less certain: found by reading Arabic entries backwards. Check with Cambridge عربي.'));
  return box;
}

function meanings(e: DictEntry) {
  const box = h('div', { class: 'dict-meanings' });
  for (const p of e.parts.slice(0, 5)) {
    box.append(h('div', { class: 'dict-pos' }, posName(p.pos)));
    const ol = h('ol', { class: 'dict-senses' });
    for (const s of p.senses.slice(0, 4)) {
      ol.append(h('li', null, s.gloss, s.example ? h('div', { class: 'dict-example' }, s.example) : null));
    }
    box.append(ol);
  }
  return box;
}
