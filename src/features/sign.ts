// Certificate digital signatures, the kind that proves who signed and shows if the file changed
// afterwards. Uses a .p12 or .pfx digital ID. The crypto library loads only when signing.

/* eslint-disable @typescript-eslint/no-explicit-any */

let forgeLoading: Promise<any> | null = null;

function loadForge(): Promise<any> {
  forgeLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/extra/forge.min.js';
    s.onload = () => resolve((window as any).forge);
    s.onerror = () => { forgeLoading = null; reject(new Error('The signing library could not be loaded.')); };
    document.head.append(s);
  });
  return forgeLoading;
}

const toBinary = (bytes: Uint8Array) => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 32768) out += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return out;
};

export const fromBinary = (s: string) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
  return out;
};

export interface DigitalId { name: string; email: string; expires: Date; key: any; chain: any[] }

/** Opens a digital ID. A wrong password or a broken file gives a clear message. */
export async function readDigitalId(file: ArrayBuffer, password: string): Promise<DigitalId> {
  const forge = await loadForge();
  let p12;
  try {
    const asn1 = forge.asn1.fromDer(toBinary(new Uint8Array(file)));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch (err) {
    const m = String((err as Error).message ?? err);
    throw new Error(/mac|password|invalid/i.test(m) ? 'That password is not correct for this digital ID.' : 'This file is not a usable digital ID.');
  }
  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? [];
  const plainKeys = p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? [];
  const key = (keyBags[0] ?? plainKeys[0])?.key;
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []).map((b: any) => b.cert).filter(Boolean);
  if (!key || !certs.length) throw new Error('This digital ID has no signing key inside.');
  // The signing certificate is the one whose public key matches the private key.
  const own = certs.find((c: any) => c.publicKey?.n?.equals?.(key.n)) ?? certs[0];
  const chain = [own, ...certs.filter((c: any) => c !== own)];
  return {
    name: own.subject.getField('CN')?.value ?? 'Unknown signer',
    email: own.subject.getField({ name: 'emailAddress' })?.value ?? '',
    expires: own.validity.notAfter,
    key, chain,
  };
}

/** Makes a self-signed digital ID. It proves the file has not changed, but not who you are to others. */
export async function createDigitalId(name: string, email: string, password: string, years: number): Promise<Blob> {
  const forge = await loadForge();
  // Key generation runs in small steps, so the window stays responsive.
  const keys: any = await new Promise((res, rej) => forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1 }, (err: Error, k: any) => (err ? rej(err) : res(k))));
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = `01${[...crypto.getRandomValues(new Uint8Array(15))].map(b => b.toString(16).padStart(2, '0')).join('')}`;
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + years * 365.25 * 864e5);
  const attrs = [{ name: 'commonName', value: name }, ...(email ? [{ name: 'emailAddress', value: email }] : [])];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    { name: 'extKeyUsage', emailProtection: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des', friendlyName: name });
  return new Blob([fromBinary(forge.asn1.toDer(p12).getBytes()) as BlobPart], { type: 'application/x-pkcs12' });
}

/** Number of hex digits reserved in the file for the signature. */
export const SIGNATURE_HEX = 32768;
const MARK = 0x41; // 'A', the placeholder the save engine writes.

/**
 * Fills in the signature. The saved file holds an empty slot. Everything except that slot gets hashed
 * and signed, and the result is written into the slot, so the file's length never changes.
 */
export async function applySignature(pdf: Uint8Array, id: DigitalId): Promise<Blob> {
  const forge = await loadForge();
  const text = (from: number, to: number) => String.fromCharCode(...pdf.subarray(from, to));

  // Find the reserved slot: a long run of the placeholder letter between < and >.
  let start = -1;
  for (let i = pdf.length - SIGNATURE_HEX - 2; i >= 0; i--) {
    if (pdf[i] === 0x3c && pdf[i + 1] === MARK && pdf[i + SIGNATURE_HEX] === MARK && pdf[i + SIGNATURE_HEX + 1] === 0x3e) { start = i; break; }
  }
  if (start < 0) throw new Error('The signature space was not found in the file.');
  const end = start + SIGNATURE_HEX + 2;

  // Find the byte range placeholder just before it.
  let rangeAt = -1;
  const needle = '/ByteRange';
  for (let i = start; i >= Math.max(0, start - 4096); i--) {
    if (pdf[i] === 0x2f && text(i, i + needle.length) === needle) { rangeAt = i; break; }
  }
  if (rangeAt < 0) {
    for (let i = end; i < Math.min(pdf.length - needle.length, end + 4096); i++) {
      if (pdf[i] === 0x2f && text(i, i + needle.length) === needle) { rangeAt = i; break; }
    }
  }
  if (rangeAt < 0) throw new Error('The signature details were not found in the file.');
  const open = pdf.indexOf(0x5b, rangeAt), close = pdf.indexOf(0x5d, open);
  const slotLength = close - open - 1;
  const range = `0 ${start} ${end} ${pdf.length - end}`;
  if (range.length > slotLength) throw new Error('The signature details do not fit in the reserved space.');
  const out = pdf.slice();
  out.set(new TextEncoder().encode(range.padEnd(slotLength, ' ')), open + 1);

  // Everything except the slot is what gets signed.
  const signed = new Uint8Array(start + (out.length - end));
  signed.set(out.subarray(0, start), 0);
  signed.set(out.subarray(end), start);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(toBinary(signed));
  for (const c of id.chain) p7.addCertificate(c);
  p7.addSigner({
    key: id.key, certificate: id.chain[0], digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign({ detached: true });
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  const hex = forge.util.bytesToHex(der);
  if (hex.length > SIGNATURE_HEX) throw new Error('This digital ID is too large for the reserved space.');
  out.set(new TextEncoder().encode(hex.toUpperCase().padEnd(SIGNATURE_HEX, '0')), start + 1);
  return new Blob([out as BlobPart], { type: 'application/pdf' });
}
