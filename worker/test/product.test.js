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
import { createDocument } from '../src/documents/index.js';
import { normaliseSpec } from '../src/documents/spec.js';
import { loadFonts } from '../src/documents/fonts.js';
import { wrap } from '../src/documents/measure.js';
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

test('the Engineering house rules carry its headline and none of the CyberSec positioning', () => {
  const p = withTools(ENGINEERING);
  const rules = house(p);

  // The line its deck carries, as the security rules quote the line theirs
  // carries. The whole definition is in the persona already; quoted here as
  // fixed, it handed the model a dash the house copy check flags in any deck.
  assert.ok(rules.includes(`**Positioning is fixed.** "${ENGINEERING_HEADLINE}"`));
  assert.ok(!rules.includes(ENGINEERING.definition), 'the whole definition, dash and all');
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

test('with no headline there is no "Positioning is fixed" to quote, and no lead-in for it', () => {
  // The lead-in announces a quoted line. With nothing to quote it read
  // "**Positioning is fixed.**" and then the solutions-company sentences, as
  // if they were the fixed line.
  for (const definition of ['', ' ! ']) {
    const rules = house(withTools({ ...ENGINEERING, definition }));
    assert.doesNotMatch(rules, /Positioning is fixed/, JSON.stringify(definition));
    assert.match(rules, /\n\nVikat is a SOLUTIONS company, not a tool company/, 'and the paragraph is otherwise whole');
    assert.match(rules, /working in tandem with what you already own/);
  }
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
  assert.doesNotMatch(rules, /`## kpi [|^]/, 'an example of the slide the same rules say the deck has none of');

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

function deck(product, spec = {}) {
  const parsed = normaliseSpec({
    format: 'pptx',
    title: 'Release faster at Northwind',
    audience: 'Northwind',
    disclosure: 'internal_only',
    content: DECK,
    ...spec,
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

test('a short name or headline counts as a word, not as letters inside one', () => {
  // "ai" is in "certain", and "lab" in "available". Matched as text, a short
  // name or headline let any invented line through that happened to spell it.
  const product = { ...ENGINEERING, name: 'Lab', definition: 'AI: delivery teams' };
  for (const line of ['Vikat is a certain kind of company.', 'Vikat is the most available partner.']) {
    assert.equal(selfDescribed(outreach(line), { product }).length, 1, line);
  }

  // Said as words they still count, and so does a name with a symbol at its
  // edge, where a plain \b would never match.
  const plus = { ...ENGINEERING, name: 'C++', definition: '' };
  for (const [line, named] of [
    ['Vikat is an AI company.', product],
    ['Vikat is the company behind Lab.', product],
    ['Vikat is the company behind C++, for teams.', plus],
  ]) {
    assert.equal(selfDescribed(outreach(line), { product: named }).length, 0, line);
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

// --- The cover and the close, whatever the headline ---------------------------
//
// The instruction set's line is one line, and both slides were laid out for
// it. Another product's line is its definition's headline: the text before the
// first colon, which is the whole definition when there is no colon, up to the
// 600 characters the portal allows.
//
// inspectPptx cannot see this go wrong. A one-line box at a fixed height sits
// inside the slide and overlaps nothing; it is the TEXT in it that runs over
// "prepared by" and the disclaimer. So these measure the words against the
// box as well as the boxes against each other.

/** A definition with no colon in it, so all of it is the headline: about 340 characters. */
const NO_COLON_LONG =
  'Engineering capacity from Vikat for software companies and digital teams, covering product ' +
  'development, QA automation, DevOps and cloud, and AI and agentic-AI engineering, delivered as ' +
  'projects or as dedicated teams that work inside the customer’s own sprint cadence, tooling and code ' +
  'review, with named engineers and a delivery lead reporting weekly.';

/** The longest title and subtitle the spec takes, which push the cover line furthest down. */
const CROWDED = {
  title: 'Northwind ships every two weeks and spends most of each sprint waiting on regression tests',
  subtitle:
    'Most of the release cycle is spent waiting on a regression run that nobody owns and nobody can ' +
    'shorten without help from outside the team, sprint after sprint.',
};

/** Where the footer row starts (the disclosure line). It is laid out on its own and is not checked here. */
const FOOTER_TOP = 6.9;

/**
 * The boxes on a slide, in inches: each text box and picture above the
 * footer, and the artwork (the wave) as one box around all of its bars.
 */
function layoutOf(xml) {
  const boxes = [];
  let art = null;
  for (const [shape] of xml.matchAll(/<p:(sp|pic)>[\s\S]*?<\/p:\1>/g)) {
    const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(shape);
    const ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(shape);
    if (!off || !ext) continue;
    const [x, y, w, h] = [off[1], off[2], ext[1], ext[2]].map((n) => Number(n) / 914400);
    const words = textOf(shape);
    const picture = shape.startsWith('<p:pic>');

    if (w >= 13 && h >= 7) continue; // the ground
    if (!words && !picture) {
      const [left, top] = art ? [Math.min(art.x, x), Math.min(art.y, y)] : [x, y];
      const [right, bottom] = art ? [Math.max(art.x + art.w, x + w), Math.max(art.y + art.h, y + h)] : [x + w, y + h];
      art = { x: left, y: top, w: right - left, h: bottom - top };
      continue;
    }
    if (y >= FOOTER_TOP) continue;

    const size = /sz="(\d+)"/.exec(shape);
    const spacing = /<a:spcPct val="(\d+)"\/>/.exec(shape);
    boxes.push({
      words: words || 'the lockup',
      picture,
      x, y, w, h,
      size: size ? Number(size[1]) / 100 : 0,
      lineHeight: spacing ? Number(spacing[1]) / 100000 : 0,
    });
  }
  return { boxes, art };
}

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * No box runs into another, into the wave or into the footer.
 *
 * On the cover the lockup is left out of the pairs: the eyebrow is set inside
 * the clear space its picture box carries, on every deck, product or none.
 */
function assertApart(xml, label, { lockup = true } = {}) {
  const { boxes, art } = layoutOf(xml);
  const checked = boxes.filter((b) => lockup || !b.picture);
  for (const [i, a] of checked.entries()) {
    for (const b of checked.slice(i + 1)) {
      assert.ok(!overlap(a, b), `${label}: "${a.words.slice(0, 30)}" runs into "${b.words.slice(0, 30)}"`);
    }
    if (art) assert.ok(!overlap(a, art), `${label}: "${a.words.slice(0, 30)}" runs into the wave`);
    assert.ok(a.y + a.h <= FOOTER_TOP, `${label}: "${a.words.slice(0, 30)}" runs into the footer`);
  }
}

/** The box that carries this line, checked to be tall enough for it: the words, not just the box. */
function lineBox(xml, line, label) {
  const box = layoutOf(xml).boxes.find((b) => b.words === line);
  if (!box) return null;
  const body = loadFonts().metrics.body;
  const lines = wrap(line, body, box.size, box.w * 72).length;
  const needs = (lines * box.size * box.lineHeight * body.naturalLineHeight) / 72;
  assert.ok(needs <= box.h + 0.005, `${label}: ${lines} line(s) need ${needs.toFixed(2)}in, the box is ${box.h.toFixed(2)}in`);
  return box;
}

test('the cover and the close keep the line inside its box and apart, however long the headline', () => {
  for (const [label, definition] of [
    ['the Engineering definition', ENGINEERING.definition],
    ['no colon, about 200 characters', ENGINEERING.definition.replace(':', ',')],
    ['no colon, about 340 characters', NO_COLON_LONG],
    ['no colon, 600 characters', `${NO_COLON_LONG} ${NO_COLON_LONG}`.slice(0, 600)],
    ['an empty definition', ''],
  ]) {
    const headline = definitionHeadline(definition);
    for (const spec of [{}, CROWDED]) {
      const built = slides(deck({ ...ENGINEERING, definition }, spec));
      const [cover, close] = [built[0], built.at(-1)];
      const where = `${label}${spec.title ? ', crowded cover' : ''}`;

      assertApart(cover, `cover, ${where}`, { lockup: false });
      assertApart(close, `close, ${where}`);

      // Set whole or not at all, and on both slides or neither.
      const onCover = Boolean(headline && lineBox(cover, headline, `cover, ${where}`));
      const onClose = Boolean(headline && lineBox(close, headline, `close, ${where}`));
      assert.equal(onCover, onClose, `${where}: on the cover ${onCover}, on the close ${onClose}`);
    }
  }
});

test('a headline that fits is set, and the close grows it into the room the tagline leaves', () => {
  // The two that fit the cover. The one with no colon is three lines of the
  // narrower close, which the close's one-line box never held.
  for (const definition of [ENGINEERING.definition, ENGINEERING.definition.replace(':', ',')]) {
    const headline = definitionHeadline(definition);
    for (const spec of [{}, CROWDED]) {
      const built = slides(deck({ ...ENGINEERING, definition }, spec));
      const close = built.at(-1);
      const line = lineBox(close, headline, 'close');
      assert.ok(line, `the close has no line for ${JSON.stringify(definition.slice(0, 40))}`);
      assert.ok(lineBox(built[0], headline, 'cover'), 'and the cover has it too');

      // Its foot is where the one-line box's foot always was, so "prepared by"
      // and the disclaimer block under it have not moved.
      assert.ok(Math.abs(line.y + line.h - 4.12) < 0.01, `the line ends at ${line.y + line.h}`);
      const by = layoutOf(close).boxes.find((b) => b.words === 'rep@vikat.ai');
      assert.ok(Math.abs(by.y - 4.34) < 0.01, `"prepared by" moved to ${by.y}`);
    }
  }
});

test('a headline too long for a cover goes on neither the cover nor the close', () => {
  const definition = `${NO_COLON_LONG} ${NO_COLON_LONG}`.slice(0, 600);
  const built = slides(deck({ ...ENGINEERING, definition }));
  assert.ok(!built.map(textOf).join(' ').includes(definition.slice(0, 60)), 'a paragraph was set as a cover line');
  assert.ok(textOf(built.at(-1)).includes('VIKAT  ENGINEERING'), 'the close is still the close');
});

// --- What the rep is told about the deck ---------------------------------------

test('a suite slide an Engineering deck leaves out is out of the count and the checks, and said', async () => {
  // The renderer leaves the suite deep dive out of another product's deck.
  // Everything else read the spec: the result counted the slide, and the
  // checks reported on words that were never drawn, so the rep could be told
  // about a slide that is not in the file.
  const cfg = loadConfig({});
  const storage = createStorage({ VIKAT_KV: fakeKV() }, cfg);
  const content = [
    '## context | Where the release time goes',
    'Most of the cycle is spent waiting for a test run.',
    '',
    '## suite ^ The detail | SecSemantic | Where the kill time goes | Kill time: the Semantic Loop cuts it before first use',
    '',
    '## stat | 40 | percent of the sprint spent on regression',
    'From the team’s own sprint reports.',
  ].join('\n');
  const build = (product) =>
    createDocument(
      { format: 'pptx', title: 'Release faster at Northwind', audience: 'Northwind', disclosure: 'external_ok', content },
      {
        storage,
        user: { email: 'rep@vikat.ai', name: 'Rep' },
        env: {},
        cfg,
        fonts: loadFonts(),
        product,
        isoDate: '2026-10-16T00:00:00.000Z',
      },
    );

  const today = await build(null);
  assert.equal(today.ok, true, today.error);
  assert.equal(today.sections, 3);
  assert.match(today.inspection, /"Semantic Loop" is retired/, 'the control: the check reads a drawn suite slide');
  assert.doesNotMatch(today.inspection, /left out/);

  const engineering = await build(ENGINEERING);
  assert.equal(engineering.ok, true, engineering.error);
  assert.equal(engineering.sections, 2, 'the count is what was drawn');
  assert.doesNotMatch(engineering.inspection, /Semantic Loop/, 'a check read a slide that is not in the file');
  assert.match(
    engineering.inspection,
    /The suite slide "Where the kill time goes" was left out: the suite deep dive belongs to the security line, and this is a Vikat Engineering deck\./,
  );
});

test('a headline left off the cover and the close is said, exactly when it is left off', async () => {
  // A cover without its line is a shorter cover, and nothing may write a
  // shorter line in its place. Left off in silence, though, neither the model
  // nor the rep knows the deck has no positioning line, or why, and nobody
  // tells whoever owns the definition.
  const cfg = loadConfig({});
  const storage = createStorage({ VIKAT_KV: fakeKV() }, cfg);
  const build = (product, format = 'pptx') =>
    createDocument(
      {
        format,
        title: 'Release faster at Northwind',
        audience: 'Northwind',
        disclosure: 'external_ok',
        content: '## context | Where the release time goes\nMost of the cycle is spent waiting for a test run.',
      },
      {
        storage,
        user: { email: 'rep@vikat.ai', name: 'Rep' },
        env: {},
        cfg,
        fonts: loadFonts(),
        product,
        isoDate: '2026-10-16T00:00:00.000Z',
      },
    );
  const said = /The headline of the Vikat Engineering definition was left off the cover and the close/;

  // Either side of the limit, the note is there exactly when the cover has no line.
  const both = { on: 0, off: 0 };
  for (const definition of [
    ENGINEERING.definition,
    ENGINEERING.definition.replace(':', ','),
    NO_COLON_LONG,
    `${NO_COLON_LONG} ${NO_COLON_LONG}`.slice(0, 600),
  ]) {
    const result = await build({ ...ENGINEERING, definition });
    assert.equal(result.ok, true, result.error);
    const stored = await storage.getDocument(result.id);
    const cover = slides(new Uint8Array(stored.bytes))[0];
    const onCover = layoutOf(cover).boxes.some((b) => b.words === definitionHeadline(definition));
    assert.equal(said.test(result.inspection), !onCover, `${definition.length} characters, on the cover ${onCover}`);
    both[onCover ? 'on' : 'off'] += 1;
  }
  assert.ok(both.on && both.off, `both sides of the limit: ${JSON.stringify(both)}`);

  // Nothing to say where nothing was left off, or where nothing is branded.
  const long = { ...ENGINEERING, definition: `${NO_COLON_LONG} ${NO_COLON_LONG}`.slice(0, 600) };
  for (const [label, result] of [
    ['no product', await build(null)],
    ['SecSemantic', await build(SECSEMANTIC)],
    ['a pdf', await build(long, 'pdf')],
    ['a docx', await build(long, 'docx')],
  ]) {
    assert.equal(result.ok, true, `${label}: ${result.error}`);
    assert.doesNotMatch(result.inspection, /left off the cover/, label);
  }
});
