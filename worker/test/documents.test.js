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
import zlib from 'node:zlib';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument, PDFName } from 'pdf-lib';
import { wrap as wrapText } from '../src/documents/measure.js';
import { figureSpace } from '../src/documents/pdfFigures.js';
import { CREAM } from '../src/documents/house.js';

import { normaliseSpec, parseSections, parseLayout, fileNameFor, DISCLOSURE_LABELS, LIMITS } from '../src/documents/spec.js';
import { renderPptx } from '../src/documents/pptx.js';
import { renderPdf, drawCover, drawClose } from '../src/documents/pdf.js';
import { renderDocx } from '../src/documents/docx.js';
import { createDocument } from '../src/documents/index.js';
import { loadFonts } from '../src/documents/fonts.js';
import { deliverDocument, documentStoreStatus, resetCaches } from '../src/documentStore.js';
import { sentenceCase, eyebrowCase, brandSafe, PALETTE, COLOR, GRADIENT } from '../src/brand.js';
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
  const r = normaliseSpec({ format: 'keynote', title: 'x', sections: [{ title: 'y' }] });
  assert.ok(!r.ok);
  assert.match(r.error, /format/);
});

test('a spec with no usable section is refused', () => {
  assert.ok(!normaliseSpec({ format: 'pdf', title: 'Just a title', sections: [] }).ok);
  assert.ok(!normaliseSpec({ format: 'pdf', title: 'Just a title', sections: [{ eyebrow: 'x' }] }).ok);
});

test('over-long content is REFUSED, so nothing is cut mid-sentence', () => {
  // This test asserted the opposite, on the reasoning that "a rep mid-call
  // wants the deck, not an error about a bullet being four characters too
  // long". The concern was right and the premise was wrong: the refusal does
  // not reach the rep. normaliseSpec answers create_document, so it lands in a
  // TOOL RESULT, the model shortens the sentence and calls again, and the rep
  // sees a slightly longer wait rather than an error.
  //
  // What the old behaviour cost: a brief went to a CISO reading "touching
  // documents that…", with three more like it, on a build that already had a
  // checker for exactly this — because that checker reports and reporting
  // happens after the PDF exists. The model is the only party that can shorten
  // a sentence without changing what it says, and it is still in the loop when
  // this runs.
  const r = normaliseSpec({
    format: 'pdf',
    title: 'A'.repeat(400),
    content: `## ok\n- ${'B'.repeat(400)}\n- C`,
  });

  assert.equal(r.ok, false);
  assert.match(r.error, /too long for the layout/);
  assert.match(r.error, /Shorten them/);
  assert.match(r.error, new RegExp(`limit is ${LIMITS.titleChars}`), 'the error names the limit to aim at');
});

test('content inside the limits is untouched', () => {
  // The other half: refusing must not become refusing everything.
  const r = normaliseSpec({
    format: 'pdf',
    title: 'A brief that fits',
    content: '## A section that fits\nA paragraph well inside the limit.\n- A point that fits',
  });
  assert.ok(r.ok, r.error);
  assert.doesNotMatch(JSON.stringify(r.spec), /\u2026/, 'no ellipsis may reach a document');
});

test('the section and point counts are capped', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ title: `Section ${i}`, points: Array(20).fill('point') }));
  // Drawn sections among them, because the prose-only rule now covers every
  // format and would otherwise refuse this fixture before any cap was reached.
  // This test is about the caps; it should fail for a cap and nothing else.
  // Inside the section cap, which slices to LIMITS.sections BEFORE the
  // prose-only check, so a drawn section at index 39 is discarded and the
  // fixture is refused as prose. And never index 0, because the assertions
  // below read sections[0].points and a stat carries none. One of them has to
  // land in the first two, and there have to be ceil(12 / 3) of them.
  for (const i of [1, 4, 7, 10]) {
    many[i] = { layout: 'stat', value: '265', caption: 'attacks. Source: ISAC.', title: '', points: [] };
  }
  const s = spec({ format: 'pdf', sections: many });
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

test('a deck is a cover, a slide per section, who we are, and a close', () => {
  // §3.4 makes the credentials close a required slide, so a three section
  // deck is six slides rather than five.
  const parts = pptxParts(
    renderPptx(spec({ sections: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] }), META, FONTS.metrics),
  );
  const slides = Object.keys(parts).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k));
  assert.equal(slides.length, 6, '3 sections + cover + who we are + close');
  assert.match(parts['[Content_Types].xml'], /slide6\.xml/, 'content types must declare every slide');
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
  // Drawn sections, so the prose-only rule does not refuse this fixture before
  // it can measure what it is actually about: flowing onto more pages. One in
  // the opening two, and ceil(10 / 3) of them in total.
  for (const i of [0, 3, 6, 9]) {
    long[i] = { layout: 'stat', value: '265', caption: 'attacks. Source: ISAC.', title: '', points: [] };
  }

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

test('a configured site id means filing never looks the site up by path', async () => {
  // The call that would have broken this on day one. GET /sites/{host}:/{path}
  // is a separate operation a Sites.Selected grant does not cover, so it
  // answers 401 generalException — indistinguishable from having no grant, and
  // it cost four rounds of wrong diagnosis when the SYNC hit it. documentStore
  // carried the identical call, so filing would have failed the moment the
  // Graph secrets were set. And it fails soft: the rep still gets their
  // download and nothing anywhere says why nothing was archived.
  resetCaches();
  const { cfg } = setup();
  cfg.SHAREPOINT_SITE_ID = 'vikatai.sharepoint.com,site-guid,web-guid';

  const stub = graphStub();
  const r = await withFetch(stub, () => deliverDocument(FILE, GRAPH_ENV, cfg));

  assert.equal(r.delivered, true);

  const byPath = stub.calls.filter((c) => /\/sites\/[^/]+:/.test(c.url));
  assert.deepEqual(
    byPath.map((c) => c.url),
    [],
    'filing must not resolve the site by path when an id is configured',
  );
  assert.ok(
    stub.calls.some((c) => c.url.includes(`/sites/${cfg.SHAREPOINT_SITE_ID}/drives`)),
    'it should go straight to the drives on the configured id',
  );
});

test('without a site id it still works, by path', async () => {
  // The fallback has to keep working: a tenant that grants Sites.ReadWrite.All
  // needs no id, and demanding one would be a setup step for nothing.
  resetCaches();
  const { cfg } = setup();
  cfg.SHAREPOINT_SITE_ID = '';

  const stub = graphStub();
  const r = await withFetch(stub, () => deliverDocument(FILE, GRAPH_ENV, cfg));

  assert.equal(r.delivered, true);
  assert.ok(
    stub.calls.some((c) => c.url.includes('/sites/vikatai.sharepoint.com:')),
    'the path lookup is the documented fallback',
  );
});

test('a site id alone is enough to count as configured', async () => {
  // graphConfigured used to require hostname AND path. An id names the site on
  // its own, and refusing to file because a redundant field is blank would be
  // the panel's old "not configured" lie in a new place.
  const { cfg } = setup();
  cfg.SHAREPOINT_SITE_ID = 'host,site,web';
  cfg.SHAREPOINT_HOSTNAME = '';
  cfg.SHAREPOINT_SITE_PATH = '';

  assert.equal(documentStoreStatus(GRAPH_ENV, cfg).configured, true);
  assert.equal(documentStoreStatus({}, cfg).configured, false, 'credentials are still required');
});

// --- drawn slides ---------------------------------------------------------

const DRAWN_CONTENT = [
  '## stat | 265 | attacks on food and agriculture in 2025',
  'Harvest windows are the target.',
  '',
  '## timeline | Plant | Grow | Harvest | Ship | Dormant',
  'Severity scoring is calendar-blind',
  '- A medium CVE in March is a medium CVE in October',
  '',
  '## split | Ranked by CVSS alone | Ranked by what the season costs',
  'The gap',
  '',
  '## chain | VSentinel > VInsight > VCommand > VShield',
  'Four planes',
  '',
  '## bars | MTTR 71 | Alert noise 90 | Triage 64',
  'Measured',
  '',
  '## quote | A harvest does not wait for your patch window.',
].join('\n');

const drawnSpec = (overrides = {}) => {
  const r = normaliseSpec({
    format: 'pptx',
    title: 'SecSemantic for agriculture',
    subtitle: 'Defend what the harvest depends on.',
    audience: 'Agricultural producer security leadership',
    disclosure: 'external_ok',
    content: DRAWN_CONTENT,
    ...overrides,
  });
  assert.ok(r.ok, r.error);
  return r.spec;
};

test('each layout directive parses into the data its drawing needs', () => {
  const sections = drawnSpec().sections;
  assert.deepEqual(sections.map((s) => s.layout), ['stat', 'timeline', 'split', 'chain', 'bars', 'quote']);

  assert.equal(sections[0].value, '265');
  assert.deepEqual(sections[1].stops, ['Plant', 'Grow', 'Harvest', 'Ship', 'Dormant']);
  assert.deepEqual(sections[3].steps, ['VSentinel', 'VInsight', 'VCommand', 'VShield']);
  assert.deepEqual(sections[4].bars, [
    { label: 'MTTR', value: 71 },
    { label: 'Alert noise', value: 90 },
    { label: 'Triage', value: 64 },
  ]);
});

test('a bullet after a timeline does not become a sixth stop', () => {
  // It did. asText() handed the fallback the SAME array as the layout, so the
  // bullet parsed on the next line was pushed into the stops too and the
  // timeline grew a stop reading "A medium CVE in…".
  const timeline = drawnSpec().sections[1];
  assert.equal(timeline.stops.length, 5);
  assert.ok(!timeline.stops.some((s) => /medium CVE/.test(s)));
});

test('a chart can be titled, and the title is not mistaken for data', () => {
  // bars, chain and timeline had no title slot, so they rendered as a bare
  // rule above a drawing — a slide the presenter explains from memory.
  const bars = parseLayout('bars | Where the response time goes | MTTR 71 | Alert noise 90');
  assert.equal(bars.title, 'Where the response time goes');
  assert.equal(bars.bars.length, 2, 'and the heading is not counted as a bar');

  const chain = parseLayout('chain | How the suite fits | VSentinel > VInsight > VCommand');
  assert.equal(chain.title, 'How the suite fits');
  assert.equal(chain.steps.length, 3);

  // A timeline stop and a title look identical, so a title must be written as
  // one. Anything else stays a stop, and every existing deck parses unchanged.
  const timeline = parseLayout('timeline | The first ninety days: | Discover | Baseline | Enforce');
  assert.equal(timeline.title, 'The first ninety days');
  assert.equal(timeline.stops.length, 3);
});

test('an untitled chart still parses exactly as it always did', () => {
  // Every deck written before the title slot existed has to keep working.
  const bars = parseLayout('bars | MTTR 71 | Alert noise 90 | Triage 64');
  assert.equal(bars.bars.length, 3, 'no bar may be eaten as a heading');
  assert.ok(!bars.title);

  const chain = parseLayout('chain | VSentinel > VInsight > VCommand');
  assert.equal(chain.steps.length, 3);
  assert.ok(!chain.title);

  const timeline = parseLayout('timeline | Plant | Grow | Harvest');
  assert.equal(timeline.stops.length, 3, 'a stop without a colon is a stop');
  assert.ok(!timeline.title);
});

test('a titled chart keeps its data in the text a PDF reads', () => {
  // pdf.js knows nothing about layouts. Before, the title of a titled chain
  // replaced the steps entirely and they vanished from the PDF.
  const { spec } = normaliseSpec({
    format: 'pdf',
    title: 'T',
    content: '## chain | How the suite fits | VSentinel > VInsight > VCommand',
  });

  const [section] = spec.sections;
  assert.equal(section.title, 'How the suite fits');
  assert.ok(section.points.join(' ').includes('VSentinel'), 'the steps must survive into text');
});

test('every layout still carries its content as text, for renderers that cannot draw', () => {
  // pdf.js reads title, body and points and knows nothing about layouts.
  // Without this a stat section would render as an empty heading and the
  // number would vanish — the worst way for a feature to be missing.
  for (const section of drawnSpec().sections) {
    const asText = [section.title, section.body, ...section.points].join(' ');
    assert.ok(asText.trim(), `${section.layout} has no textual form`);
  }

  const [stat, , , chain, bars] = drawnSpec().sections;

  // In the POINTS, like chain and timeline, and for the same reason. Once
  // pdf.js learned to draw a stat, a title holding the same words put
  // "265: ransomware attacks hit food and agriculture in 2025, up from 167 in
  // 2023. Source:…" on the page as a truncated two-line heading with the
  // figure drawing 265 and the full caption directly underneath it.
  assert.equal(stat.title, '', 'a drawn figure never takes its own data as its headline');
  assert.match(stat.points.join(' '), /265/, 'the number survives into text');
  assert.ok(bars.points.some((p) => /71/.test(p)), 'the figures survive into text');

  // In the POINTS, never the title. This line used to read
  // `assert.match(chain.title, /VSentinel/)`, and it was pinning a defect:
  // a chain with no author heading put its own step list up as the headline,
  // which the PPTX renderer then drew again as boxes directly underneath. The
  // headline was truncated with an ellipsis, because a step list is not a
  // sentence, and its arrows had been stripped by EMOJI_RE on the way, so the
  // slide read "A two hour working session with your SOC leads a read only
  // look at one site a findings…" over a diagram saying the same thing.
  //
  // Nothing caught it because the assertion above only asked that the text
  // exist SOMEWHERE, and the title is somewhere. Rendering the deck and
  // looking at slide 11 is what caught it.
  assert.equal(chain.title, '', 'a drawn slide never takes its own data as its headline');
  assert.match(chain.points.join(' '), /VSentinel/, 'the steps survive as text for the pdf');
  assert.doesNotMatch(chain.points.join(' '), /\u2192/, 'EMOJI_RE eats U+2192; the join must not emit one');
});

test('a pdf of drawn sections loses nothing', async () => {
  const spec = drawnSpec({ format: 'pdf' });
  const bytes = await renderPdf(spec, META, FONTS);
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 1);
});

test('drawn slides obey the palette and the two typefaces', () => {
  // The same rule the prose slides live under: a layout that reached for a
  // colour outside the brand would look designed and be wrong.
  const parts = pptxParts(renderPptx(drawnSpec(), META, FONTS.metrics));
  const slides = Object.entries(parts).filter(([name]) => /slide\d+\.xml$/.test(name));
  assert.equal(slides.length, 9, 'cover, six drawn slides, who we are, closing');

  const allowed = new Set(PALETTE.map((c) => c.replace('#', '').toUpperCase()));
  for (const [name, xml] of slides) {
    for (const [, value] of xml.matchAll(/<a:srgbClr val="([0-9A-Fa-f]{6})"\/>/g)) {
      assert.ok(allowed.has(value.toUpperCase()), `${name} uses ${value}, which is not in the palette`);
    }
    for (const [, face] of xml.matchAll(/typeface="([^"]+)"/g)) {
      // Arial names the bullet glyph and sets no text, the same allowance the
      // prose test makes. The credentials close is a bulleted slide, so a
      // drawn deck now contains one.
      assert.ok(/^(Inter|JetBrains Mono|Arial)$/.test(face), `${name} uses ${face}`);
    }
  }
});

test('a warning stamp is on every slide, and a cleared deck carries none', () => {
  // Drawn by the renderer, not the model, so there is no layout that can omit
  // it — including the full-bleed quote slide, which has the least room.
  //
  // The second half is the correction. This test used to assert that an
  // external_ok deck stamped "CLEARED FOR CUSTOMERS" on every slide, and it
  // passed while a PDF went to a CISO with that line in mono capitals on all
  // three pages. The stamp exists to warn a REP holding something they must
  // not send; a cleared document has nothing to warn anyone about, so on the
  // one document that actually reaches a customer the label is pure leakage,
  // announcing an internal review process to the person it was cleared for.
  const slidesOf = (spec) =>
    Object.entries(pptxParts(renderPptx(spec, META, FONTS.metrics)))
      .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name));

  for (const [name, xml] of slidesOf(drawnSpec({ disclosure: 'internal_only' }))) {
    assert.ok(
      xml.includes(eyebrowCase(DISCLOSURE_LABELS.internal_only)),
      `${name} has no warning stamp, and it is the one that needs one`,
    );
  }

  for (const [name, xml] of slidesOf(drawnSpec({ disclosure: 'external_ok' }))) {
    assert.ok(
      !/CLEARED FOR CUSTOMERS/i.test(xml),
      `${name} stamps internal clearance language on a deck going to a customer`,
    );
  }
});

test('a malformed directive is refused, not quietly demoted to a heading', () => {
  // This test used to assert the opposite, on the reasoning that an empty
  // chart is worse than the paragraph it replaced. That reasoning still holds;
  // the paragraph was the part that never arrived.
  //
  // A failed directive fell through to the prose branch, where the text before
  // the first pipe becomes the EYEBROW. So a table whose rows were separated
  // with slashes rendered a slide with "TABLE ^ WHAT YOU WOULD MEASURE" set in
  // mono capitals above a headline that was the raw comma-separated data,
  // truncated mid-row. The authoring syntax, on a slide a rep would have sent
  // to a customer. The old test passed throughout: it checked that no drawing
  // was produced and never looked at what was.
  //
  // Refused rather than repaired, for the reason normaliseSpec already gives
  // about prose-only decks: the model is in a tool loop and rebuilds for free,
  // and there is no way to guess where the author meant the pipes to go.
  for (const heading of ['## bars | nothing numeric here', '## chain | OnlyOneStep', '## stat |']) {
    const r = normaliseSpec({ format: 'pptx', title: 'T', content: `${heading}\nBody text.` });
    assert.equal(r.ok, false, `${heading} should have been refused`);
    assert.match(r.error, /will not parse/);
  }
});

test('a refused directive says which heading and how to separate its data', () => {
  // The cost of refusing is a wasted round trip, so the error has to be
  // actionable enough that the next attempt is the last one.
  const r = normaliseSpec({
    format: 'pptx',
    title: 'T',
    content: '## table ^ What you would measure | Outcome, Measure / Continuity, Lines held',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /table layout/, 'names the layout');
  assert.match(r.error, /What you would measure/, 'quotes the heading, so it can be found');
  assert.match(r.error, /"\|"/, 'says what the separator is');
});

test('a heading that merely starts with a layout word is still prose', () => {
  // The cost of the refusal above: "Table | stakes for the board" is a
  // sentence a rep might write, and it is indistinguishable from a broken
  // table directive. An unknown word is NOT, so it keeps falling through —
  // only a real layout name that then fails to parse is treated as broken.
  const r = normaliseSpec({ format: 'pptx', title: 'T', content: '## sankey | a | b\nBody.' });
  assert.ok(r.ok, 'an unrecognised directive is a heading, not an error');
});

test('an unknown directive is a title, not a silent drop', () => {
  const r = normaliseSpec({ format: 'pptx', title: 'T', content: '## sankey | a | b\nBody.' });
  assert.ok(r.ok);
  assert.equal(r.spec.sections[0].layout, undefined);
  assert.match(r.spec.sections[0].title, /a \| b/i, 'the words still reach the slide');
});

// --- visual richness ------------------------------------------------------

const proseDeck = (n) =>
  Array.from({ length: n }, (_, i) => `## section ${i} | Heading ${i}\nSome prose for slide ${i}.`).join('\n\n');

test('a deck of nothing but prose is refused, not quietly built', () => {
  // What a rep actually got when they asked for five visual slides. Refused
  // rather than warned about: a warning attached to a built file is one nobody
  // reads, because the deck is already in SharePoint by then.
  const r = normaliseSpec({ format: 'pptx', title: 'SecSemantic for agriculture', content: proseDeck(5) });

  assert.equal(r.ok, false);
  assert.match(r.error, /drawn figure/);
  // The message has to be actionable, or the model cannot fix it.
  for (const layout of ['stat', 'bars', 'chain', 'timeline', 'split', 'quote']) {
    assert.match(r.error, new RegExp(layout), `the refusal must name ${layout}`);
  }
});

test('one drawn slide at the back is NOT enough', () => {
  // This asserted the opposite: "the rule is against a deck that draws
  // NOTHING, not a quota. A quota would push the model to decorate slides
  // whose content has no shape."
  //
  // The second sentence is still true and is why the quota is a third rather
  // than a half. The first was wrong in practice: a floor is what the model
  // builds to. A brief came back with one tiles figure on page 2 and every
  // other section prose, which satisfied "at least one" and was still the wall
  // of text the rule exists to stop — and page one, the page that decides
  // whether page two is read, was unbroken paragraphs.
  const backOnly = normaliseSpec({
    format: 'pptx',
    title: 'T',
    content: `${proseDeck(5)}\n\n## quote | The one line to end on.`,
  });
  assert.equal(backOnly.ok, false);
  assert.match(backOnly.error, /drawn figure/);

  // And the same deck with the quota met, but every figure at the back, is
  // still refused — for the position rather than the count. Four prose
  // sections and two drawn ones is ceil(6 / 3), so the ratio has nothing to
  // say about it and only the opening rule is left to catch it.
  const allAtTheBack = normaliseSpec({
    format: 'pptx',
    title: 'T',
    content: [
      proseDeck(4),
      '## paradigm | The question has moved | Ranked by severity | Ranked by consequence',
      '## quote | The one line to end on.',
    ].join('\n\n'),
  });
  assert.equal(allAtTheBack.ok, false);
  assert.match(allAtTheBack.error, /opening is unbroken prose/);

  // A third, with one of them up front, passes.
  const r = normaliseSpec({
    format: 'pptx',
    title: 'T',
    content: [
      '## stat | 79% | of enterprises have zero agent visibility. Source: Gartner.',
      proseDeck(3),
      '## paradigm | The question has moved | Ranked by severity | Ranked by consequence',
      '## quote | The one line to end on.',
    ].join('\n\n'),
  });
  assert.ok(r.ok, r.error);
});

test('a figure early is not a quota on every section', () => {
  // The other half: the rule must not push the model to decorate content that
  // has no shape. Six sections need two figures, not six.
  const r = normaliseSpec({
    format: 'pdf',
    title: 'T',
    content: [
      '## stat | 79% | of enterprises have zero agent visibility. Source: Gartner.',
      proseDeck(4),
      '## quote | The one line to end on.',
    ].join('\n\n'),
  });
  assert.ok(r.ok, r.error);
});

test('a short deck may be all prose', () => {
  // A three-slide summary is legitimately prose. Refusing those would teach
  // the model to pad a deck rather than to visualise one.
  assert.ok(normaliseSpec({ format: 'pptx', title: 'T', content: proseDeck(3) }).ok);
});

test('a pdf of nothing but prose is refused too', () => {
  // This asserted the opposite: "It is a document. Paragraphs are the point."
  // That was true while pdf.js could not draw. It can now — stat, bars, tiles,
  // timeline and paradigm — and the exemption outlived the limitation: a brief
  // to a CISO came back as four pages of paragraphs and bullet lists, because
  // nothing required the renderer to draw what it was newly able to draw.
  const r = normaliseSpec({ format: 'pdf', title: 'T', content: proseDeck(8) });
  assert.equal(r.ok, false);
  assert.match(r.error, /drawn figure/);
  assert.match(r.error, /stat, bars, tiles/, 'the refusal names what to reach for');
});

test('a short document is still allowed to be prose', () => {
  // The threshold matters as much as the rule. A two-paragraph note is a note,
  // and refusing it would teach the model to pad a short answer into a long
  // one to satisfy a checker.
  const r = normaliseSpec({ format: 'pdf', title: 'T', content: proseDeck(2) });
  assert.ok(r.ok, r.error);
});

// --- DOCX -----------------------------------------------------------------

const docxSpec = (content, overrides = {}) => {
  const r = normaliseSpec({
    format: 'docx',
    title: 'SecSemantic for agriculture',
    subtitle: 'Defend what the harvest depends on.',
    audience: 'Agricultural producer security leadership',
    disclosure: 'external_ok',
    content:
      content ||
      [
        '## context | Why agriculture is targeted',
        'Attackers time intrusions to the calendar.',
        '- Seventeen days offline during harvest is a season',
        '',
        '## stat | 265 | attacks on food and agriculture in 2025',
        'Harvest windows are the target.',
        '',
        '## bars | MTTR 71 | Alert noise 90',
        'Measured',
        '',
        '## chain | VSentinel > VInsight > VCommand > VShield',
        'Four planes',
        '',
        '## quote | A harvest does not wait for your patch window.',
      ].join('\n'),
    // Second argument, so every existing positional call is untouched. The
    // disclosure is the one field a test needs to vary now that it decides
    // whether anything is stamped at all.
    ...overrides,
  });
  assert.ok(r.ok, r.error);
  return r.spec;
};

const docxParts = (bytes) => {
  const files = unzipSync(bytes);
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
};

test('a docx contains the parts Word requires to open it', () => {
  const parts = docxParts(renderDocx(docxSpec(), META));
  for (const required of [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/document.xml',
    'word/_rels/document.xml.rels',
    'word/styles.xml',
    'word/footer1.xml',
  ]) {
    assert.ok(parts[required], `missing ${required}`);
  }
});

test('every table declares a grid', () => {
  // CT_Tbl puts w:tblGrid immediately after w:tblPr, and Word and LibreOffice
  // both refuse the whole FILE without it. python-docx parses it happily,
  // which is how a document that cannot be opened can look fine from a script.
  const doc = docxParts(renderDocx(docxSpec(), META))['word/document.xml'];
  const tables = (doc.match(/<w:tbl>/g) || []).length;
  const grids = (doc.match(/<w:tblGrid>/g) || []).length;
  assert.ok(tables > 0, 'the drawn layouts should have produced tables');
  assert.equal(grids, tables, 'every table needs its grid');
});

test('a docx uses only the palette and the two typefaces', () => {
  // The same rule the deck and the pdf live under. Word additionally falls
  // back to Calibri for anything unstyled, which is why styles.xml sets the
  // default too — "approximately the brand" is what a guideline exists to
  // prevent.
  const parts = docxParts(renderDocx(docxSpec(), META));
  const allowed = new Set(PALETTE.map((c) => c.replace('#', '').toUpperCase()));

  for (const name of ['word/document.xml', 'word/footer1.xml', 'word/styles.xml']) {
    for (const [, value] of parts[name].matchAll(/w:(?:color|fill) w:val="([0-9A-Fa-f]{6})"/g)) {
      assert.ok(allowed.has(value.toUpperCase()), `${name} uses ${value}, which is not in the palette`);
    }
    for (const [, face] of parts[name].matchAll(/w:ascii="([^"]+)"/g)) {
      assert.ok(/^(Inter|JetBrains Mono)$/.test(face), `${name} uses ${face}`);
    }
  }
});

test('the disclosure label is in the footer, so it repeats on every page', () => {
  // Drawn by the renderer into a footer part rather than written by the model
  // at the end of the text: Word repeats a footer on every page by itself,
  // which is the same guarantee the deck gets by drawing it on each slide.
  const parts = docxParts(renderDocx(docxSpec(null, { disclosure: 'needs_approval' }), META));
  assert.ok(parts['word/footer1.xml'].includes(eyebrowCase(DISCLOSURE_LABELS.needs_approval)));
  assert.match(parts['word/document.xml'], /<w:footerReference w:type="default"/, 'and the body must reference it');

  // And a cleared document does NOT fall back to stamping "Internal only",
  // which is what `DISCLOSURE_LABELS[d] || DISCLOSURE_LABELS.internal_only`
  // did the moment external_ok stopped returning a string.
  const cleared = docxParts(renderDocx(docxSpec(null, { disclosure: 'external_ok' }), META));
  assert.doesNotMatch(cleared['word/footer1.xml'], /INTERNAL ONLY|CLEARED FOR CUSTOMERS/i);
});

test('a docx of pure prose is refused on the same terms', () => {
  // Also reversed. The old reasoning — "the drawn-layout rule is about decks"
  // — treated Word as a place for paragraphs, and this Word output is not a
  // draft somebody edits: it is brand-locked customer collateral, and it goes
  // to the same reader as the pdf.
  //
  // The layouts still reach it as text, so a docx loses formatting and never
  // content. What it stops is an eight-section document with nothing in it but
  // paragraphs.
  const r = normaliseSpec({ format: 'docx', title: 'T', content: proseDeck(8) });
  assert.equal(r.ok, false);
  assert.match(r.error, /wall of text/);

  const drawn = normaliseSpec({
    format: 'docx',
    title: 'T',
    content: [
      '## stat | 580,000 | cases a year. Source: AAA.',
      proseDeck(5),
      '## paradigm | The question has moved | Ranked by severity | Ranked by consequence',
      '## quote | The one line to end on.',
    ].join('\n\n'),
  });
  assert.ok(drawn.ok, drawn.error);
  assert.ok(renderDocx(drawn.spec, META).length > 0, 'and it still renders');
});

test('a bar never spans more of the grid than it has', () => {
  // The bar is drawn in twelfths, so a rounding error would let a value paint
  // past the track — and the printed number beside it would then disagree with
  // the picture.
  const spec = docxSpec('## bars | Tiny 1 | Huge 100\nMeasured');
  const doc = docxParts(renderDocx(spec, META))['word/document.xml'];

  for (const [, span] of doc.matchAll(/<w:gridSpan w:val="(\d+)"\/>/g)) {
    assert.ok(Number(span) <= 12, `a cell spans ${span} of 12 columns`);
  }
  assert.match(doc, />100</, 'the real figure is printed, so the scaling cannot overstate it');
});

test('a heading that is two sentences capitalises both', () => {
  // Shipped to a customer, twice on one page of a four-page document, in the
  // two headings that carried the argument:
  //   "Every console returns severity. the board asks consequence."
  //   "Severity misprices risk. the loss from an intrusion is set by…"
  // The minor-word pass lowercases "the" wherever it is not word zero, and
  // only the first word of the whole string was ever re-capitalised.
  assert.equal(
    sentenceCase('Every console returns severity. The board asks consequence.'),
    'Every console returns severity. The board asks consequence.',
  );
  assert.equal(
    sentenceCase('Severity misprices risk. The loss is set by what the business was doing.'),
    'Severity misprices risk. The loss is set by what the business was doing.',
  );
  // Question and exclamation ends the same way.
  assert.equal(sentenceCase('Why now? The window is open.'), 'Why now? The window is open.');
});

test('a single sentence is unchanged, which is why this went unnoticed', () => {
  // Every fixture in this file was one sentence, and one sentence is exactly
  // the case the function already got right.
  assert.equal(
    sentenceCase('Severity scores do not know your delivery window'),
    'Severity scores do not know your delivery window',
  );
  assert.equal(sentenceCase('The reliability layer for production AI'), 'The reliability layer for production AI');
});

test('a mid-sentence abbreviation is not treated as a new sentence', () => {
  // "U.S. the" would be wrong to capitalise; the rule needs whitespace after
  // the stop, which an abbreviation inside a word does not have.
  assert.match(sentenceCase('Across the U.S. and Canada'), /U\.S\. and Canada/);
});

// --- Drawn figures ----------------------------------------------------------

/**
 * A page that records what was drawn on it.
 *
 * Asserting on draw calls rather than on the rendered PDF, because the first
 * version of these tests checked page counts and module exports — and BOTH
 * mutations escaped: deleting the drawFigure call entirely, and drawing the
 * figure AND repeating its points underneath, each left every test green.
 * A test that cannot tell whether anything was drawn is not testing drawing.
 */
function recordingFlow() {
  const calls = { text: [], rect: [] };
  const page = {
    drawText: (t, o) => calls.text.push({ t, ...o }),
    drawRectangle: (o) => calls.rect.push(o),
  };
  return {
    calls,
    page,
    y: 700,
    remaining: 600,
    newPage() { this.y = 700; },
    gap(n) { this.y -= n; },
    wrapText(text, { metrics, size, width }) {
      return wrapText(text, metrics, size, width);
    },
  };
}

/** The 0..1 triple figureDeps' rgb stub produces for a brand hex. */
const hex = (h) => ({
  r: parseInt(h.slice(1, 3), 16) / 255,
  g: parseInt(h.slice(3, 5), 16) / 255,
  b: parseInt(h.slice(5, 7), 16) / 255,
});
const same = (a, b) => !!a && Math.abs(a.r - b.r) < 1e-6 && Math.abs(a.g - b.g) < 1e-6 && Math.abs(a.b - b.b) < 1e-6;

const figureDeps = () => ({
  rgb: (r, g, b) => ({ r, g, b }),
  fonts: { ...FONTS, display: 'display', heading: 'heading', body: 'body' },
  column: 483,
  left: 56,
});

test('a stat is DRAWN at figure size, not set as a heading', async () => {
  // The finding that started this: "7.5x: projected risk reduction from
  // reordering the same security budget by business risk…" arrived as a
  // truncated two-line bold sentence, because asText() flattened every layout
  // and pdf.js had never been taught any of them.
  const { drawFigure } = await import('../src/documents/pdfFigures.js');
  const r = normaliseSpec({ format: 'pdf', title: 'T', content: '## stat | 7.5x | risk reduction, per McKinsey.' });
  assert.ok(r.ok, r.error);

  // The words survive as a point for a renderer that cannot draw, and the
  // title stays empty so the page does not say it twice.
  assert.equal(r.spec.sections[0].title, '');
  assert.match(r.spec.sections[0].points.join(' '), /7\.5x/);

  const flow = recordingFlow();
  assert.equal(drawFigure(flow, r.spec.sections[0], figureDeps()), true);

  const value = flow.calls.text.find((c) => c.t === '7.5x');
  assert.ok(value, JSON.stringify(flow.calls.text));
  assert.ok(value.size >= 30, `the figure was drawn at ${value.size}pt, which is heading size`);
  assert.ok(flow.calls.rect.length >= 1, 'the accent rule is part of the figure');
});

test('bars draw a track and a fill each, and the largest takes the accent', async () => {
  const { drawFigure } = await import('../src/documents/pdfFigures.js');
  const r = normaliseSpec({ format: 'pdf', title: 'T', content: '## bars | Where it goes | Alpha 61 | Beta 44 | Gamma 22' });
  assert.ok(r.ok, r.error);

  const flow = recordingFlow();
  assert.equal(drawFigure(flow, r.spec.sections[0], figureDeps()), true);

  assert.equal(flow.calls.rect.length, 6, 'three bars, each a track and a fill');

  // Scaled to the largest value, not to 100: 61, 44 and 22 against 100 draw
  // three stubs and throw away the comparison the chart exists for.
  const fills = flow.calls.rect.filter((_, i) => i % 2 === 1).map((rect) => rect.width);
  assert.ok(fills[0] > fills[1] && fills[1] > fills[2], JSON.stringify(fills));
  assert.ok(fills[0] > fills[2] * 2, 'the longest bar should dominate, as 61 does 22');

  // The largest is the point of the chart, so it is the one coloured apart.
  const colours = flow.calls.rect.filter((_, i) => i % 2 === 1).map((rect) => JSON.stringify(rect.color));
  assert.notEqual(colours[0], colours[1], 'the largest bar must be distinguishable');
  assert.equal(colours[1], colours[2], 'and the rest must recede together');
});

test('a paradigm draws two cells and an arrow between them', async () => {
  const { drawFigure } = await import('../src/documents/pdfFigures.js');
  const r = normaliseSpec({
    format: 'pdf',
    title: 'T',
    content: '## paradigm | The question has moved | Ranked by CVSS | Ranked by what stops shipping',
  });
  assert.ok(r.ok, r.error);

  const flow = recordingFlow();
  assert.equal(drawFigure(flow, r.spec.sections[0], figureDeps()), true);

  // Two cells, a shaft, and the five slices of the arrowhead.
  assert.ok(flow.calls.rect.length >= 8, `only ${flow.calls.rect.length} shapes`);
  const said = flow.calls.text.map((c) => c.t).join(' ');
  assert.match(said, /CVSS/);
  assert.match(said, /stops shipping/);
});

test('a layout pdf.js cannot draw still reaches the page as words', async () => {
  // drawFigure returns false rather than throwing, so a layout this renderer
  // has not been taught costs formatting and never content.
  //
  // This used `table` as the example, which is now drawn — the layouts left
  // undrawn on a page are the deck furniture: kpi, outcome, logos and suite.
  const { drawFigure } = await import('../src/documents/pdfFigures.js');
  const r = normaliseSpec({
    format: 'pdf',
    title: 'T',
    content: '## kpi | The scoreboard | Lines held: 99.2% | Alerts closed: within 4 hours',
  });
  assert.ok(r.ok, r.error);
  assert.equal(r.spec.sections[0].layout, 'kpi');
  assert.match(r.spec.sections[0].points.join(' '), /Lines held/, 'the measures survive as text');

  const flow = recordingFlow();
  assert.equal(drawFigure(flow, r.spec.sections[0], figureDeps()), false);
  assert.equal(flow.calls.rect.length, 0, 'nothing half-drawn');
});

test('the layouts a brief actually uses are drawn, not flattened to prose', async () => {
  // Five of eleven layouts reached the page as another navy heading: quote,
  // split, chain, flow and table. A document ending on a quote set exactly
  // like the six headings above it has no ending, and a table rendered as a
  // sentence has lost the only thing it had.
  //
  // This matters beyond looks. normaliseSpec now requires a third of sections
  // to carry a drawn figure, and it counts layouts — so a document could meet
  // that quota with six quote sections and still render as unbroken text. The
  // quota is only honest if the renderer draws what the quota counts.
  const { drawFigure } = await import('../src/documents/pdfFigures.js');

  const cases = {
    quote: '## quote | The calendar sets the price of an intrusion.',
    split: '## split | Ranked by severity | Ranked by consequence',
    chain: '## chain | Signal > Context > Consequence > Action',
    flow: '## flow | Detect > *Rank > Act',
    table: '## table | The scoreboard | Outcome, Measure | Continuity, Lines held | Effort, Alerts closed',
  };

  for (const [layout, content] of Object.entries(cases)) {
    const r = normaliseSpec({ format: 'pdf', title: 'T', content });
    assert.ok(r.ok, `${layout}: ${r.error}`);
    assert.equal(r.spec.sections[0].layout, layout);

    const flow = recordingFlow();
    assert.equal(drawFigure(flow, r.spec.sections[0], figureDeps()), true, `${layout} was not drawn`);
    assert.ok(flow.calls.rect.length >= 2, `${layout} drew only ${flow.calls.rect.length} shapes`);

    // And it reserved room for itself. A figure that reports zero height gets
    // a page break in the middle of it, which is worse than not drawing at all.
    assert.ok(
      figureSpace(r.spec.sections[0], flow, figureDeps()) > 20,
      `${layout} claims no space`,
    );
  }
});

/**
 * The colours a rendered PDF actually paints.
 *
 * The deck and the docx have had a palette test since they were written, and
 * the docx one says "the same rule the deck and the pdf live under" — which
 * was not true: there was no pdf one. A PDF's content streams are Flate
 * compressed and its type is subsetted, so nothing in the file is greppable,
 * and the test that should have existed was never written.
 *
 * It cost exactly what an untested rule costs. Repainting the page ground from
 * cream back to white — the single change this whole pass is about — left all
 * 760 tests green.
 */
function pdfFills(bytes) {
  const buf = Buffer.from(bytes);
  const fills = [];

  for (const m of buf.toString('latin1').matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length;
    const end = buf.indexOf('endstream', start, 'latin1');
    let body;
    try {
      body = zlib.inflateSync(buf.subarray(start, end)).toString('latin1');
    } catch {
      continue; // a font or image stream, not page content
    }
    for (const [, r, g, b] of body.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) (?:rg|RG)/g)) {
      fills.push({ r: Number(r), g: Number(g), b: Number(b) });
    }
  }

  return fills;
}

/** Is `c` a point on the brand gradient, rather than a colour of its own? */
const onGradient = (c) => {
  const stops = GRADIENT.stops.map(hex);
  for (let i = 0; i < stops.length - 1; i += 1) {
    const [a, b] = [stops[i], stops[i + 1]];
    // Solve for t on the channel that moves most, then check the other two.
    const spans = [['r', b.r - a.r], ['g', b.g - a.g], ['b', b.b - a.b]];
    const [key, span] = spans.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))[0];
    const t = (c[key] - a[key]) / span;
    if (t < -0.01 || t > 1.01) continue;
    if (['r', 'g', 'b'].every((k) => Math.abs(a[k] + (b[k] - a[k]) * t - c[k]) < 2 / 255)) return true;
  }
  return false;
};

test('a pdf paints the house ground and only brand colours', async () => {
  // "There's no color highlights in the document - the entire document feels
  // monotonous." The ground is the answer to that, and it is the one thing
  // nothing was watching.
  const r = normaliseSpec({
    format: 'pdf',
    title: 'T',
    content: [
      '## stat | 265 | attacks in 2025. Source: ISAC.',
      '## A section\nA paragraph.\n- A point',
      '## quote | The one line to end on.',
      '## table | Outcome, Measure | Continuity, Lines held',
      '## split | Ranked by severity | Ranked by consequence',
      '## chain | Signal > Context > Action',
    ].join('\n\n'),
  });
  assert.ok(r.ok, r.error);

  const fills = pdfFills(await renderPdf(r.spec, META, FONTS));
  assert.ok(fills.length > 20, `only ${fills.length} fills: the streams did not decompress`);

  // The ground. Cream, and the FIRST thing painted on the page, or whatever
  // else is drawn there is painted over.
  assert.ok(same(fills[0], hex(COLOR.cream)), `the page opens on ${JSON.stringify(fills[0])}`);

  // And every colour after it is one the brand names, or a point on the
  // gradient between two that it does.
  const allowed = [...PALETTE, ...Object.values(CREAM)].map(hex);
  for (const c of fills) {
    assert.ok(
      allowed.some((a) => same(c, a)) || onGradient(c),
      `the pdf paints ${JSON.stringify(c)}, which is not a brand colour`,
    );
  }
});

test('a drawn layout never takes its own data as its headline', async () => {
  // The rule is recorded three times in spec.js — for stat, for chain, for
  // flow — and each entry describes the same defect reaching a rendered page:
  // the layout's own data set as a heading, over a figure drawing it again.
  //
  // It was recorded three times and never generalised, so `quote` and `table`
  // still did it. A quote ended a brief as a navy heading with the identical
  // sentence reversed out of a navy panel directly beneath. Asserted for every
  // layout at once, so the fourth one cannot arrive the same way.
  const { drawFigure } = await import('../src/documents/pdfFigures.js');

  const noHeading = {
    stat: '## stat | 265 | attacks in 2025. Source: ISAC.',
    quote: '## quote | The calendar sets the price of an intrusion.',
    split: '## split | Ranked by severity | Ranked by consequence',
    timeline: '## timeline | Week 0 | Week 2 | Week 6',
    table: '## table | Outcome, Measure | Continuity, Lines held | Effort, Alerts closed',
    chain: '## chain | Signal > Context > Action',
    flow: '## flow | Detect > *Rank > Act',
    paradigm: '## paradigm | Ranked by severity | Ranked by consequence',
  };

  for (const [layout, content] of Object.entries(noHeading)) {
    const r = normaliseSpec({ format: 'pdf', title: 'T', content });
    assert.ok(r.ok, `${layout}: ${r.error}`);
    assert.equal(r.spec.sections[0].layout, layout);
    assert.equal(r.spec.sections[0].title, '', `${layout} headlines itself with its own data`);

    // And the words still reach a renderer that cannot draw it.
    assert.ok(r.spec.sections[0].points.length > 0, `${layout} lost its content`);
  }

  // The author's own heading is kept, because that is not the figure's data.
  const titled = normaliseSpec({
    format: 'pdf',
    title: 'T',
    content: '## table | What you get and when | Deliverable, When | Written findings, Week 2',
  });
  assert.ok(titled.ok, titled.error);
  assert.match(titled.spec.sections[0].title, /What you get and when/);
});

test('the closing line is reversed out, not set as one more heading', async () => {
  // The specific complaint behind all of this — "the entire document feels
  // monotonous" — is about fields of colour, not point size. So the assertion
  // is that the quote paints a navy panel the width of the column, and that
  // the words on it are NOT navy.
  const { drawFigure } = await import('../src/documents/pdfFigures.js');
  const r = normaliseSpec({ format: 'pdf', title: 'T', content: '## quote | The calendar sets the price.' });
  assert.ok(r.ok, r.error);

  const flow = recordingFlow();
  drawFigure(flow, r.spec.sections[0], figureDeps());

  const navy = hex(COLOR.navy);
  const panel = flow.calls.rect.find((c) => same(c.color, navy) && c.width >= 400);
  assert.ok(panel, `no navy panel: ${JSON.stringify(flow.calls.rect.map((c) => c.width))}`);
  assert.ok(flow.calls.text.length > 0, 'the line itself has to be drawn');
  for (const t of flow.calls.text) {
    assert.ok(!same(t.color, navy), `"${t.t}" is navy on navy`);
  }
});

test('a drawn figure replaces its points rather than repeating them', async () => {
  // The defect this prevents is the one the deck renderer had: a chain slide
  // whose headline was its own step list, over a diagram of the same steps.
  //
  // Invisible from outside — both versions render a valid two-page PDF — which
  // is exactly why the first pass at these tests let it through.
  const { drawSection } = await import('../src/documents/pdf.js');
  const r = normaliseSpec({ format: 'pdf', title: 'T', content: '## bars | Where it goes | Alpha 61 | Beta 44 | Gamma 22' });
  assert.ok(r.ok, r.error);

  const flow = recordingFlow();
  flow.fonts = { ...FONTS, display: 'display', heading: 'heading', body: 'body', eyebrow: 'eyebrow' };
  flow.write = (text, opts) => {
    flow.calls.text.push({ t: text, ...opts });
    flow.y -= 12;
    return 12;
  };
  flow.measure = () => 12;
  flow.reserve = () => {};

  drawSection(flow, r.spec.sections[0]);

  const written = flow.calls.text.map((c) => c.t).join(' | ');
  const alphas = (written.match(/Alpha/g) || []).length;
  assert.equal(alphas, 1, `"Alpha" appears ${alphas} times in ${written}`);

  // BOTH halves, or the test passes when the figure is never drawn at all:
  // with drawFigure removed the points are written instead, "Alpha" still
  // appears exactly once, and the assertion above is satisfied by the bug.
  assert.ok(
    flow.calls.rect.length >= 6,
    `the figure itself was not drawn: only ${flow.calls.rect.length} shapes`,
  );
});

test('every field that can overflow is refused, not just the ones in sections', () => {
  // The hole this closes: the overflow accumulator was created halfway down
  // normaliseSpec, so title, subtitle and audience were cleaned before it
  // existed and kept truncating silently. Then, once they were wired up, they
  // were still cleaned INSIDE the returned object — after the refusal check —
  // so they recorded too late to refuse and stopped truncating at the same
  // time, which would have let an over-long subtitle run off the layout with
  // no ellipsis and no error. Worse than what it replaced.
  const long = (n) => 'W'.repeat(n);

  for (const [field, input] of [
    ['title', { title: long(400) }],
    ['subtitle', { title: 'ok', subtitle: long(400) }],
    ['audience', { title: 'ok', audience: long(400) }],
    ['section body', { title: 'ok', content: `## S\n${long(900)}` }],
    ['point', { title: 'ok', content: `## S\n- ${long(400)}` }],
    ['eyebrow', { title: 'ok', content: `## ${long(90)} | S\nBody.` }],
  ]) {
    const r = normaliseSpec({ format: 'pdf', content: '## S\nBody.', ...input });
    assert.equal(r.ok, false, `an over-long ${field} was accepted`);
    assert.match(r.error, /too long for the layout/, field);
  }
});

test('the cover carries the lockup ARTWORK, not retyped letterforms', async () => {
  // pdf.js drew the wordmark as text in Inter Black while the deck renderer
  // used the extracted artwork. src/brandassets/README.md was written against
  // exactly this: TM3 §07 says the logotype is a designed lockup and is never
  // retyped, and "a good imitation of a mark is worse than an obvious one,
  // because it survives being forwarded". Every brief that went to a customer
  // carried a redrawn mark.
  const r = normaliseSpec({
    format: 'pdf',
    title: 'T',
    content: '## stat | 580,000 | cases a year. Source: AAA.',
  });
  assert.ok(r.ok, r.error);

  const bytes = await renderPdf(r.spec, META, FONTS);
  const doc = await PDFDocument.load(bytes);

  // An embedded image is the assertion. Counting XObjects rather than looking
  // for absent text, because the absence of "vikat.AI" could equally mean the
  // cover stopped drawing anything at all.
  const page = doc.getPages()[0];
  const xobjects = page.node.Resources()?.lookup?.(PDFName.of('XObject'));
  assert.ok(xobjects, 'the cover embeds no image at all');
  assert.ok(xobjects.keys().length >= 1, 'no image on the cover');
});

test('the mark is embedded once, however many pages', async () => {
  // pdf-lib embeds by document, not by page. Embedding inside drawCover would
  // put the same artwork in the file twice.
  const long = Array.from({ length: 6 }, (_, i) => `## Section ${i}\nA paragraph.`).join('\n\n');
  const r = normaliseSpec({
    format: 'pdf',
    title: 'T',
    content: [
      '## stat | 580,000 | cases a year. Source: AAA.',
      long,
      '## paradigm | The question has moved | Ranked by severity | Ranked by consequence',
      '## quote | The one line to end on.',
    ].join('\n\n'),
  });
  assert.ok(r.ok, r.error);

  const bytes = Buffer.from(await renderPdf(r.spec, META, FONTS));
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() > 1, 'needs to span pages for this to mean anything');

  // The artwork is 466x232; a second copy would show as a second image object.
  const images = bytes.toString('latin1').match(/\/Subtype\s*\/Image/g) || [];
  assert.ok(images.length <= 2, `${images.length} image objects: the lockup and its soft mask, no more`);
});

// --- Furniture --------------------------------------------------------------

test('no renderer labels the reader a recipient or the sender a preparer', () => {
  // "Prepared for and prepared by are still there" — the fourth of six notes
  // on a brief that went to a CISO, and the reason this test exists at all:
  // NOTHING asserted on that furniture, so it survived every pass over these
  // renderers. A customer reading their own name after "prepared for" is being
  // shown an internal memo header; "prepared by" in front of the sender is
  // process language a reader has no use for.
  //
  // Both halves matter. The name and the date still have to appear — the
  // audience so the document is addressed, the sender so a stranger has
  // somebody to reply to — so deleting the block outright is not the fix and
  // is not what passes here.
  const s = spec({ format: 'pdf', audience: 'Northfield Foods' });
  const memo = /prepared (for|by)/i;

  // PDF. Watching the draw calls rather than the bytes: the type is subsetted
  // into the file, so the cover's own words are not greppable in the output.
  const calls = { text: [], rect: [] };
  const page = {
    drawText: (t, o) => calls.text.push({ t, ...o }),
    drawRectangle: (o) => calls.rect.push(o),
  };
  const flow = {
    spec: s,
    fonts: { ...FONTS, display: 'display', heading: 'heading', body: 'body', eyebrow: 'eyebrow' },
    meta: { preparedBy: 'Test Rep', date: '25 August 2026', year: 2026 },
    page,
    y: 700,
    remaining: 600,
    mark: null,
    newPage() { this.y = 700; return page; },
    gap(n) { this.y -= n; },
    write(text, opts) { calls.text.push({ t: text, ...opts }); this.y -= 12; return 12; },
  };

  drawCover(flow);
  drawClose(flow);
  const drawn = calls.text.map((c) => c.t).join(' | ');

  assert.doesNotMatch(drawn, memo, drawn);
  assert.match(drawn, /NORTHFIELD FOODS/i, 'the reader still has to be named');
  assert.match(drawn, /Test Rep/, 'and the sender still has to be reachable');

  // Word.
  const word = docxParts(renderDocx(spec({ format: 'docx', audience: 'Northfield Foods' }), META))['word/document.xml'];
  assert.doesNotMatch(word, memo);
  assert.match(word, /N.?O.?R.?T.?H.?F.?I.?E.?L.?D/i, 'the reader still has to be named');

  // Deck.
  const deck = Object.entries(unzipSync(renderPptx(spec({ audience: 'Northfield Foods' }), META, FONTS.metrics)))
    .map(([, v]) => strFromU8(v))
    .join('\n');
  assert.doesNotMatch(deck, memo);
});

test('the sign-off sits at the foot of the page, wherever the content stopped', () => {
  // The first brief through the coloured renderer put the sign-off alone on a
  // fourth page: the closing figure's trailing gap left it thirteen points
  // short, and the block was drawn wherever the cursor happened to be. A
  // sign-off floating mid-page with 300 points of cream under it looks like
  // the document ran out rather than ended.
  const run = (startY) => {
    const calls = { text: [], rect: [] };
    const page = {
      drawText: (t, o) => calls.text.push({ t, ...o }),
      drawRectangle: (o) => calls.rect.push(o),
    };
    let pages = 0;
    const flow = {
      spec: spec({ format: 'pdf' }),
      fonts: { ...FONTS, display: 'display', heading: 'heading', body: 'body', eyebrow: 'eyebrow' },
      meta: { preparedBy: 'Test Rep', date: '25 August 2026', year: 2026 },
      page,
      y: startY,
      get remaining() { return this.y - 80; },
      newPage() { pages += 1; this.y = 780; return page; },
      gap(n) { this.y -= n; },
      write(text, opts) { calls.text.push({ t: text, ...opts }); this.y -= 12; return 12; },
    };
    drawClose(flow);
    // The navy panel, which is the widest thing drawn.
    const panel = calls.rect.sort((a, b) => b.width - a.width)[0];
    return { panel, pages };
  };

  // Halfway down a page with room to spare: no new page, and the block still
  // lands at the foot rather than under the cursor.
  const high = run(600);
  assert.equal(high.pages, 0, 'a page with room does not need another');
  assert.ok(high.panel.y < 130, `the block sits at y ${high.panel.y}, not at the foot`);
  assert.ok(high.panel.y > 60, `the block at y ${high.panel.y} would collide with the footer`);

  // And too low to fit: a new page, and the block at the foot of that one.
  const low = run(140);
  assert.equal(low.pages, 1, 'no room left, so a page');
  assert.ok(low.panel.y < 130 && low.panel.y > 60, `y ${low.panel.y}`);
});
