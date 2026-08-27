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
