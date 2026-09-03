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
    label: 'LinkedIn message',
    subject: true,
    subjectChars: 160,
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

function clean(value, max) {
  return String(value == null ? '' : value)
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, max);
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

  const draft = {
    channel,
    channelLabel: spec.label,
    body,
    label: clean(input.label, LABEL_CHARS) || spec.label,
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
