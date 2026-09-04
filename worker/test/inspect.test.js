/**
 * Looking at the deck before a rep does.
 *
 * Decks shipped for weeks with the content huddled in the top four-tenths of
 * every slide and three different backgrounds in one file. Nothing said so —
 * not a test, not a warning, not the answer the rep read. They found out by
 * opening one.
 *
 * The first version of this check did not catch it either: it measured the
 * AREA the content covered, and a block spanning the full width covers plenty
 * of area while still leaving a hole under it. So the test that matters here
 * is the one that renders a top-heavy deck on purpose and insists the check
 * complains — a checker that passes everything is worse than none, because it
 * says the deck was looked at.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

import { renderPptx } from '../src/documents/pptx.js';
import { normaliseSpec, LIMITS } from '../src/documents/spec.js';
import { loadFonts } from '../src/documents/fonts.js';
import { inspectPptx, inspectionSummary } from '../src/documents/inspect.js';
import { SLIDE } from '../src/documents/ooxml.js';

const DECK = {
  format: 'pptx',
  title: 'Astec Industries — securing the agentic estate',
  subtitle: 'A view for the CISO ahead of our conversation',
  audience: 'CISO, Astec Industries',
  disclosure: 'internal_only',
  content: [
    '## context | Why now for Astec',
    'Astec runs plants across three continents, and a stopped line is the outage that matters.',
    '- Agents are already reading production telemetry',
    '',
    '## stat | 265 | attacks on manufacturing and industrials in 2025',
    '',
    '## bars | MTTR 71 | Alert noise 90 | Triage 64',
    '',
    '## chain | VSentinel > VInsight > VCommand > VShield',
    '',
    '## quote | A plant does not wait for your patch window.',
  ].join('\n'),
};

function build(input = DECK) {
  const parsed = normaliseSpec(input);
  assert.equal(parsed.ok, true, parsed.error);
  return renderPptx(parsed.spec, { preparedBy: 'rep@vikat.ai', isoDate: '2026-09-03' }, loadFonts().metrics);
}

/** One slide of raw XML, wrapped as a deck the inspector can open. */
function deckOf(slideXml) {
  return zipSync({ 'ppt/slides/slide1.xml': strToU8(slideXml) });
}

const shape = (x, y, w, h) =>
  `<a:off x="${Math.round(x * 914400)}" y="${Math.round(y * 914400)}"/>` +
  `<a:ext cx="${Math.round(w * 914400)}" cy="${Math.round(h * 914400)}"/>`;

// --- the deck the renderer actually produces -------------------------------

test('a deck built today passes its own check', () => {
  const report = inspectPptx(build());

  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.notes, [], 'a clean deck must produce no noise, or the noise gets ignored');
  assert.ok(report.slides > 0);
});

test('every slide has words on it', () => {
  // A drawing with no words is a slide the presenter explains from memory.
  const report = inspectPptx(build());
  assert.ok(!report.problems.some((p) => /no readable text/.test(p)), report.problems.join(' '));
});

test('the deck is one ground, not several', () => {
  const report = inspectPptx(build());
  assert.ok(
    !report.notes.some((n) => /different backgrounds/.test(n)),
    'white for prose, cream for drawn and navy for a quote read as three decks stapled together',
  );
});

test('a titled chart puts its title on the slide', () => {
  // Parsing a title is not the same as drawing one. bars, chain and timeline
  // rendered as a bare rule above a drawing, and a slide with a chart and no
  // heading is one the presenter explains from memory.
  const bytes = build({
    ...DECK,
    content: '## bars | Where the response time goes | MTTR 71 | Alert noise 90',
  });

  const files = unzipSync(bytes);
  const slides = Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .map((n) => strFromU8(files[n]))
    .join('');

  assert.match(slides, /Where the response time goes/, 'the heading never reached the slide');
});

/**
 * A real slide from a real deck, at the length that broke it.
 *
 * A rep opened a twelve-slide deck and found text running through the footer
 * and off the bottom of four of them. Composing past the band does not clip —
 * PowerPoint and LibreOffice both render the overflow — so nothing failed,
 * it just looked broken.
 */
const OVERFLOWING = [
  '## context | The Security Context Plane',
  'SecSemantic builds the system of record for consequence: a continuously computed graph, three',
  'coordinates per entity, drawn from the stack RadNet already runs.',
  '- Business Domain: clinical system ownership, patient data classification, HIPAA workflows, AI agent authorization scope across all 418 centers',
  '- Attack Surface: DeepHealth agent inventory, API connections, identity and access patterns, behavioral baselines per agent class',
  '- Threat Behavior: healthcare-targeted ransomware groups, credential abuse campaigns, imaging sector TTPs updated continuously from live feeds',
  '- Outcome: triage ordered by reach and worth, not queue position and shift time. The board pack priced in dollars, not CVSS scores',
].join('\n');

test('a slide with more copy than fits is made to fit', () => {
  const report = inspectPptx(build({ ...DECK, content: OVERFLOWING }));

  assert.deepEqual(
    report.problems,
    [],
    'this exact content ran through the footer and off the slide in a deck a rep opened',
  );
});

test('fitting shrinks before it drops anything', () => {
  // A rep asked for those words. Type comes down first; a bullet comes off
  // only when the smallest size still will not hold it.
  const bytes = build({ ...DECK, content: OVERFLOWING });
  const files = unzipSync(bytes);
  const slides = Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .map((n) => strFromU8(files[n]))
    .join('');

  for (const keyword of ['Business Domain', 'Attack Surface', 'Threat Behavior', 'Outcome']) {
    assert.ok(slides.includes(keyword), `${keyword} was dropped rather than fitted`);
  }
});

test('the worst a section is allowed to be still fits on a slide', () => {
  // Every field at its cap: the longest title, the longest body, the most
  // points at the longest each. Shrinking absorbs even this — which is what
  // makes the drop path below a guard rather than a routine step.
  //
  // The test that matters if anyone raises LIMITS.points or pointChars: it
  // fails here rather than in a deck a rep has already sent.
  const filler = (n) => 'considerable '.repeat(Math.ceil(n / 13)).slice(0, n).trim();
  const content = [
    `## context | ${filler(LIMITS.sectionTitleChars)}`,
    filler(LIMITS.sectionBodyChars),
    ...Array.from({ length: LIMITS.points }, () => `- ${filler(LIMITS.pointChars)}`),
  ].join('\n');

  const report = inspectPptx(build({ ...DECK, content }));
  assert.deepEqual(report.problems, [], JSON.stringify(report));
});

// --- the check has to bite --------------------------------------------------

test('a top-heavy slide is caught', () => {
  // The exact failure that shipped: a full-width block in the top third, with
  // the bottom half of the slide empty. Area-based checking called this fine.
  const xml = `<p:sld><p:cSld><p:spTree>
    <p:sp><p:spPr><a:xfrm>${shape(0.85, 0.7, 11.6, 1.6)}</a:xfrm></p:spPr>
    <p:txBody><a:p><a:r><a:t>A heading and some body copy, right at the top</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`;

  const report = inspectPptx(deckOf(xml));
  assert.ok(
    report.notes.some((n) => /top-heavy/.test(n)),
    `nothing flagged: ${JSON.stringify(report)}`,
  );
});

test('a balanced slide is not nagged', () => {
  const xml = `<p:sld><p:cSld><p:spTree>
    <p:sp><p:spPr><a:xfrm>${shape(0.85, 2.1, 11.6, 3.0)}</a:xfrm></p:spPr>
    <p:txBody><a:p><a:r><a:t>The same content, settled into the space it has</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`;

  const report = inspectPptx(deckOf(xml));
  assert.ok(!report.notes.some((n) => /top-heavy/.test(n)), report.notes.join(' '));
});

test('a slide with only footer furniture counts as empty', () => {
  // The page number and the disclosure line are on every slide and prove
  // nothing about whether this one says anything.
  const xml = `<p:sld><p:cSld><p:spTree>
    <p:sp><p:spPr><a:xfrm>${shape(0.85, 6.3, 4, 0.3)}</a:xfrm></p:spPr>
    <p:txBody><a:p><a:r><a:t>INTERNAL ONLY — NOT FOR CUSTOMER DISTRIBUTION</a:t></a:r>
    <a:r><a:t>4 / 10</a:t></a:r><a:r><a:t>2026-09-03</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`;

  const report = inspectPptx(deckOf(xml));
  assert.ok(report.problems.some((p) => /no readable text/.test(p)), JSON.stringify(report));
});

test('content running off the edge is a problem, not a note', () => {
  const xml = `<p:sld><p:cSld><p:spTree>
    <p:sp><p:spPr><a:xfrm>${shape(0.85, 2.0, SLIDE.widthIn, 2.0)}</a:xfrm></p:spPr>
    <p:txBody><a:p><a:r><a:t>This runs past the right edge of the slide</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`;

  const report = inspectPptx(deckOf(xml));
  assert.ok(report.problems.some((p) => /off the edge/.test(p)), JSON.stringify(report));
});

test('a file that is not a deck is reported, not thrown', () => {
  const report = inspectPptx(new Uint8Array([1, 2, 3, 4]));
  assert.equal(report.slides, 0);
  assert.ok(report.problems.length);
});

// --- what the rep is told ---------------------------------------------------

test('a clean deck says nothing at all', () => {
  // A wall of reassurance on every good deck teaches people to skip the
  // warning on the bad one.
  assert.equal(inspectionSummary({ problems: [], notes: [] }), '');
});

test('a problem leads with what to do about it', () => {
  const line = inspectionSummary({ problems: ['Slide 3 has no readable text on it.'], notes: [] });
  assert.match(line, /^Check before sending/);
});

test('problems outrank notes', () => {
  const line = inspectionSummary({
    problems: ['Slide 3 has no readable text on it.'],
    notes: ['Slide 4 is sparse.'],
  });
  assert.ok(!line.includes('sparse'), 'the serious one must not be buried under the cosmetic one');
});
