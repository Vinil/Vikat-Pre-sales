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
import { DENSITY } from './house.js';

/** Formats the assistant can produce. */
export const FORMATS = ['pptx', 'pdf', 'docx'];

/** Caps, so one tool call cannot ask for a hundred-slide deck. */
export const LIMITS = {
  titleChars: 90,
  subtitleChars: 160,
  sections: 12,
  sectionTitleChars: 90,
  sectionBodyChars: 600,
  points: 6,
  /**
   * Sections above which a deck must draw something.
   *
   * Four rather than two: a short deck is often a genuine summary, and
   * refusing those would teach the model to pad rather than to visualise.
   */
  proseOnlyDeck: 4,
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

  // Two accepted shapes. The tool sends `content` as markdown, because a flat
  // string schema is the only shape that reliably compiles (see tools.js); the
  // structured `sections` array is the internal form the renderers consume and
  // what the tests build directly.
  const rawSections = typeof input.content === 'string'
    ? parseSections(input.content)
    : Array.isArray(input.sections) ? input.sections : [];

  const sections = rawSections
    .slice(0, LIMITS.sections)
    .map(normaliseSection)
    .filter((s) => s.layout || s.title || s.body || s.points.length);

  if (sections.length === 0) {
    return { ok: false, error: 'At least one section with content is required.' };
  }

  // A deck of nothing but prose is the thing the drawn layouts exist to
  // prevent, and it is what a rep got when they asked for five visual slides.
  //
  // Refused rather than warned about, because a warning attached to a
  // successfully built file is a warning nobody reads — the deck is already in
  // SharePoint by then. The model gets one specific instruction and rebuilds.
  //
  // Only for a deck, and only past a few sections: a three-slide summary is
  // legitimately prose, and a pdf is a document where paragraphs are the point.
  if (format === 'pptx' && sections.length >= LIMITS.proseOnlyDeck && !sections.some((s) => s.layout)) {
    return {
      ok: false,
      error:
        `A ${sections.length}-slide deck with no drawn slides is a document with slide breaks. ` +
        'Rebuild it using at least one of stat, bars, chain, timeline, split or quote for the ' +
        'content that has that shape — a figure, a comparison, a sequence, a platform, two ' +
        'states, or the one line to end on. Keep prose slides for the parts that are genuinely ' +
        'argument.',
    };
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

/**
 * Slide layouts the renderer can DRAW, as opposed to typeset.
 *
 * Declared in the heading rather than as schema fields, and that is not a
 * shortcut. create_document's schema is flat and non-strict because a nested
 * one was rejected with "Schema is too complex." — a request-level 400 that
 * killed every conversation, including ones that never touched the tool, and
 * took three deploys to diagnose. A visual vocabulary expressed inside the
 * content string costs the schema nothing.
 *
 *   ## stat | 265 | attacks on food and agriculture in 2025
 *   ## bars | MTTR 71 | Alert noise 90 | Triage 64
 *   ## chain | VSentinel > VInsight > VCommand > VShield
 *   ## timeline | Plant | Grow | Harvest | Ship
 *   ## split | What they run today | What SecSemantic changes
 *   ## quote | Severity is calendar-blind.
 *
 * Anything else is prose, and prose is still the default: a layout used
 * because it exists, rather than because the content is that shape, is worse
 * than a paragraph.
 */
const DENSITY_CARDS = DENSITY.cards;
const DENSITY_ROWS = DENSITY.rows;
const DENSITY_COLUMNS = DENSITY.columns;

export const LAYOUTS = [
  'stat', 'bars', 'chain', 'timeline', 'split', 'quote',
  // §4.3, the named components. Reuse, do not invent.
  'tiles', 'table', 'kpi', 'outcome', 'paradigm', 'flow',
];

/** Split "a | b | c" into trimmed, non-empty parts. */
function pipes(text) {
  return String(text)
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A "label 71" pair for a bar. The number is the last token, so a label may
 * contain spaces and still parse.
 */
function bar(text) {
  const m = /^(.*?)[\s:]+(-?\d+(?:\.\d+)?)\s*%?$/.exec(String(text).trim());
  if (!m) return null;
  const label = m[1].trim();
  const value = Number(m[2]);
  if (!label || !Number.isFinite(value)) return null;
  return { label, value };
}

/**
 * The words a layout carries, for any renderer that cannot draw it.
 *
 * Layout data is ADDITIVE: a section always carries a title and points that
 * say the same thing in text. The PDF renderer reads only title, body and
 * points and knows nothing about layouts — without this, a `stat` section
 * would render as an empty heading and the number would vanish silently,
 * which is the worst way for a feature to be missing.
 *
 * It also means adding a layout can never break a renderer that has not been
 * taught it yet.
 */
function asText(drawn) {
  if (drawn.layout === 'stat') {
    // A colon, not an em dash: §2.3 bans them in customer-facing copy, and
    // the renderer's own joins reach the slide exactly as the model's words do.
    return { title: [drawn.value, drawn.caption].filter(Boolean).join(': '), points: [] };
  }
  if (drawn.layout === 'bars') {
    return { title: drawn.title || '', points: drawn.bars.map((b) => `${b.label}: ${b.value}`) };
  }
  if (drawn.layout === 'chain') {
    // With a heading the steps become points, so both survive into a PDF.
    // Without one the steps ARE the heading, which is how this has always
    // read and how every existing deck still parses.
    return drawn.title
      ? { title: drawn.title, points: [drawn.steps.join(' → ')] }
      : { title: drawn.steps.join(' → '), points: [] };
  }
  if (drawn.layout === 'tiles') {
    return { title: drawn.title || '', points: drawn.tiles.map((t) => `${t.value}: ${t.caption}`) };
  }
  if (drawn.layout === 'table') {
    return {
      title: drawn.title || drawn.columns.join(', '),
      points: drawn.rows.map((r) => r.join(', ')),
    };
  }
  if (drawn.layout === 'kpi') {
    return { title: drawn.title || '', points: drawn.kpis.map((k) => `${k.code}: ${k.target}`) };
  }
  if (drawn.layout === 'outcome') {
    return { title: drawn.title || drawn.tag, body: drawn.sentence, points: [] };
  }
  if (drawn.layout === 'paradigm') {
    return { title: drawn.title || '', points: [`From: ${drawn.from}`, `To: ${drawn.to}`] };
  }
  if (drawn.layout === 'flow') {
    return drawn.title
      ? { title: drawn.title, points: [drawn.steps.join(' > ')] }
      : { title: drawn.steps.join(' > '), points: [] };
  }
  if (drawn.layout === 'timeline') {
    // A COPY. Sharing the array meant a bullet parsed after the heading was
    // pushed into the stops as well, and the timeline grew a sixth stop
    // reading "A medium CVE in...".
    return { title: '', points: [...drawn.stops] };
  }
  if (drawn.layout === 'split') {
    return { title: '', points: [drawn.left, drawn.right] };
  }
  if (drawn.layout === 'quote') {
    return { title: drawn.line, points: [] };
  }
  return { title: '', points: [] };
}

/**
 * Read a layout directive off a heading, or return null for ordinary prose.
 *
 * Returns the layout plus the data it needs, already validated — a renderer
 * should never receive a `bars` slide with nothing to draw, because an empty
 * chart is worse than the paragraph it replaced.
 */
export function parseLayout(headingText) {
  const parts = pipes(headingText);
  if (parts.length < 2) return null;

  // §3.1 puts an eyebrow above every content heading, and §3.5 makes it part
  // of what a slide needs in order to stand alone once somebody screenshots
  // it. A drawn heading has no room for one among the pipes, because every
  // segment there is data, so it is written after a caret:
  //
  //   ## outcome ^ Our commitment | Skin in the game | LABEL | sentence.
  //
  // A caret rather than another pipe or a colon: neither appears in prose,
  // and a colon is already a KPI's separator.
  const [kindPart, ...eyebrowParts] = parts[0].split('^');
  const kind = kindPart.trim().toLowerCase();
  if (!LAYOUTS.includes(kind)) return null;

  const eyebrow = eyebrowParts.join('^').trim();
  const drawn = parseKind(kind, parts.slice(1));
  return drawn && eyebrow ? { ...drawn, eyebrow } : drawn;
}

/** The per-layout half of parseLayout, once the kind and eyebrow are off. */
function parseKind(kind, rest) {
  if (kind === 'stat') {
    // The number carries the slide; the caption says what it counts.
    return { layout: 'stat', value: rest[0], caption: rest.slice(1).join('. ') };
  }

  if (kind === 'bars') {
    // A leading segment that is not itself a bar is the slide's heading.
    // bar() needs "label number", so anything without a trailing number
    // cannot be data — which makes the title unambiguous rather than
    // positional, and leaves every existing deck parsing exactly as before.
    const title = bar(rest[0]) ? '' : rest[0];
    const data = title ? rest.slice(1) : rest;

    const bars = data.map(bar).filter(Boolean).slice(0, 6);
    return bars.length >= 2 ? { layout: 'bars', bars, ...(title ? { title } : {}) } : null;
  }

  if (kind === 'chain') {
    // Steps are joined by ">", so a first segment with no arrow in it is a
    // heading rather than a step.
    const title = rest.length > 1 && !/[>→]/.test(rest[0]) ? rest[0] : '';
    const data = title ? rest.slice(1) : rest;

    const steps = data
      .join(' | ')
      .split(/>|→/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 5);
    return steps.length >= 2 ? { layout: 'chain', steps, ...(title ? { title } : {}) } : null;
  }

  if (kind === 'timeline') {
    // Stops are plain words, so nothing in the data distinguishes a heading
    // from a stop. A heading is taken only when it is written as one — ending
    // in a colon — which keeps every existing deck parsing unchanged.
    const heading = /:$/.test(rest[0] || '');
    const title = heading ? rest[0].replace(/:$/, '') : '';
    const stops = (heading ? rest.slice(1) : rest).slice(0, 6);
    return stops.length >= 2 ? { layout: 'timeline', stops, ...(title ? { title } : {}) } : null;
  }

  if (kind === 'tiles') {
    // §4.3 stat tiles: "tiles | Heading | 418 centers | 1.4M records".
    // A tile is a figure and what it counts, so anything without a leading
    // number is the slide's heading.
    const isTile = (t) => /^[\d£$€]/.test(t.trim());
    const title = isTile(rest[0]) ? '' : rest[0];
    const tiles = (title ? rest.slice(1) : rest)
      .map((t) => {
        const m = /^(\S+)\s+(.*)$/.exec(t.trim());
        return m ? { value: m[1], caption: m[2] } : null;
      })
      .filter(Boolean)
      .slice(0, DENSITY_CARDS);

    return tiles.length >= 2 ? { layout: 'tiles', tiles, ...(title ? { title } : {}) } : null;
  }

  if (kind === 'table') {
    // "table | Heading / Offering, Measure, Target / row / row". §1.3 asks for
    // exactly this shape on an outcome slide: the customer's language only.
    const title = /,/.test(rest[0]) ? '' : rest[0];
    const body = title ? rest.slice(1) : rest;
    const rows = body.map((r) => r.split(',').map((c) => c.trim()).filter(Boolean)).filter((r) => r.length >= 2);
    if (rows.length < 2) return null;

    const columns = rows[0].slice(0, DENSITY_COLUMNS);
    const data = rows.slice(1).map((r) => r.slice(0, columns.length)).slice(0, DENSITY_ROWS);
    return data.length ? { layout: 'table', columns, rows: data, ...(title ? { title } : {}) } : null;
  }

  if (kind === 'kpi') {
    // §1.3: metric codes in pills, and `metric: target` never prose.
    const title = /:/.test(rest[0]) ? '' : rest[0];
    const lines = (title ? rest.slice(1) : rest)
      .map((l) => {
        const at = l.indexOf(':');
        return at === -1 ? null : { code: l.slice(0, at).trim(), target: l.slice(at + 1).trim() };
      })
      .filter((k) => k && k.code && k.target)
      .slice(0, DENSITY_ROWS);

    return lines.length ? { layout: 'kpi', kpis: lines, ...(title ? { title } : {}) } : null;
  }

  if (kind === 'outcome') {
    // §4.3 outcome band: "outcome | Heading | SKIN IN THE GAME | sentence."
    if (rest.length < 2) return null;
    const sentence = rest[rest.length - 1];
    const tag = rest[rest.length - 2];
    const title = rest.length > 2 ? rest[0] : '';
    return { layout: 'outcome', tag, sentence, ...(title ? { title } : {}) };
  }

  if (kind === 'paradigm') {
    // §4.3 from/to. "paradigm | Heading | ranked by severity | ranked by cost"
    if (rest.length < 2) return null;
    const to = rest[rest.length - 1];
    const from = rest[rest.length - 2];
    const title = rest.length > 2 ? rest[0] : '';
    return { layout: 'paradigm', from, to, ...(title ? { title } : {}) };
  }

  if (kind === 'flow') {
    // §4.3 flow diagram. Same shape as chain, with an emphasised step marked
    // by a leading asterisk: "flow | Heading | Detect > *Decide > Act".
    const title = rest.length > 1 && !/[>→]/.test(rest[0]) ? rest[0] : '';
    const raw = (title ? rest.slice(1) : rest)
      .join(' | ')
      .split(/>|→/)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 5);

    const emphasis = raw.findIndex((x) => x.startsWith('*'));
    const steps = raw.map((x) => x.replace(/^\*/, '').trim());
    return steps.length >= 2 ? { layout: 'flow', steps, emphasis, ...(title ? { title } : {}) } : null;
  }

  if (kind === 'split') {
    return rest.length >= 2 ? { layout: 'split', left: rest[0], right: rest[1] } : null;
  }

  if (kind === 'quote') {
    const line = rest.join('. ');
    return line ? { layout: 'quote', line } : null;
  }

  return null;
}

/**
 * Parse the markdown the model writes into sections.
 *
 * The format is deliberately the smallest thing that carries the structure,
 * because every additional rule is one the model can get wrong:
 *
 *   ## eyebrow | Section title
 *   A body paragraph.
 *   - a point
 *   - another point
 *
 * The eyebrow and the pipe are optional, as are the body and the points.
 * Anything before the first heading is ignored rather than guessed at — a
 * model that opens with "Here is your deck:" should not get a section titled
 * that.
 */
export function parseSections(markdown) {
  const sections = [];
  let current = null;

  for (const rawLine of String(markdown || '').split('\n')) {
    const line = rawLine.trim();

    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (heading) {
      if (current) sections.push(current);

      const [, text] = heading;
      const drawn = parseLayout(text);

      if (drawn) {
        // The drawing data AND the words that say the same thing, so a
        // renderer that cannot draw this layout still shows its content.
        current = { eyebrow: '', body: '', ...asText(drawn), ...drawn };
        continue;
      }

      const pipe = text.indexOf('|');
      current = pipe === -1
        ? { eyebrow: '', title: text, body: '', points: [] }
        : { eyebrow: text.slice(0, pipe), title: text.slice(pipe + 1), body: '', points: [] };
      continue;
    }

    if (!current || !line) continue;

    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      current.points.push(bullet[1]);
      continue;
    }

    // Prose. Successive lines join into one paragraph rather than becoming
    // separate ones: the renderers lay out a single block per section.
    current.body = current.body ? `${current.body} ${line}` : line;
  }

  if (current) sections.push(current);
  return sections;
}

/** The fields each layout carries, so nothing else rides along. */
function drawnFields(s) {
  if (s.layout === 'stat') {
    // 90 characters cut a real caption mid-parenthesis and left an ellipsis
    // on the slide — "…in a single 2025 breach (HHS filing,…" — which reads
    // as a bug, because it is one. A caption is one sentence saying what the
    // number counts, and one sentence is routinely longer than 90 characters
    // once it carries its source.
    return { value: clean(s.value, 12, false), caption: clean(s.caption, 200, false) };
  }
  if (s.layout === 'bars') return { bars: s.bars, title: clean(s.title, LIMITS.sectionTitleChars, true) };
  if (s.layout === 'chain') return { steps: s.steps.map((x) => clean(x, 24, false)), title: clean(s.title, LIMITS.sectionTitleChars, true) };
  if (s.layout === 'timeline') return { stops: s.stops.map((x) => clean(x, 20, false)), title: clean(s.title, LIMITS.sectionTitleChars, true) };
  if (s.layout === 'tiles') {
    return {
      title: clean(s.title, LIMITS.sectionTitleChars, true),
      tiles: s.tiles.map((t) => ({ value: clean(t.value, 12, false), caption: clean(t.caption, 90, false) })),
    };
  }
  if (s.layout === 'table') {
    return {
      title: clean(s.title, LIMITS.sectionTitleChars, true),
      columns: s.columns.map((c) => clean(c, 24, false)),
      rows: s.rows.map((r) => r.map((c) => clean(c, 70, false))),
    };
  }
  if (s.layout === 'kpi') {
    return {
      title: clean(s.title, LIMITS.sectionTitleChars, true),
      kpis: s.kpis.map((k) => ({ code: clean(k.code, 12, false), target: clean(k.target, 70, false) })),
    };
  }
  if (s.layout === 'outcome') {
    return {
      title: clean(s.title, LIMITS.sectionTitleChars, true),
      tag: clean(s.tag, 24, false),
      sentence: clean(s.sentence, 180, false),
    };
  }
  if (s.layout === 'paradigm') {
    return {
      title: clean(s.title, LIMITS.sectionTitleChars, true),
      from: clean(s.from, 80, false),
      to: clean(s.to, 80, false),
    };
  }
  if (s.layout === 'flow') {
    return {
      title: clean(s.title, LIMITS.sectionTitleChars, true),
      steps: s.steps.map((x) => clean(x, 24, false)),
      emphasis: Number.isInteger(s.emphasis) ? s.emphasis : -1,
    };
  }
  if (s.layout === 'split') return { left: clean(s.left, 60, false), right: clean(s.right, 60, false) };
  if (s.layout === 'quote') return { line: clean(s.line, 120, false) };
  return {};
}

function normaliseSection(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    // Layout data survives normalisation untouched: it was validated when it
    // was parsed, and clean() is for prose.
    ...(s.layout ? { layout: s.layout, ...drawnFields(s) } : {}),
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
  // Colons, not em dashes. §2.3 bans them in anything customer-facing, and
  // this label is printed on every slide — the renderer's own furniture is
  // held to the rule exactly as the model's words are.
  internal_only: 'Internal only: not for customer distribution',
  needs_approval: 'Draft: needs approval before it leaves Vikat',
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
