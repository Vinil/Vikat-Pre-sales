/**
 * Widget tests — disclosure-tag splitting and link rendering.
 *
 * These cover the widget's two safety-critical behaviours: a missed trailing
 * "[Internal only]" line means the rep sees an answer with no warning attached,
 * and renderBody is the one place model output becomes DOM.
 *
 * They need a real browser, so they SKIP rather than fail when none is
 * available — that is the normal state on a deploy runner. `npm test` runs
 * them wherever Chromium exists; the Tests workflow installs one so they
 * actually run on every push. To run them locally:
 *
 *   npx playwright install chromium && npm run test:widget
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
  console.log('# Playwright is not installed — skipping widget tests.');
  process.exit(0);
}

/**
 * Where the browser lives.
 *
 * Some environments pin Chromium at a fixed path; a CI runner and a laptop let
 * Playwright manage its own. Passing an executablePath that does not exist is
 * fatal, so only pass one when there is something at the other end of it.
 */
const pinned = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const launchOptions = fs.existsSync(pinned) ? { executablePath: pinned } : {};

let browser;
try {
  browser = await chromium.launch(launchOptions);
} catch (err) {
  // The package installs without a browser binary, which is the default on a
  // CI runner. Skipping is correct; failing a deploy over a missing browser is
  // not — and that is exactly what this guard existed to prevent before
  // Playwright became a declared dependency and the import stopped throwing.
  console.log(`# No Chromium available — skipping widget tests. (${String(err.message).split('\n')[0]})`);
  console.log('# Run `npx playwright install chromium` to enable them.');
  process.exit(0);
}

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

test('a generated document links to this origin without opening a tab', async () => {
  const r = await render('Here it is: [2026-08-25-call-prep.pptx](/document/doc_abc123)');
  assert.equal(r.links.length, 1);
  assert.equal(r.links[0].href, '/document/doc_abc123');
  assert.equal(r.links[0].label, '2026-08-25-call-prep.pptx');
  assert.equal(r.links[0].target, '', 'a same-origin download stays in place');
});

test('a protocol-relative link is never treated as same-origin', async () => {
  // "//evil.test" leaves the origin while looking like a path.
  for (const src of ['[click](//evil.test/x)', '[click](///evil.test)']) {
    const r = await render(src);
    assert.equal(r.links.length, 0, `${src} must not produce an anchor`);
  }
});

test('a relative link cannot smuggle a scheme past the path branch', async () => {
  for (const src of ['[x](/javascript:alert(1))', '[x](:/javascript:alert(1))']) {
    const r = await render(src);
    for (const link of r.links) {
      assert.match(link.href, /^\//, `${src} produced ${link.href}`);
      assert.ok(!/^\/\//.test(link.href));
    }
  }
});

test('SharePoint and document links coexist in one answer', async () => {
  const r = await render(
    'Built [the deck](/document/doc_1). Background is in [the overview](https://vikatai.sharepoint.com/x.pptx).',
  );
  assert.equal(r.links.length, 2);
  assert.equal(r.links[0].target, '');
  assert.equal(r.links[1].target, '_blank');
  assert.match(r.links[1].rel, /noopener/);
});
