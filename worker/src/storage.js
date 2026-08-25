/**
 * storage.js — the ONLY module that touches a persistence binding.
 *
 * Forward-compatibility rule 1: leads, sessions, logs and rate-limit counters
 * all go through this narrow interface. Tier A implements it on Cloudflare KV.
 * Tier B (B2) reimplements the same interface on D1 — callers do not change.
 *
 * Enforced by test/no-direct-bindings.test.js, which greps the source tree for
 * `env.VIKAT_KV` outside this file.
 *
 * KV key layout (Tier A):
 *   lead:<isoTimestamp>:<leadId>     -> Lead JSON
 *   session:<sessionId>              -> Session JSON
 *   log:<sessionId>:<isoTimestamp>   -> LogEntry JSON
 *   rate:<bucketKey>                 -> { count, resetAt }
 *   kb:<entryId>                     -> KnowledgeEntry JSON   (admin-authored)
 *   user:<emailLower>                -> UserRecord JSON       (role grants)
 *   setting:<key>                    -> arbitrary JSON        (admin settings)
 *
 * Timestamp-prefixed keys keep `list({ prefix })` naturally ordered for the
 * weekly transcript review.
 */

/**
 * @typedef {object} Lead
 * @property {string} [name]
 * @property {string} [email]
 * @property {string} [company]
 * @property {string} [role]
 * @property {string} [use_case]
 * @property {string} [timeline]
 * @property {'HOT'|'WARM'|'COLD'} [qualification_score]
 * @property {string} [qualification_notes]
 * @property {string} [sessionId]
 * @property {string} [source]
 */

/**
 * @typedef {object} LogEntry
 * @property {string} sessionId
 * @property {string} timestamp
 * @property {string} userMessage
 * @property {string} agentResponse
 * @property {Array<{name: string, input: object}>} toolCalls
 */

/**
 * @typedef {object} Storage
 * @property {(lead: Lead) => Promise<{id: string}>} saveLead
 * @property {(limit?: number) => Promise<Lead[]>} listLeads
 * @property {(sessionId: string) => Promise<object|null>} getSession
 * @property {(sessionId: string, data: object) => Promise<void>} saveSession
 * @property {(entry: LogEntry) => Promise<void>} appendLog
 * @property {(sessionId: string) => Promise<LogEntry[]>} getLogs
 * @property {(key: string, limit: number, windowSeconds: number) => Promise<{allowed: boolean, remaining: number, resetAt: number}>} checkRateLimit
 * @property {() => Promise<KnowledgeEntry[]>} listKnowledge
 * @property {(id: string) => Promise<KnowledgeEntry|null>} getKnowledge
 * @property {(entry: object, actor: string) => Promise<KnowledgeEntry>} saveKnowledge
 * @property {(id: string) => Promise<boolean>} deleteKnowledge
 * @property {() => Promise<UserRecord[]>} listUsers
 * @property {(email: string) => Promise<UserRecord|null>} getUser
 * @property {(email: string, role: string, actor: string) => Promise<UserRecord>} saveUser
 * @property {(email: string) => Promise<boolean>} deleteUser
 * @property {(key: string) => Promise<object|null>} getSetting
 * @property {(key: string, value: object, actor: string) => Promise<object>} saveSetting
 * @property {(doc: GeneratedDocument) => Promise<string>} saveDocument
 * @property {(id: string) => Promise<GeneratedDocument|null>} getDocument
 */

/**
 * @typedef {object} GeneratedDocument
 * @property {string} [id]
 * @property {string} fileName
 * @property {string} contentType
 * @property {Uint8Array|ArrayBuffer} bytes
 * @property {string} title
 * @property {string} disclosure
 * @property {string} createdBy
 * @property {string} [createdAt]
 */

/**
 * @typedef {object} KnowledgeEntry
 * @property {string} id
 * @property {string} section     Short title, shown to the model as the heading.
 * @property {string} content     The material itself.
 * @property {'approved'|'draft'} status
 * @property {string} [notes]     Why this exists; not sent to the model.
 * @property {string} createdBy
 * @property {string} updatedBy
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {object} UserRecord
 * @property {string} email
 * @property {'admin'|'rep'|'denied'} role
 * @property {string} grantedBy
 * @property {string} updatedAt
 */

/** Namespaced random id. crypto.randomUUID is available in Workers. */
function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/**
 * Build the Tier A KV-backed storage implementation.
 *
 * @param {{ VIKAT_KV: KVNamespace }} env  Worker environment bindings.
 * @param {ReturnType<import('./config.js').loadConfig>} cfg
 * @returns {Storage}
 */
export function createStorage(env, cfg) {
  const kv = env.VIKAT_KV;
  if (!kv) throw new Error('storage: VIKAT_KV binding is missing. Check wrangler.toml.');

  return {
    async saveLead(lead) {
      const id = newId('lead');
      const record = { id, createdAt: new Date().toISOString(), ...lead };
      await kv.put(`lead:${record.createdAt}:${id}`, JSON.stringify(record), {
        expirationTtl: cfg.LEAD_TTL_SECONDS,
      });
      return { id };
    },

    async listLeads(limit = 100) {
      const { keys } = await kv.list({ prefix: 'lead:', limit });
      const out = [];
      for (const k of keys) {
        const v = await kv.get(k.name, 'json');
        if (v) out.push(v);
      }
      // list() returns ascending; newest first is more useful for review.
      return out.reverse();
    },

    async getSession(sessionId) {
      return kv.get(`session:${sessionId}`, 'json');
    },

    async saveSession(sessionId, data) {
      await kv.put(`session:${sessionId}`, JSON.stringify(data), {
        expirationTtl: cfg.SESSION_TTL_SECONDS,
      });
    },

    async appendLog(entry) {
      const timestamp = entry.timestamp || new Date().toISOString();
      await kv.put(
        `log:${entry.sessionId}:${timestamp}`,
        JSON.stringify({ ...entry, timestamp }),
        { expirationTtl: cfg.LOG_TTL_SECONDS },
      );
    },

    async getLogs(sessionId) {
      const { keys } = await kv.list({ prefix: `log:${sessionId}:` });
      const out = [];
      for (const k of keys) {
        const v = await kv.get(k.name, 'json');
        if (v) out.push(v);
      }
      return out;
    },

    /**
     * Fixed-window counter.
     *
     * KV is eventually consistent, so a client racing requests across colos can
     * exceed the limit briefly. That is acceptable for abuse-dampening at this
     * scale; if it stops being acceptable, the fix is a Durable Object behind
     * this same method — still no caller change.
     */
    // --- Admin-authored knowledge ---------------------------------------
    //
    // Kept separate from the compiled knowledge base so an admin can add or
    // correct material without a rebuild and deploy. retrieve() merges the two.

    async listKnowledge() {
      const { keys } = await kv.list({ prefix: 'kb:' });
      const out = [];
      for (const k of keys) {
        const v = await kv.get(k.name, 'json');
        if (v) out.push(v);
      }
      return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },

    async getKnowledge(id) {
      return kv.get(`kb:${id}`, 'json');
    },

    async saveKnowledge(entry, actor) {
      const now = new Date().toISOString();
      const existing = entry.id ? await kv.get(`kb:${entry.id}`, 'json') : null;

      const record = {
        id: entry.id || newId('kb'),
        section: entry.section,
        content: entry.content,
        status: entry.status === 'approved' ? 'approved' : 'draft',
        notes: entry.notes || '',
        createdBy: existing?.createdBy || actor,
        createdAt: existing?.createdAt || now,
        updatedBy: actor,
        updatedAt: now,
      };

      // No TTL: admin-authored knowledge must not silently expire out of the
      // agent's answers months after someone wrote it.
      await kv.put(`kb:${record.id}`, JSON.stringify(record));
      return record;
    },

    async deleteKnowledge(id) {
      if (!(await kv.get(`kb:${id}`))) return false;
      await kv.delete(`kb:${id}`);
      return true;
    },

    // --- Role grants ------------------------------------------------------

    async listUsers() {
      const { keys } = await kv.list({ prefix: 'user:' });
      const out = [];
      for (const k of keys) {
        const v = await kv.get(k.name, 'json');
        if (v) out.push(v);
      }
      return out.sort((a, b) => String(a.email).localeCompare(String(b.email)));
    },

    async getUser(email) {
      return kv.get(`user:${String(email).toLowerCase()}`, 'json');
    },

    async saveUser(email, role, actor) {
      const record = {
        email: String(email).toLowerCase(),
        role,
        grantedBy: actor,
        updatedAt: new Date().toISOString(),
      };
      await kv.put(`user:${record.email}`, JSON.stringify(record));
      return record;
    },

    async deleteUser(email) {
      const key = `user:${String(email).toLowerCase()}`;
      if (!(await kv.get(key))) return false;
      await kv.delete(key);
      return true;
    },

    // --- Settings ---------------------------------------------------------

    async getSetting(key) {
      return kv.get(`setting:${key}`, 'json');
    },

    async saveSetting(key, value, actor) {
      const record = { ...value, updatedBy: actor, updatedAt: new Date().toISOString() };
      await kv.put(`setting:${key}`, JSON.stringify(record));
      return record;
    },

    /**
     * Keep a generated document so the rep can download it immediately.
     *
     * SharePoint is where the file belongs, but a Graph outage must not cost
     * a rep the deck they are about to present. This copy is the one that is
     * always there; it expires, because it is a handoff and not an archive.
     *
     * Bytes and metadata are separate keys: the metadata is small and JSON,
     * the body is not, and reading one should not pull the other.
     */
    async saveDocument(doc) {
      const id = newId('doc');
      const createdAt = doc.createdAt || new Date().toISOString();
      const ttl = cfg.DOCUMENT_TTL_SECONDS;

      await kv.put(`docbody:${id}`, doc.bytes, { expirationTtl: ttl });
      await kv.put(
        `doc:${id}`,
        JSON.stringify({
          id,
          createdAt,
          fileName: doc.fileName,
          contentType: doc.contentType,
          title: doc.title,
          disclosure: doc.disclosure,
          createdBy: doc.createdBy,
        }),
        { expirationTtl: ttl },
      );

      return id;
    },

    async getDocument(id) {
      const meta = await kv.get(`doc:${id}`, 'json');
      if (!meta) return null;

      const bytes = await kv.get(`docbody:${id}`, 'arrayBuffer');
      // Metadata without a body means the body expired first, or the write
      // was interrupted between the two puts. Either way there is no file.
      if (!bytes) return null;

      return { ...meta, bytes };
    },

    async checkRateLimit(key, limit, windowSeconds) {
      const now = Date.now();
      const kvKey = `rate:${key}`;
      const existing = await kv.get(kvKey, 'json');

      let count = 0;
      let resetAt = now + windowSeconds * 1000;

      if (existing && typeof existing.resetAt === 'number' && existing.resetAt > now) {
        count = existing.count;
        resetAt = existing.resetAt;
      }

      if (count >= limit) {
        return { allowed: false, remaining: 0, resetAt };
      }

      count += 1;
      await kv.put(kvKey, JSON.stringify({ count, resetAt }), {
        // Round up — KV rejects a TTL below 60s.
        expirationTtl: Math.max(60, Math.ceil((resetAt - now) / 1000)),
      });

      return { allowed: true, remaining: limit - count, resetAt };
    },
  };
}
