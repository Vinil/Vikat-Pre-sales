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
