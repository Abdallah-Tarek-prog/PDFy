// Run the brand-assets browser fixture first; it renders SVGs with the same engine as the app.
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const source = 'tests/output';
const frames = [16, 24, 32, 48, 64, 128, 256].map(size => ({ size, bytes: readFileSync(join(source, `pdfy-icon-${size}.png`)) }));
const header = Buffer.alloc(6 + frames.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(frames.length, 4);
let offset = header.length;
frames.forEach(({ size, bytes }, index) => {
  const at = 6 + index * 16;
  header[at] = header[at + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(bytes.length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += bytes.length;
});
writeFileSync('host/pdfy.ico', Buffer.concat([header, ...frames.map(frame => frame.bytes)]));
mkdirSync('store/Assets', { recursive: true });
for (const [name, size] of [['Square44x44Logo.png',44],['Square150x150Logo.png',150],['StoreLogo.png',50],['Square44x44Logo.targetsize-256_altform-unplated.png',256],['Square150x150Logo.scale-400.png',600]]) {
  copyFileSync(join(source, `pdfy-icon-${size}.png`), join('store/Assets', name));
}
copyFileSync(join(source, 'pdfy-icon-512.png'), 'public/brand/app-icon-512.png');
console.log('Created Meletiq PDF Windows ICO and Store logos from the selected eagle SVG.');
