/**
 * retrieve.js — knowledge abstraction.
 *
 * Forward-compatibility rule 2: knowledge injection goes through exactly one
 * function, `retrieve(query, sessionContext)`. Tier A ignores `query` and
 * returns the whole compiled knowledge base. Tier B (B4) swaps the body for a
 * Vectorize similarity search — embed `query`, fetch top-k, format the same
 * way — with no change at any call site.
 *
 * The return value is a formatted string ready to concatenate into the system
 * prompt. Keeping formatting here (rather than at the call site) is what makes
 * the Tier B swap a single-file change.
 */

import { KNOWLEDGE, KNOWLEDGE_TOKENS } from './knowledge.js';

/**
 * @typedef {object} SessionContext
 * @property {string} [sessionId]
 * @property {object} [lead]      Tier B (B2): captured lead for returning visitors.
 * @property {number} [turnCount]
 */

/**
 * Format chunks into the block injected into the system prompt.
 *
 * @param {import('./knowledge.js').KnowledgeChunk[]} chunks
 * @returns {string}
 */
function format(chunks) {
  if (chunks.length === 0) {
    return [
      '<knowledge_base status="empty">',
      'The knowledge base has not been populated. You do not currently have any',
      'material about Vikat products or solutions. Answer no product question from',
      'memory or inference. Say plainly that you cannot answer it and offer to put',
      'the prospect in touch with the team.',
      '</knowledge_base>',
    ].join('\n');
  }

  const body = chunks
    .map((c) => `<entry source="${c.page}" section="${escapeAttr(c.section)}">\n${c.content}\n</entry>`)
    .join('\n\n');

  return `<knowledge_base>\n${body}\n</knowledge_base>`;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Retrieve the knowledge to inject for this turn.
 *
 * Tier A: returns everything, `query` unused. The signature carries `query` and
 * `sessionContext` from day one precisely so B4 needs no caller changes.
 *
 * @param {string} query            The prospect's latest message.
 * @param {SessionContext} [sessionContext]
 * @returns {Promise<string>}       Formatted knowledge block.
 */
export async function retrieve(query, sessionContext = {}) {
  void query;
  void sessionContext;
  return format(KNOWLEDGE);
}

/**
 * Whether the compiled knowledge base has outgrown full injection.
 * Surfaced by GET /health so the B4 trigger is observable, not guesswork.
 *
 * @returns {{ tokens: number, chunks: number, shouldUseVectorSearch: boolean }}
 */
export function retrievalStatus() {
  return {
    tokens: KNOWLEDGE_TOKENS,
    chunks: KNOWLEDGE.length,
    shouldUseVectorSearch: KNOWLEDGE_TOKENS > 50000,
  };
}
