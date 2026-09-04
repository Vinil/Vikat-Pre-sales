/**
 * §3.4, §1.3, §1.4 and §3.3 — the rules that are about the deck rather than
 * about a slide.
 *
 * These are the ones a renderer gets right by accident and then loses: the
 * cover carried a tagline until somebody rewrote the title logic, and the data
 * note is on a slide only while the figure that obliges it stays put. Each
 * test below is written so that deleting the code it covers fails it, which is
 * not the same as passing on today's deck — and the difference has bitten this
 * file's neighbours twice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

import {
  POSITIONING_LINE, DECK_TAGLINE, WHO_WE_ARE, PATENTS_PENDING, DATA_NOTE,
  METRIC_CODES, MODELED_FIGURES, SUITE_WORDMARKS, carriesModeledFigure, isMetricCode,
} from '../src/documents/house.js';
import { renderPptx } from '../src/documents/pptx.js';
import { normaliseSpec, parseLayout } from '../src/documents/spec.js';
import { loadFonts } from '../src/documents/fonts.js';
import { inspectPptx } from '../src/documents/inspect.js';

const DOC = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../brand/PPT_Agent_Instructions.md'),
  'utf8',
);

function build(content, extra = {}) {
  const parsed = normaliseSpec({
    format: 'pptx',
    title: 'Personalized and preemptive CyberSec for RadNet',
    subtitle: 'A view for the CISO',
    audience: 'RadNet',
    disclosure: 'internal_only',
    content,
    ...extra,
  });
  assert.equal(parsed.ok, true, parsed.error);
  const bytes = renderPptx(parsed.spec, { preparedBy: 'rep@vikat.ai', isoDate: '2026-09-04' }, loadFonts().metrics);
  return { spec: parsed.spec, bytes };
}

/** Every slide's XML, in order. */
function slides(bytes) {
  const files = unzipSync(bytes);
  return Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]))
    .map((n) => strFromU8(files[n]));
}

const textOf = (xml) => [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(' ');

// --- the standing copy is the instruction set's ---------------------------

test('every locked line traces back to the instruction set', () => {
  // house.js is a transcription, and a transcription nobody checks describes
  // what the document used to say. The palette drifted in exactly this way.
  for (const line of [POSITIONING_LINE, DECK_TAGLINE, ...WHO_WE_ARE.points, ...METRIC_CODES, ...MODELED_FIGURES]) {
    assert.ok(DOC.includes(line), `the instruction set does not contain: ${line}`);
  }

  // The patents line is composed rather than quoted, so what is traced is its
  // subject matter.
  assert.match(DOC, /patents pending on the Semantic Context Plane and Semantic Context Loop/i);
  assert.ok(PATENTS_PENDING.includes('Semantic Context Plane'));
  assert.ok(PATENTS_PENDING.includes('Semantic Context Loop'));
});

// --- §3.4 the cover -------------------------------------------------------

test('the cover carries the tagline, the positioning line and all three suite wordmarks', () => {
  const cover = slides(build('## context | A heading\nSome supporting context.').bytes)[0];
  const words = textOf(cover);

  assert.ok(words.includes(DECK_TAGLINE), 'no tagline on the cover');
  assert.ok(words.includes('Personalized and Preemptive CyberSec and SRE'), 'no positioning line');
  for (const { prefix } of SUITE_WORDMARKS) {
    assert.ok(words.includes(prefix), `${prefix}Semantic is missing from the cover`);
  }

  // Two tone, per §2.3: the prefix and "Semantic" are separate runs, so the
  // mark can be one word in two colours. One run would mean one colour.
  assert.match(cover, /<a:t>Sec<\/a:t>/);
  assert.match(cover, /<a:t>Semantic<\/a:t>/);
});

test('the cover is the gradient, not a band of it', () => {
  // §3.3 allows the gradient on exactly two slides. Spending a tenth of the
  // allowance on each obeyed the letter of a rule whose point is that the ends
  // of a deck look different from its middle.
  const [cover] = slides(build('## context | A heading\nSome context.').bytes);
  assert.match(cover, /<a:gradFill/, 'the cover has no gradient at all');

  const boxes = [...cover.matchAll(/<a:ext cx="(\d+)" cy="(\d+)"\/>/g)].map((m) => ({
    w: Number(m[1]) / 914400,
    h: Number(m[2]) / 914400,
  }));
  assert.ok(
    boxes.some((b) => b.w > 13 && b.h > 7),
    `no full-bleed shape on the cover: ${JSON.stringify(boxes.slice(0, 3))}`,
  );
});

// --- §3.4 the credentials close and the thank you -------------------------

test('a deck closes with who we are and then thank you', () => {
  const { bytes } = build('## context | A heading\nSome supporting context.');
  const built = slides(bytes);

  const whoWeAre = textOf(built[built.length - 2]);
  assert.ok(whoWeAre.includes(WHO_WE_ARE.title), 'the credentials close is missing');
  for (const point of WHO_WE_ARE.points) {
    assert.ok(whoWeAre.includes(point.slice(0, 40)), `standing copy missing: ${point.slice(0, 40)}`);
  }

  // §1.2: credentials never open a deck.
  assert.ok(!textOf(built[0]).includes(WHO_WE_ARE.title));
});

test('a deck that already says who it is does not say it twice', () => {
  const { bytes } = build('## Who we are | We work inside your team.\nNamed engineers, on your rota.');
  const count = slides(bytes).filter((s) => textOf(s).includes(WHO_WE_ARE.title)).length;
  assert.equal(count, 0, 'the standing slide was added on top of the deck own');
});

test('the thank you carries the whole disclaimer block', () => {
  // §3.4 names four things. All four, or a rep forwards a slide that claims
  // modeled numbers as results with nothing on it saying otherwise.
  const built = slides(build('## context | A heading\nSome context.').bytes);
  const last = textOf(built[built.length - 1]);

  assert.ok(last.includes('trademarks of Vikat.AI'), 'no trademark line');
  assert.ok(last.includes(PATENTS_PENDING), 'no patents pending line');
  assert.ok(last.includes(DATA_NOTE), 'no modeled data disclaimer');
  assert.match(last, /Confidential/, 'no confidentiality line');
});

// --- §1.4 the data note ---------------------------------------------------

test('a modeled figure is recognised and a lookalike is not', () => {
  assert.equal(carriesModeledFigure('70,000 events a month'), true);
  assert.equal(carriesModeledFigure('70000 events a month'), true, 'separators are not the obligation');
  assert.equal(carriesModeledFigure('700 preempted'), true);
  assert.equal(carriesModeledFigure('8,700 alerts triaged'), false, '700 inside 8,700 is not 700');
  assert.equal(carriesModeledFigure('418 imaging centers'), false);
});

test('a slide with a modeled figure gets the data note beside it', () => {
  const { spec, bytes } = build('## stat | 70,000 | events enriched with semantic context each month');

  const carrying = slides(bytes).filter((s) => textOf(s).includes('70,000'));
  assert.equal(carrying.length, 1);
  assert.ok(carrying[0].includes(DATA_NOTE), 'the figure shipped without its note');

  // And a slide with no modeled figure does not collect a note it does not
  // need: a disclaimer on a sourced number reads as a hedge on all of them.
  const clean = build('## stat | 418 | imaging centers on one platform');
  const plain = slides(clean.bytes).filter((s) => textOf(s).includes('418'));
  assert.equal(plain.length, 1);
  assert.ok(!plain[0].includes(DATA_NOTE), 'the note was added to a sourced figure');

  assert.deepEqual(inspectPptx(bytes, spec).problems, []);
});

test('the inspector catches a modeled figure with no note', () => {
  // The test above passes just as well with the check deleted. This one does
  // not: the slide is built by hand, with the figure and without the note.
  const bare = zipSync({
    'ppt/slides/slide1.xml': strToU8(
      '<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>70,000 events enriched every month, ' +
        'which is a claim this slide makes entirely on its own.</a:t></a:r>' +
        '</a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    ),
  });

  const report = inspectPptx(bare);
  assert.ok(
    report.problems.some((p) => /modeled figure/.test(p)),
    `no warning: ${JSON.stringify(report.problems)}`,
  );
});

// --- §1.3 the metric system -----------------------------------------------

test('a KPI code outside the published system is a problem', () => {
  assert.equal(isMetricCode('MTTD'), true);
  assert.equal(isMetricCode('MTTX'), false);

  const { spec, bytes } = build('## kpi | The measures | MTTX: 30 days from baseline');
  const report = inspectPptx(bytes, spec);
  assert.ok(report.problems.some((p) => /MTTX/.test(p)), JSON.stringify(report.problems));

  const good = build('## kpi | The measures | MTTD: 30 days from baseline');
  assert.deepEqual(inspectPptx(good.bytes, good.spec).problems, []);
});

// --- §3.1 and §3.5 the eyebrow --------------------------------------------

test('a drawn heading can carry an eyebrow, and it reaches the slide', () => {
  const parsed = parseLayout('kpi ^ Our commitment | The measures | MTTD: 30 days from baseline');
  assert.equal(parsed.eyebrow, 'Our commitment');
  assert.equal(parsed.title, 'The measures');

  const { bytes } = build('## kpi ^ Our commitment | The measures | MTTD: 30 days from baseline');
  const withIt = slides(bytes).filter((s) => /OUR COMMITMENT/.test(textOf(s)));
  assert.equal(withIt.length, 1, 'the eyebrow did not reach a slide');
});

test('a line written under a drawn heading reaches the slide', () => {
  // §3.5 asks every slide for at least one line of supporting context. A
  // drawn heading takes its title from the pipes, so the prose under it had
  // nowhere to go and no layout rendered it: the rep saw the sentence in
  // their own request and never on the slide.
  const line = 'Severity scoring is calendar blind, and the queue does not know it.';
  const { bytes } = build(`## paradigm ^ The shift | Where it changes | Ranked by severity | Ranked by cost\n${line}`);

  const carrying = slides(bytes).filter((sl) => textOf(sl).includes(line));
  assert.equal(carrying.length, 1, 'the supporting line was dropped');
});

test('an outcome band is not also printed as a subtitle', () => {
  // asText() gives pdf.js the band's sentence as the section body, so the
  // pptx head drew it too and the slide said the same thing twice.
  const sentence = 'Fixed retainer. The bonus is paid only against these metrics.';
  const { bytes } = build(`## outcome ^ Our commitment | Skin in the game | SKIN IN THE GAME | ${sentence}`);

  const slide = slides(bytes).find((sl) => textOf(sl).includes('SKIN IN THE GAME'));
  const occurrences = textOf(slide).split('Fixed retainer').length - 1;
  assert.equal(occurrences, 1, 'the band sentence is on the slide twice');
});

test('a caret in a heading that is not a layout is still not a layout', () => {
  assert.equal(parseLayout('not a layout ^ Something | a | b'), null);
});

// --- §3.3 rhythm ----------------------------------------------------------

test('two identical layouts back to back are called out', () => {
  const { spec, bytes } = build(
    [
      '## stat | 418 | imaging centers on one platform',
      '',
      '## stat | 1.4M | records exposed at a peer',
    ].join('\n'),
  );

  const report = inspectPptx(bytes, spec);
  assert.ok(report.notes.some((n) => /back to back/.test(n)), JSON.stringify(report.notes));
});

test('alternating layouts are not', () => {
  const { spec, bytes } = build(
    [
      '## stat | 418 | imaging centers on one platform',
      '',
      '## paradigm | Where it changes | Ranked by severity | Ranked by what a stopped line costs',
    ].join('\n'),
  );

  assert.ok(!inspectPptx(bytes, spec).notes.some((n) => /back to back/.test(n)));
});

test('the rhythm check is quiet when it has no spec to check', () => {
  // documents/index.js passes one; older callers do not, and a check that
  // throws on a missing argument would take the whole report down with it.
  const { bytes } = build('## context | A heading\nSome context.');
  assert.doesNotThrow(() => inspectPptx(bytes));
});
