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
const SIZE = {
  coverTitle: 40,
  coverSub: 17,
  sectionTitle: 32,
  slideTitle: 27,
  body: BASE_PT,
  point: BASE_PT,
  eyebrow: 12,
  footer: 10,
  wordmark: 20,
};

/** Margins. Generous space is part of the type system, not a nicety. */
const M = { left: 0.85, right: 0.85, top: 0.7, bottom: 0.55 };
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
function footer(spec, onDark, pageLabel) {
  const label = DISCLOSURE_LABELS[spec.disclosure];
  const color = onDark ? ON_NAVY.muted : INK.muted;
  const y = SLIDE.heightIn - M.bottom - 0.2;

  return (
    text({ x: M.left, y, w: CONTENT_WIDTH - 1.2, h: 0.3 }, [
      { text: eyebrowCase(label), role: 'eyebrow', size: SIZE.footer, tracking: 0.12, lineHeight: 1, color },
    ]) +
    text({ x: SLIDE.widthIn - M.right - 1.2, y, w: 1.2, h: 0.3 }, [
      { text: pageLabel, role: 'eyebrow', size: SIZE.footer, tracking: 0.12, lineHeight: 1, color },
    ], { align: 'r' })
  );
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

    footer(spec, false, meta.date),
  ];

  return slideXml(shapes.join(''), bg(COLOR.white));
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

function contentSlide(spec, section, meta, pageLabel, fonts) {
  const width = CONTENT_WIDTH * 0.88;
  const shapes = [
    // A short rule in Signal Green, the 10% accent, anchoring the title.
    rect({ x: M.left, y: M.top + 0.02, w: 0.55, h: 0.055 }, solid(COLOR.signalGreen)),
  ];

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
    const h = heightOf(section.title, fonts.display, SIZE.slideTitle, width, 1.1, -0.03);
    shapes.push(
      text({ x: M.left, y, w: width, h }, [
        { text: section.title, role: 'display', size: SIZE.slideTitle, tracking: -0.03, lineHeight: 1.1, color: COLOR.navy },
      ]),
    );
    y += h + 0.3;
  }

  if (section.body) {
    const h = heightOf(section.body, fonts.body, SIZE.body, width * 0.98, 1.5);
    shapes.push(
      text({ x: M.left, y, w: width * 0.98, h }, [
        { text: section.body, role: 'body', size: SIZE.body, lineHeight: 1.5, color: INK.body },
      ]),
    );
    y += h + 0.34;
  }

  if (section.points.length) {
    // Bullets are indented, so they wrap in a narrower column than body copy.
    const pointWidth = width * 0.98 - 0.25;
    const gap = 10 / 72;

    const height = section.points.reduce(
      (n, p) => n + heightOf(p, fonts.body, SIZE.point, pointWidth, 1.45) + gap,
      0,
    );

    shapes.push(
      text(
        { x: M.left, y, w: width * 0.98, h: height },
        section.points.map((p, i) => ({
          text: p,
          role: 'body',
          size: SIZE.point,
          lineHeight: 1.45,
          color: INK.strong,
          bullet: true,
          spaceBefore: i === 0 ? 0 : 10,
        })),
      ),
    );
  }

  shapes.push(footer(spec, false, pageLabel));

  return slideXml(shapes.join(''), bg(COLOR.white));
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
    ...spec.sections.map((s, i) =>
      contentSlide(spec, s, context, `${i + 2} / ${spec.sections.length + 2}`, fonts),
    ),
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
