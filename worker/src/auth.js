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
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
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
async function verifyRs256(token, { jwksUrl, issuer, audience }) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = b64urlToJson(headerB64);
  const payload = b64urlToJson(payloadB64);

  if (header.alg !== 'RS256') throw new Error(`unexpected alg ${header.alg}`);

  const keys = await getJwks(jwksUrl);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('signing key not found in JWKS');

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
  if (!ok) throw new Error('signature verification failed');

  const now = Math.floor(Date.now() / 1000);
  // 60s of clock skew tolerance, which is conventional for JWT verification.
  if (typeof payload.exp === 'number' && payload.exp < now - 60) throw new Error('token expired');
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) throw new Error('token not yet valid');

  if (issuer && payload.iss !== issuer) throw new Error('issuer mismatch');

  if (audience) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(audience)) throw new Error('audience mismatch');
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
        const token =
          request.headers.get('Cf-Access-Jwt-Assertion') ||
          getCookie(request, 'CF_Authorization');

        if (!token) return { ok: false, reason: 'no_access_token' };

        if (!cfg.CF_ACCESS_TEAM_DOMAIN || !cfg.CF_ACCESS_AUD) {
          console.error('[auth] AUTH_MODE=cf-access but CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD are unset');
          return { ok: false, reason: 'misconfigured' };
        }

        const issuer = `https://${cfg.CF_ACCESS_TEAM_DOMAIN}`;
        const payload = await verifyRs256(token, {
          jwksUrl: `${issuer}/cdn-cgi/access/certs`,
          issuer,
          audience: cfg.CF_ACCESS_AUD,
        });

        const email = emailFrom(payload);
        if (!email) return { ok: false, reason: 'no_email_claim' };
        if (!domainAllowed(email, cfg)) return { ok: false, reason: 'domain_not_allowed' };

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
        if (!domainAllowed(email, cfg)) return { ok: false, reason: 'domain_not_allowed' };

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
    // A verification failure is expected traffic (expired tab, replayed token),
    // not an incident. Log the reason, return a flat 401 to the caller.
    console.warn('[auth] rejected:', err?.message || err);
    return { ok: false, reason: 'invalid_token' };
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
