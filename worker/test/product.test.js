/**
 * The product a rep is selling, when the page around the assistant says so.
 *
 * Vikat sells more than one thing. The portal knows which one a rep is on and
 * now says so in a structured form; Vinil's own deployment never does. So the
 * first thing pinned here is that NOT saying so changes nothing: the prompt is
 * byte for byte the one 55d72a5 built, and the deck and the checks are the
 * ones the rest of this suite already holds them to.
 *
 * The second is the failure this exists to stop. Without it, an Engineering
 * rep asking for a deck gets "VIKAT  CYBERSEC" on every slide, "Personalized
 * and Preemptive CyberSec and SRE." on the cover and the suite wordmarks under
 * it, because the assistant has only ever been told it works for a security
 * company.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

import { buildSystemPrompt, systemBlocks } from '../src/systemPrompt.js';
import {
  brandFor, WORDMARK_TAG, POSITIONING_LINE, DECK_TAGLINE, WHO_WE_ARE,
} from '../src/documents/house.js';
import { renderPptx } from '../src/documents/pptx.js';
import { normaliseSpec } from '../src/documents/spec.js';
import { loadFonts } from '../src/documents/fonts.js';
import { checkExecOutreach } from '../src/execOutreach.js';
import { definitionHeadline } from '../src/product.js';
import { runTool } from '../src/tools.js';
import { createStorage } from '../src/storage.js';
import { loadConfig } from '../src/config.js';
import { fakeKV } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');

/** What the portal sends: the products row's name and description, and its line. */
const ENGINEERING = {
  key: 'vikat-engineering',
  name: 'Vikat Engineering',
  definition:
    'Engineering capacity from Vikat for software companies and digital teams: product development, ' +
    'QA automation, DevOps and cloud, and AI and agentic-AI engineering — delivered as projects or ' +
    'dedicated teams.',
  line: 'engineering',
};

const SECSEMANTIC = {
  key: 'secsemantic',
  name: 'SecSemantic',
  definition:
    "We turn a customer's technical and business data, with their input, into a personalized, living " +
    'Cyber-Business Twin of their assets, business processes, dependencies, business value and operating ' +
    'context, and use that Twin to recognize and help prevent business-impacting cyber risk while ' +
    'calculating, explaining, prioritizing and verifying risk reduction.',
  line: 'security',
};

/** The headline the Engineering deck carries: the definition up to its first colon. */
const ENGINEERING_HEADLINE = 'Engineering capacity from Vikat for software companies and digital teams.';

// A literal config rather than loadConfig(): the pin is on the prompt, and a
// changed default elsewhere is not a change to it.
const CFG = { INTERNAL_HELP_CHANNEL: '#sales-help', WEB_SEARCH_MAX_USES: 5, WEB_RESEARCH: 'on' };
const KB = '<knowledge_base>\n</knowledge_base>';

const withTools = (product) =>
  buildSystemPrompt(CFG, KB, {}, { toolsAvailable: true, webAvailable: true, product });
const withoutTools = (product) =>
  buildSystemPrompt(CFG, KB, {}, { toolsAvailable: false, webAvailable: false, product });

/** One section of the prompt, from its heading to the next one named. */
function section(prompt, from, to) {
  const start = prompt.indexOf(from);
  assert.ok(start >= 0, `no "${from}" in the prompt`);
  const end = prompt.indexOf(to, start + from.length);
  assert.ok(end > start, `no "${to}" after "${from}"`);
  return prompt.slice(start, end);
}

const house = (prompt) => section(prompt, '# Building a deck: the house rules', '# Style');
const app = (prompt) => section(prompt, '# What this tool is, when a rep asks', '# Researching a prospect');

// --- No product: today, byte for byte ----------------------------------------

test('with no product the prompt is the 55d72a5 prompt, byte for byte', () => {
  // The fixtures are the unchanged build's own output, written before this
  // change. A deliberate edit to the prompt later updates them in the same
  // commit; an accidental one is what this test is for.
  for (const product of [undefined, null]) {
    assert.equal(withTools(product), fixture('prompt-55d72a5-tools.txt'), `tools, product ${product}`);
    assert.equal(withoutTools(product), fixture('prompt-55d72a5-no-tools.txt'), `no tools, product ${product}`);
  }
});

test('with no product the deck brand is the instruction set', () => {
  for (const product of [undefined, null, SECSEMANTIC]) {
    assert.deepEqual(brandFor(product), {
      tag: WORDMARK_TAG,
      positioningLine: POSITIONING_LINE,
      deckTagline: DECK_TAGLINE,
      suite: true,
      whoWeAre: WHO_WE_ARE,
    });
  }
});

// --- Prompt caching ------------------------------------------------------------

test('the cached block is the same on every turn for one product, and only it is cached', () => {
  // The stable block now differs by product, which is a cache entry per
  // product rather than one for everybody. It must still be one entry per
  // product: a byte that moves between turns re-writes the whole prefix.
  const rep = { email: 'rep@vikat.ai', name: 'Rep' };
  const a = systemBlocks(CFG, KB, { user: rep, turnCount: 1 }, { product: ENGINEERING });
  const b = systemBlocks(CFG, KB, { user: rep, turnCount: 9 }, { product: ENGINEERING });

  assert.equal(a[0].text, b[0].text);
  assert.deepEqual(a[0].cache_control, { type: 'ephemeral' });
  assert.equal(a[1].cache_control, undefined, 'the breakpoint belongs on the first block only');
  assert.match(a[1].text, /<current_user>/);

  assert.notEqual(a[0].text, systemBlocks(CFG, KB, { user: rep })[0].text, 'the product is in the cached part');
});

// --- An Engineering conversation ---------------------------------------------

test('an Engineering persona names the product and its definition, and no security company', () => {
  const p = withTools(ENGINEERING);

  assert.match(p, /internal sales assistant for Vikat, a company that sells several products\./);
  assert.ok(p.includes(`In this conversation the rep is selling Vikat Engineering: ${ENGINEERING.definition}`));
  assert.match(p, /Speak about Vikat Engineering in its own terms and do not describe it as a security offering\./);
  assert.doesNotMatch(p, /security and data platform/);
  assert.match(p, /do not reason by analogy from other products/);
  assert.doesNotMatch(p, /other security products/);
});

test('the Engineering house rules carry its definition and none of the CyberSec positioning', () => {
  const p = withTools(ENGINEERING);
  const rules = house(p);

  assert.ok(rules.includes(`**Positioning is fixed.** "${ENGINEERING.definition}"`));
  assert.doesNotMatch(p, /Personalized and Preemptive CyberSec/);
  assert.doesNotMatch(p, /Earlier beats faster/i);
  assert.doesNotMatch(p, /how early/i, 'the tagline restated is still the tagline');

  // The solutions-company sentences are Vikat's, not the security line's.
  assert.match(rules, /Vikat is a SOLUTIONS company, not a tool company/);
  assert.match(rules, /Never\s+rip and replace/);
  assert.match(rules, /working in tandem with what you already own/);

  // DevSemantic is still SRE. DevOps is also a real area of this product.
  assert.match(rules, /DevOps to describe\s+DevSemantic \(it is SRE\)/);
  assert.match(rules, /"DevOps" is the right word for the DevOps & Cloud area of Vikat Engineering/);

  assert.doesNotMatch(rules, /CISO or an SRE lead/);
  assert.match(rules, /split it\. The test is reading it aloud/);

  assert.doesNotMatch(rules, /UNFI|dwell/, 'the sourced figures listed are security figures');
  assert.match(rules, /Only sourced figures\. Any modeled figure/, 'the rule on sourced numbers stays');
  assert.match(rules, /No pricing figures in writing, ever/);

  assert.doesNotMatch(rules, /SCP, DCP/);
  assert.match(rules, /\*\*KPIs\.\*\* Format is `metric: target`, never prose/);
  assert.match(rules, /ending with a full\s+stop\. Never cryptic internal framing/);
});

test('the Engineering deck rules leave out the suite and the security examples', () => {
  const p = withTools(ENGINEERING);
  const rules = app(p);

  // Each security passage is gone, and what replaced it is there: a pair whose
  // left side stopped matching would leave the first true and the second not.
  assert.match(rules, /Do not add a `## suite` slide/);
  assert.doesNotMatch(rules, /SecSemantic and DevSemantic only/);

  assert.doesNotMatch(rules, /Our commitment · CyberSec/);
  assert.match(rules, /`## Our commitment \| The headline, as a sentence\.`/);

  assert.doesNotMatch(rules, /MTTP/);
  assert.match(rules, /a Vikat Engineering deck has no `## kpi` slide/);

  assert.doesNotMatch(rules, /5,750 SRE cases/);
  assert.match(rules, /a Vikat Engineering deck does not use them/);

  assert.doesNotMatch(rules, /the tagline, the suite wordmarks/);
  assert.match(rules, /with the opening of the Vikat Engineering definition/);

  // And with all of that gone, nothing in the prompt says CyberSec at all.
  assert.doesNotMatch(p, /CyberSec/);
});

test('an Engineering conversation without tools still names the product', () => {
  // The degradation ladder drops the tools, and the deck rules with them. The
  // product is in the persona, which every rung keeps.
  const p = withoutTools(ENGINEERING);
  assert.ok(p.includes('In this conversation the rep is selling Vikat Engineering:'));
  assert.doesNotMatch(p, /security and data platform/);
});

// --- A security product ------------------------------------------------------

test('a SecSemantic persona names it, and everything after the opening is today', () => {
  for (const build of [withTools, withoutTools]) {
    const p = build(SECSEMANTIC);
    const today = build(null);

    const [opening, ...rest] = p.split('\n');
    assert.match(opening, /a company that sells several products\. In this conversation the rep is selling SecSemantic: We turn/);
    assert.doesNotMatch(opening, /security and data platform|security offering/);
    assert.equal(rest.join('\n'), today.split('\n').slice(1).join('\n'), 'the house rules and the rest are as today');
  }
});

// --- The deck ----------------------------------------------------------------

const DECK = [
  '## context | Where the release time goes',
  'Most of the cycle is spent waiting for a test run.',
  '',
  '## suite ^ The detail | SecSemantic | Where the kill time goes | Kill time: cut before first use',
  '',
  '## stat | 40 | percent of the sprint spent on regression',
  'From the team’s own sprint reports.',
].join('\n');

function deck(product) {
  const parsed = normaliseSpec({
    format: 'pptx',
    title: 'Release faster at Northwind',
    audience: 'Northwind',
    disclosure: 'internal_only',
    content: DECK,
  });
  assert.equal(parsed.ok, true, parsed.error);
  return renderPptx(
    parsed.spec,
    { preparedBy: 'rep@vikat.ai', isoDate: '2026-10-16', product },
    loadFonts().metrics,
  );
}

function slides(bytes) {
  const files = unzipSync(bytes);
  return Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]))
    .map((n) => strFromU8(files[n]));
}

const textOf = (xml) => [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(' ');

test('an Engineering deck is tagged Engineering on every slide and says CyberSec nowhere', () => {
  const bytes = deck(ENGINEERING);
  const built = slides(bytes);

  for (const [i, slide] of built.entries()) {
    assert.ok(textOf(slide).includes('VIKAT  ENGINEERING'), `slide ${i + 1} has no Engineering tag`);
  }

  const everything = Object.values(unzipSync(bytes)).map((f) => strFromU8(f)).join('\n');
  assert.doesNotMatch(everything, /CYBERSEC|CyberSec/);
  assert.doesNotMatch(everything, /Earlier beats faster/);
});

test('an Engineering deck has its own cover line, no suite and no suite slide', () => {
  const built = slides(deck(ENGINEERING));
  const cover = built[0];

  assert.ok(textOf(cover).includes(ENGINEERING_HEADLINE), 'the cover line is the definition headline');
  assert.doesNotMatch(cover, /<a:t>Sec<\/a:t>|<a:t>Dev<\/a:t>|<a:t>Pro<\/a:t>/, 'suite wordmarks on the cover');

  assert.ok(!built.some((s) => textOf(s).includes('Where the kill time goes')), 'the suite slide was drawn');
  assert.ok(!built.some((s) => textOf(s).includes('VIKAT  SECSEMANTIC')));

  // Cover, two sections, who we are, thank you; the page numbers agree.
  assert.equal(built.length, 5);
  assert.ok(textOf(built[1]).includes('2 / 5'));
  assert.ok(textOf(built[3]).includes('4 / 5'));

  const who = textOf(built[3]);
  assert.ok(who.includes(WHO_WE_ARE.title));
  assert.ok(who.includes(WHO_WE_ARE.points[0]) && who.includes(WHO_WE_ARE.points[1]));
  assert.doesNotMatch(who, /back into the graph/, 'the graph point belongs to the security line');

  const close = textOf(built[4]);
  assert.ok(close.includes(ENGINEERING_HEADLINE));
});

test('a SecSemantic deck, and a deck with no product, are today’s deck', () => {
  const today = deck(undefined);
  assert.deepEqual(deck(null), today);
  assert.deepEqual(deck(SECSEMANTIC), today);
  assert.ok(textOf(slides(today)[0]).includes(DECK_TAGLINE));
});

// --- The outreach check ------------------------------------------------------

const outreach = (line) => ({
  format: 'pdf',
  disclosure: 'external_ok',
  preparedBy: 'Vinil Vadi, Head of Sales, vinil@vikat.ai, +1 512 555 0134',
  audience: 'Northwind',
  title: 'Your release train is your roadmap.',
  sections: [
    {
      title: 'Waiting on tests sets the pace of a release.',
      body: line,
      points: ['Runs alongside GitHub Actions and Jira. Nothing is ripped out.'],
    },
  ],
});

const selfDescribed = (spec, opts) =>
  checkExecOutreach(spec, opts).problems.filter((p) => /not a line this company uses/.test(p));

test('an Engineering "Vikat is" line passes with the product and fails without it', () => {
  for (const line of [
    'Vikat is the company behind Vikat Engineering.',
    'Vikat is the partner for engineering capacity from Vikat for software companies and digital teams.',
  ]) {
    assert.equal(selfDescribed(outreach(line), { product: ENGINEERING }).length, 0, line);
    assert.equal(selfDescribed(outreach(line)).length, 1, `${line} (no product)`);
  }
});

test('with a product, an invented line is still refused, and pointed at the product', () => {
  const [hit] = selfDescribed(outreach('Vikat is a security solutions company.'), { product: ENGINEERING });
  assert.ok(hit, 'an invented self-description passed because a product was named');
  assert.ok(hit.includes(ENGINEERING_HEADLINE), 'the line to use is the product’s own');
  assert.doesNotMatch(hit, /CyberSec/, 'an Engineering document is not sent to the CyberSec line');
});

// --- The tool --------------------------------------------------------------

test('create_document builds for the product in the tool context', async () => {
  const cfg = loadConfig({});
  const storage = createStorage({ VIKAT_KV: fakeKV() }, cfg);
  const user = { email: 'rep@vikat.ai', name: 'Rep' };
  const input = {
    format: 'pptx',
    title: 'Release faster at Northwind',
    audience: 'Northwind',
    disclosure: 'external_ok',
    content: `## context | Where the release time goes\nVikat is the company behind Vikat Engineering.`,
  };

  const build = async (product) => {
    const result = await runTool(
      { name: 'create_document', input },
      { sessionId: 's', user, storage, env: {}, cfg, fonts: loadFonts(), messages: [], product },
    );
    assert.ok(!result.isError, result.content);
    const stored = await storage.getDocument(result.effect.assets[0].url.split('/').pop());
    return { result, words: slides(new Uint8Array(stored.bytes)).map(textOf).join(' ') };
  };

  const engineering = await build(ENGINEERING);
  assert.ok(engineering.words.includes('VIKAT  ENGINEERING'));
  assert.doesNotMatch(engineering.result.content, /not a line this company uses/, 'the check saw the product too');

  const none = await build(undefined);
  assert.ok(none.words.includes(WORDMARK_TAG));
  assert.match(none.result.content, /not a line this company uses/);
});

// --- What does not count as a product ----------------------------------------

test('a product with no name is no product', () => {
  // Every sentence written for a product names it. With a blank name they
  // read "the rep is selling ." and "Use the name .", so a blank name means
  // what no product means: the prompt, the deck and the check as they were.
  const line = 'Vikat is the company behind Vikat Engineering.';
  for (const blank of [
    { ...ENGINEERING, name: '' },
    { ...ENGINEERING, name: '   ' },
    { ...ENGINEERING, name: undefined },
    { ...ENGINEERING, name: 42 },
  ]) {
    const label = JSON.stringify(blank.name);
    assert.equal(withTools(blank), fixture('prompt-55d72a5-tools.txt'), `tools, name ${label}`);
    assert.equal(withoutTools(blank), fixture('prompt-55d72a5-no-tools.txt'), `no tools, name ${label}`);
    assert.deepEqual(brandFor(blank), brandFor(null), `brand, name ${label}`);
    assert.deepEqual(deck(blank), deck(null), `deck, name ${label}`);
    assert.deepEqual(
      checkExecOutreach(outreach(line), { product: blank }),
      checkExecOutreach(outreach(line)),
      `outreach, name ${label}`,
    );
  }
});

// --- The headline ----------------------------------------------------------

test('a headline ends in one full stop, whatever it ended in', () => {
  // "Ship faster!." on a cover is the writer's line with a typo added, and the
  // house copy check then flags the deck for the exclamation point.
  for (const [definition, headline] of [
    ['Ship faster!: QA automation and DevOps', 'Ship faster.'],
    ['Ship faster?', 'Ship faster.'],
    ['Ship faster…: QA automation', 'Ship faster.'],
    ['Ship faster!?. : QA automation', 'Ship faster.'],
    ['Ship faster', 'Ship faster.'],
    ['Engineering capacity from Vikat for software companies and digital teams: product development', ENGINEERING_HEADLINE],
    ['', ''],
    [' ! ', ''],
  ]) {
    assert.equal(definitionHeadline(definition), headline, JSON.stringify(definition));
  }

  const cover = textOf(slides(deck({ ...ENGINEERING, definition: 'Ship faster!' }))[0]);
  assert.ok(cover.includes('Ship faster.') && !cover.includes('!'), cover);
});
