// Writes small Word, Excel and PowerPoint files with the same structure Office produces, including
// styles, numbering, tables, pictures, and slide layouts with inherited placeholder positions.
import { strToU8, zipSync } from 'fflate';
import { writeFileSync } from 'node:fs';

const dir = new URL('./fixtures/', import.meta.url);
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSALGlP8F8m3iPAAAAAElFTkSuQmCC', 'base64'));
const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const rels = list => `${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.join('')}</Relationships>`;
const zipFile = (name, files) => {
  const z = {};
  for (const [k, v] of Object.entries(files)) z[k] = typeof v === 'string' ? strToU8(v) : v;
  writeFileSync(new URL(name, dir), zipSync(z));
};

// ---- Word ----
const para = (text, pPr = '', rPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const longLines = Array.from({ length: 70 }, (_, i) => para(`Long content line number ${i + 1} so the text runs over onto another page.`)).join('');
const body = [
  para('Quarterly report', '<w:pStyle w:val="Heading1"/>'),
  para('Summary section', '<w:pStyle w:val="Heading2"/>'),
  `<w:p><w:r><w:t xml:space="preserve">This is a normal paragraph with </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>bold words</w:t></w:r><w:r><w:t xml:space="preserve"> and </w:t></w:r><w:r><w:rPr><w:i/><w:color w:val="C80000"/></w:rPr><w:t>red italic words</w:t></w:r><w:r><w:t>.</w:t></w:r></w:p>`,
  para('A centred line of text.', '<w:jc w:val="center"/>'),
  para('First bullet point', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
  para('Second bullet point', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
  para('Step one', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'),
  para('Step two', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'),
  `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>
   <w:tr><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:shd w:fill="DDEEFF"/></w:tcPr>${para('Region')}</w:tc><w:tc>${para('Sales')}</w:tc><w:tc>${para('Growth')}</w:tc></w:tr>
   <w:tr><w:tc>${para('North')}</w:tc><w:tc>${para('1200')}</w:tc><w:tc>${para('4%')}</w:tc></w:tr></w:tbl>`,
  `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId9"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
  `<w:p><w:hyperlink r:id="rId8"><w:r><w:t>A web link</w:t></w:r></w:hyperlink></w:p>`,
  `<w:p><w:pPr><w:bidi/></w:pPr><w:r><w:rPr><w:rtl/></w:rPr><w:t>هذا نص عربي للتجربة</w:t></w:r></w:p>`,
  `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`,
  para('Second page heading', '<w:pStyle w:val="Heading2"/>'),
  longLines,
].join('');
zipFile('sample.docx', {
  '[Content_Types].xml': `${X}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  '_rels/.rels': rels(['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>']),
  'word/document.xml': `${X}<w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
  'word/_rels/document.xml.rels': rels([
    '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>',
    '<Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/>',
  ]),
  'word/media/image1.png': PNG,
  'word/styles.xml': `${X}<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
    <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
    <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:color w:val="2F5496"/><w:sz w:val="36"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:color w:val="2F5496"/><w:sz w:val="28"/></w:rPr></w:style></w:styles>`,
  'word/numbering.xml': `${X}<w:numbering ${W}>
    <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
    <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
    <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
});

// ---- Excel ----
const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
zipFile('sample.xlsx', {
  '[Content_Types].xml': `${X}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
  '_rels/.rels': rels(['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>']),
  'xl/workbook.xml': `${X}<workbook ${S}><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Second sheet" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': rels([
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>',
  ]),
  'xl/sharedStrings.xml': `${X}<sst ${S}><si><t>Item</t></si><si><t>Cost</t></si><si><t>Rent</t></si><si><t>Food</t></si><si><t>Total</t></si><si><t>Unique cell text</t></si></sst>`,
  'xl/styles.xml': `${X}<styleSheet ${S}><fonts><font><sz val="11"/></font><font><b/><sz val="11"/></font></fonts><fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDEEFF"/></patternFill></fill></fills><cellXfs><xf fontId="0" fillId="0"/><xf fontId="1" fillId="1"/></cellXfs></styleSheet>`,
  'xl/worksheets/sheet1.xml': `${X}<worksheet ${S}><sheetData>
    <row r="1"><c r="A1" t="s" s="1"><v>0</v></c><c r="B1" t="s" s="1"><v>1</v></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1200</v></c></row>
    <row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>345.5</v></c></row>
    <row r="4"><c r="A4" t="s"><v>4</v></c><c r="B4"><f>B2+B3</f><v>1545.5</v></c></row></sheetData></worksheet>`,
  'xl/worksheets/sheet2.xml': `${X}<worksheet ${S}><sheetData><row r="2"><c r="B2" t="s"><v>5</v></c></row></sheetData></worksheet>`,
});

// ---- PowerPoint ----
const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const ph = (type, text, idx) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"/><p:cNvSpPr/><p:nvPr><p:ph type="${type}"${idx ? ` idx="${idx}"` : ''}/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:rPr/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
const box = (x, y, w, h) => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`;
const layoutPh = (type, x, y, w, h, idx) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"/><p:cNvSpPr/><p:nvPr><p:ph type="${type}"${idx ? ` idx="${idx}"` : ''}/></p:nvPr></p:nvSpPr><p:spPr>${box(x, y, w, h)}</p:spPr><p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp>`;
const tree = inner => `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${inner}</p:spTree></p:cSld>`;
const slideRel = extra => rels(['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>', ...extra]);
zipFile('sample.pptx', {
  '[Content_Types].xml': `${X}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>`,
  '_rels/.rels': rels(['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>']),
  'ppt/presentation.xml': `${X}<p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
  'ppt/_rels/presentation.xml.rels': rels([
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>',
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>',
  ]),
  'ppt/slides/slide1.xml': `${X}<p:sld ${P}>${tree(ph('ctrTitle', 'Deck title slide') + ph('subTitle', 'A subtitle here', '1'))}</p:sld>`,
  'ppt/slides/_rels/slide1.xml.rels': slideRel([]),
  'ppt/slides/slide2.xml': `${X}<p:sld ${P}>${tree(`${ph('title', 'Second slide title')}${ph('body', 'Body text line', '1')}
    <p:sp><p:nvSpPr><p:cNvPr id="4" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${box(914400, 4572000, 3657600, 914400)}<a:solidFill><a:srgbClr val="FFF2CC"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="2400" b="1"><a:solidFill><a:srgbClr val="0000C8"/></a:solidFill></a:rPr><a:t>Free text box</a:t></a:r></a:p></p:txBody></p:sp>
    <p:pic><p:nvPicPr><p:cNvPr id="5" name="p"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr>${box(5486400, 3657600, 914400, 914400)}</p:spPr></p:pic>`)}</p:sld>`,
  'ppt/slides/_rels/slide2.xml.rels': slideRel(['<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>']),
  'ppt/media/image1.png': PNG,
  'ppt/slideLayouts/slideLayout1.xml': `${X}<p:sldLayout ${P}>${tree(layoutPh('ctrTitle', 685800, 2130425, 7772400, 1470025) + layoutPh('title', 457200, 274638, 8229600, 1143000) + layoutPh('subTitle', 1371600, 3886200, 6400800, 1752600, '1') + layoutPh('body', 457200, 1600200, 8229600, 2000000, '1'))}</p:sldLayout>`,
  'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels(['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>']),
  'ppt/slideMasters/slideMaster1.xml': `${X}<p:sldMaster ${P}>${tree('')}</p:sldMaster>`,
});
console.log('Office fixtures written');
