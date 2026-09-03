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
import { normaliseDraft, CHANNELS } from '../src/outreach.js';
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
