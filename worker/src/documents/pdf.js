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
import { DISCLOSURE_LABELS, pageStamp } from './spec.js';
import { CREAM } from './house.js';
import { drawFigure, figureSpace } from './pdfFigures.js';
import { lockupBytes, LOCKUP_ASPECT } from './marks.js';
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

/** The gradient rule that opens a section. */
const RULE = { width: 58, height: 2.5, gap: 10 };

/** The card a point sits on: inner padding, and where its text starts. */
const CARD = { pad: 8, text: 14 };

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
function gradientBand(page, y, height, { x = 0, width = PAGE.width } = {}) {
  const strips = Math.ceil(width);
  const stops = GRADIENT.stops;

  for (let i = 0; i < strips; i += 1) {
    const t = i / (strips - 1);
    const scaled = t * (stops.length - 1);
    const index = Math.min(Math.floor(scaled), stops.length - 2);

    page.drawRectangle({
      x: x + i,
      y,
      // Overlap by a hair so no seam shows at any zoom level.
      width: width / strips + 0.6,
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

    // The house ground, not white.
    //
    // "There's no color highlights in the document — the entire document feels
    // monotonous." A cream sheet is the single change that does most of the
    // work, and it is not decoration: §3.3 makes cream the default ground for
    // every content slide, and this renderer had simply never been told. It is
    // also what makes the rest of the palette legible as structure — a white
    // card only reads as a card when the page behind it is not also white.
    this.page.drawRectangle({
      x: 0,
      y: 0,
      width: PAGE.width,
      height: PAGE.height,
      color: color(COLOR.cream),
    });

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

  /**
   * The lines `text` breaks into, for a figure laying out its own cells.
   *
   * Exposed rather than re-implemented in pdfFigures.js: a figure that wrapped
   * text by its own rules would disagree with the paragraph beside it about
   * where a word breaks, and the two would drift apart the first time the type
   * scale moved.
   */
  wrapText(text, { metrics, size, width = COLUMN, tracking = 0 }) {
    return wrap(text, metrics, size, width, tracking);
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
  const label = eyebrowCase(pageStamp(spec.disclosure));
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

/**
 * Exported for tests, for the same reason drawSection is: the type is
 * subsetted into the file, so the words on the cover cannot be found by
 * reading the rendered bytes. A test has to watch the draw calls.
 */
export function drawCover(flow) {
  const { spec, fonts, meta } = flow;
  const page = flow.newPage();

  gradientBand(page, PAGE.height - 8, 8);

  // The ARTWORK, not the letterforms.
  //
  // This drew the wordmark as text in Inter Black, which is the exact thing
  // src/brandassets/README.md was written to stop: "The logotype 'vikat.AI' is
  // a designed lockup, never retype it in body text" (TM3 §07), and "a good
  // imitation of a mark is worse than an obvious one, because it survives
  // being forwarded." The deck renderer was given the real lockup and the PDF
  // was left typesetting its own, so every brief that went to a customer
  // carried a redrawn mark.
  //
  // flow.mark is embedded once per document in renderPdf: pdf-lib embeds by
  // document, not by page, and embedding per cover would add the same image
  // to the file twice.
  if (flow.mark) {
    // Sized and seated against the text it replaced. Two corrections from
    // looking at the first render: 96pt wide made the mark twice the presence
    // it has on a slide, on a page a third the width; and drawImage takes y as
    // the BOTTOM edge where drawText took it as a baseline, so the artwork sat
    // high and drifted toward the gradient band.
    //
    // 78pt puts the lockup at roughly the optical weight of the 15pt wordmark
    // it replaces, and the top edge is pinned where the old cap-height sat.
    const w = 78;
    const h = w / LOCKUP_ASPECT;
    page.drawImage(flow.mark, {
      x: M.left,
      y: PAGE.height - M.top + 4 - h,
      width: w,
      height: h,
    });
  }

  flow.y = PAGE.height - M.top - 76;

  // The audience and the date, and NOT "Prepared for <them>".
  //
  // A customer reading their own name after the words "prepared for" is being
  // told they are a recipient of something produced about them, which is the
  // register of an internal memo that escaped. The name and the date on their
  // own read as a masthead: this document, for you, on this date.
  flow.write(eyebrowCase(spec.audience ? `${spec.audience} · ${meta.date}` : meta.date), {
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

  // No rule here any more. Every section now opens with a gradient one of its
  // own, and the first of those lands about forty points below this — two
  // short rules stacked, which reads as a mistake rather than as a device.
  flow.gap(34);
}

/**
 * Exported for tests.
 *
 * The suppression below — a drawn figure replacing its own points — is
 * invisible from outside: both versions render a valid PDF of the same page
 * count, which is why the first pass at these tests let the mutation through.
 * A test needs to see the calls.
 */
export function drawSection(flow, section) {
  const { fonts } = flow;

  // Keep a heading with at least the first lines of what follows: a section
  // title alone at the foot of a page is the classic flowed-layout failure.
  // The 8 is the gap AFTER the eyebrow, which the drawing spends and this used
  // to leave out.
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

  // The figure counts as what follows the heading.
  //
  // Without it, reserve() kept the heading with "two lines of body" — and a
  // section whose body IS a figure left its heading alone at the foot of the
  // page while the chart started the next one. That is the exact flowed-layout
  // failure the reserve above exists to prevent, reintroduced by teaching the
  // renderer a new kind of content and not telling this line about it.
  const figureHeight = section.layout ? figureSpace(section, flow, { fonts, column: COLUMN }) : 0;

  // Reserve EXACTLY what is about to be spent.
  //
  // This counted one RULE.gap and the drawing below spends two, one either
  // side of the rule, and it left out the 8 points after the eyebrow. Eighteen
  // points of disagreement between the reservation and the drawing — and
  // drawFigure carries its own page break for a figure that does not fit, so
  // the two accountings landed on opposite sides of the page edge: the heading
  // stayed, the figure moved, and "The agentic threat" sat alone at the foot
  // of page one with 250 points of cream under it.
  //
  // Both numbers come from the same constants now. A block reserved by one
  // arithmetic and drawn by another is a page break waiting for the paragraph
  // that lands on the boundary.
  const openerHeight = RULE.gap + RULE.height + RULE.gap;
  flow.reserve(openerHeight + headingHeight + (figureHeight || SIZE.body * LEADING.body * 2));

  // A gradient rule opening every section.
  //
  // The brand puts the gradient on "covers and dividers only", which is why
  // gradientBand is a private helper here — and a section opener is a divider.
  // It was being used once, on the cover, and the rest of the document was
  // navy type on white with a teal eyebrow: three colours, one of them at 8pt.
  //
  // Short rather than full bleed. Green through teal to navy across 58pt reads
  // as a mark; across 595pt, eight times in a document, it reads as a header
  // bar and stops meaning anything.
  flow.y -= RULE.gap;
  gradientBand(flow.page, flow.y, RULE.height, { x: M.left, width: RULE.width });
  flow.y -= RULE.height + RULE.gap;

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

  // A drawn layout, if this renderer knows it.
  //
  // Before the title's points, and INSTEAD of them: spec.js carries every
  // layout's content as points as well, so that a renderer which cannot draw
  // it still shows the words. Drawing the figure and then listing the same
  // values underneath says everything twice, which is the defect the deck
  // renderer had — a chain slide whose headline was its own step list over a
  // diagram of the same steps.
  const drew = section.layout
    ? drawFigure(flow, section, { rgb, fonts, column: COLUMN, left: M.left }, { reserved: true })
    : false;

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

  // Every point on its own card.
  //
  // A bullet list is the shape a wall of text takes when somebody has been
  // told to make it visual, and it was most of AAA_CISO_Brief_1.pdf. A card is
  // the deck's own vocabulary for a discrete item (§1.5, one idea to a card),
  // and against the cream ground a white panel with a teal edge is a field of
  // colour rather than a dash in the margin.
  //
  // Per point rather than one panel around the block: a point is independent,
  // so the list can break across a page without a card being cut in half, and
  // nothing has to know the total height in advance.
  for (const point of drew ? [] : section.points) {
    const height = flow.measure(point, {
      metrics: fonts.metrics.body,
      size: SIZE.point,
      leading: LEADING.point,
      indent: CARD.text,
      width: COLUMN - CARD.pad,
    });
    if (height + CARD.pad * 2 > flow.remaining) flow.newPage();

    // Drawn against the cursor before write() moves it, and from the top down,
    // because drawRectangle takes y as the bottom edge.
    flow.page.drawRectangle({
      x: M.left,
      y: flow.y - height - CARD.pad * 1.4,
      width: COLUMN,
      height: height + CARD.pad * 2,
      color: color('#FFFFFF'),
      borderColor: color(CREAM.tintBorder),
      borderWidth: 0.6,
    });

    // The edge that carries the colour. A full-height bar rather than a square
    // marker: the square was 3.5pt of teal per bullet, which is a rounding
    // error against a page.
    flow.page.drawRectangle({
      x: M.left,
      y: flow.y - height - CARD.pad * 1.4,
      width: 2.5,
      height: height + CARD.pad * 2,
      color: color(COLOR.circuitTeal),
    });

    flow.y -= CARD.pad * 0.6;
    flow.write(point, {
      font: fonts.body,
      metrics: fonts.metrics.body,
      size: SIZE.point,
      leading: LEADING.point,
      fill: color(INK.strong),
      indent: CARD.text,
      width: COLUMN - CARD.pad,
    });
    flow.gap(CARD.pad * 1.4 + 6);
  }

  flow.gap(20);
}

/** Exported for tests — see drawCover. */
export function drawClose(flow) {
  const { fonts, meta } = flow;

  // Seated at the FOOT of the page, not wherever the last section happened to
  // stop. A sign-off floating in the middle of a page with 300 points of cream
  // under it looks like the document ran out rather than ended, and pinning it
  // down also stops a section's trailing gap deciding whether it fits: the
  // first brief through this renderer put the block alone on a fourth page
  // because the closing figure left it thirteen points short.
  //
  // 104 rather than 118 for the same reason. The block is a tagline, a sender
  // line and a copyright line; 118 was room for a fourth that does not exist.
  const block = 104;
  const clearance = 30;
  const top = M.bottom + clearance + block;

  if (flow.y < top) flow.newPage();

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

  // A sign-off, not a colophon. Same reasoning as the cover eyebrow: the name
  // is what a reader needs — somebody to reply to — and "Prepared by" in front
  // of it is process language the reader has no use for.
  flow.page.drawText(`${meta.preparedBy} · ${meta.date}`, {
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

  // Embedded ONCE per document. pdf-lib embeds by document rather than by
  // page, so doing this inside drawCover would add the same image twice.
  const mark = await doc.embedPng(lockupBytes(false));

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
  flow.mark = mark;

  drawCover(flow);
  for (const section of spec.sections) drawSection(flow, section);
  drawClose(flow);
  drawFooters(flow);

  return doc.save();
}
