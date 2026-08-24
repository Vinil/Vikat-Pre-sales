/** Shared test doubles. */

/** In-memory KV stand-in covering the surface storage.js uses. */
export function fakeKV() {
  const store = new Map();
  return {
    _store: store,
    async get(key, type) {
      if (!store.has(key)) return null;
      const raw = store.get(key);
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort()
        .slice(0, limit)
        .map((name) => ({ name }));
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

/** Minimal Request stand-in for corsHeaders tests. */
export function req(headers = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: { get: (k) => map.get(k.toLowerCase()) ?? null } };
}
