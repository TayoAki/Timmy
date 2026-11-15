/*
 * Office files from Timmy's own docs, sheets and decks: .docx, .xlsx and .pptx
 * built in the browser, so any file can open in the Craft apps or be downloaded.
 * The output is deliberately plain (styles, tables, formulas, text boxes) and
 * valid Office Open XML.
 */
import { strToU8, zipSync } from 'fflate';
import type { Block, Deck, DocBody, Sheet, SheetColumn, WFile, WS } from '../data/ws-types';
import { cellValue, fmtCell } from '../state/ws';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NOW_ISO = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

const zip = (parts: Record<string, string>) => {
  const files: Record<string, Uint8Array> = {};
  for (const [path, text] of Object.entries(parts)) files[path] = strToU8(text);
  return zipSync(files, { level: 6 });
};

const core = (title: string) =>
  `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>Timmy</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${NOW_ISO()}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${NOW_ISO()}</dcterms:modified></cp:coreProperties>`;

const PKG_RELS = (main: string, type: string) =>
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${type}" Target="${main}"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;

const OFFICE_DOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

/* ───────────── .docx ───────────── */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const run = (text: string, bold = false) => `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const para = (text: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${run(text)}</w:p>`;

const table = (head: string[], rows: string[][]) => {
  const cell = (t: string, bold = false) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p>${run(t, bold)}</w:p></w:tc>`;
  return (
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid>${head.map(() => '<w:gridCol/>').join('')}</w:tblGrid>` +
    `<w:tr>${head.map((h) => cell(h, true)).join('')}</w:tr>` +
    rows.map((r) => `<w:tr>${head.map((_, i) => cell(r[i] ?? '')).join('')}</w:tr>`).join('') +
    '</w:tbl><w:p/>'
  );
};

const DOCX_STYLES = `${XML}<w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="60"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="25"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/><w:ind w:left="360" w:hanging="360"/></w:pPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/></w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

function blockXml(b: Block, ws: WS): string {
  switch (b.type) {
    case 'h2':
      return para(b.text, 'Heading1');
    case 'h3':
      return para(b.text, 'Heading2');
    case 'p':
      return para(b.text);
    case 'bullet':
      return para(`•  ${b.text}`, 'ListBullet');
    case 'todo':
      return para(`${b.checked ? '☑' : '☐'}  ${b.text}`, 'ListBullet');
    case 'table':
      return table(b.columns, b.rows);
    case 'linked-table': {
      const sheet = ws.sheets[b.sheet];
      if (!sheet) return para('(Linked table: the sheet is missing)');
      const cols = b.columns?.length ? sheet.columns.filter((c) => b.columns!.includes(c.key)) : sheet.columns;
      return table(
        cols.map((c) => c.name),
        sheet.rows.map((r) => cols.map((c) => String(fmtCell(cellValue(sheet, r, c), c)))),
      );
    }
    case 'file': {
      const f = ws.files[b.file];
      return para(`Linked file: ${f?.name ?? b.file}`);
    }
  }
}

export function docxFromDoc(file: WFile, body: DocBody, ws: WS): Uint8Array {
  const xml = `${XML}<w:document ${W}><w:body>${para(file.name, 'Title')}${body.blocks.map((b) => blockXml(b, ws)).join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return zip({
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    '_rels/.rels': PKG_RELS('word/document.xml', OFFICE_DOC),
    'word/_rels/document.xml.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'word/document.xml': xml,
    'word/styles.xml': DOCX_STYLES,
    'docProps/core.xml': core(file.name),
  });
}

/* ───────────── .xlsx ───────────── */

const colLetter = (i: number) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** Excel's day number for a yyyy-mm-dd date. */
const serial = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y!, m! - 1, d!) - Date.UTC(1899, 11, 30)) / 86400000);
};

/** "[Seats] * [Price] * 12" on row 3 → "B3*C3*12". */
const a1Formula = (formula: string, columns: SheetColumn[], row: number) =>
  formula.replace(/\[([^\]]+)\]/g, (_, name: string) => {
    const i = columns.findIndex((c) => c.name.toLowerCase() === name.trim().toLowerCase());
    return i >= 0 ? `${colLetter(i)}${row}` : '0';
  }).replace(/\s+/g, '');

export function xlsxFromSheet(file: WFile, sheet: Sheet): Uint8Array {
  const cols = sheet.columns;
  const style = (c: SheetColumn) => (c.type === 'currency' ? 2 : c.type === 'number' ? 3 : c.type === 'date' ? 4 : 0);
  const head = `<row r="1">${cols.map((c, i) => `<c r="${colLetter(i)}1" t="inlineStr" s="1"><is><t>${esc(c.name)}</t></is></c>`).join('')}</row>`;
  const body = sheet.rows
    .map((r, ri) => {
      const n = ri + 2;
      const cells = cols.map((c, i) => {
        const ref = `${colLetter(i)}${n}`;
        if (c.formula) {
          const v = cellValue(sheet, r, c);
          return `<c r="${ref}" s="${style(c)}"><f>${esc(a1Formula(c.formula, cols, n))}</f>${v === '' ? '' : `<v>${v}</v>`}</c>`;
        }
        const raw = r[c.key];
        if (raw === undefined || raw === '') return '';
        if (c.type === 'date' && typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return `<c r="${ref}" s="4"><v>${serial(raw)}</v></c>`;
        if (c.type !== 'text' && raw !== '' && !Number.isNaN(Number(raw))) return `<c r="${ref}" s="${style(c)}"><v>${Number(raw)}</v></c>`;
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(String(raw))}</t></is></c>`;
      });
      return `<row r="${n}">${cells.join('')}</row>`;
    })
    .join('');
  const widths = cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(12, Math.min(40, c.name.length + 6, ...sheet.rows.map((r) => String(r[c.key] ?? '').length + 4)))}" customWidth="1"/>`).join('');
  const sheetXml = `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths}</cols><sheetData>${head}${body}</sheetData></worksheet>`;
  const name = (sheet.table || 'Table').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);
  return zip({
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    '_rels/.rels': PKG_RELS('xl/workbook.xml', OFFICE_DOC),
    'xl/workbook.xml': `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    'xl/worksheets/sheet1.xml': sheetXml,
    'docProps/core.xml': core(file.name),
  });
}

/* ───────────── .pptx ───────────── */

const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const SLIDE_W = 12192000;
const SLIDE_H = 6858000;
const EMU = 914400; // per inch

const TREE_HEAD = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

interface Box {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  paras: { text: string; size: number; bold?: boolean; italic?: boolean; bullet?: boolean; color?: string; align?: 'l' | 'ctr' }[];
  anchor?: 't' | 'ctr' | 'b';
}

const textBox = (b: Box) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${b.id}" name="Text ${b.id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(b.x)}" y="${Math.round(b.y)}"/><a:ext cx="${Math.round(b.w)}" cy="${Math.round(b.h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" rIns="0" anchor="${b.anchor ?? 't'}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${b.paras
    .map(
      (p) =>
        `<a:p><a:pPr algn="${p.align ?? 'l'}"${p.bullet ? ' marL="342900" indent="-342900"' : ''}>${p.bullet ? '<a:buFont typeface="Arial"/><a:buChar char="•"/>' : '<a:buNone/>'}<a:spcAft><a:spcPts val="${p.bullet ? 900 : 600}"/></a:spcAft></a:pPr><a:r><a:rPr lang="en-US" sz="${p.size * 100}"${p.bold ? ' b="1"' : ''}${p.italic ? ' i="1"' : ''} dirty="0"><a:solidFill><a:srgbClr val="${p.color ?? '1C1B19'}"/></a:solidFill></a:rPr><a:t>${esc(p.text)}</a:t></a:r></a:p>`,
    )
    .join('')}</p:txBody></p:sp>`;

const slideXml = (boxes: Box[]) =>
  `${XML}<p:sld ${P}><p:cSld><p:spTree>${TREE_HEAD}${boxes.map(textBox).join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;

const THEME = `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Timmy"><a:themeElements><a:clrScheme name="Timmy"><a:dk1><a:srgbClr val="1C1B19"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="2B2A27"/></a:dk2><a:lt2><a:srgbClr val="F4F3EF"/></a:lt2><a:accent1><a:srgbClr val="3F51D9"/></a:accent1><a:accent2><a:srgbClr val="30A46C"/></a:accent2><a:accent3><a:srgbClr val="E9971A"/></a:accent3><a:accent4><a:srgbClr val="8E4EC6"/></a:accent4><a:accent5><a:srgbClr val="3B9EDB"/></a:accent5><a:accent6><a:srgbClr val="E5484D"/></a:accent6><a:hlink><a:srgbClr val="3343C4"/></a:hlink><a:folHlink><a:srgbClr val="8E4EC6"/></a:folHlink></a:clrScheme><a:fontScheme name="Timmy"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Timmy"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

const REL = (items: [string, string, string][]) =>
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join('')}</Relationships>`;

export function pptxFromDeck(file: WFile, deck: Deck): Uint8Array {
  const margin = 0.7 * EMU;
  const slides = deck.slides.map((s) => {
    const bullets = s.bullets ?? [];
    if (s.layout === 'title') {
      return slideXml([
        { id: 2, x: margin, y: SLIDE_H * 0.32, w: SLIDE_W - margin * 2, h: 1.4 * EMU, anchor: 'b', paras: [{ text: s.title, size: 44, bold: true }] },
        { id: 3, x: margin, y: SLIDE_H * 0.32 + 1.55 * EMU, w: SLIDE_W - margin * 2, h: 1.2 * EMU, paras: (bullets.length ? bullets : [file.name]).map((t) => ({ text: t, size: 20, color: '64605A' })) },
      ]);
    }
    if (s.layout === 'quote') {
      return slideXml([
        { id: 2, x: margin * 1.6, y: SLIDE_H * 0.22, w: SLIDE_W - margin * 3.2, h: SLIDE_H * 0.4, anchor: 'ctr', paras: [{ text: `“${bullets[0] ?? s.title}”`, size: 34, italic: true, align: 'ctr' }] },
        { id: 3, x: margin * 1.6, y: SLIDE_H * 0.66, w: SLIDE_W - margin * 3.2, h: 0.8 * EMU, paras: [{ text: bullets[1] ?? s.title, size: 18, color: '64605A', align: 'ctr' }] },
      ]);
    }
    return slideXml([
      { id: 2, x: margin, y: 0.5 * EMU, w: SLIDE_W - margin * 2, h: 1.0 * EMU, anchor: 'b', paras: [{ text: s.title, size: 32, bold: true }] },
      { id: 3, x: margin, y: 1.75 * EMU, w: SLIDE_W - margin * 2, h: SLIDE_H - 2.4 * EMU, paras: bullets.map((t) => ({ text: t, size: 22, bullet: true })) },
    ]);
  });

  const parts: Record<string, string> = {
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    '_rels/.rels': PKG_RELS('ppt/presentation.xml', OFFICE_DOC),
    'ppt/presentation.xml': `${XML}<p:presentation ${P} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${10 + i}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:defaultTextStyle></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': REL([
      ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
      ['rId2', 'theme', 'theme/theme1.xml'],
      ['rId3', 'presProps', 'presProps.xml'],
      ['rId4', 'viewProps', 'viewProps.xml'],
      ['rId5', 'tableStyles', 'tableStyles.xml'],
      ...slides.map((_, i): [string, string, string] => [`rId${10 + i}`, 'slide', `slides/slide${i + 1}.xml`]),
    ]),
    'ppt/presProps.xml': `${XML}<p:presentationPr ${P}/>`,
    'ppt/viewProps.xml': `${XML}<p:viewPr ${P}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`,
    'ppt/tableStyles.xml': `${XML}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
    'ppt/slideMasters/slideMaster1.xml': `${XML}<p:sldMaster ${P}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${TREE_HEAD}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2000"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': REL([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'theme', '../theme/theme1.xml'],
    ]),
    'ppt/slideLayouts/slideLayout1.xml': `${XML}<p:sldLayout ${P} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${TREE_HEAD}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': REL([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    'ppt/theme/theme1.xml': THEME,
    'docProps/core.xml': core(file.name),
  };
  slides.forEach((xml, i) => {
    parts[`ppt/slides/slide${i + 1}.xml`] = xml;
    parts[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = REL([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]);
  });
  return zip(parts);
}

/* ───────────── Which format a file becomes ───────────── */

export const officeExt = (kind: WFile['kind']) => (kind === 'doc' ? 'docx' : kind === 'sheet' ? 'xlsx' : kind === 'slides' ? 'pptx' : kind === 'pdf' ? 'pdf' : '');

/** A file name with the right extension for a download or a viewer. */
export const withExt = (name: string, ext: string) => (ext && !name.toLowerCase().endsWith(`.${ext}`) ? `${name}.${ext}` : name);

/** Builds the office file for a Timmy doc, sheet or deck; undefined when it has no body. */
export function exportNative(file: WFile, ws: WS): Uint8Array | undefined {
  if (file.kind === 'doc' && ws.docs[file.id]) return docxFromDoc(file, ws.docs[file.id]!, ws);
  if (file.kind === 'sheet' && ws.sheets[file.id]) return xlsxFromSheet(file, ws.sheets[file.id]!);
  if (file.kind === 'slides' && ws.decks[file.id]) return pptxFromDeck(file, ws.decks[file.id]!);
  return undefined;
}
