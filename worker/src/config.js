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
 *
 * AUDIENCE: this agent is internal to Vikat. It answers sales reps from
 * material that is not cleared for customers. Defaults here are chosen for a
 * closed, authenticated tool, not a public website widget.
 */

/** Static defaults. Overridable per-environment via wrangler.toml [vars]. */
export const DEFAULTS = {
  // --- Model -------------------------------------------------------------
  MODEL: 'claude-sonnet-4-6',
  // Reps ask for briefs and objection handling, which need more room than a
  // two-sentence answer to a prospect did.
  MAX_TOKENS: 2048,

  // --- Authentication ----------------------------------------------------
  // 'cf-access' | 'entra' | 'dev'
  AUTH_MODE: 'cf-access',
  CF_ACCESS_TEAM_DOMAIN: '', // e.g. vikat.cloudflareaccess.com
  CF_ACCESS_AUD: '', // Application Audience tag from the Access app
  ENTRA_TENANT_ID: '',
  ENTRA_AUDIENCE: '',
  // Second gate behind SSO. Empty list disables the check.
  ALLOWED_EMAIL_DOMAINS: ['vikat.ai'],
  // Must be explicitly true for AUTH_MODE=dev to function. Never set in prod.
  ALLOW_DEV_AUTH: false,

  // --- Request validation ------------------------------------------------
  // Reps hold longer working sessions than prospects did, and paste in
  // prospect emails and RFP excerpts to ask about.
  MAX_MESSAGES_PER_SESSION: 100,
  MAX_CHARS_PER_MESSAGE: 8000,

  // --- Rate limiting (per authenticated user) ----------------------------
  // Abuse is not the threat model here; a runaway client loop is. Set high
  // enough that a working rep never sees it.
  RATE_LIMIT_REQUESTS: 120,
  RATE_LIMIT_WINDOW_SECONDS: 600, // 10 minutes

  // --- CORS --------------------------------------------------------------
  // Internal hosts only. Comma-separated in wrangler.toml.
  ALLOWED_ORIGINS: [
    'https://sales.vikat.ai',
    'http://localhost:8788',
    'http://127.0.0.1:8788',
  ],

  // --- Notification sink -------------------------------------------------
  // Where logged prospects, expert requests and content gaps are delivered.
  // 'mailchannels' | 'webhook' | 'none'
  //   mailchannels — NOTE: MailChannels ended its free Cloudflare Workers tier
  //     in June 2024. Requires an account plus DKIM setup on the sending domain.
  //   webhook — POSTs JSON to LEAD_WEBHOOK_URL (Teams/Slack/Zapier/internal).
  //     For an internal tool a Teams incoming webhook is usually the best fit.
  //   none — log only. Local dev and CI.
  LEAD_SINK: 'webhook',
  LEAD_TO_EMAIL: 'sales@vikat.ai',
  LEAD_TO_NAME: 'Vikat Sales',
  LEAD_FROM_EMAIL: 'agent@vikat.ai',
  LEAD_FROM_NAME: 'Vikat Sales Assistant',
  LEAD_WEBHOOK_URL: '',
  // Where content gaps go, so the knowledge owner sees them.
  CONTENT_OWNER_EMAIL: 'marketing@vikat.ai',

  // --- Links -------------------------------------------------------------
  BOOKING_URL: 'https://vikat.ai/contact',
  CONTACT_EMAIL: 'sales@vikat.ai',
  // Where a rep goes when the agent cannot help.
  INTERNAL_HELP_CHANNEL: '#sales-help',

  // --- Retention ---------------------------------------------------------
  LOG_TTL_SECONDS: 60 * 60 * 24 * 90, // 90 days
  LEAD_TTL_SECONDS: 60 * 60 * 24 * 365, // 1 year
  SESSION_TTL_SECONDS: 60 * 60 * 24 * 30, // 30 days

  // --- Agent loop --------------------------------------------------------
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

const BOOLEAN_KEYS = new Set(['ALLOW_DEV_AUTH']);

const LIST_KEYS = new Set(['ALLOWED_ORIGINS', 'ALLOWED_EMAIL_DOMAINS']);

/**
 * Merge environment overrides onto DEFAULTS.
 *
 * Every key in DEFAULTS may be overridden by a same-named var in `env`.
 * Numeric keys are coerced; list keys accept a comma-separated string;
 * booleans accept only the exact string "true".
 *
 * @param {Record<string, unknown>} env Worker environment bindings.
 * @returns {typeof DEFAULTS} Effective config.
 */
export function loadConfig(env = {}) {
  const cfg = { ...DEFAULTS };

  for (const key of Object.keys(DEFAULTS)) {
    const raw = env[key];
    if (raw === undefined || raw === null || raw === '') continue;

    if (LIST_KEYS.has(key)) {
      cfg[key] = Array.isArray(raw)
        ? raw
        : String(raw)
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
      continue;
    }

    if (BOOLEAN_KEYS.has(key)) {
      // Anything other than an explicit "true" leaves the safe default in place.
      cfg[key] = raw === true || raw === 'true';
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
