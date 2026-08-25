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
    roles.js        Authorization. What an authenticated person may do
    admin.js        Admin panel API
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
  test/           158 unit tests
widget/           Embeddable chat widget, internal page, and admin panel
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
| `roles.js` | Authorization | Role model changes without touching identity |

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

The Worker serves the pages too, so `http://localhost:8787/` is the assistant
and `http://localhost:8787/admin` is the panel. Send
`X-Dev-User: you@vikat.ai` to pick an identity (a header extension like
ModHeader does this in the browser).

### Tests

```bash
npm --prefix worker test      # 158 tests, no network, no browser
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

**No custom domain or Cloudflare-managed zone is required.** Access attaches to
the Worker itself, which covers its `workers.dev` URL and any custom domain
added later.

1. Deploy once, so the Worker exists.
2. Zero Trust → Access → Applications → Add an application → **Self-hosted**.
3. Under Destinations choose **+ Add Workers** and pick `vikat-sales-assistant`
   by name — not a public hostname, which would need a zone on this account.
4. Policy: allow emails ending in `@vikat.ai`, or a specific group.
5. Copy the **Application Audience (AUD)** tag and your team domain into
   `wrangler.toml` as `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN`, then deploy
   again.

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

## Admin panel

`widget/admin.html`, served alongside the assistant. Requires the `admin` role;
everyone else gets a 403 and a plain explanation.

### Knowledge

Add, edit and remove material the agent answers from. Entries are merged into
the prompt **at request time**, so a correction typed here is live on the next
message — no rebuild, no deploy.

New entries default to **draft** and are invisible to the agent until approved.
Approved entries go into every prompt, so the list is capped at 500 and each
entry at 20,000 characters; an unbounded list is a slow, invisible way to grow
cost and latency.

Markup is stripped on the way in, so an entry cannot inject structure into the
prompt.

### SharePoint

Configures **where** the sync reads: hostname, site path, library, folder.
Changes apply on the next sync run.

It does **not** configure the Graph credentials, on purpose:

1. A client secret in KV is readable by anything that reaches KV. Today it
   lives in secret storage and cannot be read back at all. Moving it into a web
   form makes the admin panel a target worth compromising for tenant-wide
   SharePoint read access.
2. The sync runs in GitHub Actions, not in the Worker. A secret typed into the
   panel would never reach the process that calls Graph.

The panel reports whether credentials are configured and shows the last sync
result. It cannot display or exfiltrate the secret.

### Users and access

This manages **authorization, not authentication**. It never creates a login.

People sign in with their Vikat account through Entra or Cloudflare Access.
A grant here decides what they can do once signed in. The property that matters:
when someone leaves and IT disables their directory account, they lose access
here immediately, without anyone remembering to revoke anything. A second user
store with its own passwords would break exactly that.

| Role | Can |
|---|---|
| `admin` | Use the assistant, plus the admin panel |
| `rep` | Use the assistant |
| `denied` | Nothing — blocked even though the IdP authenticates them |

Precedence: `BOOTSTRAP_ADMINS` from config → an explicit grant in storage →
`DEFAULT_ROLE`.

`BOOTSTRAP_ADMINS` solves the cold start — with an empty KV nobody could reach
the panel to grant the first role — and it is the recovery path: config beats
storage, so a botched grant is fixed by redeploying rather than by editing KV
by hand. **Keep at least one.**

`DEFAULT_ROLE` decides the posture. `rep` means SSO is the gate: anyone with a
Vikat account can use the assistant. `denied` makes it an explicit allowlist.

Guardrails: the last admin cannot be demoted, you cannot remove your own admin
access, bootstrap admins cannot be edited from the panel, and a grant to an
address outside `ALLOWED_EMAIL_DOMAINS` is refused rather than silently having
no effect.

Note that with `DEFAULT_ROLE=rep`, *removing* a grant returns someone to `rep`
rather than blocking them. To actually block someone, set them to `denied`. The
panel says so when you remove a grant.

---

## Deploying

```bash
npm --prefix worker run deploy -- --env=""
```

Before the first deploy, fill the `REPLACE_WITH_` placeholders in
`wrangler.toml`: the Access team domain and AUD tag, `BOOTSTRAP_ADMINS`, the
notification webhook URL, and the KV namespace ids.

```bash
wrangler kv namespace create VIKAT_KV
wrangler kv namespace create VIKAT_KV --preview
```

The pages ship with the Worker — `widget/` is declared as a static-assets
directory in `wrangler.toml`, so `/` is the assistant and `/admin` is the panel
on the same origin as the API. One origin means one Access policy and no CORS.

That also removes a failure mode worth naming: with the pages on a separate
hostname, the Access cookie is never set for the API host, so every request
401s and reloading does not help.

`data-endpoint="/"` in both pages means same-origin. An absolute URL still
works if the front end is ever hosted separately.

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
- Open `/admin.html` as a non-admin. It must refuse.
- As an admin, add an approved knowledge entry and confirm the assistant uses
  it on the next message without a redeploy.

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
