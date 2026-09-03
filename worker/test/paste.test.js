/**
 * Pasting something long, and researching a prospect.
 *
 * The limit was 8000 characters, which is most of an RFP short of the part
 * that matters. A rep pasting one got a rejection; a textarea with maxlength
 * would have done something worse and truncated it silently, leaving the
 * assistant to answer confidently from half a document.
 *
 * Removing a limit means owning what it was holding back, so the failure it
 * now permits — a conversation outgrowing the model's context — has to arrive
 * as advice a rep can act on rather than "Something went wrong. Retry."
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import worker from '../src/index.js';
import { loadConfig } from '../src/config.js';
import { buildSystemPrompt } from '../src/systemPrompt.js';
import { fakeKV } from './helpers.js';

const ENV = {
  AUTH_MODE: 'dev',
  ALLOW_DEV_AUTH: 'true',
  BOOTSTRAP_ADMINS: 'boss@vikat.ai',
  ANTHROPIC_API_KEY: 'test-key',
};

const env = () => ({ ...ENV, VIKAT_KV: fakeKV() });

/** An API that rejects the way it rejects an over-long conversation. */
function apiRejecting(message) {
  return async (url) => {
    if (!String(url).includes('api.anthropic.com')) return { ok: false, status: 404, text: async () => 'no' };
    const body = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } });
    return {
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  };
}

async function chat(stub, content, environment = env()) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    const res = await worker.fetch(
      new Request('https://x.test/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Dev-User': 'rep@vikat.ai' },
        body: JSON.stringify({ sessionId: 'abcd1234efgh', messages: [{ role: 'user', content }] }),
      }),
      environment,
      { waitUntil() {} },
    );
    return { status: res.status, text: await res.text() };
  } finally {
    globalThis.fetch = original;
  }
}

// --- the limit -------------------------------------------------------------

test('a whole RFP can be pasted', async () => {
  // 8000 characters was the old ceiling. An RFP, an email chain, a call
  // transcript are all routinely longer.
  const cfg = loadConfig({});
  assert.ok(cfg.MAX_CHARS_PER_MESSAGE >= 100000, `still capped at ${cfg.MAX_CHARS_PER_MESSAGE}`);
});

test('the widget does not silently truncate what a rep pastes', () => {
  // A maxlength on the textarea is worse than a server rejection: the paste
  // LOOKS complete, and the answer is confidently based on part of it.
  const widget = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../widget/vikat-chat.js'),
    'utf8',
  );
  assert.ok(
    !/setAttribute\(\s*['"]maxlength['"]/.test(widget),
    'the composer must not cap the paste',
  );
});

test('a conversation that outgrows the context says what to do about it', async () => {
  // The failure removing the limit permits. "Retry" cannot work — the retry
  // sends the same oversized conversation again.
  const { status, text } = await chat(
    apiRejecting('prompt is too long: 250000 tokens > 200000 maximum'),
    'a very long paste',
  );

  assert.equal(status, 200);
  assert.match(text, /context_full/);
  assert.match(text, /Start a new chat/i);
  assert.ok(!/Retry, and if it persists/.test(text), 'advice that cannot work is worse than none');
});

test('an ordinary upstream failure still reads as one', async () => {
  // The overflow branch must not swallow every other 400 — that would turn a
  // real bug into misdirection.
  const { text } = await chat(apiRejecting('something else entirely went wrong'), 'hi');
  assert.match(text, /upstream_error/);
});

// --- the research play -----------------------------------------------------

// Collapsed, because the prompt is hard-wrapped prose: a rule that reads
// correctly can still sit across a newline, and a test that fails on the wrap
// is testing the line width rather than the rule.
const prompt = () => buildSystemPrompt(loadConfig(ENV), '<knowledge/>').replace(/\s+/g, ' ');

test('the prompt defines a trigger as something that changed', () => {
  // Without this the model calls "they are a large manufacturer" a trigger,
  // which was true last year and gives the reader no reason to answer today.
  assert.match(prompt(), /something that CHANGED/i);
  assert.match(prompt(), /is not a trigger/i);
});

test('the prompt refuses to invent a trigger when there is none', () => {
  // A rep who knows there is no trigger writes a better email than one handed
  // a manufactured urgency.
  assert.match(prompt(), /Do not invent a trigger/i);
});

test('the prompt puts the prospect before the pitch', () => {
  // The three moves, in order. Anchored on the numbering rather than the
  // phrases: "Vikat capability" appears in the research section too, and
  // indexOf would find that earlier occurrence and prove nothing.
  const p = prompt();
  const moves = p.slice(p.indexOf('Three moves'));

  assert.ok(moves.indexOf('1. **Their world') < moves.indexOf('2. **The consequence'), 'order is the play');
  assert.ok(moves.indexOf('2. **The consequence') < moves.indexOf('3. **The Vikat capability'));
  assert.match(p, /Personalisation is specificity, not flattery/i);
});

test('the prompt keeps LinkedIn from being email in a smaller box', () => {
  const p = prompt();
  assert.match(p, /300 characters, hard/i);
  assert.match(p, /POST is public/i);
});

test('the prompt forbids markdown in a draft', () => {
  // It is going into an email client, where asterisks show up as asterisks.
  assert.match(prompt(), /Never markdown/i);
});

test('with no tools, the prompt does not describe writing drafts', () => {
  // The bug this repeats: the tool left the request while the prompt still
  // described it, and the model imitated a call in visible text.
  const p = buildSystemPrompt(loadConfig(ENV), '<knowledge/>', {}, { toolsAvailable: false });
  assert.ok(!/draft_outreach/.test(p));
});
