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

import { KNOWLEDGE, KNOWLEDGE_TOKENS, KNOWLEDGE_META } from './knowledge.js';
import { POSITIONING_KEY, positioningBlock } from './positioning.js';

/** Every page in the compiled base, for retiring superseded uploads. */
const COMPILED_PAGES = new Set(KNOWLEDGE.map((c) => c.page));

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

  // Positioning is not retrieved, it is ALWAYS present. Everything below
  // answers a question; this answers the question behind every question, and a
  // rep can get every product fact right and still lose the deal by framing us
  // as the cheap version of a competitor. Reaching the model on only the turns
  // where a search happened to surface it would be no use.
  let positioning = '';
  if (sessionContext.storage) {
    try {
      positioning = positioningBlock(await sessionContext.storage.getSetting(POSITIONING_KEY));
    } catch (err) {
      console.error('[retrieve] positioning unavailable:', err?.message || err);
    }
  }

  // Admin-authored entries are merged at request time, so a correction typed
  // into the panel is live on the next message rather than the next deploy.
  // They come last: later entries read as the more recent word on a subject,
  // which is what an admin adding a correction intends.
  let runtime = [];
  if (sessionContext.storage) {
    try {
      const entries = await sessionContext.storage.listKnowledge();
      runtime = entries
        .filter((e) => e.status === 'approved' && e.content && e.content.trim())
        // An uploaded document is provisional: it answers questions from the
        // moment it is uploaded, and steps aside the night the sync indexes the
        // same file from SharePoint. Without this the assistant would hold two
        // copies of every uploaded document and cite whichever it retrieved.
        .filter((e) => !e.sourcePath || !COMPILED_PAGES.has(e.sourcePath))
        .map((e) => ({
          id: `admin:${e.id}`,
          page: 'admin/knowledge',
          section: e.section || 'Note',
          content: e.content.trim(),
        }));
    } catch (err) {
      // A KV hiccup must not take the assistant down. The compiled base is
      // still a good answer; log and carry on.
      console.error('[retrieve] runtime knowledge unavailable:', err?.message || err);
    }
  }

  const base = format([...KNOWLEDGE, ...runtime]);
  return positioning ? `${positioning}\n\n${base}` : base;
}

/**
 * Whether the compiled knowledge base has outgrown full injection.
 * Surfaced by GET /health so the B4 trigger is observable, not guesswork.
 *
 * The SharePoint fields describe the corpus this bundle was BUILT with, which
 * is the only honest answer to "when did the sync last run" that the Worker
 * can give: the sync runs in CI and cannot reach back here. It is also the
 * more useful one — it reports what the assistant actually knows, rather than
 * what a job elsewhere claimed to have done.
 *
 * @returns {{ tokens: number, chunks: number, shouldUseVectorSearch: boolean,
 *             sharePointChunks: number, sharePointSyncedAt: string|null }}
 */
export function retrievalStatus() {
  return {
    tokens: KNOWLEDGE_TOKENS,
    chunks: KNOWLEDGE.length,
    shouldUseVectorSearch: KNOWLEDGE_TOKENS > 50000,
    sharePointChunks: KNOWLEDGE_META.sharePointChunks || 0,
    sharePointSyncedAt: KNOWLEDGE_META.sharePointSyncedAt || null,
  };
}
