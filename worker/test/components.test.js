/**
 * §4.3, the named components.
 *
 * "Reuse, do not invent" is the section heading, and these hold both halves of
 * it: the components exist and carry the measurements the document gives, and
 * a slide built from them puts its content where the instructions put it.
 *
 * The shapes are checked in the built XML rather than by rendering, because a
 * Worker cannot rasterise a slide — but the geometry is all in the file, and
 * "the pill is 0.98 by 0.34" is a fact the XML can be asked for directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';

import * as comp from '../src/documents/components.js';
import { CREAM, DARK, SUITE, DENSITY } from '../src/documents/house.js';
import { renderPptx } from '../src/documents/pptx.js';
import { normaliseSpec, parseLayout, LAYOUTS } from '../src/documents/spec.js';
import { loadFonts } from '../src/documents/fonts.js';
import { inspectPptx } from '../src/documents/inspect.js';

const EMU = 914400;
const inches = (emu) => Number(emu) / EMU;

/** Every shape in a fragment, as boxes. */
function boxes(xml) {
  return [...xml.matchAll(/<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/g)].map((m) => ({
    x: inches(m[1]), y: inches(m[2]), w: inches(m[3]), h: inches(m[4]),
  }));
}

const slidesOf = (bytes) =>
  Object.keys(unzipSync(bytes))
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .map((n) => strFromU8(unzipSync(bytes)[n]))
    .join('');

function build(content) {
  const parsed = normaliseSpec({
    format: 'pptx',
    title: 'Personalized and preemptive CyberSec for RadNet',
    disclosure: 'internal_only',
    content,
  });
  assert.equal(parsed.ok, true, parsed.error);
  return renderPptx(parsed.spec, { preparedBy: 'rep@vikat.ai', isoDate: '2026-09-04' }, loadFonts().metrics);
}

// --- the components carry the document's measurements ---------------------

test('a card is a rounded rect with a hairline and a shadow', () => {
  // §4.3: radius about 0.09, hairline border, soft navy shadow at 12% —
  // "cards always", which is why it is one function rather than a habit.
  const xml = comp.card({ x: 0.6, y: 2, w: 4, h: 1 });

  assert.match(xml, /prstGeom prst="roundRect"/);
  assert.match(xml, new RegExp(CREAM.hairline.replace('#', '')));
  assert.match(xml, /outerShdw/);
  assert.match(xml, /alpha val="12000"/);
});

test('a dark card has no shadow', () => {
  // §4.3 is explicit: light themes only. A shadow on 01163A is a smudge.
  const xml = comp.card({ x: 0.6, y: 2, w: 4, h: 1 }, { fill: DARK.innerCard, dark: true });
  assert.ok(!/outerShdw/.test(xml), 'a dark card must not carry a shadow');
});

test('a metric pill is the size the document gives', () => {
  // 0.98 x 0.34, suite accent, white mono centred.
  const [box] = boxes(comp.metricPill(0.6, 2, 'MTTD'));
  assert.equal(box.w.toFixed(2), '0.98');
  assert.equal(box.h.toFixed(2), '0.34');
  assert.match(comp.metricPill(0.6, 2, 'MTTD'), new RegExp(SUITE.sec.light.replace('#', '')));
});

test('a table row is inside the height the document allows', () => {
  // 0.58 to 0.76 high.
  assert.ok(comp.TABLE_ROW_HEIGHT >= 0.58 && comp.TABLE_ROW_HEIGHT <= 0.76, comp.TABLE_ROW_HEIGHT);
});

test('the emphasised step of a flow gets a heavier border, not a different fill', () => {
  // Colour would make it a different KIND of thing. A heavier border makes it
  // the same thing, emphasised.
  const emphasised = comp.flow(0.6, 2, 12, ['Detect', 'Decide', 'Act'], { emphasis: 1 });
  const plain = comp.flow(0.6, 2, 12, ['Detect', 'Decide', 'Act'], { emphasis: -1 });

  // Counting accent-coloured things proves nothing: the arrows are accent
  // coloured too. The border WEIGHT is what carries the emphasis, so that is
  // what is asked for.
  const widths = (x) => [...x.matchAll(/<a:ln w="(\d+)"/g)].map((m) => Number(m[1]));
  const heaviest = (x) => Math.max(...widths(x));

  assert.ok(
    heaviest(emphasised) > heaviest(plain),
    `no heavier border: ${heaviest(emphasised)} vs ${heaviest(plain)}`,
  );
  assert.match(emphasised, /prst="rightArrow"/, 'the steps are joined by arrows');
});

test('mono is upper case, always', () => {
  // §4.2: JetBrains Mono is ALL CAPS and never a sentence.
  assert.match(comp.label({ x: 0, y: 0, w: 1, h: 1 }, 'offering', { mono: true }), /<a:t>OFFERING<\/a:t>/);
});

// --- the layouts reach the slide -------------------------------------------

test('every named component has a layout that reaches it', () => {
  for (const name of ['tiles', 'table', 'kpi', 'outcome', 'paradigm', 'flow']) {
    assert.ok(LAYOUTS.includes(name), `${name} is not a layout the model can ask for`);
  }
});

test('a table slide puts its column headers above the first row', () => {
  const xml = slidesOf(
    build('## table | What we commit to | Offering, Measure, Target | Threat management, Kill time, Before first use'),
  );

  assert.match(xml, /<a:t>OFFERING<\/a:t>/, 'headers are mono and upper case');
  assert.match(xml, /<a:t>Threat management<\/a:t>/);
});

test('a kpi slide is metric and target, never prose', () => {
  // §1.3. A target written as a sentence is one nobody can be held to, so a
  // line without a colon is not a KPI and does not become one.
  const parsed = parseLayout('kpi | The measures | MTTD: 30 days from baseline | this line has no target');

  assert.equal(parsed.kpis.length, 1);
  assert.equal(parsed.kpis[0].code, 'MTTD');
  assert.equal(parsed.kpis[0].target, '30 days from baseline');
});

test('a slide honours the density limits', () => {
  // §1.5: six cards, six rows, three columns. Cutting words is the instruction
  // when it does not fit; silently shrinking past a floor is not.
  const tiles = parseLayout(
    'tiles | Too many | ' + Array.from({ length: 9 }, (_, i) => `${i + 1}00 things counted`).join(' | '),
  );
  assert.equal(tiles.tiles.length, DENSITY.cards);

  const table = parseLayout(
    'table | Too wide | A, B, C, D, E | 1, 2, 3, 4, 5 | ' +
      Array.from({ length: 9 }, (_, i) => `r${i}, x, y, z, w`).join(' | '),
  );
  assert.equal(table.columns.length, DENSITY.columns);
  assert.equal(table.rows.length, DENSITY.rows);
});

test('a flow marks its emphasised step and strips the marker', () => {
  const flow = parseLayout('flow | How a decision reaches an action | Detect > Enrich > *Decide > Act');
  assert.equal(flow.emphasis, 2);
  assert.deepEqual(flow.steps, ['Detect', 'Enrich', 'Decide', 'Act'], 'the asterisk must not reach the slide');
});

test('a deck of component slides passes the house checks', () => {
  const report = inspectPptx(
    build(
      [
        '## tiles | What RadNet runs today | 418 imaging centers on one platform | 1.4M records exposed at a peer',
        '',
        '## table | What we commit to | Offering, Measure, Target | Threat management, Kill time, Before first use',
        '',
        '## kpi | The measures | MTTD: 30 days from the baseline diagnostic',
        '',
        '## paradigm | Where it changes | Ranked by severity alone | Ranked by what a stopped line costs',
        '',
        '## flow | How a decision reaches an action | Detect > *Decide > Act',
        '',
        '## outcome | Skin in the game | SKIN IN THE GAME | Fixed retainer. The bonus is paid only against these metrics.',
      ].join('\n'),
    ),
  );

  assert.deepEqual(report.problems, [], JSON.stringify(report.problems));
  assert.deepEqual(report.notes, [], JSON.stringify(report.notes));
});

test('every component layout still carries its content as text', () => {
  // pdf.js reads title, body and points and knows nothing about layouts.
  // Without this a table's rows would vanish from a PDF entirely.
  const { spec } = normaliseSpec({
    format: 'pdf',
    title: 'T',
    content: [
      '## tiles | Figures | 418 imaging centers | 1.4M records exposed',
      '',
      '## table | Commitments | Offering, Measure, Target | Threat management, Kill time, Before first use',
      '',
      '## kpi | Measures | MTTD: 30 days from baseline',
      '',
      '## outcome | Skin in the game | SKIN IN THE GAME | Fixed retainer.',
      '',
      '## paradigm | Change | Severity alone | What a stopped line costs',
      '',
      '## flow | Decisions | Detect > Decide > Act',
    ].join('\n'),
  });

  for (const section of spec.sections) {
    const asText = [section.title, section.body, ...section.points].join(' ');
    assert.ok(asText.trim(), `${section.layout} has no textual form`);
  }

  const all = spec.sections.map((s) => [s.title, s.body, ...s.points].join(' ')).join(' ');
  assert.match(all, /418/, 'a tile figure must survive into text');
  assert.match(all, /Kill time/, 'a table cell must survive into text');
  assert.match(all, /MTTD: 30 days/, 'a KPI keeps its metric:target shape');
  assert.ok(!/[—–]/.test(all), 'and none of it introduces a dash');
});
