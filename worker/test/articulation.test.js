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

import { checkArticulation, ARTICULATION_BLOCK } from '../src/articulation.js';

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
