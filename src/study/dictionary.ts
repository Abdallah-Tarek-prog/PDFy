// The offline English dictionary, built from Wiktionary. It is split into small files that load only
// when a word in them is looked up, and only a few stay in memory at a time.

export interface Sense { gloss: string; example?: string }
export interface ArabicMeaning { word: string; roman: string; sense: string; reversed: boolean; dialect?: string }
export interface PartOfSpeech { pos: string; senses: Sense[]; arabic: ArabicMeaning[] }
export interface DictEntry {
  word: string;
  ipaUk?: string;
  ipaUs?: string;
  ipa?: string;
  audioUk?: string;
  audioUs?: string;
  parts: PartOfSpeech[];
  /** Base words this form belongs to, such as "go" for "went". */
  formOf: string[];
}

interface RawEntry {
  w?: string;
  to?: string[];
  i?: { u?: string; a?: string; g?: string };
  f?: { u?: string; a?: string };
  e?: { p: string; s: [string, string?][]; a?: [string, string, string, number?, string?][] }[];
}

const MAX_SHARDS = 10;
const shards = new Map<string, Promise<Record<string, RawEntry>>>();

export function keyOf(word: string): string {
  return word.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[’ʼ]/g, "'").toLowerCase().trim();
}

const shardOf = (key: string) => {
  const a = /[a-z]/.test(key[0] ?? '') ? key[0] : '_';
  const b = /[a-z]/.test(key[1] ?? '') ? key[1] : '_';
  return a + b;
};

function loadShard(name: string): Promise<Record<string, RawEntry>> {
  let p = shards.get(name);
  if (p) { shards.delete(name); shards.set(name, p); return p; }
  p = (async () => {
    const r = await fetch(new URL(`vendor/dict/${name}.json.gz`, document.baseURI).href);
    if (r.status === 404) return {};
    if (!r.ok) throw new Error(`The dictionary could not be read (${r.status}).`);
    const unpacked = (await r.blob()).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(unpacked).json() as Record<string, RawEntry>;
  })();
  p.catch(() => shards.delete(name));
  shards.set(name, p);
  while (shards.size > MAX_SHARDS) shards.delete(shards.keys().next().value as string);
  return p;
}

const rawFor = async (key: string): Promise<RawEntry | undefined> => (await loadShard(shardOf(key)))[key];

/** Ways a word might be written, most likely first. */
export function baseForms(w: string): string[] {
  const out: string[] = [];
  const add = (s: string) => { if (s.length > 1 && !out.includes(s)) out.push(s); };
  if (w.endsWith("'s") || w.endsWith("s'")) add(w.replace(/'s?$/, ''));
  if (w.endsWith('ies')) add(`${w.slice(0, -3)}y`);
  if (w.endsWith('es')) add(w.slice(0, -2));
  if (w.endsWith('s') && !w.endsWith('ss')) add(w.slice(0, -1));
  if (w.endsWith('ied')) add(`${w.slice(0, -3)}y`);
  if (w.endsWith('ed')) { add(w.slice(0, -2)); add(w.slice(0, -1)); if (w.at(-3) === w.at(-4)) add(w.slice(0, -3)); }
  if (w.endsWith('ing')) { add(w.slice(0, -3)); add(`${w.slice(0, -3)}e`); if (w.at(-4) === w.at(-5)) add(w.slice(0, -4)); }
  if (w.endsWith('ier')) add(`${w.slice(0, -3)}y`);
  if (w.endsWith('iest')) add(`${w.slice(0, -4)}y`);
  if (w.endsWith('er')) { add(w.slice(0, -2)); add(w.slice(0, -1)); }
  if (w.endsWith('est')) { add(w.slice(0, -3)); add(w.slice(0, -2)); }
  if (w.endsWith('ly')) add(w.slice(0, -2));
  return out;
}

function toEntry(key: string, raw: RawEntry): DictEntry {
  return {
    word: raw.w ?? key,
    ipaUk: raw.i?.u, ipaUs: raw.i?.a, ipa: raw.i?.g,
    audioUk: raw.f?.u, audioUs: raw.f?.a,
    formOf: raw.to ?? [],
    parts: (raw.e ?? []).map(p => ({
      pos: p.p,
      senses: p.s.map(([gloss, example]) => ({ gloss, example })),
      arabic: (p.a ?? []).map(([word, roman, sense, rev, dialect]) => ({ word, roman, sense, reversed: !!rev, dialect: dialect || undefined })),
    })),
  };
}

/** Removes the punctuation people tend to select along with a word. */
export function cleanSelection(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}']+$/gu, '').replace(/'+$/, '').trim();
}

export interface LookupResult {
  query: string;
  entry: DictEntry | null;
  /** Set when a different form was found, such as "run" for "running". */
  from?: string;
  /** The base word's entry, when the word found is mostly a form of another. */
  base?: DictEntry | null;
  suggestions: string[];
}

export async function lookUp(text: string): Promise<LookupResult> {
  const query = cleanSelection(text);
  const key = keyOf(query);
  const result: LookupResult = { query, entry: null, suggestions: [] };
  if (!key) return result;

  const direct = await rawFor(key);
  if (direct?.e) {
    result.entry = toEntry(key, direct);
    if (direct.to?.length) {
      const b = await rawFor(direct.to[0]);
      if (b?.e) result.base = toEntry(direct.to[0], b);
    }
    return result;
  }
  if (direct?.to?.length) {
    for (const t of direct.to) {
      const r = await rawFor(t);
      if (r?.e) { result.entry = toEntry(t, r); result.from = query; return result; }
    }
  }
  for (const form of baseForms(key)) {
    const r = await rawFor(form);
    if (r?.e) { result.entry = toEntry(form, r); result.from = query; return result; }
  }
  // A hyphenated or two-word form that is listed the other way round.
  const swapped = key.includes('-') ? key.replace(/-/g, ' ') : key.includes(' ') ? key.replace(/ /g, '-') : null;
  if (swapped) {
    const r = await rawFor(swapped);
    if (r?.e) { result.entry = toEntry(swapped, r); result.from = query; return result; }
  }
  result.suggestions = await nearby(key);
  return result;
}

/** Close spellings from the same file: a shared start, then the fewest changes. */
async function nearby(key: string): Promise<string[]> {
  if (key.length < 3) return [];
  const words = Object.keys(await loadShard(shardOf(key)));
  const distance = (a: string, b: string) => {
    if (Math.abs(a.length - b.length) > 2) return 9;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row;
    }
    return prev[b.length];
  };
  return words
    .map(w => ({ w, d: distance(key, w) }))
    .filter(x => x.d <= 2)
    .sort((a, b) => a.d - b.d || a.w.length - b.w.length)
    .slice(0, 5)
    .map(x => x.w);
}

const POS_NAMES: Record<string, string> = {
  noun: 'noun', verb: 'verb', adj: 'adjective', adv: 'adverb', prep: 'preposition', conj: 'conjunction', pron: 'pronoun', intj: 'interjection',
  det: 'determiner', num: 'number', name: 'name', phrase: 'phrase', prep_phrase: 'phrase', particle: 'particle', article: 'article', prefix: 'prefix', suffix: 'suffix',
};
export const posName = (p: string) => POS_NAMES[p] ?? p.replace(/_/g, ' ');

// ---- Where else to read about the word ----

export interface OnlineSource { id: string; label: string; title: string; url(word: string): string }

const slug = (w: string) => encodeURIComponent(keyOf(w).replace(/\s+/g, '-'));

export const ONLINE_SOURCES: OnlineSource[] = [
  { id: 'longman', label: 'Longman', title: 'The real Longman entry, with its own recordings', url: w => `https://www.ldoceonline.com/dictionary/${slug(w)}` },
  { id: 'oxford', label: 'Oxford', title: "The real Oxford Learner's entry, with its own recordings", url: w => `https://www.oxfordlearnersdictionaries.com/definition/english/${slug(w)}` },
  { id: 'cambridge', label: 'Cambridge عربي', title: 'Cambridge English to Arabic, written by editors', url: w => `https://dictionary.cambridge.org/dictionary/english-arabic/${slug(w)}` },
  { id: 'reverso', label: 'Examples', title: 'Real sentences in English and Arabic, from Reverso Context', url: w => `https://context.reverso.net/translation/english-arabic/${encodeURIComponent(keyOf(w))}` },
];

export const translateUrl = (text: string) => `https://translate.google.com/?sl=en&tl=ar&op=translate&text=${encodeURIComponent(text.slice(0, 1200))}`;

export const audioUrl = (file: string) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}`;

// ---- Saying it out loud ----

let voices: SpeechSynthesisVoice[] = [];

function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!('speechSynthesis' in window)) return Promise.resolve([]);
  voices = speechSynthesis.getVoices();
  if (voices.length) return Promise.resolve(voices);
  return new Promise(res => {
    let timer = 0;
    const done = () => {
      clearTimeout(timer);
      speechSynthesis.removeEventListener('voiceschanged', done);
      voices = speechSynthesis.getVoices();
      res(voices);
    };
    speechSynthesis.addEventListener('voiceschanged', done);
    timer = window.setTimeout(done, 700);
  });
}

export async function hasVoice(lang: string): Promise<boolean> {
  return (await loadVoices()).some(v => v.lang.toLowerCase().startsWith(lang.toLowerCase()));
}

/** Uses a voice installed in Windows, so it works without the internet. */
export async function speakWord(text: string, lang: string): Promise<boolean> {
  const list = await loadVoices();
  const want = lang.toLowerCase();
  const voice = list.find(v => v.lang.toLowerCase() === want) ?? list.find(v => v.lang.toLowerCase().startsWith(want.slice(0, 2)));
  if (!voice) return false;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.voice = voice;
  u.lang = voice.lang;
  u.rate = 0.92;
  speechSynthesis.speak(u);
  return true;
}

/** A real recording if the internet allows it, otherwise a Windows voice. */
export async function pronounce(word: string, file: string | undefined, lang: 'en-GB' | 'en-US'): Promise<'recording' | 'voice' | 'none'> {
  if (file) {
    const played = await new Promise<boolean>(res => {
      const a = new Audio(audioUrl(file));
      const t = setTimeout(() => { a.pause(); res(false); }, 2500);
      a.addEventListener('playing', () => { clearTimeout(t); res(true); }, { once: true });
      a.addEventListener('error', () => { clearTimeout(t); res(false); }, { once: true });
      a.play().catch(() => { clearTimeout(t); res(false); });
    });
    if (played) return 'recording';
  }
  return (await speakWord(word, lang)) ? 'voice' : 'none';
}
