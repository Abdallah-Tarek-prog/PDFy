/// <reference lib="webworker" />
// The save engine. It loads only when needed and shuts down when idle, so the heavy PDF parser
// uses no memory while the user is only reading.

import {
  PDFDocument, PDFName, PDFArray, PDFDict, PDFRef, PDFNumber, PDFHexString, PDFString, PDFRawStream, PDFStream,
  PDFFont, PDFPage, StandardFonts, PDFRadioGroup,
  PDFContext, PDFInvalidObject, TextRenderingMode,
  degrees, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
  beginText, endText, setFontAndSize, setTextRenderingMode, setCharacterSqueeze, setTextMatrix, showText,
} from '@cantoo/pdf-lib';
import * as fontkit from '@cantoo/fontkit';
import { unzlibSync } from 'fflate';
import { shapeOf, segsToPdf, measureLabel, calloutLeader, annotBounds } from '../core/geometry';
import type { BuildOptions, FontFamily, SaveAnnot, SavePage } from '../core/model';

export interface SourceInput { id: string; blob: Blob; password?: string; pages?: number }

export interface BuildJob {
  id: number;
  op: 'build' | 'inspect';
  sources: SourceInput[];
  pages: SavePage[];
  options: BuildOptions;
  keepPassword?: string;
}

export interface Inspection {
  pages: number;
  version: string;
  encrypted: boolean;
  title: string | null;
  language: string | null;
  tagged: boolean;
  pdfa: string | null;
  outputIntent: boolean;
  javascript: boolean;
  fonts: { name: string; embedded: boolean }[];
  transparency: boolean;
  attachments: number;
}

export interface BuildResult {
  id: number;
  ok: boolean;
  blob?: Blob;
  error?: string;
  warnings?: string[];
  inspection?: Inspection;
  /** The file had parts the save engine could not read, so the result needs a closer look. */
  suspect?: boolean;
}

const SIGNATURE_HEX = 32768; // Matches the size the main app fills in.
const RTL_TEXT = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LATIN_ONLY = /^[\x20-\x7e\xa0-\xff]*$/;
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (e: MessageEvent<BuildJob>) => {
  const job = e.data;
  try {
    if (job.op === 'inspect') {
      scope.postMessage({ id: job.id, ok: true, inspection: await inspect(job.sources[0]) } satisfies BuildResult);
      return;
    }
    const report = (p: number) => scope.postMessage({ id: job.id, progress: p });
    // Some fonts cannot be cut down to just the letters used. That only shows at the very end of a
    // save, so try again with whole fonts, and finally with no embedded fonts at all.
    const attempts: BuildOptions[] = [job.options, { ...job.options, wholeFonts: true }, { ...job.options, fontBase: undefined }];
    let lastError: unknown = null;
    for (const options of attempts) {
      const warnings: string[] = [];
      try {
        const flags = { suspect: false };
        const blob = await build({ ...job, options }, warnings, report, flags);
        scope.postMessage({ id: job.id, ok: true, blob, warnings, suspect: flags.suspect } satisfies BuildResult);
        return;
      } catch (err) {
        lastError = err;
        if (!options.fontBase) break;
        console.warn('Save attempt failed', err);
      }
    }
    throw lastError;
  } catch (err) {
    scope.postMessage({ id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies BuildResult);
  }
};

const N = (s: string) => PDFName.of(s);

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt((hex || '#000000').replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const num = (n: number) => +n.toFixed(3);
const rgbOp = (hex: string, op: string) => { const c = hexRgb(hex); return `${num(c[0])} ${num(c[1])} ${num(c[2])} ${op}\n`; };

async function loadDoc(input: SourceInput): Promise<PDFDocument> {
  const bytes = new Uint8Array(await input.blob.arrayBuffer());
  // A file with only usage restrictions has an empty password, and opens with no prompt.
  return PDFDocument.load(bytes, {
    password: input.password ?? '',
    ignoreEncryption: false,
    updateMetadata: false,
    throwOnInvalidObject: false,
  } as Parameters<typeof PDFDocument.load>[1]);
}

async function build(job: BuildJob, warnings: string[], progress: (p: number) => void, flags: { suspect: boolean }): Promise<Blob> {
  const { pages, options } = job;
  const inputs = new Map(job.sources.map(s => [s.id, s]));
  const baseId = pages.find(p => p.source)?.source ?? null;
  const doc = baseId ? await loadDoc(inputs.get(baseId)!) : await PDFDocument.create();
  const originals = baseId ? doc.getPages() : [];
  // The viewer and this engine must agree on what the pages are, or edits land on the wrong page.
  const expected = baseId ? inputs.get(baseId)!.pages : undefined;
  if (expected !== undefined && originals.length !== expected) throw new Error(`The save engine sees ${originals.length} pages, the viewer ${expected}.`);
  // A damaged part is skipped when reading, which can quietly lose content.
  if (baseId) flags.suspect = doc.context.enumerateIndirectObjects().some(([, o]) => o instanceof PDFInvalidObject);
  for (const page of originals) mergeInheritedResources(page);
  const fonts = new FontBox(doc, options.fontBase, options.wholeFonts);

  // 1. Work out the final page list without moving anything yet.
  const others = new Map<string, PDFDocument>();
  const used = new Set<number>();
  const final: PDFPage[] = [];
  const removedSlots: Set<number>[] = [];
  const rotations: number[] = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    let page: PDFPage;
    if (!p.source) {
      page = PDFPage.create(doc);
      page.setMediaBox(p.view[0], p.view[1], p.view[2] - p.view[0], p.view[3] - p.view[1]);
      removedSlots.push(new Set());
      rotations.push(p.absoluteRotate);
    } else if (p.source === baseId && !used.has(p.index)) {
      page = originals[p.index];
      removedSlots.push(annotationSlots(page, p.removed));
      rotations.push(((page.getRotation().angle + p.rotate) % 360 + 360) % 360);
      used.add(p.index);
    } else {
      let from: PDFDocument = doc;
      if (p.source !== baseId) {
        let o = others.get(p.source);
        if (!o) { o = await loadDoc(inputs.get(p.source)!); others.set(p.source, o); }
        from = o;
      }
      const original = from.getPage(p.index);
      // copyPages preserves annotation array order, but assigns new object references. Match the
      // original IDs to their array slots before copying, never to destination reference numbers.
      removedSlots.push(annotationSlots(original, p.removed));
      rotations.push(((original.getRotation().angle + p.rotate) % 360 + 360) % 360);
      [page] = await doc.copyPages(from, [p.index]);
    }
    final.push(page);
    if (i % 50 === 0) progress((i / pages.length) * 0.3);
  }
  others.clear(); // Other documents are not needed once pages are copied.

  const orderChanged = final.length !== originals.length || final.some((p, i) => p !== originals[i]);
  if (orderChanged) rewritePageTree(doc, final, originals);

  // 2. Page level edits.
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const page = final[i];
    {
      if (removedSlots[i].size) removeAnnots(page, removedSlots[i]);
      page.setRotation(degrees(rotations[i]));
      if (p.crop) page.setCropBox(p.crop[0], p.crop[1], p.crop[2] - p.crop[0], p.crop[3] - p.crop[1]);
      for (const a of p.annots) {
        if (options.pdfa) a.embedFonts = true;
        // An edit that cannot be written must not vanish quietly. Failing here sends the document
        // to the rebuild, which keeps every edit.
        await addAnnot(doc, page, a, fonts, options);
      }
      if (p.hiddenText?.length) await drawHiddenText(page, p.hiddenText, fonts);
    }
    if (i % 25 === 0) progress(0.3 + (i / pages.length) * 0.4);
  }

  // 3. Document level edits.
  if (options.flattenAnnots) for (const page of final) flattenPage(doc, page, warnings);
  if (options.flattenForms) {
    try { doc.getForm().flatten(); } catch (err) { warnings.push(`Forms could not be flattened: ${String(err)}`); }
  }
  if (options.dropDocLevel) {
    const cat = doc.catalog;
    for (const k of ['Outlines', 'Names', 'Dests', 'OpenAction', 'PageLabels', 'AcroForm', 'StructTreeRoot']) cat.delete(N(k));
  }
  if (options.metadata) {
    const m = options.metadata;
    if (m.title !== undefined) doc.setTitle(m.title);
    if (m.author !== undefined) doc.setAuthor(m.author);
    if (m.subject !== undefined) doc.setSubject(m.subject);
    if (m.keywords !== undefined) doc.setKeywords(m.keywords.split(',').map(s => s.trim()).filter(Boolean));
  }
  if (options.stripMetadata) stripMetadata(doc);
  if (options.bookmarks) addBookmarks(doc, final, options.bookmarks);
  for (const f of options.attachments ?? []) {
    await doc.attach(new Uint8Array(f.bytes), f.name, { mimeType: f.mime || 'application/octet-stream', creationDate: new Date(), modificationDate: new Date() });
  }
  if (options.pdfa) doc.convertToPDFA({ conformance: options.pdfa });
  if (options.signature) await addSignatureSlot(doc, final, options.signature, fonts);
  if (options.compress) await compressImages(doc, options.compress, warnings, f => progress(0.7 + f * 0.2));

  removeUnreachable(doc);
  progress(0.92);

  const password = options.encrypt ?? (job.keepPassword ? { userPassword: job.keepPassword, ownerPassword: job.keepPassword } : null);
  if (password) doc.encrypt(password as Parameters<PDFDocument['encrypt']>[0]);

  const saveOptions = { useObjectStreams: !password && !options.signature, addDefaultPage: pages.length === 0, updateFieldAppearances: false };
  let out: Uint8Array;
  try {
    out = await doc.save(saveOptions as Parameters<PDFDocument['save']>[0]);
  } catch (err) {
    // Files marked as PDF/A-1 must be written the older way.
    if (!/cross-reference streams/i.test(String((err as Error).message))) throw err;
    out = await doc.save({ ...saveOptions, useObjectStreams: false } as Parameters<PDFDocument['save']>[0]);
  }
  progress(1);
  return new Blob([out as BlobPart], { type: 'application/pdf' });
}

/** Space for a digital signature. The main app fills it in once the file's bytes are final. */
async function addSignatureSlot(doc: PDFDocument, pages: PDFPage[], sig: NonNullable<BuildOptions['signature']>, fonts: FontBox) {
  const ctx = doc.context;
  const range = PDFArray.withContext(ctx);
  range.push(PDFNumber.of(0));
  for (let i = 0; i < 3; i++) range.push(N('**********'));
  const dict = ctx.obj({
    Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached',
  }) as PDFDict;
  dict.set(N('ByteRange'), range);
  dict.set(N('Contents'), PDFHexString.of('A'.repeat(SIGNATURE_HEX)));
  dict.set(N('M'), PDFString.fromDate(new Date()));
  dict.set(N('Name'), PDFHexString.fromText(sig.name));
  if (sig.reason) dict.set(N('Reason'), PDFHexString.fromText(sig.reason));
  if (sig.location) dict.set(N('Location'), PDFHexString.fromText(sig.location));
  const sigRef = ctx.register(dict);

  const page = pages[Math.min(sig.pageIndex, pages.length - 1)];
  const rect = sig.rect ?? [0, 0, 0, 0];
  const widget = ctx.obj({
    Type: 'Annot', Subtype: 'Widget', FT: 'Sig', F: 4, Rect: rect, V: sigRef, P: page.ref,
  }) as PDFDict;
  widget.set(N('T'), PDFHexString.fromText(`Signature ${Date.now()}`));
  if (sig.rect) {
    const font = await fonts.get(false);
    const w = rect[2] - rect[0], h = rect[3] - rect[1];
    const size = Math.max(6, Math.min(11, h / 4.2));
    const lines = [`Digitally signed by ${sig.name}`, `Date: ${new Date().toLocaleString()}`, sig.reason ? `Reason: ${sig.reason}` : ''].filter(Boolean);
    let ops = `q 0.1 0.34 0.86 RG 1 w 0.5 0.5 ${num(w - 1)} ${num(h - 1)} re S Q\nBT /F0 ${num(size)} Tf 0.1 0.1 0.1 rg\n`;
    lines.forEach((l, i) => {
      let encoded;
      try { encoded = font.encodeText(l); } catch { encoded = font.encodeText('Digitally signed'); }
      ops += `1 0 0 1 4 ${num(h - size * 1.3 * (i + 1) - 1)} Tm ${encoded.toString()} Tj\n`;
    });
    ops += 'ET';
    const ap = ctx.register(ctx.flateStream(ops, {
      Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, w, h], Resources: ctx.obj({ Font: { F0: font.ref } } as never),
    } as never));
    widget.set(N('AP'), ctx.obj({ N: ap }));
  }
  const widgetRef = ctx.register(widget);
  page.node.addAnnot(widgetRef);
  const acro = doc.getForm().acroForm;
  acro.addField(widgetRef);
  acro.dict.set(N('SigFlags'), PDFNumber.of(3));
}

/**
 * PDFy's own bookmarks are marked, and drawn in a colour of rgb(1, 2, 3), which looks black. The
 * colour is how the viewer recognises them on reopening; the mark is how a save finds and replaces
 * the ones written last time.
 */
export const BOOKMARK_COLOUR = [1, 2, 3];

/** Takes out the bookmarks PDFy wrote on an earlier save, keeping the document's own contents. */
function dropOwnBookmarks(doc: PDFDocument, root: PDFDict) {
  const ctx = doc.context;
  const kept: PDFRef[] = [];
  let removed = 0;
  let ref = root.get(N('First'));
  for (let guard = 0; ref instanceof PDFRef && guard < 100000; guard++) {
    const item = ctx.lookup(ref);
    if (!(item instanceof PDFDict)) break;
    if (item.get(N('PDFyMark'))) removed++; else kept.push(ref);
    ref = item.get(N('Next'));
  }
  if (!removed) return;
  kept.forEach((r, i) => {
    const item = ctx.lookup(r) as PDFDict;
    if (i > 0) item.set(N('Prev'), kept[i - 1]); else item.delete(N('Prev'));
    if (i < kept.length - 1) item.set(N('Next'), kept[i + 1]); else item.delete(N('Next'));
  });
  if (kept.length) { root.set(N('First'), kept[0]); root.set(N('Last'), kept[kept.length - 1]); }
  else { root.delete(N('First')); root.delete(N('Last')); }
  const count = root.lookup(N('Count'));
  root.set(N('Count'), PDFNumber.of(Math.max(0, Math.abs(count instanceof PDFNumber ? count.asNumber() : 0) - removed)));
}

/** User bookmarks become part of the file's contents list, after anything already there. */
function addBookmarks(doc: PDFDocument, pages: PDFPage[], marks: NonNullable<BuildOptions['bookmarks']>) {
  const ctx = doc.context;
  let root = doc.catalog.lookup(N('Outlines'));
  let rootRef = doc.catalog.get(N('Outlines'));
  if (root instanceof PDFDict) dropOwnBookmarks(doc, root);
  if (!marks.length) return;
  if (!(root instanceof PDFDict) || !(rootRef instanceof PDFRef)) {
    root = ctx.obj({ Type: 'Outlines', Count: 0 });
    rootRef = ctx.register(root as PDFDict);
    doc.catalog.set(N('Outlines'), rootRef);
  }
  const dict = root as PDFDict;
  let prev = dict.get(N('Last')) as PDFRef | undefined;
  let added = 0;
  for (const m of marks) {
    const page = pages[m.pageIndex];
    if (!page) continue;
    const item = ctx.obj({ Parent: rootRef, Dest: [page.ref, N('Fit')], PDFyMark: true, C: BOOKMARK_COLOUR.map(v => v / 255) }) as PDFDict;
    item.set(N('Title'), PDFHexString.fromText(m.title));
    const ref = ctx.register(item);
    if (prev) {
      item.set(N('Prev'), prev);
      const before = ctx.lookup(prev);
      if (before instanceof PDFDict) before.set(N('Next'), ref);
    } else {
      dict.set(N('First'), ref);
    }
    dict.set(N('Last'), ref);
    prev = ref;
    added++;
  }
  const count = dict.lookup(N('Count'));
  dict.set(N('Count'), PDFNumber.of(Math.abs(count instanceof PDFNumber ? count.asNumber() : 0) + added));
}

/** Reads what a file contains, for the PDF/A and accessibility check. */
async function inspect(input: SourceInput): Promise<Inspection> {
  const doc = await loadDoc(input);
  const cat = doc.catalog;
  const fonts = new Map<string, boolean>();
  let javascript = false, transparency = false;
  const nameOf = (v: unknown) => (v instanceof PDFName ? v.decodeText() : '');
  const hasFile = (d: PDFDict) => {
    const fd = d.lookup(N('FontDescriptor'));
    return fd instanceof PDFDict && (fd.has(N('FontFile')) || fd.has(N('FontFile2')) || fd.has(N('FontFile3')));
  };
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    const d = o instanceof PDFStream ? o.dict : o;
    if (!(d instanceof PDFDict)) continue;
    if (nameOf(d.lookup(N('S'))) === 'JavaScript') javascript = true;
    if (nameOf(d.lookup(N('S'))) === 'Transparency' || d.has(N('SMask'))) transparency = true;
    if (nameOf(d.lookup(N('Type'))) !== 'Font') continue;
    const sub = nameOf(d.lookup(N('Subtype')));
    if (sub === 'Type3' || sub.startsWith('CIDFont')) continue;
    let embedded = hasFile(d);
    if (sub === 'Type0') {
      const kids = d.lookup(N('DescendantFonts'));
      const kid = kids instanceof PDFArray ? kids.lookup(0) : null;
      embedded = kid instanceof PDFDict && hasFile(kid);
    }
    fonts.set(nameOf(d.lookup(N('BaseFont'))) || 'Unnamed font', embedded);
  }
  const names = cat.lookup(N('Names'));
  if (names instanceof PDFDict && names.has(N('JavaScript'))) javascript = true;
  let pdfa: string | null = null;
  const meta = cat.lookup(N('Metadata'));
  if (meta instanceof PDFRawStream) {
    let bytes: Uint8Array = meta.contents;
    if (meta.dict.has(N('Filter'))) { try { bytes = unzlibSync(bytes); } catch { /* Left as is. */ } }
    const xml = new TextDecoder().decode(bytes);
    const part = /pdfaid:part["'>=\s]+(\d)/.exec(xml)?.[1];
    const level = /pdfaid:conformance["'>=\s]+([A-Za-z])/.exec(xml)?.[1];
    if (part) pdfa = `${part}${level ?? ''}`;
  }
  const mark = cat.lookup(N('MarkInfo'));
  const marked = mark instanceof PDFDict ? String(mark.lookup(N('Marked'))) === 'true' : false;
  const lang = cat.lookup(N('Lang'));
  const att = names instanceof PDFDict ? names.lookup(N('EmbeddedFiles')) : null;
  const attNames = att instanceof PDFDict ? att.lookup(N('Names')) : null;
  const intents = cat.lookup(N('OutputIntents'));
  return {
    pages: doc.getPageCount(),
    version: '',
    encrypted: !!input.password,
    title: doc.getTitle() ?? null,
    language: lang instanceof PDFString || lang instanceof PDFHexString ? lang.decodeText() : null,
    tagged: marked && cat.has(N('StructTreeRoot')),
    pdfa,
    outputIntent: intents instanceof PDFArray && intents.size() > 0,
    javascript,
    fonts: [...fonts.entries()].map(([name, embedded]) => ({ name, embedded })),
    transparency,
    attachments: attNames instanceof PDFArray ? attNames.size() / 2 : 0,
  };
}

const RESOURCE_KINDS = ['Font', 'XObject', 'ExtGState', 'ColorSpace', 'Pattern', 'Shading', 'Properties'];

/**
 * Some files keep fonts on a parent node as well as on the page. Viewers merge the two, but the first
 * edit to a page hides the parent's. Copying them down keeps everything the page was showing.
 */
function mergeInheritedResources(page: PDFPage) {
  const node = page.node;
  const own = node.lookup(N('Resources'));
  if (!(own instanceof PDFDict)) return;
  let parent = node.lookup(N('Parent'));
  for (let guard = 0; parent instanceof PDFDict && guard < 32; guard++) {
    const up = parent.lookup(N('Resources'));
    if (up instanceof PDFDict) {
      for (const kind of RESOURCE_KINDS) {
        const from = up.lookup(N(kind));
        if (!(from instanceof PDFDict)) continue;
        const to = own.lookup(N(kind));
        if (!(to instanceof PDFDict)) { own.set(N(kind), from.clone(page.doc.context)); continue; }
        for (const [k, v] of from.entries()) if (!to.has(k)) to.set(k, v);
      }
    }
    parent = parent.lookup(N('Parent'));
  }
}

/** Writes a flat page list, which is fast even for thousands of pages. */
function rewritePageTree(doc: PDFDocument, final: PDFPage[], originals: PDFPage[]) {
  const pagesRoot = doc.catalog.Pages();
  const rootRef = doc.catalog.get(N('Pages')) as PDFRef;
  const kids = PDFArray.withContext(doc.context);

  // Pages inherit size and resources from tree nodes, so copy them down before those nodes go.
  for (const page of final) {
    const node = page.node;
    for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
      const v = node.getInheritableAttribute(N(key));
      if (v && !node.has(N(key))) node.set(N(key), v);
    }
    node.set(N('Parent'), rootRef);
    kids.push(page.ref);
  }
  pagesRoot.set(N('Kids'), kids);
  pagesRoot.set(N('Count'), PDFNumber.of(final.length));

  // Outlines may still point at deleted pages. Emptying them lets their content be dropped.
  const kept = new Set(final.map(p => p));
  for (const old of originals) {
    if (!kept.has(old)) doc.context.assign(old.ref, doc.context.obj({ Type: 'Page' }));
  }
}

function annotsOf(page: PDFPage): PDFArray | undefined {
  const a = page.node.lookup(N('Annots'));
  return a instanceof PDFArray ? a : undefined;
}

function annotationSlots(page: PDFPage, ids: string[]): Set<number> {
  const slots = new Set<number>();
  const arr = annotsOf(page);
  if (!arr || !ids.length) return slots;
  const want = new Set(ids);
  for (let i = 0; i < arr.size(); i++) {
    const v = arr.get(i);
    if (v instanceof PDFRef) {
      const id = v.generationNumber ? `${v.objectNumber}R${v.generationNumber}` : `${v.objectNumber}R`;
      if (want.has(id)) slots.add(i);
    }
  }
  return slots;
}

function removeAnnots(page: PDFPage, slots: Set<number>) {
  const arr = annotsOf(page);
  if (!arr) return;
  // Unreferenced objects are removed at the end; another page may still use this annotation ref.
  for (let i = arr.size() - 1; i >= 0; i--) if (slots.has(i)) arr.remove(i);
}

const FONTS: Record<FontFamily, [StandardFonts, StandardFonts, StandardFonts, StandardFonts]> = {
  helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};

const FONT_FILES: Record<FontFamily, [string, string, string, string]> = {
  helvetica: ['arial.ttf', 'arialbd.ttf', 'ariali.ttf', 'arialbi.ttf'],
  times: ['times.ttf', 'timesbd.ttf', 'timesi.ttf', 'timesbi.ttf'],
  courier: ['cour.ttf', 'courbd.ttf', 'couri.ttf', 'courbi.ttf'],
};

const fontLetters = new WeakMap<PDFFont, Set<number>>();

/** Fonts draw an empty box for any letter they lack, so that has to be checked first. */
function fontHasAll(font: PDFFont, text: string): boolean {
  let set = fontLetters.get(font);
  if (!set) { set = new Set(font.getCharacterSet()); fontLetters.set(font, set); }
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c <= 32 || (c >= 0x200b && c <= 0x200f)) continue;
    if (!set.has(c)) return false;
  }
  return true;
}

class FontBox {
  private cache = new Map<string, PDFFont>();
  private embedded = new Map<string, PDFFont | null>();
  constructor(private doc: PDFDocument, private fontBase?: string, private wholeFonts = false) {}

  /**
   * A real font from the PC, with only the characters used. Null if it cannot be loaded, and then
   * the caller falls back to a picture of the text.
   */
  async getEmbedded(bold: boolean, family: FontFamily = 'helvetica', italic = false): Promise<PDFFont | null> {
    if (!this.fontBase) return null;
    const file = FONT_FILES[family][(bold ? 1 : 0) + (italic ? 2 : 0)];
    if (this.embedded.has(file)) return this.embedded.get(file)!;
    let font: PDFFont | null = null;
    try {
      const r = await fetch(`${this.fontBase}${file}`);
      if (r.ok) {
        this.doc.registerFontkit(fontkit);
        font = await this.doc.embedFont(new Uint8Array(await r.arrayBuffer()), { subset: !this.wholeFonts });
      }
    } catch (err) {
      console.warn('Font', file, err);
    }
    this.embedded.set(file, font);
    return font;
  }

  async get(bold: boolean, family: FontFamily = 'helvetica', italic = false): Promise<PDFFont> {
    const k = FONTS[family][(bold ? 1 : 0) + (italic ? 2 : 0)];
    let f = this.cache.get(k);
    if (!f) { f = await this.doc.embedFont(k); this.cache.set(k, f); }
    return f;
  }
}

function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let cur = '';
    for (const word of para.split(/(\s+)/)) {
      const test = cur + word;
      if (font.widthOfTextAtSize(test, size) <= width || !cur) cur = test;
      else { lines.push(cur.trimEnd()); cur = word.trimStart(); }
    }
    lines.push(cur);
  }
  return lines;
}

interface Appearance { ops: string; resources: PDFDict; bbox: number[] }

async function buildAppearance(doc: PDFDocument, a: SaveAnnot, fonts: FontBox): Promise<Appearance> {
  const ctx = doc.context;
  const resources = ctx.obj({}) as PDFDict;
  const bounds = annotBounds(a as never);
  let ops = 'q\n/G0 gs\n';

  const gs: Record<string, unknown> = { Type: 'ExtGState', ca: a.opacity, CA: a.opacity };
  if (a.kind === 'highlight' || a.marker) gs.BM = 'Multiply';
  resources.set(N('ExtGState'), ctx.obj({ G0: gs } as never));

  const shape = shapeOf(a as never);
  const fillColour = a.kind === 'highlight' ? a.color
    : a.kind === 'redact' ? '#000000'
    : a.kind === 'note' ? a.color
    : a.kind === 'arrow' ? a.color : a.fill ?? null;

  if (shape.fill.length && fillColour) ops += rgbOp(fillColour, 'rg') + segsToPdf(shape.fill) + 'f\n';
  if (shape.stroke.length && a.kind !== 'highlight' && (a.width > 0 || a.kind === 'note')) {
    ops += rgbOp(a.kind === 'note' ? '#5f5a2a' : a.color, 'RG') + `${num(a.kind === 'note' ? 0.75 : a.width)} w\n1 J 1 j\n`
      + segsToPdf(shape.stroke) + 'S\n';
  }

  if (a.kind === 'image' && a.imageBytes) {
    const img = a.imageType === 'jpg'
      ? await doc.embedJpg(new Uint8Array(a.imageBytes))
      : await doc.embedPng(new Uint8Array(a.imageBytes));
    resources.set(N('XObject'), ctx.obj({ Im0: img.ref }));
    ops += placeOps(a) + `${num(a.rect[2] - a.rect[0])} 0 0 ${num(a.rect[3] - a.rect[1])} 0 0 cm\n/Im0 Do\nQ\n`;
  }

  if (a.kind === 'text' || a.kind === 'callout' || a.kind === 'stamp' || a.kind === 'measure' || a.kind === 'math') {
    ops += await textOps(doc, a, fonts, resources);
  }

  ops += 'Q\n';
  return { ops, resources, bbox: bounds };
}

/** Local coordinates for a rotated box: origin at bottom-left of the unrotated rect. */
function placeOps(a: SaveAnnot): string {
  const [x0, y0, x1, y1] = a.rect;
  const ang = ((a.angle ?? 0) * Math.PI) / 180;
  const c = Math.cos(ang), s = Math.sin(ang);
  const w = x1 - x0, h = y1 - y0;
  const cx = x0 + w / 2, cy = y0 + h / 2;
  return `q\n${num(c)} ${num(s)} ${num(-s)} ${num(c)} ${num(cx)} ${num(cy)} cm\n1 0 0 1 ${num(-w / 2)} ${num(-h / 2)} cm\n`;
}

async function textOps(doc: PDFDocument, a: SaveAnnot, fonts: FontBox, resources: PDFDict): Promise<string> {
  const ctx = doc.context;
  const [x0, y0, x1, y1] = a.rect;
  const w = x1 - x0, h = y1 - y0;

  if (a.kind === 'measure') {
    const label = measureLabel(a as never);
    const font = await fonts.get(true);
    resources.set(N('Font'), ctx.obj({ F0: font.ref }));
    const p = a.pts ?? [];
    const size = 9;
    return `BT\n/F0 ${size} Tf\n${rgbOp(a.color, 'rg')}1 0 0 1 ${num((p[0] + (p[2] ?? p[0])) / 2)} ${num((p[1] + (p[3] ?? p[1])) / 2 + 4)} Tm\n${font.encodeText(label).toString()} Tj\nET\n`;
  }

  let ops = placeOps(a);
  if (a.kind === 'stamp') {
    ops += rgbOp(a.color, 'RG') + `${num(Math.max(1.5, a.width))} w\n`;
    ops += `1 1 ${num(w - 2)} ${num(h - 2)} re\nS\n`;
  } else if (a.kind === 'callout') {
    if (a.fill) ops += rgbOp(a.fill, 'rg') + `0 0 ${num(w)} ${num(h)} re\nf\n`;
    ops += rgbOp(a.color, 'RG') + `${num(Math.max(0.75, a.width))} w\n0 0 ${num(w)} ${num(h)} re\nS\n`;
  } else if (a.fill) {
    ops += rgbOp(a.fill, 'rg') + `0 0 ${num(w)} ${num(h)} re\nf\n`;
  }

  // Printed by the browser engine: any font, any language, real vector text. It only needs placing.
  if (a.vectorPdf) {
    const src = await PDFDocument.load(new Uint8Array(a.vectorPdf));
    const pageH = a.vectorHeight ?? src.getPage(0).getHeight();
    const [form] = await doc.embedPages([src.getPage(0)], [{ left: 0, right: w, top: pageH, bottom: pageH - h }]);
    // Done now, because anything not yet connected to the file is cleared before saving.
    await form.embed();
    resources.set(N('XObject'), ctx.obj({ Vx0: form.ref }));
    return ops + '/Vx0 Do\nQ\n';
  }

  const bold = a.kind === 'stamp' || !!a.bold;
  // Text the built-in fonts cannot show gets a real font from the PC, so it stays selectable.
  // Lines that mix directions need layout the PDF font code cannot do, so those stay a picture.
  let font: PDFFont | null = null;
  const needsReal = !!a.textImage || !!a.embedFonts;
  if (needsReal && !a.mixedDirection) font = await fonts.getEmbedded(bold, a.font ?? 'helvetica', !!a.italic);
  if (font && a.textImage && !fontHasAll(font, a.text ?? '')) font = null;
  if (!font && a.textImage) {
    const img = await doc.embedPng(new Uint8Array(a.textImage));
    resources.set(N('XObject'), ctx.obj({ Tx0: img.ref }));
    return ops + `${num(w)} 0 0 ${num(h)} 0 0 cm\n/Tx0 Do\nQ\n`;
  }
  font ??= await fonts.get(bold, a.font ?? 'helvetica', !!a.italic);
  resources.set(N('Font'), ctx.obj({ F0: font.ref }));
  const text = a.text ?? '';
  const pad = a.kind === 'stamp' ? 0 : 4;

  if (a.kind === 'stamp') {
    const size = Math.min(h * 0.55, (w * 0.86) / (font.widthOfTextAtSize(text, 1) || 1));
    const tw = font.widthOfTextAtSize(text, size);
    ops += `BT\n/F0 ${num(size)} Tf\n${rgbOp(a.color, 'rg')}1 0 0 1 ${num((w - tw) / 2)} ${num((h - size * 0.72) / 2)} Tm\n${font.encodeText(text).toString()} Tj\nET\n`;
    return ops + 'Q\n';
  }

  const size = a.fontSize ?? 12;
  const lead = size * 1.2;
  const used = font;
  const lines = wrapText(text, used, size, w - pad * 2);
  ops += `BT\n/F0 ${num(size)} Tf\n${rgbOp(a.textColor ?? a.color, 'rg')}`;
  lines.forEach((line, i) => {
    if (!line) return;
    // Right-to-left lines start from the right edge of the box.
    const x = RTL_TEXT.test(line) ? Math.max(pad, w - pad - used.widthOfTextAtSize(line, size)) : pad;
    ops += `1 0 0 1 ${num(x)} ${num(h - pad - size * 0.85 - i * lead)} Tm\n${used.encodeText(line).toString()} Tj\n`;
  });
  return ops + 'ET\nQ\n';
}

const SUBTYPES: Record<string, string> = {
  highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut', squiggly: 'Squiggly',
  ink: 'Ink', rect: 'Square', ellipse: 'Circle', line: 'Line', arrow: 'Line', polygon: 'Polygon', polyline: 'PolyLine',
  cloud: 'Polygon', text: 'FreeText', callout: 'FreeText', note: 'Text', stamp: 'Stamp', image: 'Stamp',
  measure: 'Line', redact: 'Redact', whiteout: 'Square', math: 'Stamp',
};

async function addAnnot(doc: PDFDocument, page: PDFPage, a: SaveAnnot, fonts: FontBox, options: BuildOptions) {
  const ctx = doc.context;
  if (a.kind === 'link') {
    const ref = ctx.register(ctx.obj({
      Type: 'Annot', Subtype: 'Link', Rect: a.rect, Border: [0, 0, 0], F: 4,
      A: { S: 'URI', URI: PDFString.of(a.url ?? '') },
    }));
    page.node.addAnnot(ref);
    return;
  }
  if (a.field) { await addField(doc, page, a, fonts); return; }
  if (a.attachmentBytes) { addFileNote(doc, page, a); return; }
  if (a.kind === 'attachment') throw new Error('The pinned file has no readable bytes.');

  const ap = await buildAppearance(doc, a, fonts);
  const form = ctx.register(ctx.flateStream(ap.ops, {
    Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: ap.bbox, Resources: ap.resources,
    Group: a.kind === 'highlight' || a.marker ? { S: 'Transparency', Type: 'Group' } : undefined,
  } as never));

  if (a.burn || options.flattenAnnots) {
    drawForm(page, form, 1, 0, 0, 1, 0, 0);
    return;
  }

  const dict = ctx.obj({
    Type: 'Annot', Subtype: SUBTYPES[a.kind] ?? 'Square',
    Rect: ap.bbox, F: 4, CA: a.opacity,
    AP: { N: form },
  }) as PDFDict;
  dict.set(N('NM'), PDFHexString.fromText(`pdfy-${a.id}`));
  dict.set(N('C'), ctx.obj(hexRgb(a.color)));
  dict.set(N('M'), PDFString.fromDate(new Date(a.created ?? Date.now())));
  if (a.author) dict.set(N('T'), PDFHexString.fromText(a.author));
  const contents = a.contents ?? a.text;
  if (contents) dict.set(N('Contents'), PDFHexString.fromText(contents));
  if (a.width) dict.set(N('BS'), ctx.obj({ W: a.width, S: 'S' }));
  if (a.fill) dict.set(N('IC'), ctx.obj(hexRgb(a.fill)));

  switch (a.kind) {
    case 'highlight': case 'underline': case 'strikeout': case 'squiggly':
      dict.set(N('QuadPoints'), ctx.obj((a.quads ?? []).flat())); break;
    case 'ink':
      dict.set(N('InkList'), ctx.obj(a.paths ?? []));
      if (a.marker) dict.set(N('IT'), N('FreehandHighlight'));
      break;
    case 'line': case 'arrow': case 'measure':
      dict.set(N('L'), ctx.obj((a.pts ?? []).slice(0, 4)));
      if (a.kind === 'arrow') dict.set(N('LE'), ctx.obj([N('None'), N('ClosedArrow')]));
      break;
    case 'polygon': case 'polyline': case 'cloud':
      dict.set(N('Vertices'), ctx.obj(a.pts ?? []));
      if (a.kind === 'cloud') dict.set(N('BE'), ctx.obj({ S: 'C', I: 1 }));
      break;
    case 'text': case 'callout': {
      const c = hexRgb(a.textColor ?? a.color);
      dict.set(N('DA'), PDFString.of(`${num(c[0])} ${num(c[1])} ${num(c[2])} rg /Helv ${a.fontSize ?? 12} Tf`));
      if (a.kind === 'callout' && a.pts) {
        const leader = calloutLeader(a as never);
        const flat = leader.flatMap(s => s.slice(1) as number[]);
        if (flat.length >= 4) dict.set(N('CL'), ctx.obj(flat.slice(0, 4)));
        dict.set(N('IT'), N('FreeTextCallout'));
      }
      break;
    }
    case 'note': dict.set(N('Name'), N('Comment')); break;
    case 'stamp': dict.set(N('Name'), N('Draft')); break;
    case 'math':
      dict.set(N('Name'), N('Equation'));
      if (a.angle) dict.set(N('Rotate'), PDFNumber.of(a.angle));
      break;
    case 'image':
      dict.set(N('Name'), N('Image'));
      if (a.angle) dict.set(N('Rotate'), PDFNumber.of(a.angle));
      break;
  }
  const parent = ctx.register(dict);
  page.node.addAnnot(parent);
  addThread(doc, page, a, parent);
}

/** Replies and review status, stored the standard way so other PDF apps show them as a thread. */
function addThread(doc: PDFDocument, page: PDFPage, a: SaveAnnot, parent: PDFRef) {
  const ctx = doc.context;
  const child = (contents: string, author: string, when: number) => {
    const d = ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: a.rect, F: 28, IRT: parent, RT: 'R', Name: 'Comment' }) as PDFDict;
    d.set(N('Contents'), PDFHexString.fromText(contents));
    if (author) d.set(N('T'), PDFHexString.fromText(author));
    d.set(N('M'), PDFString.fromDate(new Date(when || Date.now())));
    return d;
  };
  for (const r of a.replies ?? []) page.node.addAnnot(ctx.register(child(r.text, r.author, r.when)));
  if (a.status && a.status !== 'none') {
    const word = a.status[0].toUpperCase() + a.status.slice(1);
    const d = child(`${word} set by ${a.author ?? 'reviewer'}`, a.author ?? '', Date.now());
    d.set(N('F'), PDFNumber.of(30));
    d.set(N('State'), PDFString.of(word));
    d.set(N('StateModel'), PDFString.of('Review'));
    page.node.addAnnot(ctx.register(d));
  }
}

/** A file pinned to a spot on the page. Other PDF apps show it as a paperclip they can open. */
function addFileNote(doc: PDFDocument, page: PDFPage, a: SaveAnnot) {
  const ctx = doc.context;
  const bytes = new Uint8Array(a.attachmentBytes!);
  const name = a.attachment?.name ?? 'attachment';
  const file = ctx.register(ctx.flateStream(bytes, {
    Type: 'EmbeddedFile', Subtype: a.attachment?.mime ? N(a.attachment.mime.replace('/', '#2F').split(';')[0]) : undefined,
    Params: { Size: bytes.length, ModDate: PDFString.fromDate(new Date()) },
  } as never));
  const spec = ctx.obj({ Type: 'Filespec', EF: { F: file, UF: file } } as never) as unknown as PDFDict;
  spec.set(N('F'), PDFString.of(name.replace(/[^\x20-\x7e]/g, '_')));
  spec.set(N('UF'), PDFHexString.fromText(name));
  const specRef = ctx.register(spec);
  const [x0, y0, x1, y1] = a.rect;
  const icon = shapeOf(a as never);
  const w = x1 - x0, h = y1 - y0;
  // A simple coloured tab, so the spot is visible in every viewer.
  const ops = `q ${rgbOp(a.color, 'rg')}${rgbOp('#5f5a2a', 'RG')}0.75 w ${segsToPdf(icon.fill)}B Q`;
  const ap = ctx.register(ctx.flateStream(ops, {
    Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [x0, y0, x1, y1], Resources: ctx.obj({}),
  } as never));
  const dict = ctx.obj({ Type: 'Annot', Subtype: 'FileAttachment', Rect: a.rect, F: 4, FS: specRef, AP: { N: ap } } as never) as unknown as PDFDict;
  void w; void h;
  dict.set(N('Name'), N(a.attachment?.voice ? 'Speaker' : 'Paperclip'));
  dict.set(N('NM'), PDFHexString.fromText(`pdfy-${a.id}`));
  dict.set(N('C'), ctx.obj(hexRgb(a.color)));
  dict.set(N('Contents'), PDFHexString.fromText(a.contents ?? name));
  if (a.author) dict.set(N('T'), PDFHexString.fromText(a.author));
  dict.set(N('M'), PDFString.fromDate(new Date(a.created ?? Date.now())));
  page.node.addAnnot(ctx.register(dict));
}

/**
 * Draws a filled-in answer into its field, so it shows and prints in every app. Plain Latin text
 * uses the standard font; anything else uses a font from this PC. If drawing fails, the answer is
 * still stored, and other apps are asked to draw it themselves.
 */
async function drawAnswer(doc: PDFDocument, fonts: FontBox, update: (font: PDFFont) => void, text: string) {
  void doc;
  try {
    const plain = [...text].every(ch => { const c = ch.codePointAt(0)!; return c === 10 || c === 13 || (c >= 32 && c < 127) || (c >= 160 && c <= 255); });
    const font = plain ? await fonts.get(false) : await fonts.getEmbedded(false);
    // Only draw when the font has every letter, so an answer never prints as empty boxes. Otherwise
    // the answer is still stored in the field, and PDF apps that draw fields themselves show it.
    if (!font) return;
    const has = new Set(font.getCharacterSet());
    if (![...text].every(ch => ch === '\n' || ch === '\r' || has.has(ch.codePointAt(0)!))) return;
    update(font);
  } catch (err) {
    console.warn('Field appearance', err);
  }
}

async function addField(doc: PDFDocument, page: PDFPage, a: SaveAnnot, fonts: FontBox) {
  const form = doc.getForm();
  const f = a.field!;
  const box = { x: a.rect[0], y: a.rect[1], width: a.rect[2] - a.rect[0], height: a.rect[3] - a.rect[1] };
  // Names must be unique, except for radio choices: those with one name are one question.
  let name = f.name || `field_${a.id}`;
  const group = f.type === 'radio' ? form.getFieldMaybe(name) : undefined;
  if (group && f.type === 'radio' && group instanceof PDFRadioGroup) {
    const taken = group.getOptions();
    let option = f.options?.[0] ?? 'Option1';
    for (let i = 2; taken.includes(option); i++) option = `${f.options?.[0] ?? 'Option'} ${i}`;
    group.addOptionToPage(option, page, box);
    if (f.value === true) group.select(option);
    return;
  }
  for (let i = 2; form.getFieldMaybe(name); i++) name = `${f.name}_${i}`;
  // What was typed or ticked before saving goes into the file as the field's value.
  const value = f.value;
  const text = typeof value === 'string' ? value : '';
  switch (f.type) {
    case 'text': {
      const t = form.createTextField(name);
      if (text.includes('\n')) t.enableMultiline();
      t.addToPage(page, box);
      if (text) { t.setText(text); await drawAnswer(doc, fonts, f => t.updateAppearances(f), text); }
      break;
    }
    case 'check': {
      const c = form.createCheckBox(name);
      c.addToPage(page, box);
      if (value === true) c.check();
      break;
    }
    case 'radio': {
      const g = form.createRadioGroup(name);
      const option = f.options?.[0] ?? 'Option1';
      g.addOptionToPage(option, page, box);
      if (value === true) g.select(option);
      break;
    }
    case 'dropdown': {
      const d = form.createDropdown(name);
      const options = f.options?.length ? f.options : ['Option 1', 'Option 2'];
      d.addOptions(options);
      d.addToPage(page, box);
      if (text && options.includes(text)) { d.select(text); await drawAnswer(doc, fonts, f => d.updateAppearances(f), text); }
      break;
    }
    case 'list': {
      const l = form.createOptionList(name);
      const options = f.options?.length ? f.options : ['Option 1', 'Option 2'];
      l.addOptions(options);
      l.enableMultiselect();
      l.addToPage(page, box);
      const chosen = Array.isArray(value) ? value.filter(x => options.includes(x)) : [];
      if (chosen.length) { l.select(chosen); await drawAnswer(doc, fonts, f => l.updateAppearances(f), chosen.join(' ')); }
      break;
    }
    case 'signature': {
      const sig = doc.context.obj({
        Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of(name), Rect: a.rect, F: 4,
      });
      const ref = doc.context.register(sig);
      page.node.addAnnot(ref);
      const acro = form.acroForm;
      acro.addField(ref);
      break;
    }
  }
}

function drawForm(page: PDFPage, form: PDFRef, a: number, b: number, c: number, d: number, e: number, f: number) {
  const name = page.node.newXObject('FX', form);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(a, b, c, d, e, f), drawObject(name), popGraphicsState());
}

/** Draws every annotation's appearance into the page, then removes the annotation. */
function flattenPage(doc: PDFDocument, page: PDFPage, warnings: string[]) {
  const arr = annotsOf(page);
  if (!arr) return;
  let kept = 0;
  for (let i = arr.size() - 1; i >= 0; i--) {
    const dict = arr.lookup(i);
    if (!(dict instanceof PDFDict)) continue;
    const sub = dict.lookup(N('Subtype'));
    const subName = sub instanceof PDFName ? sub.decodeText() : '';
    if (subName === 'Popup') { arr.remove(i); continue; }
    if (subName === 'Link' || subName === 'Widget') continue;
    const ap = dict.lookup(N('AP'));
    let normal = ap instanceof PDFDict ? ap.get(N('N')) : undefined;
    const resolved = normal ? doc.context.lookup(normal) : undefined;
    if (resolved instanceof PDFDict && !(resolved instanceof PDFStream)) {
      const state = dict.lookup(N('AS'));
      normal = state instanceof PDFName ? resolved.get(state) : undefined;
    }
    const stream = normal ? doc.context.lookup(normal) : undefined;
    const rectObj = dict.lookup(N('Rect'));
    if (stream instanceof PDFStream && normal instanceof PDFRef && rectObj instanceof PDFArray) {
      const rect = rectObj.asArray().map(v => (v instanceof PDFNumber ? v.asNumber() : NaN));
      const bb = stream.dict.lookup(N('BBox'));
      if (!(bb instanceof PDFArray)) { kept++; continue; }
      const box = bb.asArray().map(v => (v instanceof PDFNumber ? v.asNumber() : NaN));
      const mx = stream.dict.lookup(N('Matrix'));
      const m = mx instanceof PDFArray ? mx.asArray().map(v => (v instanceof PDFNumber ? v.asNumber() : NaN)) : [1, 0, 0, 1, 0, 0];
      if (rect.length !== 4 || box.length !== 4 || m.length !== 6 || ![...rect, ...box, ...m].every(Number.isFinite)) { kept++; continue; }
      const xs: number[] = [], ys: number[] = [];
      for (const [x, y] of [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]]) {
        xs.push(m[0] * x + m[2] * y + m[4]); ys.push(m[1] * x + m[3] * y + m[5]);
      }
      const tx0 = Math.min(...xs), tx1 = Math.max(...xs), ty0 = Math.min(...ys), ty1 = Math.max(...ys);
      const rx0 = Math.min(rect[0], rect[2]), rx1 = Math.max(rect[0], rect[2]);
      const ry0 = Math.min(rect[1], rect[3]), ry1 = Math.max(rect[1], rect[3]);
      if (tx0 === tx1 || ty0 === ty1 || rx0 === rx1 || ry0 === ry1) { kept++; continue; }
      const sx = tx1 - tx0 ? (rx1 - rx0) / (tx1 - tx0) : 1, sy = ty1 - ty0 ? (ry1 - ry0) / (ty1 - ty0) : 1;
      drawForm(page, normal, sx, 0, 0, sy, rx0 - tx0 * sx, ry0 - ty0 * sy);
      arr.remove(i);
    } else kept++;
  }
  if (kept) warnings.push(`${kept} annotation${kept === 1 ? ' was' : 's were'} kept editable because an appearance could not be drawn safely.`);
}

/** Words drawn in invisible mode, so search and copy work on scanned pages but nothing shows. */
async function drawHiddenText(page: PDFPage, words: NonNullable<SavePage['hiddenText']>, fonts: FontBox) {
  const standard = await fonts.get(false);
  const real = await fonts.getEmbedded(false);
  const tag = page.node.newFontDictionary('OCR', standard.ref);
  const realTag = real ? page.node.newFontDictionary('OCRU', real.ref) : null;
  const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
  for (const w of words) {
    let encoded;
    let font = standard, name = tag;
    if (LATIN_ONLY.test(w.text)) encoded = standard.encodeText(w.text);
    else {
      // A real font handles any language, if the PC has one to use.
      if (!real || !realTag || !fontHasAll(real, w.text)) continue;
      try { encoded = real.encodeText(w.text); font = real; name = realTag; } catch { continue; }
    }
    const size = Math.max(1, w.h);
    const natural = font.widthOfTextAtSize(w.text, size) || 1;
    ops.push(setFontAndSize(name, size), setCharacterSqueeze((w.w / natural) * 100), setTextMatrix(1, 0, 0, 1, w.x, w.y), showText(encoded));
  }
  ops.push(endText(), popGraphicsState());
  page.pushOperators(...ops);
}

function stripMetadata(doc: PDFDocument) {
  doc.catalog.delete(N('Metadata'));
  const info = doc.context.trailerInfo.Info;
  if (info) {
    doc.context.delete(info as PDFRef);
    doc.context.trailerInfo.Info = undefined;
  }
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && !(obj instanceof PDFStream)) {
      obj.delete(N('PieceInfo'));
      obj.delete(N('LastModified'));
    }
    if (obj instanceof PDFStream) obj.dict.delete(N('Metadata'));
  }
}

/** Removes objects nothing points at, or deleted pages would stay inside the file. */
function removeUnreachable(doc: PDFDocument) {
  const ctx: PDFContext = doc.context;
  const seen = new Set<string>();
  const stack: unknown[] = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt, ctx.trailerInfo.ID];
  while (stack.length) {
    const o = stack.pop();
    if (!o) continue;
    if (o instanceof PDFRef) {
      const key = o.tag;
      if (seen.has(key)) continue;
      seen.add(key);
      stack.push(ctx.lookup(o));
    } else if (o instanceof PDFStream) {
      stack.push(o.dict);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) stack.push(v);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) stack.push(o.get(i));
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) ctx.delete(ref);
}

/** Re-encodes large images. Each one is only kept if it actually got smaller. */
async function compressImages(doc: PDFDocument, opt: { quality: number; maxSide: number }, warnings: string[], progress: (f: number) => void) {
  const items = doc.context.enumerateIndirectObjects().filter(([, o]) => {
    if (!(o instanceof PDFRawStream)) return false;
    const sub = o.dict.lookup(N('Subtype'));
    return sub instanceof PDFName && sub.decodeText() === 'Image';
  });
  let i = 0;
  for (const [ref, obj] of items) {
    i++;
    progress(i / items.length);
    try {
      const stream = obj as PDFRawStream;
      const mask = stream.dict.lookup(N('ImageMask'));
      if (mask && String(mask) === 'true') continue;
      if (stream.dict.has(N('Mask'))) continue; // Re-encoding must not drop explicit transparency.
      const w = (stream.dict.lookup(N('Width')) as PDFNumber)?.asNumber();
      const h = (stream.dict.lookup(N('Height')) as PDFNumber)?.asNumber();
      if (!w || !h) continue;
      const bitmap = await decodeImage(doc, stream, w, h);
      if (!bitmap) continue;
      const k = Math.min(1, opt.maxSide / Math.max(w, h));
      const nw = Math.max(1, Math.round(w * k)), nh = Math.max(1, Math.round(h * k));
      const canvas = new OffscreenCanvas(nw, nh);
      const c2d = canvas.getContext('2d')!;
      c2d.fillStyle = '#fff';
      c2d.fillRect(0, 0, nw, nh);
      c2d.imageSmoothingQuality = 'high';
      c2d.drawImage(bitmap, 0, 0, nw, nh);
      bitmap.close();
      const jpg = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: opt.quality })).arrayBuffer());
      if (jpg.length >= stream.contents.length * 0.95) continue;
      const dict = doc.context.obj({
        Type: 'XObject', Subtype: 'Image', Width: nw, Height: nh, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode',
      }) as PDFDict;
      const smask = stream.dict.get(N('SMask'));
      if (smask) dict.set(N('SMask'), smask);
      doc.context.assign(ref, PDFRawStream.of(dict, jpg));
    } catch (err) {
      warnings.push(`An image was left as it was (${String(err)})`);
    }
  }
}

async function decodeImage(doc: PDFDocument, stream: PDFRawStream, w: number, h: number): Promise<ImageBitmap | null> {
  const filter = stream.dict.lookup(N('Filter'));
  const name = filter instanceof PDFName ? filter.decodeText()
    : filter instanceof PDFArray && filter.size() === 1 ? String(filter.lookup(0)).replace('/', '') : '';
  const cs = stream.dict.lookup(N('ColorSpace'));
  let comps = 0;
  if (cs instanceof PDFName) comps = cs.decodeText() === 'DeviceRGB' ? 3 : cs.decodeText() === 'DeviceGray' ? 1 : 0;
  else if (cs instanceof PDFArray && String(cs.lookup(0)) === '/ICCBased') {
    const icc = cs.lookup(1);
    const n = icc instanceof PDFStream ? icc.dict.lookup(N('N')) : null;
    comps = n instanceof PDFNumber ? n.asNumber() : 0;
    if (comps !== 1 && comps !== 3) comps = 0;
  }
  if (!comps) return null; // CMYK and indexed images are left alone so colours do not shift.

  if (name === 'DCTDecode') return createImageBitmap(new Blob([stream.contents as BlobPart], { type: 'image/jpeg' }));
  if (name !== 'FlateDecode') return null;
  const bits = stream.dict.lookup(N('BitsPerComponent'));
  if (!(bits instanceof PDFNumber) || bits.asNumber() !== 8) return null;

  let raw: Uint8Array = unzlibSync(stream.contents);
  const parms = stream.dict.lookup(N('DecodeParms'));
  const pred = parms instanceof PDFDict ? parms.lookup(N('Predictor')) : null;
  if (pred instanceof PDFNumber && pred.asNumber() >= 10) raw = undoPngPredictor(raw, w * comps, h, comps);
  else if (pred instanceof PDFNumber && pred.asNumber() !== 1) return null;
  if (raw.length < w * h * comps) return null;

  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0, k = 0; i < w * h; i++, k += 4) {
    if (comps === 3) { rgba[k] = raw[j++]; rgba[k + 1] = raw[j++]; rgba[k + 2] = raw[j++]; }
    else { rgba[k] = rgba[k + 1] = rgba[k + 2] = raw[j++]; }
    rgba[k + 3] = 255;
  }
  void doc;
  return createImageBitmap(new ImageData(rgba, w, h));
}

function undoPngPredictor(src: Uint8Array, rowBytes: number, rows: number, bpp: number): Uint8Array {
  const out = new Uint8Array(rowBytes * rows);
  for (let y = 0; y < rows; y++) {
    const rowIn = y * (rowBytes + 1);
    const type = src[rowIn];
    const rowOut = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const v = src[rowIn + 1 + x] ?? 0;
      const a = x >= bpp ? out[rowOut + x - bpp] : 0;
      const b = y ? out[rowOut - rowBytes + x] : 0;
      const c = y && x >= bpp ? out[rowOut - rowBytes + x - bpp] : 0;
      let add = 0;
      if (type === 1) add = a;
      else if (type === 2) add = b;
      else if (type === 3) add = (a + b) >> 1;
      else if (type === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[rowOut + x] = v + add;
    }
  }
  return out;
}
