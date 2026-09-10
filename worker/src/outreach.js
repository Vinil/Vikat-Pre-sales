/**
 * outreach.js — the drafts a rep sends, as something they can copy.
 *
 * An email written into the answer text is technically an email, and it is
 * also four paragraphs a rep has to select around markdown, a subject line
 * they have to spot in a sentence, and a signature they have to delete. The
 * draft is a THING, so it travels as one: subject and body as separate fields,
 * rendered as a card with its own copy buttons.
 *
 * Email and LinkedIn share this rather than getting a tool each. They are the
 * same act — a short piece of writing aimed at one person, built from a real
 * trigger — and the differences are length and whether there is a subject
 * line. Two tools would have been two schemas to keep in step, and the schema
 * budget is not free: "Schema is too complex" is a REQUEST-level 400 that once
 * killed every conversation, including ones that never touched a tool.
 */

import { noDashes } from './brand.js';

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
  },
};

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

const looksMalformed = (value) => TOOL_MARKUP.test(String(value == null ? '' : value));

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
 * @returns {{ ok: true, draft: object, warnings: string[] } | { ok: false, error: string }}
 */
export function normaliseDraft(input = {}) {
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

  if (spec.subject) {
    const subject = clean(input.subject, spec.subjectChars);
    // Not fatal. A rep can write their own subject line in two seconds; losing
    // the body over a missing one would be the worse trade.
    if (!subject) warnings.push('No subject line was written for this one.');
    else draft.subject = subject;
  }

  return { ok: true, draft, warnings };
}
