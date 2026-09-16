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
changing, delete it.

## Every headline answers "why should I care"

The headline is the only line guaranteed to be read, so it has to say something
rather than label something.

- **In words they already use.** "SecSemantic for McLane" tells a McLane
  executive nothing: they have never heard of SecSemantic, and you have spent
  the one line they will read on a word they cannot parse. Name the product
  once the idea has landed, in the body, never in the headline.
- **Say the point, do not file it.** "The commitment model", "How the suite
  fits", "Our approach" are drawer labels. What is this slide actually
  claiming? That sentence is the headline. "Two surfaces now land on every
  healthcare CISO's desk" is a headline. "The Security Context Plane" is not.
- **A headline is a sentence, not a noun phrase.** "Beyond detection", "The
  commitment model", "The quiet shift" are evocative and say nothing: the
  reader has to reach the body to find out what was meant, which is the
  opposite of what a headline is for. Put a verb in it and make a claim.
- Plain English a busy executive reads at a glance, and no ALL-CAPS.

## Say who we are before you use our words

Anything going outside the building introduces Vikat, early, in a sentence:
what we do and what we stand for, in the reader's language rather than ours.
A CISO who has never met us is reading advice from a stranger until you do.

And nothing is named before that introduction lands. SecSemantic, VShield, the
Security Context Plane, the suite: to a reader who has not been told who we
are, each one is a proper noun belonging to nobody, arriving while they are
still deciding whether to keep reading. Introduce, then name, then explain.

## The order it goes in

Open where the reader already feels good, not on what is wrong with their
company. Someone rolling AI agents across four hundred sites is proud of that
and should be. The opportunity is the NEXT level, not the hole.

1. **Personalize.** Name the work they have actually done: the programme, the
   launch, the thing the executive said in public. Specific, or leave it out. A
   compliment that would fit any company is worse than none.
2. **Their priorities.** What they are trying to do next and where it gets
   hard. The thing keeping them up, in their words. Opportunity, never deficiency.
3. **Why now.** What changed and what waiting costs. A date, a filing, a
   regulation, a season, a competitor. If nothing changed, say so and argue on
   merit rather than manufacturing urgency.
4. **How we accelerate.** The differentiated answer, SHOWN through an example
   on their stack rather than described. Not a feature list, and never a
   product name standing in for a benefit.
5. **Next steps.** One ask, small enough to say yes to in a reply.

## Make it visual

A deck is looked at, not read. Anything that is a number, a comparison, a
sequence or a set gets a drawn layout: stat, bars, tiles, table, kpi, outcome,
paradigm, flow. A section that is a heading over four lines of prose and five
bullets is a document someone will skim and forget. If more than half the
slides are prose, the deck is not finished.

## Never call your own work ready

Not "ready for customer use", not "polished", not "client-ready". A rep decides
when something is ready, and on a deck stamped DRAFT it is not even true. Say
what you built and what they should check before it leaves the building.`;


/**
 * The order a proposition goes in.
 *
 * Not a template to fill in. It is the sequence a person uses when they have
 * earned the meeting and want to keep it, and the current decks do not follow
 * it: they open on the problem, which reads as a stranger telling you what is
 * wrong with your company.
 *
 * Start where the reader already feels good. Someone rolling AI agents across
 * 418 sites is proud of that, and rightly. The opportunity is the NEXT level,
 * not the hole.
 */
export const STORY_ARC = [
  {
    beat: 'Personalize',
    does: 'Acknowledge the work they have actually done. The programme, the launch, the thing the executive said in public. Named and specific, or leave it out.',
    fails: 'A compliment that would fit any company is worse than no compliment.',
  },
  {
    beat: 'Their priorities',
    does: 'Taking it to the next level: what they are trying to do next, and where that gets hard. The thing keeping them up, in their words.',
    fails: 'Telling them their business is broken. The frame is opportunity, not deficiency.',
  },
  {
    beat: 'Why now',
    does: 'What changed, and what it costs to wait. A date, a filing, a regulation, a season, a competitor.',
    fails: 'Manufactured urgency. If nothing changed, say so and make the case on merit.',
  },
  {
    beat: 'How we accelerate',
    does: 'The differentiated answer, shown through an example rather than described. What it does on their stack, for their problem.',
    fails: 'A feature list, or a product name standing in for a benefit.',
  },
  {
    beat: 'Next steps',
    does: 'One ask, small enough to say yes to in a reply.',
    fails: 'Three options, or a paragraph that ends without asking for anything.',
  },
];

/**
 * Vocabulary that means nothing outside this building.
 *
 * "SecSemantic for McLane" tells a McLane executive nothing: they have never
 * heard of SecSemantic, and the headline has spent the one line they will
 * definitely read on a word they cannot parse. Inside the body, after the idea
 * has landed, these names are fine. In a HEADLINE they are a closed door.
 */
const INSIDE_WORDS = [
  'SecSemantic', 'DevSemantic', 'ProSemantic',
  'VSentinel', 'VInsight', 'VCommand', 'VShield',
  'SCP', 'DCP', 'PCP',
  'Security Context Plane', 'Development Context Plane', 'Process Context Plane',
  'Context Plane', 'Semantic Suite', 'Atomic Pod', 'the suite',
];

/**
 * Headlines that label a slide instead of saying something.
 *
 * "The commitment model" and "How the suite fits" are filing labels. They tell
 * a reader which drawer the slide lives in, not why they should care, and a
 * deck of them reads as a table of contents with pictures.
 */
const LABEL_HEADLINES =
  /^(?:the\s+\w+\s+(?:model|framework|approach|architecture|platform|plane|layer)|how\s+(?:it|the|we)\b[^?]*|our\s+\w+|what\s+we\s+do|overview|introduction|summary|next\s+steps?|the\s+solution|key\s+benefits?)$/i;

/**
 * A headline that is a noun phrase rather than a claim.
 *
 * "The articulation including headlines that are cryptic" — the first of six
 * notes on a brief, and the hardest of them to make mechanical, because
 * cryptic is not a word list. LABEL_HEADLINES catches the filing labels
 * ("Our approach", "Overview"); it does not catch "Beyond detection" or "The
 * quiet shift", which are not labels. They are gestures.
 *
 * What the two have in common is grammatical and checkable: no verb. A
 * headline with no verb makes no claim, so the reader has to reach the body to
 * find out what was meant — which is the opposite of what a headline is for.
 *
 * Three conditions together, because any one alone over-fires:
 *
 *   - it opens on a determiner or a preposition, so it is a phrase and not a
 *     fragment of something longer;
 *   - it is short, six words or fewer — past that a headline is usually
 *     carrying a clause whether or not this list knows the verb in it;
 *   - and it contains none of the verbs below.
 *
 * A closed list, not a part-of-speech guess. "Three surfaces" and "The costs
 * model" both end in -s and neither is a verb, so any suffix rule flags them;
 * a list of the fifty commonest finite verbs and auxiliaries under-fires
 * instead, which for an advisory note is the right direction to be wrong in.
 */
const PHRASE_OPENER = /^(?:the|a|an|our|its|their|this|these|those|beyond|inside|within|after|before|behind|under|toward|towards)\b/i;

const FINITE_VERB = new RegExp(
  `\\b(?:${[
    'is', 'are', 'was', 'were', 'be', 'been', 'am', 'has', 'have', 'had',
    'do', 'does', 'did', 'can', 'could', 'will', 'would', 'shall', 'should',
    'must', 'may', 'might', 'need', 'needs', 'means', 'mean', 'costs', 'cost',
    'sets', 'set', 'moves', 'moved', 'move', 'lands', 'land', 'takes', 'take',
    'took', 'makes', 'make', 'made', 'gets', 'get', 'got', 'goes', 'go', 'went',
    'says', 'say', 'said', 'stops', 'stop', 'starts', 'start', 'buys', 'buy',
    'ranks', 'rank', 'sees', 'see', 'knows', 'know', 'wants', 'want',
    'happens', 'happen', 'changed', 'changes', 'change', 'arrives', 'arrive',
  ].join('|')})\\b`,
  'i',
);

function saysNothing(h) {
  const count = h.trim().split(/\s+/).filter(Boolean).length;
  return count <= 6 && count >= 2 && PHRASE_OPENER.test(h) && !FINITE_VERB.test(h);
}

/**
 * Claims about our own output that are not ours to make.
 *
 * "Ready for customer use" is the assistant congratulating itself, and on a
 * deck stamped DRAFT, NEEDS APPROVAL BEFORE IT LEAVES VIKAT it is also false.
 * A rep decides when something is ready. The assistant says what it built.
 */
const SELF_CONGRATULATION = [
  /\bready (?:for|to) (?:customer|client|external|send|use|share|go)/i,
  /\bcustomer[- ]ready\b|\bclient[- ]ready\b|\bpresentation[- ]ready\b/i,
  /\bpolished (?:and|,)|\bprofessionally (?:designed|formatted|crafted)/i,
  /\bthis (?:deck|document|one[- ]pager) is (?:complete|finished|good to go)/i,
];

/**
 * What counts as naming us.
 *
 * "Vikat.AI" and "Vikat" both, and the trailing boundary keeps it off
 * "Vikatai.sharepoint.com" and anything else that merely contains the letters.
 */
const NAMES_US = /\bVikat(?:\.AI)?\b/i;

/** Disclosures that mean a customer will read this. */
const CUSTOMER_BOUND = new Set(['external_ok', 'needs_approval']);

/**
 * Words that mean nothing to a reader who has never met us, in reading order.
 *
 * Every passage a reader passes through, flattened. Reading order matters and
 * a joined blob loses it: the whole question here is whether the product name
 * arrives BEFORE or AFTER the sentence that says who we are.
 */
function passages(spec) {
  const out = [String(spec.title || ''), String(spec.subtitle || '')];
  for (const s of spec.sections || []) {
    out.push(String(s.eyebrow || ''), String(s.title || ''), String(s.body || ''));
    for (const p of s.points || []) out.push(String(p));
  }
  return out.filter((p) => p.trim());
}

const words = (text) => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * Does a stranger know who we are before we start using our own vocabulary?
 *
 * Two of the six notes on AAA_CISO_Brief_1.pdf, and they are one fault:
 *
 *   "All of a sudden there's a reference of SecSemantic"
 *   "No introduction of Vikat and what we stand for and do"
 *
 * checkHeadline already refused an inside word in a HEADLINE, and that rule
 * was working — the brief kept its product names out of its headings and put
 * SecSemantic in the body instead, where nothing was looking. The rule was
 * never about headlines. It is about a reader meeting a word they cannot
 * parse, and that happens wherever the word first appears.
 *
 * So: the first passage that names a product is compared against the first
 * passage that introduces us. A CISO who has never heard of Vikat reads a
 * brief about their own fulfillment calendar, and three paragraphs in a
 * proper noun appears that belongs to a company they have not been told the
 * name of.
 *
 * Scoped to what leaves the building. An internal deal review may open on
 * SecSemantic, because everybody reading it has heard of SecSemantic.
 *
 * A draft awaiting approval counts as leaving the building: approval is the
 * last gate before it does, which is exactly when the missing introduction has
 * to be caught.
 *
 * @param {object} spec  A spec through normaliseSpec().
 * @returns {{ problems: string[] }}
 */
export function checkIntroduction(spec) {
  const problems = [];
  // An ALLOWLIST, and the cautious default matches normaliseSpec's own: an
  // unrecognised or missing disclosure is treated as internal. `!== internal_only`
  // was the other way round, and it made every spec built by hand — a test
  // fixture, a caller that forgot the field — a customer document with a
  // missing introduction.
  if (!CUSTOMER_BOUND.has(spec.disclosure)) return { problems };

  const text = passages(spec);

  // An introduction is a SENTENCE about us, not our name in a footer. Six
  // words is the floor: "Vikat.AI" on its own, or "Vikat CyberSec LLC", is a
  // signature, and a signature introduces nobody.
  const introduced = text.findIndex((p) => NAMES_US.test(p) && words(p) >= 6);

  let named = -1;
  let product = '';
  text.forEach((p, i) => {
    if (named !== -1) return;
    const hit = INSIDE_WORDS.find((w) => new RegExp(`\\b${w}\\b`, 'i').test(p));
    if (hit) {
      named = i;
      product = hit;
    }
  });

  if (named !== -1 && (introduced === -1 || introduced > named)) {
    problems.push(
      `${product} is named before this document says who Vikat is. To a reader who has never ` +
        'heard of us that is a proper noun belonging to nobody, and it arrives while they are ' +
        'still deciding whether to keep reading. Introduce Vikat and what it does first, in a ' +
        'sentence, then name the product.',
    );
  }

  if (introduced === -1) {
    problems.push(
      'Nothing here says who Vikat is or what it does. This goes to someone outside the ' +
        'building: one or two sentences, early, in their language rather than ours — what we do ' +
        'and what we stand for — or the whole document is advice from a stranger.',
    );
  }

  return { problems };
}

/**
 * Read a headline the way the person receiving it will.
 *
 * Separate from checkArticulation because a headline is not a short paragraph.
 * It is the only line guaranteed to be read, it has to answer "why should I
 * care" on its own, and the rules that make a good sentence are not the rules
 * that make a good headline.
 *
 * @param {string} headline
 * @returns {{ notes: string[] }}
 */
export function checkHeadline(headline) {
  const h = String(headline || '').trim();
  const notes = [];
  if (!h) return { notes };

  const inside = INSIDE_WORDS.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(h));
  if (inside.length) {
    notes.push(
      `"${h}" opens on ${inside[0]}, which the reader has never heard of. A headline has to answer "why should I care" in words they already use; name the product once the idea has landed.`,
    );
  }

  if (LABEL_HEADLINES.test(h)) {
    notes.push(
      `"${h}" labels the slide rather than saying something. What is the point of this slide, in one plain sentence? That is the headline.`,
    );
  } else if (saysNothing(h)) {
    // else, because a filing label is also a noun phrase and one note about
    // one headline is enough. The label message is the more specific of the
    // two and says the same thing about what to do next.
    notes.push(
      `"${h}" is a phrase, not a claim: there is no verb in it, so a reader has to reach the body to find out what was meant. A headline makes the point on its own.`,
    );
  }

  return { notes };
}

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

  // §07, first rule on the page: "No dashes in narrative copy. Use commas,
  // periods or a new sentence instead."
  //
  // This was missing until the message ANNOUNCING this component was run
  // through it and came back clean while containing three. noDashes() is
  // applied to drafts in outreach.js and to documents through brandSafe, so
  // the rule was enforced in both places that render and in neither place that
  // reads — and the module whose entire job is how the writing sounds was the
  // one not looking for it.
  const dashes = (copy.match(/[—–]/g) || []).length;
  if (dashes) {
    notes.push(
      `${dashes} dash${dashes > 1 ? 'es' : ''} in the copy. §07 wants a comma, a full stop or a new sentence: a dash is usually two thoughts that have not been separated yet.`,
    );
  }

  for (const re of SELF_CONGRATULATION) {
    if (re.test(copy)) {
      notes.push(
        'Do not call your own output ready, polished or customer-ready. A rep decides that, and on a deck stamped DRAFT it is not even true. Say what you built and what they should check.',
      );
      break;
    }
  }

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
