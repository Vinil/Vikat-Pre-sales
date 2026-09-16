/**
 * marks.js — the Vikat mark as bytes.
 *
 * Bundled rather than fetched, for the same reason the fonts are: a cover that
 * fetches its logo at runtime is a cover that sometimes has no logo, and a
 * deck missing its mark reaches a customer looking like a draft somebody
 * forgot to finish.
 *
 * Imported through one module so the renderers never touch a file path, and so
 * the Node test run can stub these the way it stubs the fonts. See
 * src/brandassets/README.md for which variant goes where and why there are
 * exactly three.
 */

import lockup from '../brandassets/vikat-lockup.png';
import lockupReversed from '../brandassets/vikat-lockup-reversed.png';

/**
 * The two lockups a slide can carry.
 *
 * Keyed by relationship id because that is how OOXML addresses them from the
 * slide, and keeping the mapping in one object stops a renderer and a
 * relationship file drifting apart — which would not throw, it would silently
 * put the colour lockup on navy, one of TM3's prohibited uses.
 */
export function markMedia() {
  return {
    'ppt/media/vikat-lockup.png': new Uint8Array(lockup),
    'ppt/media/vikat-lockup-reversed.png': new Uint8Array(lockupReversed),
  };
}

/**
 * The lockup as raw bytes, for a renderer that embeds rather than zips.
 *
 * pdf.js needs the same artwork and cannot use the OOXML map above: pdf-lib
 * embeds a PNG and draws it, it does not add parts to an archive. Exposing the
 * bytes here rather than importing the .png in pdf.js keeps the rule this
 * module exists for — one place imports the artwork, so the Node test hook has
 * one thing to stub and no renderer holds a file path.
 *
 * @param {boolean} [onDark] The reversed lockup, for navy and dark grounds.
 */
export function lockupBytes(onDark = false) {
  return new Uint8Array(onDark ? lockupReversed : lockup);
}

/** The artwork's true aspect ratio, so no renderer stretches it. */
export const LOCKUP_ASPECT = 466 / 232;
