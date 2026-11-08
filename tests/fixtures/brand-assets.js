// Render the selected Meletiq PDF eagle at real Windows icon and Store sizes.
const results = [];
const png = async (source, size) => {
  const picture = new Image();
  picture.src = source;
  await picture.decode();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d').drawImage(picture, 0, 0, size, size);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
};
results.push({ name: 'App title uses Meletiq PDF', ok: document.title === 'Meletiq PDF' });
results.push({ name: 'Title bar uses Meletiq PDF', ok: document.querySelector('.brand')?.textContent === 'Meletiq PDF' });
results.push({ name: 'Home uses Meletiq PDF', ok: document.querySelector('.home h1')?.textContent === 'Meletiq PDF' });
await window.__shot('Meletiq-PDF-home');
for (const size of [16, 24, 32, 44, 48, 50, 64, 128, 150, 256, 512, 600]) {
  const blob = await png('/brand/app-icon.svg', size);
  await fetch(`/__save/pdfy-icon-${size}.png`, { method: 'PUT', body: blob });
  results.push({ name: `Selected eagle renders at ${size} pixels`, ok: blob.size > 0 });
}
const sizes = [16, 24, 32, 48, 64, 128, 256];
const row = theme => `<div class="sizes ${theme}">${sizes.map(size => `<figure><img src="/brand/app-icon.svg" width="${size}" height="${size}" alt="${size} pixels"><figcaption>${size} px</figcaption></figure>`).join('')}</div>`;
document.body.innerHTML = `<style>*{box-sizing:border-box}body{margin:0;background:#f4f5f7;color:#172b3d;font:15px/1.5 'Segoe UI',sans-serif;padding:32px}h1{font-size:28px;margin:0 0 8px}p{margin:0 0 20px}.sizes{display:flex;gap:28px;align-items:center;padding:24px;border-radius:12px;margin:16px 0}.light{background:white}.dark{background:#202325;color:#f5f5f5}figure{margin:0;text-align:center}figcaption{font-size:12px;margin-top:10px}.master{float:right;margin-right:28px}</style><img class="master" src="/brand/mark.svg" width="180" height="180" alt="Selected eagle mark"><h1>Meletiq PDF</h1><p>Selected A / Profile eagle. Original navy and gold; no caption or screenshot background in the master.</p><h2>Windows icon sizes</h2>${row('light')}${row('dark')}`;
await window.__shot('Meletiq-PDF-icon-sizes');
await fetch('/__save/test-progress.json', { method: 'PUT', body: JSON.stringify({ done: results.length, passed: results.filter(r => r.ok).length, heapMB: 0, results }) });
export default { summary: { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, results };
