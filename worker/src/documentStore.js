/**
 * documentStore.js — where a generated document goes.
 *
 * The fourth abstraction, alongside storage.js, retrieve.js and leadSink.js.
 * This is the ONLY module in the Worker that talks to Microsoft Graph. Tier B
 * swapping SharePoint for Drive, or S3, or a CRM attachment, is a change to
 * this file and nothing else.
 *
 * It fails soft on purpose. A rep asking for a deck mid-call needs the deck;
 * whether it also landed in SharePoint is a detail they can act on afterwards.
 * So `deliverDocument` never throws — it reports what happened and lets the
 * caller tell the truth about it.
 *
 * SCOPE: the app registration behind this should hold Sites.Selected with
 * write granted on one site, not Files.ReadWrite.All. See README
 * "Generated documents". A credential that can write anywhere in the tenant
 * is not worth the convenience of skipping one admin step.
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';
const LOGIN = 'https://login.microsoftonline.com';

/**
 * Tokens last an hour; the isolate rarely does. Caching still saves a round
 * trip for every document after the first in a warm isolate.
 *
 * @type {{ token: string, expiresAt: number } | null}
 */
let tokenCache = null;

function graphConfigured(env, cfg) {
  return Boolean(
    env.GRAPH_TENANT_ID &&
      env.GRAPH_CLIENT_ID &&
      env.GRAPH_CLIENT_SECRET &&
      // Either way of naming the site will do.
      (cfg.SHAREPOINT_SITE_ID || (cfg.SHAREPOINT_HOSTNAME && cfg.SHAREPOINT_SITE_PATH)),
  );
}

async function getToken(env) {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;

  const body = new URLSearchParams({
    client_id: env.GRAPH_CLIENT_ID,
    client_secret: env.GRAPH_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const res = await fetch(`${LOGIN}/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    // The response body carries the client secret's expiry story; the text is
    // safe to log (it never echoes the secret) and is the only thing that
    // distinguishes "expired" from "wrong tenant".
    throw new Error(`token request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  const json = await res.json();
  tokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in || 3600) * 1000,
  };

  return tokenCache.token;
}

async function graph(token, path) {
  const res = await fetch(`${GRAPH}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/**
 * Resolve the target drive.
 *
 * Cached per isolate: the site and library do not move, and resolving them
 * costs two round trips before any upload can start.
 */
let driveCache = null;

async function resolveDrive(token, cfg) {
  const key = `${cfg.SHAREPOINT_SITE_ID || `${cfg.SHAREPOINT_HOSTNAME}${cfg.SHAREPOINT_SITE_PATH}`}/${cfg.SHAREPOINT_LIBRARY}`;
  if (driveCache && driveCache.key === key) return driveCache.id;

  // A configured id skips the lookup entirely — see SHAREPOINT_SITE_ID in
  // config.js for why that is not merely an optimisation.
  const siteId =
    cfg.SHAREPOINT_SITE_ID ||
    (await graph(token, `/sites/${cfg.SHAREPOINT_HOSTNAME}:${cfg.SHAREPOINT_SITE_PATH}`)).id;
  const drives = await graph(token, `/sites/${siteId}/drives`);

  const drive = (drives.value || []).find((d) => d.name === cfg.SHAREPOINT_LIBRARY);
  if (!drive) {
    const available = (drives.value || []).map((d) => d.name).join(', ') || '(none visible to this app)';
    throw new Error(`library "${cfg.SHAREPOINT_LIBRARY}" not found on the site. Available: ${available}`);
  }

  driveCache = { key, id: drive.id };
  return drive.id;
}

/** Graph addresses items by path; each segment must be encoded separately. */
function encodePath(segments) {
  return segments
    .filter(Boolean)
    .map((s) => encodeURIComponent(String(s).replace(/^\/+|\/+$/g, '')))
    .join('/');
}

/**
 * File a generated document in SharePoint.
 *
 * Never throws. Returns what happened so the caller can tell the rep the
 * truth: a document that generated but did not file is still a document they
 * can use.
 *
 * @param {{ fileName: string, bytes: Uint8Array, contentType: string }} file
 * @param {Record<string, unknown>} env
 * @param {object} cfg
 * @returns {Promise<{ delivered: boolean, webUrl?: string, reason?: string }>}
 */
/**
 * The document libraries on the site, so an admin can choose where a file goes.
 *
 * Names only. The caller picks one and hands it back to uploadDocument, which
 * resolves it again — the drive id is never sent to a browser, because it is
 * the one part of this that a URL could be built from.
 */
export async function listLibraries(env, cfg) {
  if (!graphConfigured(env, cfg)) return { ok: false, reason: 'not_configured', libraries: [] };

  try {
    const token = await getToken(env);
    const siteId =
      cfg.SHAREPOINT_SITE_ID ||
      (await graph(token, `/sites/${cfg.SHAREPOINT_HOSTNAME}:${cfg.SHAREPOINT_SITE_PATH}`)).id;
    const drives = await graph(token, `/sites/${siteId}/drives`);

    return {
      ok: true,
      libraries: (drives.value || [])
        .filter((d) => d.driveType === 'documentLibrary')
        .map((d) => d.name)
        .sort(),
    };
  } catch (err) {
    console.error('[documentStore] listLibraries failed:', err?.message || err);
    return { ok: false, reason: 'error', libraries: [] };
  }
}

/**
 * Put a file somewhere a person chose.
 *
 * Distinct from deliverDocument, which files the assistant's OWN output into a
 * folder the sync skips so it can never index its own writing. An uploaded
 * document is the opposite case: it is real collateral, and it belongs where
 * the sync will find it.
 *
 * The generated folder is refused here for exactly that reason — a rep
 * uploading into it would be putting curated material somewhere nothing reads.
 */
export async function uploadDocument(file, { library, folder }, env, cfg) {
  if (!graphConfigured(env, cfg)) return { ok: false, reason: 'not_configured' };
  if (file.bytes.byteLength > cfg.MAX_DOCUMENT_BYTES) return { ok: false, reason: 'too_large' };

  const cleanFolder = String(folder || '').replace(/^\/+|\/+$/g, '');
  if (cleanFolder && cleanFolder.split('/')[0] === cfg.SHAREPOINT_GENERATED_FOLDER) {
    return { ok: false, reason: 'generated_folder' };
  }

  try {
    const token = await getToken(env);
    const driveId = await resolveDrive(token, { ...cfg, SHAREPOINT_LIBRARY: library || cfg.SHAREPOINT_LIBRARY });
    const segments = cleanFolder ? [...cleanFolder.split('/'), file.fileName] : [file.fileName];
    const path = encodePath(segments);

    const res = await fetch(
      `${GRAPH}/drives/${driveId}/root:/${path}:/content?@microsoft.graph.conflictBehavior=rename`,
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': file.contentType },
        body: file.bytes,
      },
    );

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      console.error(`[documentStore] upload failed: ${res.status} ${detail}`);
      return { ok: false, reason: res.status === 403 ? 'forbidden' : 'upload_failed', detail };
    }

    const item = await res.json();
    return {
      ok: true,
      webUrl: item.webUrl || null,
      name: item.name,
      // The path the nightly sync will index this under. Stored with the
      // knowledge so the provisional copy can retire when the sync catches up.
      syncPath: `sharepoint/${library || cfg.SHAREPOINT_LIBRARY}/${cleanFolder ? `${cleanFolder}/` : ''}${item.name}`,
    };
  } catch (err) {
    console.error('[documentStore] upload failed:', err?.message || err);
    return { ok: false, reason: 'error' };
  }
}

export async function deliverDocument(file, env, cfg) {
  if (!graphConfigured(env, cfg)) {
    return { delivered: false, reason: 'not_configured' };
  }

  if (!cfg.SHAREPOINT_GENERATED_FOLDER) {
    // Uploading to the library root would drop generated files among the
    // curated collateral the sync reads, and the assistant would start
    // quoting its own output back as source material.
    return { delivered: false, reason: 'no_generated_folder' };
  }

  if (file.bytes.byteLength > cfg.MAX_DOCUMENT_BYTES) {
    return { delivered: false, reason: 'too_large' };
  }

  try {
    const token = await getToken(env);
    const driveId = await resolveDrive(token, cfg);
    const path = encodePath([cfg.SHAREPOINT_GENERATED_FOLDER, file.fileName]);

    // @microsoft.graph.conflictBehavior=rename: two reps generating the same
    // brief in the same day must not silently overwrite each other.
    const res = await fetch(
      `${GRAPH}/drives/${driveId}/root:/${path}:/content?@microsoft.graph.conflictBehavior=rename`,
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': file.contentType },
        body: file.bytes,
      },
    );

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      console.error(`[documentStore] upload failed: ${res.status} ${detail}`);
      return { delivered: false, reason: res.status === 403 ? 'forbidden' : 'upload_failed' };
    }

    const item = await res.json();
    return { delivered: true, webUrl: item.webUrl || null, name: item.name };
  } catch (err) {
    console.error('[documentStore] delivery failed:', err?.message || err);
    return { delivered: false, reason: 'error' };
  }
}

/** Whether SharePoint delivery is wired up. Surfaced by GET /health. */
export function documentStoreStatus(env, cfg) {
  return {
    configured: graphConfigured(env, cfg),
    site: cfg.SHAREPOINT_HOSTNAME ? `${cfg.SHAREPOINT_HOSTNAME}${cfg.SHAREPOINT_SITE_PATH}` : null,
    addressedById: Boolean(cfg.SHAREPOINT_SITE_ID),
    library: cfg.SHAREPOINT_LIBRARY,
    folder: cfg.SHAREPOINT_GENERATED_FOLDER,
  };
}

/** Test seam: the caches are per-isolate and must not leak between tests. */
export function resetCaches() {
  tokenCache = null;
  driveCache = null;
}
