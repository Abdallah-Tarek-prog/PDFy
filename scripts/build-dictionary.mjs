// Builds PDFy's offline English dictionary from Wiktionary, using the kaikki.org extract.
//
// The source is large (3 GB compressed, about 25 GB unpacked, every language), so it is read as a
// stream and never stored. Only English and Arabic lines are parsed. Only the small result is written. Stops if the result grows past a limit.
//
// Usage: node scripts/build-dictionary.mjs [output folder] [--limit N lines, for trying it out]
//
// Wiktionary text is CC BY-SA 4.0, and so is this result.

import { createGunzip, gzipSync } from 'node:zlib';
import { createInterface } from 'node:readline';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

// The full, current dump. The per-language files on kaikki.org are older and miss most translation tables.
const RAW_URL = 'https://kaikki.org/dictionary/raw-wiktextract-data.jsonl.gz';
const out = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'vendor-dict';
const limitAt = process.argv.indexOf('--limit');
const LIMIT = limitAt > 0 ? +process.argv[limitAt + 1] : Infinity;
const MAX_MB = 150;

const MAX_SENSES = 6, MAX_GLOSS = 170, MAX_EX = 120, MAX_AR = 8;
const SKIP_POS = new Set(['symbol', 'character', 'romanization', 'punct', 'soft-redirect', 'hard-redirect', 'contraction-form']);
const POOR_SENSE = new Set(['obsolete', 'archaic', 'rare', 'dated', 'dialectal', 'historical', 'nonstandard', 'misspelling', 'proscribed', 'vulgar', 'offensive', 'derogatory', 'ethnic', 'slur']);
const UK_TAGS = ['Received-Pronunciation', 'UK', 'British', 'England', 'Southern-England'];
const US_TAGS = ['General-American', 'US', 'American'];

const stats = { lines: 0, kept: 0, aliases: 0, withIpa: 0, withAudio: 0, withAr: 0, fromArabic: 0 };

export function keyOf(word) {
  return word.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[’ʼ]/g, "'").toLowerCase().trim();
}

const shardOf = key => {
  const a = /[a-z]/.test(key[0] ?? '') ? key[0] : '_';
  const b = /[a-z]/.test(key[1] ?? '') ? key[1] : '_';
  return a + b;
};

/** Everything a person could mean by a word form, in the order worth trying. Same rules as the app. */
function ruleLemmas(w) {
  const out = [];
  const add = s => { if (s.length > 1) out.push(s); };
  if (w.endsWith('ies')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('es')) add(w.slice(0, -2));
  if (w.endsWith('s') && !w.endsWith('ss')) add(w.slice(0, -1));
  if (w.endsWith('ied')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('ed')) { add(w.slice(0, -2)); add(w.slice(0, -1)); if (w.at(-3) === w.at(-4)) add(w.slice(0, -3)); }
  if (w.endsWith('ing')) { add(w.slice(0, -3)); add(w.slice(0, -3) + 'e'); if (w.at(-4) === w.at(-5)) add(w.slice(0, -4)); }
  if (w.endsWith('ier')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('iest')) add(w.slice(0, -4) + 'y');
  if (w.endsWith('er')) { add(w.slice(0, -2)); add(w.slice(0, -1)); }
  if (w.endsWith('est')) { add(w.slice(0, -3)); add(w.slice(0, -2)); }
  return out;
}

async function* rawLines(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download: ${r.status}`);
  const gunzip = Readable.fromWeb(r.body).pipe(createGunzip());
  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    if (++n > LIMIT) { rl.close(); gunzip.destroy(); break; }
    if (n % 500000 === 0) console.log(`${n} lines, ${Math.round(process.memoryUsage().rss / 1048576)} MB in memory`);
    yield line;
  }
}

async function* jsonLines(url, label) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${label}: ${r.status}`);
  const gunzip = Readable.fromWeb(r.body).pipe(createGunzip());
  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    if (++n > LIMIT) { rl.close(); gunzip.destroy(); break; }
    if (n % 100000 === 0) console.log(`${label}: ${n} lines, ${Math.round(process.memoryUsage().rss / 1048576)} MB in memory`);
    try { yield JSON.parse(line); } catch { /* One bad line does not matter. */ }
  }
}

const hasTag = (s, tags) => s.tags?.some(t => tags.includes(t));
/** /slashes/ are the dictionary form. [brackets] are a narrow phonetic version, which reads badly. */
const pickIpa = (sounds, tags) => {
  const all = sounds.filter(s => s.ipa && hasTag(s, tags));
  return (all.find(s => s.ipa.startsWith('/')) ?? all[0])?.ipa;
};
const pickAudio = (sounds, tags, prefix) => {
  const a = sounds.filter(s => s.audio);
  return (a.find(s => hasTag(s, tags)) ?? a.find(s => s.audio.toLowerCase().startsWith(prefix)))?.audio;
};
const trim = (t, n) => (t.length <= n ? t : `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…`);
const isArabicText = t => /[؀-ۿ]/.test(t) && !/[A-Za-z]/.test(t);

const entries = new Map();   // key -> { w, i, f, e: [{ p, s, a }] }
const aliases = new Map();   // key -> Set of lemma keys

function entryFor(word) {
  const key = keyOf(word);
  let e = entries.get(key);
  if (!e) { e = { w: word, e: [] }; entries.set(key, e); }
  // Prefer the lower-case spelling for display: "apple", not "Apple".
  else if (word === word.toLowerCase() && e.w !== word) e.w = word;
  return e;
}

function handleEnglish(o) {
  {
    stats.lines++;
    const word = o.word;
    if (!word || word.length > 40 || SKIP_POS.has(o.pos)) return;
    const key = keyOf(word);
    if (!key) return;
    const senses = o.senses ?? [];
    const ar = (o.translations ?? []).filter(t => (t.lang_code === 'ar' || t.code === 'ar') && t.word && isArabicText(t.word));
    const sounds = o.sounds ?? [];
    const uk = pickIpa(sounds, UK_TAGS), us = pickIpa(sounds, US_TAGS);
    const any = sounds.find(s => s.ipa?.startsWith('/'))?.ipa;
    const multi = word.includes(' ');

    // A word form such as "cats" or "went" only points at its main entry.
    const pointers = senses.flatMap(s => [...(s.form_of ?? []), ...(s.alt_of ?? [])]).map(x => x.word).filter(Boolean);
    const real = senses.filter(s => !s.form_of && !s.alt_of && s.glosses?.length && !s.tags?.includes('form-of'));
    if (pointers.length && !multi) {
      let set = aliases.get(key);
      if (!set) { set = new Set(); aliases.set(key, set); }
      for (const p of pointers.slice(0, 3)) set.add(keyOf(p));
    }
    if (!real.length) return;

    // Names of people and places, and most long phrases, only earn a place if they have Arabic.
    if (o.pos === 'name' && !ar.length) return;
    if (multi && !ar.length && !['verb', 'phrase', 'prep_phrase', 'adv'].includes(o.pos)) return;
    if (multi && word.split(' ').length > 4) return;

    // Plain everyday senses first. Obsolete and rare ones only if there is nothing else.
    const usable = real.filter(s => !s.tags?.some(t => POOR_SENSE.has(t)));
    const chosen = (usable.length ? usable : real).slice(0, MAX_SENSES);

    const e = entryFor(word);
    const sensesOut = chosen.map(s => {
      const gloss = trim(s.glosses.at(-1), MAX_GLOSS);
      const ex = s.examples?.find(x => x.type === 'example' && x.text && x.text.length <= MAX_EX)?.text;
      return ex ? [gloss, ex] : [gloss];
    });
    // Standard Arabic first. Words tagged with a dialect, such as Egyptian, come after and say so.
    const dialectOf = t => (t.tags ?? []).find(x => /-Arabic$/.test(x))?.replace(/-Arabic$/, '').replace(/-/g, ' ');
    const seen = new Set();
    const arOut = [];
    const standard = ar.filter(t => !dialectOf(t)), dialects = ar.filter(t => dialectOf(t));
    for (const t of standard) {
      if (seen.has(t.word) || arOut.length >= MAX_AR) continue;
      seen.add(t.word);
      arOut.push([t.word, t.roman ?? '', t.sense ? trim(t.sense, 60) : '']);
    }
    let shown = 0;
    for (const t of dialects) {
      if (seen.has(t.word) || shown >= 3) continue;
      seen.add(t.word);
      shown++;
      arOut.push([t.word, t.roman ?? '', t.sense ? trim(t.sense, 60) : '', 0, dialectOf(t)]);
    }
    const part = { p: o.pos, s: sensesOut };
    if (arOut.length) part.a = arOut;
    e.e.push(part);

    e.i ??= {};
    if (uk && !e.i.u) e.i.u = uk;
    if (us && !e.i.a) e.i.a = us;
    if (any && !e.i.g) e.i.g = any;
    e.f ??= {};
    const fu = pickAudio(sounds, UK_TAGS, 'en-uk'), fa = pickAudio(sounds, US_TAGS, 'en-us');
    if (fu && !e.f.u) e.f.u = fu;
    if (fa && !e.f.a) e.f.a = fa;
  }
}

/**
 * Wiktionary's Arabic entries list English meanings too. That fills in words whose English entry has
 * no Arabic. These are marked, because a reversed meaning is less certain than a direct translation.
 */
const reverse = new Map();
function handleArabic(o) {
  {
    if (!o.word || !['noun', 'verb', 'adj', 'adv', 'prep', 'conj', 'pron', 'intj'].includes(o.pos)) return;
    const canonical = (o.forms ?? []).find(f => f.tags?.includes('canonical'))?.form ?? o.word;
    const roman = (o.forms ?? []).find(f => f.tags?.includes('romanization'))?.form ?? '';
    if (!isArabicText(canonical)) return;
    const senses = (o.senses ?? []).filter(s => !s.form_of && !s.alt_of && s.glosses?.length && !s.tags?.some(t => POOR_SENSE.has(t) || t === 'form-of'));
    senses.slice(0, 2).forEach((s, order) => {
      s.glosses.at(-1).split(/[;,]/).slice(0, 4).forEach((raw, place) => {
        let term = raw.replace(/\(.*?\)/g, '').trim().toLowerCase();
        if (o.pos === 'verb') term = term.replace(/^to /, '');
        else term = term.replace(/^(a|an|the) /, '');
        if (!term || term.split(' ').length > 2 || !/^[a-z' -]+$/.test(term)) return;
        let list = reverse.get(term);
        if (!list) { list = []; reverse.set(term, list); }
        // The first meaning of the Arabic word, and the first English word in it, count most.
        list.push({ ar: canonical, roman, pos: o.pos, score: order * 2 + place });
      });
    });
  }
}

function mergeReverse() {
  for (const [term, list] of reverse) {
    const e = entries.get(term);
    if (!e || e.e.some(p => p.a?.length)) continue;
    const best = list.sort((x, y) => x.score - y.score).filter(x => x.score <= 2).slice(0, 3);
    const seen = new Set();
    for (const part of e.e) {
      const match = best.filter(b => b.pos === part.p && !seen.has(b.ar));
      if (!match.length) continue;
      match.forEach(m => seen.add(m.ar));
      // The fourth item marks it as a reversed meaning.
      part.a = match.map(m => [m.ar, m.roman, '', 1]);
    }
    if (seen.size) stats.fromArabic++;
  }
}

function finish() {
  const tmp = `${out}.part`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const shards = new Map();
  const put = (key, value) => {
    const s = shardOf(key);
    let m = shards.get(s);
    if (!m) { m = {}; shards.set(s, m); }
    m[key] = value;
  };
  for (const [key, e] of entries) {
    if (!e.e.length) continue;
    if (e.i && (e.i.u || e.i.a)) delete e.i.g;
    if (e.i && !Object.keys(e.i).length) delete e.i;
    if (e.f && !Object.keys(e.f).length) delete e.f;
    if (e.i) stats.withIpa++;
    if (e.f) stats.withAudio++;
    if (e.e.some(p => p.a?.length)) stats.withAr++;
    put(key, e);
    stats.kept++;
  }
  // A form is only stored if the app's own rules cannot work it out, which keeps the files small.
  for (const [key, targets] of aliases) {
    if (entries.has(key)) {
      const e = entries.get(key);
      const extra = [...targets].filter(t => entries.has(t) && !ruleLemmas(key).includes(t));
      if (extra.length) e.to = extra;
      continue;
    }
    const usable = [...targets].filter(t => entries.has(t));
    if (!usable.length) continue;
    const rules = ruleLemmas(key);
    if (usable.some(t => rules.includes(t))) continue;
    put(key, { to: usable });
    stats.aliases++;
  }
  let total = 0;
  for (const [name, map] of shards) {
    const gz = gzipSync(JSON.stringify(map), { level: 9 });
    total += gz.length;
    if (total > MAX_MB * 1048576) throw new Error(`Stopped: the result passed ${MAX_MB} MB`);
    writeFileSync(join(tmp, `${name}.json.gz`), gz);
  }
  writeFileSync(join(tmp, 'about.json'), JSON.stringify({
    source: 'Wiktionary, through the kaikki.org extract',
    licence: 'CC BY-SA 4.0',
    built: new Date().toISOString().slice(0, 10),
    ...stats,
  }, null, 1));
  rmSync(out, { recursive: true, force: true });
  renameSync(tmp, out);
  console.log(JSON.stringify(stats));
  console.log(`${shards.size} files, ${(total / 1048576).toFixed(1)} MB in ${out}`);
}

// A cheap text check first, so the other 4,000 languages are skipped without parsing.
for await (const line of rawLines(RAW_URL)) {
  const en = line.includes('"lang_code": "en"');
  const ar = !en && line.includes('"lang_code": "ar"');
  if (!en && !ar) continue;
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  if (o.lang_code === 'en') handleEnglish(o);
  else if (o.lang_code === 'ar') handleArabic(o);
}
console.log('Read', JSON.stringify(stats));
mergeReverse();
finish();
