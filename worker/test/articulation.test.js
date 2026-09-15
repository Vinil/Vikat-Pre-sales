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

import { checkArticulation, checkHeadline, ARTICULATION_BLOCK, STORY_ARC } from '../src/articulation.js';

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
});
