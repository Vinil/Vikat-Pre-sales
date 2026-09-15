/**
 * The Vikat mark: placed artwork, never retyped letterforms.
 *
 * The renderer used to set "vikat.AI" in Inter Black, which looked close and
 * was a redrawn lockup. TM3 §07: "the logotype is a designed lockup, never
 * retype it." Semantic Suite §02: "never a redrawn version." A good imitation
 * of a mark is worse than an obvious one, because it survives forwarding.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

import { renderPptx } from '../src/documents/pptx.js';
import { normaliseSpec } from '../src/documents/spec.js';
import { loadFonts } from '../src/documents/fonts.js';
import { slideRels } from '../src/documents/ooxml.js';

const META = { preparedBy: 'rep@vikat.ai', isoDate: '2026-09-15T00:00:00Z' };
const assets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/brandassets');

function deck() {
  const parsed = normaliseSpec({
    title: 'Severity scores do not know your delivery window',
    format: 'pptx',
    audience: 'internal',
    content: '## stat | 350 | million in net sales, UNFI June 2025\n\n## The ask | Twenty minutes.',
  });
  assert.ok(parsed.ok, parsed.error);
  return unzipSync(renderPptx(parsed.spec, META, loadFonts().metrics));
}

const text = (files, name) => new TextDecoder().decode(files[name]);

test('the cover places the mark and no longer typesets it', () => {
  const files = deck();
  const cover = text(files, 'ppt/slides/slide1.xml');

  assert.ok(cover.includes('<p:pic>'), 'the cover draws no picture');
  assert.match(cover, /r:embed="rId\d"/);
  assert.ok(!cover.includes('>vikat.AI<'), 'the wordmark is still being retyped');
});

test('a dark ground takes the REVERSED lockup', () => {
  // TM3 §04 lists "color logo on dark backgrounds" under prohibited uses, and
  // the cover is a navy gradient. The choice is made from the ground, never
  // left to a caller.
  const files = deck();
  const cover = text(files, 'ppt/slides/slide1.xml');
  const rels = text(files, 'ppt/slides/_rels/slide1.xml.rels');

  const id = cover.match(/r:embed="(rId\d)"/)[1];
  const target = rels.match(new RegExp(`Id="${id}"[^>]*Target="([^"]+)"`))[1];
  assert.match(target, /vikat-lockup-reversed\.png$/, 'the colour lockup is on a dark ground');
});

test('the mark is placed at the artwork aspect, never stretched', () => {
  // "Do not stretch or distort" is §06's first prohibition, and the way it
  // happens is somebody passing a height that seemed about right.
  const files = deck();
  const cover = text(files, 'ppt/slides/slide1.xml');
  const pic = cover.slice(cover.indexOf('<p:pic>'), cover.indexOf('</p:pic>'));
  const [, cx, cy] = pic.match(/<a:ext cx="(\d+)" cy="(\d+)"/);

  assert.ok(Math.abs(Number(cx) / Number(cy) - 466 / 232) < 0.01, `aspect ${Number(cx) / Number(cy)}`);
  assert.match(pic, /noChangeAspect="1"/, 'no aspect lock, so an editor can stretch it');
  // TM3: minimum 140px wide on screen. 1.9in at 96dpi is 182.
  assert.ok(Number(cx) / 914400 >= 1.5, 'below the minimum size the guidelines set');
});

test('every image relationship points at a part that exists', () => {
  // A relationship to a missing part is a file PowerPoint refuses to open,
  // which is a worse failure than a missing logo.
  const files = deck();
  const slides = Object.keys(files).filter((n) => /ppt\/slides\/slide\d+\.xml$/.test(n));
  assert.ok(slides.length >= 3);

  for (let i = 1; i <= slides.length; i += 1) {
    const rels = text(files, `ppt/slides/_rels/slide${i}.xml.rels`);
    for (const t of rels.match(/Target="\.\.\/media\/[^"]+"/g) || []) {
      const part = `ppt/media/${t.slice('Target="../media/'.length, -1)}`;
      assert.ok(files[part], `slide ${i} names ${part}, which is not in the package`);
    }
  }
});

test('the package declares png, or the parts are unreadable', () => {
  assert.match(text(deck(), '[Content_Types].xml'), /Extension="png" ContentType="image\/png"/);
});

test('both lockups ship, because one of them is for a ground we do not use yet', () => {
  // The colour lockup is currently unused: every slide that carries the mark
  // is dark. It ships anyway, so that the first light cover cannot reach for
  // the reversed one and land on a prohibited use.
  const files = deck();
  assert.ok(files['ppt/media/vikat-lockup.png']);
  assert.ok(files['ppt/media/vikat-lockup-reversed.png']);
  assert.match(slideRels, /vikat-lockup\.png/);
  assert.match(slideRels, /vikat-lockup-reversed\.png/);
});

test('the prohibited-use artwork is not in the repo', () => {
  // The guidelines PDF carries the MISUSE examples too, and they extract
  // looking exactly like usable assets: a recoloured magenta wordmark, one
  // with a drop shadow, one with a glow. Shipping one would render the misuse
  // page onto every cover.
  const shipped = fs.readdirSync(assets).filter((f) => f.endsWith('.png')).sort();
  assert.deepEqual(shipped, ['vikat-emblem.png', 'vikat-lockup-reversed.png', 'vikat-lockup.png']);
});
