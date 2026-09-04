/**
 * The template is the source of truth, and this is what makes that true.
 *
 * brand.js used to be a transcription: someone read the deck, typed the
 * colours in, and the two drifted. The accents ended up close but wrong, the
 * ground ended up white when the template is cream, and nothing anywhere
 * noticed — the renderer was self-consistent and confidently off-brand.
 *
 * So brand.js is now checked against the template itself. When the deck
 * changes, these fail and name what moved.
 *
 * Deliberately NOT a check that every template colour appears in brand.js: a
 * deck legitimately uses shades a renderer has no business reaching for. The
 * direction that matters is the other one — what the renderer paints has to be
 * a colour the template actually uses.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readTemplate, hash } from '../../scripts/lib/template.js';
import { COLOR, INK, ON_NAVY, FONT } from '../src/brand.js';
import { SLIDE } from '../src/documents/ooxml.js';

const TEMPLATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../brand/templates/Vikat_Overview.potx',
);

const template = readTemplate(new Uint8Array(fs.readFileSync(TEMPLATE)));
const used = new Set(template.palette.map((c) => hash(c.hex)));

test('a generated deck is the same shape as the template', () => {
  // A 4:3 deck among 16:9 ones is obvious from the back of the room.
  assert.equal(SLIDE.widthIn.toFixed(2), template.slide.widthIn.toFixed(2));
  assert.equal(SLIDE.heightIn.toFixed(2), template.slide.heightIn.toFixed(2));
});

test('the ground is the template’s ground', () => {
  // The single biggest thing that was wrong: the template is cream, and the
  // cover and every prose slide were rendering on white.
  assert.equal(hash(template.ground), COLOR.cream);
});

test('every colour the renderer paints is one the template uses', () => {
  // The check that would have caught the hand-transcribed accents — a teal
  // close to the real one, and wrong.
  const mine = { ...COLOR, ...INK, ...ON_NAVY };

  for (const [name, value] of Object.entries(mine)) {
    assert.ok(
      used.has(value.toUpperCase()),
      `${name} is ${value}, which does not appear anywhere in the template`,
    );
  }
});

test('the typefaces are the template’s', () => {
  const families = new Set(Object.values(FONT).map((f) => f.family));
  for (const family of families) {
    assert.ok(
      template.fonts.includes(family),
      `${family} is not used in the template, which sets ${template.fonts.join(', ')}`,
    );
  }
});

test('the template still reads', () => {
  // A .potx that has been re-saved by a newer PowerPoint, or replaced with the
  // wrong file, should fail here rather than silently yield an empty palette
  // that makes every assertion above vacuous.
  assert.ok(template.palette.length > 20, `only ${template.palette.length} colours found`);
  assert.ok(template.fonts.length > 0);
});
