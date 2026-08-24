#!/usr/bin/env node
/**
 * build-knowledge.js — compile site HTML + curated FAQ into worker/src/knowledge.js
 *
 * Usage:
 *   node scripts/build-knowledge.js [--pages <dir>] [--out <file>] [--allow-drafts]
 *
 *   --pages <dir>     Directory of vikat.ai HTML pages to parse. Optional; when
 *                     omitted or empty, only the curated FAQ is compiled.
 *   --out <file>      Output module. Default worker/src/knowledge.js
 *   --allow-drafts    Include faq.json entries whose status is not 'approved'.
 *                     Off by default and NOT for production — draft entries have
 *                     empty content by design.
 *
 * Output shape (Forward-compatibility: this chunk shape is what Tier B's
 * Vectorize upsert will embed, so it must not change when retrieval swaps in):
 *
 *   [{ id, page, section, content }]
 *
 * Zero dependencies — plain Node, no HTML parser package. The regex stripper
 * below is adequate for a static marketing site; it is not a general-purpose
 * HTML parser and is not exposed to untrusted input.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// --- CLI ------------------------------------------------------------------

function parseArgs(argv) {
  const args = { pages: null, out: null, allowDrafts: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pages') args.pages = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--allow-drafts') args.allowDrafts = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

// --- HTML -> text ---------------------------------------------------------

const BLOCK_STRIP = /<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
const TAG = /<[^>]+>/g;

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&mdash;': '—', '&ndash;': '–',
  '&hellip;': '…', '&rsquo;': '’', '&lsquo;': '‘',
  '&ldquo;': '“', '&rdquo;': '”',
};

function decodeEntities(s) {
  return s
    .replace(/&[a-zA-Z#0-9]+;/g, (m) => {
      if (ENTITIES[m]) return ENTITIES[m];
      const num = /^&#(\d+);$/.exec(m);
      if (num) return String.fromCodePoint(Number(num[1]));
      const hex = /^&#x([0-9a-fA-F]+);$/.exec(m);
      if (hex) return String.fromCodePoint(parseInt(hex[1], 16));
      return m;
    });
}

function stripTags(html) {
  return decodeEntities(
    html.replace(BLOCK_STRIP, ' ').replace(COMMENT, ' ').replace(TAG, ' '),
  )
    .replace(/[ \t\r\f\v]+/g, ' ')
    // Collapse whitespace-only lines. Stripped tags leave one space per tag, so
    // a nav block becomes dozens of " \n" lines — pure token waste otherwise.
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line, i, all) => line !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Extract <title>, falling back to the first <h1>. */
function extractTitle(html) {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (t) {
    const clean = stripTags(t[1]);
    if (clean) return clean;
  }
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  return h1 ? stripTags(h1[1]) : '';
}

/**
 * Split a page into { section, content } chunks on heading boundaries.
 *
 * Content before the first heading is emitted as an "Overview" chunk so a page
 * with a hero block and no <h2> still produces something.
 */
function chunkByHeadings(html, pageTitle) {
  // Drop the chrome that repeats on every page — it would otherwise dominate
  // the knowledge base with N copies of the nav and footer.
  const body = html
    .replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(BLOCK_STRIP, ' ')
    .replace(COMMENT, ' ');

  const headingRe = /<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  const chunks = [];
  let lastIndex = 0;
  let currentSection = 'Overview';
  let match;

  while ((match = headingRe.exec(body)) !== null) {
    const text = stripTags(body.slice(lastIndex, match.index));
    if (text) chunks.push({ section: currentSection, content: text });
    currentSection = stripTags(match[2]) || 'Section';
    lastIndex = headingRe.lastIndex;
  }

  const tail = stripTags(body.slice(lastIndex));
  if (tail) chunks.push({ section: currentSection, content: tail });

  // Merge chunks that are too small to stand alone into the previous one, and
  // drop what remains below the floor. Prevents a KB full of stray link text.
  const MIN_CHARS = 60;
  const merged = [];
  for (const c of chunks) {
    if (c.content.length < MIN_CHARS && merged.length > 0) {
      const prev = merged[merged.length - 1];
      prev.content = `${prev.content}\n${c.section}: ${c.content}`.trim();
    } else {
      merged.push({ ...c });
    }
  }
  return merged
    .filter((c) => c.content.length >= MIN_CHARS)
    .map((c) => ({ ...c, section: c.section || pageTitle || 'Section' }));
}

// --- Sources --------------------------------------------------------------

function listHtmlFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.html?$/i.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'section';
}

function chunksFromPages(pagesDir) {
  const files = listHtmlFiles(pagesDir);
  const chunks = [];
  const seen = new Set();

  for (const file of files) {
    const html = fs.readFileSync(file, 'utf8');
    const rel = path.relative(pagesDir, file).split(path.sep).join('/');
    const pageTitle = extractTitle(html) || rel;

    for (const c of chunkByHeadings(html, pageTitle)) {
      // Site chrome that survived the nav/footer strip shows up as identical
      // content on many pages. Keep the first copy only.
      const fingerprint = c.content.slice(0, 200);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);

      let id = `page:${slugify(rel)}:${slugify(c.section)}`;
      let n = 2;
      const base = id;
      while (chunks.some((x) => x.id === id)) id = `${base}-${n++}`;

      chunks.push({ id, page: rel, section: c.section, content: c.content });
    }
  }
  return { chunks, fileCount: files.length };
}

function chunksFromFaq(faqPath, allowDrafts) {
  const faq = JSON.parse(fs.readFileSync(faqPath, 'utf8'));
  const included = [];
  const skipped = [];

  for (const e of faq.entries) {
    const approved = e.status === 'approved';
    const hasContent = typeof e.content === 'string' && e.content.trim().length > 0;

    if ((approved || allowDrafts) && hasContent) {
      included.push({
        id: `faq:${e.id}`,
        page: 'curated/faq.json',
        section: e.section,
        content: e.content.trim(),
      });
    } else {
      skipped.push({ id: e.id, section: e.section, reason: !hasContent ? 'empty content' : `status=${e.status}` });
    }
  }
  return { included, skipped };
}

// --- Emit -----------------------------------------------------------------

/** Rough token estimate. Good enough to trip the Tier B retrieval threshold. */
function estimateTokens(chunks) {
  const chars = chunks.reduce((n, c) => n + c.section.length + c.content.length, 0);
  return Math.ceil(chars / 4);
}

function renderModule(chunks, meta) {
  return `/**
 * knowledge.js — GENERATED FILE. Do not edit by hand.
 *
 * Regenerate with: npm run build:knowledge
 * Source: ${meta.sources}
 * Chunks: ${chunks.length}   Estimated tokens: ~${meta.estimatedTokens}
 *
 * Chunk shape is { id, page, section, content }. Tier B (Vectorize) embeds
 * exactly these chunks, so the shape is part of the forward-compatibility
 * contract — see scripts/build-knowledge.js.
 */

/** @typedef {{ id: string, page: string, section: string, content: string }} KnowledgeChunk */

/** @type {KnowledgeChunk[]} */
export const KNOWLEDGE = ${JSON.stringify(chunks, null, 2)};

/** Approximate token count of the compiled knowledge base. */
export const KNOWLEDGE_TOKENS = ${meta.estimatedTokens};

/** Build metadata, surfaced by GET /health for operational visibility. */
export const KNOWLEDGE_META = ${JSON.stringify(
    { chunkCount: chunks.length, estimatedTokens: meta.estimatedTokens, pageChunks: meta.pageChunks, faqChunks: meta.faqChunks, skippedFaqEntries: meta.skipped.map((s) => s.id) },
    null,
    2,
  )};
`;
}

// --- Main -----------------------------------------------------------------

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  if (args.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
    return;
  }

  const outPath = path.resolve(REPO_ROOT, args.out || 'worker/src/knowledge.js');
  const faqPath = path.resolve(REPO_ROOT, 'worker/src/knowledge/faq.json');

  const sourceLabels = [];
  let pageChunks = [];

  if (args.pages) {
    const pagesDir = path.resolve(process.cwd(), args.pages);
    if (!fs.existsSync(pagesDir)) {
      console.error(`--pages directory not found: ${pagesDir}`);
      process.exit(2);
    }
    const res = chunksFromPages(pagesDir);
    pageChunks = res.chunks;
    sourceLabels.push(`${res.fileCount} HTML page(s) from ${args.pages}`);
    console.log(`  pages: ${res.fileCount} file(s) -> ${pageChunks.length} chunk(s)`);
  } else {
    console.log('  pages: (none — pass --pages <dir> to compile site HTML)');
  }

  const { included: faqChunks, skipped } = chunksFromFaq(faqPath, args.allowDrafts);
  sourceLabels.push('worker/src/knowledge/faq.json');
  console.log(`  faq:   ${faqChunks.length} entr(y|ies) included, ${skipped.length} skipped`);

  const chunks = [...faqChunks, ...pageChunks];
  const estimatedTokens = estimateTokens(chunks);

  fs.writeFileSync(
    outPath,
    renderModule(chunks, {
      sources: sourceLabels.join(' + '),
      estimatedTokens,
      pageChunks: pageChunks.length,
      faqChunks: faqChunks.length,
      skipped,
    }),
    'utf8',
  );

  console.log(`\nWrote ${path.relative(REPO_ROOT, outPath)}`);
  console.log(`  ${chunks.length} chunk(s), ~${estimatedTokens} tokens`);

  if (skipped.length) {
    console.log('\nSkipped FAQ entries (the agent will deflect these questions to a call):');
    for (const s of skipped) console.log(`  - ${s.id.padEnd(32)} ${s.reason}  [${s.section}]`);
    console.log('\n  Fill `content` in worker/src/knowledge/faq.json and set status to "approved" to include them.');
  }

  // Tier B trigger, per spec: retrieval becomes worthwhile past ~50K tokens.
  if (estimatedTokens > 50000) {
    console.log(`\n!! Knowledge base is ~${estimatedTokens} tokens, over the ~50K threshold.`);
    console.log('   This is the Tier B / B4 trigger: switch retrieve.js to Vectorize retrieval.');
  }

  if (chunks.length === 0) {
    console.log('\n!! Knowledge base is EMPTY. The agent will be unable to answer any product');
    console.log('   question and will route everything to a call. This is a safe failure mode,');
    console.log('   but it is not a launch-ready state.');
  }
}

main();
