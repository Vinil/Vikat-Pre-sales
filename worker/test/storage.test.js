import test from 'node:test';
import assert from 'node:assert/strict';

import { createStorage } from '../src/storage.js';
import { loadConfig } from '../src/config.js';
import { fakeKV } from './helpers.js';

const cfg = loadConfig({});

function setup() {
  const kv = fakeKV();
  return { kv, storage: createStorage({ VIKAT_KV: kv }, cfg) };
}

test('createStorage fails loudly when the KV binding is missing', () => {
  assert.throws(() => createStorage({}, cfg), /VIKAT_KV/);
});

// --- leads ----------------------------------------------------------------

test('saveLead persists under a timestamped key and returns an id', async () => {
  const { kv, storage } = setup();
  const { id } = await storage.saveLead({ name: 'Ada', email: 'ada@example.com' });

  assert.match(id, /^lead_[a-f0-9]{16}$/);
  const keys = [...kv._store.keys()];
  assert.equal(keys.length, 1);
  assert.ok(keys[0].startsWith('lead:'));
  assert.ok(keys[0].endsWith(id));

  const stored = JSON.parse(kv._raw(keys[0]));
  assert.equal(stored.name, 'Ada');
  assert.equal(stored.id, id);
  assert.ok(stored.createdAt);
});

test('listLeads returns newest first', async () => {
  const { storage } = setup();
  await storage.saveLead({ name: 'first' });
  await new Promise((r) => setTimeout(r, 2));
  await storage.saveLead({ name: 'second' });

  const leads = await storage.listLeads();
  assert.equal(leads.length, 2);
  assert.equal(leads[0].name, 'second');
});

// --- sessions -------------------------------------------------------------

test('getSession returns null for an unknown session', async () => {
  const { storage } = setup();
  assert.equal(await storage.getSession('nope'), null);
});

test('saveSession round-trips through getSession', async () => {
  const { storage } = setup();
  await storage.saveSession('sess-1234abcd', { lead: { name: 'Ada' }, turns: 3 });
  const s = await storage.getSession('sess-1234abcd');
  assert.equal(s.lead.name, 'Ada');
  assert.equal(s.turns, 3);
});

// --- logs -----------------------------------------------------------------

test('appendLog writes one entry per turn, retrievable by session', async () => {
  const { storage } = setup();
  await storage.appendLog({
    sessionId: 's1',
    timestamp: '2026-01-01T00:00:00.000Z',
    userMessage: 'hello',
    agentResponse: 'hi',
    toolCalls: [],
  });
  await storage.appendLog({
    sessionId: 's1',
    timestamp: '2026-01-01T00:01:00.000Z',
    userMessage: 'more',
    agentResponse: 'sure',
    toolCalls: [{ name: 'capture_lead', input: {} }],
  });
  await storage.appendLog({
    sessionId: 's2',
    timestamp: '2026-01-01T00:00:30.000Z',
    userMessage: 'other session',
    agentResponse: 'ok',
    toolCalls: [],
  });

  const logs = await storage.getLogs('s1');
  assert.equal(logs.length, 2, 'only this session');
  assert.equal(logs[0].userMessage, 'hello', 'chronological order');
  assert.equal(logs[1].toolCalls[0].name, 'capture_lead');
});

test('appendLog stamps a timestamp when the caller omits one', async () => {
  const { storage } = setup();
  await storage.appendLog({ sessionId: 's1', userMessage: 'x', agentResponse: 'y', toolCalls: [] });
  const [log] = await storage.getLogs('s1');
  assert.ok(Date.parse(log.timestamp) > 0);
});

// --- rate limiting --------------------------------------------------------

test('checkRateLimit allows up to the limit then blocks', async () => {
  const { storage } = setup();
  for (let i = 1; i <= 3; i++) {
    const r = await storage.checkRateLimit('1.2.3.4', 3, 600);
    assert.ok(r.allowed, `request ${i} should be allowed`);
    assert.equal(r.remaining, 3 - i);
  }

  const blocked = await storage.checkRateLimit('1.2.3.4', 3, 600);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.resetAt > Date.now());
});

test('checkRateLimit counts each key independently', async () => {
  const { storage } = setup();
  await storage.checkRateLimit('1.1.1.1', 1, 600);
  assert.equal((await storage.checkRateLimit('1.1.1.1', 1, 600)).allowed, false);
  assert.equal((await storage.checkRateLimit('2.2.2.2', 1, 600)).allowed, true);
});

test('checkRateLimit starts a fresh window once the old one expires', async () => {
  const { kv, storage } = setup();
  await storage.checkRateLimit('1.2.3.4', 1, 600);
  assert.equal((await storage.checkRateLimit('1.2.3.4', 1, 600)).allowed, false);

  // Simulate the window having elapsed.
  kv._seed('rate:1.2.3.4', JSON.stringify({ count: 1, resetAt: Date.now() - 1000 }));
  const r = await storage.checkRateLimit('1.2.3.4', 1, 600);
  assert.equal(r.allowed, true, 'expired window resets the counter');
});

test('checkRateLimit tolerates a corrupt counter record', async () => {
  const { kv, storage } = setup();
  kv._seed('rate:1.2.3.4', JSON.stringify({ nonsense: true }));
  const r = await storage.checkRateLimit('1.2.3.4', 5, 600);
  assert.equal(r.allowed, true);
  assert.equal(r.remaining, 4);
});
