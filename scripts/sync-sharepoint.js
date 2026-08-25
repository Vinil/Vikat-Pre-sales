#!/usr/bin/env node
/**
 * sync-sharepoint.js — pull approved sales material from SharePoint into the
 * knowledge base.
 *
 * Usage:
 *   node scripts/sync-sharepoint.js [--full] [--dry-run]
 *
 *   --full      Ignore the saved delta token and re-read everything. Use after
 *               changing the folder scope or an extractor.
 *   --dry-run   Fetch and extract, report, write nothing.
 *
 * Output: worker/src/knowledge/sharepoint.json — chunks in the same
 * { id, page, section, content } shape as the site pages, plus the delta token
 * so the next run is incremental. build-knowledge.js merges it.
 *
 * SCOPE IS DELIBERATELY NARROW AND FAILS CLOSED. The sync reads one document
 * library, and optionally one folder within it. That library is the approval
 * boundary: publishing a file there is what makes it visible to the assistant.
 * Widening the scope to a whole site means anything anyone drops anywhere
 * becomes an answer, which is how a roadmap deck ends up quoted on a call.
 *
 * Required environment:
 *   GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET
 *   SHAREPOINT_HOSTNAME      e.g. vikat.sharepoint.com
 *   SHAREPOINT_SITE_PATH     e.g. /sites/Sales
 *   SHAREPOINT_LIBRARY       document library (drive) name, e.g. "Sales Enablement"
 * Optional:
 *   SHAREPOINT_FOLDER        restrict further, e.g. "Approved"
 *   SHAREPOINT_MAX_FILE_MB   skip files larger than this (default 40)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getToken, getSite, listDrives, deltaItems, downloadItem, folderPathOf } from './lib/graph.js';
import { extract, SUPPORTED_EXTENSIONS } from './lib/extract.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = path.join(REPO_ROOT, 'worker/src/knowledge/sharepoint.json');

const MIN_CHUNK_CHARS = 60;

// --- CLI ------------------------------------------------------------------

const args = process.argv.slice(2);
const FULL = args.includes('--full');
const DRY_RUN = args.includes('--dry-run');

for (const a of args) {
  if (!['--full', '--dry-run'].includes(a)) {
    console.error(`Unknown argument: ${a}`);
    process.exit(2);
  }
}

// --- Config ---------------------------------------------------------------

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable: ${name}`);
    console.error('See the header of this file, or README "SharePoint sync".');
    process.exit(2);
  }
  return v;
}

const CONFIG = {
  tenantId: requireEnv('GRAPH_TENANT_ID'),
  clientId: requireEnv('GRAPH_CLIENT_ID'),
  clientSecret: requireEnv('GRAPH_CLIENT_SECRET'),
  hostname: requireEnv('SHAREPOINT_HOSTNAME'),
  sitePath: requireEnv('SHAREPOINT_SITE_PATH'),
  // Fails closed: without a named library there is no safe default to guess.
  library: requireEnv('SHAREPOINT_LIBRARY'),
  folder: (process.env.SHAREPOINT_FOLDER || '').replace(/^\/+|\/+$/g, ''),
  maxFileBytes: Number(process.env.SHAREPOINT_MAX_FILE_MB || 40) * 1024 * 1024,
};

// --- Helpers --------------------------------------------------------------

/**
 * A one-or-two sentence gist of a document, taken from its own opening prose.
 *
 * Skips slide titles and headings (short, no sentence punctuation) because a
 * list of headings tells a rep nothing they cannot get from the file name.
 */
function summarise(chunks) {
  const MAX = 280;
  const lines = chunks
    .flatMap((c) => c.content.split('\n'))
    .map((l) => l.trim())
    .filter((l) => l.length > 40 && /[.!?]/.test(l));

  if (lines.length === 0) {
    // No prose at all — a metrics slide, say. Fall back to the first content.
    const first = chunks[0]?.content.replace(/\s+/g, ' ').trim() || '';
    return first.length > MAX ? `${first.slice(0, MAX - 1)}…` : first;
  }

  let out = '';
  for (const line of lines) {
    if (out.length + line.length + 1 > MAX) break;
    out += (out ? ' ' : '') + line;
  }
  return out || `${lines[0].slice(0, MAX - 1)}…`;
}

function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'item'
  );
}

function loadPrevious() {
  if (!fs.existsSync(OUT_PATH)) return { deltaLink: null, chunks: [], files: {} };
  try {
    const prev = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    return {
      deltaLink: prev.deltaLink || null,
      chunks: prev.chunks || [],
      files: prev.files || {},
    };
  } catch (err) {
    console.warn(`  Could not read existing ${path.basename(OUT_PATH)} (${err.message}); doing a full sync.`);
    return { deltaLink: null, chunks: [], files: {} };
  }
}

/** Is this item inside the folder we are scoped to? */
function inScope(item) {
  if (!CONFIG.folder) return true;
  const folder = folderPathOf(item);
  return folder === CONFIG.folder || folder.startsWith(`${CONFIG.folder}/`);
}

function isSupported(name) {
  const lower = String(name).toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// --- Main -----------------------------------------------------------------

async function main() {
  console.log('SharePoint sync');
  console.log(`  site:    ${CONFIG.hostname}${CONFIG.sitePath}`);
  console.log(`  library: ${CONFIG.library}${CONFIG.folder ? ` / ${CONFIG.folder}` : ''}`);
  console.log(`  mode:    ${FULL ? 'full' : 'incremental'}${DRY_RUN ? ' (dry run)' : ''}`);

  const token = await getToken(CONFIG);

  const site = await getSite(token, CONFIG.hostname, CONFIG.sitePath);
  const drives = await listDrives(token, site.id);
  const drive = drives.find((d) => d.name === CONFIG.library);

  if (!drive) {
    console.error(`\nLibrary "${CONFIG.library}" not found on this site.`);
    console.error(`Available: ${drives.map((d) => d.name).join(', ') || '(none visible to this app)'}`);
    console.error('If the list is empty, the app registration probably lacks access to this site.');
    process.exit(1);
  }

  const previous = loadPrevious();
  const deltaLink = FULL ? null : previous.deltaLink;

  const { items, deltaLink: nextDelta } = await deltaItems(token, drive.id, deltaLink);
  console.log(`\n  ${items.length} item(s) changed since the last sync`);

  // Keep chunks from files that did not change, keyed by item id.
  /** @type {Map<string, object[]>} */
  const chunksByFile = new Map();
  if (!FULL) {
    for (const c of previous.chunks) {
      if (!chunksByFile.has(c.itemId)) chunksByFile.set(c.itemId, []);
      chunksByFile.get(c.itemId).push(c);
    }
  }

  const files = FULL ? {} : { ...previous.files };
  const stats = { added: 0, updated: 0, deleted: 0, skipped: 0, failed: 0 };
  const warnings = [];

  for (const item of items) {
    // Deletions arrive as a tombstone; drop the file's chunks.
    if (item.deleted) {
      if (chunksByFile.delete(item.id)) {
        stats.deleted++;
        console.log(`  - removed ${files[item.id]?.name || item.id}`);
      }
      delete files[item.id];
      continue;
    }

    // Folders themselves carry no text.
    if (item.folder) continue;
    if (!item.file) continue;

    if (!inScope(item)) {
      stats.skipped++;
      continue;
    }

    if (!isSupported(item.name)) {
      stats.skipped++;
      continue;
    }

    if (item.size > CONFIG.maxFileBytes) {
      stats.skipped++;
      warnings.push(`${item.name}: ${(item.size / 1024 / 1024).toFixed(1)}MB exceeds the size limit; skipped`);
      continue;
    }

    const isUpdate = Boolean(files[item.id]);

    try {
      const buffer = await downloadItem(token, item);
      const result = extract(buffer, item.name);

      for (const w of result.warnings) warnings.push(`${item.name}: ${w}`);

      const folder = folderPathOf(item);
      const page = `sharepoint/${folder ? `${folder}/` : ''}${item.name}`;

      const chunks = result.sections
        .filter((s) => s.content.trim().length >= MIN_CHUNK_CHARS)
        .map((s, i) => ({
          id: `sp:${slugify(item.name)}:${slugify(s.title)}:${i}`,
          page,
          section: s.title,
          content: s.content.trim(),
          // Retained so an incremental run can drop this file's chunks, and so
          // a reviewer can trace an answer back to a document.
          itemId: item.id,
          webUrl: item.webUrl || null,
          modified: item.lastModifiedDateTime || null,
        }));

      if (chunks.length === 0) {
        warnings.push(`${item.name}: produced no usable text`);
        chunksByFile.delete(item.id);
        delete files[item.id];
        stats.skipped++;
        continue;
      }

      chunksByFile.set(item.id, chunks);
      files[item.id] = {
        name: item.name,
        page,
        folder,
        webUrl: item.webUrl || null,
        modified: item.lastModifiedDateTime || null,
        chunks: chunks.length,
        // Extractive, not generated: the first substantive prose in the
        // document. A model-written summary would be better, but it would also
        // be a per-file API call on every sync and a new thing that can be
        // wrong. This is cheap, deterministic, and good enough to recognise a
        // document by.
        summary: summarise(chunks),
      };

      if (isUpdate) stats.updated++;
      else stats.added++;
      console.log(`  ${isUpdate ? '~' : '+'} ${page} (${chunks.length} chunk${chunks.length === 1 ? '' : 's'})`);
    } catch (err) {
      // One unreadable file must not abandon the whole sync.
      stats.failed++;
      warnings.push(`${item.name}: ${err.message}`);
      console.warn(`  ! ${item.name}: ${err.message}`);
    }
  }

  const allChunks = [...chunksByFile.values()].flat();
  const estimatedTokens = Math.ceil(
    allChunks.reduce((n, c) => n + c.section.length + c.content.length, 0) / 4,
  );

  console.log(
    `\n  ${stats.added} added, ${stats.updated} updated, ${stats.deleted} removed, ` +
      `${stats.skipped} skipped, ${stats.failed} failed`,
  );
  console.log(`  ${allChunks.length} chunk(s) total, ~${estimatedTokens} tokens`);

  if (warnings.length) {
    console.log(`\n  ${warnings.length} warning(s):`);
    for (const w of warnings.slice(0, 30)) console.log(`    - ${w}`);
    if (warnings.length > 30) console.log(`    … and ${warnings.length - 30} more`);
  }

  if (DRY_RUN) {
    console.log('\n  --dry-run: nothing written.');
    return;
  }

  fs.writeFileSync(
    OUT_PATH,
    `${JSON.stringify(
      {
        $comment:
          'GENERATED by scripts/sync-sharepoint.js. Do not edit by hand. deltaLink is the incremental-sync cursor; delete this file or run with --full to resync from scratch.',
        syncedAt: new Date().toISOString(),
        source: {
          hostname: CONFIG.hostname,
          sitePath: CONFIG.sitePath,
          library: CONFIG.library,
          folder: CONFIG.folder || null,
        },
        deltaLink: nextDelta,
        estimatedTokens,
        files,
        chunks: allChunks,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log(`\nWrote ${path.relative(REPO_ROOT, OUT_PATH)}`);
  console.log('Run `npm run build:knowledge` to compile it into the agent.');
}

main().catch((err) => {
  console.error(`\nSync failed: ${err.message}`);
  process.exit(1);
});
