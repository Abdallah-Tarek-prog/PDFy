// Test helpers: a realistic dark Gemini-style screenshot and a simulated Ctrl+V.
window.mockGemini = async function mockGemini() {
  const c = document.createElement('canvas');
  c.width = 1100; c.height = 720;
  const x = c.getContext('2d');
  x.fillStyle = '#131314'; x.fillRect(0, 0, 1100, 720);
  x.fillStyle = '#1e1f20'; x.fillRect(0, 0, 230, 720);
  x.fillStyle = '#e3e3e3'; x.font = '15px Segoe UI, Arial';
  x.fillText('New chat', 54, 44);
  x.fillStyle = '#c4c7c5'; x.font = '13px Segoe UI, Arial';
  ['Recent', 'Theme converter idea', 'PDF editor features', 'Trip to Aswan', 'Dark mode colours'].forEach((t, i) => x.fillText(t, 24, 92 + i * 34));
  const g = x.createLinearGradient(260, 30, 300, 70);
  g.addColorStop(0, '#4285f4'); g.addColorStop(0.5, '#9b72cb'); g.addColorStop(1, '#d96570');
  x.fillStyle = g;
  x.beginPath(); x.moveTo(280, 30); x.quadraticCurveTo(284, 46, 300, 50); x.quadraticCurveTo(284, 54, 280, 70); x.quadraticCurveTo(276, 54, 260, 50); x.quadraticCurveTo(276, 46, 280, 30); x.fill();
  x.fillStyle = '#282a2c'; x.beginPath(); x.roundRect(640, 24, 420, 50, 18); x.fill();
  x.fillStyle = '#e3e3e3'; x.font = '15px Segoe UI, Arial'; x.fillText('How do I convert a screenshot to light mode?', 660, 54);
  x.fillStyle = '#e3e3e3'; x.font = '16px Segoe UI, Arial';
  ['Here is a simple way to think about it. Only lightness should flip,', 'so colours keep their meaning. For example, this link stays blue:'].forEach((t, i) => x.fillText(t, 320, 118 + i * 26));
  x.fillStyle = '#a8c7fa'; x.fillText('developers.google.com/gemini', 320, 172);
  x.fillStyle = '#f28b82'; x.fillText('A red warning stays red', 600, 172);
  x.fillStyle = '#81c995'; x.fillText('Green stays green', 800, 172);
  x.fillStyle = '#1e1f20'; x.beginPath(); x.roundRect(320, 195, 720, 150, 12); x.fill();
  x.font = '14px Consolas, monospace';
  const rows = [
    [['function ', '#c58af9'], ['convert', '#fdd663'], ['(pixels) {', '#e3e3e3']],
    [['  const ', '#c58af9'], ['L = ', '#e3e3e3'], ['1 - lightness', '#8ab4f8'], [';', '#e3e3e3']],
    [['  return ', '#c58af9'], ['oklch', '#fdd663'], ['(L, chroma, hue);', '#e3e3e3']],
    [['}', '#e3e3e3']],
    [['// comment line', '#9aa0a6']],
  ];
  rows.forEach((r, i) => { let px = 340; r.forEach(([t, col]) => { x.fillStyle = col; x.fillText(t, px, 225 + i * 24); px += x.measureText(t).width; }); });
  // A photo: smooth colour with fine grain, as a real photo has.
  x.save(); x.beginPath(); x.roundRect(320, 370, 320, 220, 14); x.clip();
  const img = x.createImageData(320, 220);
  for (let j = 0; j < 220; j++) for (let i = 0; i < 320; i++) {
    const k = (j * 320 + i) * 4;
    const n = Math.sin(i * 0.09) * Math.cos(j * 0.07) * 40 + ((i * 7 + j * 13) % 23);
    img.data[k] = 120 + i * 0.3 + n; img.data[k + 1] = 90 + j * 0.5 + n; img.data[k + 2] = 60 + (i + j) * 0.25 + n * 1.2; img.data[k + 3] = 255;
  }
  const tmp = document.createElement('canvas');
  tmp.width = 320; tmp.height = 220;
  tmp.getContext('2d').putImageData(img, 0, 0);
  x.drawImage(tmp, 320, 370);
  x.restore();
  x.fillStyle = '#c4c7c5'; x.font = '13px Segoe UI, Arial'; x.fillText('A photo inside the screenshot should not change.', 660, 480);
  x.fillStyle = '#1e1f20'; x.beginPath(); x.roundRect(320, 630, 720, 60, 28); x.fill();
  x.fillStyle = '#8e918f'; x.font = '15px Segoe UI, Arial'; x.fillText('Ask Gemini', 348, 665);
  return new Promise(r => c.toBlob(r, 'image/png'));
};

window.paste = async function paste(blob) {
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
  document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
};
