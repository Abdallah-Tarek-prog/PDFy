// Reads the publishers' own dictionary pages, the same pages you would open in a browser, and turns
// them into plain entries for the pop-up. Nothing from their pages is run or inserted as it is: only
// the words, pronunciations and recording addresses are taken out and laid out again by PDFy.
// If a site changes its layout, that site's reader returns nothing and the pop-up offers the page.

export type PubId = 'cambridge' | 'oxford' | 'longman';

export interface PubPron { region: 'UK' | 'US'; ipa?: string; audio?: string }
export interface PubExample { text: string; audio?: string; arabic?: string; pattern?: string }
export interface PubSense {
  num?: string;
  signpost?: string;
  labels?: string;
  level?: string;
  def: string;
  arabic?: string;
  examples: PubExample[];
  sub?: PubSense[];
  /** Other entries this meaning points to, such as "high/low water". */
  see?: string[];
}
export interface PubBlock {
  headword: string;
  homnum?: string;
  pos?: string;
  grammar?: string;
  level?: string;
  freq?: string[];
  hyphen?: string;
  prons: PubPron[];
  senses: PubSense[];
}
export interface PubResult {
  source: PubId;
  url: string;
  blocks: PubBlock[];
  related: { label: string; url: string }[];
  suggestions: string[];
}

export const PUBLISHERS: { id: PubId; label: string; full: string; home: string }[] = [
  { id: 'cambridge', label: 'Cambridge عربي', full: 'Cambridge English–Arabic Dictionary', home: 'https://dictionary.cambridge.org' },
  { id: 'oxford', label: 'Oxford', full: "Oxford Learner's Dictionaries", home: 'https://www.oxfordlearnersdictionaries.com' },
  { id: 'longman', label: 'Longman', full: 'Longman Dictionary of Contemporary English', home: 'https://www.ldoceonline.com' },
];

const slug = (w: string) => encodeURIComponent(w.trim().toLowerCase().replace(/\s+/g, '-'));

/** The address PDFy reads for a word. Oxford and Longman pick the best entry themselves. */
export function pageUrl(id: PubId, word: string): string {
  if (id === 'cambridge') return `https://dictionary.cambridge.org/dictionary/english-arabic/${slug(word)}`;
  if (id === 'oxford') return `https://www.oxfordlearnersdictionaries.com/search/english/direct/?q=${encodeURIComponent(word.trim())}`;
  return `https://www.ldoceonline.com/search/english/direct/?q=${encodeURIComponent(word.trim())}`;
}

const ALLOWED_HOSTS = ['dictionary.cambridge.org', 'www.oxfordlearnersdictionaries.com', 'www.ldoceonline.com'];
export const isPublisherUrl = (u: string) => { try { const x = new URL(u); return x.protocol === 'https:' && ALLOWED_HOSTS.includes(x.hostname); } catch { return false; } };

// ---- Fetching ----

let nextId = 1;
const waiting = new Map<number, { resolve(v: { html: string; url: string }): void; reject(e: Error): void }>();
let offlineForTest = false;
export const setOfflineForTest = (v: boolean) => { offlineForTest = v; };

/** Replies from the Windows app, which does the reading because web pages cannot fetch other sites. */
export function onPageMessage(data: { type?: string; id?: number; ok?: boolean; html?: string; url?: string; error?: string }) {
  if (data.type !== 'web-page' || data.id === undefined) return;
  const job = waiting.get(data.id);
  if (!job) return;
  waiting.delete(data.id);
  if (data.ok && data.html) job.resolve({ html: data.html, url: data.url ?? '' });
  else job.reject(new Error(data.error || 'The page could not be read.'));
}

export class OfflineError extends Error {}

export function fetchPage(url: string): Promise<{ html: string; url: string }> {
  if (!isPublisherUrl(url)) return Promise.reject(new Error('Only the dictionary sites are read.'));
  if (offlineForTest || navigator.onLine === false) return Promise.reject(new OfflineError('No internet connection.'));
  const webview = window.chrome?.webview;
  if (webview) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      webview.postMessage({ type: 'web-fetch', id, url });
      setTimeout(() => { if (waiting.delete(id)) reject(new OfflineError('The site took too long to answer.')); }, 15000);
    });
  }
  // The test server reads pages the same way, so the readers can be tested outside the app.
  if (location.hostname === 'localhost') {
    return fetch(`/__web?url=${encodeURIComponent(url)}`).then(async r => {
      if (!r.ok) throw new OfflineError(`The site could not be reached (${r.status}).`);
      return await r.json() as { html: string; url: string };
    });
  }
  return Promise.reject(new OfflineError('Reading dictionary pages needs the Meletiq PDF desktop app.'));
}

const memo = new Map<string, Promise<PubResult | null>>();
const MEMO_LIMIT = 60;

/** Reads one site's entry for a word. Null means the site has no entry. */
export function lookUpOnline(id: PubId, wordOrUrl: string): Promise<PubResult | null> {
  const url = wordOrUrl.startsWith('https://') ? wordOrUrl : pageUrl(id, wordOrUrl);
  const key = `${id}|${url}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const job = fetchPage(url).then(({ html, url: finalUrl }) => parsePage(id, html, finalUrl || url));
  // A failure is not remembered, so it can be tried again once the internet is back.
  job.catch(() => memo.delete(key));
  memo.set(key, job);
  while (memo.size > MEMO_LIMIT) memo.delete(memo.keys().next().value as string);
  return job;
}

export function parsePage(id: PubId, html: string, url: string): PubResult | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const result = id === 'cambridge' ? readCambridge(doc, url) : id === 'oxford' ? readOxford(doc, url) : readLongman(doc, url);
  if (!result.blocks.length && !result.suggestions.length) return null;
  return result;
}

// ---- Shared helpers ----

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').replace(/\s+([,.;:!?)])/g, '$1').replace(/\(\s+/g, '(').trim();
const absolute = (href: string | null | undefined, base: string) => { try { return href ? new URL(href, base).href : undefined; } catch { return undefined; } };
const audioOk = (u: string | undefined) => (u && /^https:\/\/[^/]+\.(?:ldoceonline\.com|oxfordlearnersdictionaries\.com|cambridge\.org)\//.test(u) ? u : undefined);
const clean = (s: string) => s.replace(/^\/+|\/+$/g, '').trim();

/** Text of an element without the parts that are not part of the sentence, such as speaker icons. */
function textWithout(el: Element, skip: string): string {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll(skip).forEach(n => n.remove());
  return text(copy);
}

// ---- Cambridge English–Arabic ----

function readCambridge(doc: Document, url: string): PubResult {
  const out: PubResult = { source: 'cambridge', url, blocks: [], related: [], suggestions: [] };
  for (const body of doc.querySelectorAll('.entry-body__el')) {
    const head = body.querySelector('.pos-header') ?? body;
    const block: PubBlock = {
      headword: text(head.querySelector('.hw, .dhw, .headword')),
      pos: [...head.querySelectorAll('.pos.dpos, .dpos')].map(p => text(p)).filter(Boolean).join(', ') || undefined,
      grammar: text(head.querySelector('.gram, .dgram')) || undefined,
      prons: [],
      senses: [],
    };
    for (const [cls, region] of [['uk', 'UK'], ['us', 'US']] as const) {
      const loc = head.querySelector(`.${cls}.dpron-i, .${cls}.dloc, .${cls}`);
      if (!loc) continue;
      const src = loc.querySelector('audio source[type="audio/mpeg"]')?.getAttribute('src');
      // The symbols sit beside the region label, inside the same pronunciation group.
      const ipa = text(loc.querySelector('.ipa') ?? loc.closest('.pron-info, .dpron-info')?.querySelector('.ipa'));
      block.prons.push({ region, ipa: ipa ? `/${clean(ipa)}/` : undefined, audio: audioOk(absolute(src, url)) });
    }
    let n = 0;
    for (const group of body.querySelectorAll('.dsense, .sense-block')) {
      const guide = text(group.querySelector('.guideword, .dsense_h .guideword')).replace(/^\(|\)$/g, '');
      let first = true;
      for (const def of group.querySelectorAll('.def-block')) {
        if (def.closest('.phrase-block, .dphrase-block')) continue;
        const english = text(def.querySelector('.def.ddef_d, .ddef_d, .def'));
        if (!english) continue;
        const bodyEl = def.querySelector('.def-body, .ddef_b');
        const arabic = [...(bodyEl?.children ?? [])].filter(c => c.classList.contains('trans')).map(c => text(c)).join('، ') || undefined;
        const sense: PubSense = {
          num: String(++n),
          signpost: first && guide ? guide : undefined,
          level: text(def.querySelector('.epp-xref, .dxref')) || undefined,
          labels: text(def.querySelector('.def-info .gram, .def-info .lab, .dlab, .dgram')) || undefined,
          def: english.replace(/:$/, ''),
          arabic,
          examples: [...def.querySelectorAll('.examp, .dexamp')].map(ex => ({
            text: text(ex.querySelector('.eg, .deg')),
            arabic: text(ex.querySelector('.trans')) || undefined,
          })).filter(e => e.text).slice(0, 6),
        };
        block.senses.push(sense);
        first = false;
      }
    }
    if (block.headword && block.senses.length) out.blocks.push(block);
  }
  // Remove the repeated header items the site shows for each part of speech.
  return out;
}

// ---- Oxford Learner's ----

const LEVEL = /ox[35]ksym_([abc][12])/i;

function readOxford(doc: Document, url: string): PubResult {
  const out: PubResult = { source: 'oxford', url, blocks: [], related: [], suggestions: [] };
  const top = doc.querySelector('.webtop');
  if (top) {
    const levelClass = [...top.querySelectorAll('.symbols [class]')].map(e => e.getAttribute('class') ?? '').find(c => LEVEL.test(c));
    const block: PubBlock = {
      headword: text(top.querySelector('.headword')),
      pos: text(top.querySelector('.pos')) || undefined,
      grammar: text(top.querySelector(':scope > .grammar, :scope > .labels')) || undefined,
      level: levelClass ? LEVEL.exec(levelClass)![1].toUpperCase() : undefined,
      prons: [],
      senses: [],
    };
    for (const [cls, region] of [['phons_br', 'UK'], ['phons_n_am', 'US']] as const) {
      const p = top.querySelector(`.${cls}`);
      if (!p) continue;
      block.prons.push({ region, ipa: text(p.querySelector('.phon')) || undefined, audio: audioOk(p.querySelector('[data-src-mp3]')?.getAttribute('data-src-mp3') ?? undefined) });
    }
    const senses = [...doc.querySelectorAll('.entry li.sense, #entryContent li.sense')].filter(s => !s.closest('.idioms, .pv-g, .collapse'));
    let lastGroup: Element | null = null;
    senses.forEach((s, i) => {
      const group = s.closest('.shcut-g');
      const sign = group && group !== lastGroup ? text(group.querySelector('.shcut')) : '';
      lastGroup = group;
      const levelOf = [...s.querySelectorAll(':scope > .sensetop .symbols [class], :scope > .symbols [class]')].map(e => e.getAttribute('class') ?? '').find(c => LEVEL.test(c));
      const labels = [...s.querySelectorAll(':scope > .grammar, :scope > .labels, :scope > .sensetop .grammar, :scope > .sensetop .labels, :scope > .dis-g, :scope > .use')].map(x => text(x)).filter(Boolean).join(' ');
      const examples: PubExample[] = [...s.querySelectorAll(':scope > ul.examples > li')].map(li => ({
        pattern: text(li.querySelector('.cf')) || undefined,
        text: text(li.querySelector('.x')),
      })).filter(e => e.text).slice(0, 6);
      const def = text(s.querySelector(':scope > .def, :scope > .sensetop .def'));
      if (!def) return;
      block.senses.push({ num: String(i + 1), signpost: sign || undefined, level: levelOf ? LEVEL.exec(levelOf)![1].toUpperCase() : undefined, labels: labels || undefined, def, examples });
    });
    if (block.headword && block.senses.length) out.blocks.push(block);
    for (const a of doc.querySelectorAll('#relatedentries li a')) {
      const href = absolute(a.getAttribute('href'), url);
      const label = text(a);
      if (href && isPublisherUrl(href) && label && !href.split('?')[0].endsWith(url.split('?')[0].split('/').pop() ?? '##')) out.related.push({ label, url: href });
    }
    out.related = out.related.slice(0, 8);
  }
  if (!out.blocks.length) out.suggestions = suggestionsFrom(doc, '.result-list li a, .didyoumean li a, ul.result-list a');
  return out;
}

// ---- Longman ----

function readLongman(doc: Document, url: string): PubResult {
  const out: PubResult = { source: 'longman', url, blocks: [], related: [], suggestions: [] };
  for (const dict of doc.querySelectorAll('.dictentry')) {
    const intro = text(dict.querySelector('.dictionary_intro'));
    // Pages can also show Longman's business dictionary. Only the main dictionary is used.
    if (intro && !/contemporary english/i.test(intro)) continue;
    for (const entry of dict.querySelectorAll('.ldoceEntry')) {
      const head = entry.querySelector('.Head');
      if (!head) continue;
      const uk = text(head.querySelector('.PRON'));
      const usVariant = textWithout(head.querySelector('.AMEVARPRON') ?? document.createElement('span'), '.neutral').replace(/^\$\s*/, '');
      const block: PubBlock = {
        headword: text(head.querySelector('.HWD')),
        homnum: text(head.querySelector('.HOMNUM')) || undefined,
        hyphen: text(head.querySelector('.HYPHENATION')) || undefined,
        pos: [...head.querySelectorAll('.POS')].map(p => text(p)).filter(Boolean).join(', ') || undefined,
        grammar: text(head.querySelector('.GRAM')) || undefined,
        level: head.querySelector('.LEVEL')?.getAttribute('title')?.replace(/^Core vocabulary:\s*/i, '') || undefined,
        freq: [...head.querySelectorAll('.FREQ')].map(f => text(f)).filter(Boolean),
        prons: [],
        senses: [],
      };
      const bre = head.querySelector('.speaker.brefile')?.getAttribute('data-src-mp3') ?? undefined;
      const ame = head.querySelector('.speaker.amefile')?.getAttribute('data-src-mp3') ?? undefined;
      if (uk || bre) block.prons.push({ region: 'UK', ipa: uk ? `/${clean(uk)}/` : undefined, audio: audioOk(bre) });
      if (uk || usVariant || ame) block.prons.push({ region: 'US', ipa: usVariant ? `/${clean(usVariant)}/` : uk ? `/${clean(uk)}/` : undefined, audio: audioOk(ame) });
      for (const s of entry.querySelectorAll(':scope > .Sense')) {
        const sense = longmanSense(s);
        if (sense) block.senses.push(sense);
      }
      if (block.headword && block.senses.length) out.blocks.push(block);
    }
  }
  if (!out.blocks.length) out.suggestions = suggestionsFrom(doc, '.didyoumean li a, .didyoumean a, ul.didyoumean a');
  return out;
}

function longmanSense(s: Element): PubSense | null {
  const own = (sel: string) => [...s.querySelectorAll(sel)].filter(x => x.closest('.Sense, .Subsense') === s);
  const examples: PubExample[] = [];
  for (const ex of own('.EXAMPLE')) {
    const group = ex.closest('.ColloExa, .GramExa');
    const pattern = group && group.closest('.Sense, .Subsense') === s ? text(group.querySelector('.COLLO, .PROPFORM, .PROPFORMPREP')) : '';
    examples.push({
      text: textWithout(ex, '.speaker'),
      audio: audioOk(ex.querySelector('.speaker[data-src-mp3]')?.getAttribute('data-src-mp3') ?? undefined),
      pattern: pattern || undefined,
    });
  }
  const subs = [...s.querySelectorAll(':scope > .Subsense')].map(x => longmanSense(x)).filter(Boolean) as PubSense[];
  const def = text(own('.DEF')[0]);
  // Some numbered lines only point to a phrase with its own entry, such as "→ high/low water".
  const see = own('.Crossref').flatMap(c => text(c).split('→')).map(x => x.trim()).filter(x => x && x.length < 60);
  if (!def && !subs.length && !see.length) return null;
  const labels = [own('.GRAM')[0], own('.REGISTERLAB')[0], own('.GEO')[0]].map(x => text(x)).filter(Boolean).join(' ');
  return {
    num: text(own('.sensenum')[0]) || undefined,
    signpost: text(own('.SIGNPOST')[0]) || undefined,
    labels: labels || undefined,
    def,
    examples: examples.filter(e => e.text).slice(0, 6),
    sub: subs.length ? subs : undefined,
    see: see.length ? see : undefined,
  };
}

function suggestionsFrom(doc: Document, selector: string): string[] {
  return [...new Set([...doc.querySelectorAll(selector)].map(a => text(a)).filter(t => t && t.length < 40))].slice(0, 6);
}

// ---- Playing their recordings ----

let playing: HTMLAudioElement | null = null;

/** Plays a recording. Resolves true once sound starts, false if it cannot be reached in time. */
export function playRecording(url: string, wait = 4000): Promise<boolean> {
  playing?.pause();
  return new Promise(res => {
    const a = new Audio(url);
    playing = a;
    const t = setTimeout(() => { a.pause(); res(false); }, wait);
    a.addEventListener('playing', () => { clearTimeout(t); res(true); }, { once: true });
    a.addEventListener('error', () => { clearTimeout(t); res(false); }, { once: true });
    a.play().catch(() => { clearTimeout(t); res(false); });
  });
}
