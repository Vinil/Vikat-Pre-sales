/**
 * pdfText.js — read a PDF by giving it to the model, not by parsing its bytes.
 *
 * scripts/lib/extract.js can pull text out of a PDF only when that PDF stores
 * it as plain text-showing operators. Most real ones do not: fonts get
 * subsetted with a custom encoding, and the bytes come back as noise. The
 * extractor's legibility check catches that and refuses — correctly, because
 * garbage in the knowledge base is worse than a missing document — but the
 * upshot was that uploading a PDF usually just failed.
 *
 * The model reads a PDF the way a person does, including scanned pages that
 * have no text layer at all, so that is the primary path here. The byte
 * extractor stays as the fallback for anywhere without an API key — notably
 * the nightly sync in CI, which has none.
 *
 * This SPENDS TOKENS on every PDF upload, which nothing else in the ingest
 * path does. That is deliberate and it is visible: the usage comes back with
 * the result and the admin panel prints it. Set PDF_READER=bytes to turn it
 * off and go back to the byte extractor everywhere.
 */

import Anthropic from '@anthropic-ai/sdk';

/** Anthropic's own limits on a document block. */
export const PDF_LIMITS = {
  // 32MB per request, but MAX_DOCUMENT_BYTES caps us far below that anyway.
  maxBytes: 32 * 1024 * 1024,
  // 100 pages for 200k-context models. Refused before spending anything.
  maxPages: 100,
};

/**
 * Bytes to base64, with no newlines — the API rejects a wrapped payload.
 *
 * Chunked because btoa needs a string and fromCharCode.apply blows the stack
 * on a whole file.
 */
export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

/**
 * Roughly how many pages, read off the page tree.
 *
 * Only used to refuse an over-long PDF BEFORE paying to send it, so an
 * approximation that errs low is fine — a wrong guess costs a clear API error
 * instead of a clear local one, never a wrong answer.
 */
export function estimatePages(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  const count = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
  if (count) return count;
  const declared = /\/Count\s+(\d+)/.exec(text);
  return declared ? Number(declared[1]) : 0;
}

const PROMPT = [
  'Transcribe this document into plain markdown so it can be indexed for search.',
  '',
  'Rules:',
  '- Reproduce the wording of the document. Do not summarise, shorten, comment on it or add anything that is not in it.',
  '- Start each section with "## " and the heading the document uses. If a page or slide has no heading, use a short one drawn from its own words.',
  '- Write tables as markdown tables and keep every row.',
  '- Describe a chart or diagram only by the labels and figures printed on it.',
  '- Skip page furniture: page numbers, repeated headers and footers, and slide numbers.',
  '- If a page is blank or unreadable, write "## Page N" and "(no readable content)" and carry on.',
  '',
  'Output the markdown and nothing else — no preamble, no closing remark.',
].join('\n');

/** Split the model's markdown back into the { title, content } sections ingest wants. */
export function splitSections(markdown, fallbackTitle) {
  const sections = [];
  let title = fallbackTitle;
  let body = [];

  const flush = () => {
    const content = body.join('\n').trim();
    if (content) sections.push({ title, content });
    body = [];
  };

  for (const line of String(markdown).split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      title = heading[1].trim() || fallbackTitle;
    } else {
      body.push(line);
    }
  }
  flush();

  return sections;
}

/**
 * Read a PDF with the model.
 *
 * @param {Uint8Array} bytes
 * @param {string} fileName
 * @param {{ env: object, cfg: object, client?: object }} deps
 * @returns {Promise<{ ok: true, sections: object[], warnings: string[], usage: object }
 *                 | { ok: false, reason: string }>}
 */
export async function readPdfWithModel(bytes, fileName, { env, cfg, client } = {}) {
  if (!env?.ANTHROPIC_API_KEY) return { ok: false, reason: 'no API key is configured' };

  if (bytes.byteLength > PDF_LIMITS.maxBytes) {
    return { ok: false, reason: `the file is larger than ${PDF_LIMITS.maxBytes / (1024 * 1024)}MB` };
  }

  const pages = estimatePages(bytes);
  if (pages > PDF_LIMITS.maxPages) {
    return {
      ok: false,
      reason: `it has about ${pages} pages and the limit is ${PDF_LIMITS.maxPages}; split it and upload the parts`,
    };
  }

  const api = client || new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  let message;
  try {
    // Streamed: a long document takes minutes of generation and a single
    // non-streaming request would hit the HTTP timeout before it finished.
    message = await api.messages
      .stream({
        model: cfg.MODEL,
        max_tokens: cfg.PDF_READ_MAX_TOKENS || cfg.MAX_TOKENS,
        messages: [
          {
            role: 'user',
            content: [
              // The document goes FIRST. The API is explicit that a document
              // block belongs before the text that refers to it.
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: toBase64(bytes) },
              },
              { type: 'text', text: PROMPT },
            ],
          },
        ],
        // No thinking. Transcription needs none, and thinking is drawn from
        // max_tokens before any visible text — on a long PDF it would eat the
        // budget the transcript itself needs.
      })
      .finalMessage();
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  }

  const markdown = (message.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  if (!markdown) return { ok: false, reason: 'the model returned nothing' };

  const warnings = [];
  if (message.stop_reason === 'max_tokens') {
    // Say so. A silently truncated transcript is a knowledge base that is
    // confidently missing the second half of a document.
    warnings.push(
      `${fileName} was too long to read in one pass — only the first part was indexed. Split it and upload the parts.`,
    );
  }

  return {
    ok: true,
    sections: splitSections(markdown, fileName),
    warnings,
    usage: {
      inputTokens: message.usage?.input_tokens ?? 0,
      outputTokens: message.usage?.output_tokens ?? 0,
      pages,
    },
  };
}
