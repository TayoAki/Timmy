# Timmy backend PRD

Nov 16, 2026 (updated the same day with the decisions made while building phase 0, and on Nov 17 with phase 1 as built) · Exported from the living doc in Claude Docs: https://claude.ai/artifact/Q5Kzr8u27UVqzUFKdXUVDH (the diagrams are there)

## Summary

The backend turns today's single-user preview into a multi-tenant SaaS. People sign up with email and get a workspace. That workspace comes with an assistant that reads their mail, calendar, files and CRM, builds a map of their work (an ontology), and drafts and acts through an approval gate. The assistant also has its own cloud computer. The plan is four phases over about 8 months, with a team of 6 to 7 (5 engineers), a private beta from week 5 and a paid launch in week 22.

**Goals**

- Every screen in the current frontend runs on real accounts: Gmail first, Microsoft 365 second.
- Nothing leaves a workspace unless policy allows it. Every send, invite, CRM write, text and post is an Action record that waits for approval unless a rule says otherwise.
- The assistant knows the user's world. Each workspace gets an ontology of people, companies, deals, projects, candidates, properties and so on. It is built automatically and kept current.
- Each workspace gets one assistant with its own cloud computer, a tool catalog and app connections.
- It works for teams from day one: roles, delegate mode for EAs, RevOps approval for CRM writes, and client workspaces for agencies.

**Non-goals for v1:** training or hosting our own models; social posting (it stays "coming soon" until phase 3); replacing Salesforce for teams already on it; running our own email warm-up network.

**Success targets** (proposed; to confirm with the beta)

| Measure | Target |
| --- | --- |
| Sign-up to first useful brief | under 10 minutes (first 30 days of mail synced) |
| Drafts sent with no edits or minor edits | 60% or more |
| Sends, texts or CRM writes that ran without your approval or a rule you set | 0 |
| Draft ready after a new email arrives (p95) | under 20 s |
| Beta workspaces still active in week 4 | 40% or more |

## What the frontend needs from the backend

The frontend already covers 15 areas on sample data. The state shape in `src/state/store.tsx` and the action reducer are the backend's contract. Each reducer action becomes an API command, and each piece of state becomes a synced resource. The table below lists what each area needs.

| Frontend area | What it does on sample data today | What the backend must provide |
| --- | --- | --- |
| Today and urgency | Ranked "Needs you today" with plain reasons; calm home; focus | Urgency scoring service over synced threads, tasks, waiting items and leads; per-user preferences |
| Mail and triage | Threads, summaries, Follow Up / Waiting / Read Through labels, Accept confident | Gmail and Graph sync (push plus incremental), label write-back, a triage classifier with a confidence score |
| Approvals and Decided | Linked approvals, decision cards, duplicate-ask checks, 7-day undo | Action records, a policy engine, approver routing, idempotent executors, an audit log, an undo window |
| Waiting and Send & track | Who owes me what, promised dates, nudges | Commitment extraction from sent and received mail, due-date tracking, a scheduled nudge job |
| Ask Timmy | AG-UI chat with widgets (urgent, approvals, day, pipeline, thread, waiting) | Agent runtime streaming AG-UI events over SSE, a tool registry, conversation memory |
| Calendar | Day/week views, find time, prep cards | Calendar sync, free/busy across attendees, invite actions through approvals |
| Docs, files and Drive | Docs, sheets and decks open inside the app; To file naming | Drive and OneDrive sync, file storage, a document index for search and grounding |
| Projects, tasks, people, CRM | Focus scopes, deals, contacts, next steps | Core records in Postgres, CRM sync (HubSpot, Salesforce), ontology-backed entities |
| Outbound | Leads, CSV import, offer, templates, sequences, caps, Unibox | Drafts saved in the user's Composio-connected accounts, a Drafts view, sending with caps, warm-up ramp, per-lead time zones, bounce and reply handling, unsubscribe |
| Speed to lead | Form leads with a live clock, auto-reply, call, book | Webhook intake, lead-source connectors (Follow Up Boss, Zillow, Realtor.com), alerts, SMS and voice |
| Channels | Slack, SMS, phone in the lead panel | Slack app. Twilio texts and the browser dialer are deferred; in live mode they show as coming soon |
| Social (coming soon) | Composer, calendar, trends | Deferred to phase 3: LinkedIn, Instagram and Facebook connectors plus a scheduler |
| Voice | On-device speech model | None (stays on the device) |
| Settings and rules | Triage rules, sending limits, appearance, deals switch | Workspace settings, a rules store that the policy engine enforces |
| New this round | Delegate mode, call list, CRM sync with RevOps, lead sources, Outlook, client workspaces, mailboxes at scale | Roles and on-behalf-of sending, approver routing, multi-workspace orgs, bulk mailbox management |

The frontend keeps its optimistic UI. The backend sends back the confirmed state, and conflicts resolve in the server's favour with a toast.

## Architecture

Timmy runs one agent loop on its own servers, with one API and one workspace store per region. Composio is the way in for app data. The Action gateway is the only way out for anything that changes the world. The sandbox only runs tools.

*Architecture diagram: see the Claude Docs version. Rows: Composio → Sync jobs → Workspace store; Web and phone app → API + Better Auth → Agent runtime (one loop, any model, Claude by default) ↔ Cloud computer (runs tools only, short-lived tokens); Agent runtime ↔ Workspace store; Agent runtime → Action gateway (policy, approvals, undo, audit log) → Executors (Composio writes, mail, texts, calls); the gateway asks you, the exec or RevOps.*

Composio events become items in the store, and plain code decides which of them need a model. The agent reads the store and proposes writes. The gateway asks you, the exec or RevOps, then the executors carry the change out. Runs are leased rows in Postgres, so a crash or a pause for approval resumes exactly where it stopped. The cloud computer runs tools for jobs no API covers, and it never holds a real credential.

**Stack.**

- TypeScript end to end, to match the frontend.
- Hono on Node for the API and the agent service.
- Postgres on Railway with row-level security, plus pgvector (Railway's pgvector template, since its default Postgres has no extensions). Backups on. Runs, checkpoints and effect records live there too.
- Better Auth inside the API.
- One job system: pg-boss in Postgres, for schedules and as the crash backup for runs. Runs start immediately, not from the queue. Inngest is the upgrade if per-tenant fairness needs it.
- A sandbox interface over E2B or Daytona.
- Railway Buckets (S3-compatible) for files and sandbox homes.
- The frontend's reducer actions become API commands, and state comes back as patches over SSE.
- **One service serves the API and the live app, on one origin** (decided Nov 16, 2026, during phase 0). `up.railway.app` is on the public suffix list, so two Railway subdomains cannot share a cookie, and cross-site cookies are blocked by Safari. Serving both from the `app` service keeps sign-in cookies first-party and needs no CORS. The older `web` service stays the demo.
- **The server runs the frontend's own reducer** (decided Nov 16, 2026). Each command is applied by the same reducer code on the workspace's stored state, and the difference goes back as patches keyed by entity. An action that would send mail is found by looking at the reducer's result (a new message from the user) and is turned into an effect record first, so a send cannot slip past the gateway under an action name the server has not heard of. Actions that only pretend in the demo (campaign launch, texts, fake connections) are refused on a real workspace until their phase builds them.

## Accounts, workspaces and roles

Login runs on **Better Auth**, inside our own API and backed by our own Postgres. Its [organization plugin](https://www.better-auth.com/docs/plugins/organization) is the workspace. People sign up with email and a password, or an email link. There is no Sign in with Google or Microsoft. Signing in only proves who someone is. Access to mail, calendar and files is a separate step done through Composio connect buttons (see Connections), so Timmy's own login never touches Google or Microsoft.

**Sign-up, start to finish**

1. Sign up with email and a password, or with an email link.
2. Name the workspace and pick a trade: sales, recruiting, real estate, home services, consulting, agency or other. The trade seeds the ontology, fields and templates.
3. Connect apps with one button each, Gmail and Calendar first. Each button opens Composio's connect page.
4. The assistant is set up. A 30-day backfill starts, and the first brief is ready in under 10 minutes. The 90-day backfill continues in the background.
5. Invite teammates. Better Auth sends the invitation, and the user chooses each person's role.

As built (Nov 16, 2026): Timmy's own account mail (sign-in links, invitations, password resets, address confirmation) goes through [Resend](https://resend.com/docs/api-reference/emails/send-email). Each message is recorded first and delivered by a job under a fixed idempotency key, so a retry is never a second email. Once the server has a Resend key and a sender address, a new account must open the link sent to its address before it can sign in. On production, sign-up also stays invite-only until the operator opens it. An account can be created for an address on the operator's list (`TIMMY_SIGNUP_ALLOW`) or one that holds a pending invitation to a workspace. An invitation link never joins by itself: it shows who is inviting the person to which workspace and in what role, and they choose. An email leaves under the name of whoever connected the mailbox, so a send from it by anyone else who is not an owner or admin waits for that person's OK, as a delegate's does.

**How Better Auth maps to Timmy**

| Better Auth | In Timmy |
| --- | --- |
| Organization | A workspace: its own mailboxes, ontology, assistant, cloud computer and bill |
| Active organization on the session | The workspace switcher. An agency moves between client workspaces with it. |
| Built-in roles: owner, admin, member | Kept as they are |
| Custom roles (access control and dynamic roles) | `assistant` (delegate), `revops`, `client` (read-only reports) |
| Teams | Pods inside a workspace, such as an SDR team or a recruiting desk |
| Invitations and organization hooks | Invites by email. Hooks set up the assistant and default policies when a workspace is created. |

**Roles and what they can approve**

| Role | Works in the inbox | Approves sends | Approves CRM writes | Changes policy and billing |
| --- | --- | --- | --- | --- |
| Owner | Yes | Yes | Yes | Yes |
| Admin | Yes | Yes | Yes | Policy only |
| Member | Their own | Their own | No, routed to RevOps | No |
| Assistant (delegate) | The exec's, on behalf of | When the exec's policy allows | No | No |
| RevOps | Read only | No | Yes | CRM rules only |
| Client (agency) | Reports only | No | No | No |

**Delegate mode.** An EA is a member with the `assistant` role in the exec's workspace. The exec's mailbox stays connected to the exec's account. Every action the EA takes records two people: who did it and on whose behalf. The exec's policy decides what the EA may send alone and what goes to the exec, for example anything external or any decision over $5,000. The audit log shows who approved each item, which was the EA tester's dealbreaker.

**Client workspaces (agencies).** Each client is its own organization, linked to the agency's organization with a `parent` field. An organization hook adds agency staff to every new client workspace. Each client workspace has its own offer, mailbox pool, lead lists, Unibox and reports. Client logins get the `client` role and see reports only.

## Timmy for other AI apps (MCP), as built (Nov 18, 2026)

Timmy is an MCP server at `/mcp` (streamable HTTP, `@modelcontextprotocol/server` 2.4.0), so a person can use it "headlessly" from Claude (custom connector), ChatGPT (developer-mode connector), Claude Code (`claude mcp add --transport http timmy <url>/mcp`) or any MCP client, with their own AI subscription doing the thinking. No Timmy model is called from it; this is the "Lite mode" path where the person's AI costs us nothing.

- Authorization is OAuth 2.1 from Timmy's own auth server (Better Auth's `@better-auth/mcp`, with `@better-auth/cimd` for client metadata documents and open dynamic registration for clients that still use RFC 7591). Discovery follows the MCP spec: `/mcp` answers 401 with `WWW-Authenticate: Bearer resource_metadata=…`, `/.well-known/oauth-protected-resource/mcp` names the issuer `<url>/api/auth`, and `/.well-known/oauth-authorization-server/api/auth` lists the endpoints. PKCE (S256) always; only authorization-code and refresh grants; clients register as public native clients, so desktop clients' `http://localhost` callbacks and web clients' https callbacks both work.
- The person's side is three pages (`src/live/Connect.tsx`): sign in (only when signed out; the app's name is shown), pick the workspace the app may use (automatic with one), and consent, which says what the app may and may not do. The chosen workspace is the consent's reference and rides in the access token as `workspace`.
- Each request: the token is verified (signature against the auth server's keys, issuer, audience `<url>/mcp`, expiry); then the consent for that app, person and workspace must still exist, and the person must still be a member with a role that may read (`http/mcp.ts`). Disconnecting the app (Rules & settings › Approvals lists connected apps) or removing the member stops it at once, without waiting for the token to expire.
- Tools are Ask's (search and read mail, files, pages, people, commitments, tracked things; draft a reply; propose an email, a reply, a filing, a sorting rule) plus six only an app needs (`agent/mcp-tools.ts`): what's waiting, projects, to-dos (list, add, check off) and putting a thread in a project. Changes go through the same command path as the app's buttons, so every check applies. Each tool call is a run row of kind `mcp`, so what it prepares is traced in the audit log. Sends, filings and rules are prepared at the gateway and wait for the person's OK in Timmy, exactly as from Ask.
- Checked against the official MCP client SDK (`@modelcontextprotocol/client` 2.4.0): it discovered, registered, authorized, refreshed, negotiated protocol 2025-11-25 and called the tools.

## The assistant: runtime, computer, memory

Each workspace's assistant is one agent loop on our servers. It reads every new item, works on requests from Ask and routines, and drives its own computer for long jobs. The loop calls the model through a driver per provider, so a route can change models without changing anything else. The sandbox only runs tools. This is how Rakazo, OpenMausBot, OpenClaw and Hermes all work (see Build vs buy).

| Work | How it runs | Why |
| --- | --- | --- |
| Read each new email, event or file: triage, summary, urgency, ontology facts | Plain code goes first: rules, known senders, and whether anything changed. Only what's left gets one structured Messages API call. The first 30 days go through the regular API, so the first brief is ready in minutes. The rest of the 90-day backfill goes through OpenRouter's Batch API at the model's batch price. | Most mail never needs a model, and the rest has a fixed shape |
| Drafts, decisions, Ask Timmy, nudges, routines | The agent loop in our agent service, streaming AG-UI events over SSE. Each run is a Postgres row with a lease and a fence. It starts the moment the message arrives, survives a crash, and saves a checkpoint when it stops for approval. Routines start runs the same way. Unattended runs can read and draft. They send only what a rule you turned on covers, like a speed-to-lead auto-reply. | One code path for every request, and one approval path |
| Computer jobs: research a lead, fill a portal, build a file | The same loop. Shell and browser tools run in a per-workspace E2B or Daytona sandbox behind a sandbox interface, at about $0.17 an hour for 2 vCPU and 4 GB ([E2B](https://e2b.dev/pricing), [Daytona](https://www.daytona.io/pricing)). The home folder is saved to object storage between runs. The sandbox pauses after 10 minutes idle, and its network is allowlisted. It never holds a real credential: each turn gets a short-lived token, and our servers add the keys. | Computer jobs arrive in phase 3. The agent drives the browser with Playwright through the page's text (its accessibility tree), not screenshots and clicks. So any model on the list can do it, it costs fewer tokens, and it is easier to test. There is no desktop: apps without a web page wait until a real job needs one. Until then, the agent works through APIs only. A box left on around the clock costs about $120 a month per workspace. |

**Sorting mail automatically, as built (Nov 18, 2026, after the first real Gmail test).** Plain code still sorts every new thread first, and a model reads only mail a person wrote. What changed: an owner or admin can now let Timmy file the junk by itself ("Sort junk automatically", in the setup, in Triage and in Settings). It is stored as a rule (a policy row for `mail.modify` with the scope `{sort: "automatic"}`) that names who switched it on and when, so it is "a rule the person set" in the sense of the safety properties. While it is on, threads plain code is sure of (Gmail's Promotions and Social tabs, receipts, calendar replies, system senders such as no-reply addresses, and mailing lists, which go to Read Through) are filed as they arrive. Mail a person wrote, and anything the model suggested, still waits in Triage. Switching it on also files the junk already waiting, **inside Timmy only**; in the mailbox only mail that arrives after the switch is filed, each filing an effect the rule approves (the owner chose this so that turning it on never rewrites months of existing mail in Gmail at once). Addresses a small business's own person might use (hello@, info@, team@) are only a guess and are never filed by the rule. Why: on the first real mailbox, 1,838 of the threads in Triage were suggestions Timmy was sure of, and asking a person to accept them one by one, or in one command larger than the server's limit of 100 filings, did not work. Triage now lists the newest first, and "Accept all … Timmy is sure about" sends them in batches of 100 after a confirmation that says what will change in the mailbox.

**Sorting rules a person writes, and putting an email in a project, as built (Nov 18, 2026).** A rule says which mail (from an address or a whole domain, words in the subject, words anywhere) and what to do (archive it, Read Through, "always show it to me", and/or a project). Plain code applies it exactly as written, before the automatic sort and before any model; the model is never asked whether a rule applies. Where a rule lives: the `rules` slice (`Rule.mail`, `src/state/mail-rules.ts`, shared by the screens and the server). A rule that files mail away (archive, Read Through) is also a policy row (`mail.modify`, scope `{mailRule: <rule id>}`) naming the owner or admin who saved it, so it is "a rule the person set": it files new mail in the mailbox, but only mail whose newest message arrived after the row was made, and switching the rule off or deleting it switches the row off. Mail already waiting in Triage is never filed by saving a rule: it gets the rule as Timmy's sure suggestion and goes when the person accepts it (the owner's earlier choice, "new mail only", applied to rules too). "Always show it to me" files nothing; it outranks any rule or sort that would file the mail away, and Timmy's read of such a thread adds what it asks but keeps the rule's place. Mail a rule files away is not read by the model (it needs nothing), which saves a read per email. A rule with a project puts matching mail (now and as it arrives) in the project when it is in none, with its to-dos. Only owners and admins write rules; the server keeps a rule only in the form its check returns. Rules written in plain words (no `mail` part) that the person added go with each email Timmy reads, outside the tags around the mail, capped at 12 lines; the rules every workspace starts with don't, so a workspace that added none pays nothing extra.

Putting one email in a project is a command (`setProject`) any role that may work the inbox can send: from the email (the project chip, or P) or from its row in Triage; a new project can be made from the picker. Its to-dos follow it. Nothing is written to the mailbox. When the email has an outside sender, an owner or admin is offered "Put new mail from anyone at acme.com in this project too?", which saves a sorting rule (a free mail address, or a colleague, is named by address, never by domain). 

Telling Timmy a rule in Ask ("always archive mail from linkedin.com", "put mail from acme.com in the Acme project", "never archive mail from my accountant") goes through the Action gateway like any other write: the `save_rule` tool proposes an effect of the new kind `rule.save` (domain `rules`, not outbound, never Auto-mode eligible, no executor call outside), the chat shows the rule in words with how much mail it matches now, and nothing is saved until an owner or admin presses Save rule. Its executor then saves the rule, checked again, with its policy row, in one transaction; the rule's id is derived from the effect, so it can't be saved twice, and an effect whose outcome is unknown is confirmed by looking for the rule. A member is told to ask an owner or admin, and a routine (an unattended run) never writes a rule, so mail that asks for one gets nothing.

Learning from how the person files mail: when they move mail from the same company (or person) out of Triage to the same place (archive, Read Through, Follow Up) twice themselves, and no rule covers that sender, Timmy proposes it as a sorting rule, shown at the top of Triage and in Library › Learned rules. Accepting saves exactly the rule shown; declining is remembered so the same offer doesn't come back. Timmy's own filing, and moves to Waiting, don't count.

**Onboarding, as built (Nov 18, 2026).** A new workspace opens on a five-step setup: connect email (Gmail or Outlook), choose how Timmy sorts, connect the calendar (Outlook's comes with it), add files (optional), and choose the morning run time. Each step's state is read from the workspace, so it is the same on every device; coming back from Google's or Microsoft's sign-in page reopens it at the next step. On a real workspace it replaces the demo's "Watch the story" button. The files Timmy lists from a connected Google Drive or OneDrive are now on the Files screen too (Drive › Drive & OneDrive), not only in Ask.

**Reading an email, as built (Nov 18, 2026).** Timmy stores every email's words as plain text, for search, the model and the lists. To read one the way its sender laid it out, the original HTML is fetched from the mailbox when it is opened (`GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID` with the full format, `OUTLOOK_GET_MESSAGE` with the body), cleaned on the server with `sanitize-html` against a fixed list of formatting tags and attributes, and shown in a sandboxed frame with no scripts and a content policy that loads nothing from other sites unless the person asks for pictures. It is not stored. Why: the owner asked for a reader that feels like Gmail (formatted mail, clickable links, full addresses); rendering what was stored as text could not do that, and storing HTML would put sender-written markup in the database for no other use.

**Detecting projects, as built (Nov 18, 2026).** The ontology's missing layer was the project: which threads, people, files and meetings are one piece of work. A scan started from the Projects screen groups the last 90 days by plain code (the outside company domain or personal address a thread is mostly with; among colleagues, a rare shared subject word; meetings by who they invite; files by owner domain and name) and leaves out junk and one-offs. The model names each group from its subjects, people, file and meeting titles (wrapped as outside content), may split one into up to three, and its answer is held to the subjects it was shown. The person reviews a list and a map (the automations canvas's graph library) and keeps, renames, merges or drops each. Kept projects are made like hand-made ones; their threads are tagged, their files and meetings linked (`project_link`), and the keys they were found by (`project_key`) file new mail from the same company or person into them when exactly one project claims it. Why the person confirms instead of Timmy creating projects silently: a wrong guess would clutter everything after it. Why grouping is plain code: it costs nothing, it is the same every time, and no email can steer it. Next: project context in drafts and Ask (a short brief per project), sorting new files and meetings as they arrive, and, with the owner's OK and an approval per project, a Drive folder per project.

**Files inside Timmy, as built (Nov 18, 2026).** A file from a connected Drive or OneDrive opens in Timmy read only, read through its connection when opened and not stored: a Google Doc as HTML built from Google's document structure and cleaned like an email (shown in the same sandboxed frame), a Sheet as a table, Slides slide by slide, Office files from OneDrive as their words. Editing stays in Google's or Microsoft's own app, one click away. Why read only: Timmy holds no edit permission it uses on files, and a second editor beside Google's would be worse than Google's.

**The map, as built (Nov 18, 2026).** People › Map draws the ontology as a network from what Timmy already keeps: people (the 120 most in touch, and anyone on a kept project), their companies (`works_at`), projects with the companies, people, files and meetings they were found by, and open promises on the people they are with. A small deterministic force layout (`src/lib/forceLayout.ts`) puts connected things together; it is the same graph library as the automations canvas. Why bounded: a few hundred nodes stay readable and fast; focus, filters and search reach the rest.

**To-dos from email, as built (Nov 18, 2026).** The one model read of a thread a person wrote also returns up to three to-dos from its newest message: what it asks of the person, with a due date when stated and the sentence it rests on. Each is kept only if that sentence is in the newest message; it becomes a task with a stable id (thread and words), linked to the thread and its project, and marked as Timmy's. Why the newest message only: an older ask has had its chance, and a re-read must not bring back a to-do the person already finished or deleted.

**The morning run, as built (Nov 16, 2026).** A job checks every five minutes for workspaces whose chosen time has come in their own time zone (Settings › Schedule; the zone is taken from the owner's browser the first time). For each, once a day: fetch the last two days of the mailbox again so nothing the triggers missed is left out, read the threads people wrote that are still unread, then draft replies for up to 10 threads that need an answer. It only prepares: it never moves a thread and never sends. What it did shows on Today and in the activity log, and its model cost counts against the share of the monthly limit set aside for work nobody asked for.

**Waiting, as built (Nov 16, 2026).** The drafting call returns, with the reply, what the reply asks the other person for and the date it names ("track"). That becomes the draft's Send & track: sending it moves the thread to Waiting with the item and the date, three working days out when the email named none. The morning run drafts a nudge for a Waiting thread whose date has passed with no answer, five a day at most, and sending the nudge sets a new date. A reply on the thread ends the wait and drops a nudge that was drafted. Commitments the person made themselves ("I'll send it Friday") are not extracted yet.

**Model.** Every model call goes through [OpenRouter](https://openrouter.ai/docs), so each workspace can choose the model that powers Timmy from a list we have tested. Claude Opus 5.5 is the default: $4 input and $20 output per million tokens, $0.20 cached input. It runs with adaptive thinking and an effort level set per route. A fallback model list for outages is supported but empty (as built, Nov 16, 2026): a fallback reads the same mail as the default, so one is added only after it passes the eval and the owner approves it, the same as any model on the list. The auto-mode judge never falls back to another model. OpenRouter passes Claude's prompt caching through ([OpenRouter](https://openrouter.ai/docs/features/prompt-caching)). The account enforces zero data retention, so mail only reaches endpoints that keep nothing ([OpenRouter](https://openrouter.ai/docs/features/zdr)). OpenRouter adds 5.5% when credits are bought ([FAQ](https://openrouter.ai/docs/faq)). A model joins the list only after it passes our eval for tool calling, drafting and refusals. Two routes are not the user's choice. The auto-mode judge is pinned to a model we test, because a weaker judge weakens every approval. Computer jobs need no special model: the agent drives the browser through the page's text, not screenshots, so any model on the list can run them. Every route keeps its system prompt and tool list stable so prompt caching keeps working.

**What a user costs us in model calls** (our estimate, for a user who gets 100 emails a day)

| Route per month | Volume | All Opus 5.5 | Option B (needs your OK after evals) |
| --- | --- | --- | --- |
| Read every item | 3,000 items | about $37 | about $1.40 on Haiku 5.5 |
| Drafts | 300 drafts | about $11 | about $11 (Opus 5.5) |
| Ask Timmy | 150 turns | about $5 | about $5 (Opus 5.5) |
| Computer jobs | capped by the workspace spend limit | $3 cap | $3 cap |
| **Total** |  | **about $56** | **about $20** |

Choosing a model per route is your call. We'd measure Haiku 5.5 on the read route against an eval of 500 real, labeled emails before switching.

Checking with plain code first lowers the read route further: receipts, newsletters and unchanged threads never reach a model. Phase 0 measures how much mail that removes.

**Using GLM-5.2.** [Z.ai's GLM-5.2](https://docs.z.ai/guides/llm/glm-5.2) has a 1M-token context and 128K output, supports function calling, and works with the OpenAI SDK. It is listed at $1.40 input and $4.40 output per million tokens, and US hosts on [OpenRouter](https://openrouter.ai/z-ai/glm-5.2) charge as little as $0.45 and $1.44. Third-party sources say the weights are open under MIT; Z.ai's page doesn't say. Through OpenRouter it becomes one more choice on the model list once it passes the eval. Tools, the Action gateway and AG-UI stay the same.

| Route | GLM-5.2 fit | Why |
| --- | --- | --- |
| Read every item | Possible, after the eval | About $5 a user a month on the cheapest US host, against about $1.40 for Haiku 5.5 and $37 for Opus 5.5 (our estimate) |
| Drafts and Ask | Only if it matches on truthfulness | Made-up claims were a dealbreaker in the simulation. The eval has to show it doesn't invent. |
| Computer jobs | Yes, in our own sandbox | GLM-5.2 can't take images, but computer jobs read pages as text, so it can run them in the same sandbox. |

The data question matters more than the price. Gmail data sent to a model provider has to be named in Google's verification and our subprocessor list. Many business buyers won't accept a processor based in China. If we use GLM-5.2, it should run on a US or EU host under a DPA (Together, Baseten, DeepInfra, Mistral) or on our own GPUs, not on Z.ai's API. Self-hosting a model of about 750B parameters (about 40B active) needs a multi-GPU node, which only pays off at high volume.

**Benchmarks, checked Nov 16, 2026.** [Artificial Analysis](https://artificialanalysis.ai/models/glm-5-2) now marks GLM-5.2 as deprecated and lists no independent score for it. Its successor, [GLM-5.3](https://artificialanalysis.ai/models/glm-5-3), is text only and has open weights under a custom license with commercial restrictions. On Artificial Analysis's Intelligence Index it scores 32 at max effort and 23 at low. [Claude Haiku 5.5](https://artificialanalysis.ai/models/claude-haiku-5-5) scores 36 at max and 19 at low, takes images, and costs $0.077 per million tokens blended against GLM-5.3's $0.90 (that blend is mostly cached input, which is why it sits below Haiku's $0.10 list price). The GLM-5.2 scores Z.ai published (81.0 on Terminal-Bench 2.1, about 91 on GPQA Diamond) are its own and haven't been checked independently. Our email eval should decide, not these scores.

**Memory and skills.**

- **Memory:** revisioned Markdown in Postgres for each workspace: preferences, writing style, standing instructions. A run takes a frozen snapshot of it at the start, so writes during the run don't break prompt caching; the next run sees them.
- **Skills:** how this workspace does a weekly review, a quote or a showing. Each is a folder the agent loads only when it needs it.
- **Phase 3:** a background review keeps memory and skills up to date. It can use only the memory and skill tools, and its changes can be undone.
- Credentials never go into memory.

**The approval loop.**

- **Effect records.** No tool that changes something outside Timmy runs directly. It creates an **effect record** (kind, payload, preview, who it's for, risk, idempotency key) and the run pauses: it saves a checkpoint, moves to waiting and posts the approval card.
- **Resume.** Once someone approves, the run picks up and replays exactly the approved call. The record moves through intended, approved, executing and completed, so nothing runs twice.
- **Auto mode.** A judging model decides routine cases. It sees only the user's own words, never fetched mail or web content. It answers "ask" when unsure, and it gets stricter once a run has read outside content. As built (Nov 16, 2026): Auto mode is off by default and covers one thing, filing the mail thread the person has open on screen (a label, or archive) in their own mailbox when they ask for it in the chat. That limit is enforced in code before the judge is asked: one action per request, and only on the open thread. The judge is told the action in fixed words (“Move one mail thread to the archive in the user's own mailbox”) and never the thread's subject or sender. A run nobody is watching cannot use it, and anything that reaches another person is never put to the judge at all.
- **Always a person.** Sends, posts, payments and invites need a person unless a rule you wrote covers them.
- **Never allowed.** A never-list blocks moving money, signing and deleting accounts.
- **Limits.** Each workspace has caps on concurrent runs and on monthly model and computer spend.
- **Undo.** Sends wait 30 seconds so you can undo them, and everything stays in the audit log.

## Ontology: a map of each workspace's world

Each workspace gets its own ontology: the people, companies, deals, projects, commitments and documents in the user's work, and how they connect. We build it with our own extraction pipeline and borrow the data model from [NVIDIA Auto Ontology](https://github.com/NVIDIA/auto-ontology). We don't run Auto Ontology itself as the engine, for three reasons:

- It reads only SQL databases (10 connectors, from Postgres to Snowflake). It has no ingestion for email or documents.
- It has no tenant model.
- Its README says the API trusts a user-id header that the frontend forwards, and the ingestion endpoints have no authentication.

It is Apache-2.0, at version 1.2.0 with 13.1k stars, and it doesn't accept outside contributions.

**What we take from Auto Ontology:**

- Its three building blocks. *Terms* are concepts with synonyms ("Acme renewal" = "Acme 2027"). *Attributes* are reviewed fields and measures. *Relationships* are typed links.
- The human **Certify** step.
- The `check_answerable` gate, which runs before the assistant answers from data.
- Ossie YAML export, so a workspace can take its ontology elsewhere.

**What the ontology holds**

| Kind | Examples | Comes from |
| --- | --- | --- |
| Core types (every workspace) | Person, Organization, Project, Task, Commitment (who owes what, by when), Meeting, Document, Thread | Mail, calendar, Drive, tasks |
| Trade types (picked at sign-up, then learned) | Deal and Lead (sales); Candidate and Role (recruiting); Property and Showing (real estate); Job and Site (home services); Client and Invoice (consulting, agencies) | Mail, CRM, lead sources, forms |
| Relationships | works at, owns, waiting on, promised by, part of project, mentioned in, booked for | Extraction, with the message or file that proves it |
| Terms | Synonyms and nicknames for the same thing | Extraction, then confirmed by the user |

**How it is built and kept current**

1. **Seed at sign-up.** The trade the user picks loads a starter schema, sample fields and templates. This also fixes the "built for someone else" complaint from the simulation.
2. **Backfill.** The last 90 days of mail, calendar events, Drive titles and CRM records go through extraction. This runs on OpenRouter's Batch API at the model's batch price. Every fact carries evidence: the source item's id and the quote it came from.
3. **Discover.** Entity types and fields that don't fit the schema are grouped together and proposed to the user. For example: "You track properties with an address, a price and a showing date. Add them?"
4. **Certify.** The user accepts, renames or rejects each proposal in one review screen. Only certified types drive fields, templates and CRM mapping.
5. **Stay current.** Each new email, event or file is extracted within a minute of sync. Entities are matched on email address, then domain, then name plus embedding similarity. When two sources disagree, the conflict is shown to the user and the assistant doesn't pick a side.

**How it is used:**

- Drafts are grounded in facts that carry citations.
- Ask Timmy answers questions and says "I don't know" when `check_answerable` fails.
- Urgency scoring uses deal value, VIPs and promised dates.
- Each trade gets its own fields and templates.
- Ontology types map onto HubSpot and Salesforce objects for CRM sync.

**Where it lives:** Postgres tables for entities, relationships, terms and evidence, with pgvector for embeddings and row-level security on `workspace_id`.

**As built, first version (Nov 16, 2026).** Four tables (`entity`, `relation`, `evidence`, `term`) with row-level security. The core types Person, Organization, Meeting, Document and Commitment are built; Project, Task and Thread stay where the screens already keep them.

- **Plain code builds the map.** Every stored item is looked at once: who wrote a message, who it was sent to, who was invited to an event, who owns a file. A company comes from an address's domain unless it is a personal-mail domain. Mailboxes nobody sits behind (no-reply, billing, newsletters) are not people. No model is called, so this step costs nothing and cannot be steered by what an email says.
- **A model adds only promises**, in the same single read each thread already gets. A promise is kept only if the sentence it rests on is really in a stored message from the person said to have made it; otherwise it is dropped.
- **Evidence is a foreign key.** Each entity and link points at the item it came from. When an account is disconnected or mail passes its retention, the items are deleted, the evidence goes with them, and whatever nothing supports any more is removed.
- **Where it shows.** People from the mail appear on the People screen as suggestions, with company and how often they wrote; a contact someone typed or tracked is never overwritten. Ask has `lookup_person` and `list_commitments`, both returned as outside content with the sentence behind each promise.
- **Not built yet:** matching by embedding, showing conflicts between sources, the batch backfill through a model, re-reading old mail when a kind is accepted, and CRM mapping.

**Kinds for the workspace's trade, as built (Nov 17, 2026).** Each trade has its kinds with a short list of fields: sales, Deal and Lead; recruiting, Candidate and Role; real estate, Property and Showing; home services, Job and Site; consulting and agencies, Client and Invoice. They start as suggestions. Only an owner or admin accepts one (People › What Timmy tracks), and only accepted kinds are extracted.
- **Same single read.** The one model read each thread already gets also returns, for accepted kinds, the things the thread mentions with their fields and the sentence each rests on. The server keeps a thing only if that sentence is in the thread and a field only if its value appears there. Repeats merge on kind and first field (ignoring capitals, spacing and punctuation); a thing's fields are recomputed from its evidence, newest email first, so deleting a message removes only what it gave. The read's output limit went from 900 to 1,200 tokens.
- **Discovery is counted, not trusted.** The same read may name up to two kinds of thing that fit nothing accepted. Each is checked like a thing and counted once per thread; seen in three threads, it becomes a suggestion with up to three examples and their sentences. A dismissed or stopped kind is not suggested again.
- **The review screen** lists suggestions (accept, accept under another name, dismiss), tracked kinds (rename, remove a field, stop tracking, which removes what was learned), and each kind's things with the sentence and the email behind every one. Everyone who can read the workspace can look.
- **Ask** has `find_things`, returned as outside content.
- **Not built:** re-reading old mail when a kind is accepted; matching "Acme" with "Acme Corp"; bringing back a dismissed kind from the screen. No real model has read the longer prompt yet.

**Decisions, as built (Nov 16, 2026).** When an email asks the person to choose or approve something, the read step returns the question, two or three answers and the figures that bear on it. The server keeps a figure only if its sentence is in the thread, and shows the card in Approvals. Timmy never picks. Choosing an answer records it and starts a reply draft that says so; the draft waits for Send like any other. If the person answers the thread themselves, the card closes. A question that was already decided makes no new card: the thread shows what was decided and when.

**Running Auto Ontology itself (phase 3).** For agency and enterprise workspaces that connect a SQL warehouse, we run Auto Ontology as a sidecar behind our own auth, one instance per tenant. It maps warehouse tables onto the same terms.

## Connections: Composio for every app

Every app connection is a Composio connect button. That covers Gmail, Google Calendar, Drive, Outlook, OneDrive, HubSpot, Salesforce, Follow Up Boss, Slack, Notion and lead sources. The agent pulls data through Composio into the workspace store and acts through Composio tools. [Composio](https://composio.dev/pricing) lists 1,700+ apps and supports MCP. Each Timmy user is a Composio `user_id`, and each connection is a connected account under an auth config.

**How data comes in**

1. **Connect.** The button opens Composio's connect page. It can carry our brand, but the host stays connect.composio.dev ([docs](https://docs.composio.dev/docs/white-labeling-authentication)).
2. **Backfill.** A durable job pages through the last 90 days with Composio tools. It stays under Gmail's 6,000 quota units per minute per user ([quota](https://developers.google.com/workspace/gmail/api/reference/quota)).
3. **Stay current.** Composio [triggers](https://docs.composio.dev/docs/triggers) POST each new event, signed, to our webhook. Outlook's triggers are pushed by Microsoft as they happen. Composio's Gmail, Google Calendar and Drive triggers are polling triggers that check about every 2 minutes (as Composio's trigger list describes them, Nov 16, 2026).
4. **Normalize.** The ingest job fetches the full item, stores it as a workspace item (message, event, file, record), and sends it to extraction for the ontology.
5. **Repair.** A nightly reconcile catches events that went missing. Google says its push channels are "not 100% reliable" ([Calendar](https://developers.google.com/workspace/calendar/api/guides/push)).

**As built (Nov 16, 2026).** Gmail, Outlook, Google Calendar and Google Drive can be connected; every other app shows as coming soon, and the API refuses to connect an app until Timmy reads it or acts through it. A workspace has one everyday mailbox, Gmail or Outlook, the one its owner (or another member who may connect apps) connects: it is who "me" is in that workspace's mail, and every send says which mailbox it leaves from. A mailbox per member, which the roles section assumes for teams, is not built yet.

Mail code is written once against a small mailbox interface (list a page since a date, fetch a thread, send, find in Sent, file) with Gmail and Outlook behind it. Outlook differs in four ways that the interface hides. A thread is a conversation listed by filter. A message's place is a folder, translated into the same words Gmail's labels use. Filing is written as categories with the same three names, and Archived is the Archive folder. A reply is created as a draft, addressed to exactly the approved people, read back, and only then sent, because Outlook's own reply chooses the recipients. Outlook bodies arrive as HTML and are stored as text. Outlook's calendar and OneDrive are not read yet.

**Calendars, as built (Nov 17, 2026).** Google and Outlook calendars sit behind one interface, like the mailboxes. An Outlook connection is the person's calendar as well as their mail (Outlook is asked for `Calendars.ReadWrite` in addition to mail and profile). Both are read for two weeks back and two months ahead, on connect, when the calendar announces a change, and after Timmy's own writes; there is no nightly re-read yet. A new event is the effect `calendar.create`; changing a synced event's time, title, guests or note is `calendar.update`, and removing it is `calendar.delete`. With guests, before or after, each waits for approval like an email and the card names who is told and the old and new time; without, it is the person's own action with the undo window. The executor reads the event first and refuses one that someone else organizes, or one that has gained a guest the approver was not shown; an unknown outcome is settled by reading the calendar, never by writing again. One change per event at a time. A new event goes to the person's own calendar if they connected one, otherwise the workspace's, and among several to the one connected first.

**Changes made in the mailbox itself, as built (Nov 17, 2026).** Filing is two-way. A thread archived, labelled with one of Timmy's three labels or categories, read, deleted or restored in Gmail or Outlook follows in Timmy. Each look lists where the last three days of mail sits (labels only, no bodies) in one or two calls, compares it with what the mailbox showed last time and applies only the difference straight to Timmy's state: no effect record and no call back to the mailbox, so there is no loop. A filing of Timmy's own still on its way is left alone until it settles. Looks happen when mail is ingested, with the nightly check and the morning run, when the app is opened, and every ten minutes while someone is using it, about 500 to 1,000 calls a month for an active mailbox.

Drive and OneDrive are read-only: a list of files changed in the last 90 days and since, plus files shared with the person (Drive), kept current by events, a change feed (OneDrive) and a nightly check. As built (Nov 17, 2026), the text of Google Docs, Sheets and Slides and of Word, Excel and PowerPoint files changed in that window is read in a bounded pass (at most 40 files a pass, re-read only when a file changes, 24,000 characters each; a file the provider fails on outright three passes running is set aside with the reason until it changes, so it can't hold up the rest) into Postgres's full-text index, so Ask finds files by name or by words inside them, with a short passage as outside content. The text goes with the file and with the account. Office files are read by a small reader of our own with strict limits; downloads only over https from an allowed public host. Drive and OneDrive accounts can only call read-only tools. PDFs, and Office files kept in Google Drive, are listed but not read. OneDrive asks Microsoft for Files.Read, offline_access and User.Read only.

**Organizing into projects on its own (built Nov 18, 2026).** New mail: plain code first (a project's own people and companies); otherwise the one model read each new thread already gets is shown the open projects as outside content and may name the one the thread is plainly about. The thread and its to-dos go in, with a history line, and nothing already placed moves. New files: plain code links a file in no project to the one project its owner, name or words plainly point to (owner strongest, words weakest; a tie does nothing). Both stay inside Timmy.

**Editing a Drive file in Timmy (built Nov 18, 2026).** A Google Doc, Sheet or Slides deck opens in Timmy's own editor (the Craft apps) as the Office file Google exports; a Word, Excel, PowerPoint or PDF file kept in Drive opens as it is (up to 10 MB). File › Save goes back to the Drive file:
- **The write.** It goes through the Action gateway as `file.update` (domain `files`, no hold, never Auto). The person's press of Save is the approval.
- **Checks before it is sent.** The server checks:
  - that the upload is the person's own and of the file's kind;
  - that Drive's copy is unchanged since it was opened (its last-changed time; a change by someone else stops the save until the person chooses to save over it);
  - in the executor, the approved hash and Drive's version once more.
- **The call.** Composio's `GOOGLEDRIVE_UPLOAD_UPDATE_FILE`, through `writeTool`, the only path past the read-only guard, and only the gateway's executor takes it. Drive keeps the earlier version in its version history.
- **OneDrive.** Opens to read and download; saving back to OneDrive is not built.

**Composio only (owner's decision, Nov 16, 2026).** Every outside app, including CRMs and lead sources in phase 2, connects through Composio. An app Composio does not offer is skipped for now; that includes the enrichment provider that uses its own token.

**The new screens (page editor, automations, website chat, pipeline board)** and how their backends are built are described in [ui-additions-backend.md](ui-additions-backend.md). As built (Nov 17, 2026):
- **Automations run.** An owner or admin switches one on; each switch-on freezes a version. Triggers: a new email in the inbox, or a schedule. Steps: create a task, notify, draft a reply, ask me first, add to a doc, if/else, wait, and Send. Send only ever puts the reply that run drafted into Approvals, addressed to whoever wrote the email, and a Send approved by a rule or by Auto mode is refused: a person always decides. "Ask me first" is its own effect kind (`automation.ask`) that reaches nobody and goes through the same approve and decline path. One run per trigger event; a lease so no step runs twice; three retries per step; five failures in a row or 100 runs in an hour switch an automation off with the reason shown. A dry run writes nothing and calls no model. Blocks that cannot run yet (forms, Slack, texts) say so and refuse switching on.
- **The website chat runs.** A business pastes one line of code into its site. The loader adds a sandboxed frame that only the named site may show, served from the chat's own address when `CHAT_PUBLIC_URL` is set (that host answers nothing but the chat and never sets a cookie), otherwise from the app's address. A proof-of-work check runs in the visitor's browser before a conversation's first message, and per-address limits are counted in Postgres so they hold across servers. A visitor's request names no workspace: the workspace comes from the site key and the conversation from a token signed for that conversation. Replies come from the chat's own settings by plain rules, never a model, and each is an effect record (`chat.reply`) approved by a rule that exists only while an owner or admin has the chat switched on; the database refuses to show a reply without one. A teammate can take over and reply. Leads from chats never overwrite a lead from elsewhere. Limits per visitor, address, conversation and day; conversations kept 12 months by default.
- **Pages keep their versions.** Before a page's contents change, what it held is kept: at most one copy per five minutes of ordinary editing, always one before Timmy writes into it and before a restore. The newest 100 per page are kept, none older than 90 days. Pages in the trash are deleted for good after 30 days, counted on the server's clock, with their sub-pages, versions and the links to them.
- **Pictures and attachments are stored in the bucket.** Pictures on pages and covers are uploaded and saved as references; files travel through the API both ways and are served to members only, as sandboxed downloads. An email carries up to 10 files: the approval card lists them, the effect record holds each file's fingerprint, and at send time the bytes must still match or nothing is sent (Gmail through Composio's file staging; Outlook as a draft whose attachments are checked before it is sent). Nothing is scanned for viruses yet.

**Composio toolkit versions are pinned in config.** Composio renames tools and changes argument types between versions (Outlook's send tool took `to_email`, then `to`; the calendar tool's `send_updates` went from yes/no to a word). The server runs each toolkit at the version its code was checked against, and a script (`server/scripts/check-composio.mts`) checks every tool and event the server uses against Composio's API before a version moves forward. The nightly reconcile is built for mail: it fetches the last two days of each connected mailbox again and takes in anything the triggers missed. Filing is written back: a thread sorted in Timmy gets a Gmail label or an Outlook category (“Timmy Follow Up”, “Timmy Waiting”, “Timmy Read Through”) and stays in the inbox, and an archived thread leaves it. The write is a `mail.modify` effect approved by the person's own action. It is one-way for now: changes made in the mailbox itself are not read back. Mail is sent exactly as approved: the provider is told not to append the account's signature. A new event added in Timmy is written to Google Calendar as a `calendar.create` effect: it gets the undo window, and with guests it is approved like an email because Google then sends invitations. Changes to and deletions of existing events are not written back yet.

**How the agent acts.**

- Composio tools reach the agent through MCP, from a curated allowlist per trade.
- When a workspace has more than about 20 tools, the agent gets a catalog it searches and loads from, instead of every schema in every prompt.
- Reads run freely. Every write (send, invite, CRM update, post) becomes an effect record that waits for approval, the same as Timmy's own tools.
- The agent never holds a Composio key. Each turn gets a short-lived token, and our servers add the real one.

**What we decide before launch**

- **Composio's own Google and Microsoft apps to start.** Connect buttons use Composio's managed OAuth apps, so at launch we register no OAuth app for mail, calendar or files. Google's restricted-scope review and the yearly CASA assessment fall on whoever owns the app. The trade-offs: the consent screen says Composio, not Timmy, and Composio's default app shares quota across all its customers. Composio recommends your own app for production ([Composio](https://docs.composio.dev/docs/custom-auth-configs)). When we switch, each user reconnects once, and the review and CASA then apply to Timmy ([Google](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)).
- **Least scope.** As built (Nov 17, 2026), Outlook is asked for mail, calendar and profile permissions only (`COMPOSIO_SCOPES_OUTLOOK`); Google stays at Composio's defaults until Composio says which narrower sets its app holds. The plan was: we ask for `gmail.modify` (restricted) only when the user turns on triage. Sending alone needs `gmail.send`, which is only sensitive. For Drive we use `drive.file` where it is enough. As built (Nov 16, 2026): this holds for Outlook, where Timmy asks for mail and the profile only instead of Composio's wider default. It does not hold yet for Google: Composio's managed Google app asks for full mail access plus contacts and profile details for Gmail, and full Drive access for Drive, and those sets are used as they are until Composio confirms which narrower ones its app is approved for, or we move to our own Google app.
- **Microsoft tenants.** Under Microsoft's default consent policy (as documented in Aug 2026; tenants can differ), admins must consent to mail and calendar access ([Entra](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies)). The connect button explains this and sends a consent link to the admin.
- **Call volume and cost.** Composio Standard is $18 per seat with 10k calls, then $5 per 1,000 calls. A user who gets 100 emails a day makes about 3,000 fetches a month, plus calendar, files and sends. At list price that is roughly $15–20 a month per user (our estimate), which would be the largest cost after models. Phase 0 measures real calls per user. If sync costs more than $3 per user a month, we negotiate volume pricing or move bulk mail and calendar sync to a native lane: direct Gmail and Graph calls with our own OAuth apps, which means leaving Composio's managed apps first. Composio keeps the buttons, the long tail of apps and the agent's tools. Whether Composio exposes tokens for our own auth configs is still to verify.

## Sales stack: CRM, sending, calls, lead sources, enrichment

The sales features are where the simulation said users pay. They are also where the outside rules are strictest. Each one runs through Composio where possible and through the Action gateway always.

| Capability | How we build it | What gates it | Source |
| --- | --- | --- | --- |
| HubSpot and Salesforce sync | Composio tools and triggers map CRM objects onto ontology types. Every deal or stage write is an Action that RevOps approves. Call and email activity can be pre-approved by policy. | HubSpot marketplace apps get 110 requests per 10 seconds per account. A listing needs 3 active installs, then about 10 business days of review. Salesforce now requires External Client Apps for new integrations. | [HubSpot limits](https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines), [listing](https://developers.hubspot.com/docs/apps/developer-platform/list-apps/listing-your-app/app-marketplace-listing-requirements), [Salesforce, third-party](https://www.getclientell.com/salesforce-blogs/salesforce-connected-app-changes-spring-26) |
| Cold email | **Decided Nov 16, 2026 (owner's decision, replacing the secondary-domain sending service): Timmy never sends cold email through a mail provider's API.** Timmy writes the email. Pressing Send opens the mail app's own compose window (Gmail or Outlook) with the recipient, subject and text filled in, and the person sends it from there. Timmy marks the lead as contacted when sync sees the email in Sent, and replies from leads land in the Unibox. A sequence cannot send itself: each email is one click by a person, and the daily limits are guidance, not enforcement. | Google forbids apps that send "unsolicited commercial mail" through its user-data APIs. Sending by hand from the person's own mail app keeps Timmy, and the Google app the mailbox is connected through, out of that. The sender's own domain reputation is still theirs to look after. | [Google policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy), [sender rules](https://support.google.com/a/answer/81126) |
| Texts | **Deferred Nov 16, 2026 (owner's decision): Twilio is skipped for now.** Texts and the dialer stay demo-only, and the API refuses them on a real workspace. The plan when it returns: Twilio Messaging, with a consent ledger per lead. Quiet hours and STOP handling are built in. | Each customer registers an A2P 10DLC brand and campaign: $4.50 brand fee, $41.50 vetting, and days of review. The FCC's revised opt-out rules take effect Nov 25, 2026, and opt-outs must be honored within 10 business days. | [10DLC](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv), [fees](https://www.twilio.com/docs/trust-hub/registrations/a2p-10dlc-brand), [TCPA](https://www.nelsonmullins.com/insights/alerts/fcc-download/all/fcc-adopts-overhaul-of-tcpa-consent-revocation-rules-revoke-all-narrowed-exclusive-opt-out-methods-permitted-and-fraud-alert-exemption-expanded) |
| Call list and dialer | Twilio Voice from the browser, at about $0.018 a minute to US phones. The call list comes from campaign call steps, callbacks and new form leads. Notes, callbacks and outcomes become CRM activity. | Recording needs every party's consent in about 11 states, including CA, FL, IL, PA and WA. | [Twilio voice](https://www.twilio.com/en-us/voice/pricing/us), [recording law](https://www.rcfp.org/introduction-to-reporters-recording-guide/) |
| Speed to lead | A webhook for any form, plus lead-source connectors. Push and SMS alerts go to the agent. New leads appear on Today with a running clock. | Follow Up Boss: API key, system registration, 250 requests per 10 seconds, and new leads go through `POST /v1/events`. Zillow has no public lead API, so we either join its partner program for Tech Connect or parse its lead emails. Realtor.com delivers leads through its Lead Delivery API, which needs Connections Plus. | [Follow Up Boss](https://docs.followupboss.com/reference/events-post), [Zillow Tech Connect](https://help.callaction.co/en/articles/1061769-zillow-tech-connect), [Realtor.com](https://help.rechat.com/guides/crm/contacts/adding-contacts/connect-to-lead-sources/connect-to-realtor) |
| Enrichment and finding leads | Agent tools `find_leads(icp, filters, count)` and `enrich(lead)`. They call Treg by default, which picks the best data provider for each lookup. If the workspace connects its own provider (Apollo, Clay, People Data Labs, Hunter) through Composio, that provider takes over. Every address is verified before the first send. | Provider terms and credits. Verification costs about $19.50 per 1,000 checks pay-as-you-go. Provenance is stored per field so GDPR and CCPA requests can be answered. | [ZeroBounce](https://www.zerobounce.net/email-validation-pricing) |
| Agencies | Client workspaces, each with its own mailbox pool, offer, leads, Unibox and reports. Client logins are read-only. Bulk mailbox import and DNS checks are included. | Per-client sending domains and DMARC alignment |  |

**Leads the agent finds on its own.** The assistant can add and enrich leads without asking, up to a daily cap (25 by default) and inside the monthly credit budget. Both are set in Connections. Adding a lead only changes the workspace's own list and can be undone. Contacting a lead never happens on its own: Timmy drafts, and the user sends. Each found lead records its provider and the search that produced it.

**Treg for data.** [Treg](https://treg.to/) is a pay-per-call marketplace of data and tools for AI agents: more than 4,100 endpoints from 127 providers behind one token, open source under Apache 2.0. Every workspace has it on by default. Following Treg's guide for products, Timmy holds one Treg team token and tags every call with the workspace in the `X-Treg-Meta` header. Our code sets that tag, never the model ([integration guide](https://treg.to/integrate.md)). A per-workspace daily cap comes from Treg's budgets endpoint, and `X-Treg-Route-Max-Cost` caps each call. Costs come back in `X-Treg-Cost-Micro` and count against the workspace's enrichment budget. The agent uses Treg's routed lookups, which pick the provider and fall back on failure, and only catalog tools, never raw upstream URLs. v1 uses Treg only to look things up; a write through Treg would be an effect record like any other.

## Safety, security and compliance

Timmy reads people's mail and can act for them. The trust testers gave it ("nothing goes out without my OK") is the product, and the backend has to earn it the same way.

| Area | What we do |
| --- | --- |
| Tenant isolation | Every row carries `workspace_id`, and Postgres row-level security enforces it. The API runs as a role that can't bypass it, and the system role needs a separate key. (As built: the two are separate database roles. Since Nov 17, 2026 each can sign in with its own separately held credential (`TIMMY_APP_DATABASE_URL`, `TIMMY_SYSTEM_DATABASE_URL`), and the server refuses to start if the app's credential signs in as a role that can bypass row-level security. Until the owner switches to them, the app role's password is derived from the owner's inside the server, as in phase 0; the steps are in STATUS.md.) A test suite tries cross-workspace reads on every endpoint. Each workspace gets its own sandbox; none are shared. |
| Secrets | OAuth tokens live in Composio, or in a KMS-encrypted vault for the native lane. The agent and the sandbox only ever get short-lived tokens per turn; our servers add the real keys. (As built in phase 0 there is no sandbox yet, and the agent's tools run inside our own server and never see a key, so no token is issued; per-turn tokens arrive with the sandbox in phase 3.) Secrets never go into memory, prompts or logs. |
| Prompt injection | Mail, web pages and documents are data, not instructions, and the prompt marks them as such. Tools are scoped per route. Every write is an effect record behind the gateway. The Auto-mode judge never sees outside content, and a run that has read outside content is gated more strictly. Sandboxes run with a network allowlist. |
| Hard limits | Moving money, signing, deleting accounts and changing security settings are blocked outright, not just put up for approval. Each workspace has caps on concurrent runs and monthly spend. As built (Nov 16, 2026): reading mail on its own may use at most half of a workspace's monthly limit, so incoming mail cannot silence Ask; one account can create three workspaces; and one ceiling covers the whole service's model spend for the month. |
| Google | While we use Composio's Google app, the app is Composio's, so Google's review of it is Composio's to hold. Composio says it "registers and maintains the Google OAuth app" and that there is "no verification on your end" ([Composio](https://composio.dev/blog/ship-gmail-integration-in-minutes)); it does not state outright that the app has passed the restricted-scope review and CASA. Unconfirmed until asked in writing or seen on a real connect (corrected Nov 16, 2026: an earlier version of this row said Composio "carries" both). Once we move to our own app: restricted-scope verification plus a CASA assessment from an approved lab, repeated at least every 12 months, with a 100-user cap until it is done. Data from Google APIs is never used to train general models ([policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)). |
| Microsoft | Publisher verification through the Microsoft partner program. Each customer tenant's admin consents to mail and calendar access. |
| Email law and sender rules | CAN-SPAM: a postal address, and opt-outs honored within 10 business days. Gmail and Yahoo: SPF, DKIM, DMARC, one-click unsubscribe and spam under 0.3%. |
| Texts and calls | TCPA consent ledger per lead. The revised opt-out rules apply from Nov 25, 2026. Call recording is off by default, and all-party consent applies in the states that require it. |
| Privacy | Export and delete per workspace. Disconnecting an app deletes its cached content within 30 days. (As built, Nov 16, 2026: disconnecting takes that account's mail and events off the screens and out of Ask at once and deletes the stored copy by a job; a deleted workspace is closed at once and every row of it is removed after 30 days. Website chat conversations are kept 12 months by default (1 to 24, the owner's choice) and a visitor's network address is not stored; pages in the trash are deleted for good after 30 days; earlier versions of a page are kept at most 90 days. Export is not built yet. Drafts for the data processing agreement, the subprocessor list, the security measures as built and a penetration-test brief are in `docs/legal/`.) Data processing agreement, published subprocessors (OpenRouter and the model providers it routes to, Composio, Twilio, the sandbox provider, Railway), a US region at launch, and an EU region once that open question is decided. |
| Audit | An append-only log of every effect record: who asked, who approved, on whose behalf, what ran, and its undo. Delegate mode and RevOps approvals depend on it. |
| Certification | SOC 2 Type I by the paid launch, and a Type II observation window in phase 3. |

## Data model and APIs

The frontend's state is already the data model. Each slice becomes a set of tables, and each reducer action becomes a command the API accepts.

| Table group | Tables | Holds |
| --- | --- | --- |
| Identity (Better Auth) | user, session, account, organization, member, invitation, team, organizationRole | Who someone is, their workspaces and their roles |
| Connections | connection, sync\_cursor, webhook\_event | Composio connected-account ids, trigger ids, sync cursors (history id, sync token, delta link) and raw events, kept 7 days |
| Items | item, item\_body, attachment | Every message, event, file and record in one normalized shape. Bodies are stored separately so they can expire. |
| Work | thread, task, project, commitment, decision, note | What the screens show: Waiting is a commitment, Decided is a decision |
| Ontology | entity, relationship, term, evidence, schema\_proposal | The workspace map, each fact with its source |
| Sales | deal, lead, lead\_list, campaign, step, variant, mailbox, send, reply, call, consent, lead\_source | Outbound, the Unibox, speed to lead, calls and the consent ledger |
| Actions | run, run\_checkpoint, effect, approval, policy, held\_for, audit\_log | Runs with a lease and a checkpoint. Every write is an effect record (intended, approved, executing, completed) with its payload, preview, requester, approver, idempotency key and undo-until. |
| Agent | conversation, memory\_doc, memory\_revision, skill, routine, sandbox\_home, usage, limit | Chat history, revisioned memory, skills, schedules, saved sandbox homes, and tokens, credits and spend limits per workspace |

**APIs**

As built (Nov 16, 2026), every route is under `/api` on the same origin as the app (see Architecture), so the paths are `/api/v1/...` and `/api/hooks/...`. Sign-in is at `/api/auth/*` (Better Auth).

- `POST /api/v1/commands` takes the same `{ type, ...payload }` the reducer takes today, with an id. It returns the resulting patches, and conflicts resolve in the server's favour. The same id from the same person always gets the same answer.
- `GET /api/v1/state` returns the workspace's state in slices, and `GET /api/v1/stream` is a single SSE connection per tab that carries the patches after it.
- `POST /api/v1/agent/runs` streams AG-UI events: text, tool calls, widgets, done. The chat UI already speaks it.
- `POST /api/v1/actions/{id}/approve` and `/decline` record who decided. Delegate and RevOps routing set who is allowed to call them. The Approvals screen makes the same decision through a command.
- `GET` and `PATCH /api/v1/settings` (the model, the monthly spend limit and the number of runs at once, each within a ceiling the server sets; the kill switch), `POST /api/v1/connections/{app}/connect` and `/disconnect`, `GET /api/v1/audit`, `GET /api/v1/usage`.
- Added Nov 16 and 17, 2026: `GET /api/v1/automations/test-emails`, `GET /api/v1/chat/conversations` (older conversations, paged) and `GET /api/v1/chat/loader`; `POST /api/v1/pages/{id}/summarize`; `GET /api/v1/pages/{id}/versions`, `GET .../versions/{n}`, `POST .../versions/{n}/restore` and `GET /api/v1/pages/trash`; `POST /api/v1/automations/{id}/test` (dry run) and `GET /api/v1/automations/{id}/runs`; `GET /api/v1/tracked`, `GET /api/v1/tracked/{id}/things`, `POST /api/v1/tracked/proposals/{key}/accept` and `/dismiss`, `PATCH` and `DELETE /api/v1/tracked/{id}`; `GET /api/v1/chat/conversations/{id}/messages`.
- The website chat's public side, with no sign-in: `GET /chat.js` (the loader), `GET /chat/frame` and its script and stylesheet, and `GET /api/public/chat/{siteKey}/config`, `POST .../messages` and `GET .../stream`. The workspace comes from the site key only, and the conversation from a signed token sent in the body or a header, never the address.
- Incoming webhooks: `/api/hooks/composio` (signed, built). `/api/hooks/twilio`, `/api/hooks/forms/{id}` and `/api/hooks/fub` come with the sales phase.
- Outgoing webhooks and a read API (phase 3) for agencies and Zapier-style automations.

## Build vs buy, and what to borrow

We buy the plumbing and build what makes Timmy different: the approval model, decisions and Waiting, the ontology, and the sales workflows. All six assistants you named exist. The list matches word for word the one in [Rakazo's README](https://github.com/elie222/rakazo), which calls itself an alternative to all six.

**Assistants to learn from**

| Product | Maker, status | What Timmy takes | Source |
| --- | --- | --- | --- |
| Meta Muse | Meta, US launch Sep 8, 2026 | A separate Sentinel agent approves anything that reaches the internet. Per-app access levels (read only, or read and send). Credentials are hidden from the agent. | [Meta](https://about.fb.com/news/2026/09/introducing-muse-personal-a) |
| OpenAI Dots | OpenAI, DevDay Sep 29, 2026 | Always-on agents, each with its own cloud computer. Consequential actions go through auto-review, and a monitor can pause an agent. Reachable in Slack and Teams. | [SiliconANGLE](https://siliconangle.com/2026/09/29/openai-launches-dots-) (openai.com pages returned 403) |
| Instinct | Instinct, invite-only beta since Feb 2026 | "Text or call it": a phone channel for the assistant. Its architecture could not be verified. | [instinct.com](https://instinct.com) |
| OpenClaw | OpenClaw Foundation, MIT | A gateway for 20+ chat channels, skills from ClawHub, cron and webhooks, pairing approval for unknown senders. Note that its tools run on the host unless sandboxing is configured. | [GitHub](https://github.com/openclaw/openclaw) |
| Hermes Agent | Nous Research, MIT | Skills it writes and improves itself, agent-curated memory with full-text search, built-in cron, six sandbox backends. | [GitHub](https://github.com/NousResearch/hermes-agent) |
| Claude Duet | Anthropic, research preview Oct 21, 2026 | A VM with its own browser. Checks connected apps every few hours and sends a morning brief. Shows exactly what it is about to do before sending, paying, signing or deleting. It is the closest to Timmy's model. | [Claude](https://claude.com/resources/articles/claude-duet) |

**Open-source repos**

| Repo | What it is | Use it for | Don't |
| --- | --- | --- | --- |
| [NVIDIA Auto Ontology](https://github.com/NVIDIA/auto-ontology) | Builds an ontology from SQL databases and answers questions with SQL. Apache-2.0, v1.2.0. | The data model, the Certify step, `check_answerable`, Ossie export | Run it per tenant as is: it has no tenancy, no email or document ingestion, and an unauthenticated internal service |
| [Rakazo](https://github.com/elie222/rakazo) | Self-hosted AI teammates with memory, routines, apps and a computer. Apache-2.0, very active. | The sandbox-provider contract with a portable home directory; approval modes (ask, auto, never) with allow and block lists; Markdown memory per space; routines | Expect inbox features: Gmail is only a Composio connector there |
| [OpenMausBot](https://github.com/milind-soni/OpenMausBot) | A desktop app for teams of bots that use the user's local Claude, Codex and Grok CLIs | Approval cards from a permission broker, file memory with a change journal, the daily-watch routine | Use it as a backend: it is local-first and single-user, and its `enterprise/` folder needs a license |
| [Inbox Zero](https://github.com/elie222/inbox-zero) | Rakazo's author's email assistant: drafts in your voice, plain-English rules | Product ideas for triage and rules | Copy its code: it is AGPL-3.0, which would put source-disclosure duties on a hosted SaaS |

**How the open-source agents actually run** (read from the code, Nov 16, 2026)

All four keep the agent loop in their own server process and send only tool execution to a sandbox. None of them is a multi-tenant SaaS except Rakazo.

|  | Rakazo | OpenMausBot | OpenClaw | Hermes Agent |
| --- | --- | --- | --- | --- |
| Where the loop runs | The API or worker process, on a third-party loop library ("Pi"). Each run is a database row with a lease, so a crash resumes it. | A desktop server that drives the user's own Claude Code, Codex and Grok command-line tools. It runs its own loop only for API models. | Inside one long-running Gateway per host. Turns are queued per conversation. | Inside the gateway process, with a fresh agent per message |
| Models | Any provider, with your own keys. A model per bot, a fallback chain, and separate models for approvals and the computer. | The user's own subscriptions. API drivers for xAI and OpenAI-compatible models. | 88 provider plugins, with a primary model and fallbacks | 40 provider plugins, a fallback chain and pooled keys |
| Where tools run | Shell, browser and desktop in a sandbox (Docker, E2B, Daytona and 12 more). The home folder is saved to S3 between runs. | Desktop and shell on a Boat cloud box. The agent stays on the host and reaches the box through one tool server. | On the host by default; a Docker or SSH sandbox is optional | Locally by default; Docker, SSH, Modal, Daytona or Vercel |
| Approvals | Ask, Auto or Never. In Auto, a judging model sees only the owner's own words, never fetched content, and says "ask" when unsure. Every write is an idempotent effect record. | The engine's permission prompts become cards. If the approval service can't be reached, the answer is no. Sends, posts, payments and invites are held, and a never-list blocks the worst commands. Default level: full access. | Command modes from deny to full. Commands on the host run without approval by default. Unknown senders must pair. | A helper model decides by default, with a fixed blocklist. Approvals are skipped inside containers. |
| Memory | Markdown in Postgres with revisions; up to 32 KB goes into each prompt | MEMORY.md, topic notes, recall placed in the user message, and a journal with undo | MEMORY.md and USER.md in the prompt; daily notes are searched | Small, frozen MEMORY.md and USER.md, full-text search, and skills it writes itself |
| Schedules | Cron, webhook, email, Slack and change-watch jobs on Graphile Worker | Every 15 minutes, plain code checks Gmail and Calendar first; a model runs only when something is new | Cron and webhooks inside the gateway | A 60-second tick, or a hosted callback that lets idle instances scale to zero |
| Tenancy | Multi-tenant, with Postgres row-level security per Space | One machine per customer | "One trust boundary per gateway" | Single tenant; one instance per user |

**Adopted in this version.** All nine lessons are now part of the plan:

- one loop on our servers, with a model driver and a sandbox interface (Architecture, The assistant);
- leased runs with checkpoints, and effect records;
- the safer Auto mode and turn-scoped credentials;
- plain-code checks before any model call;
- the searchable tool catalog (Connections);
- frozen memory snapshots, and skills loaded on demand;
- per-workspace limits on runs and spend (Safety).

**What we buy**

| Need | Choice | Runner-up | Why |
| --- | --- | --- | --- |
| Login and workspaces | Better Auth (your call) | WorkOS | Runs in our own stack, organizations built in, and no per-user fees |
| App connections | Composio (your call) | Nango | 1,700+ apps, MCP and triggers. Watch the per-call price. |
| Models | OpenRouter, with Claude Opus 5.5 by default, through our own agent loop | n/a | Strong tool use. One key for every model, so each workspace can choose. Only models that pass our eval are offered, and the auto-mode judge stays pinned. |
| Cloud computer | E2B or Daytona | Fly Machines | Pause and resume, a headless browser, SOC 2 Type II, about $0.17 an hour |
| Jobs | pg-boss in Postgres | Inngest | One system fewer: runs, schedules and the crash backup in the same database. Inngest if per-tenant fairness needs it. |
| Database | Postgres + pgvector | Neo4j later | One store with row-level security. A graph database only if traversal needs it. |
| Telephony | Twilio | Telnyx (cheaper per minute) | 10DLC tooling, browser voice SDK, the best-known compliance path |

## Roadmap, team and cost

Four phases over about 32 weeks. Paid launch is at week 22, once the sales stack is done. No phase starts until the previous gate is met.

**Changed Nov 16, 2026 (owner's decisions):** the model evaluation is dropped from phase 1, because Timmy uses one model through OpenRouter and the evaluation was only for adding more to the picker; and the "60% of drafts sent" goal is no longer a gate for phase 1.

**Phase 1 as built (Nov 17, 2026).** The known gaps that code could close are closed (OneDrive read-only, searching inside files, the calendar and Outlook gaps, the chat's own address and bot check, the automation and page gaps, virus scanning ready to switch on). Triage, brief and drafts; Waiting; decisions; ontology v1 and kinds for the trade with their review screen; Outlook mail and calendar; Drive (list and reading Docs, Sheets and Slides); changing and deleting calendar events; two-way filing; the page editor with version history; automations; the website chat. File storage for pictures and attachments. The closing safety review is done: two independent reviewers proved 24 breaks with tests, all fixed (see STATUS.md). Still open for phase 1: a run on real Gmail, Outlook and Drive accounts (needs a person at the consent screen), an outside penetration test and a signed data processing agreement (drafts for both in `docs/legal/`), and the gate of 50 live workspaces.

*Roadmap diagram: see the Claude Docs version. Phase 0 Foundations (weeks 1–4): sign-in and workspaces, Postgres with RLS, Gmail via Composio, agent loop and gateway, Ask on real mail, cost test per user. Gate 1: 10 users live a full day, 0 unapproved sends. Phase 1 Private beta (weeks 5–12): triage, brief, drafts; Waiting and decisions; ontology v1; Outlook and Drive; model allowlist eval; pen test and DPA. Gate 2: 50 workspaces live, 60% of drafts sent. Phase 2 Sales and teams (weeks 13–22): CRM sync and RevOps queue, cold email as drafts, Treg data on by default, lead sources, enrichment and find leads, delegate and agencies. Gate 3: paid launch, sales stack done. Phase 3 Computer and scale (weeks 23–32): cloud computer (browser), routines and channels, social posting, Salesforce listing, SOC 2 Type II window, warehouse ontology.*

Composio says it registers and maintains the Google app behind its Gmail toolkit and that we need no verification of our own ([Composio](https://composio.dev/blog/ship-gmail-integration-in-minutes)). If that app has passed Google's restricted-scope review, the beta has no 100-user cap and no 7-day token expiry; Composio's pages do not say so in those words, so this is confirmed in writing, or by the first real Gmail connect (an "unverified app" warning would mean it has not), before the beta depends on it. Composio recommends our own app for production with many users ([Composio](https://docs.composio.dev/docs/custom-auth-configs)). Our own Google app waits until we want Timmy's name on the consent screen. Its verification "can potentially take several weeks", and CASA repeats every year.

**Team (6 to 7 people)**

| Role | Owns |
| --- | --- |
| Founder / PM | Scope, the beta cohort, the gates |
| 2 platform engineers | API, Better Auth, Postgres and RLS, sync, Composio, jobs |
| 1 agent engineer | Model routes, tools, evals, ontology extraction, Managed Agents |
| 1 frontend engineer | Moves the reducer onto the API, streaming, phone |
| 1 sales-stack engineer | Sending service, CRM sync, lead sources, Treg |
| Fractional security | CASA, SOC 2, DPA, pen test |

**Running cost per active user per month** (our estimate at 1,000 users)

| Item | Estimate | Notes |
| --- | --- | --- |
| Models, Option B | about $20 | All Opus 5.5 is about $56 (see The assistant) |
| Composio | $0 to $20 | Depends on the phase 0 call test and volume pricing |
| Database, jobs, hosting | about $2 | Postgres, pg-boss, object storage |
| Computer jobs | $3 cap | Workspace spend limit; sandboxes pause when idle |
| Texts, calls, enrichment | Passed through | Billed by usage or included credits |

On these estimates, cost lands between $25 and $45 a user a month. Phase 0 measures the real figure. Pricing is out of this version and gets set after that.

## Risks and open questions

The biggest risk is cost, not technology. Model and Composio calls together come to $25–45 a user a month on our estimates.

| Risk | Likelihood | Impact | What we do |
| --- | --- | --- | --- |
| Cost per user is too high (models + Composio calls) | High | High | Measure in phase 0. Choose models per route after evals (Option B). Get Composio volume pricing or use the native mail lane. |
| Composio's Google app loses its verification, or we have to move to our own app | Medium | High | Auth config ids live in config. Use the narrowest scopes. Keep cold email off Gmail's API. Start our own verification as soon as we decide to switch, and budget 4 to 10 weeks. |
| Cold email burns domains or breaks Google's rules | Low for Timmy since Nov 16, 2026 (cold email is sent by hand from the person's mail app, never through an API) | Medium | Timmy only drafts and opens the compose window. Daily limits are shown as guidance. Address verification before the first email still applies. |
| Composio pricing, outages or token access | Medium | Medium | Our own OAuth apps once we outgrow Composio's. A connector interface inside our code. The native lane for mail and calendar. |
| A wrong or injected send | Low with the gateway | High | Nothing sends without approval by default, a preview before every send, a 30-second undo, scoped tools, sandbox allowlists |
| Scope is bigger than the team | High | Medium | Hard gates. Social, the cloud computer and the warehouse ontology wait for phase 3. |
| Partner access: Zillow, HubSpot listing, Salesforce | Medium | Medium | Email parsing for Zillow until a partnership exists. Three design partners install HubSpot early. |
| The ontology invents facts | Medium | Medium | Evidence on every fact, user certification, `check_answerable` before answering |
| We own the agent loop and its plumbing | Medium | Low | Copy patterns proven in Rakazo (leased runs, checkpoints, effect records), and keep the loop small and heavily tested. Managed Agents stays an option for headless jobs. |
| Microsoft admin consent slows larger customers | High | Low | The consent link goes to the admin from inside the app. Gmail customers aren't blocked. |

**Open questions for you**

- [ ] Does Composio's fair-use policy allow cold email sent from drafts through its Google app? Ask before launch.
- [ ] Models per route: approve Option B (Haiku 5.5 reads every item; Opus 5.5 does everything else) once it passes the eval?
- [ ] Cold email: core plan or an add-on? It carries the most policy risk.
- [x] Cold email: Timmy drafts it and opens the mail app's compose window; the person sends it by hand. Nothing cold goes through an API (decided Nov 16, 2026).
- [x] Twilio: skipped for now (decided Nov 16, 2026).
- [ ] Which provider sends Timmy's own account mail (sign-in links, invitations, password resets)?
- [ ] Hosting: stay on Railway for the beta, or move to AWS or GCP before SOC 2?
- [ ] Data residency: US only at launch, or EU from day one?

## Rating of this plan

**Still 4 out of 10 after folding in the open-source lessons. Rework before committing 8 months.** A second reviewer, who hadn't seen the first scores, read the revised plan cold. The new runtime design raised the architecture score. The overall score is held down by scope and money, and only a scope decision and the phase 0 cost test can fix those.

| Dimension | First review | Second review | Why, now |
| --- | --- | --- | --- |
| Fit to the product and users | 7 | 6 | Every area and decision is mapped. But it builds for seven trades plus agencies at once, and the "dealbreakers" come from a simulation. |
| Technical soundness | 6 | 7 | One loop, one gateway, effect records, leased runs and RLS are right. Still open: whether Composio's tokens can be exported, and a design for cold-mail mailboxes. |
| Scope, team and timeline | 3 | 2 | Phase 2 gives one engineer 10 weeks for two CRMs, sending, texts, a dialer, lead sources, enrichment, delegate mode and agencies, alongside SOC 2. |
| Unit economics | 3 | 2 | Cost is $25–45 a user. Thinking tokens, backfill and heavy users aren't counted yet. |
| Security and compliance | 7 | 6 | Strong on CASA, TCPA, 10DLC, RLS and the audit log. Missing: mail retention and encryption, staff access, data leaking through reads, a GDPR basis for leads Timmy finds, incident response. |
| Risks and mitigation | 7 | 5 | The right top risk, but nothing can stop the project before week 22. |
| Clarity | 7 | 6 | Sourced and readable, but diluted by long reference sections, and the open questions have no owner or date. |

**What would raise it to about 7.** Both reviewers put the first two at the top.

1. **A 4-week spike with a hard Gate 1.** Put 15 to 20 real Gmail users on it. Pass only if:
   - all-in cost, counting thinking, Composio and backfill, is measured and under a ceiling you set;
   - Composio's tokens can be exported;
   - trigger latency has been measured.

   Otherwise stop or redesign.
2. **A narrow v1.** Triage, approvals, Waiting, Ask, the brief and delegate mode. Outbound, texts and calls, lead sources and agencies become an add-on after launch.
3. **A cost model built from measured tokens per route.** Compare Haiku 5.5, Sonnet 5.5 and Opus 5.5 at low effort. Count backfill as an acquisition cost.
4. **Decide now:** direct Gmail and Graph sync for bulk mail, the cold-mail mailbox provider, and hosting before SOC 2.
5. **Fill the security gaps:** retention periods, staff access with an audit trail, a GDPR basis for found leads, and incident response.

**Fixed after this review:**

- One job system (pg-boss), and social is phase 3 everywhere.
- Pricing is out of this version; it comes back after the phase 0 cost test.
- The first 30 days of backfill use the regular API, so the first brief stays fast.
- Unattended runs send only what your rules cover, and the zero-unapproved-sends target says so.
- The Haiku blended price is explained.
- The cloud computer is phase 3 in every section. The 7-day token expiry noted then no longer applies while we use Composio's Google app.
