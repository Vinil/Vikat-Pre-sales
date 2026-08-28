/**
 * The per-account chat list.
 *
 * The interesting half is not listing — it is that one rep can never read
 * another's conversation. These transcripts contain what a rep asked about a
 * named customer, so the isolation is the feature and the list is the garnish.
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
  ANTHROPIC_API_KEY: 'unused-by-these-routes',
};

function setup() {
  const kv = fakeKV();
  const env = { ...ENV, VIKAT_KV: kv };
  return { env, storage: createStorage(env, loadConfig(env)) };
}

const call = (env, path, { as = 'rep@vikat.ai', method = 'GET' } = {}) =>
  worker.fetch(
    new Request(`https://x.test${path}`, { method, headers: { 'X-Dev-User': as } }),
    env,
    { waitUntil() {} },
  );

// --- listing ---------------------------------------------------------------

test('a rep sees their own conversations, newest first', async () => {
  const { env, storage } = setup();

  await storage.touchChat('rep@vikat.ai', 'aaaa11112222', 'Brief me on VCommand');
  await new Promise((r) => setTimeout(r, 5));
  await storage.touchChat('rep@vikat.ai', 'bbbb33334444', 'Skan COO deck');

  const { chats } = await (await call(env, '/chats')).json();

  assert.equal(chats.length, 2);
  assert.equal(chats[0].title, 'Skan COO deck', 'most recently touched first');
  assert.equal(chats[1].title, 'Brief me on VCommand');
  assert.equal(chats[0].sessionId, 'bbbb33334444');
});

test('the list is one KV call, not one per chat', async () => {
  // The index stores its title in KV metadata precisely so list() answers
  // without a read per key. A rep with forty conversations should not cost
  // forty reads every time the sidebar renders.
  const { env, storage } = setup();
  for (let i = 0; i < 6; i += 1) {
    await storage.touchChat('rep@vikat.ai', `sess${i}0000000`, `Chat ${i}`);
  }

  // Counting CHAT reads specifically. Authenticating the request reads the
  // caller's role, which is one get and has nothing to do with the index.
  const kv = env.VIKAT_KV;
  const chatReads = [];
  const realGet = kv.get.bind(kv);
  kv.get = (key, ...rest) => {
    if (String(key).startsWith('chat:')) chatReads.push(key);
    return realGet(key, ...rest);
  };

  const { chats } = await (await call(env, '/chats')).json();

  assert.equal(chats.length, 6, 'all of them, with their titles');
  assert.ok(chats.every((c) => c.title), 'titles came from list metadata');
  assert.deepEqual(chatReads, [], 'the index must answer from list metadata alone');
});

test('a fresh rep has an empty list, not an error', async () => {
  const { env } = setup();
  const res = await call(env, '/chats');
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).chats, []);
});

// --- isolation -------------------------------------------------------------

test('a rep cannot read another rep\'s conversation', async () => {
  // The one that matters. These transcripts name customers.
  const { env, storage } = setup();
  await storage.touchChat('alice@vikat.ai', 'alice1111222', 'Acme renewal risk');
  await storage.appendLog({
    sessionId: 'alice1111222',
    userEmail: 'alice@vikat.ai',
    userMessage: 'Acme is threatening to churn',
    agentResponse: 'Here is what to say.',
  });

  const res = await call(env, '/chats/alice1111222', { as: 'bob@vikat.ai' });
  const body = await res.text();

  assert.equal(res.status, 404);
  assert.ok(!body.includes('Acme'), 'not one word of it may cross');
  assert.ok(!body.includes('churn'));
});

test("someone else's conversation is indistinguishable from one that never existed", async () => {
  // A 403 here and a 404 there is a probe: a rep could learn which session ids
  // belong to colleagues by watching which ones are merely forbidden.
  const { env, storage } = setup();
  await storage.touchChat('alice@vikat.ai', 'alice1111222', 'Acme renewal risk');

  const theirs = await call(env, '/chats/alice1111222', { as: 'bob@vikat.ai' });
  const nobodys = await call(env, '/chats/zzzz99998888', { as: 'bob@vikat.ai' });

  assert.equal(theirs.status, nobodys.status);
  assert.deepEqual(await theirs.json(), await nobodys.json());
});

test('an admin gets no special read on a colleague\'s chat', async () => {
  // Admin is a permission over configuration, not over other people's
  // conversations. Reviewing those is the audit log's job, deliberately not a
  // button in the product.
  const { env, storage } = setup();
  await storage.touchChat('alice@vikat.ai', 'alice1111222', 'Acme renewal risk');

  const res = await call(env, '/chats/alice1111222', { as: 'boss@vikat.ai' });
  assert.equal(res.status, 404);
});

test('the routes reject an anonymous caller', async () => {
  const env = {
    ...ENV,
    AUTH_MODE: 'cf-access',
    CF_ACCESS_TEAM_DOMAIN: 'vikat.cloudflareaccess.com',
    CF_ACCESS_AUD: 'a'.repeat(64),
    VIKAT_KV: fakeKV(),
  };
  const res = await worker.fetch(new Request('https://x.test/chats'), env, { waitUntil() {} });
  assert.equal(res.status, 401);
});

// --- reading and forgetting ------------------------------------------------

test('a conversation reads back as ordered turns', async () => {
  const { env, storage } = setup();
  await storage.touchChat('rep@vikat.ai', 'sess11112222', 'VShield pricing');
  await storage.appendLog({
    sessionId: 'sess11112222',
    userEmail: 'rep@vikat.ai',
    timestamp: '2026-08-27T10:00:00.000Z',
    userMessage: 'First question',
    agentResponse: 'First answer',
    toolCalls: [{ name: 'find_collateral', input: {} }],
  });
  await storage.appendLog({
    sessionId: 'sess11112222',
    userEmail: 'rep@vikat.ai',
    timestamp: '2026-08-27T10:01:00.000Z',
    userMessage: 'Second question',
    agentResponse: 'Second answer',
  });

  const body = await (await call(env, '/chats/sess11112222')).json();

  assert.equal(body.turns.length, 2);
  assert.equal(body.turns[0].userMessage, 'First question', 'oldest first, as it was said');
  assert.equal(body.turns[1].userMessage, 'Second question');
  assert.deepEqual(body.turns[0].toolCalls, ['find_collateral'], 'names only, not the inputs');
});

test('deleting a chat hides it but keeps the transcript', async () => {
  // Every conversation is logged and reviewable. A rep tidying their sidebar
  // must not be able to erase what the assistant told them.
  const { env, storage } = setup();
  await storage.touchChat('rep@vikat.ai', 'sess11112222', 'VShield pricing');
  await storage.appendLog({
    sessionId: 'sess11112222',
    userEmail: 'rep@vikat.ai',
    userMessage: 'Can I send this to a customer?',
    agentResponse: 'No.',
  });

  const res = await call(env, '/chats/sess11112222', { method: 'DELETE' });
  assert.equal(res.status, 200);

  assert.deepEqual((await (await call(env, '/chats')).json()).chats, [], 'gone from the list');

  const logs = await storage.getLogs('sess11112222');
  assert.equal(logs.length, 1, 'the transcript is retained');
  assert.equal(logs[0].agentResponse, 'No.');
});

test('a malformed id is refused before it reaches storage', async () => {
  const { env } = setup();
  const res = await call(env, '/chats/..%2Fadmin');
  assert.equal(res.status, 400);
});

// --- titles ----------------------------------------------------------------

test('the title is the first message and does not drift', async () => {
  // Named by what it was opened about. Titling from the latest turn would
  // rewrite the sidebar under the rep every time they typed.
  const { env, storage } = setup();

  await storage.touchChat('rep@vikat.ai', 'sess11112222', 'Brief me on VCommand');
  await storage.touchChat('rep@vikat.ai', 'sess11112222', 'Brief me on VCommand');

  const { chats } = await (await call(env, '/chats')).json();
  assert.equal(chats[0].title, 'Brief me on VCommand');
});

test('a long first message is trimmed rather than stored whole', async () => {
  const { env, storage } = setup();
  const meta = await storage.touchChat('rep@vikat.ai', 'sess11112222', 'x'.repeat(500));
  assert.ok(meta.title.length <= 80, `title was ${meta.title.length} characters`);
});
