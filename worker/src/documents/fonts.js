/**
 * fonts.js — the brand typefaces, bundled into the Worker.
 *
 * Wrangler compiles .ttf as a Data module (see the `[[rules]]` block in
 * wrangler.toml), so each import is an ArrayBuffer at runtime with no fetch
 * and nothing to go wrong on a cold start.
 *
 * This is the ONLY module that imports font bytes. Everything downstream —
 * measurement, PPTX, PDF — takes a font set as an argument, which is what
 * lets the renderers be tested under plain Node, where a .ttf import is not
 * a thing.
 */

import interBlack from '../fonts/Inter-Black.ttf';
import interBold from '../fonts/Inter-Bold.ttf';
import interRegular from '../fonts/Inter-Regular.ttf';
import jetBrainsMonoBold from '../fonts/JetBrainsMono-Bold.ttf';

import { FontMetrics } from './measure.js';

/**
 * Parsing the metrics tables costs a few milliseconds per font, so it happens
 * once per isolate rather than once per document.
 *
 * @type {{ display: Uint8Array, heading: Uint8Array, body: Uint8Array, eyebrow: Uint8Array } | null}
 */
let cached = null;

/**
 * The font set the renderers take.
 *
 * Keyed by brand role rather than file name, so a renderer asks for "the
 * display face" and brand.js decides what that is.
 */
export function loadFonts() {
  if (cached) return cached;

  const bytes = {
    display: new Uint8Array(interBlack),
    heading: new Uint8Array(interBold),
    body: new Uint8Array(interRegular),
    eyebrow: new Uint8Array(jetBrainsMonoBold),
  };

  cached = {
    bytes,
    metrics: {
      display: new FontMetrics(bytes.display),
      heading: new FontMetrics(bytes.heading),
      body: new FontMetrics(bytes.body),
      eyebrow: new FontMetrics(bytes.eyebrow),
    },
  };

  return cached;
}
