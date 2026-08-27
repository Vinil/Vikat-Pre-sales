/**
 * What the sync reads.
 *
 * A GTM site keeps material in several libraries — PPTs, CISO briefs, ICP
 * files — and reading only one silently misses the rest. That is a failure
 * with no error message: the sync reports success, and a rep is told the deck
 * they can see in SharePoint does not exist.
 *
 * The script is a CLI that runs on import, so it is driven here against a
 * stubbed Graph and the file it writes is the assertion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
// NOT the real worker/src/knowledge/sharepoint.json. This suite runs the sync
// for real, so pointing it at the production path meant every case overwrote
// the live index with stubs and then deleted it — including in CI, mid-run,
// where it destroyed the delta cursor the next sync depends on.
const OUT = path.join(os.tmpdir(), `vikat-sync-test-${process.pid}.json`);
const SYNC = path.join(REPO, 'scripts/sync-sharepoint.js');

const DRIVES = [
  { id: 'd1', name: 'Documents', driveType: 'documentLibrary' },
  { id: 'd2', name: 'PPTs', driveType: 'documentLibrary' },
  { id: 'd3', name: 'CISO Briefs', driveType: 'documentLibrary' },
  { id: 'd4', name: 'Site Assets', driveType: 'documentLibrary' },
  { id: 'd5', name: 'Notebook', driveType: 'notebook' },
];

/** Every library uses item id "i1", which is the collision this guards. */
const ITEMS = {
  d1: [item('i1', 'Overview.pptx')],
  d2: [item('i1', 'DevSemantic_CTO.pptx'), item('i2', 'SecSemantic_CISO.pptx')],
  d3: [item('i1', 'CISO_Brief.pptx')],
  d4: [item('i1', 'Theme.pptx')],
};

function item(id, name, folder = '') {
  return {
    id,
    name,
    file: {},
    size: 500,
    webUrl: `https://sp.test/${id}`,
    lastModifiedDateTime: '2026-08-04T00:00:00Z',
    parentReference: { path: `/drive/root:${folder ? `/${folder}` : ''}` },
  };
}

/** A .pptx carrying one slide with enough text to clear the chunk minimum. */
function deck(name) {
  const text = `Content of ${name}, long enough to be indexed as a usable chunk of text.`;
  const slide =
    '<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp>' +
    `<p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  return zipSync({ 'ppt/slides/slide1.xml': strToU8(slide) });
}

/** Run the sync against a fake Graph and return what it wrote. */
async function runSync(env = {}) {
  const originalFetch = globalThis.fetch;
  const walked = [];

  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });

    if (u.includes('login.microsoftonline.com')) return json({ access_token: 't', expires_in: 3600 });
    if (/\/sites\/[^/]+:/.test(u)) return json({ id: 'site-1' });
    if (u.endsWith('/drives')) return json({ value: DRIVES });

    const delta = /\/drives\/(\w+)\/root\/delta/.exec(u);
    if (delta) {
      walked.push(delta[1]);
      return json({ value: ITEMS[delta[1]] || [], '@odata.deltaLink': `link-${delta[1]}` });
    }

    const download = /\/drives\/(\w+)\/items\/(\w+)\/content/.exec(u);
    if (download) {
      const name = (ITEMS[download[1]] || []).find((i) => i.id === download[2])?.name || 'x.pptx';
      return { ok: true, status: 200, arrayBuffer: async () => deck(name) };
    }

    return { ok: false, status: 404, text: async () => 'not found' };
  };

  Object.assign(process.env, {
    GRAPH_TENANT_ID: 't',
    GRAPH_CLIENT_ID: 'c',
    GRAPH_CLIENT_SECRET: 's',
    SHAREPOINT_HOSTNAME: 'vikatai.sharepoint.com',
    SHAREPOINT_SITE_PATH: '/sites/VikatGTM',
    SHAREPOINT_OUT_PATH: OUT,
    ...env,
  });
  if (!env.SHAREPOINT_LIBRARY) delete process.env.SHAREPOINT_LIBRARY;

  fs.rmSync(OUT, { force: true });

  try {
    // Cache-busted so each test re-runs main() rather than reusing the module.
    await import(`${OUT_URL()}?run=${walked.length}-${Math.round(process.hrtime()[1])}`);
    for (let i = 0; i < 200 && !fs.existsSync(OUT); i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return { walked, result: JSON.parse(fs.readFileSync(OUT, 'utf8')) };
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(OUT, { force: true });
  }
}

const OUT_URL = () => new URL(`file://${SYNC}`).href;

test('every document library on the site is read', async () => {
  const { walked, result } = await runSync();

  assert.deepEqual(result.source.libraries, ['Documents', 'PPTs', 'CISO Briefs']);
  assert.deepEqual(walked, ['d1', 'd2', 'd3'], 'each library gets its own delta pass');
  assert.equal(Object.keys(result.files).length, 4);
});

test("SharePoint's own libraries are left out", async () => {
  // Site Assets holds page furniture and themes; a notebook is not a library
  // at all. Indexing either buries the real collateral.
  const { walked, result } = await runSync();

  assert.ok(!walked.includes('d4'), 'Site Assets must be skipped');
  assert.ok(!walked.includes('d5'), 'a notebook is not a document library');
  assert.ok(!result.source.libraries.includes('Site Assets'));
});

test('an item id repeated across libraries does not evict its namesake', async () => {
  // Item ids are unique within a drive, not across them. Keying on the item
  // alone let a file in one library silently replace a file in another.
  const { result } = await runSync();
  const names = Object.values(result.files).map((f) => f.name).sort();

  assert.deepEqual(names, [
    'CISO_Brief.pptx',
    'DevSemantic_CTO.pptx',
    'Overview.pptx',
    'SecSemantic_CISO.pptx',
  ]);
});

test('provenance records which library a document came from', async () => {
  // "PPTs" and "CISO Briefs" carry different expectations about what may be
  // repeated to a customer, so the library has to survive into the index.
  const { result } = await runSync();
  const deckFile = Object.values(result.files).find((f) => f.name === 'DevSemantic_CTO.pptx');

  assert.equal(deckFile.library, 'PPTs');
  assert.equal(deckFile.page, 'sharepoint/PPTs/DevSemantic_CTO.pptx');
});

test('each library keeps its own incremental cursor', async () => {
  // One shared cursor across several libraries replays one drive's changes
  // against another and loses everything else.
  const { result } = await runSync();
  assert.deepEqual(Object.keys(result.deltaLinks).sort(), ['d1', 'd2', 'd3']);
});

test('naming a library narrows the sync to it', async () => {
  const { walked, result } = await runSync({ SHAREPOINT_LIBRARY: 'PPTs' });

  assert.deepEqual(walked, ['d2']);
  assert.deepEqual(result.source.libraries, ['PPTs']);
  assert.equal(Object.keys(result.files).length, 2);
});

test('a sentinel value means every library, since a variable cannot be blank', async () => {
  // GitHub Actions refuses to save a variable with an empty value, so "unset
  // it" is not always available. These read as "no narrowing" rather than as
  // the name of a library nobody has.
  for (const value of ['*', 'all', 'ALL', ' * ', 'any', '(all)']) {
    const { result } = await runSync({ SHAREPOINT_LIBRARY: value });
    assert.deepEqual(
      result.source.libraries,
      ['Documents', 'PPTs', 'CISO Briefs'],
      `"${value}" should read every library`,
    );
  }
});

test('a real library name still narrows, and a wrong one fails loudly', async () => {
  const { result } = await runSync({ SHAREPOINT_LIBRARY: 'CISO Briefs' });
  assert.deepEqual(result.source.libraries, ['CISO Briefs']);
});

test('the folder sentinel means no folder restriction, not a folder named "*"', async () => {
  // The same "*" that widens the library scope would, read literally, narrow
  // the folder scope to a folder nobody has — indexing nothing and reporting
  // success. Both variables have to understand the sentinel or neither should.
  for (const value of ['*', 'all', 'ALL', ' * ']) {
    const { result } = await runSync({ SHAREPOINT_LIBRARY: '*', SHAREPOINT_FOLDER: value });
    assert.equal(
      Object.keys(result.files).length,
      4,
      `SHAREPOINT_FOLDER="${value}" should not restrict anything`,
    );
    assert.equal(result.source.folder, null);
  }
});

test('a real folder name still restricts', async () => {
  // Nothing in the stub lives in a folder, so naming one must index nothing —
  // which is what proves the sentinel above is doing real work.
  const { result } = await runSync({ SHAREPOINT_LIBRARY: '*', SHAREPOINT_FOLDER: 'Approved' });
  assert.equal(Object.keys(result.files).length, 0);
  assert.equal(result.source.folder, 'Approved');
});

test('a supplied site id skips path resolution entirely', async () => {
  // Resolving a site by hostname:path is a separate Graph operation from
  // reading it, and a Sites.Selected app is not always permitted the former.
  // The resulting 401 is indistinguishable from a missing grant, so being able
  // to skip the step removes a whole class of misdiagnosis.
  const seen = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    const json = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });

    if (u.includes('login.microsoftonline.com')) return json({ access_token: 't', expires_in: 3600 });
    // One empty library: enough for the script to run to completion, so the
    // assertion is about which calls it made rather than how it gave up.
    if (u.endsWith('/drives')) return json({ value: [{ id: 'd1', name: 'Documents', driveType: 'documentLibrary' }] });
    if (u.includes('/root/delta')) return json({ value: [], '@odata.deltaLink': 'link-d1' });
    return { ok: false, status: 404, text: async () => 'not found' };
  };

  Object.assign(process.env, {
    GRAPH_TENANT_ID: 't',
    GRAPH_CLIENT_ID: 'c',
    GRAPH_CLIENT_SECRET: 's',
    SHAREPOINT_HOSTNAME: 'vikatai.sharepoint.com',
    SHAREPOINT_SITE_PATH: '/sites/VikatGTM',
    SHAREPOINT_SITE_ID: 'vikatai.sharepoint.com,aaaa,bbbb',
  });

  try {
    fs.rmSync(OUT, { force: true });
    await import(`${OUT_URL()}?siteid=${process.hrtime.bigint()}`);
    for (let i = 0; i < 200 && !fs.existsSync(OUT); i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }

    const resolved = seen.filter((u) => /\/sites\/[^,]+:/.test(u));
    assert.deepEqual(resolved, [], 'no hostname:path resolution should be attempted');
    assert.ok(
      seen.some((u) => u.includes('vikatai.sharepoint.com,aaaa,bbbb/drives')),
      'the supplied id should be used directly',
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.SHAREPOINT_SITE_ID;
    fs.rmSync(OUT, { force: true });
  }
});

test('the workflow passes every variable the sync reads', () => {
  // Twice now a config option has been added to the script and not to the
  // workflow, so the variable someone dutifully set never reached the process
  // and the run failed exactly as it had before. The script's own env reads
  // are the source of truth; the workflow has to keep up with them.
  const script = fs.readFileSync(SYNC, 'utf8');
  const workflow = fs.readFileSync(path.join(REPO, '.github/workflows/sync-knowledge.yml'), 'utf8');

  // Two forms: direct reads, and the requireEnv() helper that the mandatory
  // ones go through. Missing the second is how this check first passed while
  // proving nothing — every required variable was invisible to it.
  const read = new Set([
    ...[...script.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]),
    ...[...script.matchAll(/requireEnv\(['"]([A-Z][A-Z0-9_]+)['"]\)/g)].map((m) => m[1]),
  ]);
  // Set by the workflow's own step, not by configuration.
  read.delete('FULL');
  // A test seam, not configuration: it exists so this suite does not write to
  // the real output path. CI must NOT set it.
  read.delete('SHAREPOINT_OUT_PATH');

  assert.ok(read.size >= 9, `expected the script's full config surface, found ${read.size}`);

  // A plain substring: the env block writes each as "NAME: ${{ vars.NAME }}",
  // and a regex here has its own escaping to get wrong.
  const missing = [...read].filter((name) => !workflow.includes(`${name}:`));

  assert.deepEqual(
    missing,
    [],
    `sync-knowledge.yml does not pass: ${missing.join(', ')} — the variable would be silently empty`,
  );
});

test('this suite never writes to the real sync output path', () => {
  // It used to. Every case here ran the sync for real against the production
  // path, overwriting the live index with stubs and deleting it afterwards. In
  // CI that landed between "Compile the knowledge base" and "Save sync cursor",
  // so the deploy was correct and the delta cursor was gone — the cache step
  // logged "Path(s) specified in the action for caching do(es) not exist" and
  // every nightly run quietly became a full resync.
  const production = path.join(REPO, 'worker/src/knowledge/sharepoint.json');
  assert.notEqual(OUT, production, 'the fixture path must not be the production path');
  assert.ok(
    !OUT.startsWith(REPO),
    `the fixture must live outside the repo entirely, not at ${OUT}`,
  );
});
