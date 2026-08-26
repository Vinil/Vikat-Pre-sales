/**
 * graph.js — the ONLY module that talks to Microsoft Graph.
 *
 * Same abstraction discipline as the Worker's storage.js / leadSink.js: one
 * module owns the vendor API, so replacing SharePoint with another source is a
 * change here and nowhere else.
 *
 * Auth is the client-credentials flow — an app registration acting as itself,
 * not as a user. That means the app's permissions ARE the scope of what the
 * assistant can read, which is why `Sites.Selected` is worth the extra setup
 * over `Sites.Read.All`: it limits the app to sites an admin has explicitly
 * granted, rather than every site in the tenant.
 *
 * Required environment:
 *   GRAPH_TENANT_ID       Directory (tenant) ID
 *   GRAPH_CLIENT_ID       Application (client) ID
 *   GRAPH_CLIENT_SECRET   Client secret            <- a secret, never committed
 */

const LOGIN_HOST = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';

/** Retry on throttling and transient server errors, honouring Retry-After. */
async function request(url, token, { retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    if (res.ok) return res;

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      const body = await res.text().catch(() => '');
      throw new Error(`Graph ${res.status} ${url}\n${body.slice(0, 400)}`);
    }

    // Graph sends Retry-After on 429 and means it. Respect it rather than
    // guessing, or the next attempt is throttled too.
    const after = Number(res.headers.get('Retry-After'));
    const waitMs = Number.isFinite(after) && after > 0 ? after * 1000 : 2 ** attempt * 1000;
    console.warn(`  Graph ${res.status}; retrying in ${Math.round(waitMs / 1000)}s`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

/**
 * Acquire an app-only access token.
 *
 * @param {{ tenantId: string, clientId: string, clientSecret: string }} creds
 * @returns {Promise<string>}
 */
/**
 * Translate the Entra error codes that have one cause each.
 *
 * Azure shows a secret's ID in the list and its Value only once, at creation,
 * so reaching for the wrong one is the default mistake rather than a careless
 * one. The raw message does say so — under a trace id, a correlation id and a
 * timestamp, where nobody reads it.
 */
function explainAuthFailure(body) {
  if (body.includes('AADSTS7000215')) {
    return 'GRAPH_CLIENT_SECRET holds the secret ID, not the secret VALUE. The Value is shown once when you create the secret; if you cannot see it, create a new one and copy it immediately.';
  }
  if (body.includes('AADSTS7000222')) {
    return 'The client secret has expired. Create a new one in Certificates & secrets and update GRAPH_CLIENT_SECRET.';
  }
  if (body.includes('AADSTS700016') || body.includes('AADSTS900023')) {
    return 'GRAPH_CLIENT_ID or GRAPH_TENANT_ID does not match an app in this tenant. Both are on the app registration Overview page.';
  }
  return '';
}

export async function getToken({ tenantId, clientId, clientSecret }) {
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      'Missing Graph credentials. Set GRAPH_TENANT_ID, GRAPH_CLIENT_ID and GRAPH_CLIENT_SECRET.',
    );
  }

  const res = await fetch(`${LOGIN_HOST}/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // The error body carries the AADSTS code, which is the only thing that
    // makes an auth failure diagnosable. Keep it, but lead with a translation:
    // the codes that matter here have exactly one cause each, and the raw text
    // buries it under trace and correlation ids.
    const hint = explainAuthFailure(body);
    throw new Error(
      `Token request failed (${res.status}).${hint ? `\n\n  ${hint}\n` : ' '}${body.slice(0, 400)}`,
    );
  }

  const { access_token: token } = await res.json();
  if (!token) throw new Error('Token response contained no access_token.');
  return token;
}

/**
 * Resolve a site by hostname and server-relative path.
 *
 * @param {string} token
 * @param {string} hostname   e.g. "vikat.sharepoint.com"
 * @param {string} sitePath   e.g. "/sites/Sales"
 */
export async function getSite(token, hostname, sitePath) {
  const clean = sitePath.replace(/^\/+|\/+$/g, '');
  const res = await request(`${GRAPH}/sites/${hostname}:/${clean}`, token);
  return res.json();
}

/** List the document libraries (drives) on a site. */
export async function listDrives(token, siteId) {
  const res = await request(`${GRAPH}/sites/${siteId}/drives`, token);
  const { value } = await res.json();
  return value || [];
}

/**
 * Walk a drive with a delta query.
 *
 * The first run has no token and returns everything; later runs pass the
 * saved deltaLink and get only what changed — including deletions, which
 * arrive as items carrying a `deleted` facet. That is the whole reason to use
 * delta rather than re-listing: a deck removed from SharePoint has to leave
 * the knowledge base too, and a full re-list cannot tell you that.
 *
 * @returns {Promise<{ items: object[], deltaLink: string|null }>}
 */
export async function deltaItems(token, driveId, deltaLink) {
  let url = deltaLink || `${GRAPH}/drives/${driveId}/root/delta`;
  const items = [];
  let nextDelta = null;

  for (;;) {
    const res = await request(url, token);
    const page = await res.json();

    for (const item of page.value || []) items.push(item);

    if (page['@odata.nextLink']) {
      url = page['@odata.nextLink'];
      continue;
    }
    nextDelta = page['@odata.deltaLink'] || null;
    break;
  }

  return { items, deltaLink: nextDelta };
}

/**
 * Download a drive item's bytes.
 *
 * The pre-authenticated download URL must be fetched WITHOUT the bearer token
 * — it carries its own credential, and sending both makes Graph reject it.
 */
export async function downloadItem(token, item) {
  const direct = item['@microsoft.graph.downloadUrl'];

  if (direct) {
    const res = await fetch(direct);
    if (!res.ok) throw new Error(`Download failed (${res.status}) for ${item.name}`);
    return Buffer.from(await res.arrayBuffer());
  }

  const res = await request(
    `${GRAPH}/drives/${item.parentReference.driveId}/items/${item.id}/content`,
    token,
  );
  return Buffer.from(await res.arrayBuffer());
}

/** Server-relative folder path of an item, e.g. "Approved/Battlecards". */
export function folderPathOf(item) {
  const raw = item.parentReference?.path || '';
  // Graph returns "/drives/{id}/root:/Approved/Battlecards".
  const idx = raw.indexOf('root:');
  return idx === -1 ? '' : decodeURIComponent(raw.slice(idx + 5)).replace(/^\/+/, '');
}
