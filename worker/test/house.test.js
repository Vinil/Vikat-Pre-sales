/**
 * The instruction set, held to the instruction set.
 *
 * brand/PPT_Agent_Instructions.md is the authority. house.js is its executable
 * half, and this asserts the two still agree — every colour, every measurement,
 * every banned word traced back to the document that mandates it.
 *
 * The alternative was tried on the palette and failed: brand.js was a
 * transcription, somebody read the source and typed the values in, and the two
 * drifted until the accents were close-but-wrong. A spec nobody checks against
 * is a spec that describes what the code used to do.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CREAM, DARK, SUITE, WARNING, GEOMETRY, FLOORS, DENSITY,
  FINE_PRINT, DATA_NOTE, WORDLISTS, checkCopy,
} from '../src/documents/house.js';
import { renderPptx } from '../src/documents/pptx.js';
import { normaliseSpec, DISCLOSURE_LABELS } from '../src/documents/spec.js';
import { loadFonts } from '../src/documents/fonts.js';
import { inspectPptx } from '../src/documents/inspect.js';
import { brandSafe } from '../src/brand.js';
import { SLIDE } from '../src/documents/ooxml.js';

const DOC = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../brand/PPT_Agent_Instructions.md'),
  'utf8',
);

// --- house.js says what the document says ---------------------------------

test('every colour is one the instruction set names', () => {
  const all = { ...CREAM, ...DARK, ...SUITE.sec, ...SUITE.dev, ...SUITE.pro, warning: WARNING };

  for (const [name, hex] of Object.entries(all)) {
    assert.ok(
      DOC.toUpperCase().includes(hex.replace('#', '').toUpperCase()),
      `${name} is ${hex}, which the instruction set does not mention`,
    );
  }
});

test('the measurements are the document’s', () => {
  // §3.1 and §3.2. A margin that looks right and the margin the house uses are
  // two different numbers, and only one makes a generated deck sit beside a
  // hand-built one without announcing itself.
  assert.match(DOC, new RegExp(`MX = ${GEOMETRY.marginX}`));
  assert.match(DOC, new RegExp(`Inter bold ${GEOMETRY.title.size}pt`));
  assert.match(DOC, new RegExp(`${GEOMETRY.eyebrow.size}pt`));
  assert.match(DOC, new RegExp(`y ${GEOMETRY.finePrint.y}`));
  assert.match(DOC, new RegExp(`x ${GEOMETRY.pageNumber.x}`));
  assert.match(DOC, new RegExp(`${SLIDE.widthIn.toFixed(2)} x ${SLIDE.heightIn} inches`));
});

test('the type floors are the document’s floors', () => {
  assert.match(DOC, new RegExp(`body ${FLOORS.body}pt`));
  assert.match(DOC, new RegExp(`labels ${FLOORS.label}pt`));
  assert.match(DOC, new RegExp(`fine print ${FLOORS.finePrint}pt`));
});

test('the density limits are the document’s', () => {
  assert.match(DOC, new RegExp(`six cards or ${DENSITY.rows === 6 ? 'six' : DENSITY.rows} table rows`));
  assert.match(DOC, /Maximum three columns/);
  assert.equal(DENSITY.columns, 3);
});

test('the fine print is reproduced exactly', () => {
  // "exactly" is the rule, so a near-miss is a failure. Anything a rep
  // forwards carries this line and nothing else.
  assert.ok(DOC.includes(FINE_PRINT), 'the trademark line does not match the instruction set');
});

test('the modeled-data note is reproduced exactly', () => {
  assert.ok(DOC.includes(DATA_NOTE));
});

test('every banned word is banned by the document', () => {
  for (const [list, words] of Object.entries(WORDLISTS)) {
    for (const word of words) {
      // Hyphenated variants are this file's own expansion of a spaced term.
      const base = word.replace(/-/g, ' ');
      assert.ok(
        DOC.toLowerCase().includes(base.toLowerCase()),
        `${list} lists "${word}", which the instruction set does not mention`,
      );
    }
  }
});

// --- the checks catch what the document forbids ---------------------------

test('an em dash is a problem, not a note', () => {
  // §2.3, and §5 makes it its own QA gate.
  const { problems } = checkCopy('We preempt early — not fast.');
  assert.ok(problems.some((p) => /dash/.test(p)), problems.join(' '));
});

test('bot jargon is caught', () => {
  const { problems } = checkCopy('A holistic, best-in-class platform to empower your journey.');
  assert.ok(problems.some((p) => /jargon/i.test(p)), problems.join(' '));
});

test('fear selling is caught', () => {
  const { problems } = checkCopy('A catastrophic breach. A devastating outage.');
  assert.ok(problems.some((p) => /Dramatic/i.test(p)), problems.join(' '));
});

test('retired language is caught', () => {
  const { problems } = checkCopy('Stop chasing alerts. Grounded and Autonomous.');
  assert.ok(problems.some((p) => /Retired/i.test(p)), problems.join(' '));
});

test('an exclamation point is caught', () => {
  assert.ok(checkCopy('Earlier beats faster!').problems.some((p) => /exclamation/i.test(p)));
});

test('an ambiguous superlative is a note, not a problem', () => {
  // "the only outage that matters" is exactly the register the document asks
  // for. Calling it an error teaches people to skip the errors, which is how
  // the em dash gets through.
  const r = checkCopy('A stopped line is the only outage that matters.');
  assert.deepEqual(r.problems, []);
  assert.ok(r.notes.some((n) => /the only/.test(n)));
});

test('compliant copy is silent', () => {
  const r = checkCopy('We measure how early, not how fast. Domain coverage: 100%.');
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.notes, []);
});

// --- the renderer obeys ----------------------------------------------------

function build(content, extra = {}) {
  const parsed = normaliseSpec({
    format: 'pptx',
    title: 'Personalized and preemptive CyberSec for RadNet',
    subtitle: 'A view for the CISO',
    disclosure: 'internal_only',
    content,
    ...extra,
  });
  assert.equal(parsed.ok, true, parsed.error);
  return renderPptx(parsed.spec, { preparedBy: 'rep@vikat.ai', isoDate: '2026-09-04' }, loadFonts().metrics);
}

test('a deck built from dash-laden copy ships without one', () => {
  // The model is told not to use them and mostly will not. Mostly is how one
  // reaches a customer, so they are rewritten on the way in and the built file
  // is checked on the way out.
  const report = inspectPptx(
    build('## context | Earlier beats faster\nWe preempt early — not fast — and the difference is measurable.'),
  );
  assert.ok(!report.problems.some((p) => /dash/.test(p)), report.problems.join(' '));
});

test('the renderer\'s own furniture carries no dash either', () => {
  // The disclosure label printed on every slide was "Internal only — not for
  // customer distribution". The dash check never saw it, because the same
  // filter that stops the footer counting as slide content was hiding it.
  const report = inspectPptx(build('## context | A heading\nSome supporting context for it.'));
  assert.ok(!report.problems.some((p) => /dash/.test(p)), report.problems.join(' '));

  // And the label itself, directly: the deck above only proves the check is
  // quiet, not that the string it checks is clean.
  assert.ok(!/[—–]/.test(Object.values(DISCLOSURE_LABELS).join(' ')), 'a disclosure label still has a dash');
});

test('a dash between numbers becomes a range, not a comma', () => {
  assert.equal(brandSafe('2020–2024 saw a rise'), '2020 to 2024 saw a rise');
});

test('the fine print is on every slide the renderer builds', () => {
  // §3.2. A slide gets screenshotted and forwarded without its deck, and the
  // footer is how a reader knows who is claiming what they are reading.
  const report = inspectPptx(build('## context | A heading\nSome supporting context for it.'));
  assert.ok(!report.problems.some((p) => /fine print/.test(p)), report.problems.join(' '));
});

test('a deck missing the fine print is caught', () => {
  // Asserting the absence of a warning on a good deck proves the renderer
  // works, not that the check does — it passes just as well with the check
  // deleted. This is the one that fails when it is.
  const bare = zipSync({
    'ppt/slides/slide1.xml': strToU8(
      '<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r>' +
        '<a:t>A slide with everything except the line that says whose it is.</a:t>' +
        '</a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    ),
  });

  const report = inspectPptx(bare);
  assert.ok(report.problems.some((p) => /fine print/.test(p)), JSON.stringify(report));
});

test('the renderer’s own joins carry no dashes either', () => {
  // asText() joined a stat's value and caption with an em dash, and a bar's
  // label and value with another. The rule applies to the renderer's words
  // exactly as it applies to the model's.
  const { spec } = normaliseSpec({
    format: 'pdf',
    title: 'T',
    content: '## stat | 1.4M | patient records exposed in one breach\n\n## bars | MTTR 71 | Alert noise 90',
  });

  const text = spec.sections.map((s) => [s.title, s.body, ...s.points].join(' ')).join(' ');
  assert.ok(!/[—–]/.test(text), text);
});
