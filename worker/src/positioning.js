/**
 * positioning.js — the statement that outranks the knowledge base.
 *
 * Everything in the knowledge base answers a question. This answers the
 * question behind every question: what Vikat actually is, and why a buyer
 * chooses it over the alternative they are also looking at.
 *
 * It is kept apart from `kb:` entries for one reason: those are RETRIEVED, and
 * a retrieved thing can be missed. Positioning is injected on every single
 * turn, ahead of the knowledge base, and the prompt tells the model it wins
 * where the two disagree. A rep can get every product fact right and still
 * lose a deal by framing us as the cheap version of a competitor.
 *
 * One editable text, not chunks. An upload fills the field and the admin saves
 * it deliberately — nothing governs every answer the assistant gives without a
 * person having read it first.
 */

export const POSITIONING_KEY = 'positioning';

/**
 * Long enough for a real positioning document, short enough that it cannot
 * quietly eat the context every conversation shares.
 */
export const POSITIONING_MAX_CHARS = 24000;

/**
 * The block injected ahead of the knowledge base.
 *
 * Empty string when nothing is set, so the caller can concatenate without
 * checking — and so the prompt says nothing about a document that does not
 * exist, which is the failure mode that produced an invented architecture
 * once already.
 */
export function positioningBlock(saved) {
  const content = String(saved?.content || '').trim();
  if (!content) return '';

  const source = saved.sourceName ? ` source="${escapeAttr(saved.sourceName)}"` : '';
  return [
    `<positioning authority="highest"${source}>`,
    'This is how Vikat positions itself and how it differs from the alternatives.',
    'It was written by the people who own the message, and it OUTRANKS anything',
    'in the knowledge base it disagrees with — including a product page, a deck,',
    'or an older document that says otherwise. Lead with it whenever you explain',
    'what Vikat is, why it is different, or why a buyer would choose it.',
    '',
    content,
    '</positioning>',
  ].join('\n');
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
