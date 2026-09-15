/**
 * The brand guidelines, as something a generator obeys.
 *
 * Source: "The Semantic Suite — Brand Guidelines", Vikat, v1.0, 2026,
 * confirmed authoritative for the visual system over the TM3 trademark
 * documentation, which specifies a different typeface, palette and mark.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkGuidelines,
  suitesMentioned,
  SUITE_ACCENTS,
  NEUTRALS,
  TYPE,
  PLANES,
  THE_LINE,
  CONFLICTS,
} from '../src/documents/guidelines.js';

const spec = (sections, extra = {}) => ({ title: 'Deck', sections, ...extra });
const sec = (o) => ({ eyebrow: '', title: '', body: '', points: [], ...o });
const problems = (s) => checkGuidelines(s).problems.join(' | ');
const notesOf = (s) => checkGuidelines(s).notes.join(' | ');

test('the values are the ones in the document', () => {
  // Traced back to the section that mandates them. A hex that drifts should be
  // traceable to a document that did or did not change.
  assert.equal(SUITE_ACCENTS.SecSemantic.accent, '#009CB4');
  assert.equal(SUITE_ACCENTS.DevSemantic.accent, '#6054D8');
  assert.equal(SUITE_ACCENTS.ProSemantic.accent, '#C0741A');
  assert.equal(NEUTRALS.ink, '#121417');
  assert.equal(TYPE.headline.family, 'Inter');
  assert.equal(TYPE.mono.family, 'JetBrains Mono');
  assert.deepEqual(PLANES, ['SCP', 'DCP', 'PCP']);
  assert.match(THE_LINE, /^The vendor-neutral semantic context layer/);
});

test('each suite owns exactly one accent and one plane', () => {
  const planes = Object.values(SUITE_ACCENTS).map((s) => s.plane);
  assert.deepEqual(planes, PLANES, 'a suite without its plane is half a rule');
  const accents = Object.values(SUITE_ACCENTS).map((s) => s.accent);
  assert.equal(new Set(accents).size, 3, 'two suites sharing an accent is the thing §04 forbids');
});

test('two accents on one surface is the rule decks break', () => {
  // §04: "Accents are never mixed within a single surface." A deck drafted
  // from two suites' material breaks it without anybody noticing.
  const p = problems(
    spec([sec({ title: 'SecSemantic for security' }), sec({ title: 'DevSemantic for coding agents' })]),
  );
  assert.match(p, /SecSemantic and DevSemantic/);
  assert.match(p, /one surface takes one accent/);
});

test('one suite, however often it is named, is fine', () => {
  const p = problems(
    spec([sec({ title: 'SecSemantic' }), sec({ body: 'SecSemantic again, and SCP.' })]),
  );
  assert.equal(p, '');
});

test('plane names are always uppercase', () => {
  assert.match(problems(spec([sec({ body: 'The scp holds the context.' })])), /"scp" should be SCP/);
  assert.equal(problems(spec([sec({ body: 'The SCP holds the context.' })])), '');
});

test('a suite name is one closed word', () => {
  assert.match(problems(spec([sec({ title: 'Sec Semantic' })])), /one closed word: SecSemantic/);
  assert.match(problems(spec([sec({ title: 'Dev-Semantic' })])), /one closed word: DevSemantic/);
});

test('bullets take a dot, never a dash', () => {
  // §07. The renderer sets the glyph, so this is a dash typed INSIDE the point.
  assert.match(problems(spec([sec({ points: ['- the fine', 'the outage'] })])), /never a dash/);
  assert.equal(problems(spec([sec({ points: ['the fine', 'the outage'] })])), '');
});

test('a shouted headline is a note, not a refusal', () => {
  // §05: uppercase belongs to mono kickers. But voice is a judgement and a
  // deck five minutes before a call is still a deck.
  const out = checkGuidelines(spec([sec({ title: 'SECURITY CONTEXT EVERYWHERE' })]));
  assert.equal(out.problems.length, 0);
  assert.match(out.notes.join(' '), /sentence case/);
});

test('a short headline in caps is left alone', () => {
  // SCP, DCP, an acronym in a title: not shouting.
  assert.equal(notesOf(spec([sec({ title: 'SCP' })])), '');
});

test('suitesMentioned names them rather than counting', () => {
  // The finding a rep can act on is "this deck wears two accents", not "2".
  assert.deepEqual(suitesMentioned(spec([sec({ title: 'ProSemantic and SecSemantic' })])), [
    'SecSemantic',
    'ProSemantic',
  ]);
});

test('the conflicts are recorded rather than quietly settled', () => {
  // Three documents give three different lines and two different legal
  // entities. Picking is a brand decision, and no source file is entitled to
  // make one silently.
  const topics = CONFLICTS.map((c) => c.topic);
  assert.ok(topics.includes('The line'));
  assert.ok(topics.includes('Legal entity'));
  for (const c of CONFLICTS) {
    assert.ok(c.guidelines && c.elsewhere && c.note, `${c.topic} records only one side`);
  }
});

test('generating a document actually runs the guidelines check', async () => {
  // The component the user asked for is one that IS CALLED, not one that
  // exists. A checker nothing invokes is a file, and this repo has already
  // shipped a guard that never fired.
  const { createDocument } = await import('../src/documents/index.js');
  const { loadFonts } = await import('../src/documents/fonts.js');
  const { createStorage } = await import('../src/storage.js');
  const { loadConfig } = await import('../src/config.js');
  const { fakeKV } = await import('./helpers.js');

  const cfg = loadConfig({});
  const out = await createDocument(
    {
      title: 'Two suites, one deck',
      format: 'pdf',
      audience: 'internal',
      // The §04 breach, in the shape a real deck reaches us in.
      content: '## SecSemantic | Security context\nFor Sec agents.\n\n## DevSemantic | Coding context\nFor Dev agents.',
    },
    {
      storage: createStorage({ VIKAT_KV: fakeKV() }, cfg),
      user: { email: 'rep@vikat.ai', name: 'Rep' },
      env: {},
      cfg,
      fonts: loadFonts(),
    },
  );

  assert.equal(out.ok, true, out.error);
  // inspectionSummary is what reaches the rep and the model, and a problem
  // prefixes it with "Check before sending".
  assert.match(
    out.inspection,
    /one surface takes one accent/,
    'the guidelines check did not run on a generated document',
  );
  assert.match(out.inspection, /^Check before sending/);
});

test('the check runs on a PDF, which inspectPptx cannot even open', async () => {
  // inspectPptx unzips a .pptx. A one-pager wearing two accents is as far
  // outside the guidelines as a deck is, and was previously unchecked.
  const { checkGuidelines } = await import('../src/documents/guidelines.js');
  const out = checkGuidelines({
    title: 'One pager',
    sections: [{ title: 'SecSemantic', points: [] }, { title: 'ProSemantic', points: [] }],
  });
  assert.equal(out.problems.length, 1);
});
