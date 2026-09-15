/**
 * The workflows that put knowledge in front of a rep.
 *
 * These are not unit tests of a function; they hold one invariant that nothing
 * else can see. build-knowledge.js compiles whatever is in the knowledge
 * directory AT THE TIME IT RUNS, and the committed knowledge.js is built from
 * the public site and the curated FAQ alone, because this repository is
 * public. So any workflow that compiles and deploys must merge SharePoint in
 * first, or it ships a Worker that has never seen the internal material — and
 * reports itself perfectly healthy while doing it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');

/**
 * The commands a workflow actually RUNS, in order.
 *
 * Comments are stripped first, and that is not fussiness: the first version of
 * this test searched the whole file and failed on a comment that named
 * build-knowledge.js while explaining why the order matters. A test that reads
 * prose is measuring the wrong thing — it would pass a workflow whose steps
 * were wrong but whose comments were reassuring, which is precisely the
 * failure it exists to catch.
 */
function commands(yml) {
  return yml
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
    .split('\n')
    .filter((l) => /^\s*(run:|-\s)/.test(l) || /node scripts\//.test(l))
    .join('\n');
}

const DEPLOYS = ['deploy.yml', 'sync-knowledge.yml'];

test('every workflow that deploys merges SharePoint before compiling', () => {
  // The regression this exists for: Deploy rebuilt from the public site only,
  // so a deploy fourteen minutes after a nightly sync left sharePointChunks
  // at 0 and the agent answering reps about Vikat out of marketing pages. It
  // was silent for a week — /health said ok:true throughout.
  for (const file of DEPLOYS) {
    const yml = commands(read(file));
    assert.ok(yml.includes('wrangler') || yml.includes('run deploy'), `${file} no longer deploys?`);

    const sync = yml.indexOf('sync-sharepoint.js');
    const build = yml.indexOf('build-knowledge.js');

    assert.ok(sync !== -1, `${file} deploys without ever merging SharePoint material`);
    assert.ok(build !== -1, `${file} deploys without compiling the knowledge base`);
    assert.ok(
      sync < build,
      `${file} compiles the knowledge base BEFORE merging SharePoint, so the merge reaches nothing`,
    );
  }
});

test('skipping the merge is a deliberate act, not a default', () => {
  // An escape hatch for a Graph outage during an urgent rollforward. It has to
  // be off unless someone chooses it, or the regression comes back as the
  // path of least resistance.
  const yml = read('deploy.yml');

  assert.match(yml, /skip_sharepoint:/);
  const block = yml.slice(yml.indexOf('skip_sharepoint:'));
  assert.match(block.slice(0, 200), /default: false/, 'the skip must default to off');
  assert.match(yml, /!inputs\.skip_sharepoint/, 'the skip is declared but never honoured');
});

test('a failed merge stops the deploy rather than shipping a hole', () => {
  // Continuing past a failed merge is the same regression with extra steps,
  // and it would be invisible in exactly the same way.
  const yml = read('deploy.yml');
  assert.match(yml, /::error::SharePoint material could not be merged/);
  assert.match(yml, /skip_sharepoint if you need the code change out/);
});

test('no browser test loads a page over file://', () => {
  // Ten admin tests were red in CI for weeks while passing locally, all with
  // "page.waitForFunction: Timeout 5000ms exceeded". They loaded admin.html
  // from file://, and admin.js calls fetch('/admin/summary'), which on a file
  // origin resolves to file:///admin/summary rather than a request
  // page.route('**' + '/admin/**') can answer.
  //
  // Whether that fetch is interceptable at all depends on the Chromium build,
  // which is why it passed on one machine and timed out on another. The
  // reason was already written in widget.test.js, for the app tests, and had
  // simply never been applied to the admin ones.
  //
  // A real origin is also what the app actually runs on, so this is the more
  // honest harness as well as the working one.
  const dir = path.join(root, 'worker/test');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.test.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const offenders = src
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => /\.goto\(\s*`?file:\/\//.test(line));

    assert.deepEqual(
      offenders,
      [],
      `${f} loads a page over file://, where fetch() cannot be intercepted:\n` +
        offenders.map(([n, l]) => `  ${n}: ${l.trim()}`).join('\n'),
    );
  }
});
