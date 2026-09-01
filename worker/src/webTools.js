/**
 * webTools.js — the assistant's only route to the outside world.
 *
 * These are SERVER tools: Anthropic runs them, so nothing here executes in the
 * Worker and runTool() never sees them. That is why they are kept apart from
 * tools.js, whose every entry has a handler behind it — mixing the two got the
 * loop trying to run a search it had no way to run.
 *
 * They exist for ONE job: researching a prospect. Who the company is, what
 * they announced, who runs it, what pressure they are under. What they are
 * emphatically not for is answering "what does Vikat do" — that has to come
 * from the knowledge base, because a page on the open web saying something
 * about Vikat is not the same as it being true, and an assistant that will
 * repeat marketing copy back to a rep is the fabrication problem this system
 * was built to avoid, arriving by a new door.
 *
 * The prompt carries that rule (systemPrompt.js). What is enforced HERE is the
 * spend: max_uses is a hard ceiling the API applies, not an instruction the
 * model can talk itself out of.
 */

/** Requires Opus 4.6+/5, Sonnet 4.6 or Sonnet 5. Older models need the basic variants. */
export const WEB_SEARCH_TYPE = 'web_search_20260209';
export const WEB_FETCH_TYPE = 'web_fetch_20260209';

/**
 * The web tools this config asks for, ready to go in `tools`.
 *
 * Empty when WEB_RESEARCH is off, which is the whole switch: no entry in
 * `tools` means no capability, and systemPrompt.js reads the same flag so the
 * prompt stops describing what the request no longer offers. Describing a tool
 * that is not attached is what once produced an answer with an invented
 * product architecture in it.
 *
 * Deliberately NOT accompanied by a code_execution tool. The _20260209
 * variants run one internally for dynamic filtering, and declaring a second
 * execution environment confuses the model about which one it is in.
 */
export function webTools(cfg) {
  if (cfg.WEB_RESEARCH !== 'on') return [];

  // allowed_domains and blocked_domains are mutually exclusive; only ever
  // send the one that is configured.
  const blocked = (cfg.WEB_BLOCKED_DOMAINS || []).filter(Boolean);
  const limits = blocked.length ? { blocked_domains: blocked } : {};

  return [
    {
      type: WEB_SEARCH_TYPE,
      name: 'web_search',
      max_uses: cfg.WEB_SEARCH_MAX_USES,
      ...limits,
    },
    {
      type: WEB_FETCH_TYPE,
      name: 'web_fetch',
      max_uses: cfg.WEB_FETCH_MAX_USES,
      // Citations on, because a claim about a prospect that a rep may repeat
      // in a meeting has to carry where it came from.
      citations: { enabled: true },
      ...limits,
    },
  ];
}

/** Whether a tool name is one the API runs rather than one this Worker runs. */
export function isServerTool(name) {
  return name === 'web_search' || name === 'web_fetch';
}

/**
 * The sources a turn actually read, for the assets rail.
 *
 * Pulled off the result blocks rather than out of the answer text: the model
 * decides how many of its sources to mention, and a rep checking where a
 * claim came from needs all of them, not the ones that fitted the paragraph.
 *
 * Server-tool failures arrive as HTTP 200 with an ERROR OBJECT where the list
 * of results would be — `{ error_code: 'max_uses_exceeded' }` — so every
 * content field here is checked for being an array before it is walked. That
 * is not defensive tidiness: hitting the cap is the expected outcome of a
 * broad question, and it must not throw.
 */
export function sourcesFrom(content) {
  const out = [];
  const seen = new Set();

  const add = (url, title) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ kind: 'web', url, name: title || url, external: true });
  };

  for (const block of content || []) {
    if (block?.type === 'web_search_tool_result') {
      if (!Array.isArray(block.content)) continue;
      for (const result of block.content) add(result?.url, result?.title);
    }

    if (block?.type === 'web_fetch_tool_result') {
      const result = block.content;
      if (!result || Array.isArray(result)) continue;
      add(result.url, result.document?.title);
    }
  }

  return out;
}
