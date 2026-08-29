/**
 * docx.js — a brand-locked Word document.
 *
 * The third renderer, built the same way as the other two: brand.js supplies
 * every colour, face and size, the model supplies only words, and the
 * disclosure label is drawn here rather than written by the model, so there is
 * no path to a document without one.
 *
 * It exists because a pdf is finished. A rep who needs to add a paragraph
 * before sending a threat brief to a customer cannot, and was reduced to
 * retyping the thing into Word — which is exactly how a document stops
 * following the template.
 *
 * The type scale mirrors pdf.js deliberately: a brief and its printable
 * version should read as the same document, not as two designs that happen to
 * share a palette.
 *
 * On drawn layouts: WordprocessingML has no shape layer worth using, but it
 * has tables with cell shading, which is the same primitive the deck draws
 * rects with. A bar is a shaded cell of proportional width; a chain is a row
 * of filled cells. Word will not match the deck pixel for pixel and does not
 * need to — what matters is that a stat is a number and not a bullet.
 */

import { zipSync, strToU8 } from 'fflate';

import { COLOR, INK, ON_NAVY, FONT, eyebrowCase } from '../brand.js';
import { xml } from './ooxml.js';
import { DISCLOSURE_LABELS } from './spec.js';

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** Word measures lengths in twentieths of a point; 1440 to the inch. */
const inches = (n) => Math.round(n * 1440);

/** A4, with the same ~20mm sides pdf.js uses. */
const PAGE = { w: inches(8.268), h: inches(11.693) };
const MARGIN = { top: inches(0.86), right: inches(0.78), bottom: inches(0.8), left: inches(0.78) };
const COLUMN = PAGE.w - MARGIN.left - MARGIN.right;

/**
 * The same scale as pdf.js, in half-points, which is how Word sizes runs.
 *
 * Not re-derived from the brand ratios independently: two renderers of the
 * same document drifting apart by a point is the kind of difference nobody
 * notices until the two are laid side by side in front of a customer.
 */
const SIZE = {
  coverTitle: 60,
  sectionTitle: 34,
  body: 21,
  eyebrow: 16,
  footer: 15,
  stat: 96,
  quote: 30,
};

const hx = (c) => String(c).replace('#', '').toUpperCase();

// --- Runs and paragraphs ---------------------------------------------------

/**
 * One run of text.
 *
 * `spacing` is letter-spacing in twentieths of a point, which is how the
 * eyebrow gets its tracking — the brand's one shouting element.
 */
function run(text, { font = FONT.body, size = SIZE.body, color = INK.body, spacing = 0, caps = false } = {}) {
  // rPr order: rFonts, b, caps, color, spacing, sz, szCs.
  return (
    '<w:r><w:rPr>' +
    `<w:rFonts w:ascii="${xml(font.family)}" w:hAnsi="${xml(font.family)}"/>` +
    (font.weight >= 700 ? '<w:b/>' : '') +
    (caps ? '<w:caps/>' : '') +
    `<w:color w:val="${hx(color)}"/>` +
    (spacing ? `<w:spacing w:val="${spacing}"/>` : '') +
    `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` +
    '</w:rPr>' +
    `<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`
  );
}

/**
 * A paragraph.
 *
 * `shade` fills the whole paragraph, which is how the quote block gets its
 * navy field without a shape.
 */
function para(runs, { before = 0, after = 120, line = 264, shade = null, align = null, indent = 0 } = {}) {
  // pPr order: pBdr, shd, spacing, ind, jc.
  const pr =
    '<w:pPr>' +
    (shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${hx(shade)}"/>` : '') +
    `<w:spacing w:before="${before}" w:after="${after}" w:line="${line}" w:lineRule="auto"/>` +
    (indent ? `<w:ind w:left="${indent}"/>` : '') +
    (align ? `<w:jc w:val="${align}"/>` : '') +
    '</w:pPr>';
  return `<w:p>${pr}${runs}</w:p>`;
}

/** The short green rule that opens a section in every other medium. */
function rule(color = COLOR.signalGreen) {
  return (
    '<w:p><w:pPr>' +
    `<w:pBdr><w:bottom w:val="single" w:sz="18" w:space="0" w:color="${hx(color)}"/></w:pBdr>` +
    '<w:spacing w:before="240" w:after="80" w:line="120" w:lineRule="exact"/>' +
    `<w:ind w:right="${COLUMN - inches(0.55)}"/>` +
    '</w:pPr></w:p>'
  );
}

/** A bulleted point. Word needs numbering.xml for real bullets; this is a
 *  hanging indent with a literal mark, which survives copy-paste better. */
function bullet(text) {
  return para(
    run('• ', { color: COLOR.circuitTeal, font: FONT.heading }) + run(text),
    { after: 80, indent: inches(0.18) },
  );
}

// --- Tables, which is how this medium draws --------------------------------

function cell(content, { width, span = 1, shade = null, valign = 'center' } = {}) {
  return (
    // tcPr order: tcW, shd, tcMar, vAlign.
    '<w:tc><w:tcPr>' +
    `<w:tcW w:w="${width}" w:type="dxa"/>` +
    (span > 1 ? `<w:gridSpan w:val="${span}"/>` : '') +
    (shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${hx(shade)}"/>` : '') +
    '<w:tcMar><w:top w:w="120" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/>' +
    '<w:left w:w="140" w:type="dxa"/><w:right w:w="140" w:type="dxa"/></w:tcMar>' +
    `<w:vAlign w:val="${valign}"/>` +
    '</w:tcPr>' +
    (content || '<w:p/>') +
    '</w:tc>'
  );
}

/**
 * A table.
 *
 * `grid` is required, not optional: CT_Tbl puts w:tblGrid immediately after
 * w:tblPr, and without it Word and LibreOffice both refuse to open the file —
 * python-docx parses it happily, which is how a broken document can look fine
 * from a script. Cells span grid columns with w:gridSpan, which is also how a
 * bar gets a proportional width without a nested table.
 */
function table(rows, grid, { after = 200 } = {}) {
  return (
    // tblPr order: tblW, tblBorders, tblLayout. Then tblGrid, then the rows.
    '<w:tbl><w:tblPr>' +
    `<w:tblW w:w="${COLUMN}" w:type="dxa"/>` +
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((e) => `<w:${e} w:val="none" w:sz="0" w:space="0" w:color="auto"/>`)
      .join('') +
    '</w:tblBorders>' +
    // Fixed, or Word re-computes the widths and a bar stops being proportional
    // to anything.
    '<w:tblLayout w:type="fixed"/>' +
    '</w:tblPr>' +
    `<w:tblGrid>${grid.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>` +
    rows.join('') +
    '</w:tbl>' +
    `<w:p><w:pPr><w:spacing w:after="${after}" w:line="20" w:lineRule="exact"/></w:pPr></w:p>`
  );
}

/** An even grid of `n` columns across the text column. */
const evenGrid = (n) => Array.from({ length: n }, () => Math.floor(COLUMN / n));

const row = (cells) => `<w:tr>${cells.join('')}</w:tr>`;

// --- Drawn sections --------------------------------------------------------

const DRAWN = {
  stat(section) {
    return (
      rule() +
      para(run(section.value, { font: FONT.display, size: SIZE.stat, color: COLOR.navy }), { after: 60, line: 240 }) +
      (section.caption
        ? para(run(section.caption, { font: FONT.heading, size: SIZE.sectionTitle, color: COLOR.circuitTeal }), {
            after: 160,
          })
        : '') +
      (section.body ? para(run(section.body)) : '')
    );
  },

  bars(section) {
    // Twelve columns for the track plus one for the number. The filled part of
    // a bar spans however many of the twelve its value earns, which is how it
    // gets a proportional width inside a fixed grid without nesting a table.
    // The number is printed beside it, so the rounding to twelfths can never
    // overstate anything.
    const COLS = 12;
    const unit = Math.floor((COLUMN * 0.82) / COLS);
    const valueW = COLUMN - unit * COLS;
    const grid = [...Array.from({ length: COLS }, () => unit), valueW];

    const max = Math.max(...section.bars.map((b) => Math.abs(b.value))) || 1;

    const rows = section.bars.flatMap((b, i) => {
      const filled = Math.min(COLS, Math.max(1, Math.round((COLS * Math.abs(b.value)) / max)));
      const empty = COLS - filled;

      const barCells = [
        cell('', { width: unit * filled, span: filled, shade: i === 0 ? COLOR.signalGreen : COLOR.circuitTeal }),
      ];
      if (empty > 0) barCells.push(cell('', { width: unit * empty, span: empty, shade: INK.rule }));
      barCells.push(
        cell(para(run(String(b.value), { font: FONT.display, size: 28, color: COLOR.navy }), { after: 0 }), {
          width: valueW,
        }),
      );

      return [
        row([
          cell(para(run(b.label, { size: SIZE.eyebrow, color: INK.body }), { after: 20 }), {
            width: unit * COLS,
            span: COLS,
          }),
          cell('', { width: valueW }),
        ]),
        row(barCells),
      ];
    });

    return (
      rule() +
      (section.body ? para(run(section.body, { font: FONT.heading, size: SIZE.sectionTitle, color: COLOR.navy })) : '') +
      table(rows, grid)
    );
  },

  chain(section) {
    const grid = evenGrid(section.steps.length);
    return (
      rule() +
      (section.body ? para(run(section.body, { font: FONT.heading, size: SIZE.sectionTitle, color: COLOR.navy })) : '') +
      table(
        [
          row(
            section.steps.map((step, i) =>
              cell(
                para(run(step, { font: FONT.heading, size: SIZE.body, color: ON_NAVY.strong }), { after: 0 }),
                { width: grid[i], shade: i === 0 ? COLOR.circuitTeal : COLOR.navy },
              ),
            ),
          ),
        ],
        grid,
      )
    );
  },

  timeline(section) {
    const grid = evenGrid(section.stops.length);
    const n = section.stops.length;
    return (
      rule() +
      (section.body ? para(run(section.body, { font: FONT.heading, size: SIZE.sectionTitle, color: COLOR.navy })) : '') +
      table(
        [
          // The rule itself: a row of thin shaded cells.
          row(
            section.stops.map((_, i) =>
              cell('<w:p><w:pPr><w:spacing w:after="0" w:line="60" w:lineRule="exact"/></w:pPr></w:p>', {
                width: grid[i],
                shade: i === n - 1 ? COLOR.signalGreen : COLOR.circuitTeal,
              }),
            ),
          ),
          row(
            section.stops.map((stop, i) =>
              cell(para(run(stop, { font: FONT.heading, size: SIZE.eyebrow, color: COLOR.navy }), { after: 0 }), {
                width: grid[i],
                valign: 'top',
              }),
            ),
          ),
        ],
        grid,
      )
    );
  },

  split(section) {
    const grid = evenGrid(2);
    return (
      rule() +
      (section.body ? para(run(section.body, { font: FONT.heading, size: SIZE.sectionTitle, color: COLOR.navy })) : '') +
      table(
        [
          row([
            cell(para(run(section.left, { size: SIZE.body, color: INK.muted }), { after: 0 }), {
              width: grid[0],
              shade: COLOR.white,
              valign: 'top',
            }),
            cell(para(run(section.right, { size: SIZE.body, color: ON_NAVY.strong }), { after: 0 }), {
              width: grid[1],
              shade: COLOR.navy,
              valign: 'top',
            }),
          ]),
        ],
        grid,
      )
    );
  },

  quote(section) {
    // Paragraph shading rather than a table: it is one block of text and Word
    // will keep it together across a page break more reliably this way.
    return (
      para(run(section.line, { font: FONT.display, size: SIZE.quote, color: ON_NAVY.strong }), {
        before: 240,
        after: 80,
        shade: COLOR.deepNavy,
        line: 300,
      }) +
      (section.body
        ? para(run(section.body, { size: SIZE.body, color: ON_NAVY.body }), { after: 240, shade: COLOR.deepNavy })
        : '')
    );
  },
};

/** A section that is prose, which is still the default. */
function proseSection(section) {
  let out = rule();

  if (section.eyebrow) {
    out += para(
      run(eyebrowCase(section.eyebrow), { font: FONT.eyebrow, size: SIZE.eyebrow, color: COLOR.circuitTeal, spacing: 24 }),
      { after: 60 },
    );
  }
  if (section.title) {
    out += para(run(section.title, { font: FONT.heading, size: SIZE.sectionTitle, color: COLOR.navy }), { after: 100 });
  }
  if (section.body) out += para(run(section.body));
  for (const point of section.points) out += bullet(point);

  return out;
}

// --- The document ----------------------------------------------------------

function cover(spec, meta) {
  return (
    para(run('vikat.AI', { font: FONT.heading, size: SIZE.sectionTitle, color: COLOR.navy }), { after: 300 }) +
    (spec.audience
      ? para(
          run(eyebrowCase(`Prepared for ${spec.audience}`), {
            font: FONT.eyebrow,
            size: SIZE.eyebrow,
            color: COLOR.circuitTeal,
            spacing: 24,
          }),
          { after: 100 },
        )
      : '') +
    para(run(spec.title, { font: FONT.display, size: SIZE.coverTitle, color: COLOR.navy }), { after: 120, line: 240 }) +
    (spec.subtitle ? para(run(spec.subtitle, { size: SIZE.body, color: INK.body }), { after: 240 }) : '')
  );
}

/**
 * The footer, carrying the disclosure label on every page.
 *
 * A footer part rather than a paragraph at the end, because Word repeats it on
 * every page automatically — the same guarantee the deck gets by drawing it on
 * each slide, and the reason the model cannot produce a document without one.
 */
function footerXml(spec, meta) {
  const label = eyebrowCase(DISCLOSURE_LABELS[spec.disclosure] || DISCLOSURE_LABELS.internal_only);
  return `${DECL}
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
${para(
  run(label, { font: FONT.eyebrow, size: SIZE.footer, color: INK.muted, spacing: 24 }) +
    run(' · ', { font: FONT.eyebrow, size: SIZE.footer, color: INK.rule }) +
    run(`${meta.preparedBy} · ${meta.isoDate.slice(0, 10)}`, {
      font: FONT.eyebrow,
      size: SIZE.footer,
      color: INK.muted,
      spacing: 24,
    }),
  { after: 0 },
)}
</w:ftr>`;
}

function documentXml(spec, meta) {
  const body =
    cover(spec, meta) +
    spec.sections
      .map((section) => (section.layout && DRAWN[section.layout] ? DRAWN[section.layout](section) : proseSection(section)))
      .join('');

  const sectPr =
    '<w:sectPr>' +
    '<w:footerReference w:type="default" r:id="rId1"/>' +
    `<w:pgSz w:w="${PAGE.w}" w:h="${PAGE.h}"/>` +
    `<w:pgMar w:top="${MARGIN.top}" w:right="${MARGIN.right}" w:bottom="${MARGIN.bottom}" w:left="${MARGIN.left}" ` +
    'w:header="0" w:footer="480" w:gutter="0"/>' +
    '</w:sectPr>';

  return `${DECL}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>${body}${sectPr}</w:body>
</w:document>`;
}

const CONTENT_TYPES = `${DECL}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const ROOT_RELS = `${DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const DOC_RELS = `${DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

/**
 * Document defaults.
 *
 * Word falls back to Calibri for anything a run does not name, so the default
 * is set here too — a stray unstyled paragraph in Calibri is exactly the
 * "approximately the brand" outcome the guidelines exist to prevent.
 */
const STYLES = `${DECL}
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="${FONT.body.family}" w:hAnsi="${FONT.body.family}"/>
<w:color w:val="${hx(INK.body)}"/>
<w:sz w:val="${SIZE.body}"/><w:szCs w:val="${SIZE.body}"/>
</w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>`;

const coreXml = ({ title, author, created }) => `${DECL}
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xml(title)}</dc:title>
<dc:creator>${xml(author)}</dc:creator>
<cp:lastModifiedBy>${xml(author)}</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified>
</cp:coreProperties>`;

/**
 * Render a spec as a .docx.
 *
 * @param {object} spec Output of normaliseSpec().
 * @param {{ preparedBy: string, isoDate: string }} meta
 * @returns {Uint8Array}
 */
export function renderDocx(spec, meta) {
  const files = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(ROOT_RELS),
    'word/document.xml': strToU8(documentXml(spec, meta)),
    'word/_rels/document.xml.rels': strToU8(DOC_RELS),
    'word/styles.xml': strToU8(STYLES),
    'word/footer1.xml': strToU8(footerXml(spec, meta)),
    'docProps/core.xml': strToU8(
      coreXml({ title: spec.title, author: meta.preparedBy, created: meta.isoDate }),
    ),
  };

  return zipSync(files, { level: 6 });
}
