/**
 * Auth is the only thing standing between internal sales material and the
 * open internet, so these tests lean on the negative cases.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';

import { authenticate, __internals } from '../src/auth.js';
import { authFailure, authStatus } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import { req } from './helpers.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

// --- Test token minting ---------------------------------------------------

const TEAM = 'vikat.cloudflareaccess.com';
const ISSUER = `https://${TEAM}`;
const AUD = 'test-aud-tag';
const JWKS_URL = `${ISSUER}/cdn-cgi/access/certs`;

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let keyPair;
let publicJwk;

async function keys() {
  if (keyPair) return { keyPair, publicJwk };
  keyPair = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  publicJwk = await webcrypto.subtle.exportKey('jwk', keyPair.publicKey);
  publicJwk.kid = 'test-kid';
  return { keyPair, publicJwk };
}

async function mintToken(claims = {}, { kid = 'test-kid', sign = true } = {}) {
  const { keyPair: kp } = await keys();
  const now = Math.floor(Date.now() / 1000);

  const header = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })));
  const payload = b64url(
    Buffer.from(
      JSON.stringify({
        iss: ISSUER,
        aud: AUD,
        email: 'rep@vikat.ai',
        name: 'Test Rep',
        sub: 'user-123',
        iat: now,
        exp: now + 3600,
        ...claims,
      }),
    ),
  );

  const signature = sign
    ? b64url(
        new Uint8Array(
          await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, Buffer.from(`${header}.${payload}`)),
        ),
      )
    : b64url(Buffer.from('not-a-real-signature'));

  return `${header}.${payload}.${signature}`;
}

/** Serve the JWKS from a stubbed fetch, and clear the module cache. */
async function withJwks(fn, { serve = true } = {}) {
  const { publicJwk: jwk } = await keys();
  const original = globalThis.fetch;
  __internals.jwksCache.clear();

  globalThis.fetch = async (url) => {
    if (String(url) === JWKS_URL && serve) {
      return { ok: true, json: async () => ({ keys: [jwk] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
    __internals.jwksCache.clear();
  }
}

const cfg = loadConfig({ AUTH_MODE: 'cf-access', CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD });

// --- Happy path -----------------------------------------------------------

test('a valid Access token authenticates the rep', async () => {
  await withJwks(async () => {
    const token = await mintToken();
    const r = await authenticate(req({ 'Cf-Access-Jwt-Assertion': token }), {}, cfg);

    assert.ok(r.ok, `expected success, got ${r.reason}`);
    assert.equal(r.user.email, 'rep@vikat.ai');
    assert.equal(r.user.name, 'Test Rep');
    assert.equal(r.user.sub, 'user-123');
  });
});

test('the token is also accepted from the CF_Authorization cookie', async () => {
  await withJwks(async () => {
    const token = await mintToken();
    const r = await authenticate(req({ Cookie: `foo=bar; CF_Authorization=${token}` }), {}, cfg);
    assert.ok(r.ok, `expected success, got ${r.reason}`);
  });
});

// --- Rejections -----------------------------------------------------------

test('no token is refused', async () => {
  const r = await authenticate(req({}), {}, cfg);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_access_token');
});

test('a token signed by the wrong key is refused', async () => {
  await withJwks(async () => {
    const token = await mintToken({}, { sign: false });
    const r = await authenticate(req({ 'Cf-Access-Jwt-Assertion': token }), {}, cfg);
    assert.equal(r.ok, false, 'a forged signature must not authenticate');
    assert.equal(r.reason, 'bad_signature');
    // Reported as a credential problem, not a server fault. Access does not
    // issue tokens that fail their own signature, so this is a tampered token
    // or a stale cached key; answering "the assistant is misconfigured" would
    // be wrong and would confirm something to whoever sent it.
    assert.equal(authStatus({ reason: r.reason }), 401);
  });
});

test('an expired token is refused', async () => {
  await withJwks(async () => {
    const past = Math.floor(Date.now() / 1000) - 7200;
    const token = await mintToken({ exp: past, iat: past - 3600 });
    const r = await authenticate(req({ 'Cf-Access-Jwt-Assertion': token }), {}, cfg);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'token_expired');

    // The common failure, and the one a rep can act on. It used to answer
    // "Sign in with your Vikat account", which reads as though they never had
    // one — the actual situation is that they did and it ran out.
    const said = authFailure({ reason: r.reason }, cfg);
    assert.equal(said.retry, 'signin');
    assert.match(said.error, /expired/i);
    assert.equal(authStatus({ reason: r.reason }), 401);
  });
});

test('a token for a different audience is refused, and NOT with a sign-in loop', async () => {
  // This is the case the flattening got dangerously wrong. The token is
  // genuine and correctly signed; it was issued for another Access
  // application. Every reason fell through to `retry: "signin"`, so a rep
  // signed in, received a fresh token that mismatched identically, and was
  // told to sign in. Forever.
  await withJwks(async () => {
    const token = await mintToken({ aud: 'someone-elses-app' });
    const r = await authenticate(req({ 'Cf-Access-Jwt-Assertion': token }), {}, cfg);
    assert.equal(r.ok, false, 'audience confusion must not authenticate');
    assert.equal(r.reason, 'audience_mismatch');

    const said = authFailure({ reason: r.reason }, cfg);
    assert.equal(said.retry, 'never', 'signing in again cannot fix an audience mismatch');
    assert.match(said.error, /will not help/i, 'and the rep has to be told that');
    assert.equal(authStatus({ reason: r.reason }), 503, 'this is a deployment fault, not a credential one');
  });
});

test('a token from a different issuer is refused', async () => {
  await withJwks(async () => {
    const token = await mintToken({ iss: 'https://attacker.cloudflareaccess.com' });
    const r = await authenticate(req({ 'Cf-Access-Jwt-Assertion': token }), {}, cfg);
    assert.equal(r.ok, false);
  });
});

test('an unknown signing key id is refused', async () => {
  await withJwks(async () => {
    const token = await mintToken({}, { kid: 'unknown-kid' });
    const r = await authenticate(req({ 'Cf-Access-Jwt-Assertion': token }), {}, cfg);
    assert.equal(r.ok, false);
  });
});

test('a malformed token is refused', async () => {
  for (const bad of ['', 'notatoken', 'a.b', 'a.b.c.d']) {
    const r = await authenticate(req({ 'Cf-Access-Jwt-Assertion': bad }), {}, cfg);
    assert.equal(r.ok, false, `"${bad}" must not authenticate`);
  }
});

test('an alg:none token is refused', async () => {
  await withJwks(async () => {
    const header = b64url(Buffer.from(JSON.stringify({ alg: 'none', kid: 'test-kid' })));
    const payload = b64url(
      Buffer.from(JSON.stringify({ iss: ISSUER, aud: AUD, email: 'attacker@vikat.ai', exp: Date.now() / 1000 + 3600 })),
    );
    const r = await authenticate(req({ 'Cf-Access-Jwt-Assertion': `${header}.${payload}.` }), {}, cfg);
    assert.equal(r.ok, false, 'alg:none must never authenticate');
  });
});

test('an outside email domain is refused even with a valid signature', async () => {
  await withJwks(async () => {
    const token = await mintToken({ email: 'attacker@gmail.com' });
    const r = await authenticate(req({ 'Cf-Access-Jwt-Assertion': token }), {}, cfg);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'domain_not_allowed');
  });
});

test('a token with no email claim is refused', async () => {
  await withJwks(async () => {
    const token = await mintToken({ email: undefined, preferred_username: undefined });
    const r = await authenticate(req({ 'Cf-Access-Jwt-Assertion': token }), {}, cfg);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_email_claim');
  });
});

test('an unreachable JWKS endpoint refuses rather than allowing through', async () => {
  await withJwks(
    async () => {
      const token = await mintToken();
      const r = await authenticate(req({ 'Cf-Access-Jwt-Assertion': token }), {}, cfg);
      assert.equal(r.ok, false, 'fail closed, never open');
    },
    { serve: false },
  );
});

// --- Misconfiguration -----------------------------------------------------

test('cf-access without a team domain refuses as misconfigured', async () => {
  const broken = loadConfig({ AUTH_MODE: 'cf-access' });
  const r = await authenticate(req({ 'Cf-Access-Jwt-Assertion': 'x.y.z' }), {}, broken);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'misconfigured');
});

test('an unknown AUTH_MODE refuses', async () => {
  const r = await authenticate(req({}), {}, loadConfig({ AUTH_MODE: 'trustme' }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'misconfigured');
});

// --- Dev mode -------------------------------------------------------------

test('dev auth is inert unless ALLOW_DEV_AUTH is explicitly true', async () => {
  const r = await authenticate(
    req({ 'X-Dev-User': 'anyone@anywhere.com' }),
    {},
    loadConfig({ AUTH_MODE: 'dev' }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'dev_auth_disabled');
});

test('ALLOW_DEV_AUTH only opens on the exact string "true"', async () => {
  for (const val of ['1', 'yes', 'TRUE', 'on']) {
    const r = await authenticate(
      req({ 'X-Dev-User': 'x@vikat.ai' }),
      {},
      loadConfig({ AUTH_MODE: 'dev', ALLOW_DEV_AUTH: val }),
    );
    assert.equal(r.ok, false, `ALLOW_DEV_AUTH="${val}" must not open dev auth`);
  }
});

test('dev auth works when deliberately enabled', async () => {
  const r = await authenticate(
    req({ 'X-Dev-User': 'local@vikat.ai' }),
    {},
    loadConfig({ AUTH_MODE: 'dev', ALLOW_DEV_AUTH: 'true' }),
  );
  assert.ok(r.ok);
  assert.equal(r.user.email, 'local@vikat.ai');
});

// --- Domain gate ----------------------------------------------------------

test('domainAllowed is case-insensitive and rejects lookalikes', () => {
  const c = loadConfig({ ALLOWED_EMAIL_DOMAINS: 'vikat.ai' });
  assert.ok(__internals.domainAllowed('Rep@Vikat.AI', c));
  assert.ok(!__internals.domainAllowed('rep@vikat.ai.evil.com', c));
  assert.ok(!__internals.domainAllowed('rep@notvikat.ai', c));
  assert.ok(!__internals.domainAllowed('novalidemail', c));
  assert.ok(!__internals.domainAllowed('', c));
});

test('an empty ALLOWED_EMAIL_DOMAINS disables the domain gate', () => {
  const c = loadConfig({});
  c.ALLOWED_EMAIL_DOMAINS = [];
  assert.ok(__internals.domainAllowed('anyone@anywhere.com', c));
});

test('an issuer mismatch is a deployment fault, not a credential one', async () => {
  // Same shape as the audience case: a valid token from the wrong team.
  await withJwks(async () => {
    const token = await mintToken({ iss: 'https://someone-else.cloudflareaccess.com' });
    const r = await authenticate(req({ 'Cf-Access-Jwt-Assertion': token }), {}, cfg);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'issuer_mismatch');
    assert.equal(authFailure({ reason: r.reason }, cfg).retry, 'never');
    assert.equal(authStatus({ reason: r.reason }), 503);
  });
});

test('every refusal names a remedy that could actually work', () => {
  // The rule the rest of authFailure was written to, applied to the whole set
  // rather than to the branches somebody remembered. `signin` is a promise: it
  // says a fresh token would be accepted. For any reason where a fresh token
  // fails identically, making that promise costs the rep a round trip and
  // their confidence in the message.
  const FRESH_TOKEN_WOULD_FAIL_THE_SAME_WAY = [
    'issuer_mismatch',
    'audience_mismatch',
    'unexpected_alg',
    'domain_not_allowed',
    'no_email_claim',
    'misconfigured',
    'dev_auth_disabled',
    'jwks_unavailable',
  ];

  for (const reason of FRESH_TOKEN_WOULD_FAIL_THE_SAME_WAY) {
    const said = authFailure({ reason, email: 'someone@example.com' }, cfg);
    assert.notEqual(said.retry, 'signin', `${reason} must not send the rep round the sign-in loop`);
    assert.ok(said.error, `${reason} must still say something`);
    assert.equal(said.reason, reason, 'the reason travels, so a log line explains the screen');
  }

  // And the converse: where a fresh token IS the fix, say so.
  for (const reason of ['no_access_token', 'token_expired', 'bad_signature', 'malformed_token']) {
    assert.equal(authFailure({ reason }, cfg).retry, 'signin', `${reason} is fixed by signing in`);
  }
});

test('an unforeseen verification failure fails closed', () => {
  // fail() attaches a reason; anything that throws without one must still be
  // refused rather than sailing past the switch into a default that permits.
  const said = authFailure({ reason: 'invalid_token' }, cfg);
  assert.equal(said.code, 'unauthorized');
  assert.equal(authStatus({ reason: 'invalid_token' }), 401);
});

test('a mismatch names the one setting to change, and tells nobody the values', async () => {
  // Grouping audience and issuer under "the audience or team domain" left an
  // administrator with two settings in two places and no way to tell which.
  // Distinguishing them is free: the reason already did.
  await withJwks(async () => {
    const wrongAud = await mintToken({ aud: 'someone-elses-app' });
    const a = authFailure({ reason: (await authenticate(req({ 'Cf-Access-Jwt-Assertion': wrongAud }), {}, cfg)).reason }, cfg);
    assert.match(a.error, /CF_ACCESS_AUD/);
    assert.doesNotMatch(a.error, /CF_ACCESS_TEAM_DOMAIN/, 'naming both is naming neither');

    const wrongIss = await mintToken({ iss: 'https://someone-else.cloudflareaccess.com' });
    const i = authFailure({ reason: (await authenticate(req({ 'Cf-Access-Jwt-Assertion': wrongIss }), {}, cfg)).reason }, cfg);
    assert.match(i.error, /CF_ACCESS_TEAM_DOMAIN/);
    assert.doesNotMatch(i.error, /CF_ACCESS_AUD/);

    // The expected and actual values go to the log, never to the caller. They
    // are committed in wrangler.toml and so are not secret, but an
    // unauthenticated caller should not be handed a deployment's config by its
    // own error messages.
    for (const said of [a, i]) {
      assert.doesNotMatch(said.error, /someone-elses-app|someone-else\.cloudflareaccess/);
      assert.doesNotMatch(said.error, new RegExp(cfg.CF_ACCESS_AUD), 'the expected AUD is not echoed either');
    }
  });
});

test('the log line carries what the client message deliberately omits', async () => {
  // Without this the administrator has the name of a setting and no idea what
  // the token actually said, which is the whole question.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await withJwks(async () => {
      const token = await mintToken({ aud: 'someone-elses-app' });
      await authenticate(req({ 'Cf-Access-Jwt-Assertion': token }), {}, cfg);
    });
  } finally {
    console.warn = realWarn;
  }

  const line = warnings.find((w) => /audience_mismatch/.test(w));
  assert.ok(line, `no audience_mismatch warning in:\n${warnings.join('\n')}`);
  assert.match(line, /someone-elses-app/, 'what the token carried');
  assert.match(line, new RegExp(cfg.CF_ACCESS_AUD), 'and what was expected');
});

test('the log says whether Access injected the token or the browser did', async () => {
  // A stale CF_ACCESS_AUD and an Access application that is no longer in front
  // of the Worker produce the identical audience_mismatch, and the fixes are
  // opposite: re-copy a tag, versus re-attach the application. Access injects
  // the header and only for a Worker it actually guards; a cookie outlives the
  // application that minted it. So the source answers which.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    await withJwks(async () => {
      const token = await mintToken({ aud: 'someone-elses-app' });

      await authenticate(req({ 'Cf-Access-Jwt-Assertion': token }), {}, cfg);
      assert.match(
        warnings.find((w) => /audience_mismatch/.test(w)) || '',
        /via access-header/,
        'a header means Access is in front and the configured AUD is the wrong one',
      );

      warnings.length = 0;
      await authenticate(req({ Cookie: `CF_Authorization=${token}` }), {}, cfg);
      assert.match(
        warnings.find((w) => /audience_mismatch/.test(w)) || '',
        /via cookie/,
        'a cookie with no header means Access is not enforcing ahead of this Worker',
      );
    });
  } finally {
    console.warn = realWarn;
  }
});

test('a cookie is held to exactly the same checks as an injected header', () => {
  // The source is recorded, never trusted. Recording it would be a real
  // weakness if it ever became a reason to skip a check.
  const src = fs.readFileSync(new URL('../src/auth.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf("case 'cf-access'"), src.indexOf("case 'entra'"));
  assert.doesNotMatch(block, /tokenSource\s*===/, 'nothing may branch on where the token came from');
  assert.equal(
    (block.match(/verifyRs256\(/g) || []).length,
    1,
    'one verification path, so a cookie cannot take a softer one',
  );
});
