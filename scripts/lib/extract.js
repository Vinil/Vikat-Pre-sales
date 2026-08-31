/**
 * extract.js — pull readable text out of Office and PDF files.
 *
 * .pptx and .docx are ZIP archives of XML, so they need no vendor library
 * beyond an unzipper. PDF is handled on a best-effort basis (see below) and
 * reports honestly when it cannot read a file, rather than emitting garbage —
 * a knowledge base full of extraction noise is worse than a missing document.
 *
 * Every extractor returns { sections: [{ title, content }], warnings: [] }.
 * `sections` maps onto the { section, content } half of a knowledge chunk.
 *
 * Written against Uint8Array and fflate only — no Buffer, no node:zlib — so
 * the SAME file runs in the Worker, which is not Node. Deliberate rather than
 * tidy: the PDF path refuses mangled output on a legibility check that took a
 * production bug to find, and a second copy of that logic for the upload route
 * would eventually stop agreeing with this one.
 */

/** Latin-1 bytes to a string, the alphabet PDF operators live in. */
function latin1(bytes) {
  let out = '';
  // Chunked: fromCharCode.apply blows the stack on a whole file.
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return out;
}

/** A latin-1 string back to the bytes it stands for. */
function bytesOf(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Whatever the caller handed us, as bytes. */
function asBytes(buffer) {
  if (buffer instanceof Uint8Array) return buffer;
  return new Uint8Array(buffer);
}

import { unzipSync, strFromU8, unzlibSync, inflateSync } from 'fflate';

// --- XML helpers ----------------------------------------------------------

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
};

function decode(s) {
  return s.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m) => {
    if (ENTITIES[m]) return ENTITIES[m];
    const dec = /^&#(\d+);$/.exec(m);
    if (dec) return String.fromCodePoint(Number(dec[1]));
    const hex = /^&#x([0-9a-fA-F]+);$/.exec(m);
    if (hex) return String.fromCodePoint(parseInt(hex[1], 16));
    return m;
  });
}

/**
 * Concatenate the text runs of an OOXML part.
 *
 * `<a:t>` (DrawingML, used by PowerPoint) and `<w:t>` (WordprocessingML) both
 * hold literal text. Paragraph and break elements become newlines so the
 * output keeps the document's shape instead of collapsing into one line.
 */
function textFromOoxml(xml, tag) {
  const withBreaks = xml
    .replace(/<(?:w|a):p\b[^>]*\/>/g, '\n')
    .replace(/<\/(?:w|a):p>/g, '\n')
    .replace(/<(?:w|a):br\b[^>]*\/?>/g, '\n')
    .replace(/<w:tab\b[^>]*\/?>/g, ' ');

  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>|\\n`, 'g');
  let out = '';
  let m;
  while ((m = re.exec(withBreaks)) !== null) {
    out += m[1] !== undefined ? decode(m[1]) : '\n';
  }

  return out
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .trim();
}

function unzip(buffer) {
  return unzipSync(new Uint8Array(buffer));
}

// --- PowerPoint -----------------------------------------------------------

/** Slide files sort lexically ("slide10" before "slide2"), so sort numerically. */
function slideNumber(name) {
  const m = /slide(\d+)\.xml$/.exec(name);
  return m ? Number(m[1]) : 0;
}

/**
 * One section per slide, titled by the slide's own title placeholder where it
 * has one. Speaker notes are appended: they usually carry the explanation the
 * slide itself only gestures at, which is exactly what a rep needs.
 */
export function extractPptx(buffer) {
  const files = unzip(buffer);
  const warnings = [];
  const sections = [];

  const slides = Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  if (slides.length === 0) warnings.push('no slides found');

  for (const name of slides) {
    const n = slideNumber(name);
    const xml = strFromU8(files[name]);
    const body = textFromOoxml(xml, 'a:t');

    const notesName = `ppt/notesSlides/notesSlide${n}.xml`;
    let notes = '';
    if (files[notesName]) {
      notes = textFromOoxml(strFromU8(files[notesName]), 'a:t');
      // PowerPoint stores the slide number in the notes master; drop a notes
      // body that is nothing but that digit.
      if (/^\d+$/.test(notes.trim())) notes = '';
    }

    if (!body && !notes) continue;

    // First non-trivial line is almost always the slide title.
    const firstLine = body.split('\n').find((l) => l.length > 2) || '';
    const title = firstLine.length > 80 ? `Slide ${n}` : firstLine || `Slide ${n}`;

    sections.push({
      title: `Slide ${n}: ${title}`,
      content: notes ? `${body}\n\nSpeaker notes: ${notes}` : body,
    });
  }

  return { sections, warnings };
}

// --- Word -----------------------------------------------------------------

/**
 * Split on Heading styles so a long document becomes navigable sections
 * rather than one wall of text.
 */
export function extractDocx(buffer) {
  const files = unzip(buffer);
  const warnings = [];

  const doc = files['word/document.xml'];
  if (!doc) return { sections: [], warnings: ['no word/document.xml'] };

  const xml = strFromU8(doc);

  // Split the body into paragraphs, keeping each paragraph's properties so we
  // can tell a heading from body text.
  const paragraphs = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g) || [];

  const sections = [];
  let current = { title: 'Document', content: [] };

  for (const p of paragraphs) {
    const text = textFromOoxml(p, 'w:t').trim();
    if (!text) continue;

    const isHeading = /w:pStyle[^>]*w:val="(?:Heading\d|Title|Subtitle)"/i.test(p);

    if (isHeading) {
      if (current.content.length) sections.push({ title: current.title, content: current.content.join('\n') });
      current = { title: text, content: [] };
    } else {
      current.content.push(text);
    }
  }

  if (current.content.length) sections.push({ title: current.title, content: current.content.join('\n') });
  if (sections.length === 0) warnings.push('no readable paragraphs');

  return { sections, warnings };
}

// --- Plain text and markdown ---------------------------------------------

export function extractText(buffer, name) {
  const text = new TextDecoder().decode(asBytes(buffer));
  return {
    sections: text.trim() ? [{ title: name, content: text.trim() }] : [],
    warnings: [],
  };
}

// --- PDF ------------------------------------------------------------------

/**
 * A parenthesised string handed to a text-showing operator.
 *
 * The grouping matters and used to be wrong: `/\(([^)]*)\)\s*Tj|TJ/` reads as
 * "(...)Tj OR TJ", so a bare "TJ" anywhere passed — and two such bytes turn up
 * constantly in binary. That is how compressed image data came to be scanned
 * for text.
 */
const SHOW_OPERATOR = /\(((?:\\.|[^\\()])*)\)\s*(?:Tj|TJ|')/;

/** Printable-ish latin1, the alphabet a PDF content stream is written in. */
function printableRatio(s) {
  if (!s) return 0;
  const printable = s.replace(/[^\x20-\x7E\r\n\t]/g, '').length;
  return printable / s.length;
}

/**
 * Whether an un-inflated stream is plausibly an uncompressed content stream
 * rather than image or font bytes that happen to contain a text operator.
 */
function looksLikeContentStream(s) {
  return printableRatio(s) > 0.9 && /\bBT\b/.test(s);
}

/**
 * Best-effort PDF text extraction.
 *
 * PDFs store text as positioned glyph runs, so faithful extraction needs a
 * real parser. This handles the common case — uncompressed or Flate-compressed
 * content streams with plain text-showing operators — and gives up loudly on
 * anything else rather than emitting mangled output.
 *
 * A scanned PDF has no text layer at all and will always report empty. If PDFs
 * turn out to matter, the right fix is a proper parser in this one function,
 * not a workaround at the call site.
 */
export function extractPdf(buffer, name) {
  const warnings = [];
  const buf = asBytes(buffer);

  let raw = '';
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  let m;

  const source = latin1(buf);

  while ((m = streamRe.exec(source)) !== null) {
    const chunk = bytesOf(m[1]);
    let decoded = null;

    // Flate first, by far the most common filter. A PDF stream carries the
    // zlib wrapper, so unzlib is the right call; raw deflate is tried second
    // because a few writers omit the header.
    try {
      decoded = latin1(unzlibSync(chunk));
    } catch {
      try {
        decoded = latin1(inflateSync(chunk));
      } catch {
        // A stream that will not inflate is an image, a font, or a filter this
        // does not implement. It is NOT text. Treating it as literal put raw
        // compressed bytes through the operator scan below, and a rep opened
        // the Collateral tab to a summary reading 's85$^p`meEs^]#Eh&DP!B^S.cO'.
        // Uncompressed content streams do exist, so keep it only if it reads
        // as one.
        const literal = latin1(chunk);
        decoded = looksLikeContentStream(literal) ? literal : null;
      }
    }

    if (decoded && SHOW_OPERATOR.test(decoded)) raw += `${decoded}\n`;
  }

  // Pull the literal strings out of text-showing operators.
  const pieces = [];
  const showRe = new RegExp(SHOW_OPERATOR.source, 'g');
  let s;
  while ((s = showRe.exec(raw)) !== null) {
    pieces.push(s[1].replace(/\\([()\\])/g, '$1').replace(/\\[rn]/g, ' '));
  }

  const text = pieces.join(' ').replace(/\s+/g, ' ').trim();

  // The comment above this function promises it "gives up loudly rather than
  // emitting mangled output". It did not: mangled output reached the knowledge
  // base and the Collateral tab as a document summary. This is that promise,
  // enforced. Prose is overwhelmingly printable and has spaces in it; a run of
  // decompression noise is neither.
  const wordish = text.split(/\s+/).filter((w) => /^[\x20-\x7E]{1,30}$/.test(w)).length;
  const mangled = text && (printableRatio(text) < 0.95 || wordish / Math.max(1, text.split(/\s+/).length) < 0.6);

  if (mangled) {
    warnings.push(
      'extracted text failed a legibility check and was discarded — the PDF stores its text in a form this extractor cannot read. Convert it to .docx or .pptx.',
    );
    return { sections: [], warnings };
  }

  if (!text) {
    warnings.push(
      'no extractable text — the PDF is scanned, uses embedded font encodings, or is otherwise not plain-text extractable. Convert it to .docx or .pptx, or add a text layer.',
    );
    return { sections: [], warnings };
  }

  warnings.push('PDF text extracted best-effort; check the result before relying on it');
  return { sections: [{ title: name, content: text }], warnings };
}

// --- Dispatch -------------------------------------------------------------

export const SUPPORTED_EXTENSIONS = ['.pptx', '.docx', '.pdf', '.txt', '.md'];

/**
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {string} name  File name, used for the extension and as a fallback title.
 * @returns {{ sections: {title: string, content: string}[], warnings: string[] }}
 */
export function extract(buffer, name) {
  const lower = name.toLowerCase();

  try {
    if (lower.endsWith('.pptx')) return extractPptx(buffer);
    if (lower.endsWith('.docx')) return extractDocx(buffer);
    if (lower.endsWith('.pdf')) return extractPdf(buffer, name);
    if (lower.endsWith('.txt') || lower.endsWith('.md')) return extractText(buffer, name);
  } catch (err) {
    return { sections: [], warnings: [`extraction failed: ${err.message}`] };
  }

  return { sections: [], warnings: [`unsupported file type: ${name}`] };
}
