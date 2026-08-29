/**
 * Extraction tests, run against real .pptx and .docx files produced by
 * python-pptx / python-docx (see fixtures/README.md), not hand-written XML.
 * Hand-written OOXML fixtures tend to test the fixture rather than the parser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extract, extractPptx, extractDocx, extractPdf, extractText } from '../lib/extract.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name) => fs.readFileSync(path.join(FIXTURES, name));

// --- PowerPoint -----------------------------------------------------------

test('pptx yields one section per slide, in slide order', () => {
  const r = extractPptx(read('battlecard.pptx'));
  assert.equal(r.sections.length, 3);
  assert.deepEqual(
    r.sections.map((s) => s.title),
    [
      'Slide 1: Vikat vs. Legacy CSPM',
      'Slide 2: Pricing bands',
      'Slide 3: Reference customers',
    ],
  );
  assert.deepEqual(r.warnings, []);
});

test('pptx captures slide body text', () => {
  const r = extractPptx(read('battlecard.pptx'));
  const slide1 = r.sections[0].content;
  assert.match(slide1, /Agent-aware policy/);
  assert.match(slide1, /MCP server discovery/);
});

test('pptx captures speaker notes, which carry the real guidance', () => {
  const r = extractPptx(read('battlecard.pptx'));
  // The note on slide 1 is the correction a rep most needs: do NOT claim the
  // competitor lacks MCP coverage. Losing notes would lose that.
  assert.match(r.sections[0].content, /Speaker notes: Lead with agent visibility/);
  assert.match(r.sections[0].content, /they announced beta support/);
  assert.match(r.sections[1].content, /Never quote floor without approval/);
});

test('pptx omits a notes block for a slide that has none', () => {
  const r = extractPptx(read('battlecard.pptx'));
  assert.ok(!r.sections[2].content.includes('Speaker notes:'), 'slide 3 has no notes');
});

test('pptx reports no slides rather than throwing on a non-deck zip', () => {
  // A .docx is a valid zip with no ppt/slides/, which is the realistic
  // mislabelled-file case.
  const r = extractPptx(read('deployment.docx'));
  assert.equal(r.sections.length, 0);
  assert.deepEqual(r.warnings, ['no slides found']);
});

// --- Word -----------------------------------------------------------------

test('docx splits into sections on headings', () => {
  const r = extractDocx(read('deployment.docx'));
  assert.deepEqual(
    r.sections.map((s) => s.title),
    ['Deployment Models', 'Engagement Models', 'Ampersands & entities'],
  );
});

test('docx keeps every paragraph under its heading', () => {
  const r = extractDocx(read('deployment.docx'));
  const deployment = r.sections[0].content;
  assert.match(deployment, /SaaS, in-VPC, or fully self-hosted/);
  assert.match(deployment, /Kubernetes 1\.27 or later/);
  assert.equal(deployment.split('\n').length, 2, 'both paragraphs, one per line');
});

test('docx decodes XML entities rather than leaking escapes', () => {
  const r = extractDocx(read('deployment.docx'));
  const last = r.sections[2].content;
  assert.match(last, /<angle brackets>/);
  assert.match(last, /& ampersands/);
  assert.ok(!last.includes('&amp;'), 'entities must be decoded, not passed through');
  assert.ok(!last.includes('&lt;'));
});

test('docx reports a missing document part rather than throwing', () => {
  const r = extractDocx(read('battlecard.pptx'));
  assert.equal(r.sections.length, 0);
  assert.deepEqual(r.warnings, ['no word/document.xml']);
});

// --- Plain text -----------------------------------------------------------

test('text files pass through whole', () => {
  const r = extractText(Buffer.from('Deployment is SaaS or self-hosted.\nNothing else.'), 'notes.txt');
  assert.equal(r.sections.length, 1);
  assert.equal(r.sections[0].title, 'notes.txt');
  assert.match(r.sections[0].content, /self-hosted/);
});

test('an empty text file yields no sections', () => {
  assert.equal(extractText(Buffer.from('   \n  '), 'empty.txt').sections.length, 0);
});

// --- PDF ------------------------------------------------------------------

test('a PDF with no text layer warns instead of emitting noise', () => {
  // A scanned PDF is bytes with no text-showing operators. The failure mode
  // that matters is silently producing garbage, so assert on the warning.
  const notAPdf = Buffer.from('%PDF-1.4\nstream\n\x00\x01\x02\x03\nendstream\n%%EOF');
  const r = extractPdf(notAPdf, 'scan.pdf');
  assert.equal(r.sections.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /no extractable text/);
});

test('extracted PDF text is flagged as best-effort', () => {
  const simple = Buffer.from(
    '%PDF-1.4\nstream\nBT /F1 12 Tf (Vikat deploys as SaaS or self-hosted.) Tj ET\nendstream\n%%EOF',
  );
  const r = extractPdf(simple, 'doc.pdf');
  assert.equal(r.sections.length, 1);
  assert.match(r.sections[0].content, /Vikat deploys as SaaS/);
  assert.match(r.warnings[0], /best-effort/, 'the caller must know not to trust this blindly');
});

test('a binary stream containing "TJ" is not mined for text', () => {
  // What a rep actually saw in the Collateral tab, as the summary of
  // Vikat_SecSemantic_ExecBrief.pdf:
  //
  //   s85$^p`meEs^]#Eh&DP!B^S.cO 8R;$.Oj1PX6mk4M_H4tc+V"V*2D
  //
  // Two defects together. The gate read /\(([^)]*)\)\s*Tj|TJ/, which parses as
  // "(...)Tj OR TJ" — so a bare "TJ" anywhere passed, and those two bytes turn
  // up constantly in compressed data. And a stream that failed to inflate was
  // kept as "literal" text, so image bytes reached the operator scan, which
  // duly found parenthesised runs in the noise.
  // Bytes that fail to inflate, are mostly unprintable, and happen to contain
  // both a bare "TJ" and a parenthesised run followed by "Tj" — which is all
  // it took. Built explicitly rather than with random noise: the first version
  // of this test used noise that never reached the operator scan, so it passed
  // against the broken code and proved nothing.
  const noise = Buffer.concat([
    Buffer.from([0x78, 0x9c, 0xff, 0xfe, 0x00, 0x91, 0xd3, 0x1b, 0x00, 0xa7]),
    Buffer.from('TJ', 'latin1'),
    Buffer.from([0x00, 0xbe, 0xef, 0x1c]),
    Buffer.from('(s85$^p`meEs^]#Eh&DP!B^S.cO) Tj', 'latin1'),
    Buffer.from([0x00, 0xd9, 0x7a, 0x03, 0xfc, 0x8b]),
  ]);
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\nstream\n', 'latin1'),
    noise,
    Buffer.from('\nendstream\n%%EOF', 'latin1'),
  ]);

  const r = extractPdf(pdf, 'Vikat_SecSemantic_ExecBrief.pdf');
  assert.deepEqual(r.sections, [], 'binary must not become a document summary');
  assert.ok(
    r.warnings.some((w) => /no extractable text|legibility/.test(w)),
    'and it must say so, rather than failing silently',
  );
});

test('mangled output is discarded even if it reaches the end', () => {
  // The belt to the braces. This function's own comment promises it "gives up
  // loudly rather than emitting mangled output"; until now it did not, and the
  // consequence was not cosmetic — the same text became knowledge-base chunks
  // the assistant could retrieve and quote.
  const junk = '(\x01\x9e\xd3q\x88\xfe\x11) Tj (\x7f\xa0\xb2\xc4) Tj';
  const pdf = Buffer.from(`%PDF-1.4\nstream\nBT ${junk} ET\nendstream\n%%EOF`, 'latin1');

  const r = extractPdf(pdf, 'garbled.pdf');
  assert.deepEqual(r.sections, []);
  assert.ok(r.warnings.length, 'silence is the failure being prevented');
});

test('an uncompressed content stream is still read', () => {
  // The fallback exists for a reason: plenty of PDFs carry plain content
  // streams. Refusing every un-inflatable stream would have fixed the garbage
  // by breaking the feature.
  const pdf = Buffer.from(
    '%PDF-1.4\nstream\nBT /F1 12 Tf (VShield validates every MCP tool call.) Tj ET\nendstream\n%%EOF',
  );
  const r = extractPdf(pdf, 'plain.pdf');
  assert.equal(r.sections.length, 1);
  assert.match(r.sections[0].content, /VShield validates every MCP tool call/);
});

// --- Dispatch -------------------------------------------------------------

test('extract dispatches on file extension', () => {
  assert.equal(extract(read('battlecard.pptx'), 'battlecard.pptx').sections.length, 3);
  assert.equal(extract(read('deployment.docx'), 'deployment.docx').sections.length, 3);
});

test('extension matching is case-insensitive', () => {
  assert.equal(extract(read('battlecard.pptx'), 'BATTLECARD.PPTX').sections.length, 3);
});

test('an unsupported type is reported, not thrown', () => {
  const r = extract(Buffer.from('binary'), 'diagram.vsdx');
  assert.equal(r.sections.length, 0);
  assert.match(r.warnings[0], /unsupported file type/);
});

test('a corrupt file is reported, not thrown', () => {
  // The realistic case: a truncated download. One bad file must not abort a
  // whole sync, so extraction has to fail soft.
  const r = extract(Buffer.from('not a zip at all'), 'broken.pptx');
  assert.equal(r.sections.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /extraction failed/);
});

test('the legacy binary formats are not silently accepted', () => {
  // .ppt/.doc are not OOXML. Accepting them would produce garbage chunks.
  for (const name of ['old.ppt', 'old.doc']) {
    const r = extract(Buffer.from('anything'), name);
    assert.equal(r.sections.length, 0);
    assert.match(r.warnings[0], /unsupported file type/, `${name} must be rejected`);
  }
});
