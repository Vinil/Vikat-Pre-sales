/**
 * The banner on a LinkedIn post.
 *
 * Two things are load-bearing and neither is obvious from the code alone: the
 * model is asked for a BACKGROUND and never for text, and a failed banner must
 * never cost the rep the post.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { generateImage, toPrompt, monthlyAllowance } from '../src/imageGen.js';
import { loadConfig } from '../src/config.js';
import { createStorage } from '../src/storage.js';
import { fakeKV } from './helpers.js';

const cfg = loadConfig({});
const USER = { email: 'rep@vikat.ai' };
const BRIEF = 'An engineer in hi-vis at a server rack, cool blue light.';

function ctx(env = { OPENAI_API_KEY: 'sk-openai-test' }, over = {}) {
  return {
    env,
    cfg: { ...cfg, ...over },
    storage: createStorage({ VIKAT_KV: fakeKV() }, cfg),
    user: USER,
  };
}

/** A 1x1 PNG, base64, which is all any of this needs to be real bytes. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function withFetch(stub, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const returns = (body, status = 200) => async () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('the model is told not to draw text, because it cannot', () => {
  // The whole design rests on this. Ask an image model for a set headline and
  // it returns confident gibberish that looks fine as a thumbnail and is
  // unusable at full size. The headline is drawn over the picture afterwards,
  // so any lettering the model invents would collide with it.
  const p = toPrompt(BRIEF);

  assert.match(p, /NO text/);
  assert.match(p, /NO logos/);
  assert.match(p, /set over this/, 'the model is told WHY, not just told no');
  // And the brief itself survives: this is a scene written by the assistant
  // that knows the campaign, and paraphrasing it here would be a second author
  // with less context.
  assert.ok(p.startsWith(BRIEF));
});

test('the budget is converted to a count of images', () => {
  // KV counts images; the agreement was in dollars.
  assert.equal(monthlyAllowance({ IMAGE_MONTHLY_BUDGET_USD: 100, IMAGE_COST_USD: 0.08 }), 1250);
  // A missing or nonsense cost must not become an infinite allowance.
  assert.equal(monthlyAllowance({ IMAGE_MONTHLY_BUDGET_USD: 100, IMAGE_COST_USD: 0 }), 0);
  assert.equal(monthlyAllowance({ IMAGE_MONTHLY_BUDGET_USD: 100 }), 0);
});

test('a banner is made, stored, and served from this app', async () => {
  const c = ctx();
  const out = await withFetch(returns({ data: [{ b64_json: PNG }] }), () =>
    generateImage(BRIEF, c),
  );

  assert.equal(out.ok, true);
  assert.match(out.url, /^\/document\/doc_[a-f0-9]{16}$/, 'the reader only embeds this shape');

  // Stored as a real PNG under the same route and expiry as a generated deck.
  const doc = await c.storage.getDocument(out.url.slice('/document/'.length));
  assert.equal(doc.contentType, 'image/png');
  assert.ok(doc.bytes.byteLength > 0);
  assert.match(doc.disclosure, /Check it before posting/, 'a generated image needs saying so');
});

test('the request carries the configured size and quality, not defaults', async () => {
  // Quality is the biggest lever on what one image costs, so a silent fall
  // back to "high" is a budget decision nobody made.
  let sent;
  await withFetch(
    async (url, init) => {
      sent = { url: String(url), body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ data: [{ b64_json: PNG }] }), { status: 200 });
    },
    () => generateImage(BRIEF, ctx()),
  );

  assert.match(sent.url, /api\.openai\.com/);
  assert.equal(sent.body.model, 'gpt-image-1');
  assert.equal(sent.body.size, '1536x1024');
  assert.equal(sent.body.quality, 'medium');
  assert.equal(sent.body.n, 1);
});

test('the monthly pot is shared, and running out is not an error', async () => {
  // Two images of budget, three asks. The third is refused by us, before any
  // money is spent, and says what a rep should do about it.
  const c = ctx(undefined, { IMAGE_MONTHLY_BUDGET_USD: 0.16, IMAGE_COST_USD: 0.08 });
  const stub = returns({ data: [{ b64_json: PNG }] });

  const a = await withFetch(stub, () => generateImage(BRIEF, c));
  const b = await withFetch(stub, () => generateImage(BRIEF, c));
  let calls = 0;
  const third = await withFetch(
    async (...args) => {
      calls += 1;
      return stub(...args);
    },
    () => generateImage(BRIEF, c),
  );

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(third.ok, false);
  assert.equal(calls, 0, 'a spent budget must not reach the provider at all');
  assert.match(third.reason, /budget/);
  assert.match(third.reason, /The post is unaffected/, 'a rep needs to know the campaign survives');
});

test('no key is reported as configuration, not as a failure', async () => {
  // A rep reading this should hand it to an admin rather than retry it.
  const out = await generateImage(BRIEF, ctx({}));

  assert.equal(out.ok, false);
  assert.match(out.reason, /No image provider key is configured/);
});

test('a refusal from the provider never reaches the rep verbatim', async () => {
  // "invalid_request_error" is an admin's problem and a rep can do nothing
  // with it. It goes to the log; the rep gets a sentence they can act on.
  const out = await withFetch(
    returns({ error: { type: 'invalid_request_error', message: 'content_policy_violation' } }, 400),
    () => generateImage(BRIEF, ctx()),
  );

  assert.equal(out.ok, false);
  assert.doesNotMatch(out.reason, /invalid_request_error|content_policy/);
  assert.match(out.reason, /the brief is all there is/);
});

test('an unreachable provider does not throw', async () => {
  // A campaign is not worth losing over a picture. generateImage reports; the
  // tool turns that into a warning and the post goes out regardless.
  const out = await withFetch(
    async () => {
      throw new Error('connection reset');
    },
    () => generateImage(BRIEF, ctx()),
  );

  assert.equal(out.ok, false);
  assert.match(out.reason, /could not be reached/);
});

test('a 200 with no image in it is caught', async () => {
  const out = await withFetch(returns({ data: [] }), () => generateImage(BRIEF, ctx()));

  assert.equal(out.ok, false);
  assert.match(out.reason, /nothing usable/);
});

test('generation can be switched off without touching a key', async () => {
  let calls = 0;
  const out = await withFetch(
    async () => {
      calls += 1;
      return new Response('{}', { status: 200 });
    },
    () => generateImage(BRIEF, ctx(undefined, { IMAGE_GENERATION: 'off' })),
  );

  assert.equal(out.ok, false);
  assert.equal(calls, 0);
  assert.match(out.reason, /switched off/);
});
