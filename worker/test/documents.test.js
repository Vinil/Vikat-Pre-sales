/**
 * Document generation.
 *
 * Generated collateral is the only thing the assistant produces that leaves
 * the building, so these lean on what must not happen: an off-brand file, a
 * document with no disclosure label, a rep losing their deck because Graph
 * was down, or the assistant's own output being fed back to it as source.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';

import { normaliseSpec, parseSections, fileNameFor, DISCLOSURE_LABELS, LIMITS } from '../src/documents/spec.js';
import { renderPptx } from '../src/documents/pptx.js';
import { renderPdf } from '../src/documents/pdf.js';
import { createDocument } from '../src/documents/index.js';
import { loadFonts } from '../src/documents/fonts.js';
import { deliverDocument, documentStoreStatus, resetCaches } from '../src/documentStore.js';
import { sentenceCase, eyebrowCase, brandSafe, PALETTE } from '../src/brand.js';
import { FontMetrics, wrap } from '../src/documents/measure.js';
import { createStorage } from '../src/storage.js';
import { loadConfig } from '../src/config.js';
import { fakeKV, stubFetch } from './helpers.js';

const FONTS = loadFonts();
const META = { preparedBy: 'Test Rep', isoDate: '2026-08-25T10:00:00Z' };

function spec(overrides = {}) {
  const r = normaliseSpec({
    format: 'pptx',
    title: 'VShield for Acme',
    subtitle: 'What it does and what Acme still needs to decide.',
    audience: 'Acme security team',
    disclosure: 'internal_only',
    sections: [
      { eyebrow: 'context', title: 'The gap', body: 'Agents reach production before controls do.', points: ['One', 'Two'] },
    ],
    ...overrides,
  });
  if (!r.ok) throw new Error(r.error);
  return r.spec;
}

// --- Brand rules ----------------------------------------------------------

test('a Title Cased heading becomes sentence case', () => {
  assert.equal(sentenceCase('The Reliability Layer For Production AI'), 'The Reliability Layer for Production AI');
});

test('sentence case never lower-cases a name it does not recognise', () => {
  // A customer name flattened to "acme" on a deck that goes to Acme is worse
  // than a stray capital, so only minor words are ever lowered.
  assert.match(sentenceCase('VShield Vs The Field For Acme'), /Acme/);
  assert.match(sentenceCase('A Deck For Northwind'), /Northwind/);
});

test('shouting is flattened, but the brand marks survive it', () => {
  assert.equal(sentenceCase('WHY VIKAT WINS'), 'Why Vikat wins');
  assert.equal(sentenceCase('vshield beats the field'), 'VShield beats the field');
});

test('eyebrows are the one place the system shouts', () => {
  assert.equal(eyebrowCase('call prep'), 'CALL PREP');
});

test('emoji are stripped from anything that reaches a document', () => {
  const rocket = String.fromCodePoint(0x1f680);
  assert.equal(brandSafe(`Great deck ${rocket} for you`), 'Great deck for you');
  assert.ok(!spec({ title: `Rocket ${rocket} deck` }).title.includes(rocket));
});

// --- Spec -----------------------------------------------------------------

test('an unknown format is refused rather than guessed at', () => {
  const r = normaliseSpec({ format: 'docx', title: 'x', sections: [{ title: 'y' }] });
  assert.ok(!r.ok);
  assert.match(r.error, /format/);
});

test('a spec with no usable section is refused', () => {
  assert.ok(!normaliseSpec({ format: 'pdf', title: 'Just a title', sections: [] }).ok);
  assert.ok(!normaliseSpec({ format: 'pdf', title: 'Just a title', sections: [{ eyebrow: 'x' }] }).ok);
});

test('over-long content is truncated, not rejected', () => {
  // A rep mid-call wants the deck, not an error about a bullet being four
  // characters too long.
  const s = spec({
    title: 'A'.repeat(400),
    sections: [{ title: 'ok', points: ['B'.repeat(400), 'C'] }],
  });
  assert.ok(s.title.length <= LIMITS.titleChars + 1, 'title truncated');
  assert.ok(s.sections[0].points[0].length <= LIMITS.pointChars + 1);
});

test('the section and point counts are capped', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ title: `Section ${i}`, points: Array(20).fill('point') }));
  const s = spec({ sections: many });
  assert.equal(s.sections.length, LIMITS.sections);
  assert.equal(s.sections[0].points.length, LIMITS.points);
});

test('an unknown disclosure value falls back to the cautious one', () => {
  assert.equal(spec({ disclosure: 'obviously_fine' }).disclosure, 'internal_only');
  assert.equal(spec({ disclosure: undefined }).disclosure, 'internal_only');
});

test('the filename sorts by date and says what it is', () => {
  assert.equal(
    fileNameFor(spec({ title: 'VShield for Acme' }), '2026-08-25T10:00:00Z'),
    '2026-08-25-vshield-for-acme.pptx',
  );
});

// --- Measurement ----------------------------------------------------------

test('metrics come from the font, not from a character-count guess', () => {
  const mono = FONTS.metrics.eyebrow;
  // JetBrains Mono is monospaced: if cmap or hmtx were being read wrongly,
  // these two would differ.
  assert.equal(mono.widthOf('M', 12).toFixed(4), mono.widthOf('i', 12).toFixed(4));
  assert.ok(FONTS.metrics.body.widthOf('M', 12) > FONTS.metrics.body.widthOf('i', 12), 'Inter is proportional');
});

test('the natural line height is read from the font, not assumed to be 1', () => {
  // OOXML line spacing is a percentage of this, so assuming 1.0 under-computes
  // every block by about a fifth and slides the next one up into it.
  assert.ok(FONTS.metrics.body.naturalLineHeight > 1.1);
  assert.ok(FONTS.metrics.body.naturalLineHeight < 1.5);
});

test('a font missing the tables layout needs is rejected, not half-read', () => {
  assert.throws(() => new FontMetrics(new Uint8Array(64)));
});

test('wrapping respects the width it is given', () => {
  const lines = wrap('one two three four five six seven eight', FONTS.metrics.body, 12, 60);
  assert.ok(lines.length > 1);
  for (const line of lines) {
    assert.ok(FONTS.metrics.body.widthOf(line, 12) <= 60, `"${line}" overflows`);
  }
});

test('a word longer than the line is broken rather than allowed to overflow', () => {
  const lines = wrap('https://example.test/a/very/long/path/that/never/ends', FONTS.metrics.body, 12, 50);
  assert.ok(lines.length > 1);
  for (const line of lines) {
    assert.ok(FONTS.metrics.body.widthOf(line, 12) <= 50, `"${line}" overflows`);
  }
});

// --- PPTX -----------------------------------------------------------------

function pptxParts(bytes) {
  const files = unzipSync(bytes);
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
}

test('a deck contains the parts PowerPoint requires to open it', () => {
  const parts = pptxParts(renderPptx(spec(), META, FONTS.metrics));
  for (const required of [
    '[Content_Types].xml',
    '_rels/.rels',
    'ppt/presentation.xml',
    'ppt/_rels/presentation.xml.rels',
    'ppt/slideMasters/slideMaster1.xml',
    'ppt/slideLayouts/slideLayout1.xml',
    'ppt/theme/theme1.xml',
    'ppt/slides/slide1.xml',
    'ppt/slides/_rels/slide1.xml.rels',
  ]) {
    assert.ok(parts[required], `missing ${required}`);
  }
});

test('a deck is a cover, a slide per section, and a close', () => {
  const parts = pptxParts(
    renderPptx(spec({ sections: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] }), META, FONTS.metrics),
  );
  const slides = Object.keys(parts).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k));
  assert.equal(slides.length, 5, '3 sections + cover + close');
  assert.match(parts['[Content_Types].xml'], /slide5\.xml/, 'content types must declare every slide');
});

test('every slide carries the disclosure label', () => {
  const parts = pptxParts(renderPptx(spec({ disclosure: 'needs_approval' }), META, FONTS.metrics));
  const label = eyebrowCase(DISCLOSURE_LABELS.needs_approval);

  for (const [name, body] of Object.entries(parts)) {
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue;
    assert.ok(body.includes(label), `${name} has no disclosure label`);
  }
});

test('a deck uses only brand colours', () => {
  const parts = pptxParts(renderPptx(spec(), META, FONTS.metrics));
  const allowed = new Set(PALETTE.map((c) => c.replace('#', '').toUpperCase()));

  for (const [name, body] of Object.entries(parts)) {
    if (!name.startsWith('ppt/')) continue;
    for (const match of body.matchAll(/srgbClr val="([0-9A-F]{6})"/g)) {
      assert.ok(allowed.has(match[1]), `${name} uses #${match[1]}, which is not in the palette`);
    }
  }
});

test('a deck names only the brand typefaces', () => {
  const parts = pptxParts(renderPptx(spec(), META, FONTS.metrics));
  // Arial appears once, as the bullet glyph font: it sets the marker, no text.
  const allowed = new Set(['Inter', 'JetBrains Mono', 'Arial', '']);

  for (const [name, body] of Object.entries(parts)) {
    if (!name.startsWith('ppt/')) continue;
    for (const match of body.matchAll(/typeface="([^"]*)"/g)) {
      assert.ok(allowed.has(match[1]), `${name} asks for "${match[1]}"`);
    }
  }
});

test('the same spec renders to the same bytes', () => {
  assert.deepEqual(
    Buffer.from(renderPptx(spec(), META, FONTS.metrics)),
    Buffer.from(renderPptx(spec(), META, FONTS.metrics)),
  );
});

test('a date outside what ZIP can represent still produces an openable deck', () => {
  const bytes = renderPptx(spec(), { ...META, isoDate: '1969-07-20T20:17:00Z' }, FONTS.metrics);
  assert.ok(unzipSync(bytes)['ppt/presentation.xml']);
});

test('markup in model output cannot break out of the XML', () => {
  const parts = pptxParts(
    renderPptx(spec({ title: 'A </a:t></a:r><p:sp> injection attempt' }), META, FONTS.metrics),
  );
  const cover = parts['ppt/slides/slide1.xml'];
  assert.ok(cover.includes('&lt;/a:t&gt;'), 'angle brackets must be escaped');
  assert.equal(
    (cover.match(/<p:sp>/g) || []).length,
    (cover.match(/<\/p:sp>/g) || []).length,
    'shapes stay balanced',
  );
});

// --- PDF ------------------------------------------------------------------

test('a PDF renders and embeds its typefaces rather than naming them', async () => {
  const bytes = await renderPdf(spec({ format: 'pdf' }), META, FONTS);
  assert.match(Buffer.from(bytes.slice(0, 8)).toString('latin1'), /^%PDF-/);

  // The file is read back rather than grepped: pdf-lib writes object streams,
  // so the font programs are compressed and invisible to a byte search.
  const reloaded = await PDFDocument.load(bytes);

  const names = [];
  let embeddedPrograms = 0;

  for (const [, object] of reloaded.context.enumerateIndirectObjects()) {
    const dict = object?.dict;
    if (!dict) continue;
    for (const [key, value] of dict.entries()) {
      const k = String(key);
      if (k === '/FontFile2') embeddedPrograms += 1;
      if (k === '/BaseFont') names.push(String(value));
    }
  }

  assert.ok(embeddedPrograms >= 4, `expected four embedded font programs, found ${embeddedPrograms}`);
  const joined = names.join(' ');
  assert.match(joined, /Inter/);
  assert.match(joined, /JetBrainsMono/);
});

test('a long PDF flows onto more pages rather than off the first one', async () => {
  const long = Array.from({ length: 10 }, (_, i) => ({
    title: `Section ${i}`,
    body: 'A paragraph of body copy that takes several lines on an A4 page once wrapped at the column width. '.repeat(3),
    points: ['one', 'two', 'three'],
  }));

  const one = await PDFDocument.load(await renderPdf(spec({ format: 'pdf' }), META, FONTS));
  const many = await PDFDocument.load(await renderPdf(spec({ format: 'pdf', sections: long }), META, FONTS));

  assert.equal(one.getPageCount(), 1, 'a one-section document is one page');
  assert.ok(many.getPageCount() >= 3, `expected several pages, got ${many.getPageCount()}`);
});

test('the PDF records the disclosure label in its own metadata', async () => {
  const bytes = await renderPdf(spec({ format: 'pdf', disclosure: 'external_ok' }), META, FONTS);
  const reloaded = await PDFDocument.load(bytes);
  assert.equal(reloaded.getSubject(), DISCLOSURE_LABELS.external_ok);
  assert.equal(reloaded.getTitle(), 'VShield for Acme');
});

// --- Delivery -------------------------------------------------------------

function setup(env = {}) {
  const cfg = loadConfig({
    SHAREPOINT_HOSTNAME: 'vikatai.sharepoint.com',
    SHAREPOINT_SITE_PATH: '/sites/VikatGTM',
    ...env,
  });
  return { cfg, storage: createStorage({ VIKAT_KV: fakeKV() }, cfg) };
}

const GRAPH_ENV = { GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 'shhh-secret' };

async function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** A Graph stub: token, then site, then drives, then the upload. */
function graphStub({ uploadOk = true } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method || 'GET' });

    if (u.includes('login.microsoftonline.com')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    }
    if (u.includes('/sites/vikatai.sharepoint.com:')) {
      return { ok: true, status: 200, json: async () => ({ id: 'site-1' }) };
    }
    if (u.endsWith('/drives')) {
      return { ok: true, status: 200, json: async () => ({ value: [{ id: 'drive-1', name: 'Documents' }] }) };
    }
    if (!uploadOk) return { ok: false, status: 403, text: async () => 'denied' };
    return {
      ok: true,
      status: 201,
      json: async () => ({ webUrl: 'https://vikatai.sharepoint.com/x/deck.pptx', name: 'deck.pptx' }),
    };
  };
  fn.calls = calls;
  return fn;
}

const FILE = { fileName: 'deck.pptx', bytes: new Uint8Array(10), contentType: 'a/b' };

test('delivery is skipped, not attempted, when Graph is not configured', async () => {
  resetCaches();
  const { cfg } = setup();
  const stub = stubFetch();
  const r = await withFetch(stub, () => deliverDocument(FILE, {}, cfg));

  assert.equal(r.delivered, false);
  assert.equal(r.reason, 'not_configured');
  assert.equal(stub.calls.length, 0, 'no credentials means no request');
});

test('a generated file is filed in the folder the sync does not read', async () => {
  resetCaches();
  const { cfg } = setup();
  const stub = graphStub();
  const r = await withFetch(stub, () => deliverDocument(FILE, GRAPH_ENV, cfg));

  assert.equal(r.delivered, true);
  const upload = stub.calls.find((c) => c.method === 'PUT');
  assert.ok(upload, 'a PUT must have happened');
  assert.match(upload.url, new RegExp(encodeURIComponent(cfg.SHAREPOINT_GENERATED_FOLDER)));
  assert.match(upload.url, /conflictBehavior=rename/, 'two reps must not overwrite each other');
});

test('the generated-files folder cannot be blanked by an empty setting', () => {
  // The folder is what keeps the assistant's own output out of the sync's
  // scope. An operator who clears the variable gets the default back, not the
  // library root.
  assert.equal(
    setup({ SHAREPOINT_GENERATED_FOLDER: '' }).cfg.SHAREPOINT_GENERATED_FOLDER,
    'Generated by assistant',
  );
});

test('delivery refuses outright when there is no folder keeping generated files apart', async () => {
  // Writing to the library root would let the nightly sync index the
  // assistant's own output, and it would start citing itself as a source.
  resetCaches();
  const { cfg } = setup();
  const stub = graphStub();
  const r = await withFetch(stub, () =>
    deliverDocument(FILE, GRAPH_ENV, { ...cfg, SHAREPOINT_GENERATED_FOLDER: '' }),
  );

  assert.equal(r.delivered, false);
  assert.equal(r.reason, 'no_generated_folder');
  assert.equal(stub.calls.length, 0, 'nothing may be uploaded');
});

test('a Graph refusal is reported, never thrown', async () => {
  resetCaches();
  const { cfg } = setup();
  const r = await withFetch(graphStub({ uploadOk: false }), () => deliverDocument(FILE, GRAPH_ENV, cfg));
  assert.equal(r.delivered, false);
  assert.equal(r.reason, 'forbidden');
});

test('a network failure mid-upload is reported, never thrown', async () => {
  resetCaches();
  const { cfg } = setup();
  const r = await withFetch(async () => { throw new Error('socket hang up'); }, () =>
    deliverDocument(FILE, GRAPH_ENV, cfg),
  );
  assert.equal(r.delivered, false);
  assert.equal(r.reason, 'error');
});

test('a file past the simple-upload limit is refused before it is sent', async () => {
  resetCaches();
  const { cfg } = setup({ MAX_DOCUMENT_BYTES: '100' });
  const stub = graphStub();
  const r = await withFetch(stub, () =>
    deliverDocument({ ...FILE, bytes: new Uint8Array(500) }, GRAPH_ENV, cfg),
  );
  assert.equal(r.reason, 'too_large');
  assert.equal(stub.calls.length, 0);
});

test('the status shown on /health never carries the client secret', () => {
  const { cfg } = setup();
  const status = documentStoreStatus(GRAPH_ENV, cfg);
  assert.equal(status.configured, true);
  assert.ok(!JSON.stringify(status).includes(GRAPH_ENV.GRAPH_CLIENT_SECRET));
});

// --- The whole pipeline ---------------------------------------------------

const USER = { email: 'rep@vikat.ai', name: 'Test Rep' };

const MINIMAL = {
  format: 'pptx',
  title: 'Call prep for Acme',
  subtitle: null,
  audience: 'Acme',
  disclosure: 'internal_only',
  sections: [{ eyebrow: null, title: 'The gap', body: 'Controls lag.', points: [] }],
};

test('a generated document is kept even when SharePoint is unreachable', async () => {
  resetCaches();
  const { cfg, storage } = setup();

  const result = await withFetch(graphStub({ uploadOk: false }), () =>
    createDocument(MINIMAL, { storage, user: USER, env: GRAPH_ENV, cfg, fonts: FONTS, isoDate: META.isoDate }),
  );

  assert.ok(result.ok);
  assert.equal(result.filed, false, 'filing failed');
  assert.ok(result.downloadPath, 'but the rep still has a link');

  const stored = await storage.getDocument(result.id);
  assert.ok(stored, 'the copy the rep downloads must exist regardless');
  assert.equal(stored.fileName, '2026-08-25-call-prep-for-acme.pptx');
});

test('a successful filing hands back the SharePoint link', async () => {
  resetCaches();
  const { cfg, storage } = setup();

  const result = await withFetch(graphStub(), () =>
    createDocument(
      { ...MINIMAL, format: 'pdf', title: 'One pager', disclosure: 'external_ok' },
      { storage, user: USER, env: GRAPH_ENV, cfg, fonts: FONTS, isoDate: META.isoDate },
    ),
  );

  assert.equal(result.filed, true);
  assert.match(result.sharePointUrl, /^https:\/\//);
  assert.equal(result.format, 'pdf');
  assert.equal(result.disclosureLabel, DISCLOSURE_LABELS.external_ok);
});

test('an unusable spec fails before anything is stored or uploaded', async () => {
  resetCaches();
  const { cfg, storage } = setup();
  const stub = graphStub();

  const result = await withFetch(stub, () =>
    createDocument({ format: 'pptx', title: '', sections: [] }, { storage, user: USER, env: GRAPH_ENV, cfg, fonts: FONTS }),
  );

  assert.ok(!result.ok);
  assert.equal(stub.calls.length, 0);
});

test('a stored document round-trips its bytes intact', async () => {
  resetCaches();
  const { cfg, storage } = setup();

  const result = await withFetch(graphStub(), () =>
    createDocument(MINIMAL, { storage, user: USER, env: GRAPH_ENV, cfg, fonts: FONTS, isoDate: META.isoDate }),
  );

  const stored = await storage.getDocument(result.id);
  assert.ok(unzipSync(new Uint8Array(stored.bytes))['ppt/presentation.xml'], 'what comes out of storage is still a deck');
});

test('a document whose body has expired reads as absent, not as a broken file', async () => {
  resetCaches();
  const cfg = loadConfig({ SHAREPOINT_HOSTNAME: 'vikatai.sharepoint.com', SHAREPOINT_SITE_PATH: '/sites/VikatGTM' });
  const kv = fakeKV();
  const storage = createStorage({ VIKAT_KV: kv }, cfg);

  const result = await withFetch(graphStub(), () =>
    createDocument(MINIMAL, { storage, user: USER, env: GRAPH_ENV, cfg, fonts: FONTS, isoDate: META.isoDate }),
  );

  // The two keys expire independently, so the metadata can outlive the body.
  // Returning metadata with no file would give the rep a link to nothing.
  await kv.delete(`docbody:${result.id}`);
  assert.equal(await storage.getDocument(result.id), null);
});

// --- Markdown sections ----------------------------------------------------
// The tool sends structure as markdown in one string, because a nested schema
// is rejected outright by the API. That makes this parser the seam where a
// model's output becomes a document, so it is tested on what models actually
// produce rather than on ideal input.

test('a heading, prose and points become one section', () => {
  const [section] = parseSections(
    '## context | Controls lag behind agents\nThe model ships first.\n- Real credentials\n- No owner',
  );
  assert.equal(section.eyebrow.trim(), 'context');
  assert.equal(section.title.trim(), 'Controls lag behind agents');
  assert.equal(section.body, 'The model ships first.');
  assert.deepEqual(section.points, ['Real credentials', 'No owner']);
});

test('the eyebrow and the pipe are optional', () => {
  const [section] = parseSections('## Just a title\nBody.');
  assert.equal(section.eyebrow, '');
  assert.equal(section.title, 'Just a title');
});

test('preamble before the first heading is dropped, not guessed at', () => {
  // A model that opens with "Here is your deck:" must not produce a section
  // titled that.
  const sections = parseSections('Here is your deck:\n\n## Real section\nBody.');
  assert.equal(sections.length, 1);
  assert.equal(sections[0].title, 'Real section');
});

test('wrapped prose joins into one paragraph', () => {
  // The renderers lay out a single block per section, so successive lines are
  // one paragraph rather than several.
  const [section] = parseSections('## T\nOne line.\nA second line.\n\nA third.');
  assert.equal(section.body, 'One line. A second line. A third.');
});

test('any heading level and any bullet character work', () => {
  // Models are inconsistent about both, and neither carries meaning here.
  for (const hash of ['#', '##', '###', '####']) {
    assert.equal(parseSections(`${hash} Title\n- p`).length, 1, `${hash} should open a section`);
  }
  for (const bullet of ['-', '*', '•']) {
    assert.deepEqual(parseSections(`## T\n${bullet} point`)[0].points, ['point']);
  }
});

test('empty or headingless markdown yields nothing rather than a broken section', () => {
  assert.deepEqual(parseSections(''), []);
  assert.deepEqual(parseSections('Just some prose with no heading at all.'), []);
  assert.deepEqual(parseSections(null), []);
});

test('a markdown document renders end to end', async () => {
  // The path the tool actually takes: markdown in, deck out.
  const r = normaliseSpec({
    format: 'pptx',
    title: 'Call prep for Acme',
    subtitle: 'What to cover.',
    audience: 'Acme security team',
    disclosure: 'internal_only',
    content: '## context | The gap\nControls lag.\n- One\n- Two\n\n## next | What we need\n- A decision',
  });

  assert.ok(r.ok, r.error);
  assert.equal(r.spec.sections.length, 2);
  assert.equal(r.spec.sections[0].eyebrow, 'context');
  assert.deepEqual(r.spec.sections[1].points, ['A decision']);

  const parts = unzipSync(renderPptx(r.spec, META, FONTS.metrics));
  assert.ok(parts['ppt/slides/slide4.xml'], 'cover + 2 sections + close');
});

test('markdown that parses to nothing is refused, not rendered empty', () => {
  const r = normaliseSpec({
    format: 'pdf',
    title: 'Empty',
    subtitle: '',
    audience: '',
    disclosure: 'internal_only',
    content: 'No headings here, so there are no sections.',
  });
  assert.ok(!r.ok);
  assert.match(r.error, /section/i);
});
