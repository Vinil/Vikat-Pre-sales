/**
 * collateral.js — the SharePoint document index.
 *
 * One entry per file the nightly sync indexed, as opposed to the passages in
 * knowledge.js. Two callers want documents rather than text: the Collateral
 * tab, which lists them, and the `find_collateral` tool, which hands a rep a
 * link to send.
 *
 * Ranking is a deliberately plain term match. It is not, and does not pretend
 * to be, semantic search: a rep looking for collateral knows roughly what it
 * is called, and a wrong-but-confident ranking is worse than an obvious one.
 * When Tier B brings Vectorize in, `searchCollateral` is the single seam that
 * changes — same signature, same return shape.
 *
 * A link is not a grant. SharePoint authorises every click itself, so a rep
 * who cannot open a document still sees it here and gets SharePoint's own
 * refusal. That is why the endpoint is safe to serve whole to any rep, and
 * why nothing here needs its own permission model.
 */

import { COLLATERAL } from './knowledge.js';

/** How many documents a search returns when the caller does not say. */
const DEFAULT_LIMIT = 25;

/** Fields searched, and how much a hit in each is worth. */
const FIELD_WEIGHTS = [
  ['name', 6],
  ['library', 3],
  ['folder', 3],
  ['summary', 1],
];

function terms(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/**
 * Score one document against the search terms.
 *
 * Every term must appear somewhere, so "vshield pricing" does not match a
 * document that is merely about pricing. Returns 0 when it does not match.
 */
function score(doc, list) {
  let total = 0;

  for (const term of list) {
    let best = 0;
    for (const [field, weight] of FIELD_WEIGHTS) {
      const value = String(doc[field] || '').toLowerCase();
      if (!value.includes(term)) continue;
      // A whole-word hit beats a hit inside a longer word: "sase" should not
      // rank a document about "phase one" above the SASE deck.
      const whole = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(value);
      best = Math.max(best, whole ? weight * 2 : weight);
    }
    if (best === 0) return 0;
    total += best;
  }

  return total;
}

/**
 * Rank a document list against a query.
 *
 * Separate from searchCollateral because the corpus is baked into the bundle
 * at build time: this is the half that can be exercised against a known set.
 *
 * An empty query returns the list unchanged — newest first, as built — which
 * is the Collateral tab's initial view and what a browsing rep wants.
 *
 * @param {import('./knowledge.js').CollateralDocument[]} documents
 * @param {string} query
 * @param {{ limit?: number }} [options]
 * @returns {import('./knowledge.js').CollateralDocument[]}
 */
export function rankDocuments(documents, query, options = {}) {
  const list = terms(query);

  if (list.length === 0) {
    return options.limit ? documents.slice(0, options.limit) : documents.slice();
  }

  const limit = options.limit || DEFAULT_LIMIT;

  return documents
    .map((doc) => ({ doc, s: score(doc, list) }))
    .filter((r) => r.s > 0)
    // Equal scores keep source order, which is newest-first, because
    // Array.prototype.sort is required to be stable.
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((r) => r.doc);
}

/**
 * Search the indexed collateral.
 *
 * @param {string} query
 * @param {{ limit?: number }} [options]
 * @returns {import('./knowledge.js').CollateralDocument[]}
 */
export function searchCollateral(query, options = {}) {
  return rankDocuments(COLLATERAL, query, options);
}

/**
 * The compiled index plus documents uploaded since it was built.
 *
 * An upload is provisional in exactly the way an uploaded knowledge chunk is:
 * it shows in the Collateral tab immediately, and drops out the night the sync
 * indexes the same file from SharePoint and the compiled index carries it. One
 * document, one row, whichever side of that boundary you are on.
 */
export function searchCollateralWith(uploaded, query, options = {}) {
  const compiledPages = new Set(COLLATERAL.map((d) => d.page));
  const extra = (uploaded || []).filter((d) => d.page && !compiledPages.has(d.page));
  return rankDocuments([...extra, ...COLLATERAL], query, options);
}

export function collateralCount() {
  return COLLATERAL.length;
}
