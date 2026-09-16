/**
 * How the writing sounds.
 *
 * Every other check here is about facts. This one is about whether a
 * stakeholder reads two sentences and keeps going — and whether the copy
 * announces that a machine wrote it, which is the thing a reader who sees
 * twenty of these a week has learned to skip.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkArticulation,
  checkHeadline,
  checkIntroduction,
  ARTICULATION_BLOCK,
  STORY_ARC,
} from '../src/articulation.js';

const notes = (t) => checkArticulation(t).notes.join(' | ');

test('an opener that would fit any company is called out', () => {
  // The first line is the only one guaranteed to be read, so it gets its own
  // check rather than being one more hit in a list.
  const n = notes("In today's rapidly evolving threat landscape, security teams face challenges.");
  assert.match(n, /would fit any company/);
});

test('a specific opener raises nothing', () => {
  // The check must not fire on good copy. A warning that cries wolf is one
  // reps learn to skip, and then the real one goes unread.
  assert.equal(
    notes('McLane opened a tech hub in Austin in August and is deploying AI agents into operations.'),
    '',
  );
});

test('the words that arrive by default rather than by choice', () => {
  const n = notes('We leverage robust, seamless tooling to unlock transformative value.');
  assert.match(n, /Reads as generated/);
  for (const w of ['leverage', 'robust', 'seamless', 'unlock']) assert.match(n, new RegExp(w));
});

test('the shapes people actually notice', () => {
  assert.match(notes("It's not just a scanner, it's a context layer."), /it's not just X/i);
  assert.match(notes('Not only does it detect, but also it prevents.'), /not only X but also/i);
  assert.match(notes('Moreover, the platform scales.'), /essay connective/);
  assert.match(notes('I hope this helps.'), /assistant's sign-off/);
  assert.match(notes('This can help to potentially reduce dwell time.'), /stacked hedging/);
});

test('emoji are out, in any material', () => {
  assert.match(notes('Great news 🚀 for your team.'), /No emoji/);
});

test('sentences that run long are measured, not guessed at', () => {
  // "Short sentences, plain words" has a number behind it, and copy averaging
  // thirty words a sentence is not what either guidelines document describes.
  const long = Array.from({ length: 4 }, () =>
    'The platform provides a comprehensive and deeply integrated approach to the ongoing management of security context across the entire enterprise estate, including every workload, every data store and every agent that might reasonably need to consult it during an incident.',
  ).join(' ');
  assert.match(notes(long), /words a sentence/);
});

test('short declarative copy is left alone', () => {
  // Spare, declarative, technical. This is the target, and nothing should fire.
  assert.equal(
    notes('BerryGPT went live in March. It reads from the same stores your pickers use. Worth twenty minutes?'),
    '',
  );
});

test('empty copy is not a finding', () => {
  assert.deepEqual(checkArticulation('').notes, []);
  assert.deepEqual(checkArticulation(null).notes, []);
});

test('the prompt block says what to do, not what to admire', () => {
  // "Be direct" is not actionable. "The outcome first, in the first sentence"
  // is. The block is instructions or it is decoration.
  assert.match(ARTICULATION_BLOCK, /outcome first, in the first sentence/);
  assert.match(ARTICULATION_BLOCK, /must not read as though a machine wrote it/);
  assert.match(ARTICULATION_BLOCK, /pick the shorter, plainer option/);
  assert.match(ARTICULATION_BLOCK, /Address the reader as "you"/);
  // Named tells, so the model has something to avoid rather than a mood.
  for (const w of ['leverage', 'seamless', 'Moreover']) {
    assert.match(ARTICULATION_BLOCK, new RegExp(w));
  }
});

// --- the story, the headlines, and not praising your own work --------------

test('the arc starts where the reader already feels good', () => {
  // Not a template. The current decks open on the problem, which reads as a
  // stranger telling you what is wrong with your company. Someone rolling AI
  // agents across 418 sites is proud of that, and rightly.
  assert.deepEqual(
    STORY_ARC.map((s) => s.beat),
    ['Personalize', 'Their priorities', 'Why now', 'How we accelerate', 'Next steps'],
  );
  // Each beat says what it does AND how it fails: a beat with no failure mode
  // is a heading, and a writer cannot tell whether they hit it.
  for (const s of STORY_ARC) {
    assert.ok(s.does && s.fails, `${s.beat} has no failure mode`);
  }
  assert.match(STORY_ARC[1].fails, /opportunity, not deficiency/i);
});

test('a headline built on a product name is a closed door', () => {
  const n = checkHeadline('SecSemantic for McLane').notes.join(' ');
  assert.match(n, /never heard of/);
  assert.match(n, /once the idea has landed/);
});

test('inside words are fine in the body, wrong in the headline', () => {
  // The rule is about the ONE line guaranteed to be read, not about the
  // vocabulary as a whole.
  assert.equal(checkHeadline('').notes.length, 0);
  assert.ok(checkHeadline('The Security Context Plane').notes.length > 0);
  assert.equal(
    checkArticulation('SecSemantic builds a system of record for consequence.').notes.length,
    0,
    'the product name in prose is not a finding',
  );
});

test('a headline that labels rather than says', () => {
  for (const h of ['The commitment model', 'How the suite fits', 'Our approach', 'Overview']) {
    assert.match(checkHeadline(h).notes.join(' '), /labels the slide/, h);
  }
});

test('a headline that makes a point passes', () => {
  for (const h of [
    'Two surfaces now land on every healthcare CISO desk',
    'Your agents reach patient data faster than your reviews do',
  ]) {
    assert.equal(checkHeadline(h).notes.length, 0, h);
  }
});

test('the assistant does not call its own work ready', () => {
  // On a deck stamped DRAFT, NEEDS APPROVAL BEFORE IT LEAVES VIKAT, "ready for
  // customer use" is not just chatbot flavour. It is false.
  for (const s of [
    'The deck is ready for customer use.',
    'This is a polished, client-ready one-pager.',
    'Your presentation-ready deck is attached.',
  ]) {
    assert.match(notes(s), /rep decides that/, s);
  }
  assert.equal(notes('The deck is built. Check the 48 versus 60 country figure before it goes out.'), '');
});

test('the prompt carries the arc, the headline rule and the visual rule', () => {
  // A checker catches it after the fact; the prompt is what stops it being
  // written. Both, or the model writes it and the rep reads a complaint.
  assert.match(ARTICULATION_BLOCK, /Every headline answers "why should I care"/);
  assert.match(ARTICULATION_BLOCK, /SecSemantic for McLane/);
  assert.match(ARTICULATION_BLOCK, /Personalize/);
  assert.match(ARTICULATION_BLOCK, /Why now/);
  assert.match(ARTICULATION_BLOCK, /One ask, small enough to say yes to/);
  assert.match(ARTICULATION_BLOCK, /A deck is looked at, not read/);
  assert.match(ARTICULATION_BLOCK, /Never call your own work ready/);

  // A checker that reports a missing introduction after the PDF exists costs
  // the rep a round trip. The prompt is what stops it being written that way.
  assert.match(ARTICULATION_BLOCK, /Say who we are before you use our words/);
  assert.match(ARTICULATION_BLOCK, /Introduce, then name, then explain/);
  assert.match(ARTICULATION_BLOCK, /A headline is a sentence, not a noun phrase/);
});

test('the dash rule is checked here, not only where copy is rendered', () => {
  // §07's first rule, and it was missing until the message announcing this
  // component was run through it and came back clean while containing three.
  // noDashes() is applied in outreach.js and through brandSafe, so the rule
  // was enforced in both places that RENDER and neither place that READS.
  assert.match(notes('Two surfaces — both new — land this quarter.'), /2 dashes in the copy/);
  assert.match(notes('One thought – then another.'), /1 dash in the copy/);
  assert.match(notes('A dash here — like this.'), /comma, a full stop or a new sentence/);
  // A hyphen inside a word is not a dash.
  assert.equal(notes('Vendor-neutral, self-hosted, board-ready.'), '');
});

// --- Who we are -------------------------------------------------------------

/** A customer-bound spec, so each test varies one thing. */
const brief = (over = {}) => ({
  disclosure: 'external_ok',
  title: 'Your fulfillment window is your attackers’ calendar.',
  subtitle: 'What a severity score cannot see.',
  sections: [
    { title: 'The calendar sets the price.', body: 'Severity scoring cannot see the calendar.', points: [] },
  ],
  ...over,
});

const intro = (spec) => checkIntroduction(spec).problems.join(' | ');

test('a product named before Vikat is introduced is a problem', () => {
  // "All of a sudden there's a reference of SecSemantic." checkHeadline
  // already refused an inside word in a HEADLINE, and that rule was working:
  // the brief kept its product names out of its headings and put SecSemantic
  // in the body, where nothing was looking. The rule was never about
  // headlines. It is about a reader meeting a word they cannot parse.
  const spec = brief();
  spec.sections[0].points = ['SecSemantic reads the alert stream alongside Splunk.'];

  const p = intro(spec);
  assert.match(p, /SecSemantic is named before/);
  assert.match(p, /Introduce Vikat and what it does first/);
});

test('order is the whole point: the same two sentences, the other way round', () => {
  // Not "does the document contain both". A reader meets them in order, and
  // the fault is meeting the product first. Swapping nothing but the sequence
  // has to change the verdict, or this is measuring presence, not position.
  const before = brief({
    sections: [
      { title: 'A', body: 'SecSemantic reads the alert stream.', points: [] },
      { title: 'B', body: 'Vikat builds the semantic context layer for security operations.', points: [] },
    ],
  });
  const after = brief({
    sections: [
      { title: 'A', body: 'Vikat builds the semantic context layer for security operations.', points: [] },
      { title: 'B', body: 'SecSemantic reads the alert stream.', points: [] },
    ],
  });

  assert.match(intro(before), /named before/);
  assert.equal(intro(after), '');
});

test('a document with no introduction at all is a problem', () => {
  // "No introduction of Vikat and what we stand for and do." A brief that
  // never says whose advice this is, to somebody who has not met us.
  assert.match(intro(brief()), /Nothing here says who Vikat is/);
});

test('a signature is not an introduction', () => {
  // The copyright line and the sender block both name us on every page, so a
  // check that only looked for the word would come back clean on the exact
  // document that prompted this.
  const signature = brief({
    sections: [{ title: 'A', body: 'Severity scoring cannot see the calendar.', points: ['Vikat.AI'] }],
  });
  assert.match(intro(signature), /Nothing here says who Vikat is/);

  const sentence = brief({
    sections: [
      { title: 'A', body: 'Vikat builds the semantic context layer for security operations.', points: [] },
    ],
  });
  assert.equal(intro(sentence), '');
});

test('an internal document may open on its own vocabulary', () => {
  // A deal review may say SecSemantic in its first line, because everybody
  // reading it has heard of SecSemantic. The rule is about strangers.
  const internal = brief({ disclosure: 'internal_only' });
  internal.sections[0].points = ['SecSemantic reads the alert stream.'];
  assert.equal(intro(internal), '');

  // But a draft awaiting approval is checked: approval is the last gate before
  // it leaves, which is exactly when a missing introduction has to be caught.
  const draft = brief({ disclosure: 'needs_approval' });
  draft.sections[0].points = ['SecSemantic reads the alert stream.'];
  assert.match(intro(draft), /named before/);
});

test('a spec with no disclosure is treated as internal, not as a customer document', () => {
  // normaliseSpec's own default for an unknown value is the cautious one, and
  // this has to match it. The other way round, every hand-built spec became a
  // customer document with a missing introduction.
  assert.equal(intro(brief({ disclosure: undefined })), '');
  assert.equal(intro(brief({ disclosure: 'obviously_fine' })), '');
});

// --- Cryptic headlines ------------------------------------------------------

const headline = (h) => checkHeadline(h).notes.join(' | ');

test('a headline with no verb is a gesture, not a claim', () => {
  // "The articulation including headlines that are cryptic." LABEL_HEADLINES
  // already caught the filing labels — "Our approach", "Overview" — and it
  // does not catch these, because these are not labels. They are gestures:
  // evocative, and the reader has to reach the body to find out what was
  // meant, which is the opposite of what a headline is for.
  for (const h of ['Beyond detection', 'The quiet shift', 'Under pressure', 'The calendar problem']) {
    assert.match(headline(h), /no verb in it/, h);
  }
});

test('a headline that makes a claim passes, however short', () => {
  // The direction this has to be wrong in. An advisory note that fires on good
  // headlines gets the whole report skipped, and then so does the real one.
  for (const h of [
    'The question has moved',
    'The fulfillment window is the asset',
    'Where the budget already is',
    'What we would need from you',
    'The calendar sets the price of an intrusion.',
    'Three surfaces now land on every healthcare CISO’s desk',
    'Your fulfillment window is your attackers’ calendar.',
  ]) {
    assert.equal(headline(h), '', h);
  }
});

test('a filing label gets the label note and not both', () => {
  // A drawer label is also a noun phrase, so it satisfies both rules. One
  // headline, one note: the label message is the more specific of the two and
  // already says what to do next.
  const n = checkHeadline('Our approach').notes;
  assert.equal(n.length, 1, n.join(' | '));
  assert.match(n[0], /labels the slide/);
});

test('a one-word headline is not judged on its grammar', () => {
  // "Overview" is caught as a label. A single word that is not one of those is
  // a section marker and has no room for a verb; flagging it says nothing a
  // writer can act on.
  assert.equal(headline('Timing'), '');
});
