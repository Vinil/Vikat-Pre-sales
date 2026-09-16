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

import { TOOL_DEFINITIONS } from '../src/tools.js';
import { webTools } from '../src/webTools.js';
import { loadConfig } from '../src/config.js';
import worker from '../src/index.js';
import { forgetRefusals } from '../src/toolHealth.js';
import { fakeKV } from './helpers.js';

// The refusal memo is isolate-scoped by design, which in one test process means
// it is shared. Clear it so each case starts from a healthy tool set.
test.beforeEach(() => forgetRefusals());

/**
 * Every tool a healthy request offers: the ones this Worker runs plus the ones
 * Anthropic runs. Counted rather than hard-coded, because the ladder's job is
 * "shed exactly one", and pinning a literal here would make adding any tool
 * look like a regression in the ladder.
 */
const ALL_TOOLS = () => TOOL_DEFINITIONS.length + webTools(loadConfig(ENV)).length;

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
function stubApi({
  rejectWithTools = true,
  rejectWhen,
  onRequest,
  stopReason = 'end_turn',
  text = 'Answered without tools.',
} = {}) {
  const calls = [];

  return async (url, init) => {
    const u = String(url);
    if (!u.includes('api.anthropic.com')) return { ok: false, status: 404, text: async () => 'no' };

    const body = JSON.parse(init.body);
    calls.push({ hadTools: Array.isArray(body.tools) && body.tools.length > 0 });
    if (onRequest) onRequest(body);

    const refuse = rejectWhen ? rejectWhen(body) : rejectWithTools && body.tools?.length;
    if (refuse) {
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

    // A minimal SSE stream. `text: ''` emits no delta at all, which is the
    // real shape of a turn that hit max_tokens while still thinking.
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      ...(text
        ? [
            'event: content_block_delta',
            `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}`,
            '',
          ]
        : []),
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      `data: {"type":"message_delta","delta":{"stop_reason":${JSON.stringify(stopReason)},"stop_sequence":null},"usage":{"output_tokens":4}}`,
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

/**
 * The whole system prompt as one string.
 *
 * It travels as content blocks now, so that the cache breakpoint can sit at
 * the end of the part every rep shares. These tests are about what the model
 * is TOLD, which is the blocks' text in order — the split is a billing detail
 * and asserting around it would make every one of them about plumbing.
 */
const systemText = (body) =>
  Array.isArray(body.system) ? body.system.map((b) => b.text).join('\n\n') : body.system;

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

test('a refusal sheds one tool at a time, not the whole set', async () => {
  // This stub refuses ANY request carrying tools, so the ladder walks all the
  // way down — one refusal per tool, then an answer with none. What
  // matters is the shape: each retry offers strictly fewer tools than the last,
  // rather than jumping straight to zero. Against a real API refusing ONE bad
  // schema, that difference is four working tools instead of none.
  const counts = [];
  const stub = stubApi({ onRequest: (body) => counts.push(body.tools?.length ?? 0) });
  await chat(stub);

  assert.equal(counts[0], ALL_TOOLS(), 'the first attempt offers everything');
  assert.equal(counts.at(-1), 0, 'the last attempt offers nothing and is answered');
  for (let i = 1; i < counts.length; i += 1) {
    assert.equal(counts[i], counts[i - 1] - 1, `attempt ${i + 1} should shed exactly one tool`);
  }
});

test('one bad schema costs one tool, not the other four', async () => {
  // The case the ladder exists for. Only log_prospect is refused; every other
  // tool is fine. Dropping all five on the first 400 is what left reps with an
  // assistant that could not search collateral, log a prospect or build a deck
  // — and, being told in its prompt that it could, invented the results.
  const offered = [];
  const stub = stubApi({
    rejectWithTools: false,
    rejectWhen: (body) => body.tools?.some((d) => d.name === 'log_prospect'),
    onRequest: (body) => offered.push((body.tools || []).map((d) => d.name)),
  });
  const { status, text } = await chat(stub);
  const last = offered[offered.length - 1];

  assert.equal(status, 200);
  assert.match(text, /Answered without tools\./, 'the rep still gets an answer');

  // One at a time, never the whole set. Which tool goes first is a GUESS — the
  // costliest schema is the best prior available, not a diagnosis — so the
  // ladder may take more than one retry to reach the real culprit. What must
  // never happen is the jump straight to zero that took production down.
  for (let i = 1; i < offered.length; i += 1) {
    assert.equal(offered[i].length, offered[i - 1].length - 1, `retry ${i} shed more than one`);
  }
  assert.ok(!last.includes('log_prospect'), 'the refused tool is gone');
  assert.ok(last.includes('find_collateral'), 'find_collateral survives, which is the point');
  assert.ok(last.length >= ALL_TOOLS() - offered.length + 1, 'nothing was shed beyond the ladder');
});

test('a tool shed on a wrong guess comes back next turn', () => {
  // The ladder sheds the costliest schema first, which is a prior and not a
  // diagnosis. Remembering a guess that did NOT work blacklists an innocent
  // tool for the life of the isolate — so adding three fields to
  // draft_outreach, making it the costliest, would have cost every subsequent
  // request whichever tool was shed before the real culprit was found.
  //
  // Only the last drop before the accepted request is remembered.
  const first = [];
  const firstStub = stubApi({
    rejectWithTools: false,
    rejectWhen: (body) => body.tools?.some((d) => d.name === 'log_prospect'),
    onRequest: (body) => first.push((body.tools || []).map((d) => d.name)),
  });

  const second = [];
  const secondStub = stubApi({
    rejectWithTools: false,
    rejectWhen: (body) => body.tools?.some((d) => d.name === 'log_prospect'),
    onRequest: (body) => second.push((body.tools || []).map((d) => d.name)),
  });

  return chat(firstStub).then(async () => {
    const shedOnAGuess = first[0].filter((n) => !first[first.length - 1].includes(n));
    assert.ok(shedOnAGuess.length > 1, 'this case only means anything if a guess was wrong');

    await chat(secondStub);

    // log_prospect is remembered, so the next turn never offers it again.
    assert.ok(!second[0].includes('log_prospect'), 'the real culprit is remembered');
    // Everything else it guessed at is back on the first try.
    for (const name of shedOnAGuess.filter((n) => n !== 'log_prospect')) {
      assert.ok(second[0].includes(name), `${name} was innocent and did not come back`);
    }
  });
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
  const stub = stubApi({ onRequest: (body) => sent.push(systemText(body)) });
  await chat(stub);

  assert.ok(sent.length >= 2, 'at least one retry');

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
    sent.at(-1),
    ROSTER,
    'the retry carries no tools, so the prompt must not offer any — a model told it ' +
      'has a tool it was not given imitates the call and then invents the result',
  );
  assert.match(sent.at(-1), /# Tools — UNAVAILABLE THIS TURN/, 'the roster must be replaced, not merely dropped');
});

test('the toolless prompt says the capability is down, not absent', async () => {
  // "I cannot search SharePoint" is false and sends a rep away. "I cannot
  // search it right now, and the Collateral tab lists everything" is true and
  // still gets them the document.
  const sent = [];
  const stub = stubApi({ onRequest: (body) => sent.push(systemText(body)) });
  await chat(stub);

  assert.match(sent.at(-1), /UNAVAILABLE THIS TURN/, 'the outage must be stated plainly');
  assert.match(sent.at(-1), /Collateral/, 'the tab needs no tool and must survive the cut');
  assert.match(
    sent.at(-1),
    /Never invent a value, a filename, a link, or a product capability/,
    'the specific failure mode must be named, not implied',
  );
});

test('the prompt is rebuilt only when the tools are actually dropped', async () => {
  // A model that refuses `thinking` keeps its tools, so it must keep the
  // prompt that describes them.
  const sent = [];
  const stub = stubApi({ rejectWithTools: false, onRequest: (body) => sent.push(systemText(body)) });
  await chat(stub);

  for (const [i, system] of sent.entries()) {
    assert.match(system, /find_collateral/, `attempt ${i + 1} kept its tools and must keep the roster`);
  }
});

// --- a turn must never end in silence -------------------------------------

test('a truncated turn says so instead of rendering nothing', async () => {
  // What the rep actually saw: they asked for a deck, and got their own
  // message followed by nothing. The model had spent the whole token budget
  // thinking, stopped at max_tokens before emitting a character, and the
  // widget drops its typing indicator on 'done' and renders no bubble. Silence
  // is indistinguishable from a hang, so they asked again — and the second
  // turn promised "On it — building it now" and also stopped.
  const stub = stubApi({ rejectWithTools: false, stopReason: 'max_tokens', text: '' });
  const { status, text } = await chat(stub);

  assert.equal(status, 200);
  assert.match(text, /output_truncated/, 'the truncation must reach the client');
  assert.match(text, /smaller pieces/, 'and tell the rep what to do about it');
});

test('a truncated turn that DID produce text warns the text is partial', async () => {
  // A half-written answer that stops mid-sentence reads as a complete one to
  // someone scanning it between calls, which is worse than no answer.
  const stub = stubApi({ rejectWithTools: false, stopReason: 'max_tokens', text: 'The three things to say are' });
  const { text } = await chat(stub);

  assert.match(text, /The three things to say are/, 'the partial answer is still shown');
  assert.match(text, /cut off at the length limit/, 'and flagged as incomplete');
});

test('an empty turn that was not truncated still says something', async () => {
  const stub = stubApi({ rejectWithTools: false, text: '' });
  const { text } = await chat(stub);

  assert.match(text, /empty_response/);
  assert.match(text, /returned nothing/);
});

// --- Turns that stop without saying so ------------------------------------

test('a turn that spends its tool budget says so instead of stopping dead', async () => {
  // "It stopped after the 1st response and nothing." The model announced what
  // it was about to build — "Building a 3-post sequence now, all in one go" —
  // and the loop ran out of iterations before the part it was announcing got a
  // turn to happen in. The server sent `done` with a stopReason, the widget
  // has no branch for `done` and never had one, and the rep got silence.
  const { text } = await chat(stubApi({ rejectWithTools: false, stopReason: 'tool_use' }));

  assert.match(text, /tool_budget_spent/);
  assert.match(text, /rounds of research and tool work/);
  assert.match(text, /ask for the drafts in a second message/i, 'a rep needs the way out, not the diagnosis');
});

test('research that never finishes says so too', async () => {
  // Same silence, different cause: server-side search paused more times than
  // the continuation budget allows. What a rep sees either way is half an
  // answer that reads like a whole one.
  const { text } = await chat(stubApi({ rejectWithTools: false, stopReason: 'pause_turn' }));

  assert.match(text, /research_unfinished/);
  assert.match(text, /stopped part-way through its research/);
});

test('a turn that finishes normally reports nothing at all', async () => {
  // The check must not cry wolf. An error under a good answer is worse than no
  // check, and every one of these branches fires after a turn that HAS text.
  const { text } = await chat(stubApi({ rejectWithTools: false, stopReason: 'end_turn' }));

  assert.match(text, /Answered without tools\./);
  assert.doesNotMatch(text, /tool_budget_spent|research_unfinished|empty_response|output_truncated/);
});

test('every request carries exactly one cache breakpoint, on the shared prefix', async () => {
  // Asserted on the REQUEST rather than on the builder, because this is the
  // thing that gets billed. The knowledge base is 67,000 tokens and the tool
  // loop re-sends it up to four times per turn; a breakpoint that never
  // reaches the wire costs the same as no breakpoint at all.
  const sent = [];
  const stub = stubApi({ rejectWithTools: false, onRequest: (body) => sent.push(body.system) });
  await chat(stub);

  for (const [i, system] of sent.entries()) {
    assert.ok(Array.isArray(system), `attempt ${i + 1} sent the prompt as one uncacheable string`);
    const marked = system.filter((b) => b.cache_control);
    assert.equal(marked.length, 1, `attempt ${i + 1} has ${marked.length} breakpoints`);
    assert.equal(marked[0], system[0], 'the breakpoint must be on the shared prefix, not after it');
    assert.doesNotMatch(marked[0].text, /<current_user>/, 'the rep is named inside the cached prefix');
  }
});

// --- The budget, and what it is spent on ------------------------------------

/**
 * A stub that replies from a script, one entry per request.
 *
 * stubApi answers every request the same way, which is enough for the degrade
 * ladder and useless here: what the budget does depends on what each ROUND
 * came back with, so the turns have to differ.
 *
 * A request carrying no tools gets the closing reply instead of the next
 * script entry, because that is what a request with no tools means.
 */
function scriptedApi(script, { closing = 'Here is what I have so far.', closingAsksForTool = false } = {}) {
  const requests = [];
  let step = 0;

  const sse = (blocks, stopReason) => {
    const lines = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}',
      '',
    ];

    blocks.forEach((block, i) => {
      if (block.text !== undefined) {
        lines.push(
          'event: content_block_start',
          `data: {"type":"content_block_start","index":${i},"content_block":{"type":"text","text":""}}`,
          '',
          'event: content_block_delta',
          `data: {"type":"content_block_delta","index":${i},"delta":{"type":"text_delta","text":${JSON.stringify(block.text)}}}`,
          '',
        );
      } else {
        const json = JSON.stringify(block.input);
        lines.push(
          'event: content_block_start',
          `data: {"type":"content_block_start","index":${i},"content_block":{"type":"tool_use","id":"tu_${step}_${i}","name":${JSON.stringify(block.tool)},"input":{}}}`,
          '',
          'event: content_block_delta',
          `data: {"type":"content_block_delta","index":${i},"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(json)}}}`,
          '',
        );
      }
      lines.push('event: content_block_stop', `data: {"type":"content_block_stop","index":${i}}`, '');
    });

    lines.push(
      'event: message_delta',
      `data: {"type":"message_delta","delta":{"stop_reason":${JSON.stringify(stopReason)},"stop_sequence":null},"usage":{"output_tokens":4}}`,
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    );
    return lines.join('\n');
  };

  const fetchStub = async (url, init) => {
    const u = String(url);
    if (!u.includes('api.anthropic.com')) return { ok: false, status: 404, text: async () => 'no' };

    const body = JSON.parse(init.body);
    requests.push(body);

    const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
    const closingTurn = closingAsksForTool
      ? searchTurn
      : { blocks: [{ text: closing }], stop: 'end_turn' };
    const turn = toolCount === 0
      ? closingTurn
      : (script[Math.min(step, script.length - 1)] || { blocks: [{ text: closing }], stop: 'end_turn' });
    step += 1;

    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse(turn.blocks, turn.stop)));
          controller.close();
        },
      }),
    };
  };

  fetchStub.requests = requests;
  return fetchStub;
}

/** A spec normaliseSpec refuses: five sections and nothing drawn in any of them. */
const PROSE_ONLY = {
  format: 'pdf',
  title: 'A brief',
  content: [0, 1, 2, 3, 4].map((i) => `## Heading ${i}\nSome prose for section ${i}.`).join('\n\n'),
};

/** A spec it accepts. */
const DRAWABLE = {
  format: 'pdf',
  title: 'A brief',
  content: [
    '## stat | 265 | attacks in 2025. Source: ISAC.',
    '## Heading one\nSome prose.',
    '## quote | The one line to end on.',
  ].join('\n\n'),
};

const searchTurn = { blocks: [{ tool: 'find_collateral', input: { query: 'arbitration' } }], stop: 'tool_use' };
const refusedBuild = { blocks: [{ tool: 'create_document', input: PROSE_ONLY }], stop: 'tool_use' };

test('a refused document does not spend a round of the turn’s budget', async () => {
  // The turn that prompted this: a two-pager for a CISO that searched twice,
  // had its build refused for three over-long passages, said "trimming them
  // and rebuilding now", and stopped — because the rebuild had no round left
  // to happen in. Every refusal in it was one this codebase added, and a
  // refusal searches nothing and writes nothing. It is a correction.
  //
  // Six rounds here against a budget of four. Under the old rule the answer
  // never arrives.
  const stub = scriptedApi([
    searchTurn,
    searchTurn,
    refusedBuild,
    refusedBuild,
    { blocks: [{ tool: 'create_document', input: DRAWABLE }], stop: 'tool_use' },
    { blocks: [{ text: 'Built it. Here is the link.' }], stop: 'end_turn' },
  ]);

  const { text } = await chat(stub);

  assert.match(text, /Built it\./, text.slice(0, 400));
  assert.doesNotMatch(text, /tool_budget_spent/, 'the budget was spent on corrections, not work');
});

test('a document that keeps being refused stops instead of looping', async () => {
  // Free is not unlimited. A model that cannot satisfy a checker would
  // otherwise bounce against it until the request timed out, and a short
  // answer beats a hung one.
  const stub = scriptedApi([refusedBuild]);
  const { text } = await chat(stub);

  // Four spent rounds, three bounces, one closing turn without tools.
  const cfg = loadConfig(ENV);
  assert.equal(
    stub.requests.length,
    cfg.MAX_TOOL_ITERATIONS + cfg.MAX_TOOL_BOUNCES + 1,
    `${stub.requests.length} requests`,
  );
  assert.match(text, /Here is what I have so far\./);
});

test('the turn that has no rounds left is asked without tools', async () => {
  // Offering tools to a turn with no rounds left to run them in is how the
  // model comes back asking for one more, which is the dead end this exists to
  // avoid. A tool it cannot see is a tool it cannot ask for.
  const stub = scriptedApi([searchTurn]);
  const { text } = await chat(stub);

  const last = stub.requests[stub.requests.length - 1];
  assert.ok(!last.tools || last.tools.length === 0, 'the closing turn still carried tools');

  const instruction = JSON.stringify(last.messages[last.messages.length - 1]);
  assert.match(instruction, /No tool calls are left/);
  assert.match(instruction, /do not promise to build it now/i);

  // And what it says reaches the rep, instead of the rep getting the
  // announcement and silence.
  assert.match(text, /Here is what I have so far\./);
  assert.doesNotMatch(text, /tool_budget_spent/);
});

test('a malformed round is spent, not bounced', () => {
  // stop_reason "tool_use" with no tool_use block in it: the model asked for a
  // tool and named none. Nothing ran, so nothing was refused either — treating
  // that as a free bounce spins this loop against the same malformed turn for
  // another three rounds on the way to the same place.
  const stub = scriptedApi([{ blocks: [], stop: 'tool_use' }]);

  return chat(stub).then(() => {
    const cfg = loadConfig(ENV);
    assert.equal(
      stub.requests.length,
      cfg.MAX_TOOL_ITERATIONS + 1,
      `${stub.requests.length} requests: the budget should have gone straight down`,
    );
  });
});

test('a turn that still asks for tools with none offered is reported', () => {
  // The closing turn is a repair, not a guarantee. If it comes back asking for
  // a tool anyway, the rep is back to the old outcome — the model announcing
  // what it is about to build, and then nothing — so it still has to be said
  // out loud.
  return chat(scriptedApi([searchTurn], { closingAsksForTool: true })).then(({ text }) => {
    assert.match(text, /tool_budget_spent/);
    assert.match(text, /ask for the drafts in a second message/i);
  });
});
