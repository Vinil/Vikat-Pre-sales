/**
 * product.js — which of Vikat's products a rep is selling, when the page
 * around the assistant says so.
 *
 * Vikat sells more than one thing, and the assistant was written when it sold
 * one: every prompt, every deck and one of the outreach checks assume the
 * security line. A page that embeds the assistant and knows better — the sales
 * portal, which knows which product a rep is working — can now say so, as
 *
 *   { key, name, definition, line }
 *
 * where `name` and `definition` are the product's own wording, written by the
 * people who own it, and `line` is "security" or "engineering".
 *
 * Nothing here supplies wording of its own. A product's name and definition
 * are the only product copy that ever comes from this path; everything else
 * either stays as it is or is left out.
 *
 * No product — Vinil's own deployment, every conversation it has ever had —
 * means exactly what it meant before this file existed. That is the default
 * every caller falls back to, and the tests pin it byte for byte.
 */

/**
 * @typedef {{ key: string, name: string, definition: string, line: string }} Product
 */

/**
 * Is this conversation on the security line, where everything written so far
 * already applies?
 *
 * Yes when no product is given, which is what keeps every existing deployment
 * unchanged. A line that is not "security" counts as not security, rather than
 * falling back to it: a deck about the wrong product wearing CYBERSEC on every
 * slide is the failure this exists to stop, and the only other line there is
 * today is Engineering.
 *
 * @param {Product|null|undefined} product
 */
export function sellsSecurity(product) {
  return !product || product.line === 'security';
}

/**
 * The product's one-line claim: its definition up to the first colon, ending
 * in a full stop.
 *
 * A definition is written to be read in full, and a cover has room for one
 * line. "Engineering capacity from Vikat for software companies and digital
 * teams: product development, QA automation…" already says which part is the
 * claim and which part is the list, so the cut is the writer's own rather
 * than a paraphrase of it. Empty when there is no definition to cut.
 *
 * @param {string|null|undefined} definition
 * @returns {string}
 */
export function definitionHeadline(definition) {
  const head = String(definition || '').split(':')[0].trim().replace(/[\s.]+$/, '');
  return head ? `${head}.` : '';
}
