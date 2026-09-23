import { CUSTOMER_BOUND } from './execOutreach.js';

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
 * Telling the reader what their own actions prove about them.
 *
 * The one that has to go. An email to Zscaler opened:
 *
 *   "The AI security hires you're making right now, engineers working in Go,
 *    Rust, and Python on agent security, show you're thinking carefully about
 *    what Model Context Protocol in production actually means for your attack
 *    surface."
 *
 * Thirty-eight words, two nested clauses before the verb arrives, and the
 * sentence spends all of them awarding the reader a compliment inferred from
 * a job advert. Nobody writes like this. A person writes "You're hiring Go,
 * Rust and Python engineers for agent security" and moves on, because the
 * reader already knows what their own hiring means and did not ask a stranger
 * to tell them.
 *
 * It is the most reliable tell there is: a machine reaching for rapport by
 * reading a mind from a public fact. Every one of these shapes does it.
 */
const MIND_READING = [
  {
    re: /\b(?:shows?|suggests?|signals?|tells (?:me|us))\b[^.!?]{0,40}\byou(?:'re| are|r team)\b/i,
    say: 'telling them what their own actions prove about them',
  },
  { re: /\bthe fact that you\b/i, say: 'an inference about them, drawn out loud' },
  {
    re: /\byou(?:'re| are) (?:clearly|obviously|evidently)\b|\bit(?:'s| is) clear (?:that )?you\b/i,
    say: 'deciding on their behalf what is clear',
  },
  { re: /\bi(?:'ve| have) been (?:following|watching|tracking) (?:your|the)\b/i, say: 'a stranger saying they have been watching' },
  { re: /\bcongratulations on\b|\bimpressive\b/i, say: 'a compliment nobody asked for' },
  {
    re: /\byour (?:commitment|focus|dedication|investment|emphasis|approach) (?:to|on|in)\b/i,
    say: 'praising an attitude you inferred from a web page',
  },
  { re: /\bas (?:someone|a (?:leader|company|team|pioneer)) who\b/i, say: 'a flattery opener' },
  { re: /\bspeaks volumes\b|\bsays a lot about\b/i, say: 'a reading of their character' },
];

/**
 * Telling them what their own tooling cannot do.
 *
 * The mirror of mind-reading, and the one that costs most. The Zscaler email
 * said "no SIEM or scanner in your stack answers it" — an absolute, about an
 * estate we have never seen, to a company that sells security tooling. The
 * reader's first thought is "you don't know what's in my stack", and they are
 * right.
 *
 * The claim is usually TRUE and always unprovable from outside. Said as a
 * question it survives: "does anything in your stack answer that?" invites a
 * reply instead of daring one.
 */
const KNOWS_THEIR_STACK = [
  /\bno\s+\w+(?:[,\s]+(?:or|and)\s+\w+)?\s+in your (?:stack|estate|environment|tooling)\b/i,
  /\byour (?:stack|estate|tools?|tooling|SIEM|scanner)s?\s+(?:cannot|can't|does not|doesn't|won't|will not)\b/i,
  /\bnothing (?:you (?:run|own|have)|in your \w+)\b[^.!?]{0,20}\b(?:can|does|will|answers?)\b/i,
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

/**
 * Melodrama. What "cheesy" is, when you have to catch it mechanically.
 *
 * "The headlines and title of the document is still very cheesy", on
 * AAA_CISO_Brief_4.pdf, whose cover said "When a matter leaks, the proceeding
 * fails." Nothing here caught it, and nothing was going to: it is not jargon,
 * not a label, and not cryptic. It is a film trailer.
 *
 * These are the shapes melodrama actually takes. Each one is a sentence
 * pattern rather than a word, because the words are always different and the
 * shape never is.
 */
const PORTENTOUS = [
  {
    re: /^\s*when\s+[^,.!?]{4,60},\s*[^.!?]{4,60}[.!]?\s*$/i,
    say: 'the "when X happens, Y fails" shape, which is a film trailer rather than a headline',
  },
  {
    re: /\bin the (?:age|era|world|dawn) of\b/i,
    say: '"in the age of …", which dates the document and says nothing',
  },
  { re: /\bis the new\b/i, say: 'the "X is the new Y" formula' },
  {
    re: /\b(?:the|your|every|each)\s+\w+(?:\s+\w+)?\s+(?:fails|collapses|dies|crumbles|is over|ends)\b/i,
    say: 'a doom clause, which a reader discounts on sight',
  },
  { re: /\bmake no mistake\b|\bthe stakes (?:are|have never)\b/i, say: 'a raised voice' },
  { re: /\bnot a matter of if,? but when\b/i, say: '"not if but when", which every vendor has already said to them' },
];

/**
 * "A conflict wall enforced by policy is not a conflict wall."
 *
 * The tautology worn as profundity: a phrase, then the same phrase negated.
 * It reads as a thought and contains none, and it was the closing line of a
 * brief to a CISO.
 *
 * Done as a function rather than a backreference, because the repeated part is
 * the START of the left side and the WHOLE of the right, and a regex that
 * expresses that is a regex nobody can change later.
 */
function tautology(text) {
  const m = /^(.*?)\bis not\b(.*)$/i.exec(String(text).trim());
  if (!m) return false;

  const words = (part) => part.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  const left = words(m[1]).join(' ');
  const right = words(m[2]).join(' ');

  return right.length >= 6 && left.includes(right);
}

/**
 * An identifier is data. A company selling context does not open on data.
 *
 * The sharpest note anyone has given this project: "opening the email like
 * that is totally out of context for a company selling context."
 *
 * The email opened "CISA added CVE-2026-85706 in GitLab CE/EE to its
 * known-exploited vulnerabilities catalog on September 11." Every word true,
 * and the whole sentence is a record from a catalogue. The pitch two
 * paragraphs later is that a CVE number tells you nothing until you know what
 * it can reach — so the opening refutes the argument before the reader gets
 * to it.
 *
 * The fix is the order, not the content. Say what it means for them, then name
 * the thing. "Your GitLab is on CISA's exploited list as of last Friday" is
 * the same fact with the reader in it.
 */
const BARE_IDENTIFIER =
  /\b(?:CVE|CWE|CAPEC|GHSA)[- ]?\d{4}[- ]?\d+\b|\b(?:ISO|IEC|SP|NIST SP)\s?\d{3,5}(?:[-:]\d+)?\b/i;

const MENTIONS_READER = /\byou(?:r|rs|'re|'ve)?\b/i;

/**
 * Long words that have a short one, with the short one attached.
 *
 * "Simple English. No fancy words." Naming the fault without naming the fix
 * makes somebody go and think of a synonym, which is the cost this exists to
 * avoid — so every entry carries its replacement.
 *
 * Separate from MODEL_TELLS, which is about sounding like a chatbot. This is
 * about a reader having to reread a sentence. "Resequencing the same security
 * budget" went to a CISO; "reordering" is the same word with the Latin taken
 * out.
 */
const FANCY_WORDS = [
  ['resequencing', 'reordering'], ['resequence', 'reorder'],
  ['commensurate', 'matching'], ['ascertain', 'find out'],
  ['commence', 'start'], ['terminate', 'end'], ['necessitate', 'need'],
  ['facilitate', 'help'], ['endeavour', 'try'], ['endeavor', 'try'],
  ['instantiate', 'create'], ['operationalize', 'put to work'],
  ['operationalise', 'put to work'], ['aforementioned', 'that'],
  ['subsequent to', 'after'], ['prior to', 'before'], ['in order to', 'to'],
  ['at this juncture', 'now'], ['with regard to', 'about'],
  ['in the event that', 'if'], ['a multitude of', 'many'],
  ['in close proximity to', 'near'], ['at the present time', 'now'],
  ['for the purpose of', 'to'], ['in spite of the fact that', 'although'],
  ['utilization', 'use'], ['methodology', 'method'], ['functionality', 'what it does'],
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
export const ARTICULATION_BLOCK = `## Five rules, on everything you write

These come from the person whose name goes on it, and they apply to every
document, deck, email and post — not only the ones that mention them.

1. **Simple English. No fancy words.** If a shorter, plainer word exists, it is
   the right word. Reordering, not resequencing. Use, not utilise. Start, not
   commence. About, not with regard to. A CISO reads fast and is not impressed
   by vocabulary; they are impressed by not having to reread a sentence.
2. **Professional and to the point.** Say the thing. Then stop. No throat
   clearing, no scene setting, no paragraph explaining what the next paragraph
   will cover. If a sentence survives deletion without the meaning changing,
   delete it.
3. **The hook cannot be cryptic.** A headline earns the click by being
   interesting AND clear. "When a matter leaks, the proceeding fails" is a film
   trailer. "Beyond detection" is a gesture. Say what you actually mean, in a
   sentence a stranger understands with no context: who, what, and why it costs
   them something.
4. **Dry wit is welcome. Jokes are not.** One wry line that lands the point is
   worth three earnest ones. The register is a smart colleague being honest,
   not a comedian and not a preacher. Never a pun, never a joke at the
   reader's expense, never humour about their incident or their industry's
   misfortune, and never more than one per document. If you cannot make it
   funny AND useful, make it useful.
5. **Nobody may think a machine wrote this.** That is the whole test. A rep
   sends it under their own name to someone who reads twenty of these a week.

## How to open

Name the fact. Stop. Do not say what it proves.

A real email to a real CISO opened: "The AI security hires you're making right
now, engineers working in Go, Rust, and Python on agent security, show you're
thinking carefully about what Model Context Protocol in production actually
means for your attack surface." Thirty-eight words, two nested clauses before
the verb, all of them spent awarding the reader a compliment inferred from a
job advert. Nobody writes like that.

A person writes: "You're hiring Go, Rust and Python engineers for agent
security. So MCP in production is already on your plate." Two short sentences,
same information, no mind-reading.

So, in the first line:

- **The fact, in their words, and nothing after it.** They already know what
  their own hiring means. Being told is the single most reliable sign a machine
  wrote this.
- **Never "your X shows you're…", "the fact that you…", "you're clearly…",
  "I've been following…", "your commitment to…", "impressive".** Each one is a
  stranger reading a mind from a public page.
- **Short.** Open under twenty-five words, then earn the longer sentence. A
  first sentence with clauses nested inside it is a machine warming up.
- Then go straight to what changed and why it costs them something.

## Writing to someone who has never heard of us

Assume they have not. On cold outreach they have not seen the website, do not
know the product, and did not ask. Two things follow.

**Say who is writing, in the first two or three sentences.** One plain
sentence: what we do, in their language. Not paragraph four, after three
paragraphs of analysis they have been reading while wondering who this is.
An email has no cover with a logo on it — the words are the whole introduction.

**Open on what it means for them, then name the thing.** We sell context. An
email that opens on a bare CVE number, a standard, or a statistic is a
catalogue entry, and it refutes the argument two paragraphs before the argument
arrives. "CISA added CVE-2026-85706 in GitLab CE/EE to its known-exploited
vulnerabilities catalog on September 11" is a record. "Your GitLab is on CISA's
exploited list as of Friday" is the same fact with the reader in it — and the
number still goes in, right after, for whoever wants to look it up.

The order is the whole trick: consequence, then evidence. A company whose
product says a severity score means nothing without context cannot open its own
email on a severity score.

**Never melodramatic.** No doom ("when X happens, Y fails", "the end of Z"). No
"in the age of…". No "X is not really X" tautologies that sound profound and
say nothing. No three tidy parallel clauses in a row. State what is true, in
the order a person would say it out loud.

## How it has to read

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
   launch, the posting, the thing the executive said in public. Name it and
   STOP — do not say what it shows about them. Specific, or leave it out. A
   compliment that would fit any company is worse than none, and an inferred
   one is worse than that.
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
    does: 'Name the work they have actually done — the programme, the launch, the posting — and stop there. Named and specific, or leave it out.',
    fails: 'A compliment that would fit any company, or any sentence telling them what their own work shows about them. "Acknowledge" is what licensed an email to open on what a job advert proved about the reader.',
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

// Disclosures that mean a customer will read this. Imported rather than
// declared twice: execOutreach.js reached the same conclusion about a draft
// separately, and two copies of a rule is one copy waiting to disagree.

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
export function checkArticulation(text, { opening = null } = {}) {
  const copy = String(text || '');
  const notes = [];
  if (!copy.trim()) return { notes };

  // What counts as "the opening", which the caller sometimes knows better.
  //
  // A subject line has no full stop, so a sentence splitter runs straight
  // through it into the body and calls the two of them one sentence. Caught by
  // this rule firing on a draft that opened in 22 words and was reported as 31
  // — the missing nine being the subject.
  //
  // A newline ends a sentence: subjects, headlines and bullets all end that
  // way and nothing else does. And a caller holding the body separately hands
  // it over rather than letting this guess.
  const first = String(opening ?? copy);
  const firstSentence = first.trim().split(/\n|(?<=[.!?])\s/)[0] || '';

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

  for (const shape of MIND_READING) {
    if (shape.re.test(copy)) {
      notes.push(
        `Reads as generated: ${shape.say}. Say the fact and stop — "you are hiring Go and Rust ` +
          'engineers for agent security" — and let them draw their own conclusion. They already know ' +
          'what their own decisions mean.',
      );
      break;
    }
  }

  if (KNOWS_THEIR_STACK.some((re) => re.test(copy))) {
    notes.push(
      'An absolute about their own stack, which you have never seen. Their first thought is "you do ' +
        'not know what is in my estate", and they are right. Ask it instead: "does anything you run ' +
        'answer that today?" invites a reply where the statement dares one.',
    );
  }

  // An identifier before the reader.
  if (BARE_IDENTIFIER.test(firstSentence) && !MENTIONS_READER.test(firstSentence)) {
    notes.push(
      'The first sentence is a catalogue entry: an identifier, and the reader is not in it. This ' +
        'company sells context, and opening on a bare CVE or standard number refutes the argument ' +
        'before the reader reaches it. Same fact, reader first: "your GitLab is on CISA\'s exploited ' +
        'list as of Friday" — then the number, for whoever wants to look it up.',
    );
  }

  // The FIRST sentence, on its own.
  //
  // Separate from the mean below, which a long opener barely moves. The
  // opening sentence is the one a reader uses to decide whether a person or a
  // machine wrote this, and the tell is length: the Zscaler email spent 38
  // words and two nested clauses before its verb arrived. A person opens
  // short, then earns the longer sentence.
  const openingWords = firstSentence.split(/\s+/).filter(Boolean).length;
  if (openingWords > 25) {
    notes.push(
      `The opening sentence is ${openingWords} words. It is the one a reader uses to decide whether a ` +
        'person wrote this. Open short and plain, then earn the longer sentence.',
    );
  }

  // Melodrama, line by line. A headline is a line and so is a closing quote,
  // and the whole-document scan would report the same shape once wherever it
  // appeared — which loses WHICH line to rewrite.
  //
  // ONE note per line, and one note per shape across the document. A cover
  // line that is both a conditional catastrophe and a doom clause is still one
  // sentence to rewrite, and a report that says so twice is a report a rep
  // starts skimming.
  const seen = new Set();
  for (const line of copy.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const shape = PORTENTOUS.find((p) => p.re.test(line) && !seen.has(p.say));
    if (shape) {
      seen.add(shape.say);
      notes.push(`"${line.slice(0, 60)}" uses ${shape.say}. Say what is true, plainly.`);
      continue;
    }
    if (tautology(line) && !seen.has('tautology')) {
      seen.add('tautology');
      notes.push(
        `"${line.slice(0, 60)}" is a phrase and then the same phrase negated. It reads as a thought and contains none.`,
      );
    }
  }

  const fancy = FANCY_WORDS.filter(([word]) => new RegExp(`\\b${word}\\b`, 'i').test(copy));
  if (fancy.length) {
    notes.push(
      `Plainer words exist: ${fancy.slice(0, 5).map(([w, plain]) => `${w} → ${plain}`).join(', ')}.`,
    );
  }

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
