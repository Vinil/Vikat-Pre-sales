/**
 * tools.js — tool definitions and handlers.
 *
 * AUDIENCE: Vikat sales reps. The prospect-facing tool set (capture_lead,
 * request_meeting, escalate) did not survive the audience change — the caller
 * is now the salesperson, not the lead. Asking a rep for their own email, or
 * handing them a booking link to their own team, is nonsense.
 *
 * What replaced them:
 *   capture_lead    -> log_prospect       the rep records a conversation they had
 *   request_meeting -> (dropped)          reps book their own meetings
 *   escalate        -> ask_expert         route to a named human owner
 *   (new)              flag_content_gap   the knowledge base is missing or stale
 *   (new)              find_collateral    the SharePoint deck or doc to send
 *
 * Every handler persists through storage.js and delivers through leadSink.js.
 * No handler touches KV or an outbound mail API directly.
 */

import { deliverLead } from './leadSink.js';
import { searchCollateral } from './collateral.js';

const SCORES = ['HOT', 'WARM', 'COLD'];

/**
 * Tool definitions sent to the Messages API.
 *
 * `strict: true` guarantees the input validates against the schema, so handlers
 * defend only against missing optional fields, not malformed shapes.
 *
 * @type {Array<object>}
 */
export const TOOL_DEFINITIONS = [
  {
    name: 'log_prospect',
    description:
      'Record a prospect conversation the rep has had, so it reaches the pipeline. Call this when the rep describes a customer or prospect interaction and wants it captured. Record what the rep tells you — do not interrogate them for missing fields, and never ask for the rep\'s own details.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prospect_name: { type: ['string', 'null'], description: 'Prospect contact name, or null.' },
        prospect_email: { type: ['string', 'null'], description: 'Prospect email, or null.' },
        company: { type: ['string', 'null'], description: 'Prospect company, or null.' },
        role: { type: ['string', 'null'], description: 'Prospect job title or role, or null.' },
        use_case: {
          type: 'string',
          description: 'What the prospect is trying to solve, as the rep described it.',
        },
        environment: {
          type: ['string', 'null'],
          description:
            'Cloud provider, security tooling, AI/agent adoption stage — whatever the rep mentioned. Null if not discussed.',
        },
        timeline: { type: ['string', 'null'], description: 'Timeline or deadline, or null.' },
        qualification_score: {
          type: 'string',
          enum: SCORES,
          description:
            'HOT: named problem + timeline under 6 months + decision involvement. WARM: real problem, vague timeline or unclear authority. COLD: research or curiosity. Base this on what the rep described, not on optimism.',
        },
        qualification_notes: {
          type: 'string',
          description:
            'Your reasoning for the score, the next step the rep named, and anything still unknown. Written so a sales manager reading the pipeline understands the state of the deal.',
        },
      },
      required: [
        'prospect_name', 'prospect_email', 'company', 'role', 'use_case',
        'environment', 'timeline', 'qualification_score', 'qualification_notes',
      ],
    },
  },
  {
    name: 'ask_expert',
    description:
      'Route a question to the human who owns it. Use for security questionnaires, RFP and RFI responses, legal redlines, deal-desk and pricing approvals, customer-reference requests, and technical depth beyond the knowledge base. Also use when the rep needs sign-off on anything you tagged [Check before sharing]. Tell the rep who you routed it to and roughly when to expect an answer.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        owner: {
          type: 'string',
          description:
            'The owning team, taken from the disclosure policy where it applies, e.g. "Deal Desk", "Security", "Legal", "Product", "Product Marketing", "Customer Marketing", "Sales Engineering".',
        },
        question: { type: 'string', description: 'The question, self-contained enough to answer without the chat.' },
        context: {
          type: 'string',
          description: 'Deal context: which customer, what stage, what the rep already told them.',
        },
        urgency: {
          type: 'string',
          enum: ['blocking_a_call', 'this_week', 'no_rush'],
          description: 'How fast the rep needs it. Use blocking_a_call only when they are mid-deal and stuck.',
        },
      },
      required: ['owner', 'question', 'context', 'urgency'],
    },
  },
  {
    name: 'flag_content_gap',
    description:
      'Report that the knowledge base could not answer something, or gave an answer the rep says is out of date. Call this instead of apologising a second time. This is the main feedback loop for improving the knowledge base, so err toward calling it.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: { type: 'string', description: 'What the rep asked that you could not answer well.' },
        gap_type: {
          type: 'string',
          enum: ['missing', 'outdated', 'contradictory', 'too_shallow'],
          description:
            'missing: nothing covers it. outdated: the rep says reality has moved on. contradictory: two sources disagree. too_shallow: covered, but not deep enough to use.',
        },
        details: {
          type: 'string',
          description:
            'What exists today, what is wrong with it, and what would have answered the question. Include the correction if the rep supplied one.',
        },
      },
      required: ['question', 'gap_type', 'details'],
    },
  },
  {
    name: 'find_collateral',
    description:
      "Find the SharePoint decks and documents behind an answer, so the rep gets a link they can send or open. Call this whenever the rep is preparing for a call, asks what to send, or asks a question a deck would answer — a link to the current file beats a paraphrase that goes stale. Returns nothing if no document matches; say so rather than describing a document you have not seen.",
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description:
            'What the document is about, in the words it would use: a product name, a solution area, a customer, a topic. Keep it short — three or four words match better than a sentence.',
        },
      },
      required: ['query'],
    },
  },
];

/** How many documents find_collateral hands back in one call. */
const COLLATERAL_RESULT_LIMIT = 5;

/** Drop nulls and blanks so records and notifications stay readable. */
function compact(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== ''),
  );
}

/**
 * Execute a tool call.
 *
 * Handlers never throw: a tool failure is returned to the model as text so the
 * rep's conversation continues rather than dying mid-answer.
 *
 * @param {{ name: string, input: object }} call
 * @param {{ sessionId: string, user: {email: string, name: string}, storage: import('./storage.js').Storage, env: object, cfg: object }} ctx
 * @returns {Promise<{ content: string, isError?: boolean, effect?: object }>}
 */
export async function runTool(call, ctx) {
  const { sessionId, user, storage, env, cfg } = ctx;
  const repEmail = user?.email || 'unknown';
  const repName = user?.name || repEmail;

  try {
    switch (call.name) {
      case 'log_prospect': {
        const input = compact(call.input);

        const record = compact({
          ...input,
          // The rep is the owner of this record, never its subject.
          loggedBy: repEmail,
          loggedByName: repName,
          sessionId,
          source: 'internal_sales_assistant',
        });

        const { id } = await storage.saveLead(record);
        const delivery = await deliverLead(
          {
            kind: 'lead',
            sessionId,
            data: record,
            summary: input.qualification_notes,
          },
          env,
          cfg,
        );

        return {
          content: `Logged as ${input.qualification_score}${delivery.delivered ? ' and sent to the pipeline' : ' (notification did not send; the record is saved)'}. Tell the rep it is recorded and confirm the next step they named.`,
          effect: { leadId: id, delivered: delivery.delivered, score: input.qualification_score },
        };
      }

      case 'ask_expert': {
        const input = compact(call.input);
        const blocking = input.urgency === 'blocking_a_call';

        const record = compact({
          ...input,
          requestedBy: repEmail,
          requestedByName: repName,
          sessionId,
          source: 'internal_sales_assistant_expert_request',
        });

        // Persisted as well as sent, so nothing is lost if delivery is misconfigured.
        await storage.saveLead(
          compact({
            sessionId,
            loggedBy: repEmail,
            use_case: `EXPERT REQUEST (${input.owner})`,
            qualification_notes: `${input.question}\n\nContext: ${input.context}`,
            source: 'internal_sales_assistant_expert_request',
          }),
        );

        const delivery = await deliverLead(
          { kind: 'escalation', urgent: blocking, sessionId, data: record, summary: input.question },
          env,
          cfg,
        );

        return {
          content: `Routed to ${input.owner}${blocking ? ' and flagged as blocking a call' : ''}. Tell the rep who has it${delivery.delivered ? '' : ' and that they should follow up directly, since the notification did not send'}. If they are mid-call, give them whatever safe holding answer you can in the meantime.`,
          effect: { owner: input.owner, urgency: input.urgency, delivered: delivery.delivered },
        };
      }

      case 'flag_content_gap': {
        const input = compact(call.input);

        const record = compact({
          ...input,
          reportedBy: repEmail,
          sessionId,
          source: 'internal_sales_assistant_content_gap',
        });

        await storage.saveLead(
          compact({
            sessionId,
            loggedBy: repEmail,
            use_case: `CONTENT GAP (${input.gap_type})`,
            qualification_notes: `${input.question}\n\n${input.details}`,
            source: 'internal_sales_assistant_content_gap',
          }),
        );

        // Not urgent — a gap is a backlog item, not an interrupt.
        const delivery = await deliverLead(
          { kind: 'content_gap', sessionId, data: record, summary: input.details },
          env,
          cfg,
        );

        return {
          content: `Gap logged for the content owner. Say so in one short sentence and move on — do not apologise again. Then give the rep the best partial answer you have, and name who could answer it properly.`,
          effect: { gapType: input.gap_type, delivered: delivery.delivered },
        };
      }

      case 'find_collateral': {
        const query = String(call.input.query || '').trim();
        const found = searchCollateral(query, { limit: COLLATERAL_RESULT_LIMIT });

        if (found.length === 0) {
          return {
            content:
              'No indexed document matches that. Tell the rep plainly that there is no deck or doc for it — do not describe one from memory. If they expected one to exist, that is a content gap worth flagging.',
            effect: { query, results: 0 },
          };
        }

        // The link is the deliverable, so the model is given exactly the fields
        // it needs to reproduce one and nothing it could embellish from.
        const listing = found
          .map((d) => {
            const parts = [`- ${d.name}`, `  link: ${d.webUrl}`];
            if (d.folder) parts.push(`  folder: ${d.folder}`);
            if (d.modified) parts.push(`  last updated: ${d.modified.slice(0, 10)}`);
            if (d.summary) parts.push(`  summary: ${d.summary}`);
            return parts.join('\n');
          })
          .join('\n\n');

        return {
          content: `${found.length} document(s) matched:\n\n${listing}\n\nGive the rep the link as a markdown link on the file name. Quote the summary only as far as it goes — it is the document's own opening text, not a description of everything inside. Say when a document was last updated if it is more than a few months old. Do not claim what a document contains beyond what is shown here.`,
          effect: { query, results: found.length },
        };
      }

      default:
        return { content: `Unknown tool: ${call.name}`, isError: true };
    }
  } catch (err) {
    console.error(`[tools] ${call.name} failed:`, err?.message || err);
    return {
      content: `That step did not complete. Do not retry it. Tell the rep it did not save and point them at ${cfg.INTERNAL_HELP_CHANNEL}, then carry on with the conversation.`,
      isError: true,
    };
  }
}
