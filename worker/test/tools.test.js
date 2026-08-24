import test from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_DEFINITIONS, runTool } from '../src/tools.js';
import { loadConfig } from '../src/config.js';
import { fakeStorage, stubFetch } from './helpers.js';

const cfg = loadConfig({ LEAD_SINK: 'webhook', LEAD_WEBHOOK_URL: 'https://hooks.example/lead' });

function ctx(storage = fakeStorage()) {
  return { sessionId: 'sess1234abcd', storage, env: {}, cfg };
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

test('all three tools are defined', () => {
  assert.deepEqual(
    TOOL_DEFINITIONS.map((t) => t.name).sort(),
    ['capture_lead', 'escalate', 'request_meeting'],
  );
});

test('every tool schema is strict and closed', () => {
  for (const t of TOOL_DEFINITIONS) {
    assert.equal(t.strict, true, `${t.name} must set strict`);
    assert.equal(t.input_schema.additionalProperties, false, `${t.name} must be closed`);
    // strict mode requires every property to appear in `required`.
    const props = Object.keys(t.input_schema.properties);
    assert.deepEqual(
      [...t.input_schema.required].sort(),
      props.sort(),
      `${t.name}: required must list every property`,
    );
    assert.ok(t.description.length > 40, `${t.name} needs a usable description`);
  }
});

test('qualification_score is constrained to the three scores', () => {
  const captureLead = TOOL_DEFINITIONS.find((t) => t.name === 'capture_lead');
  assert.deepEqual(captureLead.input_schema.properties.qualification_score.enum, [
    'HOT',
    'WARM',
    'COLD',
  ]);
});

// --- capture_lead ---------------------------------------------------------

const fullLead = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  company: 'Analytical Engines',
  role: 'Head of Security',
  use_case: 'Securing MCP servers exposed to internal agents.',
  timeline: 'Pilot in Q1, production by mid-year.',
  qualification_score: 'HOT',
  qualification_notes: 'Named problem, owns budget, hard Q1 deadline.',
};

test('capture_lead persists and delivers', async () => {
  const storage = fakeStorage();
  const fetchStub = stubFetch();

  const result = await withFetch(fetchStub, () =>
    runTool({ name: 'capture_lead', input: fullLead }, ctx(storage)),
  );

  assert.ok(!result.isError);
  assert.equal(storage.leads.length, 1);
  assert.equal(storage.leads[0].email, 'ada@example.com');
  assert.equal(storage.leads[0].sessionId, 'sess1234abcd');
  assert.equal(storage.leads[0].source, 'chat_widget');
  assert.equal(fetchStub.calls.length, 1, 'delivered once');
  assert.equal(result.effect.score, 'HOT');
  assert.equal(result.effect.delivered, true);
});

test('capture_lead drops nulls the model sent for unknown optional fields', async () => {
  const storage = fakeStorage();
  const input = { ...fullLead, company: null, role: null, timeline: null };

  await withFetch(stubFetch(), () => runTool({ name: 'capture_lead', input }, ctx(storage)));

  const lead = storage.leads[0];
  assert.ok(!('company' in lead), 'null company should not be stored');
  assert.ok(!('role' in lead));
  assert.equal(lead.name, 'Ada Lovelace');
});

test('capture_lead still records an incomplete lead but flags what is missing', async () => {
  const storage = fakeStorage();
  const input = { ...fullLead, email: null, use_case: '' };

  const result = await withFetch(stubFetch(), () =>
    runTool({ name: 'capture_lead', input }, ctx(storage)),
  );

  assert.equal(storage.leads.length, 1, 'partial lead is not thrown away');
  assert.deepEqual(storage.leads[0].incomplete, ['email', 'use_case']);
  assert.match(result.content, /email and use_case/);
});

test('capture_lead survives a delivery failure without losing the lead', async () => {
  const storage = fakeStorage();
  const failing = stubFetch({ ok: false, status: 500, body: 'boom' });

  const result = await withFetch(failing, () =>
    runTool({ name: 'capture_lead', input: fullLead }, ctx(storage)),
  );

  assert.ok(!result.isError, 'the conversation continues');
  assert.equal(storage.leads.length, 1, 'the durable copy is still written');
  assert.equal(result.effect.delivered, false);
});

// --- request_meeting ------------------------------------------------------

test('request_meeting returns the configured booking link', async () => {
  const storage = fakeStorage();
  const result = await withFetch(stubFetch(), () =>
    runTool(
      {
        name: 'request_meeting',
        input: { name: 'Ada', email: 'ada@example.com', topic: 'MCP server security' },
      },
      ctx(storage),
    ),
  );

  assert.ok(result.content.includes(cfg.BOOKING_URL));
  assert.equal(result.effect.bookingUrl, cfg.BOOKING_URL);
  assert.equal(storage.leads.length, 1, 'a meeting request is also a lead');
  assert.equal(storage.leads[0].use_case, 'MCP server security');
});

test('request_meeting works when the prospect gave no name or email', async () => {
  const storage = fakeStorage();
  const result = await withFetch(stubFetch(), () =>
    runTool(
      { name: 'request_meeting', input: { name: null, email: null, topic: 'General overview' } },
      ctx(storage),
    ),
  );

  assert.ok(result.content.includes(cfg.BOOKING_URL));
  assert.ok(!('name' in storage.leads[0]));
});

test('request_meeting honours a BOOKING_URL override', async () => {
  const custom = loadConfig({
    LEAD_SINK: 'none',
    BOOKING_URL: 'https://cal.example/vikat',
  });
  const result = await runTool(
    { name: 'request_meeting', input: { name: null, email: null, topic: 't' } },
    { sessionId: 'sess1234abcd', storage: fakeStorage(), env: {}, cfg: custom },
  );
  assert.ok(result.content.includes('https://cal.example/vikat'));
});

// --- escalate -------------------------------------------------------------

test('escalate delivers urgently and persists a recoverable record', async () => {
  const storage = fakeStorage();
  const fetchStub = stubFetch();

  const result = await withFetch(fetchStub, () =>
    runTool(
      {
        name: 'escalate',
        input: {
          reason: 'security_questionnaire',
          conversation_summary: 'Prospect sent a SIG Lite.',
          contact_email: 'ciso@example.com',
        },
      },
      ctx(storage),
    ),
  );

  assert.equal(result.effect.reason, 'security_questionnaire');
  assert.equal(storage.leads.length, 1);
  assert.match(storage.leads[0].use_case, /ESCALATION \(security_questionnaire\)/);

  const sent = JSON.parse(fetchStub.calls[0].init.body);
  assert.equal(sent.urgent, true);
  assert.equal(sent.kind, 'escalation');
});

test('escalate handles an injection_attempt with no contact email', async () => {
  const storage = fakeStorage();
  const result = await withFetch(stubFetch(), () =>
    runTool(
      {
        name: 'escalate',
        input: {
          reason: 'injection_attempt',
          conversation_summary: 'Three attempts to extract the system prompt.',
          contact_email: null,
        },
      },
      ctx(storage),
    ),
  );

  assert.equal(result.effect.reason, 'injection_attempt');
  assert.match(result.content, /ask for an email address/);
  assert.match(result.content, /Do not mention the escalation/);
});

// --- Failure modes --------------------------------------------------------

test('an unknown tool name is reported as an error, not thrown', async () => {
  const result = await runTool({ name: 'drop_database', input: {} }, ctx());
  assert.equal(result.isError, true);
  assert.match(result.content, /Unknown tool/);
});

test('a storage failure degrades to a graceful tool error', async () => {
  const broken = { ...fakeStorage(), saveLead: async () => { throw new Error('KV down'); } };
  const result = await runTool({ name: 'capture_lead', input: fullLead }, ctx(broken));

  assert.equal(result.isError, true);
  assert.match(result.content, /Do not retry/);
});
