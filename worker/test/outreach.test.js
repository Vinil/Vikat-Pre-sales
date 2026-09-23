/**
 * Drafts a rep can copy, and the positioning that governs what goes in them.
 *
 * Two things being held here.
 *
 * A draft is a THING, not prose. An email written into the answer text is
 * still an email, and it is also four paragraphs a rep has to select around
 * markdown and a subject line they have to find inside a sentence. So subject
 * and body travel as separate fields, survive the conversation being reopened,
 * and are trimmed to the limits the platform actually enforces.
 *
 * And positioning outranks everything. A rep can get every product fact right
 * and still lose a deal by framing Vikat as the cheap version of a competitor,
 * so the statement is injected on EVERY turn rather than retrieved on the ones
 * where a search happened to surface it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import { createStorage } from '../src/storage.js';
import { loadConfig } from '../src/config.js';
import { retrieve } from '../src/retrieve.js';
import { runTool, TOOL_DEFINITIONS } from '../src/tools.js';
import { normaliseDraft, CHANNELS, postText } from '../src/outreach.js';
import { positioningBlock, POSITIONING_KEY, POSITIONING_MAX_CHARS } from '../src/positioning.js';
import { buildSystemPrompt } from '../src/systemPrompt.js';
import { fakeKV } from './helpers.js';

const ENV = {
  AUTH_MODE: 'dev',
  ALLOW_DEV_AUTH: 'true',
  BOOTSTRAP_ADMINS: 'boss@vikat.ai',
  ALLOWED_EMAIL_DOMAINS: 'vikat.ai',
  ANTHROPIC_API_KEY: 'sk-test',
};

function setup() {
  const kv = fakeKV();
  const env = { ...ENV, VIKAT_KV: kv };
  const cfg = loadConfig(env);
  return { env, cfg, storage: createStorage(env, cfg) };
}

/** The API, stubbed: one draft_outreach call, then a line of explanation. */
function anthropicDrafting() {
  let turn = 0;

  const frames = (blocks, stopReason) => {
    const out = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}',
      '',
    ];
    blocks.forEach((block, i) => {
      out.push('event: content_block_start', `data: ${JSON.stringify({ type: 'content_block_start', index: i, content_block: block.start })}`, '');
      for (const delta of block.deltas || []) {
        out.push('event: content_block_delta', `data: ${JSON.stringify({ type: 'content_block_delta', index: i, delta })}`, '');
      }
      out.push('event: content_block_stop', `data: {"type":"content_block_stop","index":${i}}`, '');
    });
    out.push(
      'event: message_delta',
      `data: {"type":"message_delta","delta":{"stop_reason":"${stopReason}","stop_sequence":null},"usage":{"output_tokens":4}}`,
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    );
    return out.join('\n');
  };

  const INPUT = {
    channel: 'email',
    subject: 'The March ruling',
    body: 'Saw the ruling last month.\n\nWorth fifteen minutes?',
    label: 'Touch 1',
  };

  return async (url) => {
    if (!String(url).includes('api.anthropic.com')) return { ok: false, status: 404, text: async () => 'no' };

    const body =
      turn++ === 0
        ? frames(
            [
              {
                start: { type: 'tool_use', id: 'tu_1', name: 'draft_outreach', input: {} },
                deltas: [{ type: 'input_json_delta', partial_json: JSON.stringify(INPUT) }],
              },
            ],
            'tool_use',
          )
        : frames(
            [{ start: { type: 'text', text: '' }, deltas: [{ type: 'text_delta', text: 'Built on the March ruling.' }] }],
            'end_turn',
          );

    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      }),
    };
  };
}

const ctxFor = ({ storage, env, cfg }) => ({
  sessionId: 'abcd1234efgh',
  user: { email: 'rep@vikat.ai', name: 'Rep' },
  storage,
  env,
  cfg,
});

// --- the draft itself ------------------------------------------------------

test('a draft comes back as fields, not as prose to be picked apart', async () => {
  const s = setup();
  const result = await runTool(
    {
      name: 'draft_outreach',
      input: {
        channel: 'email',
        subject: 'The March fine, and the audit that follows it',
        body: 'Saw the ruling last month.\n\nWorth fifteen minutes?',
        label: 'Touch 1',
      },
    },
    ctxFor(s),
  );

  const [draft] = result.effect.drafts;
  assert.equal(draft.subject, 'The March fine, and the audit that follows it');
  assert.match(draft.body, /Worth fifteen minutes/);
  assert.equal(draft.label, 'Touch 1');
  assert.equal(draft.channelLabel, 'Email');
});

test('the model is told not to write the draft out again', async () => {
  // Without this it repeats the whole email underneath the card, and the rep
  // gets two copies of a thing they need one of — the card being the one with
  // the copy buttons.
  const s = setup();
  const result = await runTool(
    { name: 'draft_outreach', input: { channel: 'email', subject: 'S', body: 'B', label: '' } },
    ctxFor(s),
  );

  assert.match(result.content, /Do NOT repeat the draft/i);
});

test('a connection note is cut to the length LinkedIn will actually accept', async () => {
  // 300 characters is LinkedIn's own limit. A longer draft cannot be sent at
  // all, and the rep would find that out in LinkedIn rather than here.
  const long = 'x'.repeat(600);
  const read = normaliseDraft({ channel: 'linkedin_note', body: long });

  assert.equal(read.draft.body.length, 300);
  assert.ok(read.warnings.some((w) => /will not accept/i.test(w)), read.warnings.join(' '));
});

test('a post is cut at the length LinkedIn truncates at', () => {
  const read = normaliseDraft({ channel: 'linkedin_post', body: 'y'.repeat(5000) });
  assert.equal(read.draft.body.length, CHANNELS.linkedin_post.bodyChars);
});

test('a channel with no subject line does not get one', () => {
  const read = normaliseDraft({ channel: 'linkedin_note', subject: 'Ignored', body: 'Short note.' });
  assert.equal(read.draft.subject, undefined);
  assert.ok(!read.warnings.some((w) => /subject/i.test(w)), 'and is not nagged about the one it cannot have');
});

test('a missing subject costs a warning, not the draft', () => {
  // A rep writes their own subject in two seconds. Losing the body over it
  // would be the worse trade.
  const read = normaliseDraft({ channel: 'email', body: 'The body survived.' });
  assert.equal(read.ok, true);
  assert.match(read.draft.body, /survived/);
  assert.ok(read.warnings.some((w) => /subject/i.test(w)));
});

test('a draft with no body is refused', async () => {
  const s = setup();
  const result = await runTool(
    { name: 'draft_outreach', input: { channel: 'email', subject: 'Just a subject', body: '   ', label: '' } },
    ctxFor(s),
  );

  assert.equal(result.isError, true);
  assert.ok(!result.effect, 'nothing empty may reach the card');
});

test('an unknown channel falls back to email rather than failing the turn', () => {
  const read = normaliseDraft({ channel: 'carrier_pigeon', body: 'Still a usable draft.' });
  assert.equal(read.draft.channel, 'email');
});

test('the tool is offered to the model', () => {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === 'draft_outreach');
  assert.ok(tool, 'a tool the prompt describes but the request omits is how invented answers start');
  assert.deepEqual(tool.input_schema.properties.channel.enum, Object.keys(CHANNELS));
});

// --- drafts survive the conversation --------------------------------------

const SESSION = 'abcd1234efgh';
const REP = 'rep@vikat.ai';

async function recordDrafts(storage, drafts) {
  await storage.appendLog({
    sessionId: SESSION,
    userEmail: REP,
    timestamp: new Date().toISOString(),
    userMessage: 'write me a sequence',
    agentResponse: 'Three angles.',
    toolCalls: [{ name: 'draft_outreach', input: {} }],
    drafts,
  });
  await storage.touchChat(REP, SESSION, 'write me a sequence');
}

test('drafts come back when the conversation is reopened', async () => {
  const { env, storage } = setup();
  await recordDrafts(storage, [
    { channel: 'email', channelLabel: 'Email', subject: 'One', body: 'First touch.', label: 'Touch 1' },
  ]);

  const res = await worker.fetch(
    new Request(`https://x.test/chats/${SESSION}`, { headers: { 'X-Dev-User': REP } }),
    env,
    { waitUntil() {} },
  );

  const { drafts } = await res.json();
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].subject, 'One', 'the email itself, not a note that one existed');
});

test('a sequence keeps all of its touches, including near-identical ones', async () => {
  // Deliberately NOT deduped. Three touches that open the same way are still
  // three touches, and a rep sending two of them is not sending one twice.
  const { env, storage } = setup();
  await recordDrafts(storage, [
    { channel: 'email', channelLabel: 'Email', subject: 'A', body: 'Same opening line.', label: 'Touch 1' },
    { channel: 'email', channelLabel: 'Email', subject: 'A', body: 'Same opening line.', label: 'Touch 2' },
  ]);

  const res = await worker.fetch(
    new Request(`https://x.test/chats/${SESSION}`, { headers: { 'X-Dev-User': REP } }),
    env,
    { waitUntil() {} },
  );

  assert.equal((await res.json()).drafts.length, 2);
});

test('a bodyless record is dropped rather than rendered as an empty card', async () => {
  const { env, storage } = setup();
  await recordDrafts(storage, [{ channel: 'email', subject: 'Only a subject' }]);

  const res = await worker.fetch(
    new Request(`https://x.test/chats/${SESSION}`, { headers: { 'X-Dev-User': REP } }),
    env,
    { waitUntil() {} },
  );

  assert.deepEqual((await res.json()).drafts, []);
});

test('a draft written in a real turn reaches the record on its own', async () => {
  // The link every test above assumes. They seed the log directly, so nothing
  // was checking that the CHAT ROUTE writes what the turn produced — and
  // dropping the drafts on the way into appendLog left all of them passing
  // while a reopened conversation showed no email at all.
  const { env } = setup();

  const original = globalThis.fetch;
  globalThis.fetch = anthropicDrafting();
  try {
    const res = await worker.fetch(
      new Request('https://x.test/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Dev-User': REP },
        body: JSON.stringify({
          sessionId: SESSION,
          messages: [{ role: 'user', content: 'write me a first touch for Nestle' }],
        }),
      }),
      env,
      { waitUntil: (p) => p },
    );
    assert.equal(res.status, 200);
    assert.match(await res.text(), /event: draft/, 'and is streamed to the card as it happens');
  } finally {
    globalThis.fetch = original;
  }

  const res = await worker.fetch(
    new Request(`https://x.test/chats/${SESSION}`, { headers: { 'X-Dev-User': REP } }),
    env,
    { waitUntil() {} },
  );

  const { drafts } = await res.json();
  assert.equal(drafts.length, 1, 'the turn wrote an email; the record has to carry it');
  assert.match(drafts[0].body, /fifteen minutes/);
});

// --- positioning outranks the rest ----------------------------------------

test('positioning reaches every turn, not the ones a search surfaced it on', async () => {
  const { storage } = setup();
  await storage.saveSetting(
    POSITIONING_KEY,
    { content: 'We are the only platform that scores a CVE against the season it lands in.' },
    'boss@vikat.ai',
  );

  // A query with nothing to do with positioning. It must still be there.
  const block = await retrieve('what port does the collector use', { storage });
  assert.match(block, /scores a CVE against the season/);
});

test('positioning is placed ahead of the knowledge base', async () => {
  const { storage } = setup();
  await storage.saveSetting(POSITIONING_KEY, { content: 'The differentiator, stated plainly.' }, 'boss@vikat.ai');

  const block = await retrieve('anything', { storage });
  assert.ok(
    block.indexOf('<positioning') < block.indexOf('<knowledge_base'),
    'order is the whole point: what wins has to be read first',
  );
});

test('the block says it outranks the knowledge base', () => {
  const block = positioningBlock({ content: 'Something.' });
  assert.match(block, /OUTRANKS/);
  assert.match(block, /authority="highest"/);
});

test('nothing saved means nothing said', async () => {
  // The failure this prevents: a prompt describing a positioning statement
  // that does not exist, which is how the model invented a product
  // architecture once already.
  const { storage } = setup();
  const block = await retrieve('anything', { storage });

  assert.ok(!block.includes('<positioning'), block.slice(0, 200));
  assert.equal(positioningBlock(null), '');
  assert.equal(positioningBlock({ content: '   ' }), '');
});

test('the prompt tells the model which source wins', () => {
  const prompt = buildSystemPrompt(loadConfig(ENV), '<knowledge/>');
  assert.match(prompt, /positioning.*wins/is);
});

test('a KV failure costs the positioning, not the answer', async () => {
  const storage = {
    getSetting: async () => { throw new Error('KV down'); },
    listKnowledge: async () => [],
  };

  const block = await retrieve('anything', { storage });
  assert.match(block, /<knowledge_base/, 'the compiled base is still a good answer');
});

// --- the admin route ------------------------------------------------------

function adminFetch(env, method, body) {
  return worker.fetch(
    new Request('https://x.test/admin/positioning', {
      method,
      headers: { 'X-Dev-User': 'boss@vikat.ai', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    { waitUntil() {} },
  );
}

test('saving a statement makes it live on the next message', async () => {
  const { env, storage } = setup();
  const res = await adminFetch(env, 'PUT', { content: 'Seasonal risk, not severity scores.', sourceName: 'v4.pptx' });

  assert.equal(res.status, 200);
  assert.match((await res.json()).note, /leads with this/i);

  const block = await retrieve('anything', { storage });
  assert.match(block, /Seasonal risk/);
});

test('clearing it is possible, because a wrong one is worse than none', async () => {
  const { env, storage } = setup();
  await adminFetch(env, 'PUT', { content: 'Something wrong that governs every answer.' });

  const res = await adminFetch(env, 'PUT', { content: '' });
  assert.match((await res.json()).note, /Cleared/i);

  const block = await retrieve('anything', { storage });
  assert.ok(!block.includes('<positioning'));
});

test('an over-long statement is trimmed rather than allowed to eat the context', async () => {
  const { env } = setup();
  await adminFetch(env, 'PUT', { content: 'z'.repeat(POSITIONING_MAX_CHARS + 5000) });

  const { content } = await (await adminFetch(env, 'GET')).json();
  assert.equal(content.length, POSITIONING_MAX_CHARS);
});

test('GET reports who saved it and when', async () => {
  const { env } = setup();
  await adminFetch(env, 'PUT', { content: 'The statement.', sourceName: 'Positioning_v4.pptx' });

  const body = await (await adminFetch(env, 'GET')).json();
  assert.equal(body.updatedBy, 'boss@vikat.ai');
  assert.ok(body.updatedAt);
  assert.equal(body.sourceName, 'Positioning_v4.pptx');
});

test('a rep cannot read or change the positioning statement', async () => {
  const { env } = setup();
  const res = await worker.fetch(
    new Request('https://x.test/admin/positioning', { headers: { 'X-Dev-User': 'rep@vikat.ai' } }),
    env,
    { waitUntil() {} },
  );
  assert.equal(res.status, 403);
});

test('a draft is a choice unless it says otherwise', () => {
  // The safe default. A rep who reads three alternatives as three posts has
  // written less than they meant to; one who reads a campaign as a choice
  // sends less. The second mistake is recoverable next turn, the first is not.
  assert.equal(normaliseDraft({ channel: 'email', body: 'x', subject: 's' }).draft.group, 'versions');
  assert.equal(normaliseDraft({ channel: 'email', body: 'x', subject: 's', group: 'nonsense' }).draft.group, 'versions');
  assert.equal(normaliseDraft({ channel: 'email', body: 'x', subject: 's', group: 'sequence' }).draft.group, 'sequence');
});

// --- what came back from the model, and what a rep must never be handed ----

test('tool markup that leaked into an argument never reaches the card', () => {
  // A real draft came back with its label reading `</parameter> <parameter
  // name="group">versions` — the markup that separates one argument from the
  // next, ending up INSIDE one. It rendered on the card exactly as written,
  // because nothing between the model and the DOM looked at it.
  const r = normaliseDraft({
    channel: 'email',
    label: '</antml,parameter> <parameter name="group">versions',
    subject: 'BerryGPT is live',
    body: 'A real paragraph.',
  });

  assert.equal(r.draft.label, 'Email', 'a label that is markup falls back to the channel');
  assert.ok(!/parameter|antml|invoke/i.test(JSON.stringify(r.draft)), JSON.stringify(r.draft));
  assert.ok(r.warnings.some((w) => /tool markup/i.test(w)), 'and the rep is told');
});

test('markup in the body is stripped and flagged, not silently kept', () => {
  const r = normaliseDraft({
    channel: 'email',
    label: 'Touch 1',
    subject: 'A subject',
    body: 'The offer stands.</parameter><parameter name="group">sequence',
  });

  assert.ok(!/parameter/i.test(r.draft.body), r.draft.body);
  assert.match(r.draft.body, /The offer stands\./);
  assert.ok(r.warnings.some((w) => /tool markup/i.test(w)));
});

test('a draft carries no em dashes, and keeps its paragraph breaks', () => {
  // §2.3 bans them in customer-facing copy, and a draft is the MOST
  // customer-facing thing here — it goes out under the rep's own name. Decks
  // were cleaned and drafts were not, which is backwards.
  const r = normaliseDraft({
    channel: 'email',
    label: 'Touch 1',
    subject: 'BerryGPT is live — who governs what it can reach?',
    // The last dash sits at the END of a line. That is the case that matters:
    // a rewrite matching \s around the dash eats the newlines after it and
    // the two paragraphs become one. Mid-line dashes pass either way, which
    // is why the first fixture here proved nothing.
    body: 'We preempt early — not fast.\n\nA second paragraph —\n\nAnd a third.',
  });

  assert.ok(!/[—–]/.test(r.draft.subject), r.draft.subject);
  assert.ok(!/[—–]/.test(r.draft.body), r.draft.body);
  assert.equal(
    (r.draft.body.match(/\n\n/g) || []).length,
    2,
    `both paragraph breaks must survive: ${JSON.stringify(r.draft.body)}`,
  );
});


test('a product name from the positioning statement is left alone', () => {
  // A check here once flagged "Semantic Context Graph" as invented, on the
  // strength of a grep that found it nowhere in this repo. It is in the
  // POSITIONING STATEMENT, which lives in KV and is uploaded through the
  // admin panel — a grep of the repo could never have found it, and the
  // conclusion drawn from that grep was wrong.
  //
  // Nothing here knows what the positioning statement says, so nothing here
  // gets to rule on what is or is not one of our names. The positioning
  // statement is injected on every turn and outranks the knowledge base;
  // that is where this belongs and it already works.
  const r = normaliseDraft({
    channel: 'email',
    label: 'Touch 1',
    subject: 'A subject',
    body: 'Vikat builds a Semantic Context Graph of your enterprise and your business.',
  });

  assert.deepEqual(r.warnings, [], JSON.stringify(r.warnings));
  assert.match(r.draft.body, /Semantic Context Graph/);
});

test('markup in the label alone still raises the warning', () => {
  // looksMalformed() is called twice against the same string: once to decide
  // whether to blank the label, once to decide whether to warn. `.test()` on
  // a /g regex resumes from lastIndex, so without a reset the SECOND call
  // returns false and the label is silently blanked with nothing said.
  //
  // Every other fixture here puts markup in one field and checks one thing,
  // which is why this went unnoticed: it is the second question about the
  // same string that gets the wrong answer.
  const r = normaliseDraft({
    channel: 'email',
    label: 'Touch 1 <parameter name="group">versions',
    subject: 'A clean subject',
    body: 'A clean body.',
  });

  assert.equal(r.draft.label, 'Email', 'the label was markup and must not be kept');
  assert.ok(
    r.warnings.some((w) => /tool markup/i.test(w)),
    `blanked the label and said nothing: ${JSON.stringify(r.warnings)}`,
  );
});

// --- LinkedIn posts -------------------------------------------------------

const POST = {
  channel: 'linkedin_post',
  subject: '',
  label: 'Acquisition announcement',
  group: 'versions',
  headline: 'NEWS: we acquired the patent behind instrument-to-cloud test data',
  body: 'At the centre of this is the IP for test data moving from the field to the cloud.\n\nFor customers, that means fewer manual handoffs.',
  hashtags: '#TestData, #Automation #Automation OT/ICS!! #A #B #C #D',
  imageBrief: 'An engineer in hi-vis at a server rack, blue and green light, wide landscape.',
};

test('a post carries its four parts separately', () => {
  const { draft } = normaliseDraft(POST);

  assert.equal(draft.channel, 'linkedin_post');
  assert.match(draft.headline, /^NEWS: we acquired/);
  assert.match(draft.body, /fewer manual handoffs/);
  assert.match(draft.imageBrief, /hi-vis at a server rack/);
  // A rep copies these into four different places, so they must not be one
  // string they have to cut up.
  assert.ok(!draft.body.includes(draft.headline));
  assert.ok(!draft.body.includes('#TestData'));
});

test('hashtags are normalised however the model wrote them', () => {
  const { draft } = normaliseDraft(POST);

  // Commas, doubled hashes and punctuation are not information.
  assert.deepEqual(draft.hashtags.slice(0, 3), ['#TestData', '#Automation', '#Automation']);
  assert.ok(draft.hashtags.every((t) => /^#[A-Za-z0-9]+$/.test(t)), draft.hashtags.join(' '));
  // Five is the ceiling: more reads as spam.
  assert.equal(draft.hashtags.length, 5);
});

test('the 3000 covers the whole post, not the body alone', () => {
  // A body just inside the limit plus a headline and tags is over it, and the
  // rep finds that out in the composer with the text already pasted.
  const { draft, warnings } = normaliseDraft({
    ...POST,
    body: 'x'.repeat(2990),
  });

  assert.ok(postText(draft).length > 3000);
  assert.ok(
    warnings.some((w) => /together, over/.test(w)),
    JSON.stringify(warnings),
  );
});

test('postText joins in published order', () => {
  const { draft } = normaliseDraft(POST);
  const whole = postText(draft);

  assert.ok(whole.indexOf(draft.headline) === 0, 'the headline is the first line or nobody reads it');
  assert.ok(whole.indexOf(draft.body) > 0);
  assert.ok(whole.indexOf('#TestData') > whole.indexOf(draft.body), 'tags go last');
});

test('the other channels gain nothing from the new fields', () => {
  // They are required on the schema, so the model sends empty strings. An
  // email that grows a headline row would be a regression in the common case.
  const { draft } = normaliseDraft({
    channel: 'email',
    subject: 'A subject',
    body: 'A body.',
    label: '',
    group: 'versions',
    headline: 'should be ignored',
    hashtags: '#Nope',
    imageBrief: 'a photo',
  });

  assert.equal(draft.headline, undefined);
  assert.equal(draft.hashtags, undefined);
  assert.equal(draft.imageBrief, undefined);
});

test('a draft is read for how it sounds, not only for how long it is', () => {
  // "Every time a content request goes out" covers an email and a post as much
  // as a two-pager, and an email is the one a rep sends soonest and edits
  // least. checkArticulation was wired to nothing when this was written — the
  // module that answers "would a reader think a machine wrote this" had never
  // run on anything at all.
  const { warnings } = normaliseDraft({
    channel: 'email',
    subject: 'When a matter leaks, the proceeding fails',
    body: 'I hope this finds you well. We can help you leverage a robust, seamless approach.',
  });

  const said = warnings.join(' | ');
  assert.match(said, /film trailer/, `the subject line was not read:\n${said}`);
  assert.match(said, /Reads as generated/, said);

  // And a plain draft still comes back clean, or the warning list stops being
  // read at all.
  // A clean cold email has to NAME us early — the reader has never heard of
  // Vikat, and this fixture did not, which is the rule arriving after the
  // test was written rather than the test being wrong.
  const clean = normaliseDraft({
    channel: 'email',
    subject: 'Thirty minutes on your alert queue',
    body: 'You run Splunk and CrowdStrike. Vikat builds the semantic context layer that reads what they already produce and ranks it by what each finding can reach today. A 30-minute call this week, and you keep the findings either way.',
  });
  assert.deepEqual(clean.warnings, [], clean.warnings.join(' | '));
});

test('a cold email that never says who is writing is flagged', () => {
  // The prospect has never heard of Vikat. The email to Zscaler ran three
  // paragraphs — a CVE, a hiring signal, a claim about what their SIEM cannot
  // do — before the sender was named at all. A stranger reads all of that
  // asking "who is this and why is it in my inbox", and nothing answers until
  // they have already decided.
  const late = normaliseDraft({
    channel: 'email',
    subject: 'Your GitLab is on the exploited list',
    body: [
      "Your GitLab is on CISA's exploited list as of Friday.",
      'Your own job postings name it.',
      'An advisory names the flaw, not which instance sits near something critical.',
      'That is a context question.',
      'Vikat builds the semantic context layer for security operations.',
    ].join(' '),
  });
  assert.ok(
    late.warnings.some((w) => /not named until sentence 5/.test(w)),
    late.warnings.join(' | '),
  );

  const never = normaliseDraft({
    channel: 'email',
    subject: 'Your GitLab is on the exploited list',
    body: "Your GitLab is on CISA's exploited list as of Friday. Worth a look this week?",
  });
  assert.ok(never.warnings.some((w) => /Nothing here says who is writing/.test(w)));

  // Named in the first three sentences, and the note goes away.
  const early = normaliseDraft({
    channel: 'email',
    subject: 'Your GitLab is on the exploited list',
    body: "Your GitLab is on CISA's exploited list as of Friday. Vikat builds the semantic context layer for security operations, so we see which instance sits near something critical. Twenty minutes on Thursday?",
  });
  assert.ok(!early.warnings.some((w) => /who is writing|not named until/.test(w)), early.warnings.join(' | '));
});

test('a subject line is not stapled to the body to make one long sentence', () => {
  // A subject has no full stop, so a sentence splitter runs straight through
  // it into the body and calls the two of them one sentence. Found by this
  // rule firing on a draft that opened in 22 words and was reported as 31 —
  // the missing nine being the subject.
  const { warnings } = normaliseDraft({
    channel: 'email',
    subject: 'Your GitLab is on the CISA exploited list as of Friday',
    body:
      'Your GitLab is on the known-exploited list as of Friday, and your own postings name it. ' +
      'Vikat builds the semantic context layer for security operations. Twenty minutes on Thursday?',
  });

  assert.ok(
    !warnings.some((w) => /opening sentence is/.test(w)),
    warnings.join(' | '),
  );

  // And a genuinely long body opener is still caught, subject or no subject.
  const long = normaliseDraft({
    channel: 'email',
    subject: 'Quick one',
    body:
      'The AI security hires you are making right now, engineers working in Go, Rust and Python on ' +
      'agent security, point at a question about what Model Context Protocol in production means. ' +
      'Vikat builds the semantic context layer. Twenty minutes on Thursday?',
  });
  assert.ok(long.warnings.some((w) => /opening sentence is 3\d words/.test(w)), long.warnings.join(' | '));
});

test('a customer we may not name is refused even when the name is right there', () => {
  // The hard part of a descriptor-only reference is not saying the descriptor.
  // It is that the real name is already in the assistant's context from
  // somewhere else — Skan.ai is in the knowledge base, because the public
  // website names it as technology Vikat builds on — so "never work out which
  // company the descriptor points at" is an instruction competing with a fact
  // the model can see.
  //
  // An instruction cannot be relied on there. This is the part that does not
  // depend on the model cooperating.
  const forbidden = ['Reiter Affiliated', 'Reiter', 'Skan', 'Skan.ai'];

  const leaked = normaliseDraft(
    {
      channel: 'email',
      subject: 'What we did at Reiter Affiliated',
      body: 'Vikat did this for Reiter Affiliated last year. Twenty minutes on Thursday?',
    },
    { forbidden },
  );
  assert.ok(leaked.warnings.some((w) => /may not be named/.test(w)), leaked.warnings.join(' | '));
  assert.match(leaked.warnings[0], /Reiter/, 'and it leads, because it is somebody else’s confidence');

  // The descriptor is the whole permission, and it passes.
  const described = normaliseDraft(
    {
      channel: 'email',
      subject: 'A hand with the CVE, and a report either way',
      body: 'Vikat did this for the world’s largest berry producer. Twenty minutes on Thursday?',
    },
    { forbidden },
  );
  assert.ok(!described.warnings.some((w) => /may not be named/.test(w)), described.warnings.join(' | '));
});

test('a name that is not on the list is nobody’s business', () => {
  // The check must not become a general ban on proper nouns. Only what the
  // approved references explicitly mark.
  const { warnings } = normaliseDraft(
    {
      channel: 'email',
      subject: 'Your GitLab is on the exploited list',
      body: 'Vikat reads what Splunk and CrowdStrike already produce. Twenty minutes on Thursday?',
    },
    { forbidden: ['Reiter Affiliated'] },
  );
  assert.ok(!warnings.some((w) => /may not be named/.test(w)), warnings.join(' | '));
});
