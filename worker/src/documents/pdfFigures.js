/**
 * pdfFigures.js — the drawn layouts, for the page rather than the slide.
 *
 * The premise this corrects: the PDF renderer was never unable to draw. It
 * already drew a gradient band, a footer hairline and a bullet marker. It had
 * simply never been taught the layouts, so spec.js's asText() flattened every
 * one of them into prose and the strongest number in a two-pager arrived as a
 * bold sentence. "7.5x: projected risk reduction from reordering the same
 * security budget by business risk" was set as a heading, two lines long, with
 * the figure doing none of the work a figure is for.
 *
 * These are NOT the deck's components ported over. A slide is 13.3 by 7.5
 * inches with one idea on it and a presenter beside it; an A4 page is a
 * column of flowed text read alone, at arm's length, probably on a phone.
 * Each figure here is sized to sit INSIDE that column, take a strip of it, and
 * hand the cursor back — so a figure and the paragraph under it read as one
 * argument rather than as a document with pictures in it.
 *
 * Every one draws within the flow and returns nothing. The flow's cursor moves
 * as a side effect, exactly as write() does, because a figure that leaves the
 * cursor somewhere unexpected corrupts every page after it.
 */

import { COLOR, INK, ON_NAVY, eyebrowCase } from '../brand.js';
import { CREAM } from './house.js';

/** pdf-lib takes colours as 0..1 triples; mirrors pdf.js's helper. */
function color(hex, rgbFn) {
  return rgbFn(
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  );
}

/**
 * The type sizes a figure uses.
 *
 * A figure's label is SMALLER than body copy, not larger. The figure carries
 * the emphasis; a label competing with it produces two things shouting and
 * nothing read.
 */
const F = {
  stat: 40,
  statCaption: 10.5,
  label: 8,
  cell: 9.5,
  value: 13,
};

/**
 * Draw one drawn layout, or return false for one this renderer has not been
 * taught.
 *
 * Returning false rather than throwing is deliberate: spec.js always carries
 * the layout's words as title/body/points as well, so an unknown layout falls
 * back to prose and loses formatting rather than content. That is what let
 * `table` ship here unfinished without any document losing its rows.
 */
export function drawFigure(flow, section, deps, { reserved = false } = {}) {
  const draw = FIGURES[section.layout];
  if (!draw) return false;

  // A figure split across a page break is worse than a figure lower down —
  // unless the CALLER has already made room, in which case this check is a
  // second opinion on a decision that was already taken, and second opinions
  // at a page boundary are how a heading and its figure end up on different
  // pages.
  //
  // drawSection reserves openerHeight + headingHeight + figureSpace(), spends
  // exactly that, and arrives here with precisely figureSpace() left. The two
  // numbers are equal, so `>` decides on a floating-point remainder: 103.90
  // against 103.90 broke the page, and "The agentic threat" sat alone at the
  // foot of page one with its figure overleaf.
  //
  // One place decides a section's page breaks. What keeps that safe is the
  // estimate being honest — every figure is asserted to claim at least the
  // space it takes — and not a redundant check that disagrees at the edge.
  if (!reserved) {
    const height = FIGURE_HEIGHT[section.layout](section, flow, deps);
    if (height > flow.remaining) flow.newPage();
  }

  draw(flow, section, deps);
  return true;
}

// --- stat -------------------------------------------------------------------

/**
 * One number, at a size that makes it the thing the eye lands on, with its
 * caption beside it rather than under it.
 *
 * Beside, because a page is a column: a number stacked over its caption wastes
 * the column's width and pushes everything below it down a screen. The rule at
 * the left is the same green rule the section headings use, so the figure
 * reads as part of the document rather than as an inserted graphic.
 */
function statFigure(flow, section, { rgb, fonts, column, left }) {
  const { drawText, drawRectangle } = wrap(flow.page);

  const top = flow.y;
  const valueWidth = fonts.metrics.display.widthOf(section.value, F.stat) + 18;

  drawRectangle({
    x: left,
    y: top - 58,
    width: 3,
    height: 58,
    color: color(COLOR.signalGreen, rgb),
  });

  drawText(section.value, {
    x: left + 16,
    y: top - 42,
    size: F.stat,
    font: fonts.display,
    color: color(COLOR.navy, rgb),
  });

  if (section.caption) {
    const captionX = left + 16 + valueWidth;
    const lines = flow.wrapText(section.caption, {
      metrics: fonts.metrics.body,
      size: F.statCaption,
      width: column - (captionX - left) - 4,
    });
    lines.slice(0, 3).forEach((line, i) => {
      drawText(line, {
        x: captionX,
        y: top - 24 - i * F.statCaption * 1.45,
        size: F.statCaption,
        font: fonts.body,
        color: color(INK.body, rgb),
      });
    });
  }

  flow.y = top - 58;
  flow.gap(14);
}

// --- paradigm ---------------------------------------------------------------

/**
 * From, arrow, to. The one the review called "the thesis in one visual".
 *
 * Two cells of equal width so neither side looks like the answer before it is
 * read, and the arrow between them rather than a colon, because the claim is a
 * movement. The right-hand cell carries the tint; the left is outlined only.
 */
function paradigmFigure(flow, section, { rgb, fonts, column, left }) {
  const { drawText, drawRectangle } = wrap(flow.page);

  const gutter = 26;
  const cellW = (column - gutter) / 2;
  const lines = (text) =>
    flow.wrapText(text, { metrics: fonts.metrics.heading, size: F.cell, width: cellW - 24 });

  const rows = Math.max(lines(section.from).length, lines(section.to).length);
  const cellH = Math.max(46, rows * F.cell * 1.4 + 26);
  const top = flow.y;

  const cell = (x, text, filled) => {
    drawRectangle({
      x,
      y: top - cellH,
      width: cellW,
      height: cellH,
      color: color(filled ? CREAM.tintBand : '#FFFFFF', rgb),
      borderColor: color(filled ? COLOR.circuitTeal : INK.rule, rgb),
      borderWidth: filled ? 1 : 0.75,
    });

    lines(text).forEach((line, i) => {
      drawText(line, {
        x: x + 12,
        y: top - 22 - i * F.cell * 1.4,
        size: F.cell,
        font: filled ? fonts.heading : fonts.body,
        color: color(filled ? COLOR.navy : INK.muted, rgb),
      });
    });
  };

  cell(left, section.from, false);
  cell(left + cellW + gutter, section.to, true);

  // The arrow: a shaft and a head, drawn rather than typed, because the
  // arrow glyphs are outside the two brand faces and brandSafe strips them.
  const midY = top - cellH / 2;
  const shaftX = left + cellW + 6;
  drawRectangle({ x: shaftX, y: midY - 0.75, width: 10, height: 1.5, color: color(COLOR.circuitTeal, rgb) });
  for (let i = 0; i < 5; i += 1) {
    drawRectangle({
      x: shaftX + 10 + i,
      y: midY - (5 - i),
      width: 1,
      height: (5 - i) * 2,
      color: color(COLOR.circuitTeal, rgb),
    });
  }

  flow.y = top - cellH;
  flow.gap(14);
}

// --- timeline ---------------------------------------------------------------

/**
 * A horizontal sequence, for "Week 0 / Weeks 1 to 2 / Week 3 and beyond".
 *
 * Labels sit UNDER their tick and are left-aligned to it rather than centred,
 * so a long label grows to the right into its own space instead of colliding
 * with its neighbour. The last tick takes the accent: a sequence is read for
 * where it ends.
 */
function timelineFigure(flow, section, { rgb, fonts, column, left }) {
  const { drawText, drawRectangle } = wrap(flow.page);

  const stops = section.stops.slice(0, 5);
  const step = column / stops.length;
  const top = flow.y;
  const lineY = top - 10;

  drawRectangle({ x: left, y: lineY, width: column - step / 2, height: 1, color: color(INK.rule, rgb) });

  let deepest = 0;
  stops.forEach((stop, i) => {
    const x = left + i * step;
    const last = i === stops.length - 1;

    drawRectangle({
      x,
      y: lineY - 4,
      width: 3,
      height: 10,
      color: color(last ? COLOR.signalGreen : COLOR.circuitTeal, rgb),
    });

    const lines = flow.wrapText(stop, {
      metrics: fonts.metrics.heading,
      size: F.cell,
      width: step - 12,
    });
    lines.slice(0, 2).forEach((line, r) => {
      drawText(line, {
        x,
        y: lineY - 22 - r * F.cell * 1.35,
        size: F.cell,
        font: fonts.heading,
        color: color(COLOR.navy, rgb),
      });
      deepest = Math.max(deepest, 22 + r * F.cell * 1.35 + F.cell);
    });
  });

  flow.y = lineY - deepest;
  flow.gap(14);
}

// --- tiles ------------------------------------------------------------------

/**
 * A two-column grid of figure-and-caption pairs.
 *
 * Two columns and not three: an A4 text column is 483 points, and a third
 * column takes each tile below the width where a caption can say anything.
 */
function tilesFigure(flow, section, { rgb, fonts, column, left }) {
  const { drawText, drawRectangle } = wrap(flow.page);

  const tiles = section.tiles.slice(0, 6);
  const gutter = 16;
  const cellW = (column - gutter) / 2;
  const captionLines = (t) =>
    flow.wrapText(t.caption, { metrics: fonts.metrics.body, size: F.label + 1, width: cellW - 24 });

  const rowsOf = [];
  for (let i = 0; i < tiles.length; i += 2) rowsOf.push(tiles.slice(i, i + 2));

  let y = flow.y;
  for (const row of rowsOf) {
    const cellH = Math.max(...row.map((t) => captionLines(t).length)) * (F.label + 1) * 1.4 + 44;

    row.forEach((tile, i) => {
      const x = left + i * (cellW + gutter);
      drawRectangle({
        x,
        y: y - cellH,
        width: cellW,
        height: cellH,
        color: color('#FFFFFF', rgb),
        borderColor: color(INK.rule, rgb),
        borderWidth: 0.75,
      });
      drawText(tile.value, {
        x: x + 12,
        y: y - 26,
        size: F.value + 6,
        font: fonts.display,
        color: color(COLOR.navy, rgb),
      });
      captionLines(tile).forEach((line, r) => {
        drawText(line, {
          x: x + 12,
          y: y - 42 - r * (F.label + 1) * 1.4,
          size: F.label + 1,
          font: fonts.body,
          color: color(INK.body, rgb),
        });
      });
    });

    y -= cellH + gutter;
  }

  flow.y = y;
  flow.gap(6);
}

// --- quote ------------------------------------------------------------------

/**
 * The one line to end on, reversed out of navy.
 *
 * This fell through to prose and arrived as another navy heading, which is
 * the layout doing nothing: a quote slide exists to be the only thing on the
 * page, and a document ending on a sentence set exactly like the six headings
 * above it has no ending.
 *
 * A filled panel rather than large type, because "the entire document feels
 * monotonous" is a complaint about fields of colour and not about point size.
 * Navy is the brand's own reverse ground and the closing block already uses
 * it, so the document ends on the colour it signs off in.
 */
function quoteFigure(flow, section, { rgb, fonts, column, left }) {
  const { drawText, drawRectangle } = wrap(flow.page);

  const size = F.value + 4;
  const lines = flow.wrapText(section.line, {
    metrics: fonts.metrics.display,
    size,
    width: column - 76,
  });

  const height = lines.length * size * 1.35 + 44;
  const top = flow.y;

  drawRectangle({ x: left, y: top - height, width: column, height, color: color(COLOR.navy, rgb) });

  // The teal edge, the same device the point cards carry, so the closing line
  // reads as the last item in the argument rather than as a separate object.
  drawRectangle({ x: left, y: top - height, width: 3, height, color: color(COLOR.brightTeal, rgb) });

  lines.forEach((line, i) => {
    drawText(line, {
      x: left + 28,
      y: top - 32 - i * size * 1.35,
      size,
      font: fonts.display,
      color: color(ON_NAVY.strong, rgb),
      characterSpacing: -0.02 * size,
    });
  });

  flow.y = top - height;
  flow.gap(14);
}

// --- split ------------------------------------------------------------------

/**
 * Two states side by side, the second one the argument.
 *
 * Near enough to paradigm to raise the question of why both exist: paradigm is
 * a movement and carries an arrow, split is a contrast and carries a rule. The
 * model is given both because it already writes both, and a layout that falls
 * through to prose is a layout that silently costs the document a figure.
 */
function splitFigure(flow, section, { rgb, fonts, column, left }) {
  const { drawText, drawRectangle } = wrap(flow.page);

  const gutter = 20;
  const cellW = (column - gutter) / 2;
  const lines = (text) =>
    flow.wrapText(text, { metrics: fonts.metrics.heading, size: F.cell, width: cellW - 28 });

  const rows = Math.max(lines(section.left).length, lines(section.right).length);
  const cellH = Math.max(52, rows * F.cell * 1.4 + 30);
  const top = flow.y;

  const cell = (x, text, accent) => {
    drawRectangle({
      x,
      y: top - cellH,
      width: cellW,
      height: cellH,
      color: color('#FFFFFF', rgb),
      borderColor: color(CREAM.tintBorder, rgb),
      borderWidth: 0.75,
    });
    drawRectangle({ x, y: top - cellH, width: 2.5, height: cellH, color: color(accent, rgb) });

    lines(text).forEach((line, i) => {
      drawText(line, {
        x: x + 16,
        y: top - 26 - i * F.cell * 1.4,
        size: F.cell,
        font: fonts.heading,
        color: color(COLOR.navy, rgb),
      });
    });
  };

  // Grey on the left and green on the right: green is the outcome colour and
  // the right-hand cell is the state being argued for. Grey is not a second
  // accent, it is the absence of one — and it has to be VISIBLE, which sand
  // was not: #DCD6C6 on a white card beside a cream page read as a cell that
  // had failed to draw its edge rather than as a cell with a neutral one.
  cell(left, section.left, INK.muted);
  cell(left + cellW + gutter, section.right, COLOR.signalGreen);

  flow.y = top - cellH;
  flow.gap(14);
}

// --- chain ------------------------------------------------------------------

/**
 * A sequence of steps stacked down the column, each on its own row.
 *
 * Down and not across, which is where this differs from the deck: five steps
 * across 13.3 inches is a diagram, and five steps across a 483 point column is
 * five words nobody can read. Stacked, the step number carries the sequence
 * and the row can be as long as it needs to be.
 */
function chainFigure(flow, section, { rgb, fonts, column, left }) {
  const { drawText, drawRectangle } = wrap(flow.page);

  const rowH = 26;
  let y = flow.y;

  // flow marks one step as the emphasis; chain has none, and a sequence is
  // read for where it ends, so the last step takes the accent by default.
  // Ignoring `emphasis` here would render a flow identically to a chain and
  // silently drop the one thing the author marked.
  const accented = Number.isInteger(section.emphasis) && section.emphasis >= 0
    ? section.emphasis
    : Math.min(section.steps.length, 5) - 1;

  section.steps.slice(0, 5).forEach((step, i) => {
    const last = i === accented;

    drawRectangle({
      x: left,
      y: y - rowH + 4,
      width: column,
      height: rowH - 4,
      color: color('#FFFFFF', rgb),
      borderColor: color(CREAM.tintBorder, rgb),
      borderWidth: 0.75,
    });

    // The index, set in the mono face so the column of numbers aligns.
    drawRectangle({
      x: left,
      y: y - rowH + 4,
      width: 24,
      height: rowH - 4,
      color: color(last ? COLOR.signalGreen : COLOR.circuitTeal, rgb),
    });
    drawText(String(i + 1), {
      x: left + 9,
      y: y - rowH + 12,
      size: F.label + 1,
      font: fonts.eyebrow,
      color: color(ON_NAVY.strong, rgb),
    });

    drawText(step, {
      x: left + 36,
      y: y - rowH + 12,
      size: F.cell,
      font: fonts.heading,
      color: color(COLOR.navy, rgb),
    });

    y -= rowH;
  });

  flow.y = y;
  flow.gap(12);
}

// --- table ------------------------------------------------------------------

/**
 * Rows and columns, with the header band carrying the colour.
 *
 * "table shipped here unfinished" is what the module header said about this,
 * and unfinished meant the rows arrived as comma-separated prose. A table is
 * the one layout whose content is already a grid, so rendering it as a
 * sentence loses the only thing it had.
 */
function tableFigure(flow, section, { rgb, fonts, column, left }) {
  const { drawText, drawRectangle } = wrap(flow.page);

  const cols = section.columns.length;
  const colW = column / cols;
  const headH = 22;
  const lines = (text) =>
    flow.wrapText(text, { metrics: fonts.metrics.body, size: F.cell, width: colW - 20 });

  const top = flow.y;
  let y = top;

  drawRectangle({ x: left, y: y - headH, width: column, height: headH, color: color(COLOR.navy, rgb) });
  section.columns.forEach((heading, c) => {
    drawText(eyebrowCase(heading), {
      x: left + c * colW + 10,
      y: y - headH + 8,
      size: F.label,
      font: fonts.eyebrow,
      color: color(ON_NAVY.strong, rgb),
      characterSpacing: 0.12 * F.label,
    });
  });
  y -= headH;

  section.rows.forEach((row, r) => {
    const rowH = Math.max(...row.map((cell) => lines(cell).length)) * F.cell * 1.35 + 12;

    // Banded, because a hairline between every row of a narrow table is more
    // rules than data. The band is the tint, not grey.
    drawRectangle({
      x: left,
      y: y - rowH,
      width: column,
      height: rowH,
      color: color(r % 2 ? '#FFFFFF' : CREAM.tintBand, rgb),
      borderColor: color(CREAM.tintBorder, rgb),
      borderWidth: 0.5,
    });

    row.forEach((cell, c) => {
      lines(cell).forEach((line, i) => {
        drawText(line, {
          x: left + c * colW + 10,
          y: y - 14 - i * F.cell * 1.35,
          size: F.cell,
          font: c === 0 ? fonts.heading : fonts.body,
          color: color(c === 0 ? COLOR.navy : INK.body, rgb),
        });
      });
    });

    y -= rowH;
  });

  flow.y = y;
  flow.gap(14);
}

// --- bars -------------------------------------------------------------------

/**
 * Horizontal bars, scaled to the largest value rather than to 100.
 *
 * To the largest, because these are rarely percentages of anything: three
 * values of 61, 44 and 22 scaled against 100 draw three short stubs and throw
 * away the comparison, which is the only reason the chart is there.
 */
function barsFigure(flow, section, { rgb, fonts, column, left }) {
  const { drawText, drawRectangle } = wrap(flow.page);

  const bars = section.bars.slice(0, 6);
  const max = Math.max(...bars.map((b) => Math.abs(b.value)), 1);
  const numberW = 42;
  const trackW = column - numberW - 10;
  const rowH = 30;

  let y = flow.y;
  bars.forEach((bar, i) => {
    drawText(bar.label, {
      x: left,
      y: y - 10,
      size: F.label + 1,
      font: fonts.body,
      color: color(INK.body, rgb),
    });

    drawRectangle({ x: left, y: y - 22, width: trackW, height: 7, color: color(COLOR.sand, rgb) });
    drawRectangle({
      x: left,
      y: y - 22,
      width: Math.max(2, (Math.abs(bar.value) / max) * trackW),
      height: 7,
      // The largest bar is the point of the chart, so it takes the accent
      // and the rest recede. Colouring them all identically makes the reader
      // do the comparison the chart was supposed to have done.
      color: color(Math.abs(bar.value) === max ? COLOR.signalGreen : COLOR.circuitTeal, rgb),
    });

    drawText(String(bar.value), {
      x: left + trackW + 10,
      y: y - 24,
      size: F.value,
      font: fonts.heading,
      color: color(COLOR.navy, rgb),
    });

    y -= rowH;
  });

  flow.y = y;
  flow.gap(8);
}

// --- registry ---------------------------------------------------------------

const FIGURES = {
  stat: statFigure,
  paradigm: paradigmFigure,
  timeline: timelineFigure,
  tiles: tilesFigure,
  bars: barsFigure,
  quote: quoteFigure,
  split: splitFigure,
  chain: chainFigure,
  // flow is chain with an emphasised step; the page stacks its steps either
  // way, so one drawing serves both rather than two that drift apart.
  flow: chainFigure,
  table: tableFigure,
};

/**
 * What each figure will occupy, so drawFigure can decide about a page break
 * BEFORE drawing anything. Approximate on purpose: over-estimating costs a
 * little whitespace, under-estimating splits a figure across two pages.
 */
const FIGURE_HEIGHT = {
  stat: () => 72,
  paradigm: (s, flow, { fonts, column }) => {
    const cellW = (column - 26) / 2;
    const rows = Math.max(
      flow.wrapText(s.from, { metrics: fonts.metrics.heading, size: F.cell, width: cellW - 24 }).length,
      flow.wrapText(s.to, { metrics: fonts.metrics.heading, size: F.cell, width: cellW - 24 }).length,
    );
    return Math.max(46, rows * F.cell * 1.4 + 26) + 14;
  },
  timeline: () => 62,
  // Measured, not guessed at 76 a row.
  //
  // A row is 44 points of furniture plus as many lines as the caption wraps
  // to, and the estimate ignored the caption entirely. On a four-tile figure
  // with two-line captions it was 18 points short — enough for drawSection to
  // reserve, draw the heading, and then have drawFigure disagree and break the
  // page, leaving "The agentic threat" alone at the foot of page one with its
  // figure on page two.
  tiles: (s, flow, { fonts, column }) => {
    const cellW = (column - 16) / 2;
    const tiles = s.tiles.slice(0, 6);
    let total = 0;

    for (let i = 0; i < tiles.length; i += 2) {
      const lines = Math.max(
        ...tiles.slice(i, i + 2).map((t) =>
          flow.wrapText(t.caption, { metrics: fonts.metrics.body, size: F.label + 1, width: cellW - 24 }).length),
      );
      total += lines * (F.label + 1) * 1.4 + 44 + 16;
    }

    return total + 6;
  },
  bars: (s) => Math.min(s.bars.length, 6) * 30 + 8,
  quote: (s, flow, { fonts, column }) =>
    flow.wrapText(s.line, { metrics: fonts.metrics.display, size: F.value + 4, width: column - 76 }).length
      * (F.value + 4) * 1.35 + 58,
  split: (s, flow, { fonts, column }) => {
    const cellW = (column - 20) / 2;
    const rows = Math.max(
      flow.wrapText(s.left, { metrics: fonts.metrics.heading, size: F.cell, width: cellW - 28 }).length,
      flow.wrapText(s.right, { metrics: fonts.metrics.heading, size: F.cell, width: cellW - 28 }).length,
    );
    return Math.max(52, rows * F.cell * 1.4 + 30) + 14;
  },
  chain: (s) => Math.min(s.steps.length, 5) * 26 + 12,
  flow: (s) => Math.min(s.steps.length, 5) * 26 + 12,
  table: (s, flow, { fonts, column }) => {
    const colW = column / s.columns.length;
    const body = s.rows.reduce(
      (total, row) =>
        total +
        Math.max(...row.map((cell) =>
          flow.wrapText(cell, { metrics: fonts.metrics.body, size: F.cell, width: colW - 20 }).length))
          * F.cell * 1.35 + 12,
      0,
    );
    return 22 + body + 14;
  },
};

/**
 * How much room a figure needs, for a caller deciding about a page break
 * before any of it is drawn. Returns 0 for a layout this renderer cannot draw.
 */
export function figureSpace(section, flow, deps) {
  const measure = FIGURE_HEIGHT[section.layout];
  return measure ? measure(section, flow, deps) : 0;
}

/** Layouts this renderer can draw, for tests and for the spec's own reporting. */
export const PDF_FIGURES = Object.keys(FIGURES);

/**
 * pdf-lib's page methods, bound.
 *
 * A one-line indirection that exists so every figure above reads as drawing
 * rather than as page plumbing, and so the eyebrow helper is available without
 * each figure importing it.
 */
function wrap(page) {
  return {
    drawText: page.drawText.bind(page),
    drawRectangle: page.drawRectangle.bind(page),
    eyebrow: eyebrowCase,
  };
}
