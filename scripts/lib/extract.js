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
 */

import { unzipSync, strFromU8 } from 'fflate';
import { inflateSync } from 'node:zlib';

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
  const text = Buffer.from(buffer).toString('utf8');
  return {
    sections: text.trim() ? [{ title: name, content: text.trim() }] : [],
    warnings: [],
  };
}

// --- PDF ------------------------------------------------------------------

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
  const buf = Buffer.from(buffer);

  let raw = '';
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  let m;

  while ((m = streamRe.exec(buf.toString('latin1'))) !== null) {
    const chunk = Buffer.from(m[1], 'latin1');
    let decoded = null;

    // Try Flate first — by far the most common filter.
    try {
      decoded = inflateSync(chunk).toString('latin1');
    } catch {
      // Not deflate, or corrupt. Fall back to treating it as literal.
      decoded = chunk.toString('latin1');
    }

    if (decoded && /\(([^)]*)\)\s*Tj|TJ/.test(decoded)) raw += `${decoded}\n`;
  }

  // Pull the literal strings out of text-showing operators.
  const pieces = [];
  const showRe = /\(((?:\\.|[^\\()])*)\)\s*(?:Tj|TJ|')/g;
  let s;
  while ((s = showRe.exec(raw)) !== null) {
    pieces.push(s[1].replace(/\\([()\\])/g, '$1').replace(/\\[rn]/g, ' '));
  }

  const text = pieces.join(' ').replace(/\s+/g, ' ').trim();

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
 * @param {ArrayBuffer|Buffer} buffer
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
