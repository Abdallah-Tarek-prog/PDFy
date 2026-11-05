// Creates the test PDFs: normal, huge, forms, annotated, locked, rotated, mixed sizes and broken.
import { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFString, PDFHexString } from '@cantoo/pdf-lib';
import { mkdir, writeFile } from 'node:fs/promises';

const dir = new URL('./fixtures/', import.meta.url);
await mkdir(dir, { recursive: true });
const put = (name, bytes) => writeFile(new URL(name, dir), bytes);

const LOREM = 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump.';

async function textDoc(pages, label = 'Page') {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`${label} ${i + 1}`, { x: 60, y: 730, size: 22, font: bold });
    for (let l = 0; l < 6; l++) page.drawText(LOREM.slice(0, 80), { x: 60, y: 690 - l * 18, size: 11, font });
    page.drawText(`needle${i + 1}`, { x: 60, y: 560, size: 12, font, color: rgb(0, 0, 0.7) });
  }
  return doc;
}

// A normal 12-page document with an outline-free structure.
await put('normal.pdf', await (await textDoc(12)).save());

// 3,000 pages, for checking that memory stays flat.
await put('huge-3000.pdf', await (await textDoc(3000)).save());

// Different page sizes and rotations.
{
  const doc = await textDoc(4);
  const pages = doc.getPages();
  pages[1].setRotation(degrees(90));
  pages[2].setSize(842, 595);
  pages[3].setRotation(degrees(270));
  await put('rotated-mixed.pdf', await doc.save());
}

// A form with every common field type.
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Application form', { x: 60, y: 740, size: 20, font });
  const form = doc.getForm();
  page.drawText('Name', { x: 60, y: 690, size: 11, font });
  form.createTextField('name').addToPage(page, { x: 130, y: 682, width: 300, height: 24 });
  page.drawText('Agree', { x: 60, y: 650, size: 11, font });
  form.createCheckBox('agree').addToPage(page, { x: 130, y: 646, width: 18, height: 18 });
  page.drawText('Country', { x: 60, y: 610, size: 11, font });
  const dd = form.createDropdown('country');
  dd.addOptions(['Egypt', 'Jordan', 'Morocco']);
  dd.addToPage(page, { x: 130, y: 602, width: 200, height: 24 });
  page.drawText('Plan', { x: 60, y: 570, size: 11, font });
  const radio = form.createRadioGroup('plan');
  radio.addOptionToPage('basic', page, { x: 130, y: 566, width: 16, height: 16 });
  radio.addOptionToPage('pro', page, { x: 170, y: 566, width: 16, height: 16 });
  await put('form.pdf', await doc.save());
}

// A file with annotations made by another app, plus a web link.
{
  const doc = await textDoc(2);
  const page = doc.getPages()[0];
  const ctx = doc.context;
  const ap = ctx.register(ctx.flateStream('0.2 0.6 1 rg 100 300 200 80 re f', { Type: 'XObject', Subtype: 'Form', BBox: [100, 300, 300, 380] }));
  page.node.addAnnot(ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Square', Rect: [100, 300, 300, 380], C: [0.2, 0.6, 1], F: 4,
    Contents: PDFHexString.fromText('Square from another app'), T: PDFString.of('Someone else'), AP: { N: ap },
  })));
  page.node.addAnnot(ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [60, 725, 200, 755], Border: [0, 0, 0], A: { S: 'URI', URI: PDFString.of('https://example.com/') },
  })));
  await put('annotated.pdf', await doc.save());
}

// Password protected. The password is "secret".
{
  const doc = await textDoc(3, 'Locked page');
  doc.encrypt({ userPassword: 'secret', ownerPassword: 'owner', permissions: { printing: 'highResolution', copying: true, modifying: true, annotating: true } });
  await put('locked.pdf', await doc.save({ useObjectStreams: false }));
}

// A scan-like page: a picture of text with nothing selectable.
{
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  await put('blank-noText.pdf', await doc.save());
}

// A report with a heading, paragraphs, a table and a picture, for export tests.
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText('Sales Report', { x: 240, y: 730, size: 24, font: bold });
  page.drawText('This paragraph explains the numbers in the table below it.', { x: 60, y: 690, size: 11, font });
  const rows = [['Region', 'Units', 'Revenue'], ['North', '120', '4500'], ['South', '98', '3900'], ['East', '143', '5100']];
  rows.forEach((r, i) => r.forEach((c, j) => page.drawText(c, { x: 60 + j * 170, y: 650 - i * 20, size: 11, font: i ? font : bold })));
  page.drawText('Text after the table.', { x: 60, y: 550, size: 11, font });
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSALGlP8F8m3iPAAAAAElFTkSuQmCC', 'base64'));
  const img = await doc.embedPng(png);
  page.drawImage(img, { x: 60, y: 400, width: 120, height: 120 });
  page.drawText('Text after the picture.', { x: 60, y: 370, size: 11, font });
  await put('report.pdf', await doc.save());
}

// Three pages with a contents list, a link that jumps inside the file, and a layer that can be hidden.
{
  const doc = await textDoc(3, 'Chapter');
  const ctx = doc.context;
  const pages = doc.getPages();
  // Contents list.
  const root = ctx.obj({ Type: 'Outlines', Count: 3 });
  const rootRef = ctx.register(root);
  const titles = ['Chapter one', 'Chapter two', 'Chapter three'];
  const items = titles.map((title, i) => {
    const item = ctx.obj({ Parent: rootRef, Dest: [pages[i].ref, PDFName.of('Fit')] });
    item.set(PDFName.of('Title'), PDFHexString.fromText(title));
    return { item, ref: ctx.register(item) };
  });
  items.forEach((it, i) => {
    if (i) it.item.set(PDFName.of('Prev'), items[i - 1].ref);
    if (i < items.length - 1) it.item.set(PDFName.of('Next'), items[i + 1].ref);
  });
  root.set(PDFName.of('First'), items[0].ref);
  root.set(PDFName.of('Last'), items[2].ref);
  doc.catalog.set(PDFName.of('Outlines'), rootRef);
  // A link from page 1 to page 2.
  pages[0].node.addAnnot(ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [60, 725, 300, 755], Border: [0, 0, 0], Dest: [pages[1].ref, PDFName.of('Fit')] })));
  // A red square on its own layer.
  const layer = ctx.obj({ Type: 'OCG' });
  layer.set(PDFName.of('Name'), PDFHexString.fromText('Red square'));
  const layerRef = ctx.register(layer);
  doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [layerRef], D: { ON: [layerRef], Order: [layerRef] } }));
  const res = pages[0].node.Resources();
  res.set(PDFName.of('Properties'), ctx.obj({ MC0: layerRef }));
  pages[0].node.addContentStream(ctx.register(ctx.flateStream('/OC /MC0 BDC q 1 0 0 rg 100 400 200 200 re f Q EMC')));
  await put('structure.pdf', await doc.save());
}

// Broken files. None of these may crash the app.
await put('empty.pdf', new Uint8Array(0));
await put('not-a-pdf.pdf', new TextEncoder().encode('This is just a text file pretending to be a PDF.\n'.repeat(50)));
{
  const good = await (await textDoc(3)).save();
  await put('truncated.pdf', good.slice(0, Math.floor(good.length * 0.55)));
  const noisy = good.slice();
  for (let i = 400; i < noisy.length; i += 97) noisy[i] = (noisy[i] + 91) & 255;
  await put('corrupted.pdf', noisy);
}
console.log('Fixtures written');
