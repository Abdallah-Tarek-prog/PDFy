// Image types browsers cannot read on their own. Each decoder loads only when such a file appears.

/* eslint-disable @typescript-eslint/no-explicit-any */

export const isHeic = (f: { name?: string; type?: string }) => /heic|heif/i.test(f.type ?? '') || /\.(heic|heif)$/i.test(f.name ?? '');
export const isDicom = (f: { name?: string; type?: string }) => /dicom/i.test(f.type ?? '') || /\.dcm$/i.test(f.name ?? '');

let heicLoading: Promise<any> | null = null;

function loadHeic(): Promise<any> {
  heicLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/extra/heic2any.min.js';
    s.onload = () => resolve((window as any).heic2any);
    s.onerror = () => { heicLoading = null; reject(new Error('The HEIC reader could not be loaded.')); };
    document.head.append(s);
  });
  return heicLoading;
}

export async function heicToPng(blob: Blob): Promise<Blob> {
  const heic2any = await loadHeic();
  const out = await heic2any({ blob, toType: 'image/png' });
  return Array.isArray(out) ? out[0] : out;
}

interface DicomInfo { rows: number; cols: number; bits: number; stored: number; signed: boolean; samples: number; offset: number; length: number; center?: number; width?: number; slope: number; intercept: number; invert: boolean; little: boolean }

const LONG_VR = new Set(['OB', 'OW', 'OF', 'SQ', 'UT', 'UN', 'OD', 'OL', 'UC', 'UR']);

/** Reads the header of an uncompressed DICOM file. Compressed scans give a clear message. */
export function readDicom(buf: ArrayBuffer): DicomInfo {
  const view = new DataView(buf);
  const text = (o: number, n: number) => String.fromCharCode(...new Uint8Array(buf, o, n));
  if (buf.byteLength < 140 || text(128, 4) !== 'DICM') throw new Error('This is not a DICOM file.');
  let pos = 132;
  let explicit = true, little = true;
  const info: Partial<DicomInfo> & { slope: number; intercept: number } = { slope: 1, intercept: 0, samples: 1, signed: false, invert: false, little: true };
  let inMeta = true;

  while (pos + 8 <= buf.byteLength) {
    if (inMeta && view.getUint16(pos, true) !== 2) { inMeta = false; little = !(info as any).bigEndian; }
    const le = inMeta ? true : little;
    const group = view.getUint16(pos, le), element = view.getUint16(pos + 2, le);
    const tag = group * 65536 + element;
    let len: number, data: number;
    const isExplicit = inMeta ? true : explicit;
    if (group === 0xfffe) { len = view.getUint32(pos + 4, le); data = pos + 8; if (len === 0xffffffff) len = 0; pos = data + len; continue; }
    if (isExplicit) {
      const vr = text(pos + 4, 2);
      if (LONG_VR.has(vr)) { len = view.getUint32(pos + 8, le); data = pos + 12; }
      else { len = view.getUint16(pos + 6, le); data = pos + 8; }
    } else {
      len = view.getUint32(pos + 4, le);
      data = pos + 8;
    }
    if (tag === 0x00020010) {
      const uid = text(data, len).replace(/\0/g, '').trim();
      if (uid === '1.2.840.10008.1.2') explicit = false;
      else if (uid === '1.2.840.10008.1.2.2') { little = false; (info as any).bigEndian = true; }
      else if (uid !== '1.2.840.10008.1.2.1') throw new Error('This DICOM file is compressed, which PDFy cannot read yet.');
    }
    const u16 = () => view.getUint16(data, le);
    const num = () => parseFloat(text(data, len));
    if (tag === 0x00280002) info.samples = u16();
    else if (tag === 0x00280004) info.invert = text(data, len).trim() === 'MONOCHROME1';
    else if (tag === 0x00280010) info.rows = u16();
    else if (tag === 0x00280011) info.cols = u16();
    else if (tag === 0x00280100) info.bits = u16();
    else if (tag === 0x00280101) info.stored = u16();
    else if (tag === 0x00280103) info.signed = u16() === 1;
    else if (tag === 0x00281050) info.center = num();
    else if (tag === 0x00281051) info.width = num();
    else if (tag === 0x00281052) info.intercept = num();
    else if (tag === 0x00281053) info.slope = num();
    else if (tag === 0x7fe00010) {
      if (len === 0xffffffff || len === 0) throw new Error('This DICOM file is compressed, which PDFy cannot read yet.');
      info.offset = data;
      info.length = len;
      break;
    }
    if (len === 0xffffffff) throw new Error('This DICOM file uses a structure PDFy cannot read yet.');
    pos = data + len;
  }
  if (!info.rows || !info.cols || info.offset === undefined) throw new Error('This DICOM file has no picture PDFy can read.');
  info.bits ??= 16;
  info.stored ??= info.bits;
  info.little = little;
  return info as DicomInfo;
}

export async function dicomToPng(blob: Blob): Promise<Blob> {
  const buf = await blob.arrayBuffer();
  const d = readDicom(buf);
  const n = d.rows * d.cols;
  const out = new ImageData(d.cols, d.rows);
  if (d.samples === 3) {
    const src = new Uint8Array(buf, d.offset, Math.min(d.length, n * 3));
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      out.data[i * 4] = src[j]; out.data[i * 4 + 1] = src[j + 1]; out.data[i * 4 + 2] = src[j + 2]; out.data[i * 4 + 3] = 255;
    }
  } else {
    const view = new DataView(buf, d.offset, Math.min(d.length, n * (d.bits >> 3)));
    const values = new Float32Array(n);
    let lo = Infinity, hi = -Infinity;
    const shift = d.bits === 16 && d.stored < 16 ? 16 - d.stored : 0;
    for (let i = 0; i < n; i++) {
      let v: number;
      if (d.bits === 8) v = d.signed ? view.getInt8(i) : view.getUint8(i);
      else {
        const raw = view.getUint16(i * 2, d.little);
        v = d.signed && shift ? ((raw << shift) << 16 >> 16) >> shift : d.signed ? (raw << 16) >> 16 : raw;
      }
      v = v * d.slope + d.intercept;
      values[i] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    // Use the scan's own brightness window when it has one.
    const c = d.center, w = d.width;
    const min = c !== undefined && w ? c - w / 2 : lo;
    const max = c !== undefined && w ? c + w / 2 : hi;
    const range = max - min || 1;
    for (let i = 0; i < n; i++) {
      let g = Math.max(0, Math.min(255, ((values[i] - min) / range) * 255));
      if (d.invert) g = 255 - g;
      out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = g;
      out.data[i * 4 + 3] = 255;
    }
  }
  const canvas = new OffscreenCanvas(d.cols, d.rows);
  canvas.getContext('2d')!.putImageData(out, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** Turns anything image-like into something the browser can read. */
export async function readableImage(file: Blob & { name?: string }): Promise<Blob> {
  if (isHeic(file)) return heicToPng(file);
  if (isDicom(file)) return dicomToPng(file);
  return file;
}

/** Saves a converted HEIC or similar picture as a JPG or PNG. */
export async function convertImageFile(blob: Blob, type: 'image/png' | 'image/jpeg'): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const x = c.getContext('2d')!;
  x.fillStyle = '#fff';
  x.fillRect(0, 0, c.width, c.height);
  x.drawImage(bmp, 0, 0);
  bmp.close();
  return c.convertToBlob({ type, quality: 0.92 });
}
