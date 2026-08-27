import test from 'node:test';
import { schemaCost } from '../src/toolHealth.js';
import assert from 'node:assert/strict';

import { TOOL_DEFINITIONS, runTool } from '../src/tools.js';
import { loadConfig } from '../src/config.js';
import { fakeStorage, stubFetch } from './helpers.js';

const cfg = loadConfig({ LEAD_SINK: 'webhook', LEAD_WEBHOOK_URL: 'https://hooks.example/lead' });

const REP = { email: 'rep@vikat.ai', name: 'Test Rep', sub: 'user-123' };

function ctx(storage = fakeStorage()) {
  return { sessionId: 'sess1234abcd', user: REP, storage, env: {}, cfg };
}

async function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// --- Definitions ----------------------------------------------------------

test('the internal tool set is defined', () => {
  assert.deepEqual(
    TOOL_DEFINITIONS.map((t) => t.name).sort(),
    ['ask_expert', 'create_document', 'find_collateral', 'flag_content_gap', 'log_prospect'],
  );
});

test('the prospect-facing tools are gone', () => {
  const names = TOOL_DEFINITIONS.map((t) => t.name);
  for (const removed of ['capture_lead', 'request_meeting', 'escalate']) {
    assert.ok(!names.includes(removed), `${removed} belongs to the prospect-facing build`);
  }
});

test('every tool schema is closed and fully required', () => {
  // True whether or not a tool is strict: a closed, fully-required schema is
  // what stops the model inventing fields, and strict mode additionally
  // guarantees it.
  for (const t of TOOL_DEFINITIONS) {
    assert.equal(t.input_schema.additionalProperties, false, `${t.name} must be closed`);
    const props = Object.keys(t.input_schema.properties);
    assert.deepEqual(
      [...t.input_schema.required].sort(),
      props.sort(),
      `${t.name}: every property belongs in \`required\``,
    );
    assert.ok(t.description.length > 40, `${t.name} needs a usable description`);
  }
});

test('a tool is strict unless its handler validates the input itself', () => {
  // Strict is the default and the safe choice. Two tools are exempt, both
  // because `strict` put them over the grammar-compilation budget and got the
  // WHOLE request rejected with "Schema is too complex" — breaking every
  // conversation, including ones that never touched the tool.
  //
  // create_document runs normaliseSpec(); log_prospect runs
  // normaliseProspect(). An exemption is a debt, not a shortcut: whatever
  // strict would have guaranteed, the handler now owes.
  const VALIDATES_ITS_OWN_INPUT = new Set(['create_document', 'log_prospect']);

  for (const t of TOOL_DEFINITIONS) {
    if (VALIDATES_ITS_OWN_INPUT.has(t.name)) {
      assert.notEqual(t.strict, true, `${t.name} is exempt and must not re-enable strict`);
      continue;
    }
    assert.equal(t.strict, true, `${t.name} must set strict, or be listed as validating its own input`);
  }
});

test('no tool schema nests an object inside an array', () => {
  // A shape that blew the complexity budget. Checked for EVERY tool, not just
  // the strict ones, because nesting is expensive on its own — though the
  // claim once written here, that dropping `strict` does not help, turned out
  // to be wrong: create_document is the largest schema in the file and passes
  // precisely because it is not strict. The nesting still costs,
  // and the failure it causes is total, not degraded: "Schema is too complex"
  // rejects the whole request, so one over-ambitious tool kills every
  // conversation including the ones that never touch it.
  const nestsObjects = (node) => {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'array' && node.items && node.items.type === 'object') return true;
    return Object.values(node).some(nestsObjects);
  };

  for (const t of TOOL_DEFINITIONS) {
    assert.ok(
      !nestsObjects(t.input_schema),
      `${t.name} nests objects in an array — the API will reject every request`,
    );
  }
});

test('every tool schema stays within a property budget', () => {
  // A proxy, not the real limit — the real one is enforced server-side and has
  // no local equivalent. But the outage came from a schema that grew without
  // anything noticing, so a ceiling that forces a deliberate decision is worth
  // more than an exact number would be.
  const MAX_PROPERTIES_PER_TOOL = 12;
  const MAX_DEPTH = 2;

  const depthOf = (node, depth = 1) => {
    if (!node || typeof node !== 'object') return depth;
    return Math.max(
      depth,
      ...Object.values(node.properties || {}).map((v) => depthOf(v, depth + 1)),
      ...(node.items ? [depthOf(node.items, depth + 1)] : []),
    );
  };

  for (const t of TOOL_DEFINITIONS) {
    const count = Object.keys(t.input_schema.properties || {}).length;
    assert.ok(
      count <= MAX_PROPERTIES_PER_TOOL,
      `${t.name} has ${count} properties; keep it under ${MAX_PROPERTIES_PER_TOOL} or move structure into one string field`,
    );
    assert.ok(
      depthOf(t.input_schema) <= MAX_DEPTH + 1,
      `${t.name} nests ${depthOf(t.input_schema)} levels deep; flatten it`,
    );
  }
});

test('no tool asks the rep for their own identity', () => {
  for (const t of TOOL_DEFINITIONS) {
    const props = Object.keys(t.input_schema.properties);
    for (const p of props) {
      assert.ok(
        !['name', 'email', 'your_email', 'rep_email'].includes(p),
        `${t.name}.${p} would make the agent ask a signed-in rep who they are`,
      );
    }
  }
});

test('qualification_score is constrained to the three scores', () => {
  const logProspect = TOOL_DEFINITIONS.find((t) => t.name === 'log_prospect');
  assert.deepEqual(logProspect.input_schema.properties.qualification_score.enum, ['HOT', 'WARM', 'COLD']);
});

// --- log_prospect ---------------------------------------------------------

const fullProspect = {
  prospect_name: 'Ada Lovelace',
  prospect_email: 'ada@example.com',
  company: 'Analytical Engines',
  role: 'Head of Security',
  use_case: 'Securing MCP servers exposed to internal agents.',
  environment: 'AWS, Splunk, piloting agents in production.',
  timeline: 'Pilot in Q1, production by mid-year.',
  qualification_score: 'HOT',
  qualification_notes: 'Named problem, owns budget, hard Q1 deadline.',
};

test('log_prospect records the prospect and attributes it to the rep', async () => {
  const storage = fakeStorage();
  const fetchStub = stubFetch();

  const result = await withFetch(fetchStub, () =>
    runTool({ name: 'log_prospect', input: fullProspect }, ctx(storage)),
  );

  assert.ok(!result.isError);
  assert.equal(storage.leads.length, 1);

  const rec = storage.leads[0];
  assert.equal(rec.prospect_email, 'ada@example.com', 'the prospect is the subject');
  assert.equal(rec.loggedBy, 'rep@vikat.ai', 'the rep is the author');
  assert.equal(rec.source, 'internal_sales_assistant');
  assert.equal(result.effect.score, 'HOT');
});

test('log_prospect drops nulls the model sent for unknown fields', async () => {
  const storage = fakeStorage();
  const input = { ...fullProspect, company: null, role: null, timeline: null, environment: null };

  await withFetch(stubFetch(), () => runTool({ name: 'log_prospect', input }, ctx(storage)));

  const rec = storage.leads[0];
  assert.ok(!('company' in rec));
  assert.ok(!('environment' in rec));
  assert.equal(rec.prospect_name, 'Ada Lovelace');
  assert.equal(rec.loggedBy, 'rep@vikat.ai', 'attribution survives compaction');
});

test('log_prospect survives a delivery failure without losing the record', async () => {
  const storage = fakeStorage();
  const failing = stubFetch({ ok: false, status: 500, body: 'boom' });

  const result = await withFetch(failing, () =>
    runTool({ name: 'log_prospect', input: fullProspect }, ctx(storage)),
  );

  assert.ok(!result.isError, 'the rep keeps working');
  assert.equal(storage.leads.length, 1, 'the durable copy is written regardless');
  assert.equal(result.effect.delivered, false);
  assert.match(result.content, /record is saved/);
});

// --- ask_expert -----------------------------------------------------------

test('ask_expert routes to the named owner and records the request', async () => {
  const storage = fakeStorage();
  const fetchStub = stubFetch();

  const result = await withFetch(fetchStub, () =>
    runTool(
      {
        name: 'ask_expert',
        input: {
          owner: 'Security',
          question: 'Do we have a completed SIG Lite we can share under NDA?',
          context: 'Acme, late-stage, security review is the last gate.',
          urgency: 'this_week',
        },
      },
      ctx(storage),
    ),
  );

  assert.equal(result.effect.owner, 'Security');
  assert.match(result.content, /Routed to Security/);
  assert.equal(storage.leads.length, 1, 'persisted so it survives a delivery failure');

  const sent = JSON.parse(fetchStub.calls[0].init.body);
  assert.equal(sent.requestedBy, 'rep@vikat.ai');
  assert.equal(sent.urgent, false, 'this_week is not an interrupt');
});

test('ask_expert flags a blocking request as urgent', async () => {
  const fetchStub = stubFetch();
  const result = await withFetch(fetchStub, () =>
    runTool(
      {
        name: 'ask_expert',
        input: {
          owner: 'Deal Desk',
          question: 'Can I go below floor on a 3-year commit?',
          context: 'Customer is on the call now.',
          urgency: 'blocking_a_call',
        },
      },
      ctx(),
    ),
  );

  assert.equal(JSON.parse(fetchStub.calls[0].init.body).urgent, true);
  assert.match(result.content, /blocking a call/);
  assert.match(result.content, /holding answer/, 'the rep is mid-call and needs something now');
});

// --- flag_content_gap -----------------------------------------------------

test('flag_content_gap records the gap without treating it as urgent', async () => {
  const storage = fakeStorage();
  const fetchStub = stubFetch();

  const result = await withFetch(fetchStub, () =>
    runTool(
      {
        name: 'flag_content_gap',
        input: {
          question: 'Which SIEMs does VCommand integrate with?',
          gap_type: 'too_shallow',
          details: 'The product page names categories but not specific SIEM products.',
        },
      },
      ctx(storage),
    ),
  );

  assert.equal(result.effect.gapType, 'too_shallow');
  assert.equal(storage.leads.length, 1);
  assert.match(storage.leads[0].use_case, /CONTENT GAP \(too_shallow\)/);

  const sent = JSON.parse(fetchStub.calls[0].init.body);
  assert.equal(sent.kind, 'content_gap');
  assert.equal(sent.urgent, false, 'a gap is a backlog item, not an interrupt');
  assert.equal(sent.reportedBy, 'rep@vikat.ai');
});

test('flag_content_gap tells the model not to apologise twice', async () => {
  const result = await withFetch(stubFetch(), () =>
    runTool(
      {
        name: 'flag_content_gap',
        input: { question: 'q', gap_type: 'missing', details: 'd' },
      },
      ctx(),
    ),
  );
  assert.match(result.content, /do not apologise again/i);
});

// --- Failure modes --------------------------------------------------------

test('an unknown tool name is reported as an error, not thrown', async () => {
  const result = await runTool({ name: 'drop_database', input: {} }, ctx());
  assert.equal(result.isError, true);
  assert.match(result.content, /Unknown tool/);
});

test('a storage failure degrades to a graceful tool error naming the help channel', async () => {
  const broken = {
    ...fakeStorage(),
    saveLead: async () => {
      throw new Error('KV down');
    },
  };
  const result = await runTool({ name: 'log_prospect', input: fullProspect }, ctx(broken));

  assert.equal(result.isError, true);
  assert.match(result.content, /Do not retry/);
  assert.match(result.content, new RegExp(cfg.INTERNAL_HELP_CHANNEL));
});

test('a missing user does not crash tool execution', async () => {
  const storage = fakeStorage();
  const result = await withFetch(stubFetch(), () =>
    runTool(
      { name: 'log_prospect', input: fullProspect },
      { sessionId: 'sess1234abcd', user: undefined, storage, env: {}, cfg },
    ),
  );
  assert.ok(!result.isError);
  assert.equal(storage.leads[0].loggedBy, 'unknown');
});

// --- Schema validity ------------------------------------------------------
// The API validates tool schemas on every request, so one malformed tool
// breaks every conversation — including "hi", which touches no tool at all.
// Structure is checked here rather than discovered in production.

/** Walk every object schema, at every depth. */
function objectSchemas(schema, path = 'input_schema', found = []) {
  if (!schema || typeof schema !== 'object') return found;

  if (schema.type === 'object' || schema.properties) found.push({ path, schema });

  for (const [key, value] of Object.entries(schema.properties || {})) {
    objectSchemas(value, `${path}.${key}`, found);
  }
  if (schema.items) objectSchemas(schema.items, `${path}[]`, found);

  return found;
}

test('every object in a strict schema is closed and fully required', () => {
  // Strict mode requires additionalProperties:false and every property listed
  // in `required` — at EVERY level, not just the top. A nested object that
  // misses either is rejected with a 400 that names the tool, not the level.
  for (const tool of TOOL_DEFINITIONS) {
    if (!tool.strict) continue;

    for (const { path, schema } of objectSchemas(tool.input_schema)) {
      assert.equal(
        schema.additionalProperties,
        false,
        `${tool.name} ${path} must set additionalProperties: false`,
      );

      const properties = Object.keys(schema.properties || {});
      assert.deepEqual(
        [...(schema.required || [])].sort(),
        properties.sort(),
        `${tool.name} ${path}: strict mode requires every property in \`required\``,
      );
    }
  }
});

test('no tool schema uses a keyword the Messages API will not accept', () => {
  // JSON Schema is larger than what the API takes. These are the ones a model
  // reaches for by habit and which fail validation.
  const REJECTED = ['$ref', '$defs', 'definitions', 'allOf', 'anyOf', 'oneOf', 'not', 'patternProperties'];

  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    for (const keyword of REJECTED) {
      assert.ok(!(keyword in node), `${path} uses unsupported keyword "${keyword}"`);
    }
    for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
  };

  for (const tool of TOOL_DEFINITIONS) walk(tool.input_schema, tool.name);
});

test('every enum value is a plain string the model can emit', () => {
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.enum)) {
      assert.ok(node.enum.length > 0, `${path} has an empty enum`);
      for (const value of node.enum) {
        assert.equal(typeof value, 'string', `${path} enum contains a non-string`);
      }
    }
    for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
  };

  for (const tool of TOOL_DEFINITIONS) walk(tool.input_schema, tool.name);
});

test('no strict tool schema uses a union type', () => {
  // The bug that took every conversation down for days, twice misdiagnosed.
  //
  // `strict` compiles the schema into a constrained-decoding grammar, where the
  // expensive thing is branching rather than size. log_prospect carried six
  // `type: ['string', 'null']` properties — 64 admissible shapes in one tool —
  // and the API answered "Schema is too complex." on EVERY request, including
  // ones that never touched a tool. The schemas looked innocent by every
  // measure I checked first: depth 1, 23 properties, 5KB.
  //
  // Express "unknown" as an empty string instead. compact() drops blanks, so
  // the record is identical.
  for (const tool of TOOL_DEFINITIONS) {
    if (!tool.strict) continue;
    for (const [name, prop] of Object.entries(tool.input_schema.properties || {})) {
      assert.ok(
        !Array.isArray(prop.type),
        `${tool.name}.${name} is a union type (${JSON.stringify(prop.type)}) in a strict schema — ` +
          'use a single type and treat an empty string as absent',
      );
    }
  }
});

test('the shed order puts the most expensive schema first', () => {
  // Not a style preference: shedding cheap tools first means several more
  // round trips before the offending one goes, and each round trip is a failed
  // request a rep is waiting on.
  const costs = TOOL_DEFINITIONS.map((t) => ({ name: t.name, cost: schemaCost(t) }));
  for (const { name, cost } of costs) {
    assert.ok(Number.isFinite(cost) && cost > 0, `${name} should have a measurable cost`);
  }

  // A union type must dominate a plain property, or the heuristic would not
  // have found the tool that actually broke production.
  const plain = { input_schema: { properties: { a: { type: 'string' } } } };
  const union = { input_schema: { properties: { a: { type: ['string', 'null'] } } } };
  assert.ok(schemaCost(union) > schemaCost(plain), 'a union must cost more than a plain string');
});

test('a strict schema stays inside the budget that production actually accepts', () => {
  // The tripwire that would have saved three deploys.
  //
  // "Schema is too complex." names nothing and rejects the entire request, so
  // it cannot be diagnosed from the error. What it CAN be measured against is
  // the deployed Worker's own behaviour, which gave a clean natural experiment:
  //
  //   create_document  NOT strict  6 props  1755 bytes  accepted
  //   log_prospect     strict      9 props  1472 bytes  REFUSED
  //   ask_expert       strict      4 props   757 bytes  accepted
  //
  // The largest schema in the file passes and a smaller one fails, so size is
  // not the axis — `strict` is the multiplier, and the budget for a strict
  // schema sits somewhere above 4 properties and below 9.
  //
  // These bounds are empirical, not documented, and they are a floor rather
  // than a guarantee: the API may move them. If this test fails on a schema
  // that production accepts, re-measure and raise it. If production refuses a
  // schema this test passed, lower it — and trust the deployment, not the
  // number.
  const MAX_STRICT_PROPS = 6;
  const MAX_STRICT_BYTES = 1000;

  for (const tool of TOOL_DEFINITIONS) {
    if (!tool.strict) continue;
    const props = Object.keys(tool.input_schema.properties || {}).length;
    const bytes = JSON.stringify(tool.input_schema).length;

    assert.ok(
      props <= MAX_STRICT_PROPS,
      `${tool.name} is strict with ${props} properties (budget ${MAX_STRICT_PROPS}). ` +
        'Either drop strict and validate in the handler, or split the tool.',
    );
    assert.ok(
      bytes <= MAX_STRICT_BYTES,
      `${tool.name} is strict with a ${bytes}-byte schema (budget ${MAX_STRICT_BYTES}). ` +
        'Either drop strict and validate in the handler, or shorten the descriptions.',
    );
  }
});

// --- log_prospect without strict ------------------------------------------

test('an unknown key from the model never reaches the pipeline record', async () => {
  // strict used to guarantee this. Dropping it moved the obligation to the
  // handler, and a record is not a chat message — it is read later by someone
  // deciding what to do about a deal.
  const storage = fakeStorage();
  const r = await runTool(
    {
      name: 'log_prospect',
      input: {
        company: 'Acme',
        use_case: 'agent security',
        qualification_score: 'HOT',
        qualification_notes: 'Named a budget.',
        // None of these are in the schema.
        internal_note: 'ignore me',
        __proto__: 'nope',
        loggedBy: 'attacker@evil.test',
      },
    },
    ctx(storage),
  );

  assert.ok(!r.isError);
  const saved = storage.leads[0];
  assert.equal(saved.company, 'Acme');
  assert.ok(!('internal_note' in saved), 'an unknown key must be dropped');
  assert.equal(
    saved.loggedBy,
    'rep@vikat.ai',
    'the rep is the owner of the record and the model must not be able to set it',
  );
});

test('a junk qualification_score is corrected, not stored', async () => {
  const storage = fakeStorage();
  const r = await runTool(
    {
      name: 'log_prospect',
      input: { use_case: 'x', qualification_score: 'SCORCHING', qualification_notes: 'Keen.' },
    },
    ctx(storage),
  );

  assert.ok(!r.isError);
  const saved = storage.leads[0];
  assert.equal(saved.qualification_score, 'WARM', 'an unrecognised score falls back to the middle');
  assert.match(
    saved.qualification_notes,
    /SCORCHING/,
    'and the original is kept in the notes rather than silently discarded',
  );
});

test('a lowercase score is accepted rather than downgraded', async () => {
  // Without strict the model is no longer constrained to the enum's casing,
  // and treating "hot" as junk would quietly cool every lead it scored.
  const storage = fakeStorage();
  await runTool(
    {
      name: 'log_prospect',
      input: { use_case: 'x', qualification_score: '  hot ', qualification_notes: 'n' },
    },
    ctx(storage),
  );

  assert.equal(storage.leads[0].qualification_score, 'HOT');
});
