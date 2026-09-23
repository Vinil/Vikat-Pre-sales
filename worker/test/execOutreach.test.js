/**
 * The standing rules for exec outreach.
 *
 * Every test here names the thing it caught in Mclane_CISO_reach_out.pdf,
 * because that document is the spec. It went to a CISO with a retired phrase,
 * an unattributed 7.5x, an internal clearance stamp on all three pages, four
 * sentences cut mid-word, and a sender block reading "vinil" — and the three
 * checkers that ran over it returned zero notes between them.
 *
 * So the bar for these tests is not that they pass. It is that the document
 * that prompted them would not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkExecOutreach,
  unsourcedFigures,
  overRepeated,
  truncatedTails,
  recapShare,
  RETIRED_PHRASES,
} from '../src/execOutreach.js';

/** A minimal clean document, so each test varies one thing. */
const clean = (over = {}) => ({
  format: 'pdf',
  disclosure: 'external_ok',
  preparedBy: 'Vinil Vadi, Head of Sales, vinil@vikat.ai, +1 512 555 0134',
  audience: 'Northfield Foods',
  title: 'Your fulfillment window is your attackers’ calendar.',
  sections: [
    {
      title: 'The calendar sets the price of an intrusion.',
      body: 'Severity scoring cannot see the calendar. A Semantic Context Graph can.',
      points: [
        'Runs alongside Splunk and CrowdStrike. Nothing is ripped out.',
        'SOC 2 Type 2 and ISO 27001.',
        'A 30-minute scoping call this week, with findings you keep either way.',
      ],
    },
  ],
  ...over,
});

// --- Retired language -------------------------------------------------------

test('a retired phrase is a problem, and the message carries the replacement', () => {
  // "Semantic Loop" reached a CISO. Naming the fault without naming the fix
  // makes a rep go and ask somebody, which is the cost this is meant to avoid.
  const spec = clean();
  spec.sections[0].points.push('Forward Deployed Engineers run the Semantic Loop as managed support');

  const { problems } = checkExecOutreach(spec);
  const hit = problems.find((p) => /Semantic Loop/.test(p));
  assert.ok(hit, problems.join('\n'));
  assert.match(hit, /retired/i);
  assert.match(hit, /the Loop/, 'the replacement has to travel with the refusal');
});

test('"bonus at risk" is retired for customers and kept for internal use', () => {
  // A real commercial term. It belongs in a deal review and not in front of
  // the customer whose contract it describes, so the rule is scoped rather
  // than absolute — a blanket ban would be wrong and would get switched off.
  const withBonus = (disclosure) => {
    const spec = clean({ disclosure });
    spec.sections[0].points.push('Every engagement commits to a 90-day outcome, with a bonus at risk.');
    return checkExecOutreach(spec).problems.filter((p) => /bonus at risk/.test(p));
  };

  assert.equal(withBonus('external_ok').length, 1);
  assert.equal(withBonus('internal_only').length, 0, 'an internal deal review may say it');
});

test('every retired phrase declares what to say instead', () => {
  // A blacklist entry with no replacement is a complaint.
  for (const rule of RETIRED_PHRASES) {
    assert.ok(rule.say && rule.say.length > 3, `${rule.pattern} has no replacement`);
    assert.ok(rule.because && rule.because.length > 10, `${rule.pattern} does not say why`);
  }
});

// --- Internal stamps --------------------------------------------------------

test('internal clearance language in customer copy is a problem', () => {
  // "CLEARED FOR CUSTOMERS" was set in mono capitals on all three pages of a
  // document going to a customer. The stamp warns a REP; a cleared document
  // has nothing to warn anybody about, so it only tells the customer there is
  // an internal review process with opinions about them.
  const spec = clean();
  spec.sections.push({ title: 'Cleared for customers', points: [] });

  const { problems } = checkExecOutreach(spec);
  assert.ok(problems.some((p) => /internal clearance language/i.test(p)), problems.join('\n'));
});

test('an internal document may say internal things', () => {
  const spec = clean({ disclosure: 'internal_only' });
  spec.sections.push({ title: 'Internal only', points: [] });
  assert.equal(
    checkExecOutreach(spec).problems.filter((p) => /clearance/i.test(p)).length,
    0,
  );
});

// --- Sourcing ---------------------------------------------------------------

test('an anchor figure needs its source on the SAME line', () => {
  // The subtle one, and the reason this is line-scoped. A 180-character
  // window either side put the ISAC citation within reach of the 7.5x on the
  // next line and passed it: one properly sourced figure laundering the
  // unsourced one beside it, which is the figure the review called fatal.
  const text = [
    '265 attacks in 2025, up from 167 in 2023. Source: Food and Ag-ISAC.',
    '7.5x: projected risk reduction from reordering the same security budget.',
  ].join('\n');

  assert.deepEqual(unsourcedFigures(text), ['7.5x']);
});

test('attribution in any of its usual shapes counts', () => {
  for (const line of [
    '7.5x risk reduction, per McKinsey.',
    'UNFI disclosed a $350 to $400 million net sales impact.',
    '265 attacks in 2025. Source: Food and Ag-ISAC.',
    'A 30% reduction, according to the 2025 Verizon report.',
  ]) {
    assert.deepEqual(unsourcedFigures(line), [], line);
  }
});

test('a year is a date, not a claim', () => {
  // The first run of this checker asked who says it is 2025. A checker that
  // cries wolf on a date gets scrolled past, and then so does the 7.5x.
  assert.deepEqual(unsourcedFigures('In August 2025, McLane opened a hub in Austin.'), []);
  assert.deepEqual(unsourcedFigures('Between 1999 and 2026 the sector consolidated.'), []);
});

test('small numbers are labels and do not need citing', () => {
  // "Week 0", "80 distribution centers", "a 30-minute call". Demanding a
  // source for these produces a report nobody reads to the end.
  assert.deepEqual(unsourcedFigures('Week 0: a 30-minute scoping call with 3 people.'), []);
});

// --- Truncation -------------------------------------------------------------

test('a line cut to fit is a problem, quoted by its tail', () => {
  // Four of these shipped. The tail, not the line: the offending paragraph was
  // 500 characters, and a report that reprints a page back at a rep is one
  // nobody finishes. The words before the cut are what identifies it and what
  // has to be shortened.
  const long = `${'x'.repeat(400)} identical in a routine week and…`;
  const tails = truncatedTails(long);

  assert.equal(tails.length, 1);
  assert.ok(tails[0].length <= 61, `quoted ${tails[0].length} characters`);
  assert.match(tails[0], /routine week and…$/);

  const { problems } = checkExecOutreach(clean({ title: long }));
  assert.ok(problems.some((p) => /end mid-sentence/.test(p)), problems.join('\n'));
});

test('an ellipsis inside a sentence is punctuation, not truncation', () => {
  assert.deepEqual(truncatedTails('He paused… then answered.'), []);
});

// --- What a stranger needs --------------------------------------------------

test('outreach with no trust anchor is flagged', () => {
  const spec = clean();
  spec.sections[0].points = ['A 30-minute scoping call this week.'];

  const { notes } = checkExecOutreach(spec);
  assert.ok(notes.some((n) => /trust anchor/i.test(n)), notes.join('\n'));
});

test('naming a tool they already run satisfies it', () => {
  assert.equal(
    checkExecOutreach(clean()).notes.filter((n) => /trust anchor/i.test(n)).length,
    0,
  );
});

test('an ask with no date is flagged', () => {
  const spec = clean();
  spec.sections[0].points = ['SOC 2 Type 2.', 'A 30-minute scoping call.'];
  assert.ok(checkExecOutreach(spec).notes.some((n) => /no date/i.test(n)));
});

test('a sender a stranger cannot reply to is flagged', () => {
  // "Prepared by vinil". Lowercase, first name, no title, no contact.
  const { notes } = checkExecOutreach(clean({ preparedBy: 'vinil' }));
  assert.ok(notes.some((n) => /sender block/i.test(n)), notes.join('\n'));

  assert.equal(
    checkExecOutreach(clean()).notes.filter((n) => /sender block/i.test(n)).length,
    0,
    'a full block passes',
  );
});

// --- Register ---------------------------------------------------------------

test('selling register is flagged', () => {
  const { notes } = checkExecOutreach(clean({ title: 'The ordering that changes everything' }));
  assert.ok(notes.some((n) => /sells rather than states/.test(n)), notes.join('\n'));
});

test('a phrase leaned on three times is flagged once', () => {
  // "free diagnostic, no commitment" three times in two pages. Reported once,
  // and as the longest phrase rather than as every sub-phrase of itself.
  const text = [
    'A free diagnostic, no commitment.',
    'The free diagnostic returns first answers.',
    'Weeks 1 to 2: free diagnostic, no commitment.',
  ].join('\n');

  const hits = overRepeated(text);
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.match(hits[0], /free diagnostic/);
});

test('ordinary English is not repetition', () => {
  assert.deepEqual(overRepeated('It is on the table. It is in the room. It is at the door.'), []);
});

// --- Recap ------------------------------------------------------------------

test('an opening that is mostly recap is flagged', () => {
  // "He knows McLane has 80 DCs and 110,000 locations." Recap buys attention
  // for one line and spends it after that.
  const r = recapShare(
    [
      'McLane operates more than 80 distribution centers.',
      'McLane delivers 50,000 products to 110,000 locations.',
      'McLane opened a technology hub in Austin in August 2025.',
      'Severity scoring cannot see the calendar.',
    ].join('\n'),
    'McLane',
  );
  assert.ok(r.share > 0.5, JSON.stringify(r));
});

test('recap needs a recipient to measure against', () => {
  assert.equal(recapShare('Some sentences about nobody in particular.', ''), null);
});

// --- The document that prompted all of this ---------------------------------

test('the McLane PDF would not pass', () => {
  // The regression test for the whole module. If this document comes back
  // clean, none of the above is doing anything.
  const mclane = {
    format: 'pdf',
    disclosure: 'external_ok',
    preparedBy: 'vinil',
    audience: 'McLane',
    title: 'Your fulfillment window is your attackers’ calendar.',
    sections: [
      {
        title: 'The fulfillment network is the asset.',
        body: 'The security stack scores every alert by severity, a number that is identical in a routine week and…',
        points: ['UNFI net sales impact was $350 to $400 million from a June 2025 intrusion…'],
      },
      { title: 'The ordering that changes everything', points: [] },
      {
        title: 'A live record of consequence.',
        points: [
          'Forward Deployed Engineers run the Semantic Loop as managed support',
          'Every engagement commits to a 90-day outcome, with a bonus at risk',
        ],
      },
      { title: '7.5x: projected risk reduction from reordering the same security budget.' },
      { title: 'Cleared for customers' },
    ],
  };

  const { problems, notes } = checkExecOutreach(mclane);
  const all = [...problems, ...notes].join('\n');

  for (const expected of [
    /Semantic Loop/,
    /bonus at risk/,
    /internal clearance language/i,
    /7\.5x/,
    /end mid-sentence/,
    /trust anchor/i,
    /sender block/i,
    /changes everything/,
  ]) {
    assert.match(all, expected, `nothing caught ${expected}`);
  }

  assert.ok(problems.length >= 5, `only ${problems.length} problems: ${problems.join(' | ')}`);
});

test('a standard is named, not cited', () => {
  // "ISO 27001" and "ISO 9001" were both demanded a source, in a brief whose
  // only fault there was naming two certifications. Worse than noise: ISO
  // 27001 is one of the trust anchors this module asks outreach to include,
  // so the checker required a thing and then objected to it.
  for (const line of [
    'Vikat holds ISO 27001 and ISO 9001.',
    'Audited to SOC 2 Type 2 and aligned to NIST 800-53.',
    'Tracked as CVE 2024 and CWE 79.',
  ]) {
    assert.deepEqual(unsourcedFigures(line), [], line);
  }

  // And the rule stays narrow: a real statistic beside a standard is still
  // caught, or "ISO 27001" becomes a way to launder a number.
  assert.deepEqual(
    unsourcedFigures('ISO 27001 certified, and 40000 incidents handled last year.'),
    ['40000'],
  );
});

// --- What the checker can actually see --------------------------------------

test('the text a drawn layout puts on the page is checked too', () => {
  // Every rule in this module ran over title, body and points, and a drawn
  // layout's own fields are none of those. So a brief to the CISO of the
  // American Arbitration Association went out with four cut sentences in its
  // tiles and its split, and truncatedTails came back clean.
  //
  // spec.js builds each layout's prose fallback BEFORE normalisation and
  // cleans the layout fields separately, so the two diverge the moment a cap
  // bites: the point said "Case context ingested - docket, parties, stage"
  // while the page said "Case context ingested -". The checker was reading the
  // copy nobody sees.
  const spec = clean({
    sections: [
      {
        layout: 'tiles',
        title: '',
        body: '',
        points: ['80%: of tactical work was autonomous'],
        tiles: [
          { value: '80%', caption: 'of tactical work was autonomous. Anthropic GTG-1002,…' },
          { value: '27%', caption: 'of enterprises have a strategy' },
        ],
      },
    ],
  });

  const { problems } = checkExecOutreach(spec);
  assert.ok(
    problems.some((p) => /end mid-sentence/.test(p)),
    problems.join('\n'),
  );
});

test('a source the vendor list has never heard of still counts', () => {
  // SOURCE_NEARBY is a list of vendors, and a list of vendors is never
  // finished. It had Gartner and not Anthropic, Palo Alto or HBR — so on the
  // same brief it passed "Gartner, 2025" and flagged the other three tiles as
  // figures nobody had sourced. A checker that is wrong about a correctly
  // sourced number gets the whole report skipped, and the genuinely unsourced
  // one goes with it.
  for (const line of [
    '80%: of tactical work was autonomous. Anthropic GTG-1002, November 2025.',
    '27%: of enterprises have an advanced AI security strategy. Palo Alto and HBR, 2026',
    '31%: of filings were electronic. American Arbitration Association, 2025',
  ]) {
    assert.deepEqual(unsourcedFigures(line), [], line);
  }

  // And it stays narrow: a year in a sentence is not somebody vouching for a
  // number, or "In August 2025" becomes a way to launder one.
  assert.deepEqual(unsourcedFigures('In August 2025, McLane opened a hub and cut 40000 cases.'), ['40000']);
  assert.deepEqual(unsourcedFigures('Between 1999 and 2026 the sector consolidated to 12000 firms.'), ['12000']);
  assert.deepEqual(unsourcedFigures('7.5x: projected risk reduction from reordering the budget.'), ['7.5x']);
});

test('a number welded to a name by a hyphen is an identifier, not a statistic', () => {
  // "1002 carries an argument and no source" — the checker reading GTG-1002 as
  // a figure, on the one tile that named its source most precisely.
  // Deliberately without a year anywhere on the line: with one, cited() skips
  // the line and this passes whether or not the identifier rule exists.
  assert.deepEqual(unsourcedFigures('Tracked as GTG-1002 under the agentic framework.'), []);
  assert.deepEqual(unsourcedFigures('Tracked as CVE-2024-3400 and SP-800-53 in the register.'), []);

  // And an identifier does not launder the figures beside it.
  assert.deepEqual(
    unsourcedFigures('CVE-2024-3400 exposed 40000 records across the estate.'),
    ['40000'],
  );
});

test('a drawn figure keeps its source on the same line as its number', () => {
  // The line-scoping, running in reverse. drawnText emitted a stat's value and
  // its caption as separate lines, so "7.5x" landed alone and
  // "…rather than severity. McKinsey." landed on the next — and the checker
  // reported the best-attributed figure in the document as unattributed.
  const spec = clean({
    sections: [
      {
        layout: 'stat',
        title: '',
        body: '',
        points: [],
        value: '7.5x',
        caption: 'greater risk reduction from reordering the same security budget. McKinsey.',
      },
    ],
  });

  const { problems } = checkExecOutreach(spec);
  assert.equal(problems.filter((p) => /7\.5x/.test(p)).length, 0, problems.join('\n'));

  // And an unsourced one on a drawn figure is still caught, or this is just a
  // way of hiding numbers inside a layout.
  const bare = clean({
    sections: [
      { layout: 'stat', title: '', body: '', points: [], value: '7.5x', caption: 'greater risk reduction.' },
    ],
  });
  assert.ok(checkExecOutreach(bare).problems.some((p) => /7\.5x/.test(p)));
});

test('a draft awaiting approval is checked as customer copy', () => {
  // The document's own pages said "Draft: needs approval before it leaves
  // Vikat". Approval is the LAST gate before it leaves, which is exactly when
  // a retired phrase has to be caught.
  const withLoop = (disclosure) => {
    const spec = clean({ disclosure });
    spec.sections[0].points.push('Forward Deployed Engineers run the Semantic Loop as managed support');
    return checkExecOutreach(spec).problems.filter((p) => /Semantic Loop/.test(p)).length;
  };

  assert.equal(withLoop('needs_approval'), 1);
  assert.equal(withLoop('external_ok'), 1);
  assert.equal(withLoop('internal_only'), 0, 'an internal deal review may still say it');
});

test('a regulation listed as a certification is a problem', () => {
  // "Certifications: SOC 2 Type 2, ISO 27001, HIPAA, GDPR, ISO 9001" went to
  // the CISO of the American Arbitration Association. Two of those are not
  // certifications: HIPAA and GDPR are regulations, no body certifies anyone
  // against either, and a CISO knows that before they finish the line.
  //
  // It is also traceable. The knowledge base says "SOC 2 / GDPR / HIPAA
  // evidence generation" and "aligned to" — never that Vikat is certified in
  // them. The claim was assembled from source material that says something
  // narrower and true.
  const spec = clean();
  spec.sections[0].points = ['Certifications: SOC 2 Type 2, ISO 27001, HIPAA, GDPR, ISO 9001'];

  const { problems } = checkExecOutreach(spec);
  const hit = problems.find((p) => /certification/i.test(p));
  assert.ok(hit, problems.join('\n'));
  assert.match(hit, /HIPAA and GDPR/);
  assert.match(hit, /aligned to it, or evidence generated for it/, 'the replacement has to travel with it');
});

test('the same names are fine when the claim is the true one', () => {
  // The fault is the WORD next to the name. "Aligned to GDPR" is true and
  // "certified in GDPR" is not, and they differ by one verb on one line — so
  // this must not become a ban on naming a regulation.
  const spec = clean();
  spec.sections[0].points = [
    'Evidence generation for SOC 2, GDPR and HIPAA, aligned to NIST AI RMF.',
    'SOC 2 Type 2 and ISO 27001 certified.',
  ];
  assert.equal(
    checkExecOutreach(spec).problems.filter((p) => /listed as a certification/.test(p)).length,
    0,
    checkExecOutreach(spec).problems.join('\n'),
  );
});

test('an internal deal review is not policed for it', () => {
  const spec = clean({ disclosure: 'internal_only' });
  spec.sections[0].points = ['Certifications: SOC 2, HIPAA, GDPR'];
  assert.equal(
    checkExecOutreach(spec).problems.filter((p) => /listed as a certification/.test(p)).length,
    0,
  );
});

test('the date has to be in the ASK, not somewhere else in the copy', () => {
  // An email to Zscaler closed on "Worth 20 minutes to walk through what that
  // looks like on your infrastructure?" — which names no day at all — and this
  // rule stayed quiet, because a paragraph further up said a vulnerability
  // should be closed "before it finds it".
  //
  // Two faults in one line. `before\s+(?:the\s+)?\w+` matches ordinary English
  // ("before it", "before you"), and the whole document was searched when only
  // the ask can carry the answer. A rule satisfied by prose about something
  // else is not a rule.
  const spec = (body) => ({
    ...clean(),
    sections: [{ eyebrow: '', title: '', body, points: [] }],
  });
  const undated = (body) => checkExecOutreach(spec(body)).notes.some((n) => /no date/i.test(n));

  assert.equal(
    undated('We close the path a vulnerability could use before it finds it.\nWorth 20 minutes?'),
    true,
    'prose elsewhere must not stand in for the ask',
  );

  // And a REAL date elsewhere must not either — this is the half the tightened
  // pattern cannot catch on its own. The email named the day CISA published
  // the CVE, which is a date about the vulnerability and not an invitation.
  assert.equal(
    undated('CISA added the CVE to its catalog on September 11.\nWorth 20 minutes on your infrastructure?'),
    true,
    'a date about something else is not the ask having one',
  );

  // "before" on the ask line, and still not a date. The pattern used to be
  // `before\s+(?:the\s+)?\w+`, which matches "before you", "before it",
  // "before anything" — ordinary English doing the work of a calendar.
  assert.equal(
    undated('Worth 20 minutes to walk through this before you scale further?'),
    true,
    '"before you" is not a when',
  );

  // And a real date in the ask still passes, in the shapes a person writes.
  for (const ask of [
    'A 30-minute scoping call this week, with findings you keep either way.',
    'Thirty minutes on Thursday, and you keep the findings either way.',
    'Can we put 30 minutes in before the end of next week?',
    'Twenty minutes on September 24?',
  ]) {
    assert.equal(undated(ask), false, ask);
  }
});

test('a self-description nobody approved is a problem', () => {
  // "Vikat is the Agent Semantics Company" in one brief, "Vikat is a security
  // solutions company" in the next email — to a company that IS a security
  // solutions company. Neither line appears anywhere in this repository.
  //
  // The model is not inventing out of mischief: the prompt hands it a TAGLINE,
  // and a tagline is not a predicate you can drop into a paragraph, so it
  // writes one and writes a different one next time.
  for (const line of [
    'Vikat is a security solutions company.',
    'Vikat is the Agent Semantics Company.',
    'Vikat provides an AI-native defence platform.',
  ]) {
    const spec = clean();
    spec.sections[0].body = line;
    const hit = checkExecOutreach(spec).problems.find((p) => /not a line this company uses/.test(p));
    assert.ok(hit, `${line}: ${checkExecOutreach(spec).problems.join(' | ')}`);
    assert.match(hit, /vendor-neutral semantic context layer/, 'the real lines have to travel with it');
  }
});

test('the sanctioned wording passes, in any of its forms', () => {
  // Three real lines exist and they disagree; guidelines.js records that
  // conflict and says a deck can only open on one. Picking the winner is a
  // brand decision, not this file's — so all of them pass and only a FOURTH
  // invented on the spot is refused.
  for (const line of [
    'Vikat is the vendor-neutral semantic context layer for Sec and Dev AI agents.',
    'Vikat builds the semantic context layer for security operations.',
    'Vikat is the Personalized and Preemptive CyberSec and SRE company.',
  ]) {
    const spec = clean();
    spec.sections[0].body = line;
    assert.equal(
      checkExecOutreach(spec).problems.filter((p) => /not a line this company uses/.test(p)).length,
      0,
      line,
    );
  }
});

test('a sender block is contact details, not evidence', () => {
  // "+1 512 555 0134" was reported as an unattributed figure — on the line
  // that exists so a stranger can reply. The check asking for a source was
  // pointing at the phone number.
  assert.deepEqual(unsourcedFigures('Vinil Vadi, Head of Sales, Vikat'), []);
  assert.deepEqual(unsourcedFigures('vinil@vikat.ai | +1 512 555 0134'), []);

  // And a real figure on a line that also carries contact details is still
  // caught, or the sender block becomes a place to hide numbers.
  assert.deepEqual(
    unsourcedFigures('Call +1 512 555 0134. We handled 40000 incidents last year.'),
    ['40000'],
  );
});

test('a 30-minute overview is an ask, and a cloud platform is an anchor', () => {
  // Two misses on the same clean email. "Worth a 30-minute overview on
  // Thursday?" was not recognised as the ask — the pattern had "minutes" and
  // the text said "30-minute" — so the date check fell back to the sender
  // block and reported no date. And naming AWS, GCP and Azure, the three tools
  // the lead itself listed for the account, counted as naming nothing, because
  // the anchor list held security products only.
  const spec = clean();
  spec.sections[0].body =
    'It fits over what you already run across AWS, GCP and Azure. Worth a 30-minute overview on Thursday?';
  spec.sections[0].points = [];

  const { notes } = checkExecOutreach(spec);
  assert.ok(!notes.some((n) => /no date/i.test(n)), notes.join('\n'));
  assert.ok(!notes.some((n) => /trust anchor/i.test(n)), notes.join('\n'));

  // "minute" singular on its own, with no other ask word on the line — which
  // is what "a 30-minute slot" is, and what the plural-only pattern missed.
  //
  // And the ask is NOT the last line: a real email signs off after it. That
  // matters, because with no line recognised as an ask the check falls back to
  // the last line, and a fixture whose ask IS the last line passes whether or
  // not the pattern works.
  const singular = clean();
  singular.sections[0].body = 'Shall we book a 30-minute slot on Thursday?';
  singular.sections[0].points = ['Either way, the trends report is attached.'];
  assert.ok(
    !checkExecOutreach(singular).notes.some((n) => /no date/i.test(n)),
    checkExecOutreach(singular).notes.join('\n'),
  );
});
