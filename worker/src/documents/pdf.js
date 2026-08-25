/**
 * pdf.js — render a document spec as a branded A4 PDF.
 *
 * The same spec that becomes a deck becomes a document here. A deck gives one
 * section a slide; this gives it a block, and flows onto a new page when the
 * block will not fit.
 *
 * The typefaces are embedded and subsetted into the file, so the document
 * looks the same on a customer's machine as on the rep's. That is the whole
 * reason this renders a PDF rather than handing over a Word file.
 */

import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

import { COLOR, INK, ON_NAVY, GRADIENT, WORDMARK, TAGLINE, copyrightLine, eyebrowCase } from '../brand.js';
import { DISCLOSURE_LABELS } from './spec.js';
import { wrap } from './measure.js';

/** A4 in points. */
const PAGE = { width: 595.28, height: 841.89 };

/** ~20mm sides, a little more at the head. Space is part of the type system. */
const M = { left: 56, right: 56, top: 62, bottom: 58 };
const COLUMN = PAGE.width - M.left - M.right;

/**
 * The document type scale, in points.
 *
 * Derived from a 10.5pt base body, which is what A4 body copy wants. The
 * brand's own pixel figures describe a full-bleed web hero and do not
 * transfer to print, but the hierarchy they set does.
 */
const SIZE = {
  coverTitle: 30,
  sectionTitle: 17,
  body: 10.5,
  point: 10.5,
  eyebrow: 8,
  footer: 7.5,
  wordmark: 15,
  tagline: 13,
};

const LEADING = { title: 1.1, section: 1.2, body: 1.55, point: 1.5 };

/** pdf-lib takes colours as 0..1 triples. */
function color(hex) {
  const h = String(hex).replace('#', '');
  return rgb(
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  );
}

function mix(a, b, t) {
  const parse = (h) => [0, 2, 4].map((i) => parseInt(String(h).replace('#', '').slice(i, i + 2), 16));
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  return rgb((ar + (br - ar) * t) / 255, (ag + (bg - ag) * t) / 255, (ab + (bb - ab) * t) / 255);
}

/**
 * The brand gradient as a band of interpolated strips.
 *
 * PDF has native shading dictionaries; pdf-lib does not expose them, and
 * reaching under it to write raw shading operators would be more code than
 * this is worth. At 1pt strips across 595pt the banding is not resolvable in
 * print or on screen.
 *
 * Covers and dividers only, per the brand rule — which is why this is a
 * private helper rather than something a caller can place anywhere.
 */
function gradientBand(page, y, height) {
  const strips = Math.ceil(PAGE.width);
  const stops = GRADIENT.stops;

  for (let i = 0; i < strips; i += 1) {
    const t = i / (strips - 1);
    const scaled = t * (stops.length - 1);
    const index = Math.min(Math.floor(scaled), stops.length - 2);

    page.drawRectangle({
      x: i,
      y,
      // Overlap by a hair so no seam shows at any zoom level.
      width: PAGE.width / strips + 0.6,
      height,
      color: mix(stops[index], stops[index + 1], scaled - index),
    });
  }
}

/**
 * A layout cursor over a growing set of pages.
 *
 * Flowing content needs somewhere to ask "will this fit, and if not give me a
 * new page", and needs every page to end up with the same footer. Doing that
 * inline in each section is how a document ends up with one page missing its
 * disclosure line.
 */
class Flow {
  constructor(doc, fonts, spec, meta) {
    this.doc = doc;
    this.fonts = fonts;
    this.spec = spec;
    this.meta = meta;
    this.pages = [];
    this.page = null;
    this.y = 0;
  }

  newPage() {
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.pages.push(this.page);
    this.y = PAGE.height - M.top;
    return this.page;
  }

  /** Room left above the footer. */
  get remaining() {
    return this.y - (M.bottom + 22);
  }

  /** Start a new page if `height` will not fit on this one. */
  reserve(height) {
    if (!this.page || height > this.remaining) this.newPage();
  }

  /**
   * Draw wrapped text and advance the cursor.
   *
   * @returns {number} the height consumed.
   */
  write(text, { font, metrics, size, leading, fill, width = COLUMN, indent = 0, tracking = 0 }) {
    const lines = wrap(text, metrics, size, width - indent, tracking);
    const step = size * leading;

    for (const line of lines) {
      this.y -= step;
      this.page.drawText(line, {
        x: M.left + indent,
        y: this.y + size * 0.24,
        size,
        font,
        color: fill,
        ...(tracking ? { characterSpacing: tracking * size } : {}),
      });
    }

    return lines.length * step;
  }

  /** How tall `text` would be, without drawing it. */
  measure(text, { metrics, size, leading, width = COLUMN, indent = 0, tracking = 0 }) {
    return wrap(text, metrics, size, width - indent, tracking).length * size * leading;
  }

  gap(points) {
    this.y -= points;
  }
}

/** The standing footer, applied to every page once the flow is complete. */
function drawFooters(flow) {
  const { spec, fonts, meta } = flow;
  const label = eyebrowCase(DISCLOSURE_LABELS[spec.disclosure]);
  const total = flow.pages.length;

  flow.pages.forEach((page, i) => {
    // A hairline rather than a rule: the footer separates, it does not divide.
    page.drawRectangle({
      x: M.left,
      y: M.bottom + 18,
      width: COLUMN,
      height: 0.5,
      color: color(INK.rule),
    });

    page.drawText(label, {
      x: M.left,
      y: M.bottom + 6,
      size: SIZE.footer,
      font: fonts.eyebrow,
      color: color(INK.muted),
      characterSpacing: 0.12 * SIZE.footer,
    });

    const marker = `${i + 1} / ${total}`;
    const width = fonts.metrics.eyebrow.widthOf(marker, SIZE.footer, 0.12);

    page.drawText(marker, {
      x: PAGE.width - M.right - width,
      y: M.bottom + 6,
      size: SIZE.footer,
      font: fonts.eyebrow,
      color: color(INK.muted),
      characterSpacing: 0.12 * SIZE.footer,
    });

    // The closing block carries the copyright on the last page; every other
    // page states it here so a single sheet never circulates without it.
    if (i === total - 1) return;
    page.drawText(copyrightLine(meta.year), {
      x: M.left,
      y: M.bottom - 5,
      size: SIZE.footer,
      font: fonts.body,
      color: color(INK.muted),
    });
  });
}

function drawCover(flow) {
  const { spec, fonts, meta } = flow;
  const page = flow.newPage();

  gradientBand(page, PAGE.height - 8, 8);

  page.drawText(WORDMARK, {
    x: M.left,
    y: PAGE.height - M.top - 6,
    size: SIZE.wordmark,
    font: fonts.display,
    color: color(COLOR.navy),
    characterSpacing: -0.03 * SIZE.wordmark,
  });

  flow.y = PAGE.height - M.top - 76;

  flow.write(eyebrowCase(spec.audience ? `Prepared for ${spec.audience}` : meta.date), {
    font: fonts.eyebrow,
    metrics: fonts.metrics.eyebrow,
    size: SIZE.eyebrow,
    leading: 1.4,
    fill: color(COLOR.circuitTeal),
    tracking: 0.12,
  });

  flow.gap(18);

  flow.write(spec.title, {
    font: fonts.display,
    metrics: fonts.metrics.display,
    size: SIZE.coverTitle,
    leading: LEADING.title,
    fill: color(COLOR.navy),
    width: COLUMN * 0.9,
    tracking: -0.03,
  });

  if (spec.subtitle) {
    flow.gap(16);
    flow.write(spec.subtitle, {
      font: fonts.body,
      metrics: fonts.metrics.body,
      size: SIZE.body + 1.5,
      leading: LEADING.body,
      fill: color(INK.body),
      width: COLUMN * 0.85,
    });
  }

  // The green rule that opens the body of the document.
  flow.gap(26);
  page.drawRectangle({ x: M.left, y: flow.y, width: 44, height: 2, color: color(COLOR.signalGreen) });
  flow.gap(30);
}

function drawSection(flow, section) {
  const { fonts } = flow;

  // Keep a heading with at least the first lines of what follows: a section
  // title alone at the foot of a page is the classic flowed-layout failure.
  const headingHeight =
    (section.eyebrow ? SIZE.eyebrow * 1.4 + 8 : 0) +
    (section.title
      ? flow.measure(section.title, {
          metrics: fonts.metrics.heading,
          size: SIZE.sectionTitle,
          leading: LEADING.section,
          width: COLUMN * 0.92,
        }) + 10
      : 0);

  flow.reserve(headingHeight + SIZE.body * LEADING.body * 2);

  if (section.eyebrow) {
    flow.write(eyebrowCase(section.eyebrow), {
      font: fonts.eyebrow,
      metrics: fonts.metrics.eyebrow,
      size: SIZE.eyebrow,
      leading: 1.4,
      fill: color(COLOR.circuitTeal),
      tracking: 0.12,
    });
    flow.gap(8);
  }

  if (section.title) {
    flow.write(section.title, {
      font: fonts.heading,
      metrics: fonts.metrics.heading,
      size: SIZE.sectionTitle,
      leading: LEADING.section,
      fill: color(COLOR.navy),
      width: COLUMN * 0.92,
      tracking: -0.01,
    });
    flow.gap(10);
  }

  if (section.body) {
    // Widow control is per-paragraph rather than per-line: if the whole
    // paragraph will not fit, start it on the next page instead of leaving
    // one line behind.
    const height = flow.measure(section.body, {
      metrics: fonts.metrics.body,
      size: SIZE.body,
      leading: LEADING.body,
    });
    if (height > flow.remaining) flow.newPage();

    flow.write(section.body, {
      font: fonts.body,
      metrics: fonts.metrics.body,
      size: SIZE.body,
      leading: LEADING.body,
      fill: color(INK.body),
    });
    flow.gap(12);
  }

  for (const point of section.points) {
    const height = flow.measure(point, {
      metrics: fonts.metrics.body,
      size: SIZE.point,
      leading: LEADING.point,
      indent: 16,
    });
    if (height > flow.remaining) flow.newPage();

    // The marker sits on the first line's baseline, so it is drawn against
    // the cursor before write() moves it.
    flow.page.drawRectangle({
      x: M.left + 2,
      y: flow.y - SIZE.point * LEADING.point + SIZE.point * 0.55,
      width: 3.5,
      height: 3.5,
      color: color(COLOR.circuitTeal),
    });

    flow.write(point, {
      font: fonts.body,
      metrics: fonts.metrics.body,
      size: SIZE.point,
      leading: LEADING.point,
      fill: color(INK.strong),
      indent: 16,
    });
    flow.gap(5);
  }

  flow.gap(20);
}

function drawClose(flow) {
  const { fonts, meta } = flow;

  const block = 118;
  if (block + 24 > flow.remaining) flow.newPage();

  const top = flow.y - 16;

  flow.page.drawRectangle({
    x: M.left,
    y: top - block,
    width: COLUMN,
    height: block,
    color: color(COLOR.deepNavy),
  });

  flow.page.drawText(TAGLINE, {
    x: M.left + 26,
    y: top - 44,
    size: SIZE.tagline,
    font: fonts.display,
    color: color(ON_NAVY.strong),
    characterSpacing: -0.03 * SIZE.tagline,
  });

  flow.page.drawText(`Prepared by ${meta.preparedBy} · ${meta.date}`, {
    x: M.left + 26,
    y: top - 70,
    size: SIZE.body,
    font: fonts.body,
    color: color(ON_NAVY.body),
  });

  flow.page.drawText(copyrightLine(meta.year), {
    x: M.left + 26,
    y: top - 90,
    size: SIZE.footer,
    font: fonts.body,
    color: color(ON_NAVY.muted),
  });

  flow.y = top - block - 20;
}

/**
 * Render a spec as a PDF.
 *
 * @param {object} spec  A spec already through normaliseSpec().
 * @param {{ preparedBy: string, isoDate: string }} meta
 * @param {{ bytes: object, metrics: object }} fontSet  From fonts.js, or read
 *        off disk in tests. Bytes are embedded; metrics drive the layout.
 * @returns {Promise<Uint8Array>}
 */
export async function renderPdf(spec, meta, fontSet) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);

  const date = meta.isoDate.slice(0, 10);

  doc.setTitle(spec.title);
  doc.setAuthor(meta.preparedBy);
  doc.setProducer('Vikat.AI Sales Assistant');
  doc.setCreator('Vikat.AI Sales Assistant');
  doc.setSubject(DISCLOSURE_LABELS[spec.disclosure]);

  // Subsetting keeps a four-typeface document to a few tens of kilobytes
  // instead of a megabyte and a half.
  const embed = (bytes) => doc.embedFont(bytes, { subset: true });
  const fonts = {
    display: await embed(fontSet.bytes.display),
    heading: await embed(fontSet.bytes.heading),
    body: await embed(fontSet.bytes.body),
    eyebrow: await embed(fontSet.bytes.eyebrow),
    metrics: fontSet.metrics,
  };

  const flow = new Flow(doc, fonts, spec, {
    date,
    year: Number(date.slice(0, 4)),
    preparedBy: meta.preparedBy,
  });

  drawCover(flow);
  for (const section of spec.sections) drawSection(flow, section);
  drawClose(flow);
  drawFooters(flow);

  return doc.save();
}
