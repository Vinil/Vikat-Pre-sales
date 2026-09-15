/**
 * articulation.js — how the writing sounds, and how to tell when it doesn't.
 *
 * Every other check in this codebase is about facts: is this figure sourced,
 * is this product real, is this hex approved. This one is about whether a
 * stakeholder reads two sentences and keeps going.
 *
 * SOURCES, and they agree:
 *   Semantic Suite Brand Guidelines §07 — "Spare, declarative, technical.
 *   Confident without hype, precise without jargon, and it trusts the reader."
 *   Vikat TM3 §08 — "Direct. Grounded. Confident. Human." and, the line that
 *   settles most arguments: "When in doubt, pick the shorter, plainer option."
 *
 * And one requirement neither document makes, because neither was written for
 * a machine that writes: it must not read as though a model wrote it. That is
 * not a matter of taste. A rep sends this under their own name to someone who
 * reads twenty of these a week, and the tells below are what that reader has
 * learned to skip. Copy that announces its own origin is copy that gets
 * deleted before the point arrives.
 *
 * checkArticulation() is advisory by design. Voice is a judgement and a
 * checker that blocked on it would be wrong about a good sentence sooner or
 * later; these are notes for a person, never a refusal.
 */

/**
 * Openings that belong to no one.
 *
 * Each of these can open a message about literally any company in any
 * industry, which is the definition of a wasted first line. The first line is
 * the only one guaranteed to be read.
 */
const HOLLOW_OPENERS = [
  /\bin (?:today's|todays) (?:rapidly )?(?:evolving|changing|fast[- ]paced)\b/i,
  /\bin an era (?:of|where)\b/i,
  /\bin the (?:rapidly )?evolving (?:landscape|world)\b/i,
  /\bas (?:organi[sz]ations|companies|businesses|teams) (?:increasingly|continue to)\b/i,
  /\bi hope this (?:email |message )?finds you well\b/i,
  /\bi wanted to reach out\b/i,
];

/**
 * Words a model reaches for and a person does not.
 *
 * Not banned for being long. Banned because each one replaces a specific verb
 * with a vague one: "leverage" is "use" with the meaning removed, "robust" is
 * a claim with nothing behind it. §07 asks for precise without jargon, and
 * this is the jargon that arrives by default rather than by choice.
 */
const MODEL_TELLS = [
  'delve', 'leverage', 'utilize', 'utilise', 'robust', 'seamless', 'seamlessly',
  'unlock', 'empower', 'empowering', 'harness', 'holistic', 'synergy',
  'game-changer', 'game changer', 'cutting-edge', 'state-of-the-art',
  'revolutionize', 'revolutionise', 'transformative', 'paradigm shift',
  'best-in-class', 'world-class', 'unparalleled', 'unlock the power',
  'navigate the complexities', 'ever-evolving', 'tapestry', 'realm',
  'testament to', 'underscores', 'pivotal', 'myriad',
];

/**
 * Shapes, rather than words. These are the ones people actually notice.
 */
const MODEL_SHAPES = [
  {
    re: /\bit'?s not (?:just|only) [^.!?]{3,60}?,? it'?s\b/i,
    say: 'the "it\'s not just X, it\'s Y" construction',
  },
  {
    re: /\bnot only [^.!?]{3,60}? but (?:also )?\b/i,
    say: 'the "not only X but also Y" construction',
  },
  {
    re: /^(?:moreover|furthermore|additionally|in conclusion|in summary|overall|ultimately)\b/im,
    say: 'an essay connective opening a paragraph',
  },
  {
    re: /\b(?:let'?s dive in|let me break (?:this|it) down|here'?s the thing|the bottom line is)\b/i,
    say: 'a presenter\'s filler phrase',
  },
  {
    re: /\bi hope this helps\b|\bfeel free to (?:reach out|ask)\b|\blet me know if you have any (?:questions|other)\b/i,
    say: 'an assistant\'s sign-off',
  },
  {
    re: /\bcan help (?:to )?(?:potentially|possibly)\b|\bmay be able to potentially\b/i,
    say: 'stacked hedging that commits to nothing',
  },
];

/** §07 and §08 both: no emoji, anywhere. */
const EMOJI =
  /[‼-㊙\u{1F000}-\u{1FAFF}\u{1F900}-\u{1F9FF}\u{2600}-\u{27BF}]/u;

/**
 * The voice, for the system prompt.
 *
 * Written as instructions to follow rather than adjectives to admire. "Be
 * direct" is not actionable; "the outcome first, in the first sentence" is.
 */
export const ARTICULATION_BLOCK = `## How it has to read

Four attributes, from the brand guidelines, and they are the same in both.

- **Direct.** The outcome first, in the first sentence. Short sentences, plain
  words. A busy engineer skims and understands immediately.
- **Grounded.** Claim only what is true. Precision builds trust faster than
  superlatives, and one specific fact beats three adjectives.
- **Confident.** An expert peer, not a pitch. Confident without boasting,
  knowledgeable without jargon.
- **Human.** A partner, not a platform. Address the reader as "you". Warmth is
  allowed. Sound like a colleague, not a press release.

Spare, declarative, technical. It names the gap and trusts the reader. When in
doubt, pick the shorter, plainer option.

**It must not read as though a machine wrote it.** A rep sends this under their
own name to someone who reads twenty of these a week. So:

- Never open on a line that would fit any company. "In today's evolving
  landscape" and "I hope this finds you well" are the first thing a reader
  skips. Open on the specific thing: the announcement, the date, the number,
  the person who said it.
- No "it's not just X, it's Y". No "not only, but also". No paragraph starting
  Moreover, Furthermore, Additionally or In conclusion.
- Drop the words that arrive by default rather than by choice: leverage,
  utilize, robust, seamless, unlock, empower, harness, cutting-edge,
  transformative, game-changer. Each replaces a specific verb with a vague one.
- No closing summary that restates what you just said, and no assistant's
  sign-off. The last line is the ask, or it is nothing.
- No emoji, and no ALL-CAPS except a mono kicker.
- Vary the sentences. Three tidy parallel clauses in a row is the rhythm of
  generated text, and a reader clocks it before they can say why.

One idea per paragraph. If a sentence survives deletion without the meaning
changing, delete it.`;

/**
 * Read a piece of copy the way its recipient will.
 *
 * @param {string} text  What the rep is about to send or present.
 * @returns {{ notes: string[] }}  Advisory, always. Voice is a judgement.
 */
export function checkArticulation(text) {
  const copy = String(text || '');
  const notes = [];
  if (!copy.trim()) return { notes };

  // The first line carries the whole message, so it gets its own check rather
  // than being one more hit in a list.
  const opener = copy.trim().split('\n')[0];
  for (const re of HOLLOW_OPENERS) {
    if (re.test(opener)) {
      notes.push(
        'The first line would fit any company. That is the line a reader skips, and it is the only one guaranteed to be read: open on the specific thing instead.',
      );
      break;
    }
  }

  const found = MODEL_TELLS.filter((w) =>
    new RegExp(`\\b${w.replace(/[-\s]/g, '[-\\s]')}\\b`, 'i').test(copy),
  );
  if (found.length) {
    notes.push(
      `Reads as generated: ${found.slice(0, 5).join(', ')}. Each one swaps a specific verb for a vague one.`,
    );
  }

  for (const shape of MODEL_SHAPES) {
    if (shape.re.test(copy)) notes.push(`Reads as generated: ${shape.say}.`);
  }

  if (EMOJI.test(copy)) notes.push('No emoji in brand materials.');

  // Sentence length. Not a rule anybody wrote down, but "short sentences,
  // plain words" has a number behind it, and copy averaging thirty words a
  // sentence is not what either document is describing.
  const sentences = copy.split(/[.!?]+\s/).filter((s) => s.trim().length > 1);
  if (sentences.length >= 3) {
    const words = copy.split(/\s+/).filter(Boolean).length;
    const mean = words / sentences.length;
    if (mean > 28) {
      notes.push(
        `Averaging ${Math.round(mean)} words a sentence. Short sentences, plain words: a reader skimming this on a phone gets the first clause and stops.`,
      );
    }
  }

  return { notes };
}
