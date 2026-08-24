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
