/**
 * Graph client tests. The network is stubbed — what matters here is that the
 * client sends the right requests, retries the right failures, and never
 * leaks a credential into a URL that carries its own.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getToken, getSite, listDrives, deltaItems, downloadItem, folderPathOf } from '../lib/graph.js';

function stub(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

function ok(json, headers = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => json,
    text: async () => JSON.stringify(json),
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(json)).buffer,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  };
}

function fail(status, body = '', headers = {}) {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  };
}

async function withFetch(s, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = s;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const CREDS = { tenantId: 'tid', clientId: 'cid', clientSecret: 'secret' };

// --- Token ----------------------------------------------------------------

test('getToken posts client credentials to the tenant endpoint', async () => {
  const s = stub(() => ok({ access_token: 'tok123' }));
  const token = await withFetch(s, () => getToken(CREDS));

  assert.equal(token, 'tok123');
  assert.match(s.calls[0].url, /login\.microsoftonline\.com\/tid\/oauth2\/v2\.0\/token/);

  const body = s.calls[0].init.body;
  assert.equal(body.get('grant_type'), 'client_credentials');
  assert.equal(body.get('scope'), 'https://graph.microsoft.com/.default');
  assert.equal(body.get('client_id'), 'cid');
});

test('getToken refuses to call out with missing credentials', async () => {
  for (const missing of ['tenantId', 'clientId', 'clientSecret']) {
    const creds = { ...CREDS, [missing]: '' };
    await assert.rejects(() => getToken(creds), /Missing Graph credentials/);
  }
});

test('getToken surfaces the AADSTS error body, which is the only diagnosable part', async () => {
  const s = stub(() => fail(401, '{"error":"invalid_client","error_description":"AADSTS7000215"}'));
  await assert.rejects(() => withFetch(s, () => getToken(CREDS)), /AADSTS7000215/);
});

test('getToken rejects a 200 with no token rather than returning undefined', async () => {
  const s = stub(() => ok({ token_type: 'Bearer' }));
  await assert.rejects(() => withFetch(s, () => getToken(CREDS)), /no access_token/);
});

// --- Site and drives ------------------------------------------------------

test('getSite addresses the site by hostname and path', async () => {
  const s = stub(() => ok({ id: 'site-1' }));
  const site = await withFetch(s, () => getSite('tok', 'vikat.sharepoint.com', '/sites/Sales'));

  assert.equal(site.id, 'site-1');
  assert.match(s.calls[0].url, /\/sites\/vikat\.sharepoint\.com:\/sites\/Sales$/);
  assert.equal(s.calls[0].init.headers.Authorization, 'Bearer tok');
});

test('getSite tolerates leading and trailing slashes in the site path', async () => {
  const s = stub(() => ok({ id: 'site-1' }));
  await withFetch(s, () => getSite('tok', 'h.example', '//sites/Sales//'));
  assert.match(s.calls[0].url, /:\/sites\/Sales$/);
});

test('listDrives returns an empty array when the app can see nothing', async () => {
  const s = stub(() => ok({}));
  assert.deepEqual(await withFetch(s, () => listDrives('tok', 'site-1')), []);
});

// --- Delta ----------------------------------------------------------------

test('deltaItems starts at root when there is no saved cursor', async () => {
  const s = stub(() => ok({ value: [{ id: 'a' }], '@odata.deltaLink': 'https://next' }));
  const r = await withFetch(s, () => deltaItems('tok', 'drive-1', null));

  assert.match(s.calls[0].url, /\/drives\/drive-1\/root\/delta$/);
  assert.equal(r.items.length, 1);
  assert.equal(r.deltaLink, 'https://next');
});

test('deltaItems resumes from a saved cursor', async () => {
  const s = stub(() => ok({ value: [], '@odata.deltaLink': 'https://next2' }));
  await withFetch(s, () => deltaItems('tok', 'drive-1', 'https://saved-cursor'));
  assert.equal(s.calls[0].url, 'https://saved-cursor');
});

test('deltaItems follows pagination and returns the final cursor', async () => {
  const s = stub((url, init, n) => {
    if (n === 1) return ok({ value: [{ id: 'a' }], '@odata.nextLink': 'https://page2' });
    if (n === 2) return ok({ value: [{ id: 'b' }], '@odata.nextLink': 'https://page3' });
    return ok({ value: [{ id: 'c' }], '@odata.deltaLink': 'https://final' });
  });

  const r = await withFetch(s, () => deltaItems('tok', 'd', null));
  assert.deepEqual(r.items.map((i) => i.id), ['a', 'b', 'c']);
  assert.equal(r.deltaLink, 'https://final', 'the cursor comes from the last page only');
  assert.equal(s.calls.length, 3);
});

// --- Retries --------------------------------------------------------------

test('a 429 is retried after the Retry-After delay', async () => {
  const s = stub((url, init, n) =>
    n === 1 ? fail(429, 'throttled', { 'retry-after': '0' }) : ok({ value: [], '@odata.deltaLink': 'x' }),
  );
  const r = await withFetch(s, () => deltaItems('tok', 'd', null));
  assert.equal(s.calls.length, 2, 'the throttled call is retried');
  assert.equal(r.deltaLink, 'x');
});

test('a 500 is retried', async () => {
  const s = stub((url, init, n) => (n < 3 ? fail(503, 'unavailable') : ok({ value: [] })));
  await withFetch(s, () => deltaItems('tok', 'd', null));
  assert.equal(s.calls.length, 3);
});

test('a 403 is not retried — permissions will not fix themselves', async () => {
  const s = stub(() => fail(403, 'Access denied'));
  await assert.rejects(() => withFetch(s, () => listDrives('tok', 'site')), /403/);
  assert.equal(s.calls.length, 1, 'retrying an authorization failure just wastes time');
});

test('retries give up rather than looping forever', async () => {
  const s = stub(() => fail(500, 'always down'));
  await assert.rejects(() => withFetch(s, () => listDrives('tok', 'site')), /500/);
  assert.equal(s.calls.length, 5, 'initial attempt plus four retries');
});

// --- Download -------------------------------------------------------------

test('the pre-authenticated download URL is fetched WITHOUT a bearer token', async () => {
  // Sending both credentials makes Graph reject the request. This is the
  // single easiest thing to get wrong here.
  const s = stub(() => ok({ ok: 1 }));
  await withFetch(s, () =>
    downloadItem('tok', { name: 'a.pptx', '@microsoft.graph.downloadUrl': 'https://cdn/file' }),
  );

  assert.equal(s.calls[0].url, 'https://cdn/file');
  assert.equal(s.calls[0].init, undefined, 'no Authorization header on a pre-signed URL');
});

test('download falls back to the content endpoint with a bearer token', async () => {
  const s = stub(() => ok({ ok: 1 }));
  await withFetch(s, () =>
    downloadItem('tok', { id: 'i1', name: 'a.pptx', parentReference: { driveId: 'd1' } }),
  );

  assert.match(s.calls[0].url, /\/drives\/d1\/items\/i1\/content$/);
  assert.equal(s.calls[0].init.headers.Authorization, 'Bearer tok');
});

test('a failed download names the file', async () => {
  const s = stub(() => fail(404, 'gone'));
  await assert.rejects(
    () => withFetch(s, () => downloadItem('tok', { name: 'missing.pptx', '@microsoft.graph.downloadUrl': 'https://cdn/x' })),
    /missing\.pptx/,
  );
});

// --- Path parsing ---------------------------------------------------------

test('folderPathOf extracts the path below the drive root', () => {
  assert.equal(
    folderPathOf({ parentReference: { path: '/drives/b!abc/root:/Approved/Battlecards' } }),
    'Approved/Battlecards',
  );
});

test('folderPathOf returns empty for an item at the drive root', () => {
  assert.equal(folderPathOf({ parentReference: { path: '/drives/b!abc/root:' } }), '');
});

test('folderPathOf URL-decodes folder names with spaces', () => {
  assert.equal(
    folderPathOf({ parentReference: { path: '/drives/x/root:/Sales%20Enablement/Q1%20Decks' } }),
    'Sales Enablement/Q1 Decks',
  );
});

test('folderPathOf tolerates a missing parentReference', () => {
  assert.equal(folderPathOf({}), '');
});

test('a wrong-secret failure is explained before the trace ids', async () => {
  // AADSTS7000215 has exactly one cause, and the raw message buries it under a
  // trace id, a correlation id and a timestamp. This cost a real run.
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () =>
      '{"error":"invalid_client","error_description":"AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID, for a secret added to app \'x\'. Trace ID: 5f508edb Correlation ID: 24723f54 Timestamp: 2026-08-26"}',
  });

  try {
    await assert.rejects(
      getToken({ tenantId: 't', clientId: 'c', clientSecret: 'wrong' }),
      (err) => {
        assert.match(err.message, /secret ID, not the secret VALUE/);
        assert.match(err.message, /AADSTS7000215/, 'the original error is still there');
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('an expired secret says so, rather than reading as a wrong one', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => '{"error_description":"AADSTS7000222: The provided client secret keys for app are expired."}',
  });

  try {
    await assert.rejects(getToken({ tenantId: 't', clientId: 'c', clientSecret: 'old' }), /expired/);
  } finally {
    globalThis.fetch = original;
  }
});

test('a Sites.Selected site with no grant is explained, not blamed on the token', async () => {
  // SharePoint answers "no permission on this site" with "General exception
  // while processing", which sends people back to check credentials they have
  // just fixed. This exact response cost a real run.
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    headers: new Map(),
    text: async () =>
      '{"error":{"code":"generalException","message":"General exception while processing","innerError":{"code":"spException"}}}',
  });

  try {
    await assert.rejects(
      getSite('token', 'vikatai.sharepoint.com', '/sites/VikatGTM'),
      (err) => {
        assert.match(err.message, /no permission on VikatGTM/);
        assert.match(err.message, /Sites\.Selected grants nothing on its own/);
        assert.match(err.message, /spException/, 'the original error survives');
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('an unrelated Graph failure is passed through untranslated', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    headers: new Map(),
    text: async () => '{"error":{"code":"itemNotFound","message":"The resource could not be found."}}',
  });

  try {
    await assert.rejects(getSite('token', 'h', '/sites/x'), (err) => {
      assert.match(err.message, /itemNotFound/);
      assert.ok(!/Sites\.Selected/.test(err.message), 'no guess where there is one cause too many');
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});
