/**
 * guidelines.js — the brand guidelines, as something a generator can obey.
 *
 * SOURCE: "The Semantic Suite — Brand Guidelines", Vikat, Version 1.0, 2026,
 * Confidential. Every value below carries the section it came from, so nobody
 * has to reopen a PDF to find out why a hex is what it is, and so a value that
 * drifts can be traced to a document that did or did not change.
 *
 * This file is DESCRIPTIVE, not decorative. It holds what the guidelines say
 * and it answers questions about a document; it does not draw anything. The
 * renderers keep their own measurements in house.js — that is the presentation
 * instruction set, a different document with a different job. Where the two
 * disagree, see CONFLICTS at the bottom: the disagreement is recorded rather
 * than quietly settled, because settling it is a brand decision and nothing in
 * a source file is entitled to make one.
 *
 * Confirmed authoritative for the visual system over the Vikat TM3 trademark
 * documentation, which specifies a different typeface, palette and mark.
 */

/** §04 · Color. One accent per suite, and they are never mixed. */
export const SUITE_ACCENTS = {
  SecSemantic: { accent: '#009CB4', dark: '#00707E', plane: 'SCP', source: '§04' },
  DevSemantic: { accent: '#6054D8', dark: '#453BB0', plane: 'DCP', source: '§04' },
  ProSemantic: { accent: '#C0741A', dark: '#9C5410', plane: 'PCP', source: '§04' },
};

/** §04 · The neutral foundation. Most of any layout is these, on white. */
export const NEUTRALS = {
  ink: '#121417',
  body: '#6B7278',
  faint: '#9AA1A6',
  rule: '#E5E7E9',
  source: '§04',
};

/**
 * §05 · Typography. Two families, used with discipline.
 *
 * Already what the renderer embeds, which is the one place this file and the
 * deployed code were in agreement before anyone checked.
 */
export const TYPE = {
  display: { family: 'Inter', weight: 800 },
  headline: { family: 'Inter', weight: 700 },
  subhead: { family: 'Inter', weight: 600 },
  body: { family: 'Inter', weight: 400 },
  // Labels, kickers, buttons and code. The ONLY place uppercase is allowed.
  mono: { family: 'JetBrains Mono' },
  source: '§05',
};

/** §01 · The plane abbreviations, always uppercase in all contexts. */
export const PLANES = ['SCP', 'DCP', 'PCP'];

/** §01 · Products inside the SecSemantic suite. */
export const SUITE_PRODUCTS = ['VSentinel', 'VInsight', 'VCommand', 'VShield'];

/** §07 · The line. Not a slogan to rewrite per deck. */
export const THE_LINE = 'The vendor-neutral semantic context layer for Sec and Dev AI agents.';

/** §08 · The closing rule, and the one worth quoting at anybody who asks. */
export const WHEN_IN_DOUBT =
  'When in doubt, choose the quieter option, and never reintroduce a second mark.';

/** §08 · Trademark line, reproduced exactly. */
export const TRADEMARK_LINE =
  'Vikat, SecSemantic, DevSemantic, ProSemantic, SCP, DCP and PCP are trademarks of Vikat CyberSec LLC. SecSemantic and DevSemantic are patent pending.';

const SUITE_NAMES = Object.keys(SUITE_ACCENTS);

/**
 * Every hex the guidelines approve, lowercased for comparison.
 * §04: "Accents are never mixed within a single surface."
 */
export const APPROVED_HEXES = new Set(
  [
    ...Object.values(SUITE_ACCENTS).flatMap((s) => [s.accent, s.dark]),
    NEUTRALS.ink,
    NEUTRALS.body,
    NEUTRALS.faint,
    NEUTRALS.rule,
    '#FFFFFF',
  ].map((h) => h.toLowerCase()),
);

/** All the words of a spec, in one string, for the text-level rules. */
function specText(spec) {
  const parts = [spec.title || '', spec.subtitle || ''];
  for (const s of spec.sections || []) {
    parts.push(s.eyebrow || '', s.title || '', s.body || '', ...(s.points || []));
  }
  return parts.filter(Boolean).join('\n');
}

/**
 * Which suite accents a document is reaching for.
 *
 * Named rather than counted, because the finding a rep can act on is "this
 * deck is wearing two accents" and not "accentCount = 2".
 */
export function suitesMentioned(spec) {
  const text = specText(spec);
  return SUITE_NAMES.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
}

/**
 * Hold a document to the brand guidelines, and say where it strays.
 *
 * Returns the same shape as inspectPptx so the two read as one report to the
 * caller: `problems` are things that break a stated rule, `notes` are things a
 * person should look at. Nothing here refuses a document. A deck a shade
 * outside the guidelines is still a deck, and a rep five minutes from a call
 * needs it more than they need our approval.
 *
 * @param {object} spec  The normalised document spec.
 * @returns {{ problems: string[], notes: string[] }}
 */
export function checkGuidelines(spec) {
  const problems = [];
  const notes = [];
  const text = specText(spec);

  // §04. The rule the guidelines state most plainly, and the one a deck
  // drafted from three suites' material breaks without anyone noticing.
  const suites = suitesMentioned(spec);
  if (suites.length > 1) {
    problems.push(
      `This carries ${suites.join(' and ')}, and one surface takes one accent (§04). Split it, or lead with one suite and name the others in prose.`,
    );
  }

  // §01. "SCP, DCP and PCP are always uppercase." Lowercase reads as a typo
  // to everyone except the person who wrote it.
  for (const plane of PLANES) {
    const wrong = new RegExp(`\\b${plane.toLowerCase()}\\b`, 'g');
    if (wrong.test(text)) {
      problems.push(`"${plane.toLowerCase()}" should be ${plane}: plane names are always uppercase (§01).`);
    }
  }

  // §01. "Each suite name is one closed word." A space or a hyphen turns a
  // trademark into a description of one.
  const split = /\b(Sec|Dev|Pro)[\s-]+Semantic\b/g;
  let m = split.exec(text);
  while (m) {
    problems.push(`"${m[0]}" is one closed word: ${m[1]}Semantic (§01).`);
    m = split.exec(text);
  }

  // §07. "Bullets use a dot, never a dash." The renderer sets the bullet
  // glyph, so this is about a dash typed INSIDE the point.
  const dashedBullet = (spec.sections || []).some((s) =>
    (s.points || []).some((p) => /^\s*[-–—]\s+/.test(p)),
  );
  if (dashedBullet) {
    problems.push('A bullet starts with a dash. Bullets take a dot, never a dash (§07).');
  }

  // §05. Uppercase belongs to mono kickers and nowhere else. A shouted
  // headline is the most common way a deck stops looking like the brand.
  for (const s of spec.sections || []) {
    const title = String(s.title || '');
    const letters = title.replace(/[^A-Za-z]/g, '');
    if (letters.length > 8 && letters === letters.toUpperCase()) {
      notes.push(`"${title}" is set in capitals. Headlines are sentence case; only mono kickers are uppercase (§05).`);
    }
  }

  // §04, stated as a preference rather than a threshold: "Lowering accent
  // saturation is preferred to adding more of it." Nothing here can count
  // pixels, so this is the honest version — a reminder attached to the one
  // document shape that tends to over-colour.
  if (suites.length === 1 && (spec.sections || []).length > 12) {
    notes.push(
      `A deck this long is where accent creeps in. Most of any layout is ink and gray on white, with ${SUITE_ACCENTS[suites[0]].accent} reserved for the one thing that should lead the eye (§04).`,
    );
  }

  return { problems, notes };
}

/**
 * Where the guidelines and the presentation instruction set disagree.
 *
 * Recorded, not resolved. Both documents are real, both are in use, and
 * picking between them is a brand decision — the kind of thing that should be
 * made by a person once and written down, rather than made implicitly by
 * whichever file a renderer happened to import.
 *
 * The visual system has been confirmed to the Semantic Suite guidelines. The
 * lines below are what remains outstanding.
 */
export const CONFLICTS = [
  {
    topic: 'The line',
    guidelines: THE_LINE,
    elsewhere: 'house.js POSITIONING_LINE: "Personalized and Preemptive CyberSec and SRE." and DECK_TAGLINE: "Earlier beats faster."',
    alsoElsewhere: 'Vikat TM3 tagline: "Intelligence you can rely on."',
    note: 'Three different lines across three documents. A deck can only open on one.',
  },
  {
    topic: 'Legal entity',
    guidelines: 'Vikat CyberSec LLC (§08)',
    elsewhere: 'Vikat TM3: "© 2026 Vikat.AI", marks owned by Vikat.AI',
    note: 'The copyright footer on every generated asset names one of these.',
  },
  {
    topic: 'Suite accents',
    guidelines: '#009CB4 / #6054D8 / #C0741A (§04)',
    elsewhere: 'Vikat TM3: #28B5AE / #7C6FE8 / #C08500; house.js SUITE: its own set again',
    note: 'Resolved in favour of the guidelines for the visual system; house.js still holds the old values and the renderers still read house.js.',
  },
];
