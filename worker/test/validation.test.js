import test from 'node:test';
import assert from 'node:assert/strict';

import { validateChatBody, sanitize, corsHeaders, validSessionId } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import { req } from './helpers.js';

const cfg = loadConfig({});

function body(overrides = {}) {
  return {
    sessionId: 'abcd1234efgh',
    messages: [{ role: 'user', content: 'What does VShield do?' }],
    ...overrides,
  };
}

// --- sanitize -------------------------------------------------------------

test('sanitize strips HTML tags', () => {
  assert.equal(sanitize('<script>alert(1)</script>hello'), 'alert(1) hello');
  assert.equal(sanitize('<b>bold</b> text'), 'bold text');
  assert.equal(sanitize('<img src=x onerror=y>'), '');
});

test('sanitize strips control characters but keeps newlines and tabs', () => {
  const withNulls = `a${String.fromCharCode(0)}b${String.fromCharCode(27)}[31mc`;
  assert.equal(sanitize(withNulls), 'ab[31mc');
  assert.equal(sanitize('line1\nline2'), 'line1\nline2');
});

test('sanitize strips zero-width and bidi-override characters', () => {
  const zwsp = String.fromCharCode(0x200b);
  const rlo = String.fromCharCode(0x202e);
  const bom = String.fromCharCode(0xfeff);
  assert.equal(sanitize(`ig${zwsp}nore ${rlo}all${bom}`), 'ignore all');
});

test('sanitize collapses runs of spaces and trims', () => {
  assert.equal(sanitize('  too    many   spaces  '), 'too many spaces');
});

// --- validSessionId -------------------------------------------------------

test('validSessionId accepts safe ids and rejects everything else', () => {
  assert.ok(validSessionId('abcd1234efgh'));
  assert.ok(validSessionId('a-b_c-1234567'));
  assert.ok(!validSessionId('short'), 'under 8 chars');
  assert.ok(!validSessionId('a'.repeat(65)), 'over 64 chars');
  assert.ok(!validSessionId('has spaces here'));
  assert.ok(!validSessionId('../../etc/passwd'));
  assert.ok(!validSessionId(12345678));
  assert.ok(!validSessionId(null));
});

// --- validateChatBody -----------------------------------------------------

test('validateChatBody accepts a well-formed body', () => {
  const r = validateChatBody(body(), cfg);
  assert.ok(r.ok);
  assert.equal(r.sessionId, 'abcd1234efgh');
  assert.equal(r.messages.length, 1);
});

test('validateChatBody rejects a non-object body', () => {
  for (const bad of [null, undefined, 'string', 42]) {
    const r = validateChatBody(bad, cfg);
    assert.ok(!r.ok);
    assert.equal(r.status, 400);
  }
});

test('validateChatBody rejects a bad sessionId', () => {
  const r = validateChatBody(body({ sessionId: 'x' }), cfg);
  assert.ok(!r.ok);
  assert.match(r.error, /sessionId/);
});

test('validateChatBody rejects empty or non-array messages', () => {
  assert.ok(!validateChatBody(body({ messages: [] }), cfg).ok);
  assert.ok(!validateChatBody(body({ messages: 'hi' }), cfg).ok);
});

test('validateChatBody enforces the per-session message cap', () => {
  const messages = Array.from({ length: cfg.MAX_MESSAGES_PER_SESSION + 1 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `m${i}`,
  }));
  const r = validateChatBody(body({ messages }), cfg);
  assert.ok(!r.ok);
  assert.match(r.error, new RegExp(String(cfg.MAX_MESSAGES_PER_SESSION)));
});

test('validateChatBody allows exactly the message cap', () => {
  const messages = Array.from({ length: cfg.MAX_MESSAGES_PER_SESSION }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i}`,
  }));
  // Cap is even, so force the last message to be from the user.
  messages[messages.length - 1] = { role: 'user', content: 'last' };
  assert.ok(validateChatBody(body({ messages }), cfg).ok);
});

test('validateChatBody enforces the per-message character cap', () => {
  const long = 'a'.repeat(cfg.MAX_CHARS_PER_MESSAGE + 1);
  const r = validateChatBody(body({ messages: [{ role: 'user', content: long }] }), cfg);
  assert.ok(!r.ok);
  assert.match(r.error, new RegExp(String(cfg.MAX_CHARS_PER_MESSAGE)));
});

test('validateChatBody rejects unknown roles', () => {
  for (const role of ['system', 'tool', 'developer', '']) {
    const r = validateChatBody(body({ messages: [{ role, content: 'x' }] }), cfg);
    assert.ok(!r.ok, `role "${role}" should be rejected`);
  }
});

test('validateChatBody rejects non-string content', () => {
  const r = validateChatBody(body({ messages: [{ role: 'user', content: { a: 1 } }] }), cfg);
  assert.ok(!r.ok);
});

test('validateChatBody requires the last message to be from the user', () => {
  const r = validateChatBody(
    body({
      messages: [
        { role: 'user', content: 'hi there' },
        { role: 'assistant', content: 'hello back' },
      ],
    }),
    cfg,
  );
  assert.ok(!r.ok);
  assert.match(r.error, /last message/);
});

test('validateChatBody sanitizes content it passes through', () => {
  const r = validateChatBody(
    body({ messages: [{ role: 'user', content: '<b>What</b> is VShield?' }] }),
    cfg,
  );
  assert.ok(r.ok);
  assert.equal(r.messages[0].content, 'What is VShield?');
});

test('validateChatBody rejects a body that sanitizes down to nothing', () => {
  const r = validateChatBody(body({ messages: [{ role: 'user', content: '<img src=x>' }] }), cfg);
  assert.ok(!r.ok);
});

// --- CORS -----------------------------------------------------------------

test('corsHeaders allows a configured internal origin', () => {
  const h = corsHeaders(req({ Origin: 'https://sales.vikat.ai' }), cfg);
  assert.equal(h['Access-Control-Allow-Origin'], 'https://sales.vikat.ai');
  assert.equal(h.Vary, 'Origin');
});

test('corsHeaders returns null for a disallowed origin', () => {
  assert.equal(corsHeaders(req({ Origin: 'https://evil.example' }), cfg), null);
  // A prefix of an allowed origin must not pass.
  assert.equal(corsHeaders(req({ Origin: 'https://sales.vikat.ai.evil.example' }), cfg), null);
  // Nor must a scheme downgrade.
  assert.equal(corsHeaders(req({ Origin: 'http://sales.vikat.ai' }), cfg), null);
  // The public marketing site is NOT an allowed origin for an internal tool.
  assert.equal(corsHeaders(req({ Origin: 'https://vikat.ai' }), cfg), null);
});

test('corsHeaders allows a request with no Origin, without CORS headers', () => {
  const h = corsHeaders(req({}), cfg);
  assert.deepEqual(h, {});
});

test('corsHeaders honours the ALLOWED_ORIGINS override', () => {
  const custom = loadConfig({ ALLOWED_ORIGINS: 'https://staging.vikat.ai' });
  assert.ok(corsHeaders(req({ Origin: 'https://staging.vikat.ai' }), custom));
  assert.equal(corsHeaders(req({ Origin: 'https://sales.vikat.ai' }), custom), null);
});

test('CORS exposes the headers the Access-authenticated widget must send', () => {
  const h = corsHeaders(req({ Origin: 'https://sales.vikat.ai' }), cfg);
  assert.match(h['Access-Control-Allow-Headers'], /Cf-Access-Jwt-Assertion/);
  assert.equal(h['Access-Control-Allow-Credentials'], 'true', 'the Access cookie must survive the request');
});
