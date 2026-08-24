/**
 * knowledge.js — GENERATED FILE. Do not edit by hand.
 *
 * Regenerate with: npm run build:knowledge
 * Source: worker/src/knowledge/faq.json
 * Chunks: 2   Estimated tokens: ~181
 *
 * Chunk shape is { id, page, section, content }. Tier B (Vectorize) embeds
 * exactly these chunks, so the shape is part of the forward-compatibility
 * contract — see scripts/build-knowledge.js.
 */

/** @typedef {{ id: string, page: string, section: string, content: string }} KnowledgeChunk */

/** @type {KnowledgeChunk[]} */
export const KNOWLEDGE = [
  {
    "id": "faq:contact-next-steps",
    "page": "curated/faq.json",
    "section": "How to get in touch",
    "content": "Prospects can book time with the Vikat team using the booking link the assistant provides via the request_meeting tool, or reach the team by email. The assistant can pass along a name, email, company, role and a short description of the use case so the team arrives at the call already briefed."
  },
  {
    "id": "faq:assistant-scope",
    "page": "curated/faq.json",
    "section": "What this assistant can and cannot do",
    "content": "This assistant answers questions about Vikat's products and solution areas from Vikat's published material, and can arrange a conversation with the team. It does not quote prices, discuss company financials, name customers, commit to roadmap dates, or complete security questionnaires — those go to the Vikat team directly. Conversations are logged and reviewed by Vikat."
  }
];

/** Approximate token count of the compiled knowledge base. */
export const KNOWLEDGE_TOKENS = 181;

/** Build metadata, surfaced by GET /health for operational visibility. */
export const KNOWLEDGE_META = {
  "chunkCount": 2,
  "estimatedTokens": 181,
  "pageChunks": 0,
  "faqChunks": 2,
  "skippedFaqEntries": [
    "company-overview",
    "product-vcommand",
    "product-vshield",
    "product-vinsight",
    "product-vsentinel",
    "solution-mcp-server-security",
    "solution-agent-security",
    "solution-app-cloud-security",
    "solution-ai-governance",
    "deployment-models",
    "engagement-models",
    "partnership-posture",
    "integrations"
  ]
};
