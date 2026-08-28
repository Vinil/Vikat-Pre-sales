/** Shared test doubles. */

/** In-memory KV stand-in covering the surface storage.js uses. */
export function fakeKV() {
  // { value, metadata } per key. Workers KV returns metadata from list()
  // WITHOUT a read per key, which is the whole reason the chat index can be
  // listed cheaply — a fake that dropped it would have made the index look
  // affordable here and cost one KV read per chat in production.
  const store = new Map();
  return {
    _store: store,
    /** Seed a raw stored value, without going through put(). */
    _seed(key, raw) { store.set(key, { value: raw, metadata: null }); },
    /** The raw stored string, so a test need not know the record shape. */
    _raw(key) { return store.has(key) ? store.get(key).value : undefined; },
    async get(key, type) {
      if (!store.has(key)) return null;
      const raw = store.get(key).value;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async getWithMetadata(key, type) {
      if (!store.has(key)) return { value: null, metadata: null };
      const entry = store.get(key);
      return {
        value: type === 'json' ? JSON.parse(entry.value) : entry.value,
        metadata: entry.metadata || null,
      };
    },
    async put(key, value, options = {}) {
      store.set(key, { value, metadata: options.metadata || null });
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort()
        .slice(0, limit)
        .map((name) => ({ name, metadata: store.get(name).metadata || undefined }));
      return { keys, list_complete: true };
    },
  };
}

/** Captures fetch calls and returns a canned response. */
export function stubFetch({ ok = true, status = 200, body = '' } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok, status, text: async () => body };
  };
  fn.calls = calls;
  return fn;
}

/** Storage double recording every call, for tool tests. */
export function fakeStorage() {
  const leads = [];
  const logs = [];
  return {
    leads,
    logs,
    async saveLead(lead) {
      leads.push(lead);
      return { id: `lead_test_${leads.length}` };
    },
    async listLeads() {
      return leads;
    },
    async getSession() {
      return null;
    },
    async saveSession() {},
    async appendLog(e) {
      logs.push(e);
    },
    async getLogs() {
      return logs;
    },
    async checkRateLimit() {
      return { allowed: true, remaining: 99, resetAt: Date.now() + 60000 };
    },
  };
}

/**
 * Minimal Request stand-in for corsHeaders tests.
 *
 * `url` matters: corsHeaders compares the Origin against the request's own
 * host to detect same-origin, so a test double without a url cannot exercise
 * that path.
 */
export function req(headers = {}, url = 'https://sales.vikat.ai/chat') {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { url, headers: { get: (k) => map.get(k.toLowerCase()) ?? null } };
}
