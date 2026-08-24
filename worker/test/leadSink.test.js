import test from 'node:test';
import assert from 'node:assert/strict';

import { deliverLead } from '../src/leadSink.js';
import { loadConfig } from '../src/config.js';
import { stubFetch } from './helpers.js';

const basePayload = {
  kind: 'lead',
  sessionId: 'sess1234abcd',
  data: {
    prospect_name: 'Ada Lovelace',
    prospect_email: 'ada@example.com',
    company: 'Analytical Engines',
    qualification_score: 'HOT',
    loggedBy: 'rep@vikat.ai',
    loggedByName: 'Test Rep',
  },
  summary: 'Named problem, Q1 deadline, owns the budget.',
};

/** Swap globalThis.fetch for the duration of one test. */
async function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// --- MailChannels ---------------------------------------------------------

test('mailchannels sink posts a well-formed message', async () => {
  const cfg = loadConfig({ LEAD_SINK: 'mailchannels' });
  const fetchStub = stubFetch();

  const result = await withFetch(fetchStub, () => deliverLead(basePayload, {}, cfg));

  assert.deepEqual(result, { delivered: true, channel: 'mailchannels' });
  assert.equal(fetchStub.calls.length, 1);

  const call = fetchStub.calls[0];
  assert.match(call.url, /mailchannels\.net/);
  assert.equal(call.init.method, 'POST');

  const sent = JSON.parse(call.init.body);
  assert.equal(sent.personalizations[0].to[0].email, cfg.LEAD_TO_EMAIL);
  assert.equal(sent.from.email, cfg.LEAD_FROM_EMAIL);
  assert.match(sent.subject, /\[HOT\]/);
  assert.match(sent.subject, /Ada Lovelace/);
  assert.match(sent.subject, /logged by Test Rep/, 'the recipient needs to know which rep logged it');
  assert.equal(sent.reply_to.email, 'ada@example.com', 'a logged lead replies to the prospect');
  assert.equal(sent.content.length, 2, 'plain text and html parts');
  assert.match(sent.content[0].value, /ada@example\.com/);
});

test('mailchannels sink omits reply_to when there is no usable email', async () => {
  const cfg = loadConfig({ LEAD_SINK: 'mailchannels' });
  const fetchStub = stubFetch();
  const payload = { ...basePayload, data: { prospect_name: 'Anon' } };

  await withFetch(fetchStub, () => deliverLead(payload, {}, cfg));
  const sent = JSON.parse(fetchStub.calls[0].init.body);
  assert.equal(sent.reply_to, undefined);
});

test('mailchannels sink attaches DKIM fields only when configured', async () => {
  const cfg = loadConfig({ LEAD_SINK: 'mailchannels' });

  const without = stubFetch();
  await withFetch(without, () => deliverLead(basePayload, {}, cfg));
  assert.equal(JSON.parse(without.calls[0].init.body).personalizations[0].dkim_domain, undefined);

  const with_ = stubFetch();
  const env = { DKIM_PRIVATE_KEY: 'key', DKIM_DOMAIN: 'vikat.ai' };
  await withFetch(with_, () => deliverLead(basePayload, env, cfg));
  const p = JSON.parse(with_.calls[0].init.body).personalizations[0];
  assert.equal(p.dkim_domain, 'vikat.ai');
  assert.equal(p.dkim_selector, 'mailchannels', 'default selector');
});

// --- Webhook --------------------------------------------------------------

test('webhook sink posts a flat JSON lead to the configured URL', async () => {
  const cfg = loadConfig({ LEAD_SINK: 'webhook', LEAD_WEBHOOK_URL: 'https://hooks.example/lead' });
  const fetchStub = stubFetch();

  const result = await withFetch(fetchStub, () => deliverLead(basePayload, {}, cfg));

  assert.deepEqual(result, { delivered: true, channel: 'webhook' });
  assert.equal(fetchStub.calls[0].url, 'https://hooks.example/lead');

  const sent = JSON.parse(fetchStub.calls[0].init.body);
  assert.equal(sent.kind, 'lead');
  assert.equal(sent.prospect_name, 'Ada Lovelace');
  assert.equal(sent.loggedBy, 'rep@vikat.ai');
  assert.equal(sent.qualification_score, 'HOT');
  assert.equal(sent.sessionId, 'sess1234abcd');
  assert.ok(sent.receivedAt);
});

test('webhook sink sends a bearer token when one is configured', async () => {
  const cfg = loadConfig({ LEAD_SINK: 'webhook', LEAD_WEBHOOK_URL: 'https://hooks.example/lead' });
  const fetchStub = stubFetch();

  await withFetch(fetchStub, () => deliverLead(basePayload, { LEAD_WEBHOOK_TOKEN: 'tok' }, cfg));
  assert.equal(fetchStub.calls[0].init.headers.authorization, 'Bearer tok');
});

test('webhook sink reports a misconfigured URL instead of throwing', async () => {
  const cfg = loadConfig({ LEAD_SINK: 'webhook' });
  const result = await withFetch(stubFetch(), () => deliverLead(basePayload, {}, cfg));
  assert.equal(result.delivered, false);
  assert.match(result.error, /LEAD_WEBHOOK_URL/);
});

// --- Failure handling -----------------------------------------------------

test('deliverLead never throws on an upstream error', async () => {
  const cfg = loadConfig({ LEAD_SINK: 'mailchannels' });
  const fetchStub = stubFetch({ ok: false, status: 401, body: 'unauthorized' });

  const result = await withFetch(fetchStub, () => deliverLead(basePayload, {}, cfg));
  assert.equal(result.delivered, false);
  assert.equal(result.channel, 'mailchannels');
  assert.match(result.error, /401/);
});

test('deliverLead never throws when fetch itself rejects', async () => {
  const cfg = loadConfig({ LEAD_SINK: 'mailchannels' });
  const boom = async () => {
    throw new Error('network down');
  };

  const result = await withFetch(boom, () => deliverLead(basePayload, {}, cfg));
  assert.equal(result.delivered, false);
  assert.match(result.error, /network down/);
});

test('deliverLead reports an unknown sink rather than silently succeeding', async () => {
  const cfg = loadConfig({ LEAD_SINK: 'carrier-pigeon' });
  const result = await withFetch(stubFetch(), () => deliverLead(basePayload, {}, cfg));
  assert.equal(result.delivered, false);
  assert.match(result.error, /carrier-pigeon/);
});

test('the none sink sends nothing and reports not-delivered', async () => {
  const cfg = loadConfig({ LEAD_SINK: 'none' });
  const fetchStub = stubFetch();

  const result = await withFetch(fetchStub, () => deliverLead(basePayload, {}, cfg));
  assert.deepEqual(result, { delivered: false, channel: 'none' });
  assert.equal(fetchStub.calls.length, 0);
});

// --- Escalations ----------------------------------------------------------

test('a blocking expert request is subject-flagged URGENT and names the owner', async () => {
  const cfg = loadConfig({ LEAD_SINK: 'mailchannels' });
  const fetchStub = stubFetch();
  const payload = {
    kind: 'escalation',
    urgent: true,
    sessionId: 'sess1234abcd',
    data: {
      owner: 'Security',
      question: 'Can we share the SIG Lite under NDA?',
      requestedBy: 'rep@vikat.ai',
      requestedByName: 'Test Rep',
    },
    summary: 'Acme security review is the last gate.',
  };

  await withFetch(fetchStub, () => deliverLead(payload, {}, cfg));
  const sent = JSON.parse(fetchStub.calls[0].init.body);
  assert.match(sent.subject, /^URGENT/);
  assert.match(sent.subject, /Security request from Test Rep/);
  assert.match(sent.content[0].value, /URGENT/);
  assert.equal(sent.reply_to.email, 'rep@vikat.ai', 'the owner answers the rep, not a prospect');
});

test('a non-blocking expert request is not flagged urgent', async () => {
  const cfg = loadConfig({ LEAD_SINK: 'mailchannels' });
  const fetchStub = stubFetch();
  const payload = {
    kind: 'escalation',
    urgent: false,
    sessionId: 'sess1234abcd',
    data: { owner: 'Deal Desk', question: 'q', requestedByName: 'Test Rep' },
  };

  await withFetch(fetchStub, () => deliverLead(payload, {}, cfg));
  const sent = JSON.parse(fetchStub.calls[0].init.body);
  assert.ok(!sent.subject.startsWith('URGENT'), 'only blocking_a_call earns an interrupt');
});

test('a content gap is subject-tagged and truncated', async () => {
  const cfg = loadConfig({ LEAD_SINK: 'mailchannels' });
  const fetchStub = stubFetch();
  const payload = {
    kind: 'content_gap',
    sessionId: 'sess1234abcd',
    data: {
      gap_type: 'outdated',
      question: 'A'.repeat(200),
      reportedBy: 'rep@vikat.ai',
    },
    summary: 'The integrations list has not been updated since last year.',
  };

  await withFetch(fetchStub, () => deliverLead(payload, {}, cfg));
  const sent = JSON.parse(fetchStub.calls[0].init.body);
  assert.match(sent.subject, /^Content gap \(outdated\)/);
  assert.ok(sent.subject.length < 120, 'a long question must not blow up the subject line');
  assert.equal(sent.reply_to.email, 'rep@vikat.ai');
});

test('lead content is HTML-escaped in the email body', async () => {
  const cfg = loadConfig({ LEAD_SINK: 'mailchannels' });
  const fetchStub = stubFetch();
  const payload = {
    ...basePayload,
    data: { prospect_name: '<script>alert(1)</script>', prospect_email: 'x@example.com' },
  };

  await withFetch(fetchStub, () => deliverLead(payload, {}, cfg));
  const html = JSON.parse(fetchStub.calls[0].init.body).content[1].value;
  assert.ok(!html.includes('<script>'), 'raw script tag must not reach the inbox');
  assert.ok(html.includes('&lt;script&gt;'));
});
