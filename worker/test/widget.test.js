/**
 * Widget tests — the disclosure-tag split only.
 *
 * Run with `npm run test:widget` (needs Playwright + Chromium), not as part of
 * the default suite, which stays fast and dependency-free.
 *
 * This is the widget's safety-critical logic: if a trailing "[Internal only]"
 * line is missed, the rep sees an answer with no warning attached.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGET = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../widget/vikat-chat.js',
);

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('# Playwright not installed — skipping widget tests.');
  process.exit(0);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
});
const page = await browser.newPage();

// The widget needs a document.currentScript, so inject it as a real <script>.
await page.setContent('<!doctype html><html><body><div id="m"></div></body></html>');
await page.addScriptTag({
  content: fs
    .readFileSync(WIDGET, 'utf8')
    // currentScript attributes are read at load; fake them via a wrapper.
    .replace(
      'var script = document.currentScript;',
      "var script = { getAttribute: function (k) { return ({'data-endpoint':'http://x','data-mode':'inline','data-mount':'#m'})[k] || null; } };",
    ),
});

const split = (text) => page.evaluate((t) => window.VikatChatInternals.splitTags(t), text);

test.after(() => browser.close());

test('a plain answer produces no tags', async () => {
  const r = await split('VCommand triages incidents in under 30 seconds.');
  assert.equal(r.tags.length, 0);
  assert.equal(r.body, 'VCommand triages incidents in under 30 seconds.');
});

test('a trailing internal-only tag is lifted out of the body', async () => {
  const r = await split('Roadmap has this in Q3.\n[Internal only] — do not repeat to a customer.');
  assert.equal(r.tags.length, 1);
  assert.equal(r.tags[0].label, 'Internal only');
  assert.equal(r.tags[0].cls, 'vk-tag-internal');
  assert.equal(r.tags[0].note, 'do not repeat to a customer.');
  assert.equal(r.body, 'Roadmap has this in Q3.', 'the tag must not remain in the body');
});

test('each tag maps to its own colour class', async () => {
  for (const [text, cls] of [
    ['x\n[OK to share]', 'vk-tag-ok'],
    ['x\n[Internal only]', 'vk-tag-internal'],
    ['x\n[Check before sharing]', 'vk-tag-approval'],
  ]) {
    const r = await split(text);
    assert.equal(r.tags[0]?.cls, cls, `${text} should map to ${cls}`);
  }
});

test('tag matching is case-insensitive', async () => {
  const r = await split('x\n[INTERNAL ONLY] — nope');
  assert.equal(r.tags[0]?.cls, 'vk-tag-internal');
});

test('multiple trailing tags are all lifted, in order', async () => {
  const r = await split('Answer.\n[OK to share] — the product description.\n[Internal only] — the pricing.');
  assert.equal(r.tags.length, 2);
  assert.deepEqual(r.tags.map((t) => t.label), ['OK to share', 'Internal only']);
  assert.equal(r.body, 'Answer.');
});

test('blank lines before a tag do not break the split', async () => {
  const r = await split('Answer.\n\n\n[Internal only]');
  assert.equal(r.tags.length, 1);
  assert.equal(r.body, 'Answer.');
});

test('a tag-like string mid-answer is left alone', async () => {
  // Only trailing lines are tags. A bracket in prose must not be hoisted.
  const r = await split('The doc says [Internal only] in its header.\nThat is the label they use.');
  assert.equal(r.tags.length, 0);
  assert.match(r.body, /\[Internal only\]/);
});

test('a partial tag mid-stream is not yet promoted', async () => {
  // Streaming means splitTags sees prefixes. "[Inter" must not match anything.
  const r = await split('Answer.\n[Inter');
  assert.equal(r.tags.length, 0, 'a half-arrived tag must not render as a tag');
});

test('a tag with no note still renders', async () => {
  const r = await split('Answer.\n[OK to share]');
  assert.equal(r.tags.length, 1);
  assert.equal(r.tags[0].note, '');
});

test('an unknown bracketed label is not treated as a tag', async () => {
  const r = await split('Answer.\n[Top Secret] — invented label');
  assert.equal(r.tags.length, 0, 'only the three known tags may render as disclosure chips');
});
