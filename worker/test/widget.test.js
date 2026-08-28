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

const ADMIN_HTML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../widget/admin.html',
);

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

// --- the admin panel boots -------------------------------------------------

test('every admin tab loads its data, not just the first', async () => {
  // A regression test for a page that looked fine. Editing the SharePoint tab,
  // I deleted loadSharePoint() along with the form it sat beside and left the
  // call to it in boot(). The ReferenceError was caught by an empty .catch, so
  // the header rendered, Knowledge loaded, and SharePoint and Users sat on
  // their placeholder text — permanently, with a clean console and no failed
  // request to find. Nothing in the suite noticed, because nothing loaded the
  // real page.
  const admin = await browser.newPage();

  // Two channels, both needed and neither of them "any console error": a
  // sandbox with no network logs resource failures that say nothing about the
  // page. pageerror catches an uncaught throw; the [admin] prefix catches the
  // one that broke this page, which was CAUGHT — by an empty .catch that made
  // a ReferenceError look like a slow request.
  const errors = [];
  admin.on('pageerror', (e) => errors.push('uncaught: ' + e));
  admin.on('console', (m) => {
    if (m.type() === 'error' && m.text().includes('[admin]')) errors.push(m.text());
  });

  await admin.route('**/admin/**', (route) => {
    const url = route.request().url();
    const body = url.includes('/admin/summary')
      ? { you: { email: 'boss@vikat.ai', role: 'admin', roleSource: 'bootstrap' } }
      : url.includes('/admin/sharepoint')
        ? {
            scope: { hostname: 'vikatai.sharepoint.com', sitePath: '/sites/VikatGTM', library: '', generatedFolder: 'Generated by assistant', managedBy: 'GitHub Actions repository variables (SHAREPOINT_*)', note: 'An unset library means every document library on the site is crawled.' },
            credentials: {
              documentFiling: { configured: true, managedBy: 'Worker secrets', affects: 'Filing generated decks.' },
              sync: { configured: null, managedBy: 'GitHub Actions secrets', affects: 'The nightly sync, which runs in CI.' },
            },
            lastSync: { syncedAt: '2026-08-27T00:43:52.000Z', sharePointChunks: 184, collateralDocuments: 10, totalChunks: 454 },
          }
        : url.includes('/admin/knowledge')
          ? { entries: [] }
          : { users: [] };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await admin.goto(`file://${ADMIN_HTML}`);
  await admin.waitForFunction(
    () => !document.querySelector('#sp-hostname').textContent.includes('—'),
    null,
    { timeout: 5000 },
  );

  // The three things the broken page never showed.
  assert.equal(await admin.textContent('#sp-hostname'), 'vikatai.sharepoint.com');
  assert.match(await admin.textContent('#sp-credentials'), /Document filing is configured/);
  assert.match(await admin.textContent('#sp-status'), /10 document\(s\) indexed/);

  assert.deepEqual(errors, [], 'the page must boot without throwing');
  await admin.close();
});

test('one failing loader does not cancel the others', async () => {
  // The specific shape of the failure: three independent loads in one .then(),
  // so a throw in the second silently skipped the third.
  const admin = await browser.newPage();

  await admin.route('**/admin/**', (route) => {
    const url = route.request().url();
    if (url.includes('/admin/sharepoint')) return route.fulfill({ status: 500, body: 'boom' });
    const body = url.includes('/admin/summary')
      ? { you: { email: 'boss@vikat.ai', role: 'admin', roleSource: 'bootstrap' } }
      : url.includes('/admin/knowledge')
        ? { entries: [] }
        : { users: [{ email: 'rep@vikat.ai', role: 'rep', source: 'storage' }] };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await admin.goto(`file://${ADMIN_HTML}`);
  await admin.waitForFunction(
    () => document.querySelector('#whoami').textContent.includes('boss@vikat.ai'),
    null,
    { timeout: 5000 },
  );
  // Users is loaded AFTER SharePoint, so it is the one that used to be lost.
  await admin.waitForFunction(
    () => document.querySelector('#user-list').textContent.includes('rep@vikat.ai'),
    null,
    { timeout: 5000 },
  );

  await admin.close();
});

// --- markdown in answer bodies ---------------------------------------------

/** The markup renderBody produced — render() above already returns it. */
const html = async (text) => (await render(text)).html;

test('a bullet list renders as a list, not as literal hyphens', async () => {
  // The prompt asks for "short lists, clear headers" on a brief and the model
  // obliges. All of it used to arrive as literal "- " in one wall of text.
  const rendered = await html('Three things:\n\n- Deal Desk owns pricing\n- Security owns questionnaires\n- Legal owns redlines');

  assert.match(rendered, /<ul class="vk-list">/);
  assert.equal((rendered.match(/<li>/g) || []).length, 3);
  assert.match(rendered, /Deal Desk owns pricing/);
  assert.ok(!rendered.includes('- Deal Desk'), 'the marker must not survive as text');
});

test('numbered lists, headings and bold each render as themselves', async () => {
  const rendered = await html('## Next steps\n\n1. Send the deck\n2. Book the follow-up\n\nThat is **not** a commitment.');

  assert.match(rendered, /<div class="vk-h vk-h2">Next steps<\/div>/);
  assert.match(rendered, /<ol class="vk-list">/);
  assert.equal((rendered.match(/<li>/g) || []).length, 2);
  assert.match(rendered, /<strong>not<\/strong>/);
});

test('paragraphs keep their line breaks and links still work', async () => {
  const rendered = await html('VShield covers it.\nVSentinel does not.\n\nSee [the deck](https://vikatai.sharepoint.com/x.pptx).');

  assert.match(rendered, /<br>/, 'a single newline is a break, not a joined sentence');
  assert.equal((rendered.match(/<p class="vk-p">/g) || []).length, 2);
  assert.match(rendered, /<a class="vk-link" href="https:\/\/vikatai\.sharepoint\.com\/x\.pptx"/);
  assert.match(rendered, /the deck<\/a>/);
});

test('a code span is literal inside, markup and all', async () => {
  const rendered = await html('Set `SHAREPOINT_LIBRARY` to `**not** a library`.');

  assert.equal((rendered.match(/<code class="vk-code">/g) || []).length, 2);
  assert.ok(!rendered.includes('<strong>not</strong>'), 'asterisks inside backticks are characters');
});

test('markup in the text becomes text, never nodes', async () => {
  // The property this renderer must not lose. Answers summarise SharePoint
  // documents, and anyone at Vikat can name a file. A title containing a
  // script tag must reach the screen as characters.
  const rendered = await html('- A doc called <img src=x onerror=alert(1)> exists\n\n<script>alert(2)</script>');

  assert.ok(!/<img/i.test(rendered), 'no element may be constructed from the text');
  assert.ok(!/<script/i.test(rendered), 'nor a script');
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/, 'it must be visible as text');
});

test('a javascript: URL is not turned into a link', async () => {
  const rendered = await html('Try [this](javascript:alert(1)) or javascript:alert(2)');

  assert.ok(!/href="javascript:/i.test(rendered), 'only http(s) and same-origin paths become anchors');
});

test('half-written markup mid-stream degrades to text', async () => {
  // renderBody runs on every delta with the text so far, so it constantly sees
  // unclosed markup. It must not throw, and must not eat the characters.
  for (const partial of ['**bol', '- item\n- ', '## ', '`code']) {
    const rendered = await html(partial);
    assert.equal(typeof rendered, 'string', `renderBody threw on ${JSON.stringify(partial)}`);
  }
  assert.match(await html('**bol'), /\*\*bol/, 'an unclosed bold stays visible');
});
