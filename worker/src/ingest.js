/**
 * ingest.js — turn an uploaded file into knowledge the assistant can use.
 *
 * The Worker side of what the nightly sync does in CI, and deliberately the
 * SAME extractor: scripts/lib/extract.js is written against Uint8Array and
 * fflate precisely so both can run it. A second implementation would have to
 * re-learn that a PDF stream which will not inflate is an image rather than
 * text, and would eventually disagree with the one that already knows.
 */

import { extract, SUPPORTED_EXTENSIONS } from '../../scripts/lib/extract.js';

export { SUPPORTED_EXTENSIONS };

/** Chunk sizes mirror scripts/build-knowledge.js, so retrieval sees one shape. */
const MIN_CHUNK_CHARS = 60;
const MAX_CHUNK_CHARS = 1800;

/** Split a long section on paragraph boundaries rather than mid-sentence. */
function chunkText(text) {
  const paragraphs = String(text).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  let current = '';

  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > MAX_CHUNK_CHARS) {
      out.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) out.push(current);

  return out.filter((c) => c.length >= MIN_CHUNK_CHARS);
}

/**
 * Extract and chunk an uploaded file.
 *
 * @returns {{ ok: true, chunks: {section: string, content: string}[], warnings: string[] }
 *          | { ok: false, error: string, warnings: string[] }}
 */
export function ingest(bytes, fileName) {
  let result;
  try {
    result = extract(bytes, fileName);
  } catch (err) {
    return { ok: false, error: `Could not read ${fileName}: ${err?.message || err}`, warnings: [] };
  }

  const chunks = [];
  for (const section of result.sections || []) {
    for (const content of chunkText(section.content)) {
      chunks.push({ section: section.title || fileName, content });
    }
  }

  if (chunks.length === 0) {
    return {
      ok: false,
      // The honest failure, and the one that matters: a scanned PDF looks like
      // a successful upload and teaches the assistant nothing.
      error:
        result.warnings?.[0] ||
        'No readable text was found in that file. If it is a scanned PDF it has no text layer; convert it to .docx or .pptx first.',
      warnings: result.warnings || [],
    };
  }

  return { ok: true, chunks, warnings: result.warnings || [] };
}
