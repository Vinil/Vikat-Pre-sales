/**
 * house.js — the Vikat Presentation Agent instruction set, as code.
 *
 * Source: brand/PPT_Agent_Instructions.md, v1.0, September 2026. That document
 * is the authority; this file is its executable half, and a test asserts every
 * value below still appears in it. When the instructions change, the test
 * names what moved rather than the renderer quietly drifting.
 *
 * The split is deliberate. Sections 1 and 2 are doctrine — what a slide says,
 * and how it says it — and belong in the system prompt, because they have to
 * shape the words before they are written. Sections 3 to 5 are form and QA,
 * and belong here, because a rule the model is merely asked to follow is a
 * rule that holds most of the time, and "most of the time" is how a deck with
 * an em dash in it reaches a customer.
 *
 * §5 is explicit that a deck is rendered and inspected before it ships. A
 * Worker cannot rasterise a slide, so what can be checked from the XML is
 * checked from the XML, and what cannot is said plainly rather than implied.
 */

// --- §4.1 Colour ----------------------------------------------------------

/** The cream theme. Default for every content slide (§3.3). */
export const CREAM = {
  bg: '#F5F1E5',
  card: '#FFFFFF',
  hairline: '#DCD6C6',
  ink: '#022258',
  deep: '#01163A',
  body: '#4A5B74',
  dim: '#5F6C80',
  tealInk: '#14736D',
  /** Outcomes and KPIs only. */
  greenInk: '#2E7044',
  tintBand: '#EFF6F5',
  tintBorder: '#CBE2DF',
};

/** The dark theme. Reserved for suite deep dives (§3.3). */
export const DARK = {
  bg: '#01163A',
  panel: '#022258',
  hairline: '#1C3B66',
  innerCard: '#032B66',
  text: '#F6F1E4',
  body: '#B9C6D9',
  muted: '#8FA6C4',
  teal: '#7FD4CD',
  purple: '#B3A9F5',
  green: '#7FC98F',
};

/** Per-suite accents. Wordmarks are two tone: prefix ink, "Semantic" accent. */
export const SUITE = {
  sec: { light: '#14736D', dark: '#28B5AE', darkAlt: '#7FD4CD', band: '#1B968E' },
  dev: { light: '#5B4FC0', dark: '#7C6FE8', darkAlt: '#B3A9F5', band: '#7166E0' },
  pro: { light: '#8A6000' },
};

/** The only warning colour. Green is the only outcome colour. */
export const WARNING = '#C08500';

// --- §3 Form factor -------------------------------------------------------

/**
 * Slide anatomy, in inches. Every number is from §3.1 and §3.2 rather than
 * chosen — a margin that looks right and a margin the house uses are two
 * different things, and only one of them makes a generated deck sit beside a
 * hand-built one without announcing itself.
 */
export const GEOMETRY = {
  marginX: 0.6,
  eyebrow: { x: 0.6, y: 0.38, size: 11.5, tracking: 3 },
  title: { x: 0.6, y: 0.66, size: 30, sizeIfWrapping: 27 },
  subtitle: { x: 0.6, y: 1.24, size: 12.5 },
  contentTop: 1.66,
  finePrint: { y: 7.16, size: 6.5 },
  tag: { y: 7.14, size: 8 },
  pageNumber: { x: 12.88, size: 9 },
};

/** §4.2. Nothing smaller, ever. */
export const FLOORS = { body: 8.5, label: 7, finePrint: 6.5 };

/** §1.5. One idea per slide. */
export const DENSITY = { cards: 6, rows: 6, columns: 3, cardLines: 2, kpiLines: 1 };

/** §3.2, exactly. Reproduced verbatim because "exactly" is the rule. */
export const FINE_PRINT =
  '© 2026 Vikat.AI. All rights reserved. Vikat, SecSemantic, DevSemantic, ' +
  'ProSemantic, VShield, VCommand, VSentinel, and VInsight are trademarks of Vikat.AI. Confidential.';

/** §1.4. Modeled figures carry this on the same slide, small italic. */
export const DATA_NOTE =
  'Data note: illustrative modeled estimates. Not actual customer production results unless independently validated.';

// --- §2 Language, as checks ----------------------------------------------

/** §2.5. Bot jargon. A practitioner would not say these out loud. */
const JARGON = [
  'leverage', 'utilize', 'synergy', 'holistic', 'seamless', 'robust',
  'best in class', 'best-in-class', 'cutting edge', 'cutting-edge', 'enablement',
  'unlock', 'empower', 'supercharge', 'delve', 'transformative', 'game changing',
  'game-changing', 'solutioning',
];

/**
 * §2.6, the half with no judgement in it: fear selling, and superlatives that
 * are about us wherever they appear.
 */
const DRAMATIC = [
  'catastrophic', 'devastating', 'nightmare', 'explosion', 'tsunami', 'war zone',
  'unmatched', 'world class', 'world-class', 'guaranteed',
];

/**
 * §2.6, the half that needs a person.
 *
 * "the only" is banned as a superlative about Vikat and is perfectly good
 * English elsewhere — "the line stopping is the only outage that matters" is
 * exactly the register the instruction set asks for. Flagging that as an error
 * teaches people to skip the errors, which is how the em dash gets through.
 */
// Only what §2.6 actually lists. "the fastest" and "the leading" were mine,
// and the test that ties this file to the document caught them — which is the
// whole reason it exists.
const SELF_SUPERLATIVE = ['the only', 'the best'];

/** §1.1. Retired language that must never appear again. */
const RETIRED = [
  'your tools were built for humans to operate',
  'grounded and autonomous',
  'stop chasing alerts',
];

/** Words used as filler. Flagged only in that sense — see below. */
const FILLER = ['ecosystem', 'landscape', 'journey'];

const found = (haystack, needles) =>
  needles.filter((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(haystack));

/**
 * Check copy against §2.
 *
 * Returns problems (rules with no judgement in them) apart from notes (rules
 * that need a person to look). The distinction matters: an em dash is always
 * wrong, whereas "ecosystem" is wrong as filler and fine in "the partner
 * ecosystem" — flagging the second as an error would teach people to ignore
 * the first.
 *
 * @param {string} copy  All visible text from the deck.
 */
export function checkCopy(copy) {
  const problems = [];
  const notes = [];
  const text = String(copy || '');

  // §2.3, and §5 step 3 makes it its own QA gate.
  const dashes = (text.match(/[—–]/g) || []).length;
  if (dashes) {
    problems.push(
      `${dashes} em or en dash${dashes === 1 ? '' : 'es'} in the copy — the house style has none in customer-facing text.`,
    );
  }

  const jargon = found(text, JARGON);
  if (jargon.length) problems.push(`Bot jargon: ${jargon.join(', ')}.`);

  const dramatic = found(text, DRAMATIC);
  if (dramatic.length) problems.push(`Dramatic or superlative language: ${dramatic.join(', ')}.`);

  const retired = found(text, RETIRED);
  if (retired.length) problems.push(`Retired language: ${retired.join('; ')}.`);

  if (/!/.test(text)) problems.push('An exclamation point. The house style has none.');

  const superlative = found(text, SELF_SUPERLATIVE);
  if (superlative.length) {
    notes.push(`Check "${superlative.join('", "')}" is not a claim about Vikat — the house style bans those.`);
  }

  const filler = found(text, FILLER);
  if (filler.length) notes.push(`Check ${filler.join(', ')} is not being used as filler.`);

  return { problems, notes };
}

/** Exported so a test can assert every listed word is in the instruction set. */
export const WORDLISTS = { JARGON, DRAMATIC, RETIRED, FILLER, SELF_SUPERLATIVE };
