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
