/**
 * inspect.js — look at the deck before handing it to a rep.
 *
 * The renderers have always been careful. Careful is not the same as checked,
 * and the difference showed: decks were shipping with the content huddled in
 * the top four-tenths of every slide and three different backgrounds in one
 * file, and nothing anywhere said so — not a test, not a warning, not the
 * answer the rep read. They found out by opening it in front of a customer.
 *
 * So the built file is re-opened and measured. Not rendered — a Worker cannot
 * rasterise a slide — but the geometry is all in the XML, and the failures
 * that matter are geometric: a slide with almost nothing on it, a shape past
 * the edge, a drawing with no words near it, a ground that does not match the
 * rest of the deck.
 *
 * Everything here reports. Nothing here rewrites: a deck that is 4% short of a
 * threshold is still a deck, and refusing it would leave the rep with nothing
 * five minutes before a call. The rep is told what is thin and decides.
 */

import { unzipSync, strFromU8 } from 'fflate';
import { SLIDE } from './ooxml.js';
import { checkCopy, FINE_PRINT } from './house.js';

const EMU = 914400;

/** Everything a slide's shapes occupy, in inches. */
function shapesOf(xml) {
  const out = [];
  const re = /<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    out.push({
      x: Number(m[1]) / EMU,
      y: Number(m[2]) / EMU,
      w: Number(m[3]) / EMU,
      h: Number(m[4]) / EMU,
    });
  }
  return out;
}

/** The slide's background fill, so a deck can be checked for one ground. */
function groundOf(xml) {
  const m = /<p:bg>.*?<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(xml);
  return m ? m[1].toUpperCase() : null;
}

/** Visible words on the slide — a:t runs, minus the furniture. */
function wordsOf(xml) {
  const runs = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]);
  return runs
    .map((r) => r.trim())
    .filter(Boolean)
    // The footer and page number are on every slide and prove nothing about
    // whether this one has anything to say.
    .filter((r) => !/^\d+\s*\/\s*\d+$/.test(r))
    .filter((r) => !/NOT FOR CUSTOMER DISTRIBUTION|CLEARED FOR EXTERNAL USE/i.test(r))
    .filter((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r));
}

/**
 * How much of the slide the content actually covers, 0–1.
 *
 * The union of the bounding boxes would need a sweep; the bounding box of the
 * union is enough to catch the failure that matters, which is a slide whose
 * content lives entirely in one corner.
 */
function coverage(boxes, ignoreFullBleed = true) {
  const real = boxes.filter((b) => {
    if (b.w <= 0 || b.h <= 0) return false;
    // A full-bleed band or background rect would report 100% coverage for a
    // slide that is otherwise empty.
    if (ignoreFullBleed && b.w >= SLIDE.widthIn - 0.01) return false;
    return true;
  });
  if (!real.length) return 0;

  const left = Math.min(...real.map((b) => b.x));
  const right = Math.max(...real.map((b) => b.x + b.w));
  const top = Math.min(...real.map((b) => b.y));
  const bottom = Math.max(...real.map((b) => b.y + b.h));

  return ((right - left) * (bottom - top)) / (SLIDE.widthIn * SLIDE.heightIn);
}

/**
 * Space above and below the content, ignoring full-bleed bands and the footer.
 *
 * The footer is anchored to the bottom on every slide, so it has to come out
 * or every slide looks perfectly balanced.
 */
function verticalGaps(boxes) {
  const real = boxes.filter(
    (b) => b.w > 0 && b.h > 0 && b.w < SLIDE.widthIn - 0.01 && b.y < SLIDE.heightIn - 1.0,
  );
  if (!real.length) return null;

  const top = Math.min(...real.map((b) => b.y));
  const bottom = Math.max(...real.map((b) => b.y + b.h));

  return { above: top, below: SLIDE.heightIn - 0.9 - bottom };
}

/**
 * Check a built .pptx and report what a rep would notice.
 *
 * @param {Uint8Array} bytes
 * @returns {{ slides: number, problems: string[], notes: string[] }}
 */
export function inspectPptx(bytes) {
  const problems = [];
  const notes = [];

  let files;
  try {
    files = unzipSync(bytes);
  } catch (err) {
    return { slides: 0, problems: [`The file did not open: ${err?.message || err}`], notes };
  }

  const slideNames = Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]));

  if (!slideNames.length) return { slides: 0, problems: ['The deck has no slides.'], notes };

  const grounds = new Map();
  const allCopy = [];

  slideNames.forEach((name, i) => {
    const n = i + 1;
    const xml = strFromU8(files[name]);
    const boxes = shapesOf(xml);
    const words = wordsOf(xml);
    allCopy.push(...words);

    const ground = groundOf(xml);
    if (ground) grounds.set(ground, (grounds.get(ground) || 0) + 1);

    // A slide with a rule and a drawing but no words is the one a presenter
    // has to explain from memory.
    if (words.length === 0) {
      problems.push(`Slide ${n} has no readable text on it.`);
    } else if (words.join(' ').length < 12) {
      notes.push(`Slide ${n} carries almost no words — check it says something on its own.`);
    }

    // Off the edge. A shape that starts inside and runs past the right margin
    // is invisible in the room and looks like a bug on the screen.
    for (const b of boxes) {
      if (b.x + b.w > SLIDE.widthIn + 0.02 || b.y + b.h > SLIDE.heightIn + 0.02) {
        problems.push(`Slide ${n} has content running off the edge.`);
        break;
      }
    }

    // 18% let a slide with one line of text on it through — a quote filling
    // an eighth of a navy slide measured 18.2% and passed.
    const covered = coverage(boxes);
    if (covered < 0.26) {
      notes.push(`Slide ${n} is sparse — its content fills about ${Math.round(covered * 100)}% of the slide.`);
    }

    // Top-heaviness, which is the failure area alone does not see. A block
    // spanning the full width but living in the top four-tenths covers plenty
    // of area and still reads as an unfinished slide with a hole under it —
    // and that was every slide of every deck this produced, unnoticed, until
    // somebody opened one.
    const gap = verticalGaps(boxes);
    if (gap && gap.below > 1.4 && gap.below > gap.above * 2.2) {
      notes.push(
        `Slide ${n} is top-heavy — about ${gap.below.toFixed(1)}" of empty space sits under the content.`,
      );
    }
  });

  // §3.2: the fine print is on EVERY slide, cover and thank you included.
  // Checked once for the deck rather than per slide, because a deck missing
  // it on one slide and a deck missing it on all of them are the same fix.
  const withFinePrint = slideNames.filter((name) =>
    strFromU8(files[name]).includes(FINE_PRINT.slice(0, 40)),
  ).length;
  if (withFinePrint < slideNames.length) {
    problems.push(
      `${slideNames.length - withFinePrint} slide(s) are missing the fine print, which the house style puts on every slide.`,
    );
  }

  // §2, checked against everything the deck actually says. The renderer
  // controls the furniture; these are the model's own words, and a rule the
  // model is merely asked to follow holds most of the time — which is how a
  // deck with an em dash in it reaches a customer.
  // Checked against EVERY run, furniture included, not the filtered set the
  // completeness checks use. "Does this slide say anything" has to ignore the
  // footer; "is there a dash anywhere in this file" must not — the disclosure
  // label had one, printed on every slide, and the filter hid it.
  const everything = slideNames
    .flatMap((name) => [...strFromU8(files[name]).matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]))
    .join(' ');
  const copy = checkCopy(everything);
  problems.push(...copy.problems);
  notes.push(...copy.notes);

  // One ground, plus at most one deliberate contrast — a full-bleed navy
  // quote earns its place. A third means the layouts disagree with each
  // other, which is exactly what shipped: white for prose, cream for drawn,
  // navy for a quote, in the same file.
  if (grounds.size > 2) {
    const used = [...grounds.keys()].join(', ');
    notes.push(
      `The deck uses ${grounds.size} different backgrounds (${used}), which reads as several decks stapled together.`,
    );
  }

  return { slides: slideNames.length, problems, notes };
}

/**
 * The line the rep reads, or empty when there is nothing worth saying.
 *
 * Deliberately plain and deliberately short: a wall of warnings on a good deck
 * teaches people to skip the warnings on a bad one.
 */
export function inspectionSummary({ problems, notes }) {
  if (problems.length) return `Check before sending — ${problems.join(' ')}`;
  if (notes.length) return notes.join(' ');
  return '';
}
