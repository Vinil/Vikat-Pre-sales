# Vikat Internal Sales Assistant

An authenticated chat assistant for Vikat's sales team. It answers from Vikat's
own material — the public site, curated notes, and approved SharePoint decks and
documents — and tells the rep what is safe to repeat to a customer.

**This is an internal tool.** It serves material that is not cleared for
customers. Every request must carry a verified Vikat identity; there is no
anonymous access, and the Worker fails closed if authentication is
misconfigured.

---

## Layout

```
worker/           Cloudflare Worker — the agent backend
  src/
    index.js        Routing, validation, rate limiting, SSE streaming
    auth.js         Identity. The only module that decides who is calling
    systemPrompt.js Persona, disclosure policy, guardrails
    knowledge.js    GENERATED — compiled knowledge base
    retrieve.js     Knowledge abstraction
    tools.js        log_prospect, ask_expert, flag_content_gap
    storage.js      Storage abstraction (KV)
    leadSink.js     Notification abstraction (webhook / email)
    config.js       Every tunable
    knowledge/
      faq.json        Curated entries (compiled only when approved)
      disclosure.json What may be repeated to a customer, and who owns it
      sharepoint.json GENERATED, GITIGNORED — synced internal material
  test/           124 unit tests
widget/           Embeddable chat widget + standalone internal page
scripts/
  build-knowledge.js   Compile site HTML + FAQ + SharePoint into knowledge.js
  sync-sharepoint.js   Pull approved material from SharePoint via Graph
  lib/graph.js         Microsoft Graph client
  lib/extract.js       .pptx / .docx / .pdf / .txt text extraction
.github/workflows/
  sync-knowledge.yml   Nightly sync, rebuild and deploy
```

Four abstractions are load-bearing. Each is the only module allowed to touch
its concern, and `worker/test/no-direct-bindings.test.js` enforces that by
grep:

| Module | Owns | Swapping it |
|---|---|---|
| `storage.js` | KV reads and writes | KV → D1 without touching callers |
| `retrieve.js` | Knowledge injection | Full-inject → Vectorize behind the same signature |
| `leadSink.js` | Outbound notifications | Webhook → CRM without callers knowing |
| `auth.js` | Identity | Cloudflare Access → Entra ID in one file |

---

## Local development

```bash
npm --prefix worker install
npm --prefix scripts install

# Build the knowledge base from a local checkout of the site repo.
git clone https://github.com/Vinil/vikat-ai-site-v1 ../vikat-ai-site-v1
node scripts/build-knowledge.js --pages ../vikat-ai-site-v1

# Run the Worker with SSO bypassed and notifications disabled.
npm --prefix worker run dev
```

`--env dev` sets `AUTH_MODE=dev` **and** `ALLOW_DEV_AUTH=true`. Both are
required — a stray `AUTH_MODE` change alone cannot open the door. Send
`X-Dev-User: you@vikat.ai` to pick an identity.

Serve the widget against it by editing `data-endpoint` in
`widget/index.html` to `http://localhost:8787`.

### Tests

```bash
npm --prefix worker test      # 124 tests, no network, no browser
npm --prefix scripts test     # 39 tests, extraction and Graph client
npm --prefix worker run test:widget   # 10 tests, needs Playwright + Chromium
```

`test:widget` is deliberately outside the default suite so `npm test` stays
fast and dependency-free.

---

## Secrets

Never in `wrangler.toml`, never in code. A test asserts this.

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put LEAD_WEBHOOK_TOKEN     # if LEAD_SINK = "webhook"
wrangler secret put DKIM_PRIVATE_KEY       # if LEAD_SINK = "mailchannels"
```

For the nightly workflow, as GitHub **secrets**: `GRAPH_TENANT_ID`,
`GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`. As GitHub **variables** (not secret — they are
hostnames and folder names): `SHAREPOINT_HOSTNAME`, `SHAREPOINT_SITE_PATH`,
`SHAREPOINT_LIBRARY`, `SHAREPOINT_FOLDER`.

---

## Authentication

`AUTH_MODE` selects the implementation.

### Cloudflare Access (default)

1. Zero Trust → Access → Applications → add a self-hosted app for
   `sales-assistant.vikat.ai`.
2. Policy: allow emails ending in `@vikat.ai`, or a specific group.
3. Copy the **Application Audience (AUD)** tag and your team domain into
   `wrangler.toml` as `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN`.

The Worker verifies the Access JWT against your team's JWKS — signature,
expiry, issuer, audience — then checks the email domain as a second gate.

Cloudflare Access is free up to 50 users; beyond that it is billed per seat.

### Entra ID direct

Set `AUTH_MODE=entra`, `ENTRA_TENANT_ID` and `ENTRA_AUDIENCE`. The client sends
`Authorization: Bearer <token>`; the Worker verifies it against the tenant
JWKS. Use this if you would rather not put Access in front.

Both modes fail closed: an unreachable JWKS, an unknown key id, `alg:none`, a
mismatched audience and an outside email domain all reject.

---

## Knowledge base

Three sources compile into `worker/src/knowledge.js`:

1. **Site pages** — `--pages <dir>` parses the vikat.ai HTML, strips nav and
   footer, splits on headings. ~268 chunks today.
2. **`faq.json`** — curated entries. Compiled **only** when
   `status: "approved"`. A draft entry is excluded, so the agent says it does
   not know and calls `flag_content_gap` rather than guessing.
3. **`sharepoint.json`** — synced decks and documents. See below.

```bash
node scripts/build-knowledge.js --pages ../vikat-ai-site-v1
```

The build prints every skipped FAQ entry and warns when the compiled base
crosses ~50K tokens, which is the point at which full injection should give way
to Vectorize retrieval (reimplement `retrieve.js`; callers do not change).

### Adding curated knowledge

Fill `content` in `worker/src/knowledge/faq.json` and set `status` to
`"approved"`. Everything there must be **true and current** — a rep will repeat
it to a customer. Where something is not customer-repeatable, say so in the
text and the agent will tag it.

---

## SharePoint sync

The sync reads **one document library**, optionally **one folder** within it.
That library is the approval boundary: publishing a file there is what makes it
visible to the assistant. It fails closed — without `SHAREPOINT_LIBRARY` set,
it refuses to run rather than guessing a scope.

Do not point it at a whole site. Anything anyone drops anywhere then becomes an
answer, which is how an unreleased roadmap deck ends up quoted on a call.

### Setup

1. Azure Portal → App registrations → new registration.
2. API permissions → Microsoft Graph → **Application** permissions →
   `Sites.Selected`. Grant admin consent.
3. Grant that app read access to the specific site (via Graph
   `/sites/{id}/permissions`, or the SharePoint admin centre).
   `Sites.Read.All` also works but gives the app every site in the tenant —
   `Sites.Selected` is worth the extra step.
4. Certificates & secrets → new client secret.

```bash
export GRAPH_TENANT_ID=...
export GRAPH_CLIENT_ID=...
export GRAPH_CLIENT_SECRET=...
export SHAREPOINT_HOSTNAME=vikat.sharepoint.com
export SHAREPOINT_SITE_PATH=/sites/Sales
export SHAREPOINT_LIBRARY="Sales Enablement"
export SHAREPOINT_FOLDER=Approved        # optional, recommended

node scripts/sync-sharepoint.js --dry-run   # fetch and report, write nothing
node scripts/sync-sharepoint.js             # incremental
node scripts/sync-sharepoint.js --full      # ignore the delta cursor
```

Supported: `.pptx` (including speaker notes, which usually carry the real
guidance), `.docx` (split on headings), `.txt`, `.md`. PDF extraction is
best-effort and reports honestly when a file has no text layer — convert those
to `.docx` or `.pptx`. Legacy `.ppt`/`.doc` are rejected rather than mangled.

Deletions propagate: a file removed from SharePoint has its chunks dropped on
the next sync. That is why the sync uses a Graph delta query rather than
re-listing.

### Why nothing is committed

**This repository is public.** The site pages and the curated FAQ are already
public, so the committed `knowledge.js` is safe. SharePoint content is not —
it carries pricing bands, battlecards and customer names.

So `sharepoint.json` is gitignored, and the nightly workflow syncs, compiles and
deploys entirely inside the CI runner. The internal material reaches the
deployed Worker bundle and nowhere else. Two tests enforce this: one asserts the
committed knowledge base contains no SharePoint chunks, the other asserts the
gitignore rule exists.

If you make this repository private, that constraint relaxes — but the tests
should stay, because the failure is silent and expensive.

### Nightly refresh

`.github/workflows/sync-knowledge.yml` runs at 03:20 UTC: sync → compile →
test → deploy. A deck edited on Monday is live Tuesday morning. The delta
cursor is kept in the Actions cache rather than committed, since it embeds file
and folder names.

Run it on demand from the Actions tab; tick **full** to ignore the cursor.

---

## Disclosure policy

`worker/src/knowledge/disclosure.json` is the inversion that makes this an
internal tool rather than a public one. The agent does not refuse to discuss
pricing, roadmap, customers or competitors — refusing a rep just sends them to
guess in front of a customer. It answers, and tags what may leave the room:

| Tag | Meaning |
|---|---|
| `[OK to share]` | Published material, safe to repeat verbatim |
| `[Internal only]` | Do not repeat to a customer, in writing or on a call |
| `[Check before sharing]` | Repeatable only with the named owner's sign-off |

Each topic names an owning team, and the agent routes `needs_approval`
questions there via `ask_expert` rather than handing over the material and
leaving the judgement to the rep.

The widget lifts these tags out of the reply body and renders them as coloured
chips, so a rep cannot skim past the line that says "do not repeat this".

Editing the policy means editing `disclosure.json`. The prompt is generated
from it, and tests assert every topic and owner reaches the prompt.

---

## Deploying

```bash
npm --prefix worker run deploy -- --env=""
```

Before the first deploy, fill the `REPLACE_WITH_` placeholders in
`wrangler.toml`: the Access team domain and AUD tag, the notification webhook
URL, and the KV namespace ids.

```bash
wrangler kv namespace create VIKAT_KV
wrangler kv namespace create VIKAT_KV --preview
```

Deploy the widget by copying `widget/` to wherever the internal page is hosted,
and pointing `data-endpoint` at the Worker.

### Smoke tests after deploying

- `GET /health` — reports model, knowledge size, auth mode, binding presence.
  It must show `devAuthOpen: false`.
- Load the page signed out. It must refuse, not answer.
- Load it signed in, ask a pricing question, and confirm a disclosure chip
  renders.
- Ask something the knowledge base does not cover; confirm the agent says so
  and flags a gap rather than inventing an answer.
- Check the notification channel for the logged prospect, expert request and
  content gap.

---

## Weekly review

Transcripts are in KV under `log:<sessionId>:*`, attributed to the signed-in
rep, retained 90 days. Leads, expert requests and content gaps are under
`lead:*`, retained a year.

Worth reading weekly:

- **Content gaps** — the shortlist of what to write next. This is the main
  reason `flag_content_gap` exists.
- **Answers that should have carried a disclosure tag but did not** — the
  expensive failure mode.
- **Qualification scores** against reality, so reps keep trusting them.
- **Repeated expert requests on one topic** — a knowledge gap wearing a
  different hat.

---

## Known limitations

- **MailChannels** ended its free Workers tier in June 2024. `LEAD_SINK`
  defaults to `webhook` for that reason; the MailChannels path still works but
  needs an account and DKIM records.
- **PDF extraction is best-effort.** Scanned PDFs yield nothing and say so.
- **Rate limiting is eventually consistent.** KV can let a burst through across
  colos. Acceptable here — the threat is a runaway client, not abuse. A Durable
  Object behind the same `storage.js` method would fix it with no caller change.
- **The knowledge base is compiled into the bundle.** Fine at ~22K tokens.
  Past ~50K, switch `retrieve.js` to Vectorize.
