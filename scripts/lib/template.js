/**
 * template.js — read the design out of Vikat_Overview.potx.
 *
 * The template is the source of truth for what a generated deck should look
 * like, and a binary sitting in a folder is not a source of truth — it is a
 * file somebody once looked at. So it is read rather than admired: this pulls
 * the palette, the typefaces and the slide geometry out of it, and a test
 * asserts that brand.js still agrees with what comes back.
 *
 * That is the whole point of committing it. When the template changes, the
 * test fails and names the colour that moved, instead of the renderer quietly
 * drifting away from the deck it is supposed to imitate — which is exactly how
 * decks ended up shipping on white grounds with hand-transcribed accents.
 *
 * Reads only what a renderer needs. Nothing here extracts slide CONTENT: the
 * template's words are its own, and the renderer writes its own.
 */

import { unzipSync, strFromU8 } from 'fflate';

const EMU_PER_INCH = 914400;

/** Colours that carry no design intent and would drown the real palette. */
const NEUTRAL = new Set(['000000', 'FFFFFF']);

/**
 * @param {Uint8Array} bytes  A .potx or .pptx.
 * @returns {{ slide: {widthIn: number, heightIn: number},
 *             fonts: string[],
 *             palette: {hex: string, uses: number}[],
 *             ground: string|null }}
 */
export function readTemplate(bytes) {
  const files = unzipSync(bytes);

  const read = (name) => (files[name] ? strFromU8(files[name]) : '');
  const slideNames = Object.keys(files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const masterNames = Object.keys(files).filter((n) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(n));
  const design = [...slideNames, ...masterNames].map(read).join('');

  // Slide size, so a generated deck is the same shape as the template. A 4:3
  // deck among 16:9 ones is obvious from the back of the room.
  const size = /<p:sldSz cx="(\d+)" cy="(\d+)"/.exec(read('ppt/presentation.xml'));
  const slide = size
    ? { widthIn: Number(size[1]) / EMU_PER_INCH, heightIn: Number(size[2]) / EMU_PER_INCH }
    : { widthIn: 0, heightIn: 0 };

  // Typefaces the slides actually SET, not the ones the theme falls back to.
  // The theme in this template is stock Office; the design is in the slides.
  const fonts = [...new Set([...design.matchAll(/typeface="([^"]+)"/g)].map((m) => m[1]))]
    .filter((f) => f && f !== '+mn-lt' && f !== '+mj-lt')
    .sort();

  const counts = new Map();
  for (const m of design.matchAll(/srgbClr val="([0-9A-Fa-f]{6})"/g)) {
    const hex = m[1].toUpperCase();
    counts.set(hex, (counts.get(hex) || 0) + 1);
  }

  const palette = [...counts.entries()]
    .map(([hex, uses]) => ({ hex, uses }))
    .sort((a, b) => b.uses - a.uses);

  // The most-used non-neutral colour is the ground. In this template that is
  // cream, by a wide margin — and the renderer was using white.
  const ground = palette.find((c) => !NEUTRAL.has(c.hex))?.hex || null;

  return { slide, fonts, palette, ground };
}

/** `#RRGGBB` from a bare hex, to compare against brand.js without fuss. */
export function hash(hex) {
  return `#${String(hex).toUpperCase()}`;
}
