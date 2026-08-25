/**
 * measure.js — real glyph advance widths, read from the font files.
 *
 * Both renderers need to know how tall a block of text will be before they
 * can place the block under it. Estimating from character counts puts a
 * ragged hole under every short heading and overlaps every long one, so this
 * reads the actual metrics out of the TrueType tables instead.
 *
 * Only the tables layout needs are parsed: head for unitsPerEm, hhea and hmtx
 * for advance widths, cmap for the character-to-glyph mapping. Rendering is
 * somebody else's problem — PowerPoint's, or pdf-lib's.
 */

/** Parsed metrics for one font file. */
export class FontMetrics {
  /** @param {Uint8Array} bytes A .ttf file. */
  constructor(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tables = readTableDirectory(view);

    const head = required(tables, 'head', 'font has no head table');
    this.unitsPerEm = view.getUint16(head.offset + 18);

    const hhea = required(tables, 'hhea', 'font has no hhea table');
    this.ascender = view.getInt16(hhea.offset + 4) / this.unitsPerEm;
    this.descender = view.getInt16(hhea.offset + 6) / this.unitsPerEm;
    this.lineGap = view.getInt16(hhea.offset + 8) / this.unitsPerEm;

    /**
     * The font's own single-line advance, in em — for Inter this is about
     * 1.21, not 1.0.
     *
     * OOXML line spacing is a percentage OF THIS, not of the point size, so a
     * layout that assumes `lineHeight × size` under-computes every block by
     * about a fifth and slides the next one up into it.
     */
    this.naturalLineHeight = this.ascender - this.descender + this.lineGap;

    const numHMetrics = view.getUint16(hhea.offset + 34);

    const hmtx = required(tables, 'hmtx', 'font has no hmtx table');
    this.advances = readAdvances(view, hmtx.offset, numHMetrics);

    const cmap = required(tables, 'cmap', 'font has no cmap table');
    this.cmap = readCmap(view, cmap.offset);

    // Cache: layout re-measures the same characters thousands of times.
    this.widthCache = new Map();
  }

  /** Glyph id for a codepoint, or 0 (.notdef). */
  glyphFor(codePoint) {
    return this.cmap.get(codePoint) || 0;
  }

  /** Advance width of one codepoint, in em. */
  advanceOf(codePoint) {
    const cached = this.widthCache.get(codePoint);
    if (cached !== undefined) return cached;

    const glyph = this.glyphFor(codePoint);
    // Past the end of hmtx, every glyph carries the last recorded advance.
    const raw = glyph < this.advances.length ? this.advances[glyph] : this.advances[this.advances.length - 1];
    const width = raw / this.unitsPerEm;

    this.widthCache.set(codePoint, width);
    return width;
  }

  /**
   * Width of a string at a size, in the same unit as `size`.
   *
   * @param {string} text
   * @param {number} size      Point size.
   * @param {number} [tracking] Letter spacing in em, per the brand scale.
   */
  widthOf(text, size, tracking = 0) {
    let em = 0;
    let count = 0;

    for (const ch of String(text)) {
      em += this.advanceOf(ch.codePointAt(0));
      count += 1;
    }

    // Tracking is added after each character, including the last, which is
    // how both PowerPoint and CSS letter-spacing behave.
    return (em + tracking * count) * size;
  }
}

function required(tables, tag, message) {
  const t = tables.get(tag);
  if (!t) throw new Error(message);
  return t;
}

function readTableDirectory(view) {
  const tag = view.getUint32(0);
  // 0x74746366 is 'ttcf', a font collection. Point at the first font in it.
  const base = tag === 0x74746366 ? view.getUint32(12) : 0;

  const numTables = view.getUint16(base + 4);
  const tables = new Map();

  for (let i = 0; i < numTables; i += 1) {
    const entry = base + 12 + i * 16;
    const name = String.fromCharCode(
      view.getUint8(entry),
      view.getUint8(entry + 1),
      view.getUint8(entry + 2),
      view.getUint8(entry + 3),
    );
    tables.set(name, { offset: view.getUint32(entry + 8), length: view.getUint32(entry + 12) });
  }

  return tables;
}

function readAdvances(view, offset, numHMetrics) {
  const advances = new Uint16Array(numHMetrics);
  for (let i = 0; i < numHMetrics; i += 1) advances[i] = view.getUint16(offset + i * 4);
  return advances;
}

/**
 * Read the best available Unicode subtable.
 *
 * Format 4 covers the Basic Multilingual Plane and is what every Latin font
 * ships; format 12 covers the rest and is preferred when present.
 */
function readCmap(view, offset) {
  const numSubtables = view.getUint16(offset + 2);

  let best = null;
  for (let i = 0; i < numSubtables; i += 1) {
    const rec = offset + 4 + i * 8;
    const platform = view.getUint16(rec);
    const encoding = view.getUint16(rec + 2);
    const subtable = offset + view.getUint32(rec + 4);
    const format = view.getUint16(subtable);

    const unicode =
      (platform === 3 && (encoding === 1 || encoding === 10)) || platform === 0;
    if (!unicode) continue;

    const rank = format === 12 ? 2 : format === 4 ? 1 : 0;
    if (rank && (!best || rank > best.rank)) best = { subtable, format, rank };
  }

  if (!best) throw new Error('font has no usable Unicode cmap subtable');
  return best.format === 12 ? readCmap12(view, best.subtable) : readCmap4(view, best.subtable);
}

function readCmap4(view, offset) {
  const segCountX2 = view.getUint16(offset + 6);
  const segCount = segCountX2 / 2;

  const endsAt = offset + 14;
  const startsAt = endsAt + segCountX2 + 2;
  const deltasAt = startsAt + segCountX2;
  const rangesAt = deltasAt + segCountX2;

  const map = new Map();

  for (let seg = 0; seg < segCount; seg += 1) {
    const end = view.getUint16(endsAt + seg * 2);
    const start = view.getUint16(startsAt + seg * 2);
    if (start > end) continue;

    const delta = view.getInt16(deltasAt + seg * 2);
    const rangeOffset = view.getUint16(rangesAt + seg * 2);

    for (let cp = start; cp <= end && cp !== 0xffff; cp += 1) {
      let glyph;
      if (rangeOffset === 0) {
        glyph = (cp + delta) & 0xffff;
      } else {
        const at = rangesAt + seg * 2 + rangeOffset + (cp - start) * 2;
        // A malformed range offset must not read past the table.
        if (at + 1 >= view.byteLength) continue;
        glyph = view.getUint16(at);
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph) map.set(cp, glyph);
    }
  }

  return map;
}

function readCmap12(view, offset) {
  const numGroups = view.getUint32(offset + 12);
  const map = new Map();

  for (let i = 0; i < numGroups; i += 1) {
    const group = offset + 16 + i * 12;
    const start = view.getUint32(group);
    const end = view.getUint32(group + 4);
    const startGlyph = view.getUint32(group + 8);

    // Guard against a corrupt group claiming the whole codespace.
    for (let cp = start; cp <= end && cp - start < 0x10000; cp += 1) {
      map.set(cp, startGlyph + (cp - start));
    }
  }

  return map;
}

/**
 * Break text into lines that fit `maxWidth`.
 *
 * Words longer than the line (a URL, a long identifier) are broken rather
 * than allowed to overflow the box, because a slide that runs off the edge is
 * worse than one with an ugly break.
 *
 * @returns {string[]}
 */
export function wrap(text, metrics, size, maxWidth, tracking = 0) {
  const source = String(text || '').trim();
  if (!source) return [];

  const lines = [];

  for (const paragraph of source.split('\n')) {
    let line = '';

    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;

      if (metrics.widthOf(candidate, size, tracking) <= maxWidth) {
        line = candidate;
        continue;
      }

      if (line) lines.push(line);

      if (metrics.widthOf(word, size, tracking) <= maxWidth) {
        line = word;
        continue;
      }

      // Hard-break the oversized word.
      let chunk = '';
      for (const ch of word) {
        if (chunk && metrics.widthOf(chunk + ch, size, tracking) > maxWidth) {
          lines.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      line = chunk;
    }

    if (line) lines.push(line);
  }

  return lines;
}

/** How tall a wrapped block is, in the same unit as `size`. */
export function blockHeight(lineCount, size, lineHeight) {
  return lineCount * size * lineHeight;
}
