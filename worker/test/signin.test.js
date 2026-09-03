/**
 * Being turned away, and being told why.
 *
 * An admin signed in successfully and then watched the panel say "Your session
 * expired. Reloading…" every second and a half, forever. Nothing had expired.
 * Every rejection — the wrong account, an unset audience, a provider that
 * never sent an email address — came back as the same 401 with the same
 * sentence, and the panel's only remedy for a 401 was to reload. A reload
 * re-ran the same rejection, which scheduled another reload.
 *
 * So the rule these tests hold: a rejection that signing in again cannot fix
 * must not be a 401, must say what is actually wrong, and must tell the client
 * not to try again.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { authFailure, authStatus } from '../src/index.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig({ ALLOWED_EMAIL_DOMAINS: 'vikat.ai' });

// --- the one that caused it ------------------------------------------------

test('the wrong account is a 403, not an expired session', async () => {
  // Sign-in SUCCEEDED. The account is simply not one this deployment accepts,
  // and a 401 invites exactly the reload that cannot help.
  const auth = { ok: false, reason: 'domain_not_allowed', email: 'someone@gmail.com' };

  assert.equal(authStatus(auth), 403);
  assert.notEqual(authStatus(auth), 401, 'a 401 is what started the reload loop');
});

test('the wrong account is named, so the person can see the mismatch', async () => {
  const body = authFailure({ ok: false, reason: 'domain_not_allowed', email: 'someone@gmail.com' }, cfg);

  assert.match(body.error, /someone@gmail\.com/, 'they cannot fix an account they are not told about');
  assert.match(body.error, /@vikat\.ai/, 'and they need to know which one to use');
  assert.ok(!/expired/i.test(body.error), 'nothing expired; saying so sent people to the wrong problem');
});

test('a rejection a reload cannot fix says so', async () => {
  for (const reason of ['domain_not_allowed', 'no_email_claim', 'misconfigured', 'dev_auth_disabled']) {
    assert.equal(
      authFailure({ ok: false, reason }, cfg).retry,
      'never',
      `${reason}: reloading re-runs the same rejection`,
    );
  }
});

test('a missing or bad token is still worth signing in again for', async () => {
  for (const reason of ['no_access_token', 'invalid_token', 'no_bearer_token']) {
    const body = authFailure({ ok: false, reason }, cfg);
    assert.equal(authStatus({ ok: false, reason }), 401, `${reason} is a real 401`);
    assert.equal(body.retry, 'signin');
  }
});

// --- the others, each pointed at whoever can act on it ---------------------

test('a misconfigured deployment is a 503 aimed at whoever deployed it', async () => {
  const auth = { ok: false, reason: 'misconfigured' };
  assert.equal(authStatus(auth), 503);
  assert.match(authFailure(auth, cfg).error, /whoever deployed it/i);
});

test('dev auth left open in production is refused the same way', async () => {
  assert.equal(authStatus({ ok: false, reason: 'dev_auth_disabled' }), 503);
});

test('a provider that sends no email says what is missing', async () => {
  // Not the user's problem to solve, and not fixable by signing in again.
  const auth = { ok: false, reason: 'no_email_claim' };
  assert.equal(authStatus(auth), 403);
  assert.match(authFailure(auth, cfg).error, /email claim/i);
});

test('an unknown reason falls back to asking for a sign-in', async () => {
  // A reason nobody anticipated must not become a 403 dead end.
  const auth = { ok: false, reason: 'something_new' };
  assert.equal(authStatus(auth), 401);
  assert.equal(authFailure(auth, cfg).retry, 'signin');
});

test('the reason travels, so a log line can name it', async () => {
  assert.equal(authFailure({ ok: false, reason: 'invalid_token' }, cfg).reason, 'invalid_token');
});

test('with no domain gate configured the message does not invent one', async () => {
  // The gate can be turned off entirely. Telling someone to sign in with an
  // "@ account" would be worse than saying nothing.
  const open = loadConfig({});
  open.ALLOWED_EMAIL_DOMAINS = [];

  const body = authFailure({ ok: false, reason: 'domain_not_allowed', email: 'x@y.test' }, open);
  assert.match(body.error, /work account/i);
  assert.ok(!/@vikat/.test(body.error), body.error);
});
