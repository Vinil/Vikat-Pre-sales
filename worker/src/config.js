/**
 * config.js — every tunable in one place.
 *
 * Forward-compatibility rule 4: no endpoint URLs, origins, model names, limits
 * or booking links are hardcoded anywhere else in the codebase. Values here are
 * defaults; anything an operator may want to change per-environment is read
 * from `env` (wrangler.toml [vars] or `wrangler secret`) with the default as a
 * fallback.
 *
 * Secrets are NEVER defaulted here — ANTHROPIC_API_KEY is read straight from
 * `env` at the call site and must be set via `wrangler secret put`.
 */

/** Static defaults. Overridable per-environment via wrangler.toml [vars]. */
export const DEFAULTS = {
  // --- Model -------------------------------------------------------------
  // Pinned by spec. Swappable without a code change via the MODEL var.
  MODEL: 'claude-sonnet-4-6',
  MAX_TOKENS: 1024,

  // --- Request validation ------------------------------------------------
  MAX_MESSAGES_PER_SESSION: 30,
  MAX_CHARS_PER_MESSAGE: 2000,

  // --- Rate limiting (per IP) --------------------------------------------
  RATE_LIMIT_REQUESTS: 20,
  RATE_LIMIT_WINDOW_SECONDS: 600, // 10 minutes

  // --- CORS --------------------------------------------------------------
  // Comma-separated in wrangler.toml; parsed to an array by loadConfig().
  ALLOWED_ORIGINS: [
    'https://vikat.ai',
    'https://www.vikat.ai',
    'http://localhost:8788',
    'http://localhost:3000',
    'http://127.0.0.1:8788',
  ],

  // --- Lead delivery -----------------------------------------------------
  // 'mailchannels' | 'webhook' | 'none'
  //   mailchannels — the Tier A default per spec. NOTE: MailChannels ended its
  //     free Cloudflare Workers tier; an account + DKIM setup is required for
  //     delivery to succeed. See README "Lead delivery".
  //   webhook — POSTs the lead JSON to LEAD_WEBHOOK_URL (Zapier/Make/n8n/etc).
  //     No new vendor relationship required beyond whatever the operator picks.
  //   none — log only. Useful for local dev and CI.
  LEAD_SINK: 'mailchannels',
  LEAD_TO_EMAIL: 'contact@vikat.ai',
  LEAD_TO_NAME: 'Vikat Sales',
  LEAD_FROM_EMAIL: 'agent@vikat.ai',
  LEAD_FROM_NAME: 'Vikat Pre-Sales Agent',
  LEAD_WEBHOOK_URL: '', // only used when LEAD_SINK === 'webhook'

  // --- Booking -----------------------------------------------------------
  BOOKING_URL: 'https://vikat.ai/contact',
  CONTACT_EMAIL: 'contact@vikat.ai',

  // --- Retention ---------------------------------------------------------
  LOG_TTL_SECONDS: 60 * 60 * 24 * 90, // 90 days
  LEAD_TTL_SECONDS: 60 * 60 * 24 * 365, // 1 year
  SESSION_TTL_SECONDS: 60 * 60 * 24 * 30, // 30 days

  // --- Agent loop --------------------------------------------------------
  // Cap on tool round-trips within a single /chat turn. Guards against a
  // pathological loop burning tokens.
  MAX_TOOL_ITERATIONS: 4,
};

const NUMERIC_KEYS = new Set([
  'MAX_TOKENS',
  'MAX_MESSAGES_PER_SESSION',
  'MAX_CHARS_PER_MESSAGE',
  'RATE_LIMIT_REQUESTS',
  'RATE_LIMIT_WINDOW_SECONDS',
  'LOG_TTL_SECONDS',
  'LEAD_TTL_SECONDS',
  'SESSION_TTL_SECONDS',
  'MAX_TOOL_ITERATIONS',
]);

/**
 * Merge environment overrides onto DEFAULTS.
 *
 * Every key in DEFAULTS may be overridden by a same-named var in `env`.
 * Numeric keys are coerced; ALLOWED_ORIGINS accepts a comma-separated string.
 *
 * @param {Record<string, unknown>} env Worker environment bindings.
 * @returns {typeof DEFAULTS} Effective config.
 */
export function loadConfig(env = {}) {
  const cfg = { ...DEFAULTS };

  for (const key of Object.keys(DEFAULTS)) {
    const raw = env[key];
    if (raw === undefined || raw === null || raw === '') continue;

    if (key === 'ALLOWED_ORIGINS') {
      cfg[key] = Array.isArray(raw)
        ? raw
        : String(raw)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
      continue;
    }

    if (NUMERIC_KEYS.has(key)) {
      const n = Number(raw);
      if (Number.isFinite(n)) cfg[key] = n;
      continue;
    }

    cfg[key] = raw;
  }

  return cfg;
}
