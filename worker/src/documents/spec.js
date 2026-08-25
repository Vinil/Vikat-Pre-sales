/**
 * spec.js — the shape of a document the assistant can produce.
 *
 * The model authors content; it never draws. It fills this spec, and the
 * renderers decide every colour, size and position from brand.js. That split
 * is deliberate: a model given layout control produces something that looks
 * approximately like the brand, and "approximately" is what a brand guideline
 * exists to prevent.
 *
 * The same spec renders as a deck or as a document. A section becomes a slide
 * in one and a block in the other, which is why the vocabulary is "section"
 * and "points" rather than "slide" and "bullets".
 */

import { brandSafe, sentenceCase } from '../brand.js';

/** Formats the assistant can produce. */
export const FORMATS = ['pptx', 'pdf'];

/** Caps, so one tool call cannot ask for a hundred-slide deck. */
export const LIMITS = {
  titleChars: 90,
  subtitleChars: 160,
  sections: 12,
  sectionTitleChars: 90,
  sectionBodyChars: 600,
  points: 6,
  pointChars: 180,
  eyebrowChars: 40,
};

/**
 * Normalise and validate a model-authored spec.
 *
 * Truncates rather than rejecting wherever truncating still leaves a usable
 * document: a rep mid-call wants the deck, not an error about a bullet being
 * four characters too long. Rejects only what cannot be rendered at all.
 *
 * @param {object} input
 * @returns {{ ok: true, spec: object } | { ok: false, error: string }}
 */
export function normaliseSpec(input) {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'The document spec must be an object.' };
  }

  const format = String(input.format || '').toLowerCase();
  if (!FORMATS.includes(format)) {
    return { ok: false, error: `format must be one of: ${FORMATS.join(', ')}.` };
  }

  const title = clean(input.title, LIMITS.titleChars, true);
  if (!title) return { ok: false, error: 'title is required.' };

  const rawSections = Array.isArray(input.sections) ? input.sections : [];
  const sections = rawSections
    .slice(0, LIMITS.sections)
    .map(normaliseSection)
    .filter((s) => s.title || s.body || s.points.length);

  if (sections.length === 0) {
    return { ok: false, error: 'At least one section with content is required.' };
  }

  return {
    ok: true,
    spec: {
      format,
      title,
      subtitle: clean(input.subtitle, LIMITS.subtitleChars, false),
      // Free text naming who this is for. Printed on the cover, so a deck
      // never circulates without saying who it was built for.
      audience: clean(input.audience, LIMITS.subtitleChars, false),
      sections,
      // Carried onto the cover and every footer. See DISCLOSURE_LABELS.
      disclosure: DISCLOSURE_LABELS[input.disclosure] ? input.disclosure : 'internal_only',
    },
  };
}

function normaliseSection(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    eyebrow: clean(s.eyebrow, LIMITS.eyebrowChars, false),
    title: clean(s.title, LIMITS.sectionTitleChars, true),
    body: clean(s.body, LIMITS.sectionBodyChars, false),
    points: (Array.isArray(s.points) ? s.points : [])
      .slice(0, LIMITS.points)
      .map((p) => clean(p, LIMITS.pointChars, false))
      .filter(Boolean),
  };
}

/** Brand-clean, optionally sentence-case, and truncate on a word boundary. */
function clean(value, max, asHeading) {
  let text = brandSafe(value);
  if (!text) return '';
  if (asHeading) text = sentenceCase(text);
  if (text.length <= max) return text;

  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * What the reader may do with this document, printed on every page.
 *
 * A generated deck outlives the conversation that produced it. Without a
 * standing label, an internal-only competitive teardown becomes a customer
 * leave-behind the moment someone forwards it.
 */
export const DISCLOSURE_LABELS = {
  external_ok: 'Cleared for customers',
  internal_only: 'Internal only — not for customer distribution',
  needs_approval: 'Draft — needs approval before it leaves Vikat',
};

/** A short filename that sorts by date and says what it is. */
export function fileNameFor(spec, isoDate) {
  const slug =
    spec.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'document';

  return `${isoDate.slice(0, 10)}-${slug}.${spec.format}`;
}
