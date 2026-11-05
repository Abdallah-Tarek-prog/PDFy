// The pop-up beside a chosen word. "Quick" is the offline dictionary and is there at once. The other
// tabs read the publishers' own pages for the word (Cambridge English–Arabic, Oxford, Longman) and lay
// them out cleanly, with their own recordings. Without the internet, Quick and Windows voices remain.

import { getSettings, saveSettings } from '../core/settings';
import { clear, h, icon, safe, toast } from '../ui/dom';
import { hasVoice, lookUp, posName, pronounce, speakWord, translateUrl, type DictEntry, type LookupResult } from './dictionary';
import { OfflineError, PUBLISHERS, lookUpOnline, pageUrl, playRecording, type PubBlock, type PubId, type PubResult, type PubSense } from './publishers';

type TabId = 'quick' | PubId;

let current: { close(): void } | null = null;

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
  /** Start on this tab instead of the one chosen in Preferences. */
  tab?: TabId;
}

interface State {
  word: string;
  query: string;
  offline: LookupResult | null;
  online: Map<PubId, PubResult | null | Error>;
  tab: TabId;
}

export async function showDictionary(text: string, opts: PopupOptions) {
  current?.close();
  const settings = getSettings();
  const panel = h('div', { class: `dict-pop${settings.dictDocked ? ' docked' : ''}`, role: 'dialog', 'aria-label': 'Dictionary' });
  const top = h('div', { class: 'dict-head' });
  const sounds = h('div', { class: 'dict-sounds' });
  const tabs = h('div', { class: 'dict-tabs', role: 'tablist', 'aria-label': 'Dictionaries' });
  const pane = h('div', { class: 'dict-body', role: 'tabpanel' }, h('div', { class: 'dict-loading' }, 'Looking it up…'));
  const foot = h('div', { class: 'dict-foot' });
  panel.append(top, sounds, tabs, pane, foot);

  const onDocDown = (e: Event) => { if (!panel.contains(e.target as Node) && !panel.classList.contains('docked')) close(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (!panel.contains(document.activeElement) || /INPUT|TEXTAREA/.test((e.target as HTMLElement).tagName)) return;
    // 1 and 2 play British and American, from whichever row is showing.
    if (e.key === '1' || e.key === '2') {
      e.preventDefault();
      const row = sounds.hidden ? pane.querySelector('.pub-prons') : sounds;
      (row?.querySelectorAll('button')[+e.key - 1] as HTMLButtonElement | undefined)?.click();
    }
  };
  function close() {
    panel.remove();
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    if (current?.close === close) current = null;
  }
  current = { close };
  document.body.append(panel);
  place(panel, opts);
  setTimeout(() => {
    if (!panel.isConnected) return;
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);

  const online = settings.onlineDict;
  const state: State = { word: text, query: text, offline: null, online: new Map(), tab: opts.tab ?? (online ? settings.dictTab : 'quick') };

  // ---- Drawing ----

  const drawTop = () => {
    clear(top);
    const pin = h('button', {
      class: `icon-btn small${panel.classList.contains('docked') ? ' on' : ''}`, title: panel.classList.contains('docked') ? 'Float beside the word again' : 'Keep open at the side while you read',
      'aria-label': 'Pin to the side', 'aria-pressed': String(panel.classList.contains('docked')),
      onclick: () => {
        const docked = !panel.classList.contains('docked');
        panel.classList.toggle('docked', docked);
        saveSettings({ dictDocked: docked });
        place(panel, opts);
        drawTop();
      },
    }, icon('layers', 14));
    top.append(
      h('div', { class: 'dict-word', dir: 'auto' }, state.word),
      h('div', { class: 'dict-head-tools' }, pin, h('button', { class: 'icon-btn small', title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => close() }, icon('close', 14))));
  };

  /** UK and US buttons. The publisher's recording if one is loaded, otherwise Wiktionary's, otherwise Windows. */
  const drawSounds = () => {
    clear(sounds);
    const loaded = [state.tab, 'cambridge', 'oxford', 'longman']
      .map(id => state.online.get(id as PubId))
      .find((r): r is PubResult => !!r && !(r instanceof Error) && !!r.blocks[0]?.prons.length);
    const e = state.offline?.entry;
    for (const region of ['UK', 'US'] as const) {
      const pub = loaded?.blocks[0].prons.find(p => p.region === region);
      const ipa = pub?.ipa ?? (region === 'UK' ? e?.ipaUk : e?.ipaUs) ?? e?.ipa;
      const wiki = region === 'UK' ? e?.audioUk : e?.audioUs;
      if (!ipa && !pub?.audio && !wiki) continue;
      sounds.append(h('button', {
        class: `dict-sound ${region.toLowerCase()}`, title: `Hear the ${region === 'UK' ? 'British' : 'American'} pronunciation (${region === 'UK' ? 1 : 2})`, 'aria-label': `Hear the ${region} pronunciation`,
        onclick: safe(() => say(state.word, pub?.audio, wiki, region), 'Playing'),
      }, icon('speak', 13), h('b', null, region), ipa ? h('span', { class: 'dict-ipa', dir: 'ltr' }, ipa) : null));
    }
    if (!sounds.children.length && state.word) {
      sounds.append(h('button', { class: 'dict-sound', onclick: safe(() => say(state.word, undefined, undefined, 'UK'), 'Playing') }, icon('speak', 13), h('b', null, 'Say it')));
    }
  };

  const drawTabs = () => {
    clear(tabs);
    const all: { id: TabId; label: string }[] = [{ id: 'quick', label: 'Quick' }, ...PUBLISHERS.map(p => ({ id: p.id, label: p.label }))];
    for (const t of all) {
      const r = t.id === 'quick' ? null : state.online.get(t.id);
      const mark = t.id === 'quick' ? '' : r instanceof Error ? ' error' : r === null ? ' none' : '';
      tabs.append(h('button', {
        class: `dict-tab${state.tab === t.id ? ' on' : ''}${mark}`, role: 'tab', 'aria-selected': String(state.tab === t.id),
        onclick: () => { state.tab = t.id; if (t.id !== 'quick' && online) saveSettings({ dictTab: t.id }); void drawPane(); },
      }, t.label));
    }
  };

  const drawFoot = () => {
    clear(foot);
    if (state.tab !== 'quick') {
      const p = PUBLISHERS.find(x => x.id === state.tab)!;
      const r = state.online.get(state.tab);
      const url = r && !(r instanceof Error) ? r.url : pageUrl(state.tab, state.query);
      foot.append(h('button', { class: 'btn small', title: `Open the ${p.full} page`, onclick: () => openReference(url, `${p.label}: ${state.word}`) }, 'Open the page ↗'));
    }
    if (opts.sentence && opts.sentence.trim() !== state.word) {
      foot.append(h('button', {
        class: 'btn small', title: `Translate the whole sentence with Google: ${opts.sentence.slice(0, 90)}`,
        onclick: () => openReference(translateUrl(opts.sentence!), 'Translate sentence'),
      }, 'Translate sentence'));
    }
    const note = state.tab === 'quick'
      ? 'Offline: Wiktionary, CC BY-SA.'
      : `From the ${PUBLISHERS.find(x => x.id === state.tab)!.full} website, read for this word.`;
    foot.append(h('div', { class: 'dict-source' }, note));
  };

  const drawPane = async () => {
    drawTabs();
    drawFoot();
    // A publisher's entry has its own recordings beside each part of speech, so the top row would repeat them.
    sounds.hidden = state.tab !== 'quick';
    clear(pane);
    pane.scrollTop = 0;
    if (state.tab === 'quick') {
      if (!state.offline) { pane.append(h('div', { class: 'dict-loading' }, 'Looking it up…')); return; }
      drawQuick(pane, state.offline, w => void lookAgain(w));
      return;
    }
    const id = state.tab;
    if (!online) {
      pane.append(h('div', { class: 'dict-empty' }, 'Reading the dictionary websites is off. Turn it on in Preferences, under Study tools.'));
      return;
    }
    if (!state.online.has(id)) {
      pane.append(h('div', { class: 'dict-loading' }, `Reading ${PUBLISHERS.find(p => p.id === id)!.label}…`));
      await loadOnline(id);
      if (state.tab !== id || !panel.isConnected) return;
      clear(pane);
    }
    const r = state.online.get(id);
    if (r instanceof Error) {
      const offline = r instanceof OfflineError;
      pane.append(h('div', { class: 'dict-empty' }, offline
        ? 'No internet connection, so this site cannot be read. Quick still works, and words are spoken by Windows.'
        : `This page could not be read: ${r.message}`),
      h('button', { class: 'btn small', onclick: () => { state.online.delete(id); void drawPane(); } }, 'Try again'));
      return;
    }
    if (!r || !r.blocks.length) {
      pane.append(h('div', { class: 'dict-empty' }, `${PUBLISHERS.find(p => p.id === id)!.label} has no entry for “${state.query}”.`));
      if (r?.suggestions.length) {
        pane.append(h('div', { class: 'dict-suggest' }, 'It suggests: ', ...r.suggestions.flatMap((s, i) => [i ? ', ' : '', h('button', { class: 'link-btn', onclick: () => void lookAgain(s) }, s)])));
      }
      return;
    }
    pane.append(drawPublisher(r, {
      say: (word, audio, region) => say(word, audio, undefined, region),
      lookup: w => void lookAgain(w),
      openRelated: url => {
        state.online.delete(id);
        state.online.set(id, null);
        void (async () => {
          clear(pane);
          pane.append(h('div', { class: 'dict-loading' }, 'Reading…'));
          try { state.online.set(id, await lookUpOnline(id, url)); } catch (err) { state.online.set(id, err as Error); }
          drawSounds();
          void drawPane();
        })();
      },
    }));
    drawSounds();
  };

  const loadOnline = async (id: PubId) => {
    try {
      let r = await lookUpOnline(id, state.query);
      // A form such as "running" may only be listed under its base word on some sites.
      const base = state.offline?.entry?.word;
      if (!r?.blocks.length && base && base.toLowerCase() !== state.query.toLowerCase()) r = await lookUpOnline(id, base) ?? r;
      state.online.set(id, r);
    } catch (err) {
      state.online.set(id, err as Error);
    }
    drawTabs();
  };

  const lookAgain = async (word: string) => {
    state.word = word;
    state.query = word;
    state.online.clear();
    state.offline = null;
    drawTop();
    void drawPane();
    await start();
  };

  const start = async () => {
    try {
      state.offline = await lookUp(state.query);
    } catch (err) {
      state.offline = { query: state.query, entry: null, suggestions: [] };
      console.warn('Offline dictionary', err);
    }
    if (!panel.isConnected) return;
    state.query = state.offline.query || state.query;
    state.word = state.offline.entry?.word && state.tab === 'quick' ? state.offline.entry.word : state.query;
    drawTop();
    drawSounds();
    await drawPane();
    if (panel.isConnected) place(panel, opts);
  };

  drawTop();
  drawTabs();
  await start();
}

/** The publisher's recording, then Wiktionary's, then a Windows voice. */
async function say(word: string, publisher: string | undefined, wiki: string | undefined, region: 'UK' | 'US') {
  if (publisher && navigator.onLine !== false && await playRecording(publisher)) return;
  const how = await pronounce(word, navigator.onLine === false ? undefined : wiki, region === 'UK' ? 'en-GB' : 'en-US');
  if (how === 'none') toast('No recording could be reached and this PC has no English voice.', 'info');
}

function place(panel: HTMLElement, o: { x: number; y: number }) {
  if (panel.classList.contains('docked')) {
    // Beside the page, below the toolbar, so reading can carry on.
    const area = document.querySelector('.workspace')?.getBoundingClientRect();
    panel.style.left = '';
    panel.style.top = `${Math.round(area?.top ?? 120)}px`;
    panel.style.bottom = `${Math.round(innerHeight - (area?.bottom ?? innerHeight))}px`;
    return;
  }
  panel.style.bottom = '';
  const r = panel.getBoundingClientRect();
  const left = Math.max(8, Math.min(o.x, innerWidth - r.width - 8));
  const below = o.y + 14;
  const top = below + r.height < innerHeight - 8 ? below : Math.max(8, o.y - r.height - 14);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

// ---- The offline tab ----

function drawQuick(body: HTMLElement, r: LookupResult, again: (word: string) => void) {
  if (r.from && r.entry) body.append(h('div', { class: 'dict-note' }, `Showing the base word for “${r.from}”.`));
  if (!r.entry) {
    body.append(h('div', { class: 'dict-empty' }, `“${r.query}” is not in the offline dictionary. The other tabs may have it.`));
    if (r.suggestions.length) {
      body.append(h('div', { class: 'dict-suggest' }, 'Did you mean: ', ...r.suggestions.flatMap((s, i) => [i ? ', ' : '', h('button', { class: 'link-btn', onclick: () => again(s) }, s)])));
    }
    return;
  }
  const arabic = arabicBlock(r.entry);
  body.append(arabic ?? h('div', { class: 'dict-note' }, 'No Arabic meaning here yet. The Cambridge عربي tab has most words.'));
  body.append(meanings(r.entry));
  if (r.base) body.append(h('div', { class: 'dict-note' }, 'Also a form of ', h('button', { class: 'link-btn', onclick: () => again(r.base!.word) }, r.base.word), '.'));
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
      h('div', { class: 'dict-ar-words', dir: 'rtl', lang: 'ar' }, ...items.slice(0, 5).map(a => h('button', {
        class: 'dict-ar', title: a.roman ? `${a.roman}. Click to hear it` : 'Click to hear it',
        onclick: safe(async () => {
          if (!await canSpeak || !await speakWord(a.word, 'ar')) toast('This PC has no Arabic voice. Add one in Windows: Settings, Time & language, Speech.', 'info');
        }, 'Playing'),
      }, h('span', { class: 'dict-ar-text' }, a.word), a.roman ? h('span', { class: 'dict-roman', dir: 'ltr' }, a.roman) : null)))));
  }
  if (dialects.length) {
    box.append(h('div', { class: 'dict-dialects' }, h('span', { class: 'dict-ar-sense', dir: 'ltr' }, 'In dialects: '),
      ...dialects.slice(0, 4).map(a => h('span', { class: 'dict-dialect', dir: 'rtl', lang: 'ar', title: a.roman }, a.word, h('small', { dir: 'ltr' }, ` ${a.dialect}`)))));
  }
  if (!direct.length && reversed.length) box.append(h('div', { class: 'dict-note' }, 'Less certain: found by reading Arabic entries backwards. Check the Cambridge عربي tab.'));
  return box;
}

function meanings(e: DictEntry) {
  const box = h('div', { class: 'dict-meanings' });
  for (const p of e.parts.slice(0, 5)) {
    box.append(h('div', { class: 'dict-pos' }, posName(p.pos)));
    const ol = h('ol', { class: 'dict-senses' });
    for (const s of p.senses.slice(0, 4)) ol.append(h('li', null, s.gloss, s.example ? h('div', { class: 'dict-example' }, s.example) : null));
    box.append(ol);
  }
  return box;
}

// ---- A publisher's entry, laid out the way dictionaries lay them out ----

interface PubHooks {
  say(word: string, audio: string | undefined, region: 'UK' | 'US'): Promise<void>;
  openRelated(url: string): void;
  lookup(word: string): void;
}

function drawPublisher(r: PubResult, hooks: PubHooks): HTMLElement {
  const box = h('div', { class: `pub pub-${r.source}` });
  r.blocks.forEach((b, i) => {
    if (i) box.append(h('hr', { class: 'pub-rule' }));
    box.append(drawBlock(b, hooks));
  });
  if (r.related.length) {
    box.append(h('div', { class: 'pub-related' }, h('span', { class: 'pub-related-title' }, 'Other entries'),
      ...r.related.map(x => h('button', { class: 'pub-chip', onclick: () => hooks.openRelated(x.url) }, x.label))));
  }
  return box;
}

function drawBlock(b: PubBlock, hooks: PubHooks): HTMLElement {
  const head = h('div', { class: 'pub-head' },
    h('span', { class: 'pub-hw', dir: 'auto' }, b.headword, b.homnum ? h('sup', null, b.homnum) : null),
    b.pos ? h('span', { class: 'pub-pos' }, b.pos) : null,
    b.level ? h('span', { class: 'pub-level', title: 'Level' }, b.level) : null,
    ...(b.freq ?? []).map(f => h('span', { class: 'pub-freq', title: f.startsWith('S') ? 'Among the most common spoken words' : 'Among the most common written words' }, f)),
    b.grammar ? h('span', { class: 'pub-gram' }, b.grammar) : null);
  const prons = h('div', { class: 'pub-prons' }, ...b.prons.map(p => h('button', {
    class: `pub-pron ${p.region.toLowerCase()}`, title: `Hear the ${p.region === 'UK' ? 'British' : 'American'} recording`,
    onclick: safe(() => hooks.say(b.headword, p.audio, p.region), 'Playing'),
  }, icon('speak', 12), h('b', null, p.region), p.ipa ? h('span', { class: 'pub-ipa', dir: 'ltr' }, p.ipa) : null)));
  const list = h('ol', { class: 'pub-senses' }, ...b.senses.map(s => drawSense(s, b.headword, hooks)));
  return h('div', { class: 'pub-block' }, head, b.hyphen ? h('div', { class: 'pub-hyphen' }, b.hyphen) : null, b.prons.length ? prons : null, list);
}

function drawSense(s: PubSense, word: string, hooks: PubHooks): HTMLElement {
  const li = h('li', { class: 'pub-sense' });
  if (s.num) li.dataset.num = s.num;
  const line = h('div', { class: 'pub-defline' },
    s.num ? h('span', { class: 'pub-num' }, s.num) : null,
    s.signpost ? h('span', { class: 'pub-sign' }, s.signpost) : null,
    s.level ? h('span', { class: 'pub-level small' }, s.level) : null,
    s.labels ? h('span', { class: 'pub-labels' }, s.labels) : null,
    s.def ? h('span', { class: 'pub-def' }, s.def) : null);
  li.append(line);
  if (s.arabic) li.append(h('div', { class: 'pub-ar', dir: 'rtl', lang: 'ar' }, s.arabic));
  if (s.examples.length) {
    let lastPattern = '';
    const ul = h('ul', { class: 'pub-examples' });
    for (const ex of s.examples) {
      if (ex.pattern && ex.pattern !== lastPattern) ul.append(h('li', { class: 'pub-pattern' }, ex.pattern));
      lastPattern = ex.pattern ?? lastPattern;
      ul.append(h('li', { class: 'pub-ex' },
        ex.audio ? h('button', { class: 'pub-ex-play', title: 'Hear this example', 'aria-label': 'Hear this example', onclick: safe(async () => { if (!await playRecording(ex.audio!)) toast('The recording could not be reached.', 'info'); }, 'Playing') }, icon('speak', 11)) : null,
        h('span', { class: 'pub-ex-text' }, ex.text),
        ex.arabic ? h('div', { class: 'pub-ex-ar', dir: 'rtl', lang: 'ar' }, ex.arabic) : null));
    }
    li.append(ul);
  }
  if (s.see?.length) {
    li.append(h('div', { class: 'pub-see' }, '→ ', ...s.see.flatMap((w, i) => [i ? ', ' : '', h('button', { class: 'link-btn', onclick: () => hooks.lookup(w.split('/')[0].replace(/(.*?)/g, '').trim()) }, w)])));
  }
  if (s.sub?.length) li.append(h('ol', { class: 'pub-subsenses' }, ...s.sub.map(x => drawSense(x, word, hooks))));
  return li;
}
