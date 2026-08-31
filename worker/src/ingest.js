/**
 * ingest.js — turn an uploaded file into knowledge the assistant can use.
 *
 * The Worker side of what the nightly sync does in CI, and for Office files
 * deliberately the SAME extractor: scripts/lib/extract.js is written against
 * Uint8Array and fflate precisely so both can run it. A second implementation
 * would eventually disagree with the one that already works.
 *
 * PDF is the exception, and has to be. The byte extractor can only read a PDF
 * that stores its text as plain text-showing operators; a subsetted font or a
 * scan defeats it, and it refuses rather than emitting noise. So here a PDF
 * goes to the model instead (pdfText.js), which reads it the way a person
 * does. The byte path stays as the fallback for anywhere without an API key —
 * which is exactly what CI is, so the sync keeps working unchanged.
 */

import { extract, SUPPORTED_EXTENSIONS } from '../../scripts/lib/extract.js';
import { readPdfWithModel } from './pdfText.js';

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

function isPdf(fileName) {
  return /\.pdf$/i.test(String(fileName));
}

/**
 * Extract and chunk an uploaded file.
 *
 * @param {Uint8Array} bytes
 * @param {string} fileName
 * @param {{ env?: object, cfg?: object, client?: object }} deps Present in the
 *   Worker, absent in CI — which is what decides whether a PDF is read by the
 *   model or by the byte extractor.
 * @returns {Promise<{ ok: true, chunks: {section: string, content: string}[],
 *                     warnings: string[], reader: string, usage?: object }
 *                 | { ok: false, error: string, warnings: string[] }>}
 */
export async function ingest(bytes, fileName, deps = {}) {
  const { env, cfg, client } = deps;
  const warnings = [];
  let reader = 'bytes';
  let result;

  const modelAllowed = isPdf(fileName) && cfg?.PDF_READER !== 'bytes' && Boolean(env?.ANTHROPIC_API_KEY);
  let usage;

  if (modelAllowed) {
    const read = await readPdfWithModel(bytes, fileName, { env, cfg, client });
    if (read.ok) {
      reader = 'model';
      usage = read.usage;
      result = { sections: read.sections, warnings: read.warnings };
    } else {
      // Not fatal on its own: a PDF with a clean text layer still reads
      // locally, so try that before telling the admin no.
      warnings.push(`Reading ${fileName} with the model failed (${read.reason}); falling back to the byte extractor.`);
    }
  }

  if (!result) {
    try {
      result = extract(bytes, fileName);
    } catch (err) {
      return {
        ok: false,
        error: `Could not read ${fileName}: ${err?.message || err}`,
        warnings,
      };
    }
  }

  const chunks = [];
  for (const section of result.sections || []) {
    for (const content of chunkText(section.content)) {
      chunks.push({ section: section.title || fileName, content });
    }
  }

  warnings.push(...(result.warnings || []));

  if (chunks.length === 0) {
    // Two different failures, and they need different advice. Text that was
    // read but was too fragmentary to index is not the same problem as a file
    // nothing could be read from at all.
    const read = (result.sections || []).reduce((n, s) => n + String(s.content || '').trim().length, 0);
    return {
      ok: false,
      // The reader that ACTUALLY looked at the file has the useful complaint.
      // A fallback note ("the model was unreachable") is true but it is not
      // what is wrong with the document, and putting it first sent an admin
      // looking at the API when their PDF simply had no text in it.
      error: read
        ? `${fileName} was read, but every passage in it was shorter than ${MIN_CHUNK_CHARS} characters, so there is nothing worth indexing.`
        : result.warnings?.[0] || warnings[0] || `No readable text was found in ${fileName}.`,
      warnings,
    };
  }

  return { ok: true, chunks, warnings, reader, usage };
}
