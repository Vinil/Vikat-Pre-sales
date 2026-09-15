import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSystemPrompt, systemBlocks, DISCLOSURE_TOPICS, DISCLOSURE_TAGS } from '../src/systemPrompt.js';
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

test('the prompt forbids inventing a link, not just inventing a fact', async () => {
  // find_collateral hands the rep something they will paste to a customer. A
  // fabricated SharePoint URL fails in the customer's browser, not the rep's.
  const p = await prompt({ user: REP });
  assert.match(p, /find_collateral/);
  assert.match(p, /Never construct a SharePoint URL/i);
  assert.match(p, /Only link to a document/i);
});

test('the prompt holds generated documents to a higher bar than chat', async () => {
  // A deck outlives the conversation and gets forwarded. The prompt has to say
  // so, or the model treats it like any other answer.
  const p = await prompt({ user: REP });
  assert.match(p, /create_document/);
  assert.match(p, /outlives this conversation/i);
  assert.match(p, /more restrictive/i);
});

test('the prompt knows the Collateral tab exists', async () => {
  // A rep asked what collateral we had and was told the assistant could not
  // see SharePoint. It can, and the answer was one tab away.
  const p = await prompt({ user: REP });
  assert.match(p, /Collateral tab/);
  assert.match(p, /empty query/i);
  assert.match(p, /Never tell a rep you cannot see what/i);
});

test('the prompt refuses to end a request with nothing offered', async () => {
  const p = await prompt({ user: REP });
  assert.match(p, /is not a dead\s*end/i);
});

test('the invention rules survive losing the tools', () => {
  // These landed after a transcript where the assistant correctly reported its
  // tools were down, then answered anyway: "I don't need to search — I already
  // have DevSemantic content in my knowledge base", naming a file no sync has
  // returned and describing an architecture no source states. Obeying the
  // outage notice and then routing around it is not a partial fix.
  const cfg = { INTERNAL_HELP_CHANNEL: '#sales-help', CONTACT_EMAIL: 'sales@vikat.ai' };

  for (const toolsAvailable of [true, false]) {
    const prompt = buildSystemPrompt(cfg, '<knowledge_base></knowledge_base>', {}, { toolsAvailable });
    const label = toolsAvailable ? 'with tools' : 'without tools';

    assert.match(prompt, /Never name a document that is not in front of you/, label);
    assert.match(prompt, /Never describe a product's architecture, integrations or partnerships/, label);
    assert.match(prompt, /Never state how many documents exist/, label);
    assert.match(prompt, /I do not need to search, I already know this/, label);
  }
});

test('the prompt says the card previews a post, and that a past refusal was wrong', async () => {
  // A rep asked three times to see how a post would look on LinkedIn. Three
  // times they were told "I genuinely cannot do this. I'm a text assistant" —
  // with the preview rendered on screen, on a deployed build that had it.
  //
  // Two separate things have to be said. That the card lays a post out as the
  // feed does, because the model cannot see it. And that a refusal ALREADY in
  // the transcript is not evidence, because the model's own turns outweigh a
  // rule every time: two confident refusals above kept it refusing a fourth.
  const text = await prompt();

  assert.match(text, /LinkedIn feed would draw\s+it/, 'the model is never told what the card does');
  assert.match(text, /Never tell a rep you cannot render, preview/);
  assert.match(text, /If you have already told this rep you cannot, you were wrong/);
  assert.match(text, /call \\?`draft_outreach\\?` for the posts/, 'the rule has to name the action');
});

// --- Prompt caching -------------------------------------------------------

test('the cache breakpoint sits on the part that never changes', async () => {
  // The knowledge base is 67,000 tokens and every turn re-sent all of it at
  // full price. A turn is not one request either: the tool loop runs up to
  // four, each carrying the whole thing again.
  const blocks = systemBlocks(cfg, await retrieve('x', {}), { user: REP });

  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral' });
  assert.equal(blocks[1].cache_control, undefined, 'a breakpoint on the volatile block caches nothing');
  assert.match(blocks[1].text, /<current_user>/);
  assert.doesNotMatch(blocks[0].text, /<current_user>/, 'the rep is named inside the cached prefix');
});

test('two reps share one cache entry, byte for byte', async () => {
  // THE invariant. Caching is a prefix match, so a single byte of difference
  // between two reps' prompts means a separate cache entry each — the write
  // premium paid per person and the shared prefix never read. The rep's name
  // is the only thing that differs and it has to be after the breakpoint.
  const knowledge = await retrieve('x', {});
  const a = systemBlocks(cfg, knowledge, { user: { email: 'ana@vikat.ai', name: 'Ana' } });
  const b = systemBlocks(cfg, knowledge, { user: { email: 'bo@vikat.ai', name: 'Bo' } });

  assert.equal(a[0].text, b[0].text);
  assert.notEqual(a[1].text, b[1].text, 'then the per-user block is not doing its job');
});

test('an anonymous turn still caches, with no empty block', async () => {
  // /admin/upstream probes with no user. An empty text block is a 400.
  const blocks = systemBlocks(cfg, await retrieve('x', {}), {});

  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral' });
});

test('the cached prefix is over the minimum that can be cached', async () => {
  // Sonnet 4.6 silently refuses to cache a prefix under 1024 tokens — no
  // error, just cache_creation_input_tokens: 0. Four chars per token is rough
  // and deliberately pessimistic; the real prefix is far larger.
  const blocks = systemBlocks(cfg, await retrieve('x', {}), { user: REP });
  assert.ok(blocks[0].text.length / 4 > 1024, `prefix is only ~${Math.round(blocks[0].text.length / 4)} tokens`);
});

test('the string form still reads as one prompt', async () => {
  // buildSystemPrompt is what /admin/upstream and every other caller use, and
  // splitting the blocks must not change what the model is told.
  const one = buildSystemPrompt(cfg, await retrieve('x', {}), { user: REP });
  const blocks = systemBlocks(cfg, await retrieve('x', {}), { user: REP });

  assert.equal(one, blocks.map((b) => b.text).join('\n\n'));
});

test('the articulation block reaches the prompt, on every turn', async () => {
  // Same principle as the guidelines check: a component nothing invokes is a
  // file. Voice governs chat answers, emails, posts and slides alike, so it
  // sits in the persona rather than in any one section — and the persona is
  // the cached prefix, so it costs nothing to carry.
  const text = await prompt();

  assert.match(text, /## How it has to read/);
  assert.match(text, /must not read as though a machine wrote it/);
  assert.match(text, /pick the shorter, plainer option/);
});

test('the voice rules are in the CACHED half of the prompt', async () => {
  // If they landed after the breakpoint they would be re-billed every turn for
  // text that never changes.
  const blocks = systemBlocks(cfg, await retrieve('x', {}), { user: REP });
  assert.match(blocks[0].text, /## How it has to read/);
});
