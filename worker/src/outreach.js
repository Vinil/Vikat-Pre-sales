/**
 * outreach.js — the drafts a rep sends, as something they can copy.
 *
 * An email written into the answer text is technically an email, and it is
 * also four paragraphs a rep has to select around markdown, a subject line
 * they have to spot in a sentence, and a signature they have to delete. The
 * draft is a THING, so it travels as one: subject and body as separate fields,
 * rendered as a card with its own copy buttons.
 *
 * Email, LinkedIn and Teams share this rather than getting a tool each. They
 * are the same act — a short piece of writing aimed at one person, built from
 * a real trigger — and the differences are length and whether there is a
 * subject line. Two tools would have been two schemas to keep in step, and the schema
 * budget is not free: "Schema is too complex" is a REQUEST-level 400 that once
 * killed every conversation, including ones that never touched a tool.
 */

import { noDashes } from './brand.js';
import { checkArticulation } from './articulation.js';

/** What a draft can be written for. Each has a real limit, not a style note. */
export const CHANNELS = {
  email: {
    label: 'Email',
    subject: true,
    // Not a hard cap from any platform. A cold email past ~200 words is
    // skimmed and deleted, and the model will happily write 500 if nothing
    // says otherwise.
    bodyChars: 2200,
    subjectChars: 160,
    // Carries a To line: the card opens Outlook addressed to the person. See
    // readRecipient() for what an address has to prove before it is kept.
    to: true,
  },
  linkedin_note: {
    label: 'LinkedIn connection note',
    subject: false,
    // LinkedIn's own limit on a connection request. A draft over it cannot be
    // sent at all, so this one is enforced rather than advised.
    bodyChars: 300,
    hard: true,
  },
  linkedin_message: {
    // What the reps here call it. The key stays linkedin_message because it is
    // written into every logged turn already; renaming it would orphan them.
    label: 'LinkedIn InMail',
    subject: true,
    subjectChars: 160,
    // ADVISORY, not LinkedIn's. Nobody has given a sourced InMail ceiling, and
    // inventing one and enforcing it hard would be worse than a soft trim: a
    // draft would be cut at a number no platform actually applies. When the
    // real figure arrives, move this up beside the 300-character connection
    // note and set `hard`.
    bodyChars: 1800,
  },
  linkedin_post: {
    label: 'LinkedIn post',
    subject: false,
    // LinkedIn truncates a post at 3000 characters.
    bodyChars: 3000,
    hard: true,
    // A post is not one block of text. It is a headline that has to survive
    // the "see more" fold on its own, a body, a set of hashtags, and a banner
    // — four things a rep copies into four different places, so they travel as
    // four fields rather than as one string the rep has to cut up.
    headline: true,
    hashtags: true,
    image: true,
  },
  teams_message: {
    // A chat to someone the rep already works with, or who is on Teams: a
    // partner, a customer on a shared channel, a colleague being asked for an
    // intro. No subject, because nobody reads one on a chat.
    label: 'Teams message',
    subject: false,
    // ADVISORY, not Teams'. Teams' own ceiling on a chat message is far higher
    // than this — "Limits and specifications for Microsoft Teams" gives chat
    // size as approximately 100 KB per post — so enforcing 2000 hard would
    // cut a message at a number no platform applies, the mistake the InMail
    // ceiling above is careful not to make.
    // This is about what still reads as a chat: past a screenful it is an
    // email in the wrong window. It also happens to be about where the card's
    // "Open in Teams" link stops fitting in a URL.
    bodyChars: 2000,
    // The card opens a chat with this person, the text already in the box.
    to: true,
  },
};

/**
 * A headline long enough to be cut off by LinkedIn's own fold.
 *
 * ADVISORY, and deliberately not enforced. The fold moves with the device and
 * the viewport — it is nearer 140 characters on a phone than on a desktop feed
 * — so trimming at any single number would cut a headline at a figure no
 * platform actually applies. Nobody here has a sourced figure, and the same
 * rule applies as to the InMail ceiling above: say it is advisory rather than
 * inventing a limit. The card marks the fold instead and lets the rep judge.
 */
export const FOLD_CHARS = 140;

/** Sanity ceiling on a headline. Not LinkedIn's; a headline is one line. */
const HEADLINE_CHARS = 220;

/** More than a handful reads as spam and LinkedIn's own guidance says so. */
const MAX_HASHTAGS = 5;
const IMAGE_BRIEF_CHARS = 600;

/**
 * `#Word #Another` out of whatever the model wrote.
 *
 * It writes them as "#A, #B", as "A B", and as a sentence about hashtags. All
 * three become the same thing here rather than being rejected: a rep copying
 * a tag list wants tags, and the punctuation between them is not information.
 */
function cleanHashtags(value) {
  return String(value == null ? '' : value)
    .replace(TOOL_MARKUP, ' ')
    .split(/[\s,]+/)
    .map((t) => t.replace(/^#+/, '').replace(/[^A-Za-z0-9]/g, ''))
    .filter(Boolean)
    .slice(0, MAX_HASHTAGS)
    .map((t) => '#' + t);
}

export const CHANNEL_NAMES = Object.keys(CHANNELS);

const LABEL_CHARS = 80;

/**
 * Tool-call serialisation that reached an argument instead of framing it.
 *
 * A draft came back with its label reading `</parameter> <parameter
 * name="group">versions` — the markup that separates one argument from the
 * next, ending up INSIDE one. It rendered on the card exactly as written,
 * because nothing between the model and the DOM looked at it.
 *
 * No email, subject or label contains an angle-bracketed token with any of
 * these words in it. If one does, it is not content.
 */
const TOOL_MARKUP = /<\/?[^<>]*\b(?:antml|parameter|invoke|function_calls)\b[^<>]*>/gi;

/**
 * `.test()` on a /g regex is STATEFUL — it resumes from lastIndex — so three
 * calls in a row against three different strings give three answers that
 * depend on the order they were asked in. Reset before each one.
 */
const looksMalformed = (value) => {
  TOOL_MARKUP.lastIndex = 0;
  return TOOL_MARKUP.test(String(value == null ? '' : value));
};

/**
 * One plain address, and nothing a mail client could read as a second one.
 *
 * No display name, no list, no separator: "Priya <p@x.com>", "a@x.com, b@x.com"
 * and "a@x.com;b@x.com" are each something Outlook parses into more people
 * than the rep looked at. A To line is not the place to be generous about
 * format, because the cost of a wrong one is an email in a stranger's inbox.
 */
const PLAIN_ADDRESS = /^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$/;

/**
 * Address-shaped runs in running text.
 *
 * Narrower than PLAIN_ADDRESS on purpose, because this reads prose rather
 * than a field: brackets, quotes and colons end an address in a sentence
 * ("(p@x.com)", "mailto:p@x.com"), and so do the ?, & and / of a URL that
 * carries one as a parameter. The trailing full stop of the sentence is
 * trimmed afterwards rather than excluded here, because a dot inside the
 * domain is part of the address and one at the end is not.
 */
const ADDRESS_IN_TEXT = /[^\s@<>,;:()[\]{}"'`?&=/#]+@[^\s@<>,;:()[\]{}"'`?&=/#]+/g;

/**
 * Every address written in some text, lower-cased.
 *
 * What the To line is checked against. An address is kept on a draft only if
 * it is one of these — see readRecipient().
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function addressesIn(text) {
  const found = new Set();
  for (const run of String(text == null ? '' : text).match(ADDRESS_IN_TEXT) || []) {
    const address = run.replace(/[.!?]+$/, '').toLowerCase();
    if (PLAIN_ADDRESS.test(address)) found.add(address);
  }
  return found;
}

/**
 * The To line, if it has earned its place on the card.
 *
 * Every other field on a draft is read before it is sent. The address is
 * glanced at. And the likeliest wrong address is not a malformed one — it is
 * firstname.lastname at the company's domain, assembled from a name and a
 * website, which looks exactly like knowledge and is a guess. So a format
 * check proves nothing on its own. What proves the model did not make it up
 * is that the address was already WRITTEN somewhere it was given: the rep's
 * messages, or an account block the embedding page put into the prompt. Not
 * the assistant's own earlier replies — see givenText() in tools.js.
 *
 * Literal, not fuzzy. jane@example.com is a different mailbox from
 * jane@example.com.au, and a model trimming one into the other is exactly the
 * near-miss that sends a prospect's email to someone else.
 *
 * @returns {{ to?: string, warning?: string }}
 */
function readRecipient(value, knownEmails) {
  // Not clean(): that rewrites dashes for prose, and an address is not prose.
  // Markup is still stripped, so a To line that came back as tool framing is
  // reported as not-an-address rather than quoted back as markup.
  const raw = String(value == null ? '' : value)
    .replace(TOOL_MARKUP, ' ')
    .trim()
    .replace(/^mailto:/i, '')
    .slice(0, 320);
  if (!raw) return {};

  // Neither warning quotes the address. A warning is relayed to the rep in
  // the assistant's reply, so quoting it puts the guess on screen for the rep
  // to copy into Outlook by hand — the one thing dropping it was for. And the
  // reply is resent as history next turn: while replies counted as given
  // text, the quoted guess came back as an address the conversation had
  // "given", and the second draft carried it with no warning at all.
  const to = raw.toLowerCase();
  if (!PLAIN_ADDRESS.test(to)) {
    return {
      warning: 'The To line on this draft is not one plain e-mail address, so it was left off. Check who this goes to.',
    };
  }

  const known = new Set([...(knownEmails || [])].map((a) => String(a).toLowerCase()));
  if (!known.has(to)) {
    return { warning: 'The address on this draft is not one you gave, so it was left off. Check who this goes to.' };
  }

  return { to };
}

function clean(value, max) {
  return (
    noDashes(String(value == null ? '' : value).replace(TOOL_MARKUP, ' '))
      .replace(/\r\n/g, '\n')
      // The strip can leave a double space where the markup was.
      .replace(/[^\S\n]{2,}/g, ' ')
      .trim()
      .slice(0, max)
  );
}

/**
 * Normalise a model-authored draft, and say what had to be changed.
 *
 * Model-authored content is normalised rather than trusted, the same way
 * document specs are: the alternative is a rep pasting a 400-character
 * connection note into LinkedIn and finding out there that it will not send.
 *
 * @param {object} input  The tool call's arguments.
 * @param {{ forbidden?: string[], knownEmails?: Iterable<string> }} [options]
 *        `knownEmails` is every address the rep or the account block gave
 *        (see addressesIn). Absent means none: a caller that forgets
 *        to pass the conversation gets no To line, never an unchecked one.
 * @returns {{ ok: true, draft: object, warnings: string[] } | { ok: false, error: string }}
 */
export function normaliseDraft(input = {}, { forbidden = [], knownEmails = [] } = {}) {
  const channel = CHANNELS[input.channel] ? input.channel : 'email';
  const spec = CHANNELS[channel];
  const warnings = [];

  const body = clean(input.body, spec.bodyChars);
  if (!body) return { ok: false, error: 'A draft with no body is not a draft.' };

  const rawBody = clean(input.body, spec.bodyChars * 4);
  if (rawBody.length > body.length) {
    warnings.push(
      spec.hard
        ? `Trimmed to ${spec.bodyChars} characters — ${spec.label} will not accept more than that.`
        : `Trimmed to ${spec.bodyChars} characters.`,
    );
  }

  // A label that came back as markup is not a label. Blanking it falls through
  // to the channel name, which is uninformative and TRUE — better than a tab
  // reading `</parameter> <parameter name="group">`.
  const rawLabel = looksMalformed(input.label) ? '' : input.label;

  if (looksMalformed(input.label) || looksMalformed(input.subject) || looksMalformed(input.body)) {
    warnings.push(
      'This draft came back with tool markup inside it, which has been stripped. Read it before you send it.',
    );
  }

  const draft = {
    channel,
    channelLabel: spec.label,
    body,
    label: clean(rawLabel, LABEL_CHARS) || spec.label,
    // "versions" is the safe default: it frames the card as a choice, and a
    // rep who reads three alternatives as three posts has written less than
    // they meant to, whereas one who reads a campaign as a choice sends less.
    // The second mistake is recoverable in the next turn; the first is not.
    group: input.group === 'sequence' ? 'sequence' : 'versions',
  };

  // Only where a link can use it. LinkedIn has no URL that pre-fills a message
  // to a person, so an address on a LinkedIn draft would be carried for
  // nothing — and checked, and warned about, for nothing.
  if (spec.to) {
    const recipient = readRecipient(input.to, knownEmails);
    if (recipient.to) draft.to = recipient.to;
    if (recipient.warning) warnings.push(recipient.warning);
  }

  if (spec.subject) {
    const subject = clean(input.subject, spec.subjectChars);
    // Not fatal. A rep can write their own subject line in two seconds; losing
    // the body over a missing one would be the worse trade.
    if (!subject) warnings.push('No subject line was written for this one.');
    else draft.subject = subject;
  }

  if (spec.headline) {
    const headline = clean(input.headline, HEADLINE_CHARS);
    if (!headline) warnings.push('No headline was written, so the post opens on its body.');
    else draft.headline = headline;
  }

  if (spec.hashtags) {
    const tags = cleanHashtags(input.hashtags);
    if (tags.length) draft.hashtags = tags;
  }

  if (spec.image) {
    const brief = clean(input.imageBrief, IMAGE_BRIEF_CHARS);
    if (brief) draft.imageBrief = brief;
  }

  // The 3000 is LinkedIn's own and it covers the WHOLE post, not the body
  // alone. Checking the body in isolation passes a post that a headline and
  // five hashtags push over the edge, and the rep finds out in the composer
  // with the text already pasted.
  if (spec.hard && spec.headline) {
    const whole = postText(draft);
    if (whole.length > spec.bodyChars) {
      warnings.push(
        `Headline, body and hashtags come to ${whole.length} characters together, over ${spec.label}'s ${spec.bodyChars}. Something has to come out before this posts.`,
      );
    }
  }

  // How it SOUNDS, on the draft as the recipient will read it.
  //
  // "Every time a content request goes out" covers an email and a post as much
  // as a two-pager, and an email is the one a rep sends soonest and edits
  // least. checkArticulation was wired to nothing when this was added — the
  // module that answers "would a reader think a machine wrote this" had never
  // run on anything.
  //
  // Subject and headline included, not just the body: the first line is the
  // one guaranteed to be read, and it is where melodrama lives.
  const whole = [draft.subject, postText(draft)].filter(Boolean).join('\n');
  // The BODY is the opening, not the subject stapled to it. See
  // checkArticulation: a subject line has no full stop, so a splitter runs
  // through it into the first sentence and reports the two as one.
  for (const n of checkArticulation(whole, { opening: draft.body }).notes) warnings.push(n);

  // WHERE we say who we are, which in a cold email is not paragraph four.
  //
  // The prospect has never heard of Vikat. The email to Zscaler ran three
  // paragraphs of security analysis — a CVE, a hiring signal, a claim about
  // what their SIEM cannot do — before the sender was named at all. A stranger
  // reading that is asking "who is this and why is it in my inbox" the whole
  // way down, and nothing answers until they have already decided.
  //
  // A document does not have this problem: the logo is on the cover and the
  // question is answered before a word is read. An email has no cover, which
  // is why this lives here and not in checkArticulation.
  const sentences = whole.split(/(?<=[.!?])\s+/).filter((x) => x.trim());
  const introducedAt = sentences.findIndex((x) => /\bVikat(?:\.AI)?\b/i.test(x));

  if (introducedAt === -1) {
    warnings.push(
      'Nothing here says who is writing. The reader has never heard of Vikat: one plain sentence, ' +
        'early, saying what we do — before the analysis, not after it.',
    );
  } else if (introducedAt > 2) {
    warnings.push(
      `Vikat is not named until sentence ${introducedAt + 1}. The reader has never heard of us and ` +
        'spends everything before that wondering who is writing. Say it in the first two or three ' +
        'sentences, plainly, then make the argument.',
    );
  }

  // A customer we may not name, in the thing a rep sends soonest and edits
  // least. See execOutreach.js: the real names are already in the assistant's
  // context from the knowledge base, so the instruction not to use them is
  // competing with a fact it can see. This does not depend on it cooperating.
  //
  // First in the list, because it is the only warning here that is about
  // somebody else's confidence rather than about our own writing.
  const leaked = forbidden.filter((name) =>
    new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(whole),
  );
  if (leaked.length) {
    warnings.unshift(
      `${leaked.join(' and ')} may not be named to a customer. The approved references describe them ` +
        'instead, and the description is the whole permission: use it word for word and take the name out.',
    );
  }

  return { ok: true, draft, warnings };
}

/**
 * A post as one block, in the order it is published in.
 *
 * The rep pastes ONE thing into LinkedIn's composer, so the parts exist for
 * copying and editing separately but have to be able to come back together in
 * the published order — and the character count that matters is this string's,
 * not the body's. Shared with the widget's "Copy whole post" so what is
 * counted and what is copied can never disagree.
 */
export function postText(draft = {}) {
  return [draft.headline, draft.body, (draft.hashtags || []).join(' ')]
    .filter(Boolean)
    .join('\n\n');
}
