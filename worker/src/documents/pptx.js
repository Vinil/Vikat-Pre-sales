/**
 * pptx.js — render a document spec as a branded 16:9 deck.
 *
 * Every slide is drawn from absolute coordinates in inches. Nothing is a
 * PowerPoint placeholder and nothing auto-fits, so what a rep opens is what
 * this file laid out.
 *
 * Layouts, in the order the guidelines allow them:
 *   cover     the brand gradient, wordmark, title, audience, disclosure
 *   section   navy divider between parts of a long deck
 *   content   white ground, eyebrow, title, body, points
 *   close     navy, tagline, contact
 *
 * The gradient appears on the cover and on dividers only. That is a brand
 * rule, and it is enforced here rather than left to the caller.
 */

import { zipSync, strToU8 } from 'fflate';

import { COLOR, INK, ON_NAVY, FONT, GRADIENT, WORDMARK, TAGLINE, copyrightLine, eyebrowCase } from '../brand.js';
import { DISCLOSURE_LABELS } from './spec.js';
import { wrap } from './measure.js';
import * as part from './ooxml.js';
import { GEOMETRY, FLOORS, FINE_PRINT } from './house.js';
import * as comp from './components.js';

const { emu, hex, xml, SLIDE } = part;

/** Points to hundredths of a point, which is how OOXML sizes text. */
const pt = (n) => Math.round(n * 100);

/** Tracking in em to OOXML's 1/100 pt spacing, at a given size. */
const track = (em, sizePt) => Math.round(em * sizePt * 100);

/**
 * The deck type scale, in points.
 *
 * brand.js gives ratios against a medium's base body size; a 13.3in slide read
 * from across a room takes an 18pt base. The brand's own 88px display figure
 * belongs to a full-bleed web hero and would not fit a slide title.
 */
const BASE_PT = 18;
// §3.1 and §4.2. The floors are floors: nothing here may go below them, and
// the fitting pass in contentSlide() is clamped so shrinking cannot either.
const SIZE = {
  coverTitle: 40,
  coverSub: GEOMETRY.subtitle.size,
  sectionTitle: 32,
  slideTitle: GEOMETRY.title.size,
  body: BASE_PT,
  point: BASE_PT,
  eyebrow: GEOMETRY.eyebrow.size,
  footer: FLOORS.finePrint,
  wordmark: 20,
};

/** Margins. Generous space is part of the type system, not a nicety. */
// §3.1: MX = 0.6 both sides. The vertical margins are this renderer's own —
// the instruction set fixes element positions rather than a top margin — and
// are set so the eyebrow lands on its stated y.
const M = { left: GEOMETRY.marginX, right: GEOMETRY.marginX, top: GEOMETRY.eyebrow.y, bottom: 0.55 };
const CONTENT_WIDTH = SLIDE.widthIn - M.left - M.right;

// --- Shape helpers --------------------------------------------------------

let shapeId = 1;
const nextId = () => (shapeId += 1);

function frame({ x, y, w, h }) {
  return `<a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/>`;
}

/** A solid or gradient rectangle. */
function rect(box, fill) {
  const id = nextId();
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="r${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm>${frame(box)}</a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}</p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`;
}

const solid = (color) => `<a:solidFill><a:srgbClr val="${hex(color)}"/></a:solidFill>`;

/**
 * The brand gradient, at 120°.
 *
 * DrawingML measures the angle clockwise from east in 1/60000ths of a degree,
 * which is the same direction CSS measures from north — so a 120° CSS gradient
 * is 30° here.
 */
function gradientFill() {
  const stops = GRADIENT.stops
    .map((c, i) => {
      const pos = Math.round((i / (GRADIENT.stops.length - 1)) * 100000);
      return `<a:gs pos="${pos}"><a:srgbClr val="${hex(c)}"/></a:gs>`;
    })
    .join('');

  const angle = ((GRADIENT.angleDegrees - 90 + 360) % 360) * 60000;
  return `<a:gradFill flip="none" rotWithShape="1"><a:gsLst>${stops}</a:gsLst><a:lin ang="${angle}" scaled="0"/></a:gradFill>`;
}

/**
 * A text box.
 *
 * `runs` is one entry per line. Each carries its own size and colour so a
 * heading and its supporting line can share a box and stay optically locked
 * together rather than positioned twice.
 */
function text(box, runs, { align = 'l', anchor = 't' } = {}) {
  const id = nextId();

  const paragraphs = runs
    .map((r) => {
      const font = FONT[r.role] || FONT.body;
      const size = r.size;
      const spacing = track(r.tracking ?? 0, size);
      const lineSpacing = Math.round((r.lineHeight ?? 1.3) * 100000);
      const before = r.spaceBefore ? `<a:spcBef><a:spcPts val="${pt(r.spaceBefore)}"/></a:spcBef>` : '';

      const body = xml(r.text);
      // An empty run still needs a paragraph so vertical rhythm survives.
      if (!body) return `<a:p><a:pPr algn="${align}"/><a:endParaRPr sz="${pt(size)}"/></a:p>`;

      const bullet = r.bullet
        ? `<a:buFont typeface="Arial"/><a:buChar char="•"/>`
        : '<a:buNone/>';
      const indent = r.bullet ? ' marL="228600" indent="-228600"' : '';

      return `<a:p><a:pPr algn="${align}"${indent}><a:lnSpc><a:spcPct val="${lineSpacing}"/></a:lnSpc>${before}${bullet}</a:pPr>` +
        `<a:r><a:rPr lang="en-US" sz="${pt(size)}" b="${font.weight >= 700 ? 1 : 0}" spc="${spacing}" dirty="0">` +
        `${solid(r.color)}<a:latin typeface="${font.family}"/><a:cs typeface="${font.family}"/></a:rPr>` +
        `<a:t>${body}</a:t></a:r></a:p>`;
    })
    .join('');

  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="t${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm>${frame(box)}</a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>
<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}

/**
 * The wordmark, set in Inter Black.
 *
 * The full lockup pairs this with the chip-in-orbit emblem, which is a
 * supplied asset and not something to approximate — the guidelines prohibit
 * altering or reconstructing a mark. The wordmark is registered on its own,
 * so using it alone is a legitimate variant rather than a compromise. Drop
 * the emblem SVG into the repo and this becomes the full lockup.
 */
function wordmark(x, y, onDark) {
  return text(
    { x, y, w: 3, h: 0.45 },
    [
      {
        text: WORDMARK,
        role: 'display',
        size: SIZE.wordmark,
        tracking: -0.03,
        lineHeight: 1,
        color: onDark ? ON_NAVY.strong : COLOR.navy,
      },
    ],
  );
}

/** The standing footer: what this is, and what may be done with it. */
/**
 * The footer, to §3.2: fine print, disclosure, tag, page number.
 *
 * Every slide carries all of it, cover and closing included. The fine print is
 * the trademark line reproduced exactly — "exactly" is the rule, so it is a
 * constant rather than a template — and the completeness contract (§3.5) turns
 * on it: a slide gets screenshotted and forwarded without the deck, and the
 * footer is how a reader knows who is claiming what they are reading.
 */
function footer(spec, onDark, pageLabel) {
  const label = DISCLOSURE_LABELS[spec.disclosure];
  const color = onDark ? ON_NAVY.muted : INK.muted;
  const faint = onDark ? ON_NAVY.muted : INK.muted;

  return (
    // §3.2: fine print bottom left at y 7.16, 6.5pt — the type floor, not
    // below it.
    text({ x: GEOMETRY.marginX, y: GEOMETRY.finePrint.y, w: SLIDE.widthIn - GEOMETRY.marginX * 2 - 1.6, h: 0.24 }, [
      { text: FINE_PRINT, role: 'body', size: FLOORS.finePrint, lineHeight: 1.1, color: faint },
    ]) +
    // The disclosure sits above it. Not in the instruction set, and kept:
    // this assistant produces drafts that a rep must not send unreviewed, and
    // that is a fact about this deck rather than about the house style.
    text({ x: GEOMETRY.marginX, y: GEOMETRY.finePrint.y - 0.26, w: SLIDE.widthIn - GEOMETRY.marginX * 2 - 1.6, h: 0.24 }, [
      { text: eyebrowCase(label), role: 'eyebrow', size: GEOMETRY.tag.size, tracking: 0.12, lineHeight: 1, color },
    ]) +
    text({ x: GEOMETRY.pageNumber.x - 0.9, y: GEOMETRY.tag.y, w: 0.9, h: 0.3 }, [
      { text: pageLabel, role: 'eyebrow', size: GEOMETRY.pageNumber.size, tracking: 0.12, lineHeight: 1, color },
    ], { align: 'r' })
  );
}

/**
 * Settle a slide's content into the space it has.
 *
 * Every layout below composes downward from the top margin, which is the
 * natural way to write them and produces a deck where the words huddle in the
 * top four-tenths and the bottom half is empty. On a projector that reads as
 * unfinished — and it was, on every slide of every deck this has produced.
 *
 * So the shapes are laid out first and placed second: the block is measured,
 * then shifted into the band between the top margin and the footer. Not dead
 * centre — a shade above it, which is where the eye expects the weight of a
 * composed page to sit.
 *
 * String surgery on the XML rather than a parameter threaded through nine
 * layout functions: the offsets are already written, and rewriting them in one
 * place cannot be forgotten by the tenth layout somebody adds later.
 *
 * @param {string[]} shapes  Content shapes, in document order.
 * @param {number} reserveBottom  Space the footer needs, in inches.
 */
function settle(shapes, reserveBottom = 0.75) {
  const body = shapes.filter(Boolean);
  if (!body.length) return body.join('');

  const boxes = body.map(boxOf).filter(Boolean);
  if (!boxes.length) return body.join('');

  const top = Math.min(...boxes.map((b) => b.y));
  const bottom = Math.max(...boxes.map((b) => b.y + b.cy));

  const bandTop = M.top;
  const bandBottom = SLIDE.heightIn - M.bottom - reserveBottom;
  const slack = bandBottom - bandTop - (bottom - top);

  // Nothing to give. A slide that already fills its band is left exactly
  // where its layout put it — shifting it up would crop the top.
  if (slack <= 0.05) return body.join('');

  const shift = bandTop + slack * 0.42 - top;
  if (Math.abs(shift) < 0.02) return body.join('');

  return body.map((shape) => shiftY(shape, shift)).join('');
}

/** The first offset/extent pair in a shape, in inches. */
function boxOf(shape) {
  const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(shape);
  const ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(shape);
  if (!off) return null;
  return {
    y: Number(off[2]) / 914400,
    cy: ext ? Number(ext[2]) / 914400 : 0,
  };
}

/** Move every offset in a shape down by `inches`. */
function shiftY(shape, inches) {
  const delta = Math.round(inches * 914400);
  return shape.replace(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/g, (_, x, y) => {
    const moved = Math.max(0, Number(y) + delta);
    return `<a:off x="${x}" y="${moved}"/>`;
  });
}

function slideXml(shapes, background) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld>${background}<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr/>
${shapes}
</p:spTree></p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

const bg = (color) =>
  `<p:bg><p:bgPr>${solid(color)}<a:effectLst/></p:bgPr></p:bg>`;

// --- Layouts --------------------------------------------------------------

function coverSlide(spec, meta, fonts) {
  const titleWidth = CONTENT_WIDTH * 0.82;

  // A long title steps down a size rather than wrapping to four lines. Chosen
  // by measuring, so the step happens when the text actually overflows two
  // lines and not at an arbitrary character count.
  const titleSize = [SIZE.coverTitle, SIZE.coverTitle - 6, SIZE.coverTitle - 11].find(
    (size) => wrap(spec.title, fonts.display, size, titleWidth * 72, -0.03).length <= 2,
  ) || SIZE.coverTitle - 11;

  const titleHeight = heightOf(spec.title, fonts.display, titleSize, titleWidth, 1.06, -0.03);
  const coverTitleTop = 2.55;

  const shapes = [
    // The gradient is a band, not the whole ground: a full-bleed gradient
    // behind body text is what the "covers and dividers only" rule is
    // guarding against.
    rect({ x: 0, y: 0, w: SLIDE.widthIn, h: 0.22 }, gradientFill()),
    wordmark(M.left, 0.85, false),

    text({ x: M.left, y: coverTitleTop, w: titleWidth, h: titleHeight }, [
      {
        text: spec.title,
        role: 'display',
        size: titleSize,
        tracking: -0.03,
        lineHeight: 1.06,
        color: COLOR.navy,
      },
    ]),

    spec.subtitle
      ? text({ x: M.left, y: coverTitleTop + titleHeight + 0.55, w: CONTENT_WIDTH * 0.72, h: 0.9 }, [
          { text: spec.subtitle, role: 'body', size: SIZE.coverSub, lineHeight: 1.45, color: INK.body },
        ])
      : '',

    text({ x: M.left, y: 1.7, w: CONTENT_WIDTH, h: 0.3 }, [
      {
        text: eyebrowCase(spec.audience ? `Prepared for ${spec.audience}` : meta.date),
        role: 'eyebrow',
        size: SIZE.eyebrow,
        tracking: 0.12,
        lineHeight: 1,
        color: COLOR.circuitTeal,
      },
    ]),

  ];

  // The gradient band is bled to the slide edge, so it is placed rather than
  // settled — it has no business drifting toward the middle.
  const [band, ...block] = shapes;
  return slideXml(band + settle(block, 1.1) + footer(spec, false, meta.date), bg(COLOR.cream));
}

/**
 * How much vertical room a run of text needs, in inches.
 *
 * Measured against the real font rather than estimated from character counts:
 * an estimate leaves a hole under every short heading and overlaps every long
 * one, and both are visible on the first slide a rep opens.
 *
 * `lineHeight` is the OOXML `spcPct` value, which PowerPoint applies to the
 * font's own line advance rather than to the point size — so the font's
 * natural line height is part of the sum, not an approximation of 1.0.
 */
function heightOf(text, metrics, sizePt, widthIn, lineHeight, tracking = 0) {
  const lines = wrap(text, metrics, sizePt, widthIn * 72, tracking);
  return (Math.max(lines.length, 1) * sizePt * lineHeight * metrics.naturalLineHeight) / 72;
}

// --- Drawn slides ---------------------------------------------------------
//
// Every layout below is built from the same rect() and text() the prose slides
// use. Nothing here is an image: a deck that needs a photograph needs a
// designer, and pretending otherwise produces clip art. What these do is give
// a number, a sequence or a comparison the shape it actually has, so a slide
// reads in two seconds from the back of a room instead of being a paragraph
// the presenter reads aloud.

/**
 * The rule and, when there is one, the heading a drawn slide is titled with.
 *
 * bars, chain and timeline had no title slot at all, so they rendered as a
 * bare green rule above a drawing — a slide the presenter has to explain from
 * memory, which is not what a drawing is for. The rule alone is kept for the
 * layouts that genuinely caption themselves further down, like stat.
 *
 * @returns {{ shapes: string[], nextY: number }}
 */
function drawnHead(title, fonts) {
  const shapes = [rect({ x: M.left, y: M.top + 0.02, w: 0.55, h: 0.055 }, solid(COLOR.signalGreen))];
  if (!title) return { shapes, nextY: M.top + 0.55 };

  const h = heightOf(title, fonts.display, SIZE.slideTitle, CONTENT_WIDTH * 0.8, 1.15, -0.02) || 0.75;
  shapes.push(
    text({ x: M.left, y: M.top + 0.42, w: CONTENT_WIDTH * 0.8, h }, [
      { text: title, role: 'display', size: SIZE.slideTitle, tracking: -0.02, lineHeight: 1.15, color: COLOR.navy },
    ]),
  );
  return { shapes, nextY: M.top + 0.42 + h + 0.45 };
}

/** The caption line under a drawing, in the muted ink prose uses. */
function captionAt(textValue, y, width) {
  return text({ x: M.left, y, w: width, h: 0.5 }, [
    { text: textValue, role: 'body', size: SIZE.body, lineHeight: 1.4, color: INK.body },
  ]);
}

/**
 * One number, at the size the number deserves.
 *
 * 96pt is larger than anything else in the deck on purpose: a stat slide that
 * hedges its own headline is a paragraph with extra whitespace.
 */
function statSlide(spec, section, meta, pageLabel, fonts) {
  const shapes = [rect({ x: M.left, y: M.top + 0.02, w: 0.55, h: 0.055 }, solid(COLOR.signalGreen))];

  shapes.push(
    text({ x: M.left, y: M.top + 0.55, w: CONTENT_WIDTH, h: 2.1 }, [
      { text: section.value, role: 'display', size: 96, tracking: -0.04, lineHeight: 1, color: COLOR.navy },
    ]),
  );

  if (section.caption) {
    shapes.push(
      text({ x: M.left, y: M.top + 2.75, w: CONTENT_WIDTH * 0.7, h: 1.1 }, [
        { text: section.caption, role: 'display', size: SIZE.slideTitle, tracking: -0.02, lineHeight: 1.2, color: COLOR.circuitTeal },
      ]),
    );
  }

  if (section.body) shapes.push(captionAt(section.body, M.top + 3.95, CONTENT_WIDTH * 0.8));

  return slideXml(settle(shapes) + footer(spec, false, pageLabel), bg(COLOR.cream));
}

/**
 * Horizontal bars, scaled to the largest value.
 *
 * Scaled to the data rather than to 100 so a set of small numbers is still
 * legible — and labelled with the real figure, so the scaling can never
 * overstate anything.
 */
function barsSlide(spec, section, meta, pageLabel, fonts) {
  const head = drawnHead(section.title, fonts);
  const shapes = [...head.shapes];
  let y = head.nextY - 0.1;

  if (section.body) {
    shapes.push(
      text({ x: M.left, y, w: CONTENT_WIDTH * 0.85, h: 0.9 }, [
        { text: section.body, role: 'display', size: SIZE.slideTitle, tracking: -0.02, lineHeight: 1.15, color: COLOR.navy },
      ]),
    );
    y += 1.15;
  }

  const max = Math.max(...section.bars.map((b) => Math.abs(b.value))) || 1;
  const trackWidth = CONTENT_WIDTH * 0.68;
  const rowHeight = 0.72;

  section.bars.forEach((b, i) => {
    const top = y + i * rowHeight;

    shapes.push(
      text({ x: M.left, y: top, w: trackWidth, h: 0.3 }, [
        { text: b.label, role: 'body', size: 14, lineHeight: 1, color: INK.body },
      ]),
    );

    // The empty track, so a short bar still reads as a proportion.
    shapes.push(rect({ x: M.left, y: top + 0.3, w: trackWidth, h: 0.26 }, solid(INK.rule)));
    shapes.push(
      rect(
        { x: M.left, y: top + 0.3, w: Math.max(0.08, (trackWidth * Math.abs(b.value)) / max), h: 0.26 },
        solid(i === 0 ? COLOR.signalGreen : COLOR.circuitTeal),
      ),
    );

    shapes.push(
      text({ x: M.left + trackWidth + 0.22, y: top + 0.2, w: 1.6, h: 0.45 }, [
        { text: String(b.value), role: 'display', size: 24, tracking: -0.02, lineHeight: 1, color: COLOR.navy },
      ]),
    );
  });

  return slideXml(settle(shapes) + footer(spec, false, pageLabel), bg(COLOR.cream));
}

/** A sequence of named stages, left to right, with the flow made visible. */
function chainSlide(spec, section, meta, pageLabel, fonts) {
  const head = drawnHead(section.title, fonts);
  const shapes = [...head.shapes];
  let y = head.nextY - 0.1;

  if (section.body) {
    shapes.push(
      text({ x: M.left, y, w: CONTENT_WIDTH * 0.85, h: 0.9 }, [
        { text: section.body, role: 'display', size: SIZE.slideTitle, tracking: -0.02, lineHeight: 1.15, color: COLOR.navy },
      ]),
    );
    y += 1.3;
  } else {
    y += 0.9;
  }

  const n = section.steps.length;
  const gap = 0.28;
  const boxW = (CONTENT_WIDTH - gap * (n - 1)) / n;
  const boxH = 1.35;

  section.steps.forEach((step, i) => {
    const x = M.left + i * (boxW + gap);
    // Deepening navy along the chain: the eye follows the darkening, which is
    // the direction of the argument.
    const shade = i === n - 1 ? COLOR.navy : i === 0 ? COLOR.circuitTeal : COLOR.navy;
    shapes.push(rect({ x, y, w: boxW, h: boxH }, solid(shade)));
    shapes.push(
      text({ x: x + 0.16, y: y + 0.42, w: boxW - 0.32, h: 0.7 }, [
        { text: step, role: 'display', size: 17, tracking: -0.01, lineHeight: 1.15, color: ON_NAVY.strong },
      ]),
    );

    if (i < n - 1) {
      // A connector, not an arrowhead: a filled notch between boxes reads as
      // flow at slide distance and needs no glyph.
      shapes.push(rect({ x: x + boxW, y: y + boxH / 2 - 0.03, w: gap, h: 0.06 }, solid(COLOR.signalGreen)));
    }
  });

  return slideXml(settle(shapes) + footer(spec, false, pageLabel), bg(COLOR.cream));
}

/** Stops along a single rule — a calendar, a phase plan, a sequence in time. */
function timelineSlide(spec, section, meta, pageLabel, fonts) {
  const head = drawnHead(section.title, fonts);
  const shapes = [...head.shapes];
  let y = head.nextY - 0.1;

  if (section.body) {
    shapes.push(
      text({ x: M.left, y, w: CONTENT_WIDTH * 0.85, h: 0.9 }, [
        { text: section.body, role: 'display', size: SIZE.slideTitle, tracking: -0.02, lineHeight: 1.15, color: COLOR.navy },
      ]),
    );
    y += 1.5;
  } else {
    y += 1.1;
  }

  shapes.push(rect({ x: M.left, y: y + 0.5, w: CONTENT_WIDTH, h: 0.045 }, solid(INK.rule)));

  const n = section.stops.length;
  // Spread across the rule, not stepped along it. `CONTENT_WIDTH / n` put the
  // last stop at n-1/n of the way and left a hand's width of rule pointing at
  // nothing — a line that stops before its own end reads as a rendering bug.
  const step = n > 1 ? CONTENT_WIDTH / (n - 1) : 0;
  const labelWidth = n > 1 ? Math.min(step - 0.2, 2.6) : CONTENT_WIDTH;

  section.stops.forEach((stop, i) => {
    // The MARKER sits where the stop is; only its label is pulled back, and
    // only for the last one, so the text ends at the rule instead of running
    // past it. Clamping the marker too bunched the final stops together.
    const x = M.left + i * step;
    // The final label is sized to its own text before being pulled back, so
    // it sits under its marker rather than a column-width to the left of it.
    const own = i === n - 1
      ? Math.min(labelWidth, fonts.display.widthOf(stop, 15, -0.01) / 72 + 0.06)
      : labelWidth;
    const labelX = Math.min(x, M.left + CONTENT_WIDTH - own);

    shapes.push(rect({ x: Math.min(x, M.left + CONTENT_WIDTH - 0.16), y: y + 0.34, w: 0.16, h: 0.36 },
      solid(i === n - 1 ? COLOR.signalGreen : COLOR.circuitTeal)));
    shapes.push(
      text({ x: labelX, y: y + 0.92, w: own, h: 0.8 }, [
        { text: stop, role: 'display', size: 15, tracking: -0.01, lineHeight: 1.2, color: COLOR.navy },
      ]),
    );
  });

  return slideXml(settle(shapes) + footer(spec, false, pageLabel), bg(COLOR.cream));
}

/** Two states side by side, the second one carrying the weight. */
function splitSlide(spec, section, meta, pageLabel, fonts) {
  const head = drawnHead(section.title, fonts);
  const shapes = [...head.shapes];
  let y = head.nextY - 0.1;

  if (section.body) {
    shapes.push(
      text({ x: M.left, y, w: CONTENT_WIDTH * 0.85, h: 0.9 }, [
        { text: section.body, role: 'display', size: SIZE.slideTitle, tracking: -0.02, lineHeight: 1.15, color: COLOR.navy },
      ]),
    );
    y += 1.25;
  } else {
    y += 0.85;
  }

  const gap = 0.4;
  const colW = (CONTENT_WIDTH - gap) / 2;

  // Sized to the words, not fixed at 2.5in. A fixed height gave two big
  // rectangles with one line of text at the top and a hand's width of empty
  // colour beneath — which is what "What the stack sees today | What
  // SecSemantic adds" looked like on a slide a rep opened.
  const inner = colW - 0.56;
  const colH = Math.max(
    1.15,
    0.9 + Math.max(
      heightOf(section.left, fonts.display, 20, inner, 1.25, -0.01),
      heightOf(section.right, fonts.display, 20, inner, 1.25, -0.01),
    ),
  );

  // Left is the status quo, in outline; right is the change, filled. The
  // asymmetry is the argument.
  shapes.push(rect({ x: M.left, y, w: colW, h: colH }, solid(COLOR.white)));
  shapes.push(rect({ x: M.left, y, w: colW, h: 0.05 }, solid(INK.rule)));
  shapes.push(
    text({ x: M.left + 0.28, y: y + 0.45, w: colW - 0.56, h: colH - 0.7 }, [
      { text: section.left, role: 'display', size: 20, tracking: -0.01, lineHeight: 1.25, color: INK.muted },
    ]),
  );

  shapes.push(rect({ x: M.left + colW + gap, y, w: colW, h: colH }, solid(COLOR.navy)));
  shapes.push(rect({ x: M.left + colW + gap, y, w: colW, h: 0.05 }, solid(COLOR.signalGreen)));
  shapes.push(
    text({ x: M.left + colW + gap + 0.28, y: y + 0.45, w: colW - 0.56, h: colH - 0.7 }, [
      { text: section.right, role: 'display', size: 20, tracking: -0.01, lineHeight: 1.25, color: ON_NAVY.strong },
    ]),
  );

  return slideXml(settle(shapes) + footer(spec, false, pageLabel), bg(COLOR.cream));
}

/** One sentence, full bleed on navy. The slide a presenter stops talking on. */
function quoteSlide(spec, section, meta, pageLabel, fonts) {
  const shapes = [
    rect({ x: M.left, y: M.top + 0.3, w: 0.7, h: 0.07 }, solid(COLOR.signalGreen)),
    // Sized to fill: a short line gets the big treatment, a long one steps
    // down until it fits. One line at a fixed 44pt left two thirds of a navy
    // slide empty and read as an unfinished slide rather than a deliberate one.
    (() => {
      const w = CONTENT_WIDTH * 0.9;
      const size = [72, 60, 52, 44, 36].find(
        (pt) => heightOf(section.line, fonts.display, pt, w, 1.14, -0.03) <= 3.4,
      ) || 36;
      const h = heightOf(section.line, fonts.display, size, w, 1.14, -0.03);
      return text({ x: M.left, y: M.top + 0.9, w, h }, [
        { text: section.line, role: 'display', size, tracking: -0.03, lineHeight: 1.14, color: ON_NAVY.strong },
      ]);
    })(),
  ];

  if (section.body) {
    shapes.push(
      text({ x: M.left, y: M.top + 4.2, w: CONTENT_WIDTH * 0.7, h: 0.6 }, [
        { text: section.body, role: 'body', size: SIZE.body, lineHeight: 1.4, color: ON_NAVY.body },
      ]),
    );
  }

  return slideXml(settle(shapes) + footer(spec, true, pageLabel), bg(COLOR.deepNavy));
}

// --- §4.3 component layouts ------------------------------------------------
//
// Each of these is assembled from components.js rather than drawing its own
// rectangles. "Reuse, do not invent" is the section heading, and a stat tile
// built twice is a stat tile that looks different on two slides of one deck.

function tilesSlide(spec, section, meta, pageLabel, fonts) {
  const head = drawnHead(section.title, fonts);
  const shapes = [...head.shapes];
  const y = head.nextY + 0.15;

  const n = section.tiles.length;
  const gap = 0.28;
  const w = (CONTENT_WIDTH - gap * (n - 1)) / n;

  section.tiles.forEach((tile, i) => {
    shapes.push(comp.statTile({ x: M.left + i * (w + gap), y, w, h: 1.72 }, tile));
  });

  return slideXml(settle(shapes) + footer(spec, false, pageLabel), bg(COLOR.cream));
}

function tableSlide(spec, section, meta, pageLabel, fonts) {
  const head = drawnHead(section.title, fonts);
  const shapes = [...head.shapes];
  let y = head.nextY + 0.1;

  shapes.push(comp.tableHeader(M.left, y, CONTENT_WIDTH, section.columns));
  y += 0.36;

  for (const row of section.rows) {
    shapes.push(comp.tableRow(M.left, y, CONTENT_WIDTH, row));
    y += comp.TABLE_ROW_HEIGHT + 0.12;
  }

  return slideXml(settle(shapes) + footer(spec, false, pageLabel), bg(COLOR.cream));
}

/**
 * §1.3: a metric code in a pill, its target beside it. `metric: target`, never
 * prose — the format is the doctrine, because a target written as a sentence
 * is a target nobody can hold anyone to.
 */
function kpiSlide(spec, section, meta, pageLabel, fonts) {
  const head = drawnHead(section.title, fonts);
  const shapes = [...head.shapes];
  let y = head.nextY + 0.12;

  for (const { code, target } of section.kpis) {
    shapes.push(comp.metricPill(M.left, y, code));
    shapes.push(
      comp.label({ x: M.left + 1.24, y: y + 0.06, w: CONTENT_WIDTH - 1.24, h: 0.32 }, target, {
        size: 12,
        color: INK.strong,
        lineHeight: 1.2,
      }),
    );
    y += 0.56;
  }

  return slideXml(settle(shapes) + footer(spec, false, pageLabel), bg(COLOR.cream));
}

function outcomeSlide(spec, section, meta, pageLabel, fonts) {
  const head = drawnHead(section.title, fonts);
  const shapes = [...head.shapes];

  // §4.4: at most one filled accent band per slide. It is the focal point, so
  // nothing else on this slide competes with it.
  shapes.push(comp.outcomeBand(M.left, head.nextY + 0.3, CONTENT_WIDTH, section));

  return slideXml(settle(shapes) + footer(spec, false, pageLabel), bg(COLOR.cream));
}

function paradigmSlide(spec, section, meta, pageLabel, fonts) {
  const head = drawnHead(section.title, fonts);
  const shapes = [...head.shapes];
  shapes.push(comp.paradigmStrip(M.left, head.nextY + 0.3, CONTENT_WIDTH, section));
  return slideXml(settle(shapes) + footer(spec, false, pageLabel), bg(COLOR.cream));
}

function flowSlide(spec, section, meta, pageLabel, fonts) {
  const head = drawnHead(section.title, fonts);
  const shapes = [...head.shapes];
  shapes.push(comp.flow(M.left, head.nextY + 0.35, CONTENT_WIDTH, section.steps, { emphasis: section.emphasis }));
  return slideXml(settle(shapes) + footer(spec, false, pageLabel), bg(COLOR.cream));
}

const DRAWN = {
  stat: statSlide,
  tiles: tilesSlide,
  table: tableSlide,
  kpi: kpiSlide,
  outcome: outcomeSlide,
  paradigm: paradigmSlide,
  flow: flowSlide,
  bars: barsSlide,
  chain: chainSlide,
  timeline: timelineSlide,
  split: splitSlide,
  quote: quoteSlide,
};

/**
 * The band a slide's content has to live inside.
 *
 * Everything above the footer and below the top margin. Composing past it does
 * not clip — PowerPoint and LibreOffice both render the overflow — so a slide
 * with one bullet too many puts that bullet through the footer and off the
 * bottom of the screen. Which is what shipped: four slides of a twelve-slide
 * deck, text colliding with the disclosure line.
 */
const BODY_BAND = SLIDE.heightIn - M.top - M.bottom - 0.55;

/**
 * Type sizes to try, largest first.
 *
 * Shrinking is the first answer because it costs nothing a reader notices at
 * 15pt; dropping content is the last, because a rep asked for those words.
 */
const FIT_STEPS = [1, 0.94, 0.88, 0.82, 0.76, 0.7];

function contentSlide(spec, section, meta, pageLabel, fonts) {
  const width = CONTENT_WIDTH * 0.88;

  /** Lay the slide out at a given type scale, with a given number of points. */
  const compose = (scale, points) => {
    const titleSize = Math.round(SIZE.slideTitle * Math.max(scale, 0.78));
    const bodySize = Math.round(SIZE.body * scale);
    const shapes = [rect({ x: M.left, y: M.top + 0.02, w: 0.55, h: 0.055 }, solid(COLOR.signalGreen))];

    let y = M.top + 0.32;

    if (section.eyebrow) {
      shapes.push(
        text({ x: M.left, y, w: CONTENT_WIDTH, h: 0.28 }, [
          { text: eyebrowCase(section.eyebrow), role: 'eyebrow', size: SIZE.eyebrow, tracking: 0.12, lineHeight: 1, color: COLOR.circuitTeal },
        ]),
      );
      y += 0.42;
    }

    if (section.title) {
      const h = heightOf(section.title, fonts.display, titleSize, width, 1.1, -0.03);
      shapes.push(
        text({ x: M.left, y, w: width, h }, [
          { text: section.title, role: 'display', size: titleSize, tracking: -0.03, lineHeight: 1.1, color: COLOR.navy },
        ]),
      );
      y += h + 0.3 * scale;
    }

    if (section.body) {
      const h = heightOf(section.body, fonts.body, bodySize, width * 0.98, 1.5);
      shapes.push(
        text({ x: M.left, y, w: width * 0.98, h }, [
          { text: section.body, role: 'body', size: bodySize, lineHeight: 1.5, color: INK.body },
        ]),
      );
      y += h + 0.34 * scale;
    }

    if (points.length) {
      // Bullets are indented, so they wrap in a narrower column than body copy.
      const pointWidth = width * 0.98 - 0.25;
      const lead = 10 * scale;
      const gap = lead / 72;

      const height = points.reduce(
        (n, p) => n + heightOf(p, fonts.body, bodySize, pointWidth, 1.45) + gap,
        0,
      );

      shapes.push(
        text(
          { x: M.left, y, w: width * 0.98, h: height },
          points.map((p, i) => ({
            text: p,
            role: 'body',
            size: bodySize,
            lineHeight: 1.45,
            color: INK.strong,
            bullet: true,
            spaceBefore: i === 0 ? 0 : lead,
          })),
        ),
      );
      y += height;
    }

    return { shapes, height: y - M.top };
  };

  // Shrink first. Shrinking absorbs even the worst a section is ALLOWED to be
  // — every field at its cap — so the drop below never runs today, and is
  // kept as the guard for the day somebody raises LIMITS.points. When it does
  // run, the LAST point goes rather than the first: a slide's opening bullet
  // is the one it was written around. A test holds the worst legal case, and
  // fails here rather than in a deck a rep has already sent.
  let laid = null;
  let points = section.points;

  for (const scale of FIT_STEPS) {
    laid = compose(scale, points);
    if (laid.height <= BODY_BAND) break;
  }

  while (laid.height > BODY_BAND && points.length > 1) {
    points = points.slice(0, -1);
    laid = compose(FIT_STEPS[FIT_STEPS.length - 1], points);
  }

  return slideXml(settle(laid.shapes) + footer(spec, false, pageLabel), bg(COLOR.cream));
}

function closingSlide(spec, meta) {
  const shapes = [
    rect({ x: 0, y: 0, w: SLIDE.widthIn, h: 0.22 }, gradientFill()),
    wordmark(M.left, 1.5, true),

    text({ x: M.left, y: 2.9, w: CONTENT_WIDTH * 0.8, h: 1.2 }, [
      { text: TAGLINE, role: 'display', size: SIZE.sectionTitle, tracking: -0.03, lineHeight: 1.1, color: ON_NAVY.strong },
    ]),

    text({ x: M.left, y: 4.4, w: CONTENT_WIDTH * 0.7, h: 0.9 }, [
      { text: meta.preparedBy, role: 'body', size: SIZE.body, lineHeight: 1.5, color: ON_NAVY.body },
      { text: copyrightLine(meta.year), role: 'body', size: SIZE.footer, lineHeight: 1.5, color: ON_NAVY.muted, spaceBefore: 8 },
    ]),

    footer(spec, true, meta.date),
  ];

  return slideXml(shapes.join(''), bg(COLOR.deepNavy));
}

// --- Entry point ----------------------------------------------------------

/**
 * Render a spec as a .pptx.
 *
 * @param {object} spec  A spec already through normaliseSpec().
 * @param {{ preparedBy: string, isoDate: string }} meta
 * @param {{ display: import('./measure.js').FontMetrics, body: import('./measure.js').FontMetrics }} fonts
 *        Metrics only — PowerPoint resolves the typefaces by name. These are
 *        what let the layout know how tall a block will be before placing the
 *        next one.
 * @returns {Uint8Array}
 */
export function renderPptx(spec, meta, fonts) {
  shapeId = 1;

  const date = meta.isoDate.slice(0, 10);
  const year = Number(date.slice(0, 4));
  const context = { date, year, preparedBy: `Prepared by ${meta.preparedBy}` };

  const slides = [
    coverSlide(spec, context, fonts),
    ...spec.sections.map((s, i) => {
      const label = `${i + 2} / ${spec.sections.length + 2}`;
      const draw = s.layout && DRAWN[s.layout];
      return draw ? draw(spec, s, context, label, fonts) : contentSlide(spec, s, context, label, fonts);
    }),
    closingSlide(spec, context),
  ];

  /** @type {Record<string, Uint8Array>} */
  const files = {
    '[Content_Types].xml': strToU8(part.contentTypes(slides.length)),
    '_rels/.rels': strToU8(part.rootRels),
    'docProps/core.xml': strToU8(
      part.coreProps({ title: spec.title, author: meta.preparedBy, created: meta.isoDate }),
    ),
    'docProps/app.xml': strToU8(part.appProps(slides.length)),
    'ppt/presentation.xml': strToU8(part.presentation(slides.length)),
    'ppt/_rels/presentation.xml.rels': strToU8(part.presentationRels(slides.length)),
    'ppt/theme/theme1.xml': strToU8(part.theme),
    'ppt/slideMasters/slideMaster1.xml': strToU8(part.slideMaster),
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': strToU8(part.slideMasterRels),
    'ppt/slideLayouts/slideLayout1.xml': strToU8(part.slideLayout),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': strToU8(part.slideLayoutRels),
  };

  slides.forEach((s, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(s);
    files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = strToU8(part.slideRels);
  });

  // The zip's mtime is the document's own creation time, so the same spec
  // rendered twice produces the same bytes — which is what makes the renderer
  // testable. ZIP cannot represent a date outside 1980-2099, and an unopenable
  // deck is a worse outcome than a wrong timestamp, so fall back rather than
  // throw.
  const stamp = new Date(meta.isoDate);
  const stampYear = stamp.getUTCFullYear();
  const mtime = stampYear >= 1980 && stampYear <= 2099 ? stamp : new Date('2020-01-01T00:00:00Z');

  return zipSync(files, { level: 6, mtime });
}
