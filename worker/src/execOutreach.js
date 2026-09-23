/**
 * execOutreach.js — the standing rules for executive outreach, as checks.
 *
 * SOURCE: the review of Mclane_CISO_reach_out.pdf, 2026-09-16, and the team
 * checklist it ends with. Every rule below is one somebody had to catch by
 * reading a finished PDF, which is the expensive way to catch any of them.
 *
 * The division of labour matters, so it is stated once here:
 *
 *   guidelines.js  what the brand looks like        (colour, type, layout)
 *   articulation.js  how a sentence has to read     (register, story arc)
 *   execOutreach.js  what a piece of outreach must  (sources, stamps, CTA,
 *                    CONTAIN and must never SAY      sender, retired phrases)
 *
 * The distinction is not academic. articulation.js judges prose and returns
 * notes a writer weighs. Most of what follows is not a judgement: a retired
 * phrase is retired, an internal clearance stamp is internal, an anchor figure
 * without a source reads as invented. Those are problems, and a document
 * carrying one is not ready whatever else is right about it.
 *
 * Nothing here rewrites. Every renderer is downstream of a human who presses
 * send, and a rule that silently edits a rep's document teaches them to stop
 * reading it.
 */

/**
 * What the model is told, so that most of the checks below never fire.
 *
 * A checker that catches a fault after the PDF is built costs a rebuild; the
 * prompt costs nothing. The two are kept in one file deliberately, because the
 * failure mode of splitting them is a rule that is enforced and never taught,
 * or taught and never enforced.
 */
export const EXEC_OUTREACH_BLOCK = `## Outreach to an executive

These are standing rules, not preferences. A document breaking one is not
ready, however good the rest of it is.

- Research the recipient before writing. Use web search on their name, their
  company and their recent announcements, and take their exact current title
  and the vocabulary they use publicly. A wrong title on a first approach is
  not recoverable. If search returns nothing usable, say so to the rep rather
  than writing around the gap.
- Lead with the thing only Vikat can say. Never open on facts the reader
  already owns: they know their own revenue, site count and org chart. One
  line of their situation as a pivot, then spend the space on what they do
  not have.
- Open on what they have BUILT, not on what is wrong with it. Their newest
  initiative is the live, unsolved, personal problem; name the achievement
  first and the exposure second, in that order.
- Mirror their own vocabulary. If their title and public language say
  "resilience", use it once, deliberately, where it lands.
- Every figure carries its source in the same line. No exceptions. An
  unattributed number from an unknown vendor reads as invented.
- State, do not sell. Say a thing once. A claim repeated three times is a
  pitch, and the third time is the one the reader notices.
- Say the trust posture in its own labelled block, not buried in a paragraph:
  what it runs on, what stays private, who approves actions, what is audited.
- Give one trust anchor a stranger can check: a named integration they
  already run, a certification, or a customer in their vertical.
- Close with a dated ask, a named owner, and what they keep from it even if
  they never buy.
- Sign it with a full name, a title, and direct contact.
- Never include internal clearance or review language. "Cleared for
  customers" is for a rep, and the customer is not the rep.
- A two-pager is two pages. Cut content; never shrink type to fit.
`;

// --- Retired language -------------------------------------------------------

/**
 * Phrases withdrawn from customer-facing use, and what to say instead.
 *
 * A blacklist rather than a style note because retirement is a decision that
 * has already been made. "Semantic Loop" and "bonus at risk" both reached a
 * CISO's desk in one PDF; neither was a close call, and neither was caught by
 * any of the three checkers that ran over that document and passed it clean.
 *
 * `customerFacingOnly` marks language that is still correct internally. "Bonus
 * at risk" is a real commercial term and belongs in an internal deal review;
 * it is the customer-facing register it is retired from.
 */
export const RETIRED_PHRASES = [
  {
    pattern: /\bSemantic Loop\b/gi,
    say: 'the Loop',
    because:
      'Retired. The locked phrasing is "Forward Deployed Engineers run the Loop as managed support."',
    customerFacingOnly: true,
  },
  {
    pattern: /\bbonus at risk\b/gi,
    say: 'the measurable 90-day outcome, without the bonus language',
    because: 'Retired from customer-facing copy. Keep the commitment, drop the compensation mechanics.',
    customerFacingOnly: true,
  },
];

/**
 * Internal clearance and review language, which must never reach a customer.
 *
 * "CLEARED FOR CUSTOMERS" was stamped on all three pages of a document going
 * to a customer, which is the exact inversion of what the stamp is for: it
 * exists to warn a rep, and a cleared document has nothing to warn about. The
 * stamp announces an internal review process to the person it was cleared for.
 */
export const INTERNAL_STAMPS = [
  /\bcleared for customers?\b/i,
  /\binternal only\b/i,
  /\bnot for customer distribution\b/i,
  /\bneeds approval\b/i,
  /\bdraft:/i,
  /\bfor internal (?:review|use)\b/i,
];

// --- Figures ----------------------------------------------------------------

/**
 * A number big enough to carry an argument, which therefore has to carry a
 * source.
 *
 * Multipliers ("7.5x"), percentages, money, and any figure of four digits or
 * more. Deliberately not every number: "80 distribution centers" is a fact the
 * reader owns and "Week 3" is a label, and demanding a citation for those
 * produces a checker nobody listens to.
 */
const ANCHOR_FIGURE =
  /(\b\d+(?:\.\d+)?x\b|\b\d+(?:\.\d+)?\s?%|[$£€]\s?\d[\d,.]*\s?(?:million|billion|bn|m\b)?|\b\d{1,3}(?:,\d{3})+\b|\b\d{4,}\b)/gi;

/**
 * A bare year is a date, not a claim.
 *
 * The first run of this checker demanded a source for "2025" in "In August
 * 2025, McLane opened a technology hub in Austin". A checker that asks who
 * says it is 2025 is one a rep learns to scroll past, and the next thing they
 * scroll past is the 7.5x three lines down.
 */
const YEAR = /^(?:19|20)\d{2}$/;

/**
 * A number that is part of a standard's NAME, not a statistic.
 *
 * "ISO 27001" and "ISO 9001" were both demanded a source, in a document whose
 * only fault there was naming two certifications. Worse than noise: ISO 27001
 * is one of the TRUST_ANCHORS this same module asks outreach to include, so
 * the checker was requiring a thing and then objecting to it.
 *
 * Matched on what precedes the number, because that is what makes it a name.
 */
const STANDARD_BEFORE = /\b(ISO|IEC|IEEE|NIST|SP|SOC|PCI|DSS|FIPS|CMMC|HIPAA|GDPR|RFC|CVE|CWE|SSAE)\s*$/i;

/**
 * What counts as a source sitting WITH the figure.
 *
 * Attribution has to be inline, in the same breath, because the reader's
 * question is "says who" at the moment they read the number. A sources section
 * at the end of a two-pager is a footnote nobody walks to.
 */
const SOURCE_NEARBY =
  /\b(source|per|according to|reported by|disclosed|filing|SEC|10-K|ISAC|McKinsey|Gartner|Forrester|IDC|IBM|Verizon|Ponemon|survey|study|report)\b/i;

/**
 * A named body and a date, which is what attribution looks like when the
 * source is not on the list above.
 *
 * The list is a list of vendors, and a list of vendors is never finished. It
 * had Gartner and not Anthropic, Palo Alto or HBR — so on a brief to the CISO
 * of the American Arbitration Association it passed "Gartner, 2025" and
 * flagged "Anthropic GTG-1002, November 2025" and "Palo Alto and HBR, 2026" as
 * figures nobody had sourced. Three of the four tiles, all of them cited.
 *
 * A checker that is wrong about a correctly sourced number is worse than no
 * checker: the report gets skipped, and the unsourced one in it goes with it.
 *
 * So: a capitalised name followed by a year, optionally through a month. That
 * is general, it is what a citation IS, and it does not need maintaining.
 */
const MONTH = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?$/i;
const NOT_A_NAME = /^(in|on|by|the|a|an|at|since|between|from|until|before|after|during|this|last|next)$/i;

function cited(line) {
  for (const m of String(line).matchAll(/((?:[A-Z][\w&.'-]*[\s,]*(?:and\s+|&\s+)?){1,5})(?:19|20)\d{2}\b/g)) {
    const names = m[1]
      .split(/[\s,]+/)
      .filter(Boolean)
      .filter((w) => /^[A-Z]/.test(w));

    // At least one word that is a NAME rather than a date or a preposition.
    // "In August 2025, McLane opened a hub" is a sentence about a month; it is
    // not somebody vouching for a number.
    //
    // And not a word still holding its hyphen: in "CVE-2024-3400" the 2024 is
    // half an identifier, and reading it as a citation would let the rest of
    // that line's figures through unsourced.
    if (names.some((w) => !MONTH.test(w) && !NOT_A_NAME.test(w) && !w.endsWith('-'))) return true;
  }
  return false;
}

/**
 * A number welded to a word by a hyphen is part of a NAME.
 *
 * GTG-1002 is Anthropic's label for a campaign; ATT&CK, CVE-2024-3400 and
 * SP-800-53 are the same shape. "1002 carries an argument and no source" is
 * the checker reading an identifier as a statistic, and it fired on the one
 * tile that named its source most precisely.
 */
const IDENTIFIER_BEFORE = /[\w&]-$/;

/**
 * Things you can hold a certificate for, and things you cannot.
 *
 * A brief to the CISO of the American Arbitration Association carried the line
 * "Certifications: SOC 2 Type 2, ISO 27001, HIPAA, GDPR, ISO 9001". Two of
 * those are not certifications. HIPAA and GDPR are regulations — there is no
 * body that certifies anyone against either, and a CISO knows that before they
 * finish the line. It reads as a company that does not know the difference,
 * which costs more than the list earns.
 *
 * It is also traceable. The knowledge base says "SOC 2 / GDPR / HIPAA evidence
 * generation", "aligned to", and "compliance controls" — never that Vikat is
 * certified in them. The claim was assembled here, from source material that
 * says something narrower and true.
 *
 * Only the WORD is checked, not the list. Which certifications Vikat actually
 * holds is not something this file can know, and guessing would be the same
 * mistake in the other direction.
 */
const NOT_A_CERTIFICATION =
  /\b(HIPAA|GDPR|CCPA|SOX|DORA|NIS ?2|EU AI Act|NIST(?:\s+AI\s+RMF)?|MITRE ATLAS)\b/gi;

/** A line claiming we hold something, rather than work to it. */
const CERTIFICATION_CLAIM = /\b(certificat\w+|certified|accredited)\b/i;

/**
 * Who we say we are, which has been a different sentence every time.
 *
 *   "Vikat is the Agent Semantics Company."   (AAA_CISO_Brief_4.pdf)
 *   "Vikat is a security solutions company."  (the Zscaler email)
 *
 * Neither appears anywhere in this repository, and the second was sent to a
 * company that IS a security solutions company. The model is not inventing out
 * of mischief: the prompt gives it a TAGLINE, and a tagline is not a predicate
 * you can drop into a paragraph, so it writes one and writes a different one
 * next time.
 *
 * Three real lines exist and they disagree — guidelines.js records the
 * conflict and says "a deck can only open on one". Picking the winner is a
 * brand decision and not this file's to make. What this file can do is refuse
 * a FOURTH invented on the spot, and put the real three in front of whoever
 * reads the report.
 */
const SELF_DESCRIPTION =
  /\bVikat(?:\.AI)?\s+(?:is|builds|provides|offers|makes|delivers)\s+(?:a|an|the)\s+([^.,;:]{3,70})/i;

/** Wording the repository actually sanctions, in any of its three forms. */
const SANCTIONED_SELF = [
  /semantic context layer/i,
  /(?:personali[sz]ed and preemptive|cybersec and sre)/i,
];

const REAL_LINES = [
  '"The vendor-neutral semantic context layer for Sec and Dev AI agents." (brand guidelines)',
  '"Personalized and Preemptive CyberSec and SRE." (the presentation instruction set)',
].join(' or ');

// --- The trust anchors a stranger needs -------------------------------------

/**
 * Names that answer "why would I believe you", one of which has to appear.
 *
 * A CISO does not act on claims from an unknown vendor. The document reviewed
 * had no reference, no certification and no named integration — nothing the
 * reader could check. The cheapest fix is naming tools they already run.
 */
const TRUST_ANCHORS =
  new RegExp(
    '\\b(' +
      // Certifications and frameworks.
      'SOC ?2|ISO ?27001|FedRAMP|HIPAA|PCI[- ]?DSS|' +
      // Security tooling.
      'Splunk|Sentinel|CrowdStrike|Defender|Qualys|Tenable|Rapid7|Okta|' +
      // And the platforms an estate actually runs on. Naming AWS, GCP and
      // Azure — the three the lead itself listed for this account — was
      // reported as naming nothing, because the list was security products
      // only. A hyperscaler is a tool they already run by any reading.
      'AWS|Azure|GCP|Google Cloud|Kubernetes|GitLab|GitHub|ServiceNow|Jira|' +
      'reference customer|case study' +
    ')\\b',
    'i',
  );

/**
 * A CTA is only an ask if it names a when.
 *
 * "before\s+(?:the\s+)?\w+" used to be the last branch, and it matches
 * "before it", "before you", "before anything" — ordinary English. An email to
 * Zscaler closed on "Worth 20 minutes to walk through what that looks like on
 * your infrastructure?", which names no day at all, and this rule stayed quiet
 * because a paragraph further up said a vulnerability should be closed "before
 * it finds it". A rule satisfied by prose about something else is not a rule.
 *
 * "before" now needs a TIME after it, and so does "by".
 */
const WEEKDAY = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';
const MONTH_NAME = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
const DATED_ASK = new RegExp(
  '\\b(' +
    `this week|next week|this month|${WEEKDAY}|` +
    `\\d{1,2}\\s?(?:st|nd|rd|th)?\\s+(?:${MONTH_NAME})|` +
    `(?:${MONTH_NAME})[a-z]*\\s+\\d{1,2}\\b|` +
    '\\d{4}-\\d{2}-\\d{2}|' +
    `(?:by|before)\\s+(?:the\\s+)?(?:end of\\s+)?(?:${WEEKDAY}|next week|this week|month end|quarter end|the \\w+day)` +
  ')\\b',
  'i',
);

/**
 * The line that proposes the meeting, which is where the date has to be.
 *
 * Measured on the whole document before, so any date anywhere satisfied it —
 * including the date CISA published the CVE the email was about, which is a
 * fact about a vulnerability and not an invitation.
 *
 * "The last few lines" was the first attempt and it is not the shape of a real
 * document: a brief puts the ask two bullets from the end and signs off after
 * it. What identifies the ask is what it proposes, so that is what is matched.
 */
const ASK_LINE =
  /\b(call|meeting|minutes?|walk through|walkthrough|walk you through|session|demo|intro|overview|briefing|assessment|scoping|conversation|catch up)\b/i;

function theAsk(text) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  const asks = lines.filter((l) => ASK_LINE.test(l));
  // Nothing proposing anything: fall back to the last line, so a document with
  // no ask at all is still judged on where an ask would have been.
  return (asks.length ? asks : lines.slice(-1)).join('\n');
}

/** A sender block a stranger can reply to. */
const HAS_EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
const HAS_PHONE = /(\+\d[\d ().-]{7,}|\b\d{3}[ .-]\d{3}[ .-]\d{4}\b)/;

/**
 * Words that sell rather than state.
 *
 * Separate from articulation.js's JARGON list, which is about sounding like a
 * chatbot. This is about sounding like a pitch: the register the review asked
 * to kill, where a document tells the reader how significant it is instead of
 * being significant.
 */
const SELLING_REGISTER = [
  /\bchanges everything\b/i,
  /\bgame[- ]?chang/i,
  /\bno[- ]brainer\b/i,
  /\bexciting\b/i,
  /\bthrilled\b/i,
  /\bworld[- ]class\b/i,
  /\bindustry[- ]leading\b/i,
  /\bunparalleled\b/i,
];

// --- The checks -------------------------------------------------------------

/**
 * The text a drawn layout puts on the page.
 *
 * Which is not the same as the text its section carries as prose. spec.js
 * builds the fallback points from the layout data BEFORE normalisation and
 * then cleans the layout fields separately, so the two diverge the moment a
 * cap bites — the point says "Case context ingested - docket, parties, stage"
 * while the page says "Case context ingested -".
 *
 * That divergence is why truncatedTails came back clean on a brief with four
 * cut sentences in it. The checker was reading the copy nobody sees.
 */
function drawnText(s) {
  const out = [];

  // A figure and the words that source it are ONE line, because every rule
  // here that matters is line-scoped. Emitting them separately put "7.5x" on a
  // line of its own and "…rather than severity. McKinsey." on the next, so the
  // sourcing check reported the best-attributed number in the document as
  // unattributed — the exact laundering failure the line-scoping was added to
  // stop, running in reverse.
  if (s.layout === 'stat' && s.value) return [[s.value, s.caption].filter(Boolean).join(': ')];

  if (Array.isArray(s.tiles)) for (const t of s.tiles) out.push(`${t.value}: ${t.caption}`);
  if (Array.isArray(s.bars)) for (const b of s.bars) out.push(`${b.label}: ${b.value}`);
  if (Array.isArray(s.kpis)) for (const k of s.kpis) out.push(`${k.code}: ${k.target}`);
  if (Array.isArray(s.cards)) for (const c of s.cards) out.push(`${c.metric}: ${c.body}`);
  if (Array.isArray(s.steps)) out.push(...s.steps);
  if (Array.isArray(s.stops)) out.push(...s.stops);
  if (Array.isArray(s.names)) out.push(...s.names);
  if (Array.isArray(s.columns)) out.push(s.columns.join(', '));
  if (Array.isArray(s.rows)) for (const r of s.rows) out.push(r.join(', '));
  for (const key of ['value', 'caption', 'from', 'to', 'left', 'right', 'line', 'sentence', 'tag']) {
    if (typeof s[key] === 'string' && s[key]) out.push(s[key]);
  }
  return out;
}

/**
 * Disclosures that mean a customer will read this.
 *
 * `external_ok` alone was the test, and a draft awaiting approval is not
 * internal — approval is the LAST gate before it leaves, which is exactly when
 * a retired phrase has to be caught rather than the moment after.
 *
 * A brief to the CISO of the American Arbitration Association carried both
 * retired phrases at once, "run the Semantic Loop as managed support" and "an
 * outcome bonus at risk", and every check that exists for them stayed quiet
 * because the document had declared itself a draft. The stamp on its own
 * pages read "Draft: needs approval before it leaves Vikat" — it was on its
 * way out of the building and the checker read it as staying in.
 *
 * Shared with articulation.js's introduction check, which had already reached
 * the same conclusion separately. Two copies of a rule is one copy waiting to
 * disagree.
 */
export const CUSTOMER_BOUND = new Set(['external_ok', 'needs_approval']);

/** Everything the document says, in reading order. */
export function outreachText(spec) {
  const parts = [spec.title || '', spec.subtitle || ''];
  for (const s of spec.sections || []) {
    parts.push(s.eyebrow || '', s.title || '', s.body || '');
    // The drawn fields, not only the prose fallback. A figure's caption is
    // read by the customer exactly as a paragraph is, and until this line
    // every rule in this module was blind to it.
    parts.push(...(s.layout ? drawnText(s) : []));
    parts.push(...(s.points || []));
  }
  return parts.filter(Boolean).join('\n');
}

/**
 * Check a piece of outreach against the standing rules.
 *
 * @param {object} spec              A normalised document spec.
 * @param {object} [opts]
 * @param {boolean} [opts.customerFacing]  Defaults to true for external_ok.
 * @param {string}  [opts.recipient]       Who it is addressed to, for the recap check.
 * @returns {{ problems: string[], notes: string[] }}
 */
export function checkExecOutreach(spec, opts = {}) {
  const problems = [];
  const notes = [];
  const text = outreachText(spec);
  const customerFacing =
    opts.customerFacing === undefined ? CUSTOMER_BOUND.has(spec.disclosure) : Boolean(opts.customerFacing);

  // --- Retired language. Not a judgement call.
  for (const rule of RETIRED_PHRASES) {
    if (rule.customerFacingOnly && !customerFacing) continue;
    const hit = text.match(new RegExp(rule.pattern.source, 'i'));
    if (hit) {
      problems.push(`"${hit[0]}" is retired. ${rule.because} Say: ${rule.say}.`);
    }
  }

  // --- Internal stamps, which the renderer adds as well as the model. A
  // cleared document is the one case where the label is pure leakage.
  if (customerFacing) {
    for (const stamp of INTERNAL_STAMPS) {
      const hit = text.match(stamp);
      if (hit) {
        problems.push(
          `"${hit[0]}" is internal clearance language and this document is going to a customer. ` +
            'Strip it: the stamp exists to warn a rep, and there is nothing to warn a customer about.',
        );
        break;
      }
    }
  }

  // --- Every anchor figure carries its source, in the same breath.
  for (const figure of unsourcedFigures(text)) {
    problems.push(
      `"${figure}" carries an argument and no source. Attribute it inline, beside the number. ` +
        'An unattributed figure from an unknown vendor reads as invented, which costs more than the figure earns.',
    );
  }

  // --- Truncation. The renderer's ellipsis, not the author's.
  const cut = truncatedTails(text);
  if (cut.length) {
    problems.push(
      `${cut.length} line(s) end mid-sentence in an ellipsis, which is text cut to fit rather than text: ` +
        `${cut.slice(0, 3).map((t) => `"\u2026${t}"`).join(', ')}. Shorten the wording so nothing is cut.`,
    );
  }

  if (!customerFacing) return { problems, notes };

  // --- What a stranger needs in order to reply. Notes, because a second
  // touch legitimately leans on the first and need not repeat its credentials.
  // A regulation listed as a certification.
  //
  // Line-scoped, because the fault is the WORD next to the name: "aligned to
  // GDPR" is true and "certified in GDPR" is not, and they differ by one verb
  // on one line.
  if (customerFacing) {
    for (const line of text.split('\n')) {
      if (!CERTIFICATION_CLAIM.test(line)) continue;
      const named = [...new Set((line.match(NOT_A_CERTIFICATION) || []).map((m) => m.trim()))];
      if (!named.length) continue;

      problems.push(
        `${named.join(' and ')} listed as a certification. ` +
          `${named.length > 1 ? 'Those are regulations' : 'That is a regulation'}, not something anyone is ` +
          'certified in, and a CISO knows that before they finish the line. Say what is true and narrower: ' +
          'aligned to it, or evidence generated for it. Keep SOC 2 and ISO where they belong.',
      );
    }
  }

  // A self-description nobody approved.
  const described = SELF_DESCRIPTION.exec(text);
  if (customerFacing && described && !SANCTIONED_SELF.some((re) => re.test(described[1]))) {
    problems.push(
      `"Vikat is ${described[1].trim()}" is not a line this company uses anywhere. Saying who we are ` +
        'is the one sentence that has to be the same every time, and it has been different in every ' +
        `document. Use ${REAL_LINES}.`,
    );
  }

  if (!TRUST_ANCHORS.test(text)) {
    notes.push(
      'No trust anchor: no named integration, certification or reference. A stranger does not act on ' +
        'claims alone. Name tools they already run, or a certification, or a customer in their vertical.',
    );
  }

  if (!DATED_ASK.test(theAsk(text))) {
    notes.push(
      'The ask has no date. "A 30-minute call" is an intention; a specific window, a named owner, and ' +
        'what they keep from the call even if nothing proceeds, is an ask.',
    );
  }

  const sender = String(spec.preparedBy || opts.preparedBy || '');
  if (sender && !(HAS_EMAIL.test(sender) && HAS_PHONE.test(sender))) {
    notes.push(
      `The sender block reads "${sender}". On outreach to a stranger it needs a full name, a title, ` +
        'and direct contact: they cannot reply to a first name.',
    );
  }

  for (const phrase of SELLING_REGISTER) {
    const hit = text.match(phrase);
    if (hit) {
      notes.push(`"${hit[0]}" sells rather than states. Say the thing itself; the reader decides if it is big.`);
      break;
    }
  }

  for (const repeated of overRepeated(text)) {
    notes.push(
      `"${repeated}" appears repeatedly. Said once it is a fact; said three times it is a pitch, and the ` +
        'third time is the one the reader notices.',
    );
  }

  return { problems, notes };
}

/**
 * The tail of every line that ends in a truncation ellipsis.
 *
 * The TAIL, because the first version quoted the whole line and the offending
 * line was a 500-character paragraph: a report that reprints a page back at a
 * rep is one nobody finishes. What identifies the fault is the handful of
 * words before the cut, which is also the part that has to be shortened.
 */
export function truncatedTails(text, context = 60) {
  const out = new Set();
  for (const line of String(text).split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed.endsWith('\u2026')) continue;
    out.add(trimmed.slice(Math.max(0, trimmed.length - context)).trim());
  }
  return [...out];
}

/**
 * Anchor figures with no source on the same line.
 *
 * Scoped to the LINE, and that scope is the whole design. The first version
 * searched a 180-character window either side, which sounds generous and is
 * wrong: in
 *
 *   265 attacks in 2025, up from 167 in 2023. Source: Food and Ag-ISAC.
 *   7.5x: projected risk reduction from reordering the same budget.
 *
 * the window put the ISAC citation within reach of the 7.5x and passed it. One
 * properly sourced figure was laundering the unsourced one next to it, which
 * is precisely the figure the review called fatal with this reader.
 *
 * A line is also what "inline" means to the person reading: a bullet, a
 * heading, a sentence in a paragraph. A source on a different line is a
 * footnote, and the reader's question is "says who" at the moment the number
 * appears.
 */
export function unsourcedFigures(text) {
  const out = [];
  const seen = new Set();

  for (const raw of String(text).split('\n')) {
    // A sender block is contact details, not evidence. "+1 512 555 0134" was
    // reported as an unattributed figure, on the line that exists so a
    // stranger can reply — so the check asking for a source was pointing at
    // the phone number.
    const line = raw.replace(HAS_PHONE, ' ').replace(HAS_EMAIL, ' ');
    if (SOURCE_NEARBY.test(line) || cited(line)) continue;

    for (const m of line.matchAll(ANCHOR_FIGURE)) {
      const figure = m[0].trim();
      if (seen.has(figure) || YEAR.test(figure)) continue;
      if (STANDARD_BEFORE.test(line.slice(0, m.index))) continue;
      if (IDENTIFIER_BEFORE.test(line.slice(0, m.index))) continue;
      seen.add(figure);
      out.push(figure);
    }
  }
  return out;
}

/**
 * Distinctive phrases a document leans on too often.
 *
 * Three occurrences, and only of phrases long enough to be a claim rather than
 * grammar. "free diagnostic, no commitment" three times in two pages was the
 * finding; "of the" a hundred times is English.
 */
export function overRepeated(text, times = 3) {
  const words = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const counts = new Map();
  for (let n = 2; n <= 3; n += 1) {
    for (let i = 0; i + n <= words.length; i += 1) {
      const phrase = words.slice(i, i + n).join(' ');
      if (phrase.length < 12) continue;
      counts.set(phrase, (counts.get(phrase) || 0) + 1);
    }
  }

  const hits = [...counts.entries()].filter(([, c]) => c >= times).map(([p]) => p);
  // Keep the longest of any overlapping pair, so one repetition is reported
  // once rather than as every sub-phrase of itself.
  return hits.filter((p) => !hits.some((other) => other !== p && other.includes(p))).slice(0, 2);
}

/**
 * How much of the document is the reader's own situation read back to them.
 *
 * The review's sharpest point: "He knows McLane has 80 DCs and 110,000
 * locations." Recap buys attention for one line and spends it after that, and
 * page one of the document reviewed was half recap.
 *
 * Measured against the recipient's own name because that is what recap looks
 * like mechanically: sentences whose subject is them. It is a note and a crude
 * one, so it reports a proportion and lets a writer judge it.
 */
export function recapShare(text, recipient) {
  const name = String(recipient || '').trim();
  if (!name) return null;

  const first = name.split(/[\s,]+/)[0];
  if (first.length < 3) return null;

  const sentences = String(text)
    .split(/(?<=[.!?])\s+|\n/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).length >= 5);
  if (!sentences.length) return null;

  const about = sentences.filter((s) => new RegExp(`\\b${first}\\b`, 'i').test(s));
  return { share: about.length / sentences.length, sentences: sentences.length, about: about.length };
}
