/**
 * Degrading to a tool-less answer.
 *
 * A malformed tool schema is rejected at the request level, so the API answers
 * nothing at all — including messages that would never have used a tool. That
 * took the whole assistant down once. These tests hold the recovery in place:
 * the tools are what get dropped, never the conversation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import { fakeKV } from './helpers.js';

const ENV = {
  AUTH_MODE: 'dev',
  ALLOW_DEV_AUTH: 'true',
  BOOTSTRAP_ADMINS: 'boss@vikat.ai',
  ANTHROPIC_API_KEY: 'test-key',
  VIKAT_KV: fakeKV(),
};

/** The API's actual refusal, as the SDK surfaces it. */
function schemaError() {
  const err = new Error(
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"Schema is too complex."}}',
  );
  err.status = 400;
  return err;
}

/**
 * Stand in for the Anthropic endpoint.
 *
 * Rejects any request carrying tools, accepts one without — which is exactly
 * the condition that broke production.
 */
function stubApi({ rejectWithTools = true, onRequest } = {}) {
  const calls = [];

  return async (url, init) => {
    const u = String(url);
    if (!u.includes('api.anthropic.com')) return { ok: false, status: 404, text: async () => 'no' };

    const body = JSON.parse(init.body);
    calls.push({ hadTools: Array.isArray(body.tools) && body.tools.length > 0 });
    if (onRequest) onRequest(body);

    if (rejectWithTools && body.tools?.length) {
      const err = schemaError();
      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => err.message.slice(4),
        json: async () => JSON.parse(err.message.slice(4)),
      };
    }

    // A minimal SSE stream carrying one sentence.
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Answered without tools."}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":4}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n');

    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse));
          controller.close();
        },
      }),
    };
  };
}

async function chat(stub, { user = 'rep@vikat.ai', env = ENV } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    const res = await worker.fetch(
      new Request('https://x.test/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Dev-User': user },
        body: JSON.stringify({
          sessionId: 'abcd1234efgh',
          messages: [{ role: 'user', content: 'hi there' }],
        }),
      }),
      env,
      { waitUntil() {} },
    );
    return { status: res.status, text: await res.text() };
  } finally {
    globalThis.fetch = original;
  }
}

test('a refused tool schema costs the tools, not the answer', async () => {
  const stub = stubApi();
  const { status, text } = await chat(stub);

  assert.equal(status, 200);
  assert.match(text, /Answered without tools\./, 'the rep must still get an answer');
  assert.ok(!/upstream_error/.test(text), 'this must not surface as a failure');
});

test('the retry actually drops the tools rather than resending them', async () => {
  const sent = [];
  const stub = stubApi({ onRequest: (body) => sent.push(Boolean(body.tools?.length)) });
  await chat(stub);

  assert.deepEqual(sent, [true, false], 'first attempt with tools, retry without');
});

test('a 400 that is not about the schema still fails loudly', async () => {
  // Widening the fallback would turn a real request bug into a silently worse
  // answer, which is harder to find than an outage.
  const stub = async (url, init) => {
    if (!String(url).includes('api.anthropic.com')) return { ok: false, status: 404, text: async () => '' };
    return {
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => '{"type":"error","error":{"type":"invalid_request_error","message":"messages: at least one message is required"}}',
    };
  };

  const { text } = await chat(stub);
  assert.match(text, /upstream_error/, 'an unrelated 400 must not be swallowed');
});

test('an admin is told the upstream reason; a rep is not', async () => {
  const stub = async (url) => {
    if (!String(url).includes('api.anthropic.com')) return { ok: false, status: 404, text: async () => '' };
    return {
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => '{"type":"error","error":{"type":"invalid_request_error","message":"messages: at least one message is required"}}',
    };
  };

  const asAdmin = await chat(stub, { user: 'boss@vikat.ai' });
  assert.match(asAdmin.text, /at least one message/, 'an admin should not have to read Worker logs');

  const asRep = await chat(stub, { user: 'rep@vikat.ai' });
  assert.ok(!/at least one message/.test(asRep.text), 'a rep sees the plain message only');
});
