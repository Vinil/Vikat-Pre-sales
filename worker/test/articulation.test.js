/**
 * How the writing sounds.
 *
 * Every other check here is about facts. This one is about whether a
 * stakeholder reads two sentences and keeps going — and whether the copy
 * announces that a machine wrote it, which is the thing a reader who sees
 * twenty of these a week has learned to skip.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkArticulation,
  checkHeadline,
  checkIntroduction,
  ARTICULATION_BLOCK,
  STORY_ARC,
} from '../src/articulation.js';

const notes = (t) => checkArticulation(t).notes.join(' | ');

test('an opener that would fit any company is called out', () => {
  // The first line is the only one guaranteed to be read, so it gets its own
  // check rather than being one more hit in a list.
  const n = notes("In today's rapidly evolving threat landscape, security teams face challenges.");
  assert.match(n, /would fit any company/);
});

test('a specific opener raises nothing', () => {
  // The check must not fire on good copy. A warning that cries wolf is one
  // reps learn to skip, and then the real one goes unread.
  assert.equal(
    notes('McLane opened a tech hub in Austin in August and is deploying AI agents into operations.'),
    '',
  );
});

test('the words that arrive by default rather than by choice', () => {
  const n = notes('We leverage robust, seamless tooling to unlock transformative value.');
  assert.match(n, /Reads as generated/);
  for (const w of ['leverage', 'robust', 'seamless', 'unlock']) assert.match(n, new RegExp(w));
});

test('the shapes people actually notice', () => {
  assert.match(notes("It's not just a scanner, it's a context layer."), /it's not just X/i);
  assert.match(notes('Not only does it detect, but also it prevents.'), /not only X but also/i);
  assert.match(notes('Moreover, the platform scales.'), /essay connective/);
  assert.match(notes('I hope this helps.'), /assistant's sign-off/);
  assert.match(notes('This can help to potentially reduce dwell time.'), /stacked hedging/);
});

test('emoji are out, in any material', () => {
  assert.match(notes('Great news 🚀 for your team.'), /No emoji/);
});

test('sentences that run long are measured, not guessed at', () => {
  // "Short sentences, plain words" has a number behind it, and copy averaging
  // thirty words a sentence is not what either guidelines document describes.
  const long = Array.from({ length: 4 }, () =>
    'The platform provides a comprehensive and deeply integrated approach to the ongoing management of security context across the entire enterprise estate, including every workload, every data store and every agent that might reasonably need to consult it during an incident.',
  ).join(' ');
  assert.match(notes(long), /words a sentence/);
});

test('short declarative copy is left alone', () => {
  // Spare, declarative, technical. This is the target, and nothing should fire.
  assert.equal(
    notes('BerryGPT went live in March. It reads from the same stores your pickers use. Worth twenty minutes?'),
    '',
  );
});

test('empty copy is not a finding', () => {
  assert.deepEqual(checkArticulation('').notes, []);
  assert.deepEqual(checkArticulation(null).notes, []);
});

test('the prompt block says what to do, not what to admire', () => {
  // "Be direct" is not actionable. "The outcome first, in the first sentence"
  // is. The block is instructions or it is decoration.
  assert.match(ARTICULATION_BLOCK, /outcome first, in the first sentence/);
  assert.match(ARTICULATION_BLOCK, /must not read as though a machine wrote it/);
  assert.match(ARTICULATION_BLOCK, /pick the shorter, plainer option/);
  assert.match(ARTICULATION_BLOCK, /Address the reader as "you"/);
  // Named tells, so the model has something to avoid rather than a mood.
  for (const w of ['leverage', 'seamless', 'Moreover']) {
    assert.match(ARTICULATION_BLOCK, new RegExp(w));
  }
});

// --- the story, the headlines, and not praising your own work --------------

test('the arc starts where the reader already feels good', () => {
  // Not a template. The current decks open on the problem, which reads as a
  // stranger telling you what is wrong with your company. Someone rolling AI
  // agents across 418 sites is proud of that, and rightly.
  assert.deepEqual(
    STORY_ARC.map((s) => s.beat),
    ['Personalize', 'Their priorities', 'Why now', 'How we accelerate', 'Next steps'],
  );
  // Each beat says what it does AND how it fails: a beat with no failure mode
  // is a heading, and a writer cannot tell whether they hit it.
  for (const s of STORY_ARC) {
    assert.ok(s.does && s.fails, `${s.beat} has no failure mode`);
  }
  assert.match(STORY_ARC[1].fails, /opportunity, not deficiency/i);
});

test('a headline built on a product name is a closed door', () => {
  const n = checkHeadline('SecSemantic for McLane').notes.join(' ');
  assert.match(n, /never heard of/);
  assert.match(n, /once the idea has landed/);
});

test('inside words are fine in the body, wrong in the headline', () => {
  // The rule is about the ONE line guaranteed to be read, not about the
  // vocabulary as a whole.
  assert.equal(checkHeadline('').notes.length, 0);
  assert.ok(checkHeadline('The Security Context Plane').notes.length > 0);
  assert.equal(
    checkArticulation('SecSemantic builds a system of record for consequence.').notes.length,
    0,
    'the product name in prose is not a finding',
  );
});

test('a headline that labels rather than says', () => {
  for (const h of ['The commitment model', 'How the suite fits', 'Our approach', 'Overview']) {
    assert.match(checkHeadline(h).notes.join(' '), /labels the slide/, h);
  }
});

test('a headline that makes a point passes', () => {
  for (const h of [
    'Two surfaces now land on every healthcare CISO desk',
    'Your agents reach patient data faster than your reviews do',
  ]) {
    assert.equal(checkHeadline(h).notes.length, 0, h);
  }
});

test('the assistant does not call its own work ready', () => {
  // On a deck stamped DRAFT, NEEDS APPROVAL BEFORE IT LEAVES VIKAT, "ready for
  // customer use" is not just chatbot flavour. It is false.
  for (const s of [
    'The deck is ready for customer use.',
    'This is a polished, client-ready one-pager.',
    'Your presentation-ready deck is attached.',
  ]) {
    assert.match(notes(s), /rep decides that/, s);
  }
  assert.equal(notes('The deck is built. Check the 48 versus 60 country figure before it goes out.'), '');
});

test('the prompt carries the arc, the headline rule and the visual rule', () => {
  // A checker catches it after the fact; the prompt is what stops it being
  // written. Both, or the model writes it and the rep reads a complaint.
  assert.match(ARTICULATION_BLOCK, /Every headline answers "why should I care"/);
  assert.match(ARTICULATION_BLOCK, /SecSemantic for McLane/);
  assert.match(ARTICULATION_BLOCK, /Personalize/);
  assert.match(ARTICULATION_BLOCK, /Why now/);
  assert.match(ARTICULATION_BLOCK, /One ask, small enough to say yes to/);
  assert.match(ARTICULATION_BLOCK, /A deck is looked at, not read/);
  assert.match(ARTICULATION_BLOCK, /Never call your own work ready/);

  // A checker that reports a missing introduction after the PDF exists costs
  // the rep a round trip. The prompt is what stops it being written that way.
  assert.match(ARTICULATION_BLOCK, /Say who we are before you use our words/);
  assert.match(ARTICULATION_BLOCK, /Introduce, then name, then explain/);
  assert.match(ARTICULATION_BLOCK, /A headline is a sentence, not a noun phrase/);
});

test('the dash rule is checked here, not only where copy is rendered', () => {
  // §07's first rule, and it was missing until the message announcing this
  // component was run through it and came back clean while containing three.
  // noDashes() is applied in outreach.js and through brandSafe, so the rule
  // was enforced in both places that RENDER and neither place that READS.
  assert.match(notes('Two surfaces — both new — land this quarter.'), /2 dashes in the copy/);
  assert.match(notes('One thought – then another.'), /1 dash in the copy/);
  assert.match(notes('A dash here — like this.'), /comma, a full stop or a new sentence/);
  // A hyphen inside a word is not a dash.
  assert.equal(notes('Vendor-neutral, self-hosted, board-ready.'), '');
});

// --- Who we are -------------------------------------------------------------

/** A customer-bound spec, so each test varies one thing. */
const brief = (over = {}) => ({
  disclosure: 'external_ok',
  title: 'Your fulfillment window is your attackers’ calendar.',
  subtitle: 'What a severity score cannot see.',
  sections: [
    { title: 'The calendar sets the price.', body: 'Severity scoring cannot see the calendar.', points: [] },
  ],
  ...over,
});

const intro = (spec) => checkIntroduction(spec).problems.join(' | ');

test('a product named before Vikat is introduced is a problem', () => {
  // "All of a sudden there's a reference of SecSemantic." checkHeadline
  // already refused an inside word in a HEADLINE, and that rule was working:
  // the brief kept its product names out of its headings and put SecSemantic
  // in the body, where nothing was looking. The rule was never about
  // headlines. It is about a reader meeting a word they cannot parse.
  const spec = brief();
  spec.sections[0].points = ['SecSemantic reads the alert stream alongside Splunk.'];

  const p = intro(spec);
  assert.match(p, /SecSemantic is named before/);
  assert.match(p, /Introduce Vikat and what it does first/);
});

test('order is the whole point: the same two sentences, the other way round', () => {
  // Not "does the document contain both". A reader meets them in order, and
  // the fault is meeting the product first. Swapping nothing but the sequence
  // has to change the verdict, or this is measuring presence, not position.
  const before = brief({
    sections: [
      { title: 'A', body: 'SecSemantic reads the alert stream.', points: [] },
      { title: 'B', body: 'Vikat builds the semantic context layer for security operations.', points: [] },
    ],
  });
  const after = brief({
    sections: [
      { title: 'A', body: 'Vikat builds the semantic context layer for security operations.', points: [] },
      { title: 'B', body: 'SecSemantic reads the alert stream.', points: [] },
    ],
  });

  assert.match(intro(before), /named before/);
  assert.equal(intro(after), '');
});

test('a document with no introduction at all is a problem', () => {
  // "No introduction of Vikat and what we stand for and do." A brief that
  // never says whose advice this is, to somebody who has not met us.
  assert.match(intro(brief()), /Nothing here says who Vikat is/);
});

test('a signature is not an introduction', () => {
  // The copyright line and the sender block both name us on every page, so a
  // check that only looked for the word would come back clean on the exact
  // document that prompted this.
  const signature = brief({
    sections: [{ title: 'A', body: 'Severity scoring cannot see the calendar.', points: ['Vikat.AI'] }],
  });
  assert.match(intro(signature), /Nothing here says who Vikat is/);

  const sentence = brief({
    sections: [
      { title: 'A', body: 'Vikat builds the semantic context layer for security operations.', points: [] },
    ],
  });
  assert.equal(intro(sentence), '');
});

test('an internal document may open on its own vocabulary', () => {
  // A deal review may say SecSemantic in its first line, because everybody
  // reading it has heard of SecSemantic. The rule is about strangers.
  const internal = brief({ disclosure: 'internal_only' });
  internal.sections[0].points = ['SecSemantic reads the alert stream.'];
  assert.equal(intro(internal), '');

  // But a draft awaiting approval is checked: approval is the last gate before
  // it leaves, which is exactly when a missing introduction has to be caught.
  const draft = brief({ disclosure: 'needs_approval' });
  draft.sections[0].points = ['SecSemantic reads the alert stream.'];
  assert.match(intro(draft), /named before/);
});

test('a spec with no disclosure is treated as internal, not as a customer document', () => {
  // normaliseSpec's own default for an unknown value is the cautious one, and
  // this has to match it. The other way round, every hand-built spec became a
  // customer document with a missing introduction.
  assert.equal(intro(brief({ disclosure: undefined })), '');
  assert.equal(intro(brief({ disclosure: 'obviously_fine' })), '');
});

// --- Cryptic headlines ------------------------------------------------------

const headline = (h) => checkHeadline(h).notes.join(' | ');

test('a headline with no verb is a gesture, not a claim', () => {
  // "The articulation including headlines that are cryptic." LABEL_HEADLINES
  // already caught the filing labels — "Our approach", "Overview" — and it
  // does not catch these, because these are not labels. They are gestures:
  // evocative, and the reader has to reach the body to find out what was
  // meant, which is the opposite of what a headline is for.
  for (const h of ['Beyond detection', 'The quiet shift', 'Under pressure', 'The calendar problem']) {
    assert.match(headline(h), /no verb in it/, h);
  }
});

test('a headline that makes a claim passes, however short', () => {
  // The direction this has to be wrong in. An advisory note that fires on good
  // headlines gets the whole report skipped, and then so does the real one.
  for (const h of [
    'The question has moved',
    'The fulfillment window is the asset',
    'Where the budget already is',
    'What we would need from you',
    'The calendar sets the price of an intrusion.',
    'Three surfaces now land on every healthcare CISO’s desk',
    'Your fulfillment window is your attackers’ calendar.',
  ]) {
    assert.equal(headline(h), '', h);
  }
});

test('a filing label gets the label note and not both', () => {
  // A drawer label is also a noun phrase, so it satisfies both rules. One
  // headline, one note: the label message is the more specific of the two and
  // already says what to do next.
  const n = checkHeadline('Our approach').notes;
  assert.equal(n.length, 1, n.join(' | '));
  assert.match(n[0], /labels the slide/);
});

test('a one-word headline is not judged on its grammar', () => {
  // "Overview" is caught as a label. A single word that is not one of those is
  // a section marker and has no room for a verb; flagging it says nothing a
  // writer can act on.
  assert.equal(headline('Timing'), '');
});

// --- Melodrama --------------------------------------------------------------

test('a cover line that reads like a film trailer is flagged', () => {
  // "The headlines and title of the document is still very cheesy", on a brief
  // whose cover said "When a matter leaks, the proceeding fails." Nothing here
  // caught it and nothing was going to: it is not jargon, not a filing label,
  // and not cryptic. It is melodrama, and melodrama is a SHAPE — the words are
  // always different and the shape never is.
  for (const line of [
    'When a matter leaks, the proceeding fails.',
    'In the age of autonomous agents, governance cannot keep up.',
    'Consequence is the new severity.',
    'Make no mistake: this is different.',
    'It is not a matter of if, but when.',
  ]) {
    assert.match(notes(line), /Say what is true, plainly/, line);
  }
});

test('a line is worth one note, however many ways it is overwrought', () => {
  // The cover line is both a conditional catastrophe and a doom clause, and it
  // is still one sentence to rewrite. A report that says so twice is a report
  // a rep starts skimming, and then the real note goes with it.
  const n = checkArticulation('When a matter leaks, the proceeding fails.').notes;
  assert.equal(n.length, 1, n.join(' | '));
});

test('a plain statement about something bad is not melodrama', () => {
  // The direction this has to be wrong in. Security writing is about failure;
  // flagging every sentence that mentions one makes the note worthless.
  for (const line of [
    'A leaked brief exposes party strategy during a live hearing.',
    'The stack scores every finding by severity.',
    'Stolen credentials are revoked before first use.',
    'Arbitration rests on one commitment: what enters a proceeding does not leave it.',
  ]) {
    assert.doesNotMatch(notes(line), /Say what is true, plainly/, line);
  }
});

test('a phrase and then the same phrase negated is not a thought', () => {
  // "A conflict wall enforced by policy is not a conflict wall" closed a brief
  // to a CISO. It reads as profound and contains nothing.
  assert.match(
    notes('A conflict wall enforced by policy is not a conflict wall.'),
    /same phrase negated/,
  );

  // A real contrast is not a tautology, and this must not eat one.
  assert.equal(notes('Severity is not the same as consequence.'), '');
  assert.equal(notes('The model is not hosted by us.'), '');
});

// --- Simple English ---------------------------------------------------------

test('a long word with a short one available is named WITH the short one', () => {
  // "Simple English. No fancy words." Naming the fault without naming the fix
  // sends somebody off to think of a synonym, which is the cost this exists to
  // avoid — the same reason every retired phrase carries its replacement.
  const n = notes('Greater risk reduction from resequencing the same security budget prior to the hearing.');
  assert.match(n, /resequencing → reordering/);
  assert.match(n, /prior to → before/);
});

test('ordinary security vocabulary is left alone', () => {
  // "Severity", "credentials", "arbitration" and "orchestration" are the words
  // for the things. A checker that calls them fancy is one nobody finishes.
  assert.equal(
    notes('Severity scoring, stolen credentials, and agentic orchestration across the arbitration estate.'),
    '',
  );
});

// --- The standing rules -----------------------------------------------------

test('the prompt carries the five rules the work is judged against', () => {
  // These came from the person whose name goes on the document, and they apply
  // to every document, deck, email and post. A checker catches it afterwards;
  // the prompt is what stops it being written.
  assert.match(ARTICULATION_BLOCK, /Simple English\. No fancy words/);
  assert.match(ARTICULATION_BLOCK, /Professional and to the point/);
  assert.match(ARTICULATION_BLOCK, /The hook cannot be cryptic/);
  assert.match(ARTICULATION_BLOCK, /Dry wit is welcome\. Jokes are not/);
  assert.match(ARTICULATION_BLOCK, /Nobody may think a machine wrote this/);

  // Rule four is the one that goes wrong if it is left as "be funny". The
  // limits travel with it or a brief to a CISO arrives with a pun in it.
  assert.match(ARTICULATION_BLOCK, /never a joke at the\s+reader's expense/);
  assert.match(ARTICULATION_BLOCK, /never more than one per document/);

  // And the melodrama rule, which is what "cheesy" turned out to mean.
  assert.match(ARTICULATION_BLOCK, /Never melodramatic/);
});

// --- Mind-reading -----------------------------------------------------------

test('telling the reader what their own actions prove about them is flagged', () => {
  // The one that had to go. An email to a CISO at Zscaler opened:
  //
  //   "The AI security hires you're making right now, engineers working in Go,
  //    Rust, and Python on agent security, show you're thinking carefully about
  //    what Model Context Protocol in production actually means for your attack
  //    surface."
  //
  // Thirty-eight words spent awarding the reader a compliment inferred from a
  // job advert. The reader already knows what their own hiring means and did
  // not ask a stranger to tell them. It is the most reliable tell there is.
  for (const line of [
    "Your AI security hires show you're thinking carefully about agent risk.",
    'The fact that you posted three detection roles says this is a priority.',
    "You're clearly investing in agent governance.",
    "I've been following your security programme.",
    'Congratulations on the new detection team.',
    'Your commitment to agent governance is impressive.',
    'As a leader who runs a global SOC, you already know this.',
  ]) {
    assert.match(notes(line), /Reads as generated/, line);
  }
});

test('the note says what to write instead', () => {
  // Naming the fault without the fix is how a rep ends up rewriting the same
  // sentence three ways and picking the one that sounds most like the last.
  const n = notes("Your AI security hires show you're thinking carefully about agent risk.");
  assert.match(n, /Say the fact and stop/);
  assert.match(n, /draw their own conclusion/);
});

test('an ordinary sentence about their systems is not mind-reading', () => {
  // The direction this has to be wrong in. Outreach is ABOUT the reader's
  // estate; a rule that fires on every sentence mentioning them is a rule that
  // gets the whole report skipped.
  for (const line of [
    'You run Splunk and CrowdStrike, and we read what they already produce.',
    'Your SIEM does not know which matters are in active hearing.',
    "You're hiring Go, Rust and Python engineers for agent security.",
    'GitLab appears in your own job postings.',
    'Your stack ranks alerts by severity.',
  ]) {
    assert.doesNotMatch(notes(line), /Reads as generated/, line);
  }
});

test('a long opening sentence is flagged on its own', () => {
  // Separate from the sentence-length average, which a single long opener
  // barely moves. The first sentence is the one a reader uses to decide
  // whether a person wrote this, and the tell is nested clauses before the
  // verb arrives.
  const long =
    'The AI security hires you are making right now, engineers working in Go, Rust and Python on ' +
    'agent security, point at a question about what Model Context Protocol in production means here.';
  assert.match(notes(long), /opening sentence is \d+ words/);

  // Two short sentences carrying the same information pass.
  assert.equal(
    notes("You're hiring Go, Rust and Python engineers for agent security. So MCP in production is already on your plate."),
    '',
  );
});

test('the prompt says how to open, with the sentence that went wrong in it', () => {
  // A checker catches it afterwards. The prompt is what stops it being written,
  // and a rule stated as "be human" is not a rule.
  assert.match(ARTICULATION_BLOCK, /## How to open/);
  assert.match(ARTICULATION_BLOCK, /Name the fact\. Stop\. Do not say what it proves/);
  assert.match(ARTICULATION_BLOCK, /your X shows you're…/);
  assert.match(ARTICULATION_BLOCK, /Open under twenty-five words/);

  // And the arc beat that licensed it. "Acknowledge the work they have done"
  // is what a model reads as permission to editorialise about it.
  const arc = STORY_ARC.find((b) => b.beat === 'Personalize');
  assert.match(arc.does, /and stop there/);
  assert.match(arc.fails, /what their own work shows about them/);
});

test('an absolute about their own stack is flagged', () => {
  // The mirror of mind-reading, and the one that costs most. The Zscaler email
  // said "no SIEM or scanner in your stack answers it" — an absolute, about an
  // estate we have never seen, to a company that sells security tooling. The
  // reader's first thought is "you don't know what's in my stack", and they
  // are right.
  for (const line of [
    'It is a business context question, and no SIEM or scanner in your stack answers it.',
    'Your SIEM cannot see which matters are in active hearing.',
    'Nothing you run today can answer that.',
    'Nothing in your estate answers it.',
  ]) {
    assert.match(notes(line), /absolute about their own stack/, line);
  }

  // The same claim as a question survives, and the note says so.
  assert.equal(notes('Does anything you run answer that today?'), '');
  assert.match(
    notes('Nothing in your estate answers it.'),
    /does anything you run\s+answer that today/i,
    'the replacement has to travel with the refusal',
  );
});

test('describing their stack without judging it is fine', () => {
  // Outreach is about their estate. A rule that fires on every mention of it
  // is a rule that gets the report skipped.
  for (const line of [
    'We work alongside your existing SIEM, EDR and cloud tooling.',
    'Your stack ranks alerts by severity.',
    'Nothing is ripped out.',
    'You run Splunk and CrowdStrike.',
  ]) {
    assert.doesNotMatch(notes(line), /absolute about their own stack/, line);
  }
});

// --- Context, from a company selling context --------------------------------

test('an opening that is a catalogue entry is flagged', () => {
  // The sharpest note anyone gave this project: "opening the email like that
  // is totally out of context for a company selling context."
  //
  // "CISA added CVE-2026-85706 in GitLab CE/EE to its known-exploited
  // vulnerabilities catalog on September 11." Every word true, and the whole
  // sentence is a record from a catalogue. The pitch two paragraphs later is
  // that a CVE number tells you nothing until you know what it can reach — so
  // the opening refutes the argument before the reader gets to it.
  for (const line of [
    'CISA added CVE-2026-85706 in GitLab CE/EE to its known-exploited vulnerabilities catalog on September 11.',
    'Vikat holds ISO 27001 and SOC 2 Type 2.',
  ]) {
    assert.match(notes(line), /catalogue entry/, line);
  }

  // The fix is the ORDER, not the content. The same fact with the reader in
  // it passes, and the number still goes in right after.
  assert.equal(
    notes("Your GitLab is on CISA's exploited list as of Friday. The entry is CVE-2026-85706."),
    '',
  );

  // And the number may stay in the FIRST sentence, as long as the reader is
  // there too. This is a rule about who the sentence is about, not a ban on
  // identifiers — without that assertion it passes as a ban.
  assert.equal(
    notes("Your GitLab instance is affected by CVE-2026-85706, added to CISA's list on Friday."),
    '',
  );
});

test('an identifier later in the copy is not an opening', () => {
  // Only the FIRST sentence. A CVE named in paragraph three is evidence, which
  // is where evidence belongs.
  assert.doesNotMatch(
    notes('Your GitLab sits two hops from the build pipeline.\nThe entry is CVE-2026-85706, added on Friday.'),
    /catalogue entry/,
  );

  // Including when the opening has no reader in it either — it is the FIRST
  // sentence that is judged, and this one carries no identifier to judge.
  assert.doesNotMatch(
    notes('The advisory landed on Friday.\nThe entry is CVE-2026-85706.'),
    /catalogue entry/,
  );
});

test('the prompt says the order out loud', () => {
  assert.match(ARTICULATION_BLOCK, /## Writing to someone who has never heard of us/);
  assert.match(ARTICULATION_BLOCK, /Say who is writing, in the first two or three sentences/);
  assert.match(ARTICULATION_BLOCK, /consequence, then evidence/);
  assert.match(
    ARTICULATION_BLOCK,
    /cannot open its own\s+email on a severity score/,
    'the contradiction has to be named, not implied',
  );
});

test('a heading with no full stop does not merge into the line below it', () => {
  // A title, a subject or a bullet ends without punctuation, so a sentence
  // splitter runs straight through into whatever follows and reports the two
  // as one long sentence. A newline ends a sentence: those three things all
  // end that way and nothing else does.
  const heading = 'Where the GitLab exposure actually reaches today';
  const body = 'The advisory names the flaw and stops there, which leaves the question of which instance sits near something critical.';

  // Twelve words plus twenty is over the limit only if they are treated as one.
  assert.equal(notes(`${heading}\n${body}`), '', `${heading} / ${body}`);

  // And the long one on its own is still caught.
  assert.match(notes(`${heading} ${body}`), /opening sentence is \d+ words/);
});

// --- Courtesy ---------------------------------------------------------------

test('telling a CISO they have missed something is flagged', () => {
  // Every draft so far carried the same posture: here is a gap you cannot
  // see, and we can see it. To the person whose job is seeing it, that reads
  // as a stranger who has not considered they might already be on it.
  //
  // It comes from the source material — "Most CISOs can't answer the first
  // one" is a line in the knowledge base — so the model is repeating the
  // register it was handed.
  for (const line of [
    'Most CISOs cannot answer the board five basic questions.',
    'You may not realise how many agents are running unsanctioned.',
    'This is the blind spot in most agent programmes.',
    'Act before it is too late.',
  ]) {
    assert.match(notes(line), /already\s+on it/, line);
  }
});

test('granting them the competence they have is not flagged', () => {
  // The courteous version costs nothing, is almost certainly true, and changes
  // what is on offer from discovery to speed.
  for (const line of [
    'I would guess this is already on your plate this week.',
    'Where we tend to help is speed.',
    'GitLab shows up in your job postings.',
  ]) {
    assert.doesNotMatch(notes(line), /already\s+on it/, line);
  }
});

test('the prompt asks for a greeting, deference and something they keep', () => {
  assert.match(ARTICULATION_BLOCK, /Say hello, and say who you are/);
  assert.match(ARTICULATION_BLOCK, /Assume they are already on it/);
  assert.match(ARTICULATION_BLOCK, /Give them something they keep/);
  assert.match(
    ARTICULATION_BLOCK,
    /An email that only asks is an email that only takes/,
    'the reason has to travel with the rule',
  );
});
