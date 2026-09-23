/**
 * references.js — the proof a stranger needs, and the rules that come with it.
 *
 * "A stranger does not act on claims alone" is already a note this codebase
 * pushes on every piece of outreach. Until now there was nothing to act on:
 * the knowledge base holds capabilities and no customers, so the assistant
 * could be told to name a reference and had none to name. An instruction with
 * nothing behind it produces an invented customer, which is the one failure
 * this project has refused from its first line.
 *
 * So proof lives here, the way positioning does: ONE editable text, saved by a
 * person who has read it, injected on every turn rather than retrieved. A
 * retrieved thing can be missed, and a proof point that only appears when a
 * search happens to surface it is not "in every email by default".
 *
 * WHY IT IS SEPARATE FROM POSITIONING, which is the obvious place to put it:
 *
 *   - Different lifecycle. Positioning changes when the company changes its
 *     mind. Proof changes when a deal closes.
 *   - Different clearance. A customer reference carries permission — which
 *     descriptor may be used, and whether the name may be said at all.
 *     Positioning carries none of that.
 *   - The checks need them addressable. "Does this outreach carry a proof
 *     point" cannot be answered against a paragraph about differentiation.
 *
 * THE CLEARANCE RULE, which is the whole reason this file is careful:
 *
 * References arrive as descriptors — "the world's largest berry producer" —
 * and a descriptor is what somebody uses when the name is not theirs to give.
 * The model must use the words as written and must never resolve them to the
 * company they point at. Working out which berry producer is the largest is
 * exactly the helpful move that breaks an NDA.
 */

export const REFERENCES_KEY = 'references';

/**
 * Long enough for a dozen proof points with their outcomes, short enough that
 * it cannot quietly eat the context every conversation shares.
 */
export const REFERENCES_MAX_CHARS = 8000;

/**
 * The shape an entry needs, shown to the admin writing them.
 *
 * Four fields and not three: the PROBLEM is what lets the model pick the right
 * reference for a prospect it has never seen. Matching on sector puts a berry
 * grower in front of an arbitration body and calls it relevance; matching on
 * the problem puts the right one there.
 */
export const REFERENCE_TEMPLATE = [
  'One block per customer. Leave out anything you cannot evidence.',
  '',
  'How to name them: exactly as you want it printed. If the name is not cleared,',
  'write the descriptor you are allowed to use and nothing else — the assistant',
  'is told never to work out who it points at.',
  '',
  'Who: the world\'s largest berry producer',
  'Name cleared: no — descriptor only',
  'Problem: what was going wrong, in their words',
  'What we did: the part that was ours',
  'Outcome: what changed, with the number if you have one and nothing if you do not',
].join('\n');

/**
 * The block injected ahead of the knowledge base.
 *
 * Empty string when nothing is saved, so the caller concatenates without
 * checking — and so the prompt says nothing about proof that does not exist.
 * That silence is deliberate: told to include a reference with none available,
 * a model supplies one.
 */
export function referencesBlock(saved) {
  const content = String(saved?.content || '').trim();
  if (!content) return '';

  return [
    '<references authority="verbatim">',
    'Customer proof, approved by the people who own the relationships.',
    '',
    'Use one in every piece of customer-facing outreach: the one whose PROBLEM',
    'is closest to the reader\'s, not the one whose industry is closest. One is',
    'enough, and it goes in as a sentence rather than a case study.',
    '',
    'Use the wording below EXACTLY as written. Where a customer is described',
    'rather than named, that is because the name is not ours to give: never',
    'work out which company the description points at, never substitute it, and',
    'never add a detail that is not here. If nothing below fits the reader,',
    'write the email without a reference rather than stretching one.',
    '',
    content,
    '</references>',
  ].join('\n');
}
