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

// --- Link rendering -------------------------------------------------------
// Collateral links are the whole value of find_collateral, and they are also
// the one place model output becomes DOM. Both halves are tested here.

/** Render `text` into a fresh node and return { html, links }. */
const render = (text) =>
  page.evaluate((t) => {
    var n = document.createElement('div');
    window.VikatChatInternals.renderBody(n, t);
    return {
      html: n.innerHTML,
      text: n.textContent,
      links: Array.prototype.map.call(n.querySelectorAll('a'), function (a) {
        return { href: a.getAttribute('href'), label: a.textContent, rel: a.rel, target: a.target };
      }),
    };
  }, text);

test('a markdown link becomes an anchor', async () => {
  const r = await render('Send them [the VShield deck](https://vikat.sharepoint.com/x/a.pptx).');
  assert.equal(r.links.length, 1);
  assert.equal(r.links[0].href, 'https://vikat.sharepoint.com/x/a.pptx');
  assert.equal(r.links[0].label, 'the VShield deck');
});

test('collateral links open in a new tab without handing over the opener', async () => {
  const r = await render('[deck](https://vikat.sharepoint.com/x/a.pptx)');
  assert.equal(r.links[0].target, '_blank');
  assert.match(r.links[0].rel, /noopener/);
  assert.match(r.links[0].rel, /noreferrer/);
});

test('a bare URL becomes an anchor', async () => {
  const r = await render('It is at https://vikat.sharepoint.com/x/a.pptx today.');
  assert.equal(r.links.length, 1);
  assert.equal(r.links[0].href, 'https://vikat.sharepoint.com/x/a.pptx');
});

test('a full stop after a bare URL is not part of the link', async () => {
  const r = await render('See https://vikat.sharepoint.com/x/a.pptx.');
  assert.equal(r.links[0].href, 'https://vikat.sharepoint.com/x/a.pptx');
  assert.match(r.text, /a\.pptx\.$/, 'the sentence keeps its full stop');
});

test('surrounding prose survives verbatim', async () => {
  const src = 'Before [x](https://a.test/1) middle [y](https://b.test/2) after';
  const r = await render(src);
  assert.equal(r.links.length, 2);
  assert.equal(r.text, 'Before x middle y after');
});

test('text with no links is rendered unchanged', async () => {
  const r = await render('VCommand triages incidents in under 30 seconds.');
  assert.equal(r.links.length, 0);
  assert.equal(r.text, 'VCommand triages incidents in under 30 seconds.');
});

test('markup in model output is escaped, never parsed', async () => {
  // A document title in SharePoint can contain anything; it must not become
  // script in a rep's browser.
  const r = await render('<img src=x onerror=alert(1)> and <b>bold</b>');
  assert.equal(r.links.length, 0);
  assert.ok(!/<img/.test(r.html), 'no element may be created from model text');
  assert.ok(!/<b>/.test(r.html));
  assert.match(r.text, /^<img src=x onerror=alert\(1\)> and <b>bold<\/b>$/);
});

test('a javascript: URL is never turned into a link', async () => {
  for (const src of [
    '[click](javascript:alert(1))',
    'javascript:alert(1)',
    '[click](data:text/html,<script>alert(1)</script>)',
    '[click](vbscript:msgbox)',
    '[click](  javascript:alert(1))',
  ]) {
    const r = await render(src);
    assert.equal(r.links.length, 0, `${src} must not produce an anchor`);
  }
});

test('a markdown link whose label contains markup stays inert', async () => {
  const r = await render('[<img src=x onerror=alert(1)>](https://vikat.sharepoint.com/a)');
  assert.equal(r.links.length, 1);
  assert.equal(r.links[0].label, '<img src=x onerror=alert(1)>', 'label is text, not markup');
  assert.ok(!/<img/.test(r.html));
});

test('a half-arrived link mid-stream does not break the body', async () => {
  // Streaming means renderBody sees prefixes of the final text.
  const r = await render('Send them [the deck](https://vikat.share');
  assert.match(r.text, /^Send them /, 'the prose already streamed must still show');
});

test('re-rendering replaces the body rather than appending to it', async () => {
  const r = await page.evaluate(() => {
    var n = document.createElement('div');
    window.VikatChatInternals.renderBody(n, 'first [a](https://a.test/1)');
    window.VikatChatInternals.renderBody(n, 'second [b](https://b.test/2)');
    return { text: n.textContent, links: n.querySelectorAll('a').length };
  });
  assert.equal(r.text, 'second b');
  assert.equal(r.links, 1);
});
