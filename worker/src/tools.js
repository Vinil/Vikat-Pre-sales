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
 *   (new)              create_document    a branded deck or one-pager
 *
 * Every handler persists through storage.js and delivers through leadSink.js.
 * No handler touches KV or an outbound mail API directly.
 */

import { deliverLead } from './leadSink.js';
import { searchCollateral, collateralCount } from './collateral.js';
import { createDocument } from './documents/index.js';
import { LIMITS } from './documents/spec.js';

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
    // NOT strict, and the reason is measured rather than guessed.
    //
    // Live evidence from the deployed Worker: create_document, the LARGEST
    // schema in this file (1755 bytes, 6 properties), is accepted — it is not
    // strict. log_prospect, smaller at 1472 bytes, was refused with "Schema is
    // too complex." on every request in every conversation. `strict` is the
    // multiplier: it compiles the schema into a constrained-decoding grammar,
    // and this tool's nine properties are over whatever that budget is.
    //
    // Two wrong fixes preceded this one — flattening a nested array, then
    // removing six union types — both aimed at shapes that looked expensive.
    // What actually found it was the degradation ladder naming the tool in a
    // production log. normaliseProspect() below does the validating strict
    // would have done.
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        // Unknown fields travel as an EMPTY STRING, not null.
        //
        // These were type: ['string', 'null']. Under `strict` a union is a
        // branch in the constrained-decoding grammar, and six of them in one
        // tool is 64 shapes the grammar has to express — which is what the API
        // was rejecting with "Schema is too complex." on every request in every
        // conversation, tools that were never called included. Flattening
        // create_document did not fix it because the unions were never there.
        //
        // compact() below already drops blanks as well as nulls, so nothing
        // downstream changes: an unknown field is still absent from the record.
        prospect_name: { type: 'string', description: 'Prospect contact name. Empty string if not given.' },
        prospect_email: { type: 'string', description: 'Prospect email. Empty string if not given.' },
        company: { type: 'string', description: 'Prospect company. Empty string if not given.' },
        role: { type: 'string', description: 'Prospect job title or role. Empty string if not given.' },
        use_case: {
          type: 'string',
          description: 'What the prospect is trying to solve, as the rep described it.',
        },
        environment: {
          type: 'string',
          description:
            'Cloud provider, security tooling, AI/agent adoption stage — whatever the rep mentioned. Empty string if not discussed.',
        },
        timeline: { type: 'string', description: 'Timeline or deadline. Empty string if not given.' },
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
      "Find the SharePoint decks and documents behind an answer, so the rep gets a link they can send or open. Call this whenever the rep is preparing for a call, asks what to send, or asks a question a deck would answer — a link to the current file beats a paraphrase that goes stale. Pass an EMPTY query to list the most recent collateral, which is what to do when a rep asks what material exists rather than for something specific. Returns nothing if no document matches; say so rather than describing a document you have not seen.",
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description:
            'What the document is about, in the words it would use: a product name, a solution area, a customer, a topic. Keep it short — three or four words match better than a sentence. Empty string lists the most recently updated collateral instead of searching.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'create_document',
    description:
      "Produce a branded deck (.pptx) or document (.pdf) that the rep can present or send. Call it when a rep asks for a deck, a one-pager, a leave-behind, or something to take into a meeting — not for an answer they will read on screen. You write the words; layout, colour, typefaces and the disclosure footer are applied for you. Every claim must come from the knowledge base or from what the rep told you in this conversation: a document outlives the chat, and an invention in one becomes a broken promise in a deal.",
    // NOT strict, and the schema is deliberately FLAT.
    //
    // An earlier version nested objects inside an array to describe sections.
    // The API rejected the whole request with "Schema is too complex" — every
    // message in every conversation, including ones that never touched this
    // tool. Dropping `strict` did not help: the limit applies to the schema
    // either way. Only removing the nesting did.
    //
    // So the structure travels as markdown in one string, which the model
    // writes more reliably than a nested object anyway, and spec.js parses.
    // Nothing is lost by being non-strict: normaliseSpec() validates, coerces
    // and truncates every field regardless, because model-authored content
    // needed normalising from the start.
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        format: {
          type: 'string',
          enum: ['pptx', 'pdf'],
          description:
            'pptx for something the rep will present or edit; pdf for something they will send, where the layout must not move.',
        },
        title: {
          type: 'string',
          description: `What this document is, in sentence case. Under ${LIMITS.titleChars} characters.`,
        },
        subtitle: {
          type: 'string',
          description:
            'One sentence for the cover saying what the reader gets from it. Empty string if there is nothing worth saying.',
        },
        audience: {
          type: 'string',
          description:
            'Who it is for, as it should read on the cover: "Acme security team", "the CISO at Northwind". Empty string if the rep did not say.',
        },
        disclosure: {
          type: 'string',
          enum: ['external_ok', 'internal_only', 'needs_approval'],
          description:
            'Printed on every page. external_ok only when every claim is drawn from published material. internal_only when it touches pricing, roadmap, named customers or competitive positioning. needs_approval when the owning team must sign off first. When unsure, choose internal_only.',
        },
        content: {
          type: 'string',
          description:
            `The body, as markdown. One "## " heading per section, up to ${LIMITS.sections}; each becomes a slide in a deck or a block in a document. Put an optional eyebrow of two or three words before a pipe in the heading. Under each heading write an optional short paragraph of prose, then up to ${LIMITS.points} "- " points of one idea each. No other markdown: no bold, no links, no nested lists, no tables. For example:\n\n## context | Agents reach production faster than controls do\nThe model is ready long before the guardrails are.\n- Agents call tools with real credentials\n- Nobody owns the blast radius`,
        },
      },
      required: ['format', 'title', 'subtitle', 'audience', 'disclosure', 'content'],
    },
  },
];

/** How many documents find_collateral hands back for a search. */
const COLLATERAL_RESULT_LIMIT = 5;

/** More for a bare "what do we have" listing, which is a browse, not a hit. */
const COLLATERAL_LISTING_LIMIT = 12;

/**
 * What log_prospect accepts, now that the schema is not enforced for us.
 *
 * The handler used to spread the model's input straight into the pipeline
 * record, which was safe only because `strict` guaranteed the shape. Without
 * it, an unexpected key would reach storage and a junk qualification_score
 * would reach a sales manager's queue.
 */
const PROSPECT_FIELDS = [
  'prospect_name',
  'prospect_email',
  'company',
  'role',
  'use_case',
  'environment',
  'timeline',
  'qualification_notes',
];

function normaliseProspect(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const out = {};

  for (const field of PROSPECT_FIELDS) {
    const v = raw[field];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) out[field] = s;
  }

  // The score drives how a lead is triaged, so it is never passed through
  // unchecked. An unrecognised one becomes WARM — the middle, which neither
  // invents urgency nor buries a real lead — and the original is kept in the
  // notes rather than dropped, so nothing is lost silently.
  const score = String(raw.qualification_score ?? '').trim().toUpperCase();
  if (SCORES.includes(score)) {
    out.qualification_score = score;
  } else {
    out.qualification_score = 'WARM';
    const note = `[scored WARM by default; the assistant returned ${score || 'no score'}]`;
    out.qualification_notes = out.qualification_notes ? `${out.qualification_notes} ${note}` : note;
  }

  return out;
}

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
        const input = normaliseProspect(call.input);

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
        const listing = query === '';
        const found = searchCollateral(query, { limit: listing ? COLLATERAL_LISTING_LIMIT : COLLATERAL_RESULT_LIMIT });

        // Nothing indexed at all is a different problem from nothing matching,
        // and telling a rep "no deck covers that" when the library was never
        // synced sends them looking for the wrong thing.
        if (collateralCount() === 0) {
          return {
            content:
              'No SharePoint material has been indexed at all — the library is empty or the nightly sync has not run. Tell the rep this is a setup problem rather than a gap in the collateral, and that an administrator should check the sync. Do not describe documents you have not seen.',
            effect: { query, results: 0, reason: 'nothing_indexed' },
          };
        }

        if (found.length === 0) {
          return {
            content:
              'No indexed document matches that. Tell the rep plainly that there is no deck or doc for it — do not describe one from memory. Point them at the Collateral tab to browse everything, and if they expected something to exist, that is a content gap worth flagging.',
            effect: { query, results: 0 },
          };
        }

        // The link is the deliverable, so the model is given exactly the fields
        // it needs to reproduce one and nothing it could embellish from.
        const rows = found
          .map((d) => {
            const parts = [`- ${d.name}`, `  link: ${d.webUrl}`];
            if (d.folder) parts.push(`  folder: ${d.folder}`);
            if (d.modified) parts.push(`  last updated: ${d.modified.slice(0, 10)}`);
            if (d.summary) parts.push(`  summary: ${d.summary}`);
            return parts.join('\n');
          })
          .join('\n\n');

        return {
          content: `${found.length} document(s)${listing ? ` of ${collateralCount()} indexed` : ' matched'}:\n\n${rows}\n\nGive the rep the link as a markdown link on the file name. Quote the summary only as far as it goes — it is the document's own opening text, not a description of everything inside. Say when a document was last updated if it is more than a few months old. Do not claim what a document contains beyond what is shown here.`,
          effect: { query, results: found.length },
        };
      }

      case 'create_document': {
        const result = await createDocument(call.input, {
          storage,
          user: ctx.user,
          env,
          cfg,
          fonts: ctx.fonts,
        });

        if (!result.ok) {
          return {
            content: `The document could not be built: ${result.error} Tell the rep plainly and offer to try again with what is missing.`,
            isError: true,
          };
        }

        const filing = result.filed
          ? `Filed in SharePoint at ${result.sharePointUrl}.`
          : `NOT filed in SharePoint (${result.filingReason}). Say so — the rep should know this copy is theirs alone and expires.`;

        return {
          content:
            `Built ${result.fileName} — ${result.sections} section(s), ${Math.round(result.sizeBytes / 1024)}KB. ` +
            `Download link: ${result.downloadPath}\n${filing}\n\n` +
            `Give the rep the download link as a markdown link on the file name, and the SharePoint link too if there is one. ` +
            `State the disclosure label printed on it: "${result.disclosureLabel}". Do not restate the document's contents — they have it.`,
          effect: {
            format: result.format,
            sections: result.sections,
            disclosure: result.disclosure,
            filed: result.filed,
          },
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
