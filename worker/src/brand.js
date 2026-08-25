/**
 * brand.js — the Vikat.AI visual system, as data.
 *
 * Source: Vikat.AI Brand Guidelines v1.0, July 2026. Everything here is a
 * visual token that is already public — these are the colours and typefaces
 * vikat.ai renders on every page. The guidelines document itself is marked
 * confidential and is NOT in this repository, nor is the trademark register
 * or the suite architecture it contains. THIS REPOSITORY IS PUBLIC: do not
 * add anything from that document beyond what a visitor to the website can
 * already see.
 *
 * Generated collateral is the one thing the assistant produces that leaves
 * the building, so the rules below are enforced by the renderers rather than
 * left to the model's judgement. A rep should not be able to ask for an
 * off-brand deck and get one.
 */

// --- Colour ---------------------------------------------------------------

/**
 * The primary palette. Navy anchors everything; teal and green are accents,
 * at roughly 70 navy / 20 teal / 10 green.
 */
export const COLOR = {
  navy: '#022258',
  deepNavy: '#01163A',
  circuitTeal: '#34968D',
  signalGreen: '#5AB172',
  cream: '#F6F1E4',
  white: '#FFFFFF',
};

/**
 * Ink at three strengths, for body copy and secondary text on light grounds.
 * Derived from navy rather than grey, so nothing on the page is neutral-cold.
 */
export const INK = {
  strong: '#022258',
  body: '#2C3E5E',
  muted: '#6B7A93',
  rule: '#DFE4EC',
};

/** Text colours for use on navy. */
export const ON_NAVY = {
  strong: '#FFFFFF',
  body: '#C7D2E4',
  muted: '#8DA0BE',
};

/**
 * The brand gradient: Signal Green through Circuit Teal to Vikat Navy at 120°.
 *
 * COVERS AND DIVIDERS ONLY. The guidelines are explicit that it never appears
 * on cards or components, so it is exposed as a named thing the renderers ask
 * for by intent, not a colour they can reach for anywhere.
 */
export const GRADIENT = {
  stops: [COLOR.signalGreen, COLOR.circuitTeal, COLOR.navy],
  angleDegrees: 120,
};

/** Every colour a renderer may use. Anything else is off-brand by definition. */
export const PALETTE = Object.freeze([
  ...Object.values(COLOR),
  ...Object.values(INK),
  ...Object.values(ON_NAVY),
]);

// --- Type -----------------------------------------------------------------

/**
 * Inter and JetBrains Mono. Both are SIL Open Font License, so there is no
 * licensing cost or restriction for print or web, and no substitution is
 * permitted — which is why the renderers embed them rather than naming them
 * and hoping.
 */
export const FONT = {
  display: { family: 'Inter', weight: 900, style: 'Black' },
  heading: { family: 'Inter', weight: 700, style: 'Bold' },
  body: { family: 'Inter', weight: 400, style: 'Regular' },
  eyebrow: { family: 'JetBrains Mono', weight: 700, style: 'Bold' },
};

/**
 * The type scale, as ratios against a medium's base body size.
 *
 * The guidelines give pixel sizes for a full-bleed web hero (display at 88px).
 * Those numbers do not transfer to A4 or to a slide, but the hierarchy does,
 * so the ratios travel and each medium sets its own base. `tracking` is in em,
 * per the brand's tracking rule: tight on display, normal on body, wide on
 * eyebrows.
 */
export const SCALE = {
  display: { ratio: 4.4, lineHeight: 1.05, tracking: -0.03, role: 'display' },
  h1: { ratio: 2.8, lineHeight: 1.07, tracking: -0.03, role: 'display' },
  h2: { ratio: 1.8, lineHeight: 1.17, tracking: -0.01, role: 'heading' },
  h3: { ratio: 1.3, lineHeight: 1.23, tracking: 0, role: 'heading' },
  body: { ratio: 1, lineHeight: 1.5, tracking: 0, role: 'body' },
  small: { ratio: 0.8, lineHeight: 1.45, tracking: 0, role: 'body' },
  eyebrow: { ratio: 0.7, lineHeight: 1.43, tracking: 0.12, role: 'eyebrow' },
};

// --- Rules the renderers enforce -----------------------------------------

/**
 * Words that carry no meaning of their own, and so are the only ones safe to
 * lower when converting Title Case to sentence case.
 */
const MINOR_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor',
  'of', 'on', 'onto', 'or', 'over', 'per', 'the', 'to', 'up', 'versus', 'via',
  'vs', 'with', 'within', 'without',
]);

/**
 * Headings, buttons and labels are sentence case. ALL-CAPS is reserved for
 * eyebrows, which is the one place the renderers uppercase for you.
 *
 * Applied to model-authored strings, because a model asked for a deck title
 * reaches for Title Case every time.
 *
 * Deliberately conservative: only minor words are lowered. Anything else that
 * arrives capitalised stays capitalised, because a capital in the middle of a
 * heading is far more likely to be a customer, a product or an acronym than a
 * Title Case artefact — and "Acme" rendered as "acme" on a deck that goes to
 * Acme is a worse error than a stray capital.
 */
export function sentenceCase(text) {
  const s = String(text || '').trim();
  if (!s) return '';

  // A wholly upper-case string carries no capitalisation information — every
  // word looks like an acronym — so nothing can be preserved. Flatten it and
  // let restoreBrandTerms put the marks back.
  if (s === s.toUpperCase() && /[A-Z]{4,}/.test(s)) {
    const flat = s.toLowerCase();
    return restoreBrandTerms(flat.charAt(0).toUpperCase() + flat.slice(1));
  }

  const lowered = s
    .split(/\s+/)
    .map((w, i) => {
      if (i === 0) return w;
      // Strip trailing punctuation before the lookup so "field," matches.
      const bare = w.replace(/[^A-Za-z]/g, '').toLowerCase();
      return MINOR_WORDS.has(bare) ? w.toLowerCase() : w;
    })
    .join(' ');

  // Capitalise the opening, unless it is a mark that owns its own casing.
  const first = lowered.split(' ')[0];
  const opened = /[A-Z].*[A-Z]/.test(first)
    ? lowered
    : lowered.charAt(0).toUpperCase() + lowered.slice(1);

  return restoreBrandTerms(opened);
}

/**
 * Terms whose casing is fixed, restored after any case transform.
 *
 * Flattening "WHY VIKAT WINS" would otherwise put a lower-case brand name in
 * front of a customer, which is the exact failure sentenceCase exists to
 * prevent. Product marks are the same: VShield, not Vshield.
 */
const BRAND_TERMS = ['Vikat.AI', 'Vikat', 'VShield', 'VSentinel', 'VInsight', 'VCommand'];

function restoreBrandTerms(text) {
  let out = text;
  for (const term of BRAND_TERMS) {
    // Word boundary on both sides so "Vikat" does not rewrite the "Vikat" of
    // an already-correct "Vikat.AI".
    out = out.replace(new RegExp(`\\b${term.replace('.', '\\.')}\\b`, 'gi'), term);
  }
  return out;
}

/** Eyebrows are the only ALL-CAPS text in the system. */
export function eyebrowCase(text) {
  return String(text || '').trim().toUpperCase();
}

/**
 * The logotype is a designed lockup and is never retyped in body text. In
 * running copy the brand is written "Vikat.AI".
 */
export const WORDMARK = 'vikat.AI';
export const BRAND_IN_COPY = 'Vikat.AI';
export const TAGLINE = 'Intelligence you can rely on.';
export const DESCRIPTOR = 'The Agent Semantics Company';

/**
 * Characters the brand does not use in generated material. Emoji are named
 * as prohibited; the renderers strip them rather than trusting the model to
 * have read the prompt.
 */
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;

/** Strip anything the brand does not permit in generated copy. */
export function brandSafe(text) {
  return String(text || '')
    .replace(EMOJI_RE, '')
    // Straight quotes read as code; the brand sets prose, not terminal output.
    .replace(/(^|[\s(\[])"(?=\S)/g, '$1“')
    .replace(/"/g, '”')
    .replace(/(^|[\s(\[])'(?=\S)/g, '$1‘')
    .replace(/'/g, '’')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Copyright line for generated material. */
export function copyrightLine(year) {
  return `© ${year} Vikat.AI. All rights reserved.`;
}
