/**
 * admin.js — admin panel API.
 *
 * Every route here requires the `admin` role (checked by the caller in
 * index.js before dispatch). All persistence goes through storage.js.
 *
 * Three areas:
 *   /admin/knowledge   Add, edit and remove material the agent answers from.
 *   /admin/sharepoint  Configure WHERE the sync reads. Not the credentials —
 *                      see the note on that handler.
 *   /admin/users       Grant and revoke roles over IdP-authenticated people.
 *                      This is authorization, not authentication: it never
 *                      creates a login.
 */

import { ROLES, resolveRole, wouldLeaveNoAdmin } from './roles.js';

const MAX_SECTION_CHARS = 200;
const MAX_CONTENT_CHARS = 20000;
const MAX_KNOWLEDGE_ENTRIES = 500;

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/** Strip markup so admin-authored text cannot inject structure into the prompt. */
function clean(text) {
  return String(text ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\uFEFF]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function isEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

// --- Knowledge ------------------------------------------------------------

async function handleKnowledge(request, url, ctx) {
  const { storage, user, cors } = ctx;

  if (request.method === 'GET') {
    return json({ entries: await storage.listKnowledge() }, 200, cors);
  }

  if (request.method === 'POST' || request.method === 'PUT') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON.' }, 400, cors);
    }

    const section = clean(body.section);
    const content = clean(body.content);

    if (!section) return json({ error: 'A title is required.' }, 400, cors);
    if (!content) return json({ error: 'Content is required.' }, 400, cors);
    if (section.length > MAX_SECTION_CHARS) {
      return json({ error: `Title is limited to ${MAX_SECTION_CHARS} characters.` }, 400, cors);
    }
    if (content.length > MAX_CONTENT_CHARS) {
      return json({ error: `Content is limited to ${MAX_CONTENT_CHARS} characters.` }, 400, cors);
    }
    if (body.status && !['approved', 'draft'].includes(body.status)) {
      return json({ error: 'Status must be approved or draft.' }, 400, cors);
    }

    // Every approved entry is injected into every prompt, so an unbounded
    // list is a slow, invisible way to blow up cost and latency.
    if (!body.id) {
      const existing = await storage.listKnowledge();
      if (existing.length >= MAX_KNOWLEDGE_ENTRIES) {
        return json(
          { error: `The knowledge list is full (${MAX_KNOWLEDGE_ENTRIES} entries). Remove something first.` },
          400,
          cors,
        );
      }
    }

    const entry = await storage.saveKnowledge(
      { id: body.id, section, content, status: body.status, notes: clean(body.notes) },
      user.email,
    );

    return json({ entry }, 200, cors);
  }

  if (request.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return json({ error: 'id is required.' }, 400, cors);

    const removed = await storage.deleteKnowledge(id);
    if (!removed) return json({ error: 'Not found.' }, 404, cors);
    return json({ ok: true }, 200, cors);
  }

  return json({ error: 'Method not allowed.' }, 405, cors);
}

// --- SharePoint scope -----------------------------------------------------

/**
 * The panel configures WHERE the sync reads, not the credentials it reads with.
 *
 * Two reasons, and the second is the one that settles it:
 *
 *  1. A client secret stored in KV is retrievable by anything that can reach
 *     KV. Today it lives in secret storage and cannot be read back at all.
 *     Moving it here would turn the admin panel into a single target worth
 *     compromising for tenant-wide SharePoint read access.
 *
 *  2. The sync runs in GitHub Actions, not in this Worker. A secret typed here
 *     would never reach the process that actually calls Graph.
 *
 * What genuinely changes — which site, which library, which folder — is
 * editable here, and takes effect on the next sync.
 */
async function handleSharePoint(request, url, ctx) {
  const { storage, user, cors, cfg } = ctx;

  if (request.method === 'GET') {
    const settings = (await storage.getSetting('sharepoint')) || {};
    return json(
      {
        settings: {
          hostname: settings.hostname || '',
          sitePath: settings.sitePath || '',
          library: settings.library || '',
          folder: settings.folder || '',
          updatedBy: settings.updatedBy || null,
          updatedAt: settings.updatedAt || null,
        },
        // Reported, never returned. The panel shows whether the credential is
        // configured; it cannot display or exfiltrate it.
        credentials: {
          configured: Boolean(cfg.SHAREPOINT_CREDENTIALS_CONFIGURED),
          managedBy: 'GitHub Actions secrets (GRAPH_CLIENT_SECRET)',
          note: 'Credentials are intentionally not editable here. See README, "SharePoint sync".',
        },
        lastSync: (await storage.getSetting('sharepoint_status')) || null,
      },
      200,
      cors,
    );
  }

  if (request.method === 'PUT') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON.' }, 400, cors);
    }

    const hostname = clean(body.hostname).toLowerCase();
    const sitePath = clean(body.sitePath);
    const library = clean(body.library);
    const folder = clean(body.folder);

    if (hostname && !/^[a-z0-9.-]+\.sharepoint\.com$/.test(hostname)) {
      return json({ error: 'Hostname should look like yourtenant.sharepoint.com.' }, 400, cors);
    }
    if (sitePath && !sitePath.startsWith('/')) {
      return json({ error: 'Site path should start with a slash, e.g. /sites/Sales.' }, 400, cors);
    }
    if (!library) {
      // The library is the approval boundary. Without one, the sync has no
      // safe default and refuses to run — so an empty value here is a
      // misconfiguration, not a "sync everything" instruction.
      return json({ error: 'A document library is required. It is the approval boundary for what the agent can read.' }, 400, cors);
    }

    const settings = await storage.saveSetting(
      'sharepoint',
      { hostname, sitePath, library, folder: folder.replace(/^\/+|\/+$/g, '') },
      user.email,
    );

    return json({ settings, note: 'Applies on the next sync run.' }, 200, cors);
  }

  return json({ error: 'Method not allowed.' }, 405, cors);
}

// --- Users ----------------------------------------------------------------

async function handleUsers(request, url, ctx) {
  const { storage, user, cors, cfg } = ctx;

  if (request.method === 'GET') {
    const granted = await storage.listUsers();
    const bootstrap = (cfg.BOOTSTRAP_ADMINS || []).map((e) => String(e).toLowerCase());

    // Bootstrap admins are shown so the roster reflects reality, but flagged
    // as unmanageable here — they come from config and outrank storage.
    const rows = [
      ...bootstrap.map((email) => ({
        email,
        role: 'admin',
        source: 'bootstrap',
        grantedBy: 'wrangler.toml',
        updatedAt: null,
        editable: false,
      })),
      ...granted
        .filter((u) => !bootstrap.includes(u.email))
        .map((u) => ({ ...u, source: 'grant', editable: true })),
    ];

    return json({ users: rows, defaultRole: cfg.DEFAULT_ROLE, roles: ROLES }, 200, cors);
  }

  if (request.method === 'POST' || request.method === 'PUT') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON.' }, 400, cors);
    }

    const email = String(body.email || '').trim().toLowerCase();
    const role = body.role;

    if (!isEmail(email)) return json({ error: 'A valid email address is required.' }, 400, cors);
    if (!ROLES.includes(role)) {
      return json({ error: `Role must be one of: ${ROLES.join(', ')}.` }, 400, cors);
    }

    // The domain gate in auth.js will refuse this person anyway; saying so now
    // is kinder than a grant that silently never works.
    const domain = email.split('@')[1];
    if (cfg.ALLOWED_EMAIL_DOMAINS.length && !cfg.ALLOWED_EMAIL_DOMAINS.includes(domain)) {
      return json(
        {
          error: `${email} cannot sign in: only ${cfg.ALLOWED_EMAIL_DOMAINS.join(', ')} addresses are accepted. Granting a role would have no effect.`,
        },
        400,
        cors,
      );
    }

    if (cfg.BOOTSTRAP_ADMINS.includes(email)) {
      return json(
        { error: `${email} is a bootstrap admin set in configuration and cannot be changed here.` },
        400,
        cors,
      );
    }

    if (await wouldLeaveNoAdmin(email, role, storage, cfg)) {
      return json(
        { error: 'That would remove the last administrator. Grant admin to someone else first.' },
        400,
        cors,
      );
    }

    // Losing your own admin access mid-session is a support ticket, not a
    // feature. Demoting someone else is fine.
    if (email === String(user.email).toLowerCase() && role !== 'admin') {
      return json({ error: 'You cannot remove your own admin access. Ask another admin.' }, 400, cors);
    }

    const record = await storage.saveUser(email, role, user.email);
    return json({ user: { ...record, source: 'grant', editable: true } }, 200, cors);
  }

  if (request.method === 'DELETE') {
    const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
    if (!isEmail(email)) return json({ error: 'A valid email address is required.' }, 400, cors);

    if (cfg.BOOTSTRAP_ADMINS.includes(email)) {
      return json({ error: 'Bootstrap admins are set in configuration and cannot be removed here.' }, 400, cors);
    }
    if (email === String(user.email).toLowerCase()) {
      return json({ error: 'You cannot remove your own access.' }, 400, cors);
    }

    // Removing a grant returns the person to DEFAULT_ROLE. When that is 'rep'
    // they keep using the assistant, which is usually not what "remove" meant.
    if (await wouldLeaveNoAdmin(email, cfg.DEFAULT_ROLE, storage, cfg)) {
      return json(
        { error: 'That would remove the last administrator. Grant admin to someone else first.' },
        400,
        cors,
      );
    }

    const removed = await storage.deleteUser(email);
    if (!removed) return json({ error: 'No grant found for that address.' }, 404, cors);

    return json(
      {
        ok: true,
        note:
          cfg.DEFAULT_ROLE === 'rep'
            ? 'Grant removed. They fall back to the default role and can still use the assistant. To block them, set their role to "denied" instead.'
            : 'Grant removed. They no longer have access.',
      },
      200,
      cors,
    );
  }

  return json({ error: 'Method not allowed.' }, 405, cors);
}

// --- Dispatch -------------------------------------------------------------

/**
 * Route an /admin/* request. The caller has already authenticated the user and
 * confirmed the admin role.
 *
 * @param {Request} request
 * @param {URL} url
 * @param {{ storage: object, user: object, cfg: object, cors: object, env: object }} ctx
 * @returns {Promise<Response|null>} null when the path is not an admin route.
 */
export async function handleAdmin(request, url, ctx) {
  switch (url.pathname) {
    case '/admin/knowledge':
      return handleKnowledge(request, url, ctx);
    case '/admin/sharepoint':
      return handleSharePoint(request, url, ctx);
    case '/admin/users':
      return handleUsers(request, url, ctx);
    default:
      return null;
  }
}

/** Everything the panel needs to render itself on load. */
export async function handleAdminSummary(request, ctx) {
  const { storage, user, cfg, cors } = ctx;
  const { role, source } = await resolveRole(user, storage, cfg);

  const entries = await storage.listKnowledge();

  return json(
    {
      you: { email: user.email, name: user.name, role, roleSource: source },
      knowledge: {
        total: entries.length,
        approved: entries.filter((e) => e.status === 'approved').length,
        draft: entries.filter((e) => e.status !== 'approved').length,
      },
      defaultRole: cfg.DEFAULT_ROLE,
    },
    200,
    cors,
  );
}
