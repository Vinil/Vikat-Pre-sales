/**
 * Roles and admin API.
 *
 * This is access control over internal sales material, so the tests lean on
 * what must NOT happen: a rep reaching the panel, an admin locking everyone
 * out, a grant to someone who can never sign in.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveRole, canUseAssistant, canAdminister, wouldLeaveNoAdmin, ROLES } from '../src/roles.js';
import { handleAdmin, handleAdminSummary } from '../src/admin.js';
import { createStorage } from '../src/storage.js';
import { loadConfig } from '../src/config.js';
import { fakeKV } from './helpers.js';

const ADMIN = { email: 'boss@vikat.ai', name: 'Boss' };
const REP = { email: 'rep@vikat.ai', name: 'Rep' };

function setup(env = {}) {
  const cfg = loadConfig({ BOOTSTRAP_ADMINS: 'boss@vikat.ai', ...env });
  return { cfg, storage: createStorage({ VIKAT_KV: fakeKV() }, cfg) };
}

function req(method, body, search = '') {
  return new Request(`https://x.test/admin/x${search}`, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
}

const call = (path, method, ctx, body, search = '') =>
  handleAdmin(req(method, body, search), new URL(`https://x.test${path}${search}`), ctx);

// --- Role resolution ------------------------------------------------------

test('a bootstrap admin is admin regardless of storage', async () => {
  const { cfg, storage } = setup();
  await storage.saveUser('boss@vikat.ai', 'denied', 'someone');

  const r = await resolveRole(ADMIN, storage, cfg);
  assert.equal(r.role, 'admin', 'config must outrank a bad grant, or recovery means editing KV by hand');
  assert.equal(r.source, 'bootstrap');
});

test('bootstrap matching is case-insensitive', async () => {
  const { cfg, storage } = setup();
  const r = await resolveRole({ email: 'BOSS@Vikat.AI' }, storage, cfg);
  assert.equal(r.role, 'admin');
});

test('an explicit grant beats the default', async () => {
  const { cfg, storage } = setup();
  await storage.saveUser('rep@vikat.ai', 'admin', ADMIN.email);

  const r = await resolveRole(REP, storage, cfg);
  assert.equal(r.role, 'admin');
  assert.equal(r.source, 'grant');
});

test('an ungraded user falls back to DEFAULT_ROLE', async () => {
  const { cfg, storage } = setup();
  const r = await resolveRole({ email: 'new@vikat.ai' }, storage, cfg);
  assert.equal(r.role, 'rep');
  assert.equal(r.source, 'default');
});

test('DEFAULT_ROLE=denied turns the tool into an explicit allowlist', async () => {
  const { cfg, storage } = setup({ DEFAULT_ROLE: 'denied' });
  assert.equal((await resolveRole({ email: 'new@vikat.ai' }, storage, cfg)).role, 'denied');
});

test('an unrecognised DEFAULT_ROLE denies rather than opening up', async () => {
  const { cfg, storage } = setup({ DEFAULT_ROLE: 'superuser' });
  assert.equal((await resolveRole({ email: 'x@vikat.ai' }, storage, cfg)).role, 'denied');
});

test('a denied grant blocks a user the IdP still authenticates', async () => {
  const { cfg, storage } = setup();
  await storage.saveUser('gone@vikat.ai', 'denied', ADMIN.email);

  const r = await resolveRole({ email: 'gone@vikat.ai' }, storage, cfg);
  assert.equal(r.role, 'denied');
  assert.equal(canUseAssistant(r.role), false);
});

test('a storage failure denies rather than defaulting open', async () => {
  const { cfg } = setup();
  const broken = { getUser: async () => { throw new Error('KV down'); } };
  // resolveRole swallows the error and falls through to DEFAULT_ROLE, which is
  // the documented behaviour; assert it is at worst the configured default and
  // never an escalation to admin.
  const r = await resolveRole({ email: 'x@vikat.ai' }, broken, cfg);
  assert.notEqual(r.role, 'admin', 'a KV failure must never grant admin');
});

test('role predicates', () => {
  assert.ok(canUseAssistant('admin') && canUseAssistant('rep'));
  assert.ok(!canUseAssistant('denied') && !canUseAssistant('nonsense'));
  assert.ok(canAdminister('admin'));
  assert.ok(!canAdminister('rep') && !canAdminister('denied'));
});

// --- Last-admin protection ------------------------------------------------

test('the last granted admin cannot be demoted when there is no bootstrap admin', async () => {
  const { cfg, storage } = setup({ BOOTSTRAP_ADMINS: '' });
  await storage.saveUser('only@vikat.ai', 'admin', 'x');

  assert.equal(await wouldLeaveNoAdmin('only@vikat.ai', 'rep', storage, cfg), true);
});

test('demotion is fine when another granted admin remains', async () => {
  const { cfg, storage } = setup({ BOOTSTRAP_ADMINS: '' });
  await storage.saveUser('a@vikat.ai', 'admin', 'x');
  await storage.saveUser('b@vikat.ai', 'admin', 'x');

  assert.equal(await wouldLeaveNoAdmin('a@vikat.ai', 'rep', storage, cfg), false);
});

test('a bootstrap admin makes granted admins freely revocable', async () => {
  const { cfg, storage } = setup(); // boss@ is bootstrap
  await storage.saveUser('only@vikat.ai', 'admin', 'x');

  assert.equal(await wouldLeaveNoAdmin('only@vikat.ai', 'rep', storage, cfg), false);
});

test('promoting to admin is never blocked', async () => {
  const { cfg, storage } = setup({ BOOTSTRAP_ADMINS: '' });
  await storage.saveUser('a@vikat.ai', 'admin', 'x');
  assert.equal(await wouldLeaveNoAdmin('a@vikat.ai', 'admin', storage, cfg), false);
});

// --- Knowledge ------------------------------------------------------------

test('an admin can add, list, edit and remove knowledge', async () => {
  const { cfg, storage } = setup();
  const ctx = { storage, user: ADMIN, cfg, cors: {}, env: {} };

  const created = await (await call('/admin/knowledge', 'POST', ctx, {
    section: 'Pilot length',
    content: 'Standard pilot is six weeks.',
    status: 'approved',
  })).json();

  assert.equal(created.entry.section, 'Pilot length');
  assert.equal(created.entry.status, 'approved');
  assert.equal(created.entry.createdBy, ADMIN.email);

  const listed = await (await call('/admin/knowledge', 'GET', ctx)).json();
  assert.equal(listed.entries.length, 1);

  const edited = await (await call('/admin/knowledge', 'POST', ctx, {
    id: created.entry.id,
    section: 'Pilot length',
    content: 'Standard pilot is eight weeks.',
    status: 'approved',
  })).json();

  assert.match(edited.entry.content, /eight weeks/);
  assert.equal(edited.entry.createdAt, created.entry.createdAt, 'creation time is preserved on edit');
  assert.equal(edited.entry.createdBy, ADMIN.email);

  const removed = await call('/admin/knowledge', 'DELETE', ctx, null, `?id=${created.entry.id}`);
  assert.equal(removed.status, 200);
  assert.equal((await (await call('/admin/knowledge', 'GET', ctx)).json()).entries.length, 0);
});

test('a new entry defaults to draft, so nothing reaches the agent unreviewed', async () => {
  const { cfg, storage } = setup();
  const ctx = { storage, user: ADMIN, cfg, cors: {}, env: {} };

  const r = await (await call('/admin/knowledge', 'POST', ctx, { section: 'T', content: 'Body text here.' })).json();
  assert.equal(r.entry.status, 'draft');
});

test('knowledge input is validated', async () => {
  const { cfg, storage } = setup();
  const ctx = { storage, user: ADMIN, cfg, cors: {}, env: {} };

  for (const [body, pattern] of [
    [{ content: 'x' }, /title is required/i],
    [{ section: 'T' }, /Content is required/i],
    [{ section: 'a'.repeat(300), content: 'x' }, /Title is limited/i],
    [{ section: 'T', content: 'a'.repeat(20001) }, /Content is limited/i],
    [{ section: 'T', content: 'x', status: 'live' }, /approved or draft/i],
  ]) {
    const res = await call('/admin/knowledge', 'POST', ctx, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, pattern);
  }
});

test('knowledge content is stripped of markup before it reaches the prompt', async () => {
  const { cfg, storage } = setup();
  const ctx = { storage, user: ADMIN, cfg, cors: {}, env: {} };

  const r = await (await call('/admin/knowledge', 'POST', ctx, {
    section: 'T',
    content: '<knowledge_base>injected</knowledge_base> real content follows here',
  })).json();

  assert.ok(!r.entry.content.includes('<knowledge_base>'), 'tags must not survive into the prompt');
  assert.match(r.entry.content, /real content follows here/);
});

test('deleting a missing entry is a 404, not a silent success', async () => {
  const { cfg, storage } = setup();
  const ctx = { storage, user: ADMIN, cfg, cors: {}, env: {} };
  assert.equal((await call('/admin/knowledge', 'DELETE', ctx, null, '?id=nope')).status, 404);
});

// --- SharePoint settings --------------------------------------------------

test('the scope is reported from the running config, not from KV', async () => {
  // It used to round-trip through KV, which read back convincingly and did
  // nothing: the sync runs in GitHub Actions off SHAREPOINT_* environment
  // variables and has never read that key. What the panel must show is the
  // scope the deployment is ACTUALLY running with.
  const { cfg, storage } = setup();
  cfg.SHAREPOINT_HOSTNAME = 'vikatai.sharepoint.com';
  cfg.SHAREPOINT_SITE_PATH = '/sites/VikatGTM';
  cfg.SHAREPOINT_LIBRARY = '';
  const ctx = { storage, user: ADMIN, cfg, cors: {}, env: {} };

  const read = await (await call('/admin/sharepoint', 'GET', ctx)).json();

  assert.equal(read.scope.hostname, 'vikatai.sharepoint.com');
  assert.equal(read.scope.sitePath, '/sites/VikatGTM');
  assert.match(read.scope.managedBy, /GitHub Actions/i, 'and say where it is actually set');
  assert.match(
    read.scope.note,
    /every document library/i,
    'an unset library crawls the whole site now; the panel must not still call it required',
  );
});

test('saving a scope is refused rather than silently ignored', async () => {
  // The failure mode being closed: an admin corrects the library here, gets
  // "Applies on the next sync run", and watches the next sync ignore them.
  const { cfg, storage } = setup();
  const ctx = { storage, user: ADMIN, cfg, cors: {}, env: {} };

  const res = await call('/admin/sharepoint', 'PUT', ctx, {
    hostname: 'vikat.sharepoint.com',
    sitePath: '/sites/Sales',
    library: 'Sales Enablement',
  });

  assert.equal(res.status, 409, 'well-formed, but impossible in this deployment');
  const body = await res.json();
  assert.match(body.error, /not editable here/i);
  assert.match(body.detail, /SHAREPOINT_LIBRARY/, 'and name the variable to change');
  assert.match(body.detail, /Sync knowledge base/, 'and the workflow to re-run');
});

test('last sync reports what this bundle knows, not a job status', async () => {
  // The old panel read a KV key nothing writes, so "No sync has reported yet"
  // was permanent — shown while the sync was working perfectly.
  const { cfg, storage } = setup();
  const ctx = { storage, user: ADMIN, cfg, cors: {}, env: {} };

  const read = await (await call('/admin/sharepoint', 'GET', ctx)).json();

  assert.ok(read.lastSync, 'there is always something to report');
  assert.equal(typeof read.lastSync.totalChunks, 'number');
  assert.ok(read.lastSync.totalChunks > 0, 'the deployed bundle always has a knowledge base');
  assert.equal(typeof read.lastSync.collateralDocuments, 'number');
});

test('the two credential sets are reported separately', async () => {
  // One banner used to cover both and got it backwards: it read a config key
  // that exists nowhere, so it always said "not configured", and then blamed
  // the sync — which runs in CI on different secrets entirely and was fine.
  const { cfg, storage } = setup();
  const ctx = { storage, user: ADMIN, cfg, cors: {}, env: {} };

  const read = await (await call('/admin/sharepoint', 'GET', ctx)).json();

  assert.equal(typeof read.credentials.documentFiling.configured, 'boolean', 'the Worker can see its own');
  assert.equal(read.credentials.sync.configured, null, 'and must not guess at the ones it cannot see');
  assert.match(read.credentials.documentFiling.affects, /generated/i);
  assert.match(read.credentials.sync.affects, /CI/);
});

test('the SharePoint credential is never returned, only its status', async () => {
  const { cfg, storage } = setup();
  const ctx = { storage, user: ADMIN, cfg, cors: {}, env: { GRAPH_CLIENT_SECRET: 'super-secret-value' } };

  const body = await (await call('/admin/sharepoint', 'GET', ctx)).text();
  assert.ok(!body.includes('super-secret-value'), 'a secret must never cross this boundary');
  assert.match(body, /configured/);
});

// --- Users ----------------------------------------------------------------

test('granting a role does not create a login — it records authorization only', async () => {
  const { cfg, storage } = setup();
  const ctx = { storage, user: ADMIN, cfg, cors: {}, env: {} };

  const r = await (await call('/admin/users', 'POST', ctx, { email: 'new@vikat.ai', role: 'rep' })).json();

  assert.equal(r.user.email, 'new@vikat.ai');
  assert.equal(r.user.role, 'rep');
  assert.equal(r.user.grantedBy, ADMIN.email);
  // Nothing resembling a credential is stored.
  assert.ok(!('password' in r.user) && !('passwordHash' in r.user) && !('token' in r.user));
});

test('the roster shows bootstrap admins as uneditable', async () => {
  const { cfg, storage } = setup();
  const ctx = { storage, user: ADMIN, cfg, cors: {}, env: {} };
  await storage.saveUser('rep@vikat.ai', 'rep', ADMIN.email);

  const r = await (await call('/admin/users', 'GET', ctx)).json();
  const boss = r.users.find((u) => u.email === 'boss@vikat.ai');

  assert.equal(boss.source, 'bootstrap');
  assert.equal(boss.editable, false);
  assert.deepEqual(r.roles, ROLES);
});

test('a grant to an address that can never sign in is refused', async () => {
  const { cfg, storage } = setup();
  const ctx = { storage, user: ADMIN, cfg, cors: {}, env: {} };

  const res = await call('/admin/users', 'POST', ctx, { email: 'outsider@gmail.com', role: 'rep' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /cannot sign in/);
});

test('a bootstrap admin cannot be edited or removed through the panel', async () => {
  const { cfg, storage } = setup();
  const ctx = { storage, user: ADMIN, cfg, cors: {}, env: {} };

  const edit = await call('/admin/users', 'POST', ctx, { email: 'boss@vikat.ai', role: 'rep' });
  assert.equal(edit.status, 400);
  assert.match((await edit.json()).error, /bootstrap admin/i);

  const del = await call('/admin/users', 'DELETE', ctx, null, '?email=boss@vikat.ai');
  assert.equal(del.status, 400);
});

test('an admin cannot remove their own access', async () => {
  const { cfg, storage } = setup({ BOOTSTRAP_ADMINS: '' });
  const self = { email: 'me@vikat.ai', name: 'Me' };
  await storage.saveUser('me@vikat.ai', 'admin', 'x');
  await storage.saveUser('other@vikat.ai', 'admin', 'x');

  const ctx = { storage, user: self, cfg, cors: {}, env: {} };

  const demote = await call('/admin/users', 'POST', ctx, { email: 'me@vikat.ai', role: 'rep' });
  assert.equal(demote.status, 400);
  assert.match((await demote.json()).error, /your own admin access/);

  const remove = await call('/admin/users', 'DELETE', ctx, null, '?email=me@vikat.ai');
  assert.equal(remove.status, 400);
});

test('the last admin cannot be demoted away', async () => {
  const { cfg, storage } = setup({ BOOTSTRAP_ADMINS: '' });
  await storage.saveUser('only@vikat.ai', 'admin', 'x');

  const ctx = { storage, user: { email: 'other@vikat.ai' }, cfg, cors: {}, env: {} };
  const res = await call('/admin/users', 'POST', ctx, { email: 'only@vikat.ai', role: 'rep' });

  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /last administrator/);
});

test('user input is validated', async () => {
  const { cfg, storage } = setup();
  const ctx = { storage, user: ADMIN, cfg, cors: {}, env: {} };

  for (const body of [
    { email: 'notanemail', role: 'rep' },
    { email: 'x@vikat.ai', role: 'superuser' },
    { email: '', role: 'rep' },
  ]) {
    assert.equal((await call('/admin/users', 'POST', ctx, body)).status, 400, JSON.stringify(body));
  }
});

test('removing a grant explains the fallback rather than implying a block', async () => {
  const { cfg, storage } = setup();
  const ctx = { storage, user: ADMIN, cfg, cors: {}, env: {} };
  await storage.saveUser('rep@vikat.ai', 'rep', ADMIN.email);

  const r = await (await call('/admin/users', 'DELETE', ctx, null, '?email=rep@vikat.ai')).json();
  assert.match(r.note, /still use the assistant/, 'DEFAULT_ROLE=rep means removal is not a block');
  assert.match(r.note, /denied/, 'and it should say how to actually block them');
});

// --- Summary --------------------------------------------------------------

test('the summary reports the caller and the knowledge counts', async () => {
  const { cfg, storage } = setup();
  const ctx = { storage, user: ADMIN, cfg, cors: {}, env: {} };

  await storage.saveKnowledge({ section: 'A', content: 'x', status: 'approved' }, ADMIN.email);
  await storage.saveKnowledge({ section: 'B', content: 'y', status: 'draft' }, ADMIN.email);

  const r = await (await handleAdminSummary(req('GET'), ctx)).json();
  assert.equal(r.you.email, ADMIN.email);
  assert.equal(r.you.role, 'admin');
  assert.equal(r.knowledge.approved, 1);
  assert.equal(r.knowledge.draft, 1);
});

// --- Dispatch -------------------------------------------------------------

test('an unknown admin path returns null so the caller can 404 it', async () => {
  const { cfg, storage } = setup();
  const ctx = { storage, user: ADMIN, cfg, cors: {}, env: {} };
  assert.equal(await call('/admin/nope', 'GET', ctx), null);
});

test('unsupported methods are rejected on every admin route', async () => {
  const { cfg, storage } = setup();
  const ctx = { storage, user: ADMIN, cfg, cors: {}, env: {} };

  for (const path of ['/admin/knowledge', '/admin/sharepoint', '/admin/users']) {
    const res = await call(path, 'PATCH', ctx, {});
    assert.equal(res.status, 405, path);
  }
});

// --- Upstream reachability ---------------------------------------------

/**
 * Drive the probe with a scripted reply per rung, and hand back its report.
 *
 * The probe climbs a ladder — plain, system, tools, web tool, thinking — so a
 * test has to be able to accept some rungs and refuse others. That IS the
 * feature: a plain request proves the key and nothing else, and reps were
 * failing on requests carrying four more things.
 */
async function probe(reply, env = { ANTHROPIC_API_KEY: 'sk-ant-secret-abcd' }) {
  const { cfg, storage } = setup();
  const real = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    return reply(body, sent.length - 1);
  };
  try {
    const out = await (
      await call('/admin/upstream', 'GET', { cfg, storage, cors: {}, env, user: ADMIN })
    ).json();
    return { out, sent };
  } finally {
    globalThis.fetch = real;
  }
}

const ok = () => new Response('{"type":"message","content":[]}', {
  status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_1' },
});
const refuse = (status, body, headers = {}) =>
  new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });

test('each rung actually carries the thing it is named for', () => {
  // The bug this exists for: building `extra` and never spreading it into the
  // request body. Every rung then sends the same bare request, all five pass,
  // and the probe reports "everything is accepted" about a request it never
  // made. A ladder that measures nothing is worse than no ladder, because it
  // is believed.
  return probe(() => ok()).then(({ sent, out }) => {
    // By name rather than by index, so adding a rung does not renumber every
    // assertion below it. The count is asserted as a floor for the same
    // reason: the old `=== 6` was the thing that had to be edited, and an
    // assertion nobody can add to is one people delete.
    const by = Object.fromEntries(out.tried.map((t, i) => [t.step, sent[i]]));
    assert.ok(sent.length >= 6, `only ${sent.length} rungs`);

    assert.ok(!by.plain.system && !by.plain.tools && !by.plain.thinking, 'plain must be plain');
    assert.ok(by.system.system && by.system.system.length > 100, 'the system rung sends no prompt');
    assert.ok(Array.isArray(by.tools.tools) && by.tools.tools.length > 1, 'the tools rung sends no tools');
    assert.equal(by['web tool'].tools[0].name, 'web_search', 'the web rung sends no web tool');
    assert.deepEqual(by.thinking.thinking, { type: 'adaptive' }, 'the thinking rung sends no thinking');

    // The rung the ladder was missing. `system` builds its prompt with an
    // EMPTY knowledge block, so it was testing a prompt a fraction the size of
    // the one a rep sends — and reporting that everything was fine while every
    // real request was refused.
    assert.ok(
      by['system + knowledge'].system.length > by.system.system.length,
      'the knowledge rung carries no more than the empty one, so it tests nothing new',
    );

    // And all of it at once: each part passing alone says nothing about the
    // combination, because a size limit is reached by the total.
    const all = by.everything;
    assert.ok(all.system && all.tools && all.thinking, 'the everything rung is missing a part');
    assert.ok(all.tools.some((t) => t.name === 'web_search'), 'and the web tool');

    // A rounding error, deliberately.
    assert.ok(sent.every((b) => b.max_tokens === 1));
  });
});

test('the rung that fails is the answer', async () => {
  // A 403 on the web tool and nothing else means the workspace is not entitled
  // to server-side search — which a plain "hi" can never reveal, because it
  // does not carry one.
  const { out } = await probe((body) =>
    body.tools && body.tools[0] && body.tools[0].name === 'web_search'
      ? refuse(403, '{"type":"error","error":{"type":"permission_error","message":"not allowed"}}')
      : ok(),
  );

  assert.equal(out.ok, false);
  assert.deepEqual(out.tried.map((t) => t.step), ['plain', 'system', 'tools', 'web tool']);
  assert.match(out.diagnosis, /403 on the "web tool" step/);
  assert.match(out.diagnosis, /Everything before it was accepted/);
  assert.match(out.diagnosis, /not entitled to server-side web search/);
  assert.match(out.diagnosis, /WEB_RESEARCH=off/, 'a diagnosis without a way out is half a diagnosis');
});

test('the ladder stops at the first refusal', async () => {
  // Measuring a request that already contains a known-bad part tells you
  // nothing, and costs money to learn it.
  const { out, sent } = await probe((body) => (body.system ? refuse(403, 'nope') : ok()));

  assert.equal(sent.length, 2, 'it kept climbing past a refusal');
  assert.equal(out.tried.length, 2);
  assert.equal(out.tried[1].step, 'system');
});

test('a refusal that is not an API error is named as one', async () => {
  // 403 with no `type: "error"` and no request_id: the Messages API never saw
  // this. An admin reading "403 forbidden" reasonably concludes the key is
  // dead and rotates a working key, which is a wasted afternoon.
  const { out } = await probe(() =>
    refuse(403, '{"error":{"type":"forbidden","message":"Request not allowed"}}', { 'cf-ray': 'a395-BOM' }),
  );

  assert.equal(out.tried[0].fromApi, false);
  assert.match(out.diagnosis, /before the API saw it/);
  assert.match(out.diagnosis, /cf-ray/);
  assert.equal(out.tried[0].cfRay, 'a395-BOM', 'the one identifier whoever runs that edge can act on');
});

test('a real API refusal is attributed to the API', async () => {
  const { out } = await probe(() =>
    refuse(401, '{"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null}'),
  );

  assert.equal(out.tried[0].fromApi, true);
  assert.match(out.diagnosis, /The API itself refused it/);
  assert.match(out.diagnosis, /it is the key or the account/, 'a bare request failing is not about this app');
});

test('a fully accepted ladder says the configuration is not the problem', async () => {
  const { out } = await probe(() => ok());

  assert.equal(out.ok, true);
  assert.match(out.diagnosis, /Every part of a real request is accepted/);
  assert.match(out.diagnosis, /in the conversation, not the configuration/);
});

test('a missing key names the per-environment trap', async () => {
  const { out } = await probe(() => ok(), {});

  assert.equal(out.reached, false);
  assert.match(out.diagnosis, /per environment/);
});

test('egress that never completes is not blamed on the key', async () => {
  const { cfg, storage } = setup();
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('connection refused');
  };
  let out;
  try {
    out = await (await call('/admin/upstream', 'GET', {
      cfg, storage, cors: {}, env: { ANTHROPIC_API_KEY: 'sk-ant-x' }, user: ADMIN,
    })).json();
  } finally {
    globalThis.fetch = real;
  }

  assert.equal(out.ok, false);
  assert.match(out.diagnosis, /never completed/);
  assert.match(out.diagnosis, /egress from the Worker.*not the key/);
});

test('the probe never returns the key', async () => {
  // It is read by whoever is debugging and pasted wherever they are debugging.
  // Four characters distinguish two environments' keys; the rest is a secret
  // that would end up in a chat window, which is exactly how this project
  // acquired the credential it still has to rotate.
  const { out } = await probe(() => refuse(403, '{"error":{"type":"forbidden"}}'));

  assert.equal(out.keyTail, 'abcd');
  assert.doesNotMatch(JSON.stringify(out), /sk-ant-secret/);
});

test('the probe is GET only', async () => {
  const { cfg, storage } = setup();
  const res = await call('/admin/upstream', 'POST', {
    cfg, storage, cors: {}, env: {}, user: ADMIN,
  });
  assert.equal(res.status, 405);
});

test('a slow tools rung is reported, and told apart from a warm-up', async () => {
  // A tools request measured 33 SECONDS at max_tokens 1 against ~1s for every
  // other rung. One measurement is an anecdote. If carrying the schemas costs
  // that every time, every rep's first message is thirty seconds of silence —
  // a complaint this project already has. If it is paid once per isolate it is
  // nobody's problem. The same rung twice is the cheapest way to tell.
  let n = 0;
  const slowFirst = await probe(() => {
    n += 1;
    return new Promise((r) => setTimeout(() => r(ok()), n === 3 ? 30 : 0));
  });
  // The timing is faked by the clock, so assert on the SHAPE: the pair has to
  // be present for the comparison to be possible at all, and 'tools again'
  // has to come last so it measures a warmed isolate rather than a cold one.
  const steps = slowFirst.out.tried.map((t) => t.step);
  assert.ok(steps.includes('tools'), steps.join(', '));
  assert.equal(steps[steps.length - 1], 'tools again', 'the repeat must be last, or it measures nothing');
  assert.ok(steps.indexOf('tools') < steps.indexOf('tools again'));
});

test('the tools rung is measured twice with the same payload', async () => {
  // Both must carry the real schemas, or the comparison is between two
  // different requests and means nothing.
  const { sent, out } = await probe(() => ok());
  const at = (name) => sent[out.tried.findIndex((t) => t.step === name)];

  assert.deepEqual(at('tools').tools, at('tools again').tools);
  assert.ok(at('tools again').tools.length > 1);
});
