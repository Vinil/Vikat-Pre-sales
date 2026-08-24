import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSystemPrompt, DISCLOSURE_TOPICS, DISCLOSURE_TAGS } from '../src/systemPrompt.js';
import { retrieve, retrievalStatus } from '../src/retrieve.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig({});
const REP = { email: 'rep@vikat.ai', name: 'Test Rep' };

async function prompt(sessionContext = {}) {
  return buildSystemPrompt(cfg, await retrieve('what does vshield do?', sessionContext), sessionContext);
}

// --- retrieve() -----------------------------------------------------------

test('retrieve returns a knowledge_base block', async () => {
  const block = await retrieve('anything');
  assert.match(block, /^<knowledge_base/);
  assert.match(block, /<\/knowledge_base>$/);
});

test('retrieve ignores the query in Tier A but accepts the Tier B signature', async () => {
  const a = await retrieve('pricing');
  const b = await retrieve('completely different question', { sessionId: 's', turnCount: 4 });
  assert.equal(a, b, 'Tier A returns the full KB regardless of query');
});

test('retrievalStatus reports the Vectorize trigger', () => {
  const s = retrievalStatus();
  assert.equal(typeof s.tokens, 'number');
  assert.ok(s.chunks > 0, 'the knowledge base should be populated');
  assert.equal(s.shouldUseVectorSearch, s.tokens > 50000);
});

// --- Identity -------------------------------------------------------------

test('the prompt establishes an internal audience', async () => {
  const p = await prompt();
  assert.match(p, /internal sales assistant for Vikat/);
  assert.match(p, /authenticated Vikat employee/);
  assert.match(p, /Never pitch Vikat to the person you are talking to/);
});

test('the prompt clears the agent to discuss internal topics', async () => {
  const p = await prompt();
  assert.match(p, /You are cleared to discuss internal material/);
  assert.match(p, /Refusing a rep is not caution, it is a failure/);
});

// --- The invention rule survived the pivot --------------------------------

test('the no-invention rule still holds for the internal audience', async () => {
  const p = await prompt();
  assert.match(p, /What you must still never do is invent/);
  assert.match(p, /Do not guess/);
  assert.match(p, /repeating an invented capability to a customer is worse/);
});

test('the prompt requires separating documented fact from inference', async () => {
  const p = await prompt();
  assert.match(p, /what is documented, what you are inferring, and what is missing/);
});

// --- Disclosure -----------------------------------------------------------

test('every disclosure tag reaches the prompt', async () => {
  const p = await prompt();
  for (const text of Object.values(DISCLOSURE_TAGS)) {
    assert.ok(p.includes(text), `disclosure tag missing from prompt: ${text}`);
  }
});

test('every disclosure topic reaches the prompt with its owner', async () => {
  const p = await prompt();
  assert.ok(DISCLOSURE_TOPICS.length >= 5, 'expected a meaningful disclosure list');
  for (const t of DISCLOSURE_TOPICS) {
    assert.ok(p.includes(t.label), `topic "${t.label}" is missing`);
    assert.ok(p.includes(t.owner), `owner "${t.owner}" is missing for ${t.label}`);
  }
});

test('every disclosure topic carries a valid tag', () => {
  const valid = Object.keys(DISCLOSURE_TAGS);
  for (const t of DISCLOSURE_TOPICS) {
    assert.ok(valid.includes(t.disclosure), `${t.id} has unknown disclosure "${t.disclosure}"`);
    assert.ok(t.guidance && t.guidance.length > 40, `${t.id} needs actionable guidance`);
  }
});

test('the prompt warns against over-tagging', async () => {
  const p = await prompt();
  assert.match(p, /over-tagging/i);
});

test('needs_approval topics route through their owner rather than being handed over', async () => {
  const p = await prompt();
  assert.match(p, /get sign-off before responding/);
  assert.match(p, /Do not simply hand over the material/);
});

// --- Tools ----------------------------------------------------------------

test('the prompt names the internal tools and their triggers', async () => {
  const p = await prompt();
  assert.match(p, /`log_prospect`/);
  assert.match(p, /`ask_expert`/);
  assert.match(p, /`flag_content_gap`/);
  assert.match(p, /Do not ask the rep for their own details/);
});

test('the persona no longer references prospect-facing tools', () => {
  // Scoped to the persona, not the whole prompt: "escalate" is ordinary security
  // prose that legitimately appears in the site copy ("before they escalate to
  // breaches"). Only a tool-call reference is a leftover, so match the backticked
  // form the prompt uses for tool names.
  const persona = buildSystemPrompt(cfg, '', {});
  for (const gone of ['capture_lead', 'request_meeting', 'escalate']) {
    assert.ok(
      !persona.includes(`\`${gone}\``),
      `\`${gone}\` is a leftover from the prospect-facing build`,
    );
  }
});

// --- Style ----------------------------------------------------------------

test('the prompt sets an internal, terse style', async () => {
  const p = await prompt();
  assert.match(p, /Lead with the answer/);
  assert.match(p, /Assume competence/);
  assert.match(p, /mid-call, be maximally terse/);
  assert.match(p, new RegExp(cfg.INTERNAL_HELP_CHANNEL));
});

test('the prompt carries the configured help channel, not a literal', async () => {
  const custom = loadConfig({ INTERNAL_HELP_CHANNEL: '#gtm-questions' });
  const p = buildSystemPrompt(custom, await retrieve('x'), {});
  assert.match(p, /#gtm-questions/);
  assert.ok(!p.includes('#sales-help'), 'the default must not leak past the override');
});

// --- Current user ---------------------------------------------------------

test('the signed-in rep is named in the prompt', async () => {
  const p = await prompt({ user: REP });
  assert.match(p, /<current_user>/);
  assert.match(p, /Test Rep \(rep@vikat\.ai\)/);
  assert.match(p, /Do not ask them to identify themselves/);
});

test('no current_user block when identity is absent', async () => {
  const p = await prompt({ sessionId: 's1' });
  assert.ok(!p.includes('<current_user>'));
});

// --- Prefix stability (prompt caching) ------------------------------------

test('the static persona is byte-identical across turns of a session', async () => {
  const a = await prompt({ user: REP, turnCount: 1 });
  const b = await prompt({ user: REP, turnCount: 9 });
  assert.equal(a, b, 'turnCount must not vary the prompt, or the cache prefix breaks every turn');
});

test('the per-user block is appended last, so the prefix is shared across reps', async () => {
  const a = await prompt({ user: { email: 'a@vikat.ai', name: 'A' } });
  const b = await prompt({ user: { email: 'b@vikat.ai', name: 'B' } });

  const marker = '<current_user>';
  assert.equal(
    a.slice(0, a.indexOf(marker)),
    b.slice(0, b.indexOf(marker)),
    'everything before the identity block must be identical for every rep',
  );
});

test('the prompt contains no timestamp or random value', async () => {
  const p = await prompt({ user: REP });
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(p), 'an ISO timestamp would invalidate the cache prefix');
});
