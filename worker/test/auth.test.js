/**
 * Auth is the only thing standing between internal sales material and the
 * open internet, so these tests lean on the negative cases.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { authenticate, __internals } from '../src/auth.js';
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
    assert.equal(r.reason, 'invalid_token');
  });
});

test('an expired token is refused', async () => {
  await withJwks(async () => {
    const past = Math.floor(Date.now() / 1000) - 7200;
    const token = await mintToken({ exp: past, iat: past - 3600 });
    const r = await authenticate(req({ 'Cf-Access-Jwt-Assertion': token }), {}, cfg);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_token');
  });
});

test('a token for a different audience is refused', async () => {
  await withJwks(async () => {
    const token = await mintToken({ aud: 'someone-elses-app' });
    const r = await authenticate(req({ 'Cf-Access-Jwt-Assertion': token }), {}, cfg);
    assert.equal(r.ok, false, 'audience confusion must not authenticate');
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
