/**
 * auth.js — the ONLY module that decides who is calling.
 *
 * This agent is internal: it answers from material that is not cleared for
 * customers, so every request must be attributable to a known Vikat person.
 * An unauthenticated request is refused before the model is ever reached.
 *
 * Same abstraction shape as storage.js and leadSink.js: one narrow function,
 * several implementations, chosen by config. Swapping Cloudflare Access for
 * direct Entra ID verification is a change to this file alone.
 *
 * Modes (cfg.AUTH_MODE):
 *   cf-access  Cloudflare Access sits in front of the Worker and injects a
 *              signed JWT. We verify it against the team's JWKS. Default.
 *   entra      Verify a Microsoft Entra ID token directly against the tenant
 *              JWKS. Use when Access is not in play.
 *   dev        Trust an X-Dev-User header. Local development ONLY; refuses to
 *              run unless cfg.ALLOW_DEV_AUTH is true.
 */

/** JWKS cache, keyed by URL. Workers reuse isolates, so this survives requests. */
const jwksCache = new Map();
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

function b64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

/** Fetch and cache a JWKS document. */
async function getJwks(url) {
  const hit = jwksCache.get(url);
  if (hit && hit.expiresAt > Date.now()) return hit.keys;

  const res = await fetch(url);
  if (!res.ok) throw fail('jwks_unavailable', `JWKS fetch failed: ${res.status}`);
  const body = await res.json();
  const keys = body.keys || [];

  jwksCache.set(url, { keys, expiresAt: Date.now() + JWKS_TTL_MS });
  return keys;
}

/**
 * Verify an RS256 JWT against a JWKS endpoint.
 *
 * Checks signature, expiry, not-before, issuer and audience. Anything that
 * fails throws; callers turn that into a 401.
 */
/**
 * A verification failure that says which one it was.
 *
 * Every throw below used to be a bare Error, and authenticate() caught all of
 * them as one reason, `invalid_token`, which index.js then answered with
 * `retry: "signin"`. That advice is right for an expired session and wrong for
 * half the others: an audience or issuer mismatch means a correctly signed,
 * entirely valid token that this deployment is not configured to accept, so
 * signing in again produces a fresh token that fails in exactly the same way.
 * The rep is told to sign in, does, and is told to sign in.
 *
 * That is the same trap the domain_not_allowed branch in index.js was written
 * to avoid, and its comment says so: "Reloading re-runs the same successful
 * sign-in and fails identically." The rule simply never reached the catch that
 * everything else funnels through.
 */
function fail(reason, message) {
  const err = new Error(message);
  err.reason = reason;
  return err;
}

async function verifyRs256(token, { jwksUrl, issuer, audience }) {
  const parts = token.split('.');
  if (parts.length !== 3) throw fail('malformed_token', 'malformed token');

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = b64urlToJson(headerB64);
  const payload = b64urlToJson(payloadB64);

  if (header.alg !== 'RS256') throw fail('unexpected_alg', `unexpected alg ${header.alg}`);

  const keys = await getJwks(jwksUrl);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw fail('signing_key_unknown', 'signing key not found in JWKS');

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!ok) throw fail('bad_signature', 'signature verification failed');

  const now = Math.floor(Date.now() / 1000);
  // 60s of clock skew tolerance, which is conventional for JWT verification.
  if (typeof payload.exp === 'number' && payload.exp < now - 60) throw fail('token_expired', 'token expired');
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) throw fail('token_not_yet_valid', 'token not yet valid');

  // Both mismatches carry WHAT they compared, because these are the two that
  // an administrator has to fix in configuration and "audience mismatch" alone
  // does not say which value to change or what to change it to.
  //
  // Server-side only: the message reaches `wrangler tail` and never the
  // caller. The values are not secret — the expected pair is committed in
  // wrangler.toml — but an unauthenticated caller has no business being handed
  // a deployment's configuration by its own error messages.
  if (issuer && payload.iss !== issuer) {
    throw fail('issuer_mismatch', `token iss "${payload.iss}" expected "${issuer}"`);
  }

  // Both sides are sets. A token carries one or more audiences, and this
  // deployment accepts one or more applications, so the test is whether they
  // intersect. `audience` still accepts a bare string, which is what the entra
  // branch passes.
  const accepted = audience == null ? [] : Array.isArray(audience) ? audience : [audience];
  if (accepted.length) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.some((a) => accepted.includes(a))) {
      throw fail('audience_mismatch', `token aud [${aud.join(', ')}] accepted [${accepted.join(', ')}]`);
    }
  }

  return payload;
}

/** Pull the caller's email out of whichever claim the IdP used. */
function emailFrom(payload) {
  return (
    payload.email ||
    payload.preferred_username ||
    payload.upn ||
    payload.unique_name ||
    null
  );
}

/**
 * Enforce that the caller belongs to the company.
 *
 * Access and Entra both already gate on identity, but a misconfigured Access
 * policy is a realistic failure mode and this is a cheap second gate.
 */
function domainAllowed(email, cfg) {
  if (!cfg.ALLOWED_EMAIL_DOMAINS.length) return true;
  const domain = String(email || '').split('@')[1]?.toLowerCase();
  return Boolean(domain) && cfg.ALLOWED_EMAIL_DOMAINS.includes(domain);
}

/**
 * @typedef {object} AuthUser
 * @property {string} email
 * @property {string} name
 * @property {string} sub    Stable per-user id, used as the rate-limit key.
 */

/**
 * Identify the caller.
 *
 * Never throws — returns a discriminated result so the caller can map it to a
 * 401 without a try/catch at every site.
 *
 * @param {Request} request
 * @param {Record<string, unknown>} env
 * @param {ReturnType<import('./config.js').loadConfig>} cfg
 * @returns {Promise<{ ok: true, user: AuthUser } | { ok: false, reason: string }>}
 */
export async function authenticate(request, env, cfg) {
  try {
    switch (cfg.AUTH_MODE) {
      case 'cf-access': {
        // Access injects this after the user completes SSO. It cannot be set by
        // a browser cross-origin, and Access strips any client-supplied copy.
        // Which of the two the token came from is a diagnosis in itself.
        //
        // Access INJECTS the header, and only for a Worker it is actually in
        // front of. The cookie is just a cookie the browser still holds, and it
        // survives the application that minted it being deleted. So a request
        // arriving with a cookie and no header means Access is not enforcing
        // anything ahead of this Worker, and the token being judged was issued
        // by some other application — which produces exactly the same
        // audience_mismatch as a stale CF_ACCESS_AUD, with an entirely
        // different fix.
        //
        // Nothing here trusts one more than the other: both go through the
        // same signature, issuer and audience checks, so the fallback is safe.
        // It is recorded because the two are indistinguishable from the error
        // otherwise, and telling them apart cost a round trip.
        const header = request.headers.get('Cf-Access-Jwt-Assertion');
        const token = header || getCookie(request, 'CF_Authorization');
        const tokenSource = header ? 'access-header' : 'cookie';

        if (!token) return { ok: false, reason: 'no_access_token' };

        // .length, not truthiness: CF_ACCESS_AUD is a list now, and an empty
        // array is truthy. Getting this wrong would send an unconfigured
        // deployment past the guard and into verifyRs256 with nothing to
        // compare against, where `if (audience)` would skip the check entirely
        // and accept any correctly signed token from the team.
        if (!cfg.CF_ACCESS_TEAM_DOMAIN || !cfg.CF_ACCESS_AUD.length) {
          console.error('[auth] AUTH_MODE=cf-access but CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD are unset');
          return { ok: false, reason: 'misconfigured' };
        }

        const issuer = `https://${cfg.CF_ACCESS_TEAM_DOMAIN}`;
        let payload;
        try {
          payload = await verifyRs256(token, {
            jwksUrl: `${issuer}/cdn-cgi/access/certs`,
            issuer,
            audience: cfg.CF_ACCESS_AUD,
          });
        } catch (err) {
          // Carried on the error rather than appended to its message, so the
          // log line can LEAD with it. See the console.warn below.
          err.via = tokenSource;
          throw err;
        }

        const email = emailFrom(payload);
        if (!email) return { ok: false, reason: 'no_email_claim' };
        // The email rides along on the rejection. Signing in AGAIN with the
        // same account cannot fix a domain mismatch, so the person has to be
        // told which account they are actually signed in as — otherwise the
        // only symptom is a session that looks expired the moment it is made.
        if (!domainAllowed(email, cfg)) return { ok: false, reason: 'domain_not_allowed', email };

        return {
          ok: true,
          user: { email, name: payload.name || email.split('@')[0], sub: payload.sub || email },
        };
      }

      case 'entra': {
        const header = request.headers.get('Authorization') || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        if (!token) return { ok: false, reason: 'no_bearer_token' };

        if (!cfg.ENTRA_TENANT_ID || !cfg.ENTRA_AUDIENCE) {
          console.error('[auth] AUTH_MODE=entra but ENTRA_TENANT_ID/ENTRA_AUDIENCE are unset');
          return { ok: false, reason: 'misconfigured' };
        }

        const payload = await verifyRs256(token, {
          jwksUrl: `https://login.microsoftonline.com/${cfg.ENTRA_TENANT_ID}/discovery/v2.0/keys`,
          issuer: `https://login.microsoftonline.com/${cfg.ENTRA_TENANT_ID}/v2.0`,
          audience: cfg.ENTRA_AUDIENCE,
        });

        const email = emailFrom(payload);
        if (!email) return { ok: false, reason: 'no_email_claim' };
        if (!domainAllowed(email, cfg)) return { ok: false, reason: 'domain_not_allowed', email };

        return {
          ok: true,
          user: { email, name: payload.name || email.split('@')[0], sub: payload.oid || payload.sub || email },
        };
      }

      case 'dev': {
        // Guarded twice: the mode must be selected AND the escape hatch opened.
        // Shipping this to production would make the agent world-readable.
        if (!cfg.ALLOW_DEV_AUTH) {
          console.error('[auth] AUTH_MODE=dev without ALLOW_DEV_AUTH. Refusing.');
          return { ok: false, reason: 'dev_auth_disabled' };
        }
        const email = request.headers.get('X-Dev-User') || 'dev@vikat.ai';
        return { ok: true, user: { email, name: email.split('@')[0], sub: `dev:${email}` } };
      }

      default:
        console.error(`[auth] unknown AUTH_MODE "${cfg.AUTH_MODE}"`);
        return { ok: false, reason: 'misconfigured' };
    }
  } catch (err) {
    // Most of these are expected traffic (an expired tab, a replayed token),
    // not an incident, so they are warned rather than errored. The reason is
    // carried out to the caller now instead of being flattened: it decides
    // which remedy the rep is offered, and it is the difference between "your
    // session expired" and a sign-in loop nobody can escape.
    //
    // invalid_token remains the fallback for anything unforeseen, so a new
    // throw fails closed rather than being reported as something it is not.
    // Ordered by what a reader needs first, because this line is read in the
    // Cloudflare dashboard's log table, which truncates it mid-sentence.
    //
    // It used to end with the two things that identify the fault, so the table
    // showed "[auth] rejected: audience_mismatch audience mismatch: token
    // carries [8c2c8e8e366bc7c9b3e0fa9ad22…" and cut off both the expected
    // value and the token source, having said the reason twice. Reason, then
    // source, then the values.
    console.warn(
      `[auth] rejected: ${err?.reason || 'invalid_token'}${err?.via ? ` via ${err.via}` : ''}:`,
      err?.message || err,
    );
    return { ok: false, reason: err?.reason || 'invalid_token' };
  }
}

function getCookie(request, name) {
  const raw = request.headers.get('Cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/** Exported for tests. */
export const __internals = { verifyRs256, domainAllowed, emailFrom, b64urlToJson, jwksCache };
