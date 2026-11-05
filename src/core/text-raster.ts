// Draws text the built-in PDF font cannot encode (Arabic, Chinese, emoji) as a sharp picture.
// Comes with no extra font files, so the app stays small.

import { FONT_CSS, type Annot } from './model';

const SCALE = 3;
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

export async function rgbaLine(a: Annot): Promise<ArrayBuffer> {
  const w = a.rect[2] - a.rect[0], h = a.rect[3] - a.rect[1];
  const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(w * SCALE)), Math.max(1, Math.ceil(h * SCALE)));
  const ctx = canvas.getContext('2d')!;
  ctx.scale(SCALE, SCALE);

  const isStamp = a.kind === 'stamp';
  const size = isStamp ? Math.min(h * 0.5, 40) : a.fontSize ?? 12;
  ctx.font = `${a.italic ? 'italic ' : ''}${isStamp || a.bold ? 'bold ' : ''}${size}px ${a.fontName ? `'${a.fontName.replace(/['\\]/g, '')}'` : FONT_CSS[a.font ?? 'helvetica']}, "Segoe UI", sans-serif`;
  ctx.fillStyle = a.textColor ?? a.color;
  ctx.textBaseline = 'alphabetic';

  const pad = isStamp ? 0 : 4;
  const lines: string[] = [];
  for (const para of (a.text ?? '').split(/\r?\n/)) {
    let cur = '';
    for (const word of para.split(/(\s+)/)) {
      const test = cur + word;
      if (ctx.measureText(test).width <= w - pad * 2 || !cur) cur = test;
      else { lines.push(cur.trimEnd()); cur = word.trimStart(); }
    }
    lines.push(cur);
  }

  const lead = size * 1.2;
  lines.forEach((line, i) => {
    const rtl = RTL.test(line);
    ctx.direction = rtl ? 'rtl' : 'ltr';
    if (isStamp) {
      ctx.textAlign = 'center';
      ctx.fillText(line, w / 2, h / 2 + size * 0.35);
    } else {
      ctx.textAlign = rtl ? 'right' : 'left';
      ctx.fillText(line, rtl ? w - pad : pad, pad + size * 0.85 + i * lead);
    }
  });

  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
}
