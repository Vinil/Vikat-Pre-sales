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

// --- Unsupported parameters -----------------------------------------------

/** Rejects any request carrying `thinking`; accepts one without. */
function rejectsThinking() {
  const sent = [];
  return Object.assign(
    async (url, init) => {
      const u = String(url);
      if (!u.includes('api.anthropic.com')) return { ok: false, status: 404, text: async () => '' };

      const body = JSON.parse(init.body);
      sent.push({ thinking: Boolean(body.thinking), tools: Boolean(body.tools?.length) });

      if (body.thinking) {
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () =>
            '{"type":"error","error":{"type":"invalid_request_error","message":"thinking: Unsupported parameter for this model"}}',
        };
      }
      return stubApi({ rejectWithTools: false })(url, init);
    },
    { sent },
  );
}

test('a model that refuses `thinking` still answers, without it', async () => {
  // Adaptive thinking is on because turning it off makes the model narrate
  // tool calls instead of making them. But a model that will not take the
  // parameter must not cost the conversation.
  const stub = rejectsThinking();
  const { status, text } = await chat(stub);

  assert.equal(status, 200);
  assert.match(text, /Answered without tools\./);
  assert.deepEqual(
    stub.sent.map((s) => s.thinking),
    [true, false],
    'first attempt with thinking, retry without',
  );
});

test('the retry keeps the tools when only thinking was refused', async () => {
  // Degrading one capability must not quietly cost another.
  const stub = rejectsThinking();
  await chat(stub);
  assert.equal(stub.sent[1].tools, true, 'tools survive a thinking-only rejection');
});

test('a 400 naming an unrelated parameter is not silently degraded', async () => {
  const stub = async (url) => {
    if (!String(url).includes('api.anthropic.com')) return { ok: false, status: 404, text: async () => '' };
    return {
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () =>
        '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: must be greater than 0"}}',
    };
  };
  const { text } = await chat(stub);
  assert.match(text, /upstream_error/, 'a real request bug must stay loud');
});

test('adaptive thinking is on by default', async () => {
  // Regression guard. It was off for latency, and off is what made the model
  // write "[Calling find_collateral for X]" as prose and then apologise for
  // not being able to run it.
  const stub = stubApi({ rejectWithTools: false });
  const sent = [];
  const wrapped = async (url, init) => {
    if (String(url).includes('api.anthropic.com')) sent.push(JSON.parse(init.body));
    return stub(url, init);
  };

  await chat(wrapped);
  assert.deepEqual(sent[0].thinking, { type: 'adaptive' });
});

// --- the prompt has to lose the tools at the same moment the request does ---

test('the retry stops advertising tools the request no longer carries', async () => {
  // The bug this pins down produced a real answer with an invented product
  // architecture in it. Tools were dropped from the REQUEST and left in the
  // SYSTEM PROMPT, so the model still believed it had find_collateral: it
  // wrote an imitation of a call into its visible text, got nothing back, and
  // answered anyway from background knowledge — naming a SharePoint file that
  // does not exist and describing a product plane that was never built.
  //
  // The prompt's own "never name a file you have not seen in a tool result"
  // cannot catch that, because the model believed it had seen one.
  const sent = [];
  const stub = stubApi({ onRequest: (body) => sent.push(body.system) });
  await chat(stub);

  assert.equal(sent.length, 2, 'one attempt with tools, one without');

  // Matched against the ROSTER's own formatting — backtick-quoted identifiers —
  // rather than the whole prompt. The knowledge block is part of the system
  // prompt too, and a curated FAQ entry legitimately describes the tools in
  // prose ("routes with the ask_expert tool"). That is retrieved content, not
  // an instruction, and the banner below tells the model they are unavailable
  // regardless. What must not survive is the roster telling it to call them.
  const ROSTER = new RegExp('\`(?:log_prospect|ask_expert|flag_content_gap|find_collateral|create_document)\`');

  assert.match(sent[0], ROSTER, 'the first attempt has tools and should describe them');
  assert.match(sent[0], /^# Tools$/m, 'and should carry the roster heading');

  assert.doesNotMatch(
    sent[1],
    ROSTER,
    'the retry carries no tools, so the prompt must not offer any — a model told it ' +
      'has a tool it was not given imitates the call and then invents the result',
  );
  assert.match(sent[1], /# Tools — UNAVAILABLE THIS TURN/, 'the roster must be replaced, not merely dropped');
});

test('the toolless prompt says the capability is down, not absent', async () => {
  // "I cannot search SharePoint" is false and sends a rep away. "I cannot
  // search it right now, and the Collateral tab lists everything" is true and
  // still gets them the document.
  const sent = [];
  const stub = stubApi({ onRequest: (body) => sent.push(body.system) });
  await chat(stub);

  assert.match(sent[1], /UNAVAILABLE THIS TURN/, 'the outage must be stated plainly');
  assert.match(sent[1], /Collateral/, 'the tab needs no tool and must survive the cut');
  assert.match(
    sent[1],
    /Never invent a value, a filename, a link, or a product capability/,
    'the specific failure mode must be named, not implied',
  );
});

test('the prompt is rebuilt only when the tools are actually dropped', async () => {
  // A model that refuses `thinking` keeps its tools, so it must keep the
  // prompt that describes them.
  const sent = [];
  const stub = stubApi({ rejectWithTools: false, onRequest: (body) => sent.push(body.system) });
  await chat(stub);

  for (const [i, system] of sent.entries()) {
    assert.match(system, /find_collateral/, `attempt ${i + 1} kept its tools and must keep the roster`);
  }
});
