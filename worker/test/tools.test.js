import test from 'node:test';
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
  // Strict is the default and the safe choice. create_document is the one
  // exception: its schema nests objects inside an array, which exceeds the
  // grammar-compilation budget and gets the WHOLE request rejected with
  // "Schema is too complex" — breaking every conversation, including ones
  // that never touch the tool. Its handler runs normaliseSpec() instead.
  const VALIDATES_ITS_OWN_INPUT = new Set(['create_document']);

  for (const t of TOOL_DEFINITIONS) {
    if (VALIDATES_ITS_OWN_INPUT.has(t.name)) {
      assert.notEqual(t.strict, true, `${t.name} is exempt and must not re-enable strict`);
      continue;
    }
    assert.equal(t.strict, true, `${t.name} must set strict, or be listed as validating its own input`);
  }
});

test('no strict tool nests an object inside an array', () => {
  // The shape that blew the complexity budget. Cheap to check, and the
  // failure it prevents is total: not a degraded tool, a dead assistant.
  const nestsObjects = (node) => {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'array' && node.items && node.items.type === 'object') return true;
    return Object.values(node).some(nestsObjects);
  };

  for (const t of TOOL_DEFINITIONS) {
    if (!t.strict) continue;
    assert.ok(
      !nestsObjects(t.input_schema),
      `${t.name} is strict and nests objects in an array — the API will reject every request`,
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
