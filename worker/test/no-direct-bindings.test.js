/**
 * Enforces the Forward Compatibility rules mechanically, so a Tier B migration
 * cannot be quietly broken by a shortcut added later.
 *
 * Tier A Definition of Done: "All storage, retrieval, and lead delivery flows
 * pass through the abstraction modules (verified by grep: no direct KV/email
 * calls outside them)." This is that grep, as a test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

/** Every .js file under src/, as { rel, text }. */
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) {
        out.push({ rel: path.relative(SRC, full), text: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(SRC);
  return out;
}

/** Lines matching `re`, excluding comments — a mention in prose is not a call. */
function offendingLines(text, re) {
  return text
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'))
    .filter(({ line }) => re.test(line));
}

test('rule 1: only storage.js touches the KV binding', () => {
  const violations = [];
  for (const f of sourceFiles()) {
    if (f.rel === 'storage.js') continue;
    for (const v of offendingLines(f.text, /\bVIKAT_KV\b\s*\./)) {
      violations.push(`${f.rel}:${v.n}  ${v.line}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `KV must be reached through storage.js so Tier B can swap it for D1:\n${violations.join('\n')}`,
  );
});

test('rule 1: no module outside storage.js calls a KV method directly', () => {
  const KV_METHOD = /\.(put|get|list|delete)\s*\(\s*[`'"](lead|session|log|rate):/;
  const violations = [];
  for (const f of sourceFiles()) {
    if (f.rel === 'storage.js') continue;
    for (const v of offendingLines(f.text, KV_METHOD)) {
      violations.push(`${f.rel}:${v.n}  ${v.line}`);
    }
  }
  assert.deepEqual(violations, [], `Namespaced key access belongs in storage.js:\n${violations.join('\n')}`);
});

test('rule 2: only retrieve.js imports the compiled knowledge base', () => {
  const violations = [];
  for (const f of sourceFiles()) {
    if (f.rel === 'retrieve.js') continue;
    for (const v of offendingLines(f.text, /from\s+['"][./]*knowledge\.js['"]/)) {
      violations.push(`${f.rel}:${v.n}  ${v.line}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Knowledge must be reached through retrieve() so Tier B can swap in Vectorize:\n${violations.join('\n')}`,
  );
});

test('rule 3: only leadSink.js sends mail or posts a lead outbound', () => {
  const OUTBOUND = /(mailchannels|api\.hubapi\.com|sendgrid|postmark|resend\.com|LEAD_WEBHOOK_URL)/i;
  const violations = [];
  for (const f of sourceFiles()) {
    if (f.rel === 'leadSink.js' || f.rel === 'config.js') continue;
    for (const v of offendingLines(f.text, OUTBOUND)) {
      violations.push(`${f.rel}:${v.n}  ${v.line}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Lead delivery must go through deliverLead() so Tier B can add a CRM:\n${violations.join('\n')}`,
  );
});

test('rule 4: no hardcoded vikat.ai URL or model id outside config.js', () => {
  const LITERAL = /['"`]https?:\/\/[^'"`]*vikat\.ai|['"`]claude-[a-z0-9-]+['"`]/;
  const violations = [];
  for (const f of sourceFiles()) {
    if (f.rel === 'config.js') continue;
    for (const v of offendingLines(f.text, LITERAL)) {
      violations.push(`${f.rel}:${v.n}  ${v.line}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Endpoints and model ids belong in config.js:\n${violations.join('\n')}`,
  );
});

test('hard rule 1: no API key literal anywhere in source', () => {
  const violations = [];
  for (const f of sourceFiles()) {
    for (const v of offendingLines(f.text, /sk-ant-[A-Za-z0-9_-]{10,}/)) {
      violations.push(`${f.rel}:${v.n}`);
    }
  }
  assert.deepEqual(violations, [], `An API key literal is committed:\n${violations.join('\n')}`);
});

test('hard rule 1: the API key is only ever read from env', () => {
  for (const f of sourceFiles()) {
    for (const { line, n } of offendingLines(f.text, /ANTHROPIC_API_KEY/)) {
      assert.ok(
        /env\.ANTHROPIC_API_KEY|ANTHROPIC_API_KEY['"]?\s*[,)\]]|wrangler secret/.test(line),
        `${f.rel}:${n} reads ANTHROPIC_API_KEY from somewhere other than env: ${line}`,
      );
    }
  }
});

test('rule 5: only auth.js decides identity', () => {
  const IDENTITY = /(Cf-Access-Jwt-Assertion|CF_Authorization|cloudflareaccess\.com|login\.microsoftonline\.com|X-Dev-User)/i;
  const violations = [];
  for (const f of sourceFiles()) {
    if (f.rel === 'auth.js' || f.rel === 'config.js') continue;
    for (const v of offendingLines(f.text, IDENTITY)) {
      // index.js legitimately names the headers in its CORS allowlist.
      if (f.rel === 'index.js' && /Access-Control-Allow-Headers/.test(v.line)) continue;
      violations.push(`${f.rel}:${v.n}  ${v.line}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Identity must be established in auth.js only:\n${violations.join('\n')}`,
  );
});

test('hard rule: /chat is not reachable without authenticate()', () => {
  const index = sourceFiles().find((f) => f.rel === 'index.js').text;
  const chatRoute = index.indexOf("url.pathname === '/chat'");
  assert.ok(chatRoute > 0, 'the /chat route should exist');

  const authCall = index.indexOf('await authenticate(');
  assert.ok(authCall > 0, 'authenticate() must be called');

  // The CALL, not the declaration — `function handleChat(request, ...)` appears
  // earlier in the file and would make this assertion pass vacuously.
  const handleChatCall = index.indexOf('await handleChat(');
  assert.ok(handleChatCall > 0, 'handleChat() must be called');
  assert.ok(
    authCall < handleChatCall,
    'authenticate() must run before handleChat() so an anonymous caller costs nothing',
  );

  // And the guard must actually reject, not merely compute a result.
  assert.match(index, /if \(!auth\.ok\)/, 'the auth result must gate the request');
});

test('dev auth cannot be enabled by a bare AUTH_MODE change', () => {
  const auth = sourceFiles().find((f) => f.rel === 'auth.js').text;
  assert.match(
    auth,
    /if \(!cfg\.ALLOW_DEV_AUTH\)/,
    'dev mode must be gated on a second explicit flag, not just AUTH_MODE',
  );
});

test('the committed knowledge base contains no SharePoint material', async () => {
  // This repository is PUBLIC. Site pages and the curated FAQ are already
  // public; SharePoint chunks are internal sales material (pricing bands,
  // battlecards, customer names). The nightly workflow merges them inside CI
  // and deploys without committing, so a SharePoint chunk reaching a commit
  // means that separation has broken.
  const { KNOWLEDGE } = await import('../src/knowledge.js');
  const leaked = KNOWLEDGE.filter((c) => c.page.startsWith('sharepoint/') || c.id.startsWith('sp:'));

  assert.deepEqual(
    leaked.map((c) => c.page),
    [],
    'Internal SharePoint content is in the committed knowledge base. Rebuild without it ' +
      '(`node scripts/build-knowledge.js --pages <site>`) and confirm sharepoint.json is gitignored.',
  );
});

test('the SharePoint sync output is gitignored', () => {
  const ignore = fs.readFileSync(path.resolve(SRC, '../../.gitignore'), 'utf8');
  assert.match(
    ignore,
    /worker\/src\/knowledge\/sharepoint\.json/,
    'sharepoint.json holds internal material and must never be committed to a public repo',
  );
});

test('wrangler.toml declares no secrets', () => {
  const toml = fs.readFileSync(path.resolve(SRC, '../wrangler.toml'), 'utf8');
  const declarations = toml
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .filter((l) => /(ANTHROPIC_API_KEY|DKIM_PRIVATE_KEY|MAILCHANNELS_API_KEY|LEAD_WEBHOOK_TOKEN)\s*=/.test(l));
  assert.deepEqual(declarations, [], 'Secrets must be set with `wrangler secret put`, never in config.');
});
