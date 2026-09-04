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
import {
  GEOMETRY, FLOORS, FINE_PRINT, DATA_NOTE, PATENTS_PENDING, WORDMARK_TAG,
  POSITIONING_LINE, DECK_TAGLINE, WHO_WE_ARE, DARK, SUITE, DENSITY,
  carriesModeledFigure,
} from './house.js';
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
  // §3.3 says navy dominant, and evenly spaced stops are not: green through
  // teal at the halfway mark leaves navy holding a third of the slide and the
  // cover reads green. The stops are weighted so navy owns the back half.
  const STOP_POSITIONS = [0, 34000, 72000];

  const stops = GRADIENT.stops
    .map((c, i) => {
      const pos = STOP_POSITIONS[i] ?? Math.round((i / (GRADIENT.stops.length - 1)) * 100000);
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

      // §2.3: bullets are carried by small coloured dots. The ban is on the
      // • character being typed into the copy at a line start — a real
      // bullet, sized down and set in the accent, is what the rule asks for,
      // and it was rendering navy at full size, which is the version that
      // reads as a typed character.
      const bullet = r.bullet
        ? `<a:buClr><a:srgbClr val="${hex(r.bulletColor || COLOR.circuitTeal)}"/></a:buClr>` +
          `<a:buSzPct val="72000"/><a:buFont typeface="Arial"/><a:buChar char="•"/>`
        : '<a:buNone/>';
      const indent = r.bullet ? ' marL="228600" indent="-228600"' : '';

      return `<a:p><a:pPr algn="${align}"${indent}><a:lnSpc><a:spcPct val="${lineSpacing}"/></a:lnSpc>${before}${bullet}</a:pPr>` +
        `<a:r><a:rPr lang="en-US" sz="${pt(size)}" b="${font.weight >= 700 ? 1 : 0}"${r.italic ? ' i="1"' : ''} spc="${spacing}" dirty="0">` +
        `${solid(r.color)}<a:latin typeface="${font.family}"/><a:cs typeface="${font.family}"/></a:rPr>` +
        `<a:t>${body}</a:t></a:r></a:p>`;
    })
    .join('');

  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="t${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm>${frame(box)}</a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>
<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}

/**
 * Several runs on ONE line, in different colours.
 *
 * text() gives every run its own paragraph, which is right for a stack of
 * lines and wrong for a two tone wordmark: §2.3 wants "Sec" in ink and
 * "Semantic" in the suite accent, side by side, as one word. Two text boxes
 * cannot do that without hard-coding the width of the first.
 */
function inlineText(box, runs, { align = 'l', anchor = 't' } = {}) {
  const id = nextId();

  const body = runs
    .filter((r) => r.text)
    .map((r) => {
      const font = FONT[r.role] || FONT.body;
      const spacing = track(r.tracking ?? 0, r.size);
      return (
        `<a:r><a:rPr lang="en-US" sz="${pt(r.size)}" b="${font.weight >= 700 ? 1 : 0}"` +
        `${r.italic ? ' i="1"' : ''} spc="${spacing}" dirty="0">${solid(r.color)}` +
        `<a:latin typeface="${font.family}"/><a:cs typeface="${font.family}"/></a:rPr>` +
        `<a:t>${xml(r.text)}</a:t></a:r>`
      );
    })
    .join('');

  const lineSpacing = Math.round((runs[0]?.lineHeight ?? 1.2) * 100000);

  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="t${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm>${frame(box)}</a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>
<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}"><a:noAutofit/></a:bodyPr><a:lstStyle/>` +
    `<a:p><a:pPr algn="${align}"><a:lnSpc><a:spcPct val="${lineSpacing}"/></a:lnSpc><a:buNone/></a:pPr>${body}</a:p></p:txBody></p:sp>`;
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
function footer(spec, onDark, pageLabel, tag = WORDMARK_TAG) {
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
    // §3.2's wordmark tag, right aligned, left of the page number. It was
    // missing entirely: the section lists three things on the bottom of every
    // slide and the renderer drew two of them.
    text({ x: 9.3, y: GEOMETRY.tag.y, w: 2.5, h: 0.3 }, [
      { text: tag, role: 'eyebrow', size: GEOMETRY.tag.size, tracking: 0.12, lineHeight: 1, color },
    ], { align: 'r' }) +
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

/**
 * The cover, to §3.4: gradient, logo, tagline, suite wordmarks.
 *
 * It is a real gradient ground rather than the thin band this used to draw.
 * §3.3 allows the brand gradient on exactly two slides, the cover and the
 * thank you, and using a tenth of the allowance on both was a way of obeying
 * the letter of a rule whose point is that the two ends of a deck look
 * different from its middle.
 *
 * The suite wordmarks sit on white tiles. That is §4.3's rule for marks, and
 * it is also the only way the third one works here: the instruction set gives
 * ProSemantic a light accent and no dark variant, so amber on navy would be
 * either illegible or off palette, and there is no third option that keeps
 * both.
 */
function coverSlide(spec, meta, fonts) {
  const titleWidth = CONTENT_WIDTH * 0.78;

  // A long title steps down a size rather than wrapping to four lines. Chosen
  // by measuring, so the step happens when the text actually overflows two
  // lines and not at an arbitrary character count.
  const titleSize = [SIZE.coverTitle, SIZE.coverTitle - 6, SIZE.coverTitle - 11].find(
    (size) => wrap(spec.title, fonts.display, size, titleWidth * 72, -0.03).length <= 2,
  ) || SIZE.coverTitle - 11;

  const titleHeight = heightOf(spec.title, fonts.display, titleSize, titleWidth, 1.06, -0.03);
  const coverTitleTop = 2.5;

  const shapes = [
    rect({ x: 0, y: 0, w: SLIDE.widthIn, h: SLIDE.heightIn }, gradientFill()),
    wordmark(M.left, 0.8, true),

    text({ x: M.left, y: 1.62, w: CONTENT_WIDTH, h: 0.3 }, [
      {
        text: eyebrowCase(spec.audience ? `Prepared for ${spec.audience}` : meta.date),
        role: 'eyebrow',
        size: SIZE.eyebrow,
        tracking: 0.12,
        lineHeight: 1,
        // §4.1 gives SecSemantic a light variant for dark grounds. 14736D is
        // the LIGHT-theme accent and disappears into the teal end of the
        // gradient — which is exactly what it did.
        color: COLOR.paleTeal,
      },
    ]),

    text({ x: M.left, y: coverTitleTop, w: titleWidth, h: titleHeight }, [
      {
        text: spec.title,
        role: 'display',
        size: titleSize,
        tracking: -0.03,
        lineHeight: 1.06,
        color: ON_NAVY.strong,
      },
    ]),

    spec.subtitle
      ? text({ x: M.left, y: coverTitleTop + titleHeight + 0.34, w: CONTENT_WIDTH * 0.66, h: 0.7 }, [
          { text: spec.subtitle, role: 'body', size: SIZE.coverSub, lineHeight: 1.45, color: ON_NAVY.body },
        ])
      : '',

    // §1.2: the cover carries the positioning line plus the tagline. Locked
    // copy, both of them, so they are constants rather than something a deck
    // gets to paraphrase.
    inlineText(
      { x: M.left, y: coverTitleTop + titleHeight + (spec.subtitle ? 1.06 : 0.34), w: CONTENT_WIDTH * 0.8, h: 0.34 },
      [
        { text: `${POSITIONING_LINE} `, role: 'body', size: SIZE.coverSub, lineHeight: 1.3, color: ON_NAVY.body },
        { text: DECK_TAGLINE, role: 'heading', size: SIZE.coverSub, lineHeight: 1.3, color: COLOR.paleTeal },
      ],
    ),
  ];

  // The gradient ground and the furniture that hangs off the slide edges are
  // placed, not settled: they have no business drifting toward the middle.
  const [ground, ...block] = shapes;
  return (
    slideXml(
      ground +
        comp.waveMotif(M.left, 5.66, CONTENT_WIDTH, 0.4, { onDark: true }) +
        comp.suiteWordmarks(M.left, 6.24, CONTENT_WIDTH * 0.52, { onDark: true }) +
        settle(block, 2.2) +
        footer(spec, true, meta.date),
      bg(COLOR.deepNavy),
    )
  );
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
function drawnHead(section, fonts) {
  const { eyebrow, title } = section;
  const shapes = [rect({ x: M.left, y: M.top + 0.02, w: 0.55, h: 0.055 }, solid(COLOR.signalGreen))];

  // §3.1: eyebrow at y 0.38, mono bold, tracked. §3.5 makes it part of what a
  // slide needs to stand on its own — the drawn layouts had no way to carry
  // one at all, so every chart in every deck shipped without the line that
  // says which section it belongs to.
  let y = M.top + 0.32;
  if (eyebrow) {
    shapes.push(
      text({ x: M.left, y, w: CONTENT_WIDTH, h: 0.28 }, [
        { text: eyebrowCase(eyebrow), role: 'eyebrow', size: SIZE.eyebrow, tracking: 0.12, lineHeight: 1, color: COLOR.circuitTeal },
      ]),
    );
    y += 0.42;
  } else {
    y = M.top + 0.42;
  }

  if (title) {
    const h = heightOf(title, fonts.display, SIZE.slideTitle, CONTENT_WIDTH * 0.8, 1.15, -0.02) || 0.75;
    shapes.push(
      text({ x: M.left, y, w: CONTENT_WIDTH * 0.8, h }, [
        { text: title, role: 'display', size: SIZE.slideTitle, tracking: -0.02, lineHeight: 1.15, color: COLOR.navy },
      ]),
    );
    y += h + 0.18;
  }

  // §3.1's subtitle, and §3.5's "at least one line of supporting context".
  // A prose line written under a drawn heading used to go nowhere: the title
  // came off the pipes, the body was parsed, and no drawn layout rendered it.
  // The rep saw a sentence in their own request and not on the slide.
  if (section.body) {
    const h = heightOf(section.body, fonts.body, GEOMETRY.subtitle.size, CONTENT_WIDTH * 0.72, 1.4);
    shapes.push(
      text({ x: M.left, y, w: CONTENT_WIDTH * 0.72, h }, [
        { text: section.body, role: 'body', size: GEOMETRY.subtitle.size, lineHeight: 1.4, color: INK.body },
      ]),
    );
    y += h + 0.1;
  }

  return { shapes, nextY: y + (title || section.body ? 0.27 : 0.13) };
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
  let top = M.top + 0.55;

  if (section.eyebrow) {
    shapes.push(
      text({ x: M.left, y: M.top + 0.32, w: CONTENT_WIDTH, h: 0.28 }, [
        { text: eyebrowCase(section.eyebrow), role: 'eyebrow', size: SIZE.eyebrow, tracking: 0.12, lineHeight: 1, color: COLOR.circuitTeal },
      ]),
    );
    top = M.top + 0.86;
  }

  shapes.push(
    text({ x: M.left, y: top, w: CONTENT_WIDTH, h: 2.1 }, [
      { text: section.value, role: 'display', size: 96, tracking: -0.04, lineHeight: 1, color: COLOR.navy },
    ]),
  );

  // The number's box is 2.1 tall, so everything under it moves by exactly the
  // height the eyebrow took. Leaving these fixed put the caption through the
  // bottom of the digits.
  const drop = top - (M.top + 0.55);

  if (section.caption) {
    shapes.push(
      text({ x: M.left, y: M.top + 2.75 + drop, w: CONTENT_WIDTH * 0.7, h: 1.1 }, [
        { text: section.caption, role: 'display', size: SIZE.slideTitle, tracking: -0.02, lineHeight: 1.2, color: COLOR.circuitTeal },
      ]),
    );
  }

  if (section.body) shapes.push(captionAt(section.body, M.top + 3.95 + drop, CONTENT_WIDTH * 0.8));

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
  const head = drawnHead(section, fonts);
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
  const head = drawnHead(section, fonts);
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
  const head = drawnHead(section, fonts);
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
  const head = drawnHead(section, fonts);
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
  const head = drawnHead(section, fonts);
  const shapes = [...head.shapes];
  const y = head.nextY + 0.15;

  const n = section.tiles.length;
  const gap = 0.28;
  const w = (CONTENT_WIDTH - gap * (n - 1)) / n;

  // A fixed tile height left three quarters of an inch of white under the
  // longest caption and twice that under the shortest. The tallest caption
  // sets the height and all of them share it, so the row still lines up.
  const captionHeight = Math.max(
    ...section.tiles.map((t) => heightOf(t.caption, fonts.body, 9, w - 0.44, 1.35)),
  );
  const h = Math.max(1.16, 0.78 + captionHeight + 0.24);

  section.tiles.forEach((tile, i) => {
    shapes.push(comp.statTile({ x: M.left + i * (w + gap), y, w, h }, tile));
  });

  return slideXml(settle(shapes) + footer(spec, false, pageLabel), bg(COLOR.cream));
}

function tableSlide(spec, section, meta, pageLabel, fonts) {
  const head = drawnHead(section, fonts);
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
  const head = drawnHead(section, fonts);
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
  // asText() hands the band's sentence to pdf.js as the section body, which is
  // right there and wrong here: drawing it as a subtitle as well printed the
  // sentence twice on one slide, once in grey and once in the band under it.
  const head = drawnHead({ ...section, body: '' }, fonts);
  const shapes = [...head.shapes];

  // §4.4: at most one filled accent band per slide. It is the focal point, so
  // nothing else on this slide competes with it.
  shapes.push(comp.outcomeBand(M.left, head.nextY + 0.3, CONTENT_WIDTH, section));

  return slideXml(settle(shapes) + footer(spec, false, pageLabel), bg(COLOR.cream));
}

function paradigmSlide(spec, section, meta, pageLabel, fonts) {
  const head = drawnHead(section, fonts);
  const shapes = [...head.shapes];
  shapes.push(comp.paradigmStrip(M.left, head.nextY + 0.3, CONTENT_WIDTH, section));
  return slideXml(settle(shapes) + footer(spec, false, pageLabel), bg(COLOR.cream));
}

function flowSlide(spec, section, meta, pageLabel, fonts) {
  const head = drawnHead(section, fonts);
  const shapes = [...head.shapes];
  shapes.push(comp.flow(M.left, head.nextY + 0.35, CONTENT_WIDTH, section.steps, { emphasis: section.emphasis }));
  return slideXml(settle(shapes) + footer(spec, false, pageLabel), bg(COLOR.cream));
}

/**
 * §3.3's suite deep dive: the one slide licensed off the cream ground.
 *
 * "Dark navy slides are reserved for suite deep dives (detail and impact)" is
 * a reservation, not a permission, so this is the only layout that renders on
 * navy apart from the cover and the thank you — and it earns it by being the
 * slide where the detail actually lives.
 *
 * drawnHead() is not reused: it paints navy on cream, which on this ground is
 * a hole rather than a heading.
 */
function suiteSlide(spec, section, meta, pageLabel, fonts) {
  const key = section.suite.toLowerCase().startsWith('dev') ? 'dev' : 'sec';
  const accent = SUITE[key].darkAlt;
  const tag = `VIKAT  ${section.suite.toUpperCase()}`;

  const shapes = [rect({ x: M.left, y: M.top + 0.02, w: 0.55, h: 0.055 }, solid(accent))];
  let y = M.top + 0.32;

  if (section.eyebrow) {
    shapes.push(
      text({ x: M.left, y, w: CONTENT_WIDTH, h: 0.28 }, [
        { text: eyebrowCase(section.eyebrow), role: 'eyebrow', size: SIZE.eyebrow, tracking: 0.12, lineHeight: 1, color: accent },
      ]),
    );
    y += 0.42;
  } else {
    y = M.top + 0.42;
  }

  // §2.3: the wordmark is two tone wherever it appears, prefix in the ground's
  // text colour and "Semantic" in the accent.
  shapes.push(
    inlineText({ x: M.left, y, w: CONTENT_WIDTH * 0.8, h: 0.5 }, [
      { text: section.suite.replace(/Semantic$/, ''), role: 'display', size: SIZE.slideTitle, tracking: -0.02, lineHeight: 1.15, color: DARK.text },
      { text: 'Semantic', role: 'display', size: SIZE.slideTitle, tracking: -0.02, lineHeight: 1.15, color: accent },
    ]),
  );
  y += 0.58;

  if (section.title) {
    const h = heightOf(section.title, fonts.body, GEOMETRY.subtitle.size, CONTENT_WIDTH * 0.72, 1.4);
    shapes.push(
      text({ x: M.left, y, w: CONTENT_WIDTH * 0.72, h }, [
        { text: section.title, role: 'body', size: GEOMETRY.subtitle.size, lineHeight: 1.4, color: DARK.body },
      ]),
    );
    y += h + 0.1;
  }

  if (section.body) {
    const h = heightOf(section.body, fonts.body, GEOMETRY.subtitle.size, CONTENT_WIDTH * 0.72, 1.4);
    shapes.push(
      text({ x: M.left, y, w: CONTENT_WIDTH * 0.72, h }, [
        { text: section.body, role: 'body', size: GEOMETRY.subtitle.size, lineHeight: 1.4, color: DARK.muted },
      ]),
    );
    y += h + 0.1;
  }

  y += 0.3;

  // Three across at most, per §1.5, wrapping to a second row rather than
  // narrowing to a fourth column.
  const columns = Math.min(DENSITY.columns, section.cards.length);
  const gap = 0.26;
  const w = (CONTENT_WIDTH - gap * (columns - 1)) / columns;
  const cardHeight = Math.max(
    1.14,
    0.86 + Math.max(...section.cards.map((c) => heightOf(c.body, fonts.body, 9.5, w - 0.48, 1.35))),
  );

  section.cards.forEach((card, i) => {
    shapes.push(
      comp.darkKpiCard(
        {
          x: M.left + (i % columns) * (w + gap),
          y: y + Math.floor(i / columns) * (cardHeight + gap),
          w,
          h: cardHeight,
        },
        card,
      ),
    );
  });

  return slideXml(settle(shapes) + footer(spec, true, pageLabel, tag), bg(DARK.bg));
}

/**
 * §4.3's logo tiles: uniform white rounded tiles, never raw on the ground.
 *
 * Names rather than marks, because there are no logo assets here and a
 * redrawn logo is a trademark somebody has to defend. Nothing in the renderer
 * can check that a name belongs to a real customer; that is the model's rule
 * and the rep's review, and both are told so.
 */
function logosSlide(spec, section, meta, pageLabel, fonts) {
  const head = drawnHead(section, fonts);
  const shapes = [...head.shapes];

  const columns = Math.min(3, section.names.length);
  const gap = 0.26;
  const w = (CONTENT_WIDTH - gap * (columns - 1)) / columns;
  const h = 0.92;

  section.names.forEach((name, i) => {
    shapes.push(
      comp.logoTile({
        x: M.left + (i % columns) * (w + gap),
        y: head.nextY + 0.15 + Math.floor(i / columns) * (h + gap),
        w,
        h,
      }, name),
    );
  });

  return slideXml(settle(shapes) + footer(spec, false, pageLabel), bg(COLOR.cream));
}

const DRAWN = {
  stat: statSlide,
  suite: suiteSlide,
  logos: logosSlide,
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

/**
 * The thank you, to §3.4: the full disclaimer block.
 *
 * Trademarks, patents pending, the modeled data disclaimer, confidentiality.
 * All four, on the last slide, because this is the one a rep forwards on its
 * own more often than any other and the four things it must carry are the
 * four things nobody puts back by hand.
 */
function closingSlide(spec, meta) {
  const shapes = [
    rect({ x: 0, y: 0, w: SLIDE.widthIn, h: SLIDE.heightIn }, gradientFill()),
    wordmark(M.left, 1.3, true),

    text({ x: M.left, y: 2.5, w: CONTENT_WIDTH * 0.8, h: 1.0 }, [
      { text: DECK_TAGLINE, role: 'display', size: SIZE.sectionTitle, tracking: -0.03, lineHeight: 1.1, color: ON_NAVY.strong },
    ]),

    text({ x: M.left, y: 3.62, w: CONTENT_WIDTH * 0.62, h: 0.5 }, [
      { text: POSITIONING_LINE, role: 'body', size: SIZE.coverSub, lineHeight: 1.4, color: ON_NAVY.body },
    ]),

    text({ x: M.left, y: 4.34, w: CONTENT_WIDTH * 0.7, h: 0.4 }, [
      { text: meta.preparedBy, role: 'body', size: SIZE.body, lineHeight: 1.4, color: ON_NAVY.body },
    ]),

    // The disclaimer block. Set small and italic, the way a legal line is set,
    // so it is present and readable without competing with the tagline.
    text({ x: M.left, y: 4.96, w: CONTENT_WIDTH * 0.74, h: 1.0 }, [
      { text: PATENTS_PENDING, role: 'body', size: FLOORS.label, lineHeight: 1.45, color: ON_NAVY.muted, italic: true },
      { text: DATA_NOTE, role: 'body', size: FLOORS.label, lineHeight: 1.45, color: ON_NAVY.muted, italic: true, spaceBefore: 5 },
    ]),

    comp.waveMotif(M.left, 6.28, CONTENT_WIDTH, 0.34, { onDark: true }),

    footer(spec, true, meta.date),
  ];

  return slideXml(shapes.join(''), bg(COLOR.deepNavy));
}

/**
 * §1.2 step 5 and §3.4: the credentials close, before the thank you.
 *
 * Every line on it is approved standing copy from the instruction set. That
 * is the point: a slide about who we are is precisely where an invented
 * capability, a client name, or a certification would go unnoticed, because
 * it is the one slide nobody fact-checks against a source. So nothing on it
 * is written fresh, here or by the model.
 */
function whoWeAreSlide(spec, meta, pageLabel, fonts) {
  return contentSlide(
    spec,
    { eyebrow: WHO_WE_ARE.eyebrow, title: WHO_WE_ARE.title, body: '', points: WHO_WE_ARE.points },
    meta,
    pageLabel,
    fonts,
  );
}

/** Does the deck already say who we are? Then the standing slide is redundant. */
const isCredentials = (section) =>
  /\bwho we are\b|\babout (us|vikat)\b|\bcredentials\b/i.test(String(section?.title || '') + ' ' + String(section?.eyebrow || ''));

/**
 * §1.4: a slide carrying a modeled figure carries the data note beside it.
 *
 * Added after the fact rather than by each layout, because the obligation is
 * on the figure and every layout can show one. A rule enforced in eleven
 * places is a rule the twelfth layout will not have.
 */
function withDataNote(slideMarkup) {
  const note = text(
    { x: M.left, y: GEOMETRY.finePrint.y - 0.54, w: SLIDE.widthIn - M.left - M.right - 1.6, h: 0.26 },
    [{ text: DATA_NOTE, role: 'body', size: FLOORS.label, lineHeight: 1.2, color: INK.muted, italic: true }],
  );
  return slideMarkup.replace('</p:spTree>', `${note}</p:spTree>`);
}

/** All the words a section will put on its slide, for the §1.4 check. */
const sectionText = (s) =>
  [s.title, s.body, s.tag, s.sentence, s.from, s.to, ...(s.points || []), ...(s.steps || []), ...(s.stops || [])]
    .filter(Boolean)
    .concat((s.tiles || []).map((t) => `${t.value} ${t.caption}`))
    .concat((s.kpis || []).map((k) => `${k.code} ${k.target}`))
    .concat((s.bars || []).map((b) => `${b.label} ${b.value}`))
    .concat((s.rows || []).flat())
    .join(' ');

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
  comp.resetIds();

  const date = meta.isoDate.slice(0, 10);
  const year = Number(date.slice(0, 4));
  const context = { date, year, preparedBy: `Prepared by ${meta.preparedBy}` };

  // §3.4 makes the credentials close a required slide, unless the deck
  // already has one of its own — two "who we are" slides is worse than none.
  const wantsWhoWeAre = spec.format === 'pptx' && !spec.sections.some(isCredentials);
  const total = spec.sections.length + 2 + (wantsWhoWeAre ? 1 : 0);

  const slides = [
    coverSlide(spec, context, fonts),
    ...spec.sections.map((s, i) => {
      const label = `${i + 2} / ${total}`;
      const draw = s.layout && DRAWN[s.layout];
      const built = draw ? draw(spec, s, context, label, fonts) : contentSlide(spec, s, context, label, fonts);
      return carriesModeledFigure(sectionText(s)) ? withDataNote(built) : built;
    }),
    ...(wantsWhoWeAre ? [whoWeAreSlide(spec, context, `${total - 1} / ${total}`, fonts)] : []),
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
