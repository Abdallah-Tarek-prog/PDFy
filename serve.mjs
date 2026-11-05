// Small local server for development and testing. The installed app does not use it.
import { createServer } from 'node:http';
import { createReadStream, createWriteStream, mkdirSync, statSync } from 'node:fs';
import { basename, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./dist/', import.meta.url));
const extra = fileURLToPath(new URL('./tests/fixtures/', import.meta.url));
const output = fileURLToPath(new URL('./tests/output/', import.meta.url));
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.pdf': 'application/pdf', '.gz': 'application/gzip', '.ttf': 'font/ttf',
};
const port = +(process.env.PORT ?? 5199);

const WEB_HOSTS = ['dictionary.cambridge.org', 'www.oxfordlearnersdictionaries.com', 'www.ldoceonline.com'];

createServer((req, res) => {
  if (req.url.startsWith('/__web?')) {
    const target = new URL(req.url, 'http://x').searchParams.get('url') ?? '';
    let ok = false;
    try { const u = new URL(target); ok = u.protocol === 'https:' && WEB_HOSTS.includes(u.hostname); } catch { /* Not an address. */ }
    if (!ok) { res.writeHead(403); res.end('Only the dictionary sites'); return; }
    fetch(target, { headers: { 'user-agent': 'PDFy/1.0 (personal dictionary reader)' }, redirect: 'follow', signal: AbortSignal.timeout(15000) })
      .then(async r => { const html = await r.text(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: r.status, url: r.url, html: html.slice(0, 3_000_000) })); })
      .catch(err => { res.writeHead(502); res.end(String(err)); });
    return;
  }
  if (req.method === 'PUT' && req.url.startsWith('/__save/')) {
    const name = basename(decodeURIComponent(req.url.slice(8)));
    mkdirSync(output, { recursive: true });
    req.pipe(createWriteStream(join(output, name))).on('finish', () => { res.writeHead(204); res.end(); });
    return;
  }
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const safe = normalize(path).replace(/^([/\\])+/, '');
  const base = safe.startsWith('fixtures') ? extra : root;
  let file = join(base, safe.startsWith('fixtures') ? safe.slice(9) : (safe || 'index.html'));
  if (safe.startsWith('sysfonts')) file = join(process.env.WINDIR ?? 'C:/Windows', 'Fonts', basename(safe));
  if (safe.startsWith('corpus') && process.env.CORPUS_DIR) file = join(process.env.CORPUS_DIR, basename(safe));
  try {
    const st = statSync(file);
    if (st.isDirectory()) throw new Error('dir');
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`PDFy test server on http://localhost:${port}`));
