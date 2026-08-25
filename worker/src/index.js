/**
 * index.js — Cloudflare Worker: routing, validation, rate limiting, streaming.
 *
 * Routes
 *   POST /chat        Streamed chat turn (SSE).
 *   GET  /collateral  The indexed SharePoint document list.
 *   GET  /health      Build + config visibility. No secrets.
 *   OPTIONS *         CORS preflight.
 *
 * AUDIENCE: internal. Every /chat request must carry a verified Vikat identity
 * (see auth.js). The agent answers from material that is not cleared for
 * customers, so an unauthenticated request is refused before the model is
 * reached and before anything is billed.
 *
 * The worker is stateless in Tier A: the client sends the full history each
 * turn. Tier B (B2) makes the server session-authoritative — the client will
 * then send only `sessionId` plus the new message, and this handler will load
 * history through storage.getSession(). Everything else stays as it is.
 */

import Anthropic from '@anthropic-ai/sdk';

import { loadConfig } from './config.js';
import { createStorage } from './storage.js';
import { retrieve, retrievalStatus } from './retrieve.js';
import { searchCollateral, collateralCount } from './collateral.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { TOOL_DEFINITIONS, runTool } from './tools.js';
import { authenticate } from './auth.js';
import { resolveRole, canUseAssistant, canAdminister } from './roles.js';
import { handleAdmin, handleAdminSummary } from './admin.js';

// --- CORS -----------------------------------------------------------------

/**
 * Resolve the CORS headers for a request.
 *
 * Returns `null` when the Origin is present but not allowed, which the caller
 * turns into a 403. A missing Origin (curl, server-to-server) is allowed
 * through without CORS headers — the browser is the thing being protected.
 *
 * Same-origin is always allowed, whatever the allowlist says. Browsers send an
 * Origin header on same-origin POSTs as well as cross-origin ones, so without
 * this the Worker rejects requests from the very pages it serves. The
 * allowlist governs genuinely cross-origin callers only.
 */
function corsHeaders(request, cfg) {
  const origin = request.headers.get('Origin');
  if (!origin) return {};

  let sameOrigin = false;
  try {
    // Full origin, not just host: http:// and https:// on the same host are
    // different origins, and treating them as one would accept a downgrade.
    sameOrigin = new URL(origin).origin === new URL(request.url).origin;
  } catch {
    // Malformed Origin header; fall through to the allowlist, which rejects it.
  }

  if (!sameOrigin && !cfg.ALLOWED_ORIGINS.includes(origin)) return null;

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cf-Access-Jwt-Assertion, X-Dev-User',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

// --- Validation -----------------------------------------------------------

const TAG_RE = /<[^>]*>/g;
// C0 controls except \t \n \r, plus DEL. Strips terminal escapes and the
// zero-width tricks used to smuggle instructions past a human reviewer.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const RUN_OF_SPACES_RE = /[ \t]{2,}/g;

/** Strip markup, control characters and invisible formatting from prospect input. */
function sanitize(text) {
  return String(text)
    .replace(TAG_RE, ' ')
    .replace(CONTROL_RE, '')
    .replace(INVISIBLE_RE, '')
    .replace(RUN_OF_SPACES_RE, ' ')
    .trim();
}

/** Session ids come from the client; keep them to a safe, bounded shape. */
function validSessionId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
}

/**
 * Validate and normalise the request body.
 *
 * @returns {{ ok: true, sessionId: string, messages: Array<{role: string, content: string}> }
 *         | { ok: false, status: number, error: string }}
 */
function validateChatBody(body, cfg) {
  if (!body || typeof body !== 'object') {
    return { ok: false, status: 400, error: 'Body must be a JSON object.' };
  }

  const { sessionId, messages } = body;

  if (!validSessionId(sessionId)) {
    return { ok: false, status: 400, error: 'Invalid sessionId.' };
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, status: 400, error: 'messages must be a non-empty array.' };
  }

  if (messages.length > cfg.MAX_MESSAGES_PER_SESSION) {
    return {
      ok: false,
      status: 400,
      error: `This conversation has reached its ${cfg.MAX_MESSAGES_PER_SESSION}-message limit. Start a new chat, or email us and we'll pick it up from there.`,
    };
  }

  const clean = [];
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
      return { ok: false, status: 400, error: 'Each message needs role "user" or "assistant".' };
    }
    if (typeof m.content !== 'string') {
      return { ok: false, status: 400, error: 'Each message needs string content.' };
    }
    if (m.content.length > cfg.MAX_CHARS_PER_MESSAGE) {
      return {
        ok: false,
        status: 400,
        error: `Messages are limited to ${cfg.MAX_CHARS_PER_MESSAGE} characters.`,
      };
    }
    const content = sanitize(m.content);
    if (content) clean.push({ role: m.role, content });
  }

  if (clean.length === 0 || clean[clean.length - 1].role !== 'user') {
    return { ok: false, status: 400, error: 'The last message must be from the user.' };
  }

  return { ok: true, sessionId, messages: clean };
}

// --- SSE ------------------------------------------------------------------

const encoder = new TextEncoder();

/** Serialise one SSE frame. */
function sse(event, data) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// --- Chat -----------------------------------------------------------------

async function handleChat(request, env, ctx, cfg, cors, user) {
  if (!env.ANTHROPIC_API_KEY) {
    console.error('[chat] ANTHROPIC_API_KEY is not set. Run: wrangler secret put ANTHROPIC_API_KEY');
    return json({ error: 'The assistant is not available right now.', code: 'misconfigured' }, 503, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON.', code: 'bad_request' }, 400, cors);
  }

  const parsed = validateChatBody(body, cfg);
  if (!parsed.ok) {
    return json({ error: parsed.error, code: 'bad_request' }, parsed.status, cors);
  }

  const storage = createStorage(env, cfg);

  // Rate limit per authenticated user, not per IP: reps share office egress
  // and NAT, so an IP bucket would throttle a whole team at once. Abuse is not
  // the threat model here — a runaway client loop is.
  const rate = await storage.checkRateLimit(
    `user:${user.sub}`,
    cfg.RATE_LIMIT_REQUESTS,
    cfg.RATE_LIMIT_WINDOW_SECONDS,
  );

  if (!rate.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000));
    const waitMinutes = Math.max(1, Math.ceil(retryAfter / 60));
    return json(
      {
        error: `Rate limit reached — try again in about ${waitMinutes} minute${waitMinutes === 1 ? '' : 's'}. If this is unexpected, flag it in ${cfg.INTERNAL_HELP_CHANNEL}.`,
        code: 'rate_limited',
        retryAfter,
      },
      429,
      { ...cors, 'Retry-After': String(retryAfter) },
    );
  }

  const { sessionId, messages } = parsed;
  const userMessage = messages[messages.length - 1].content;

  // Tier A: no server-side session state. Tier B (B2) loads it here.
  const sessionContext = {
    sessionId,
    user,
    // retrieve() uses this to merge admin-authored entries at request time.
    storage,
    turnCount: messages.filter((m) => m.role === 'user').length,
  };

  const knowledge = await retrieve(userMessage, sessionContext);
  const system = buildSystemPrompt(cfg, knowledge, sessionContext);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const stream = new ReadableStream({
    async start(controller) {
      /** @type {Array<{name: string, input: object}>} */
      const toolCalls = [];
      let fullText = '';
      let closed = false;

      const send = (event, data) => {
        if (closed) return;
        try {
          controller.enqueue(sse(event, data));
        } catch {
          // Client went away mid-stream; stop trying to write.
          closed = true;
        }
      };

      try {
        /** @type {Anthropic.MessageParam[]} */
        const convo = messages.map((m) => ({ role: m.role, content: m.content }));

        for (let iteration = 0; iteration < cfg.MAX_TOOL_ITERATIONS; iteration++) {
          const messageStream = client.messages.stream({
            model: cfg.MODEL,
            max_tokens: cfg.MAX_TOKENS,
            // No `thinking` parameter: on Sonnet 4.6 that means thinking is off,
            // which is what the sub-2s first-token target needs. Turning it on
            // would add seconds before the first visible character.
            system,
            tools: TOOL_DEFINITIONS,
            messages: convo,
          });

          messageStream.on('text', (delta) => {
            fullText += delta;
            send('text', { text: delta });
          });

          const final = await messageStream.finalMessage();

          if (final.stop_reason !== 'tool_use') {
            send('done', { stopReason: final.stop_reason });
            break;
          }

          const blocks = final.content.filter((b) => b.type === 'tool_use');
          convo.push({ role: 'assistant', content: final.content });

          const results = [];
          for (const block of blocks) {
            // Tool inputs are parsed JSON from the SDK; never string-match them.
            toolCalls.push({ name: block.name, input: block.input });
            send('tool', { name: block.name });

            const result = await runTool(
              { name: block.name, input: block.input },
              { sessionId, user, storage, env, cfg },
            );

            results.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result.content,
              ...(result.isError ? { is_error: true } : {}),
            });

          }

          convo.push({ role: 'user', content: results });

          if (iteration === cfg.MAX_TOOL_ITERATIONS - 1) {
            console.warn(`[chat] session ${sessionId} hit MAX_TOOL_ITERATIONS`);
            send('done', { stopReason: 'max_tool_iterations' });
          }
        }
      } catch (err) {
        console.error('[chat] stream failed:', err?.status || '', err?.message || err);

        const isOverloaded = err?.status === 429 || err?.status === 529;
        send('error', {
          message: isOverloaded
            ? 'The assistant is busy right now. Try again in a moment.'
            : `Something went wrong. Retry, and if it persists flag it in ${cfg.INTERNAL_HELP_CHANNEL}.`,
          code: isOverloaded ? 'upstream_busy' : 'upstream_error',
        });
      } finally {
        // Logging must not delay closing the stream for the prospect.
        ctx.waitUntil(
          storage
            .appendLog({
              sessionId,
              userEmail: user.email,
              timestamp: new Date().toISOString(),
              userMessage,
              agentResponse: fullText,
              toolCalls,
            })
            .catch((e) => console.error('[chat] appendLog failed:', e?.message || e)),
        );

        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed by client disconnect */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...cors,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}

// --- Entry point ----------------------------------------------------------

export default {
  /**
   * @param {Request} request
   * @param {Record<string, unknown>} env
   * @param {{ waitUntil(p: Promise<unknown>): void }} ctx
   */
  async fetch(request, env, ctx) {
    const cfg = loadConfig(env);
    const cors = corsHeaders(request, cfg);

    if (cors === null) {
      return json({ error: 'Origin not allowed.', code: 'forbidden_origin' }, 403);
    }

    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Unauthenticated: deployment sanity only. Deliberately says nothing about
    // the knowledge base's contents, only its size.
    if (url.pathname === '/health' && request.method === 'GET') {
      return json(
        {
          ok: true,
          model: cfg.MODEL,
          knowledge: retrievalStatus(),
          // Zero here after a sync has supposedly run is the signal that the
          // sync failed silently or wrote nothing.
          collateralDocuments: collateralCount(),
          leadSink: cfg.LEAD_SINK,
          authMode: cfg.AUTH_MODE,
          rateLimit: `${cfg.RATE_LIMIT_REQUESTS}/${cfg.RATE_LIMIT_WINDOW_SECONDS}s per user`,
          apiKeyConfigured: Boolean(env.ANTHROPIC_API_KEY),
          kvConfigured: Boolean(env.VIKAT_KV),
          // Loudly visible if dev auth is ever live in production.
          devAuthOpen: cfg.AUTH_MODE === 'dev' && cfg.ALLOW_DEV_AUTH,
        },
        200,
        cors,
      );
    }

    // Everything below is internal and requires a verified Vikat identity.
    // Authenticate before parsing a body or touching the model, so an
    // unauthenticated caller costs nothing.
    const isProtected =
      url.pathname === '/chat' ||
      url.pathname === '/whoami' ||
      url.pathname === '/collateral' ||
      url.pathname.startsWith('/admin/');

    if (isProtected) {
      const auth = await authenticate(request, env, cfg);

      if (!auth.ok) {
        const misconfigured = auth.reason === 'misconfigured' || auth.reason === 'dev_auth_disabled';
        return json(
          {
            error: misconfigured
              ? 'The assistant is not configured correctly. Flag this to whoever deployed it.'
              : 'Sign in with your Vikat account to use the sales assistant.',
            code: misconfigured ? 'misconfigured' : 'unauthorized',
            reason: auth.reason,
          },
          misconfigured ? 503 : 401,
          cors,
        );
      }

      const storage = createStorage(env, cfg);
      const { role, source } = await resolveRole(auth.user, storage, cfg);

      // Authenticated but not authorized. 403, not 401: signing in again will
      // not help, and telling them so saves a support round-trip.
      if (!canUseAssistant(role)) {
        return json(
          {
            error: 'Your account does not have access to the sales assistant. Ask an administrator to grant it.',
            code: 'forbidden',
          },
          403,
          cors,
        );
      }

      if (url.pathname === '/whoami') {
        return json({ email: auth.user.email, name: auth.user.name, role, roleSource: source }, 200, cors);
      }

      // The Collateral tab's index. Reps only — a document title and its own
      // opening prose are internal material, whatever the link permits.
      if (url.pathname === '/collateral') {
        if (request.method !== 'GET') {
          return json({ error: 'Use GET.', code: 'method_not_allowed' }, 405, cors);
        }
        // Served whole: a few hundred documents is small enough that the
        // browser filters instantly and no keystroke costs a round trip.
        // Past a few thousand this becomes a server-side search — the
        // searchCollateral() seam is already where that would go.
        return json(
          { documents: searchCollateral(url.searchParams.get('q') || ''), total: collateralCount() },
          200,
          { ...cors, 'cache-control': 'private, max-age=60' },
        );
      }

      if (url.pathname.startsWith('/admin/')) {
        if (!canAdminister(role)) {
          return json({ error: 'Administrator access is required.', code: 'forbidden' }, 403, cors);
        }

        const adminCtx = { storage, user: auth.user, cfg, cors, env };

        try {
          if (url.pathname === '/admin/summary') {
            return await handleAdminSummary(request, adminCtx);
          }
          const res = await handleAdmin(request, url, adminCtx);
          if (res) return res;
          return json({ error: 'Not found.', code: 'not_found' }, 404, cors);
        } catch (err) {
          console.error('[admin] unhandled:', err?.message || err);
          return json({ error: 'Something went wrong.', code: 'internal_error' }, 500, cors);
        }
      }

      if (request.method !== 'POST') {
        return json({ error: 'Use POST.', code: 'method_not_allowed' }, 405, cors);
      }

      try {
        return await handleChat(request, env, ctx, cfg, cors, auth.user);
      } catch (err) {
        console.error('[chat] unhandled:', err?.message || err);
        return json({ error: 'Something went wrong.', code: 'internal_error' }, 500, cors);
      }
    }

    return json({ error: 'Not found.', code: 'not_found' }, 404, cors);
  },
};

// Exported for unit tests. Not part of the Worker's runtime surface.
export { validateChatBody, sanitize, corsHeaders, validSessionId };
