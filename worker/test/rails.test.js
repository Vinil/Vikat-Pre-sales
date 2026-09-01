/**
 * What a conversation produced, still there when the rep comes back.
 *
 * Assets used to exist only as an SSE event held in the browser's memory. A
 * refresh, a switch to another chat, or reopening one later and the rail was
 * empty next to a transcript that plainly showed a deck being built. The turn
 * knows what it produced, so the record of the turn has to carry it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import { createStorage } from '../src/storage.js';
import { loadConfig } from '../src/config.js';
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
  return { env, storage: createStorage(env, loadConfig(env)) };
}

const SESSION = 'abcd1234efgh';
const REP = 'rep@vikat.ai';

/** Put a turn in the record the way the chat route does. */
async function record(storage, { assets, message = 'build me a deck', at }) {
  await storage.appendLog({
    sessionId: SESSION,
    userEmail: REP,
    timestamp: at || new Date().toISOString(),
    userMessage: message,
    agentResponse: 'Here it is.',
    toolCalls: [{ name: 'create_document', input: {} }],
    assets,
  });
  await storage.touchChat(REP, SESSION, message);
}

function getChat(env, id = SESSION) {
  return worker.fetch(
    new Request(`https://x.test/chats/${id}`, { headers: { 'X-Dev-User': REP } }),
    env,
    { waitUntil() {} },
  );
}

/**
 * The API, stubbed: one create_document call, then an answer.
 *
 * Deliberately drives the real tool rather than a fake one — the asset has to
 * come out of the tool's own effect, which is where production gets it.
 */
function anthropicBuilding() {
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

  const DOC = {
    title: 'Harvest window risk',
    format: 'pdf',
    disclosure: 'internal_only',
    content:
      '## context | Why a harvest window changes severity\n' +
      'Agricultural operations concentrate risk into a few weeks a year, and severity scoring has never known that.\n\n' +
      '## stat | 265 | attacks on food and agriculture in 2025',
  };

  return async (url, init) => {
    if (!String(url).includes('api.anthropic.com')) {
      // No Graph in this test: the document is built and served from KV, and
      // failing to file it is a note on the answer, not a failure of the turn.
      return { ok: false, status: 403, text: async () => 'no graph' };
    }

    const body =
      turn++ === 0
        ? frames(
            [
              {
                start: { type: 'tool_use', id: 'tu_1', name: 'create_document', input: {} },
                deltas: [{ type: 'input_json_delta', partial_json: JSON.stringify(DOC) }],
              },
            ],
            'tool_use',
          )
        : frames([{ start: { type: 'text', text: '' }, deltas: [{ type: 'text_delta', text: 'Built it.' }] }], 'end_turn');

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

const DECK = {
  kind: 'generated',
  name: 'Nestle_Brief.pptx',
  url: '/documents/abc123',
  disclosure: 'Internal only',
  sharePointUrl: 'https://vikatai.sharepoint.com/x/Nestle_Brief.pptx',
};

const FOUND = {
  kind: 'collateral',
  name: 'Vikat_DevSemantic_CTO_Short.pptx',
  url: 'https://vikatai.sharepoint.com/x/DevSemantic.pptx',
  folder: 'CISO',
};

test('a document built in a past turn is still listed when the chat is reopened', async () => {
  const { env, storage } = setup();
  await record(storage, { assets: [DECK] });

  const res = await getChat(env);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.assets.length, 1, 'the rail is fed from here; empty means the rep sees nothing');
  assert.deepEqual(body.assets[0], DECK, 'and with everything the card needs, not just a name');
});

test('assets from every turn of the conversation come back together', async () => {
  const { env, storage } = setup();
  await record(storage, { assets: [FOUND], at: '2026-01-01T10:00:00.000Z' });
  await record(storage, { assets: [DECK], at: '2026-01-01T10:05:00.000Z' });

  const { assets } = await (await getChat(env)).json();
  assert.deepEqual(
    assets.map((a) => a.name).sort(),
    [DECK.name, FOUND.name].sort(),
    'the rail shows the conversation, not just its last turn',
  );
});

test('the same document surfaced three times is one row', async () => {
  const { env, storage } = setup();
  await record(storage, { assets: [FOUND], at: '2026-01-01T10:00:00.000Z' });
  await record(storage, { assets: [FOUND, DECK], at: '2026-01-01T10:05:00.000Z' });
  await record(storage, { assets: [FOUND], at: '2026-01-01T10:09:00.000Z' });

  const { assets } = await (await getChat(env)).json();
  assert.equal(assets.length, 2);
});

test('a conversation that produced nothing returns an empty list, not an error', async () => {
  const { env, storage } = setup();
  await record(storage, { assets: undefined, message: 'what is our pricing' });

  const res = await getChat(env);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).assets, []);
});

test('an asset with no url is dropped rather than rendered as a dead card', async () => {
  const { env, storage } = setup();
  await record(storage, { assets: [{ kind: 'generated', name: 'Half a record' }, DECK] });

  const { assets } = await (await getChat(env)).json();
  assert.deepEqual(assets, [DECK]);
});

test('a document built in a real turn reaches the record on its own', async () => {
  // The link the other tests here assume: they seed the log directly, so
  // nothing was checking that the CHAT ROUTE actually writes what the turn
  // produced. Dropping the assets on the way into appendLog left every one of
  // them passing and the rail empty in production.
  const { env } = setup();

  const original = globalThis.fetch;
  globalThis.fetch = anthropicBuilding();
  try {
    const chat = await worker.fetch(
      new Request('https://x.test/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Dev-User': REP },
        body: JSON.stringify({
          sessionId: SESSION,
          messages: [{ role: 'user', content: 'build me a one pager on harvest risk' }],
        }),
      }),
      env,
      { waitUntil: (p) => p },
    );
    assert.equal(chat.status, 200);
    await chat.text();
  } finally {
    globalThis.fetch = original;
  }

  const { assets } = await (await getChat(env)).json();
  assert.equal(assets.length, 1, 'the turn built a document; the record has to say so');
  assert.equal(assets[0].kind, 'generated');
  assert.match(assets[0].url, /^\/document\//, assets[0].url);
});

test('assets are not readable from someone else’s conversation', async () => {
  // The ownership check has to cover this route the same as the transcript —
  // a deck name can carry an account name.
  const { env, storage } = setup();
  await record(storage, { assets: [DECK] });

  const res = await worker.fetch(
    new Request(`https://x.test/chats/${SESSION}`, { headers: { 'X-Dev-User': 'someone@vikat.ai' } }),
    env,
    { waitUntil() {} },
  );

  assert.equal(res.status, 404);
});
