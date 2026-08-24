/**
 * leadSink.js — the ONLY module that delivers a lead anywhere outbound.
 *
 * Forward-compatibility rule 3: every lead and every escalation leaves through
 * `deliverLead(payload, env, cfg)`. Tier A emails. Tier B (B3) adds a HubSpot
 * call alongside the email behind the same call. No caller learns the difference.
 *
 * Enforced by test/no-direct-bindings.test.js, which greps for MailChannels
 * and mail-send URLs outside this file.
 */

const MAILCHANNELS_URL = 'https://api.mailchannels.net/tx/v1/send';

/**
 * @typedef {object} LeadPayload
 * @property {'lead'|'meeting'|'escalation'} kind
 * @property {boolean} [urgent]
 * @property {string} sessionId
 * @property {Record<string, unknown>} data     Tool input, as the agent supplied it.
 * @property {string} [summary]
 */

/** Basic HTML escaping for the email body. */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function subjectFor(payload) {
  const d = payload.data || {};
  const who = d.name || d.email || 'Unknown prospect';
  const company = d.company ? ` (${d.company})` : '';

  switch (payload.kind) {
    case 'escalation':
      return `URGENT — Vikat agent escalation: ${d.reason || 'unspecified'}`;
    case 'meeting':
      return `Meeting request — ${who}${company}`;
    default: {
      const score = d.qualification_score ? `[${d.qualification_score}] ` : '';
      return `${score}New Vikat lead — ${who}${company}`;
    }
  }
}

function bodyFor(payload) {
  const rows = Object.entries(payload.data || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;vertical-align:top;color:#666">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`)
    .join('\n');

  const banner = payload.urgent
    ? '<p style="background:#7f1d1d;color:#fff;padding:8px 12px;margin:0 0 16px;font-weight:600">URGENT — needs a human</p>'
    : '';

  const summary = payload.summary
    ? `<h3 style="margin:20px 0 6px">Conversation summary</h3><p style="white-space:pre-wrap;margin:0">${esc(payload.summary)}</p>`
    : '';

  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;color:#111">
${banner}
<h2 style="margin:0 0 12px">${esc(subjectFor(payload))}</h2>
<table style="border-collapse:collapse">${rows}</table>
${summary}
<hr style="margin:24px 0;border:0;border-top:1px solid #ddd">
<p style="color:#666;font-size:12px;margin:0">Session <code>${esc(payload.sessionId)}</code> · ${esc(new Date().toISOString())}<br>
Sent by the Vikat pre-sales agent. Transcript is in KV under <code>log:${esc(payload.sessionId)}:*</code>.</p>
</body></html>`;

  const text = [
    payload.urgent ? 'URGENT — needs a human' : '',
    subjectFor(payload),
    '',
    ...Object.entries(payload.data || {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}: ${v}`),
    payload.summary ? `\nConversation summary:\n${payload.summary}` : '',
    '',
    `Session ${payload.sessionId} · ${new Date().toISOString()}`,
  ]
    .filter(Boolean)
    .join('\n');

  return { html, text };
}

/**
 * Tier A default: MailChannels transactional send.
 *
 * NOTE FOR OPERATORS: MailChannels ended its free Cloudflare Workers tier in
 * June 2024. This path needs a MailChannels account plus a DKIM key and a
 * `_mailchannels` TXT record on the sending domain, or the send returns 4xx.
 * If that is not wanted, set LEAD_SINK to 'webhook' — see config.js.
 */
async function sendViaMailChannels(payload, env, cfg) {
  const { html, text } = bodyFor(payload);

  /** @type {Record<string, unknown>} */
  const body = {
    personalizations: [{ to: [{ email: cfg.LEAD_TO_EMAIL, name: cfg.LEAD_TO_NAME }] }],
    from: { email: cfg.LEAD_FROM_EMAIL, name: cfg.LEAD_FROM_NAME },
    subject: subjectFor(payload),
    content: [
      { type: 'text/plain', value: text },
      { type: 'text/html', value: html },
    ],
  };

  // Reply straight to the prospect when they gave an address.
  const replyTo = payload.data?.email;
  if (typeof replyTo === 'string' && replyTo.includes('@')) {
    body.reply_to = { email: replyTo, name: payload.data?.name || replyTo };
  }

  // DKIM is optional in the request shape but required in practice for
  // deliverability. Configured as secrets, so absent in dev.
  if (env.DKIM_PRIVATE_KEY && env.DKIM_DOMAIN) {
    body.personalizations[0].dkim_domain = env.DKIM_DOMAIN;
    body.personalizations[0].dkim_selector = env.DKIM_SELECTOR || 'mailchannels';
    body.personalizations[0].dkim_private_key = env.DKIM_PRIVATE_KEY;
  }

  const res = await fetch(MAILCHANNELS_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(env.MAILCHANNELS_API_KEY ? { 'X-Api-Key': env.MAILCHANNELS_API_KEY } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`MailChannels ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

/**
 * Vendor-neutral alternative: POST the lead JSON wherever the operator wants
 * (Zapier, Make, n8n, an internal endpoint). Introduces no new dependency the
 * operator has not already chosen.
 */
async function sendViaWebhook(payload, env, cfg) {
  const url = cfg.LEAD_WEBHOOK_URL;
  if (!url) throw new Error('leadSink: LEAD_SINK is "webhook" but LEAD_WEBHOOK_URL is unset.');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(env.LEAD_WEBHOOK_TOKEN ? { authorization: `Bearer ${env.LEAD_WEBHOOK_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      kind: payload.kind,
      urgent: Boolean(payload.urgent),
      sessionId: payload.sessionId,
      subject: subjectFor(payload),
      summary: payload.summary || null,
      ...payload.data,
      receivedAt: new Date().toISOString(),
    }),
  });

  if (!res.ok) {
    throw new Error(`Lead webhook ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

/**
 * Deliver a lead, meeting request or escalation.
 *
 * Never throws: a delivery failure must not break the prospect's conversation.
 * The outcome is returned so the caller can log it, and a failure is always
 * recoverable from the KV copy written by storage.saveLead().
 *
 * @param {LeadPayload} payload
 * @param {Record<string, unknown>} env
 * @param {ReturnType<import('./config.js').loadConfig>} cfg
 * @returns {Promise<{ delivered: boolean, channel: string, error?: string }>}
 */
export async function deliverLead(payload, env, cfg) {
  const channel = cfg.LEAD_SINK;

  try {
    switch (channel) {
      case 'mailchannels':
        await sendViaMailChannels(payload, env, cfg);
        break;
      case 'webhook':
        await sendViaWebhook(payload, env, cfg);
        break;
      case 'none':
        console.log('[leadSink] delivery disabled (LEAD_SINK=none)', subjectFor(payload));
        break;
      default:
        throw new Error(`leadSink: unknown LEAD_SINK "${channel}"`);
    }
    return { delivered: channel !== 'none', channel };
  } catch (err) {
    // Logged, not thrown. storage.saveLead() already has the durable copy.
    console.error('[leadSink] delivery failed:', err?.message || err);
    return { delivered: false, channel, error: String(err?.message || err) };
  }
}
