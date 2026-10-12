import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopback(req: IncomingMessage): boolean {
  return LOOPBACK.has(req.socket.remoteAddress ?? '');
}

/**
 * Loopback callers are the owner on this machine. Anyone else (the phone on
 * the same Wi-Fi) must present the access token, as ?token= or a cookie set
 * from it. With no token configured, only loopback is allowed.
 */
export function isAuthorized(req: IncomingMessage, token: string | undefined): boolean {
  if (isLoopback(req)) return true;
  if (!token) return false;
  const presented = presentedToken(req);
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function presentedToken(req: IncomingMessage): string | undefined {
  const url = new URL(req.url ?? '/', 'http://x');
  const q = url.searchParams.get('token');
  if (q) return q;
  const cookie = req.headers.cookie ?? '';
  return /(?:^|;\s*)lmi_token=([^;]+)/.exec(cookie)?.[1];
}

/**
 * Browsers send Origin on WebSocket upgrades and do not apply CORS to them,
 * so any web page open in the owner's browser could otherwise connect to
 * ws://localhost and read the transcript. Only same-origin pages may connect.
 */
export function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // Not a browser (tests, replay tools).
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
