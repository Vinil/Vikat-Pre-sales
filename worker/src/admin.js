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
import { documentStoreStatus, listLibraries, uploadDocument } from './documentStore.js';
import { ingest, SUPPORTED_EXTENSIONS } from './ingest.js';
import { retrievalStatus } from './retrieve.js';
import { collateralCount } from './collateral.js';

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
  const { storage, user, cors, cfg, env } = ctx;

  if (request.method === 'GET') {
    // Everything below is reported from something that is actually true.
    //
    // What this endpoint used to return was, on three counts, false by
    // construction. It read cfg.SHAREPOINT_CREDENTIALS_CONFIGURED, which is
    // defined in no config file and is therefore always undefined, so the
    // panel showed "not configured" no matter what was deployed. It read a KV
    // key, sharepoint_status, that nothing has ever written, so "no sync has
    // reported yet" was permanent. And it offered an editable scope that the
    // sync cannot read: the sync runs in CI from environment variables, so a
    // value saved here changed nothing while looking like it had.
    //
    // A dashboard that is confidently wrong is worse than no dashboard. It was
    // read while the sync was working perfectly and said the sync would not
    // run.
    const store = documentStoreStatus(env, cfg);
    const knowledge = retrievalStatus();

    return json(
      {
        // The scope the DEPLOYED WORKER is running with, which is the same
        // configuration the sync workflow passes. Not editable, because the
        // process that reads it does not run here.
        scope: {
          hostname: cfg.SHAREPOINT_HOSTNAME || '',
          sitePath: cfg.SHAREPOINT_SITE_PATH || '',
          library: cfg.SHAREPOINT_LIBRARY || '',
          generatedFolder: cfg.SHAREPOINT_GENERATED_FOLDER || '',
          managedBy: 'GitHub Actions repository variables (SHAREPOINT_*)',
          note: 'An unset library means every document library on the site is crawled.',
        },
        // Two different credential sets, which the old banner conflated into
        // one sentence and then got backwards.
        credentials: {
          // The Worker's own Graph credentials, used to file a generated deck
          // back into SharePoint. This one the Worker can actually see.
          documentFiling: {
            configured: store.configured,
            managedBy: 'Worker secrets (wrangler secret put GRAPH_CLIENT_SECRET)',
            affects: 'Filing generated decks and PDFs back into SharePoint. The rep still gets the download either way.',
          },
          // The sync's credentials live in CI and are invisible from here, so
          // the honest report is "cannot tell", not "not configured".
          sync: {
            configured: null,
            managedBy: 'GitHub Actions secrets (GRAPH_CLIENT_SECRET)',
            affects: 'The nightly knowledge sync, which runs in CI. This Worker cannot see those secrets, so their state is reported by the workflow run, not here.',
          },
        },
        // What the deployed bundle actually knows — compiled in at build time
        // by scripts/build-knowledge.js. This is a better answer than a CI job
        // status: it describes the knowledge this Worker is serving right now.
        lastSync: {
          syncedAt: knowledge.sharePointSyncedAt,
          sharePointChunks: knowledge.sharePointChunks,
          collateralDocuments: collateralCount(),
          totalChunks: knowledge.chunks,
        },
      },
      200,
      cors,
    );
  }

  if (request.method === 'PUT') {
    // The scope is not editable here, and pretending otherwise was the bug.
    //
    // This used to validate a hostname, a site path and a library, save them
    // to KV, and answer "Applies on the next sync run." It does not: the sync
    // runs in GitHub Actions and reads SHAREPOINT_* environment variables, so
    // nothing has ever read that KV key. Someone correcting a scope here would
    // have watched the next sync ignore them, with no error to explain it.
    //
    // 409 rather than 405: the request is well-formed and the route exists,
    // it is the state of the world that makes it impossible.
    return json(
      {
        error: 'The sync scope is not editable here.',
        detail:
          'The nightly sync runs in GitHub Actions and reads SHAREPOINT_HOSTNAME, ' +
          'SHAREPOINT_SITE_PATH, SHAREPOINT_LIBRARY and SHAREPOINT_FOLDER from the ' +
          'repository variables. Change them there (Settings → Secrets and variables → ' +
          'Actions → Variables) and re-run the "Sync knowledge base" workflow.',
      },
      409,
      cors,
    );
  }

  return json({ error: 'Method not allowed.' }, 405, cors);
}

// --- Upload ---------------------------------------------------------------

/** The content types Graph should store these under. */
const UPLOAD_TYPES = {
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
};

const extensionOf = (name) => {
  const dot = String(name).lastIndexOf('.');
  return dot === -1 ? '' : String(name).slice(dot).toLowerCase();
};

/**
 * Take a document an admin uploaded and make it part of what the assistant
 * knows, then file it where the collateral lives.
 *
 * The order matters and is the opposite of the obvious one: the knowledge is
 * saved BEFORE the SharePoint upload is attempted. Graph being down should
 * cost the filing, not the reason the admin uploaded the thing. The response
 * says plainly which of the two happened.
 */
async function handleUpload(request, url, ctx) {
  const { storage, user, cors, cfg, env } = ctx;

  if (request.method === 'GET') {
    // Where an upload can go. Answered from Graph, so it is the real list of
    // libraries rather than a guess the admin has to match by hand.
    const { ok, libraries, reason } = await listLibraries(env, cfg);
    return json(
      {
        libraries,
        defaultLibrary: cfg.SHAREPOINT_LIBRARY,
        accepts: SUPPORTED_EXTENSIONS,
        maxBytes: cfg.MAX_DOCUMENT_BYTES,
        // A folder the sync skips on purpose; offering it would be offering to
        // file curated collateral where nothing reads it.
        reservedFolder: cfg.SHAREPOINT_GENERATED_FOLDER,
        sharePoint: ok ? 'ready' : reason,
        // Whether a PDF will be read by the model, and so whether uploading
        // one costs anything. The panel says so before the upload, not after.
        pdfReader: cfg.PDF_READER === 'bytes' || !env.ANTHROPIC_API_KEY ? 'bytes' : 'model',
      },
      200,
      cors,
    );
  }

  if (request.method !== 'POST') {
    return json({ error: 'Use POST.', code: 'method_not_allowed' }, 405, cors);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'Send the file as multipart/form-data.' }, 400, cors);
  }

  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') {
    return json({ error: 'No file was attached.' }, 400, cors);
  }

  const fileName = clean(file.name || 'upload').slice(0, 180);
  const extension = extensionOf(fileName);

  if (!SUPPORTED_EXTENSIONS.includes(extension)) {
    return json(
      { error: `${extension || 'That file'} cannot be read. Accepted: ${SUPPORTED_EXTENSIONS.join(', ')}.` },
      400,
      cors,
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > cfg.MAX_DOCUMENT_BYTES) {
    return json(
      {
        error: `${fileName} is ${Math.round(bytes.byteLength / 1024)}KB; the limit is ${Math.round(cfg.MAX_DOCUMENT_BYTES / 1024)}KB.`,
      },
      413,
      cors,
    );
  }

  // Read it first. A file whose text cannot be extracted must not be filed
  // anywhere: it would sit in SharePoint looking indexed and teach the
  // assistant nothing, which is worse than a refused upload.
  // A PDF is read by the model rather than by parsing its bytes, so this
  // spends tokens — see pdfText.js. The usage comes back and is reported.
  const read = await ingest(bytes, fileName, { env, cfg });
  if (!read.ok) return json({ error: read.error, warnings: read.warnings }, 422, cors);

  const library = clean(form.get('library') || cfg.SHAREPOINT_LIBRARY).slice(0, 120);
  const folder = clean(form.get('folder') || '').slice(0, 200);

  const filed = await uploadDocument(
    { fileName, bytes, contentType: UPLOAD_TYPES[extension] || 'application/octet-stream' },
    { library, folder },
    env,
    cfg,
  );

  // One knowledge entry per chunk, tagged with where the sync will eventually
  // find the same file. retrieve() drops a tagged entry once the compiled base
  // carries that path, so the provisional copy retires by itself rather than
  // needing a cleanup job — and the document never exists twice.
  const saved = [];
  for (const [i, chunk] of read.chunks.entries()) {
    saved.push(
      await storage.saveKnowledge(
        {
          section: `${fileName} — ${chunk.section}`,
          content: chunk.content,
          status: 'approved',
          notes: `Uploaded by ${user.email}`,
          sourcePath: filed.ok ? filed.syncPath : null,
          uploadName: fileName,
          uploadWebUrl: filed.ok ? filed.webUrl : null,
          uploadFolder: folder,
          uploadIndex: i,
        },
        user.email,
      ),
    );
  }

  return json(
    {
      fileName,
      chunks: saved.length,
      warnings: read.warnings,
      filed: filed.ok,
      webUrl: filed.ok ? filed.webUrl : null,
      // What read it, and what that cost. Said rather than hidden: this is the
      // one upload path that spends model tokens.
      reader: read.reader,
      usage: read.usage || null,
      // Said plainly rather than implied: the assistant knows it either way,
      // and whether it also reached SharePoint is a separate fact.
      note: filed.ok
        ? `Added to the assistant's knowledge and filed in ${library}${folder ? `/${folder}` : ''}.`
        : `Added to the assistant's knowledge. NOT filed in SharePoint (${filed.reason}) — it will not appear in Collateral for other people until it is.`,
    },
    200,
    cors,
  );
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
    case '/admin/upload':
      return handleUpload(request, url, ctx);
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
