import test from 'node:test';
import assert from 'node:assert/strict';

import { rankDocuments, searchCollateral, collateralCount } from '../src/collateral.js';
import { runTool } from '../src/tools.js';
import { COLLATERAL } from '../src/knowledge.js';
import { createStorage } from '../src/storage.js';
import { loadConfig } from '../src/config.js';
import { fakeKV } from './helpers.js';
import worker from '../src/index.js';

/** A stand-in corpus. Newest first, as the build emits it. */
const DOCS = [
  {
    name: 'VShield Pricing 2026.pptx',
    summary: 'List pricing and discount bands for VShield across all editions.',
    webUrl: 'https://vikat.sharepoint.com/x/VShield%20Pricing%202026.pptx',
    folder: 'Pricing',
    modified: '2026-08-01T10:00:00Z',
    page: 'sharepoint/Pricing/VShield Pricing 2026.pptx',
  },
  {
    name: 'MCP Server Security Overview.pptx',
    summary: 'How Vikat secures Model Context Protocol servers in enterprise deployments.',
    webUrl: 'https://vikat.sharepoint.com/x/MCP.pptx',
    folder: 'Solutions',
    modified: '2026-07-14T10:00:00Z',
    page: 'sharepoint/Solutions/MCP Server Security Overview.pptx',
  },
  {
    name: 'Phase One Rollout Notes.docx',
    summary: 'Notes from the first phase of a customer rollout, including timelines.',
    webUrl: 'https://vikat.sharepoint.com/x/Phase.docx',
    folder: 'Delivery',
    modified: '2026-02-02T10:00:00Z',
    page: 'sharepoint/Delivery/Phase One Rollout Notes.docx',
  },
];

// --- rankDocuments --------------------------------------------------------

test('an empty query returns everything in source order', () => {
  const r = rankDocuments(DOCS, '');
  assert.equal(r.length, 3);
  assert.equal(r[0].name, DOCS[0].name, 'newest first, as built');
});

test('an empty query still honours an explicit limit', () => {
  assert.equal(rankDocuments(DOCS, '   ', { limit: 2 }).length, 2);
});

test('a name match outranks a summary match', () => {
  const r = rankDocuments(DOCS, 'pricing');
  assert.equal(r[0].name, 'VShield Pricing 2026.pptx');
});

test('every term must match, not just one', () => {
  // "pricing" alone matches the VShield deck; "kubernetes" matches nothing.
  assert.deepEqual(rankDocuments(DOCS, 'pricing kubernetes'), []);
});

test('terms may match across different fields of the same document', () => {
  const r = rankDocuments(DOCS, 'solutions mcp');
  assert.equal(r.length, 1);
  assert.equal(r[0].folder, 'Solutions');
});

test('a whole-word hit outranks the same term inside a longer word', () => {
  // "phase" contains no whole-word "mcp", but a substring match on a shorter
  // term is exactly the case that must not win. Use a term both share.
  const docs = [
    { name: 'Phased Migration.docx', summary: '', folder: '', modified: null, webUrl: 'u1' },
    { name: 'Phase Gate Review.docx', summary: '', folder: '', modified: null, webUrl: 'u2' },
  ];
  const r = rankDocuments(docs, 'phase');
  assert.equal(r[0].name, 'Phase Gate Review.docx', 'the whole word wins');
  assert.equal(r.length, 2, 'the substring match still matches');
});

test('a query of nothing but single characters is treated as no query', () => {
  // One letter is not enough to rank on, and a rep mid-type should see the
  // full list rather than an arbitrary slice of it.
  assert.equal(rankDocuments(DOCS, 'a').length, DOCS.length);
  assert.equal(rankDocuments(DOCS, '- /').length, DOCS.length);
});

test('a single character does not widen a real query', () => {
  const r = rankDocuments(DOCS, 'a pricing');
  assert.equal(r.length, 1);
  assert.equal(r[0].name, 'VShield Pricing 2026.pptx');
});

test('search is case- and punctuation-insensitive', () => {
  const r = rankDocuments(DOCS, 'VSHIELD, pricing!');
  assert.equal(r[0].name, 'VShield Pricing 2026.pptx');
});

test('a regex metacharacter in the query does not throw', () => {
  assert.doesNotThrow(() => rankDocuments(DOCS, 'c++ (v1.0) [draft] a*'));
});

test('results are capped', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    name: `Pricing deck ${i}.pptx`,
    summary: '',
    folder: '',
    modified: null,
    webUrl: `u${i}`,
  }));
  assert.equal(rankDocuments(many, 'pricing').length, 25, 'default limit');
  assert.equal(rankDocuments(many, 'pricing', { limit: 5 }).length, 5);
});

test('ranking does not mutate the corpus it is given', () => {
  const before = DOCS.map((d) => d.name);
  rankDocuments(DOCS, 'pricing');
  rankDocuments(DOCS, '');
  assert.deepEqual(DOCS.map((d) => d.name), before);
});

// --- the compiled corpus --------------------------------------------------

test('searchCollateral reads the compiled index', () => {
  assert.equal(collateralCount(), COLLATERAL.length);
  assert.ok(Array.isArray(searchCollateral('')));
});

test('every compiled document carries a link, which is the whole point', () => {
  for (const d of COLLATERAL) {
    assert.ok(d.webUrl, `${d.name} has no webUrl and should not have been compiled in`);
    assert.match(d.webUrl, /^https:\/\//, `${d.name} has a non-https link`);
  }
});

// --- find_collateral ------------------------------------------------------

const ctx = {
  sessionId: 'test1234abcd',
  user: { email: 'rep@vikat.ai', name: 'Rep' },
  storage: null,
  env: {},
  cfg: { INTERNAL_HELP_CHANNEL: '#sales-assistant' },
};

test('an unsynced library reads as a setup problem, not a gap in the collateral', async () => {
  // The compiled corpus is empty in tests, which is exactly the state a
  // deployment is in before the first sync runs. Saying "no deck covers that"
  // then sends a rep hunting for material that was never indexed, and hides a
  // broken sync behind what looks like a content gap.
  assert.equal(collateralCount(), 0, 'this test describes the empty-index case');

  const r = await runTool(
    { name: 'find_collateral', input: { query: 'zzzz nonexistent quantum toaster' } },
    ctx,
  );

  assert.ok(!r.isError);
  assert.equal(r.effect.reason, 'nothing_indexed');
  assert.match(r.content, /sync/i);
  assert.match(r.content, /do not describe documents you have not seen/i);
});

test('an empty query is a browse request, not a malformed search', async () => {
  // "What collateral do we have?" is a real question, and the answer is a
  // list. Requiring a search term turned it into a refusal.
  const r = await runTool({ name: 'find_collateral', input: { query: '   ' } }, ctx);
  assert.ok(!r.isError, 'a blank query must be answered, not rejected');
  assert.equal(r.effect.query, '');
});

test('find_collateral does not need storage, so it cannot fail on a KV outage', async () => {
  // storage is null above; a handler that reached for it would throw here and
  // be caught into an isError result.
  const r = await runTool({ name: 'find_collateral', input: { query: 'anything' } }, ctx);
  assert.ok(!r.isError);
});

// --- GET /collateral ------------------------------------------------------

const ENV = {
  AUTH_MODE: 'dev',
  ALLOW_DEV_AUTH: 'true',
  BOOTSTRAP_ADMINS: 'boss@vikat.ai',
  VIKAT_KV: fakeKV(),
  ANTHROPIC_API_KEY: 'not-used-by-this-route',
};

const get = (init = {}) =>
  worker.fetch(new Request('https://x.test/collateral', init), ENV, { waitUntil() {} });

test('/collateral refuses an unauthenticated request', async () => {
  const res = await worker.fetch(
    new Request('https://x.test/collateral'),
    {
      ...ENV,
      AUTH_MODE: 'cf-access',
      CF_ACCESS_TEAM_DOMAIN: 'vikat.cloudflareaccess.com',
      CF_ACCESS_AUD: 'a'.repeat(64),
    },
    { waitUntil() {} },
  );
  assert.equal(res.status, 401, 'no Access assertion, so no identity');
});

test('/collateral refuses to serve when dev auth is half-configured', async () => {
  // AUTH_MODE=dev without ALLOW_DEV_AUTH is a deployment mistake, not a
  // sign-in problem: 503, so it reads as broken rather than as "log in again".
  const res = await worker.fetch(
    new Request('https://x.test/collateral'),
    { ...ENV, ALLOW_DEV_AUTH: 'false' },
    { waitUntil() {} },
  );
  assert.equal(res.status, 503);
});

test('/collateral serves the index to a signed-in rep', async () => {
  const res = await get({ headers: { 'X-Dev-User': 'rep@vikat.ai' } });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.ok(Array.isArray(body.documents));
  assert.equal(body.total, collateralCount());
});

test('/collateral filters on ?q', async () => {
  const res = await worker.fetch(
    new Request('https://x.test/collateral?q=nothing-matches-this-xyzzy', {
      headers: { 'X-Dev-User': 'rep@vikat.ai' },
    }),
    ENV,
    { waitUntil() {} },
  );
  assert.deepEqual((await res.json()).documents, []);
});

test('/collateral is never cached publicly — it is internal material', async () => {
  const res = await get({ headers: { 'X-Dev-User': 'rep@vikat.ai' } });
  const cc = res.headers.get('cache-control') || '';
  assert.match(cc, /private/);
  assert.ok(!/public/.test(cc));
});

test('/collateral rejects a write', async () => {
  const res = await get({ method: 'POST', headers: { 'X-Dev-User': 'rep@vikat.ai' } });
  assert.equal(res.status, 405);
});

test('/collateral refuses a user whose role is denied', async () => {
  const cfg = loadConfig(ENV);
  const kv = fakeKV();
  const storage = createStorage({ VIKAT_KV: kv }, cfg);
  await storage.saveUser('gone@vikat.ai', 'denied', 'boss@vikat.ai');

  const res = await worker.fetch(
    new Request('https://x.test/collateral', { headers: { 'X-Dev-User': 'gone@vikat.ai' } }),
    { ...ENV, VIKAT_KV: kv },
    { waitUntil() {} },
  );
  assert.equal(res.status, 403);
});
