/**
 * components.js — §4.3, the parts a slide is assembled from.
 *
 * "Reuse, do not invent" is the section heading, and it is the reason this
 * file exists rather than each layout drawing its own rectangles. A stat tile
 * built twice is a stat tile that looks different on two slides of the same
 * deck, and nobody notices until both are on screen.
 *
 * Every measurement is from §4.3 or §4.1. Where the instructions give a range
 * — a big number "23 to 27pt", a table row "0.58 to 0.76 high" — the middle is
 * taken and the range is kept in the comment, so the next person can see the
 * value was chosen inside a rule rather than picked.
 *
 * The card treatment is the one thing that applies everywhere: corner radius
 * about 0.09, a hairline border, and a soft navy shadow on light themes only.
 * Never on dark. That last clause is a rule, not a preference — a shadow on
 * 01163A is a smudge.
 */

import { CREAM, DARK, SUITE, GEOMETRY, FLOORS } from './house.js';

const EMU = 914400;
const emu = (inches) => Math.round(inches * EMU);
const pt = (points) => Math.round(points * 100);
const hex = (c) => String(c).replace('#', '').toUpperCase();

let id = 5000;
const nextId = () => (id += 1);

const frame = ({ x, y, w, h }) =>
  `<a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/>`;

const solid = (color) => `<a:solidFill><a:srgbClr val="${hex(color)}"/></a:solidFill>`;

/** A hairline, in the weight §4.3 gives for an emphasised card or a plain one. */
const line = (color, widthPt = 1) =>
  `<a:ln w="${pt(widthPt) * 127}"><a:solidFill><a:srgbClr val="${hex(color)}"/></a:solidFill></a:ln>`;

/**
 * §4.3: soft navy shadow, opacity 0.12, blur 7, offset 2.
 *
 * Blur and offset are given in points; OOXML wants EMU, and the alpha is in
 * hundredths of a percent.
 */
const SHADOW =
  '<a:effectLst><a:outerShdw blurRad="88900" dist="25400" dir="5400000" rotWithShape="0">' +
  '<a:srgbClr val="022258"><a:alpha val="12000"/></a:srgbClr></a:outerShdw></a:effectLst>';

/**
 * The card, which almost everything below is made of.
 *
 * @param {{x,y,w,h}} box
 * @param {object} [options]
 * @param {string} [options.fill]     Defaults to the cream theme's white card.
 * @param {string} [options.border]   Hairline colour. Null for none.
 * @param {number} [options.borderPt] 1.75 for the emphasised step of a flow.
 * @param {boolean} [options.dark]    Suppresses the shadow. Never on dark.
 */
export function card(box, { fill = CREAM.card, border = CREAM.hairline, borderPt = 1, dark = false } = {}) {
  const n = nextId();
  // §4.3: corner radius about 0.09in. prstGeom takes the adjustment as a
  // fraction of half the shorter side, in thousandths.
  const shorter = Math.min(box.w, box.h);
  const adj = Math.max(0, Math.min(50000, Math.round((0.09 / (shorter / 2)) * 50000)));

  return `<p:sp><p:nvSpPr><p:cNvPr id="${n}" name="card${n}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm>${frame(box)}</a:xfrm><a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${adj}"/></a:avLst></a:prstGeom>${solid(fill)}${border ? line(border, borderPt) : '<a:ln><a:noFill/></a:ln>'}</p:spPr>
${dark ? '' : SHADOW}
<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`;
}

/**
 * Text, in the two typefaces §4.2 allows.
 *
 * `mono` is JetBrains Mono, ALL CAPS and tracked — eyebrows, column headers,
 * metric codes, tags and fine labels. Never a sentence, which is why the
 * caller asks for it by name rather than by size.
 */
export function label(box, string, {
  size = FLOORS.body,
  color = CREAM.ink,
  bold = false,
  mono = false,
  tracking = 0,
  align = 'l',
  anchor = 't',
  lineHeight = 1.3,
} = {}) {
  const n = nextId();
  const face = mono ? 'JetBrains Mono' : 'Inter';
  const body = mono ? String(string).toUpperCase() : String(string);

  const runs = String(body)
    .split('\n')
    .map(
      (lineText) =>
        `<a:p><a:pPr algn="${align === 'r' ? 'r' : align === 'c' ? 'ctr' : 'l'}">` +
        `<a:lnSpc><a:spcPct val="${Math.round(lineHeight * 100000)}"/></a:lnSpc></a:pPr>` +
        `<a:r><a:rPr lang="en-GB" sz="${pt(size)}" b="${bold || mono ? 1 : 0}" dirty="0"` +
        `${tracking ? ` spc="${Math.round(tracking * 100)}"` : ''}>` +
        `${solid(color)}<a:latin typeface="${face}"/><a:cs typeface="${face}"/></a:rPr>` +
        `<a:t>${escapeXml(lineText)}</a:t></a:r></a:p>`,
    )
    .join('');

  return `<p:sp><p:nvSpPr><p:cNvPr id="${n}" name="t${n}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm>${frame(box)}</a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>
<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}"><a:noAutofit/></a:bodyPr><a:lstStyle/>${runs}</p:txBody></p:sp>`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// --- The named components -------------------------------------------------

/**
 * Stat tile (§4.3): white card, big number top left, label in slate beneath.
 *
 * Number 23 to 27pt bold ink; label 8.5 to 9.5pt. The middles are taken.
 */
export function statTile(box, { value, caption }) {
  return [
    card(box),
    label({ x: box.x + 0.22, y: box.y + 0.2, w: box.w - 0.44, h: 0.5 }, value, {
      size: 25,
      bold: true,
      color: CREAM.ink,
      lineHeight: 1.05,
    }),
    label({ x: box.x + 0.22, y: box.y + 0.78, w: box.w - 0.44, h: box.h - 0.98 }, caption, {
      size: 9,
      color: CREAM.body,
      lineHeight: 1.35,
    }),
  ].join('');
}

/**
 * Table row (§4.3): a full-width white card, three columns.
 *
 * Height 0.58 to 0.76; 0.66 taken. The mono column headers sit above the first
 * row rather than inside it, which is what makes it a table rather than four
 * cards that happen to line up.
 */
export const TABLE_ROW_HEIGHT = 0.66;

export function tableHeader(x, y, width, columns, accent = CREAM.tealInk) {
  const colW = width / columns.length;
  return columns
    .map((c, i) =>
      label({ x: x + i * colW + (i === 0 ? 0.22 : 0.14), y, w: colW - 0.3, h: 0.24 }, c, {
        size: FLOORS.label,
        mono: true,
        tracking: 1.5,
        color: accent,
      }),
    )
    .join('');
}

export function tableRow(x, y, width, cells) {
  const colW = width / cells.length;
  return [
    card({ x, y, w: width, h: TABLE_ROW_HEIGHT }),
    ...cells.map((cell, i) =>
      label(
        { x: x + i * colW + (i === 0 ? 0.22 : 0.14), y: y + 0.16, w: colW - 0.3, h: TABLE_ROW_HEIGHT - 0.3 },
        cell,
        { size: 9.5, color: i === 0 ? CREAM.ink : CREAM.body, bold: i === 0, lineHeight: 1.25 },
      ),
    ),
  ].join('');
}

/**
 * Metric code pill (§4.3): 0.98 x 0.34, suite accent, white mono 10.5pt,
 * centred. The published metric codes — MTTK, MTTD, MTTP — travel in these.
 */
export function metricPill(x, y, code, accent = SUITE.sec.light) {
  return [
    card({ x, y, w: 0.98, h: 0.34 }, { fill: accent, border: null }),
    label({ x, y: y + 0.085, w: 0.98, h: 0.24 }, code, {
      size: 10.5,
      mono: true,
      color: '#FFFFFF',
      align: 'c',
      tracking: 1,
    }),
  ].join('');
}

/**
 * Outcome band (§4.3): full-width tint card, mono green label then bold deep
 * text. At most one filled accent band per slide (§4.4) — it is the focal
 * point, so a layout that wants two wants two slides.
 */
export function outcomeBand(x, y, width, { tag, sentence }) {
  const h = 0.72;
  return [
    card({ x, y, w: width, h }, { fill: CREAM.tintBand, border: CREAM.tintBorder }),
    label({ x: x + 0.24, y: y + 0.26, w: 1.6, h: 0.24 }, tag, {
      size: FLOORS.label + 0.5,
      mono: true,
      tracking: 1.5,
      color: CREAM.greenInk,
    }),
    label({ x: x + 1.95, y: y + 0.22, w: width - 2.2, h: h - 0.36 }, sentence, {
      size: 11,
      bold: true,
      color: CREAM.deep,
      lineHeight: 1.25,
    }),
  ].join('');
}

/**
 * Paradigm strip (§4.3): muted cell, accent arrow, accented tint cell.
 *
 * For from/to contrasts, which is the shape of most of what this deck argues:
 * ranked by severity, then ranked by consequence.
 */
export function paradigmStrip(x, y, width, { from, to }, accent = SUITE.sec.light) {
  const arrow = 0.5;
  const cellW = (width - arrow) / 2;

  return [
    card({ x, y, w: cellW, h: 0.86 }, { fill: '#FFFFFF', border: CREAM.hairline }),
    label({ x: x + 0.22, y: y + 0.24, w: cellW - 0.44, h: 0.5 }, from, {
      size: 11,
      color: CREAM.dim,
      lineHeight: 1.25,
    }),
    arrowRight(x + cellW + 0.13, y + 0.34, accent),
    card({ x: x + cellW + arrow, y, w: cellW, h: 0.86 }, { fill: CREAM.tintBand, border: CREAM.tintBorder }),
    label({ x: x + cellW + arrow + 0.22, y: y + 0.24, w: cellW - 0.44, h: 0.5 }, to, {
      size: 11,
      bold: true,
      color: CREAM.ink,
      lineHeight: 1.25,
    }),
  ].join('');
}

/** The small accent arrow a flow and a paradigm strip are joined by. */
export function arrowRight(x, y, color) {
  const n = nextId();
  return `<p:sp><p:nvSpPr><p:cNvPr id="${n}" name="a${n}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm>${frame({ x, y, w: 0.24, h: 0.18 })}</a:xfrm><a:prstGeom prst="rightArrow"><a:avLst/></a:prstGeom>${solid(color)}<a:ln><a:noFill/></a:ln></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`;
}

/**
 * Flow diagram (§4.3): white cards joined by accent arrows, and the
 * emphasised step gets a 1.75pt accent border rather than a different fill.
 * Colour would make it a different KIND of thing; a heavier border makes it
 * the same thing, emphasised.
 */
export function flow(x, y, width, steps, { emphasis = -1, accent = SUITE.sec.light } = {}) {
  const arrow = 0.42;
  const cardW = (width - arrow * (steps.length - 1)) / steps.length;
  const h = 0.92;

  return steps
    .map((step, i) => {
      const cx = x + i * (cardW + arrow);
      const emphasised = i === emphasis;
      return (
        card({ x: cx, y, w: cardW, h }, {
          border: emphasised ? accent : CREAM.hairline,
          borderPt: emphasised ? 1.75 : 1,
        }) +
        label({ x: cx + 0.16, y: y + 0.3, w: cardW - 0.32, h: h - 0.4 }, step, {
          size: 11,
          bold: true,
          color: CREAM.ink,
          align: 'c',
          lineHeight: 1.2,
        }) +
        (i < steps.length - 1 ? arrowRight(cx + cardW + 0.09, y + h / 2 - 0.09, accent) : '')
      );
    })
    .join('');
}

/**
 * Dark KPI card (§4.3): 032B66 fill, cream metric name 12.5pt bold, light body
 * line beneath. No shadow — §4.3 is explicit that shadows are light themes only.
 */
export function darkKpiCard(box, { metric, body }) {
  return [
    card(box, { fill: DARK.innerCard, border: DARK.hairline, dark: true }),
    label({ x: box.x + 0.24, y: box.y + 0.22, w: box.w - 0.48, h: 0.3 }, metric, {
      size: 12.5,
      bold: true,
      color: DARK.text,
      lineHeight: 1.15,
    }),
    label({ x: box.x + 0.24, y: box.y + 0.62, w: box.w - 0.48, h: box.h - 0.84 }, body, {
      size: 9.5,
      color: DARK.body,
      lineHeight: 1.35,
    }),
  ].join('');
}

/** The margin every component is laid out inside. */
export const CONTENT_X = GEOMETRY.marginX;
