/**
 * bundler.test.js — the module rules the DEPLOY uses, not the ones the tests use.
 *
 * The Worker imports fonts and the brand mark as bytes. Two things have to
 * agree for that to work, and nothing made them:
 *
 *   - wrangler.toml, which tells esbuild which extensions are Data modules.
 *   - test/ttf-loader.mjs, which registers an equivalent Node hook so the same
 *     imports resolve under `node --test`.
 *
 * The loader's own header says "Both extensions wrangler.toml declares as
 * Data", and that claim was never checked. It went wrong in the obvious way:
 * the mark was added as a SECOND [[rules]] block, both blocks said
 * `fallthrough = false`, and wrangler stops at the first rule of a type unless
 * told otherwise. Every deploy failed at the bundler. The full suite passed
 * throughout, because the loader hook covers each extension independently and
 * has no opinion about rule order.
 *
 * A test that reads the deployed config is the only kind that could have
 * caught it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const toml = fs.readFileSync(path.join(here, '../wrangler.toml'), 'utf8');
const loader = fs.readFileSync(path.join(here, 'ttf-loader.mjs'), 'utf8');

/** Every [[rules]] block, as { type, globs, fallthrough }. */
function moduleRules(text) {
  return text
    .split(/^\[\[rules\]\]$/m)
    .slice(1)
    .map((block) => block.split(/^\[/m)[0])
    .map((block) => ({
      type: (/type\s*=\s*"([^"]+)"/.exec(block) || [])[1],
      globs: [...block.matchAll(/"\*\*\/\*\.([a-z0-9]+)"/g)].map((m) => m[1]),
      fallthrough: /fallthrough\s*=\s*true/.test(block),
    }));
}

test('no module rule is shadowed by an earlier one of the same type', () => {
  // The deploy failure, as a test. wrangler only reaches a second rule of a
  // given type if every rule before it is marked fallthrough.
  const rules = moduleRules(toml);
  assert.ok(rules.length, 'wrangler.toml declares no module rules at all?');

  const seen = new Map();
  for (const rule of rules) {
    const previous = seen.get(rule.type);
    if (previous) {
      assert.ok(
        previous.fallthrough,
        `a ${rule.type} rule for ${rule.globs.join(', ')} is unreachable: the earlier ` +
          `${rule.type} rule for ${previous.globs.join(', ')} is not fallthrough. ` +
          'Add the globs to that rule, or mark it `fallthrough = true`.',
      );
    }
    seen.set(rule.type, rule);
  }
});

test('the test loader covers exactly the extensions wrangler bundles as Data', () => {
  // Either direction is a real failure. An extension wrangler bundles but the
  // loader does not is an import that works in production and throws under
  // `node --test`; the reverse is a test importing something the deployed
  // Worker cannot, which is how a green suite ships a broken Worker.
  const declared = moduleRules(toml)
    .filter((r) => r.type === 'Data')
    .flatMap((r) => r.globs)
    .sort();
  assert.ok(declared.length, 'no Data globs found — did the rule shape change?');

  const hook = /\\.\(\?:([a-z0-9|]+)\)\$/.exec(loader);
  assert.ok(hook, 'could not find the extension pattern in ttf-loader.mjs');
  const covered = hook[1].split('|').sort();

  assert.deepEqual(
    covered,
    declared,
    'test/ttf-loader.mjs and wrangler.toml disagree about which files are bytes',
  );
});
