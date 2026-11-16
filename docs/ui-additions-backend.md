# New UI and how to build its backend

Nov 16, 2026 · Commit `747fc22` on `claude/modest-meitner-59cqpr` · Builds on [backend-prd.md](backend-prd.md)

This round added four things to the frontend:

1. The Notion-style doc editor, with pages, a page tree and a trash.
2. Automations: a canvas for "when this happens, do that".
3. Website chat: a chat bubble for the customer's own site.
4. A pipeline-style Tasks board.

Today all four run in the browser on demo data, like the rest of the app. This doc covers two things for each feature:

- what the user sees now, and what is real versus simulated;
- how to build the backend so it works on real accounts.

It follows the stack and rules in the backend PRD, and the backend already built on `claude/funny-keller-5ouhro` (see “Where the backend is today”). That means:

- TypeScript and Hono.
- Postgres with row-level security, and pg-boss for jobs.
- Better Auth for workspaces and roles.
- Composio for every outside app.
- The agent loop, with models through OpenRouter.
- The Action gateway for anything that changes the outside world.

## At a glance

| Feature | Where in the app | Real today | Simulated today | Backend size (rough guess) |
| --- | --- | --- | --- | --- |
| Doc editor | Docs › any Timmy doc | Editing, formatting, nesting, drag to move, icons, covers, sub-pages, page tree, trash, save badge | Saving goes to browser storage. Other people's cursors don't exist yet. Only another tab of the same browser shows a cursor. | 3–5 weeks, plus 3–4 for live co-editing |
| Summarize with Timmy | "/" menu in a doc | A summary built from the page's own headings, tables and to-dos. Timmy's cursor types it in. | No model: it picks lines from the page rather than writing new sentences | 1 week |
| Automations | Library › Automations | Drawing, connecting, settings, `{{field}}` chips, saving, on/off | Nothing runs when an automation is on. A test run uses sample data and sends nothing. | 6–9 weeks |
| Website chat | Outbound › Website chat | Settings, the code snippet, the preview, reading chats, take over, replying | The snippet points to a placeholder script. The preview bot follows simple rules (no model). The sample chats are seeded. Replies go nowhere. | 6–7 weeks |
| Tasks board | Tasks › Board | Lane summaries, quick add, tags, contact cards, drag | Same as the rest of Tasks: demo data | Under 1 week, mostly covered by the core task API |

The estimates are our guesses for one engineer who knows the stack. They assume the PRD's phase 0 foundations already exist: auth, the store, the command API, the gateway and Composio.

## Where the backend is today (checked Nov 16, 2026)

The backend is on the branch `claude/funny-keller-5ouhro`, in `server/`. Its `STATUS.md` says phase 0 is built, deployed to both staging and production, and tested on staging. The Railway project `timmy` has two environments with the same services:

| Service | What it runs | Staging | Production |
| --- | --- | --- | --- |
| `web` | The demo frontend. It redeploys `claude/modest-meitner-59cqpr` (this branch) on every push. | https://web-staging-5c9e4925.up.railway.app | https://web-production-c4bbfc9c.up.railway.app |
| `app` | The API plus the live app (`VITE_TIMMY_LIVE=1`). It redeploys `claude/funny-keller-5ouhro`. | https://app-staging-fcb4f05d.up.railway.app: fake providers and test hooks; the live suites run here | https://app-production-a7a7000d.up.railway.app: real Composio and OpenRouter keys, invite-only sign-up, no sign-ups yet |
| `pgvector` | Postgres 18 with pgvector, private network only | yes | yes |
| `timmy-files` | A bucket, wired to `app` but not used by code yet | yes | yes |

**The new UI is not in the live app yet.** The editor, automations, website chat and board changes are on this branch only. That means two things:

- They show on both `web` services, as the demo with sample data.
- They are not in `app`, because the backend branch split off before them.

## How the frontend talks to the backend (applies to everything below)

The backend runs **the frontend's own reducer on the server** (`server/src/state/engine.ts`):

1. Each command arrives at `POST /api/v1/commands`.
2. The server applies it to the workspace's stored state, saves the difference, and sends patches to every open tab over `GET /api/v1/stream`.
3. The Action gateway then checks the *result*, so anything that would put a message on the wire becomes an effect record first.

State is stored slice by slice: `SLICES` and `WS_COLLECTIONS` in `src/live/patches.ts`.

**Bringing this round live:**

1. **Merge this branch into the backend branch.**
   - Expect conflicts in `src/state/store.tsx`, `src/data/ws-types.ts`, `src/App.tsx`, `README.md` and the e2e suites. Both branches made the suites honor `BASE`.
   - The two new demo suites are `e2e/e2e-pages.cjs` and `e2e/e2e-uis.cjs`.
2. **Add the new collections to `WS_COLLECTIONS`:** `trash`, `automations`, `chat` and `chats`. If they're missing, the server won't keep them and they'll vanish on reload.
   - The new doc fields (`icon`, `cover`, and each block's `indent`, `color` and `rich`) already ride inside `ws.docs`.
   - The new file fields (`parent`, `trashed`, `trashRoot`) ride inside `ws.files` and `ws.trash`.
3. **Check the shapes on the server.** The reducer applies the frontend's generic workspace ops (`put`, `patch`, `remove`) as they are, so the commit step should check the new records with a schema before saving them:
   - known block types;
   - size limits;
   - an automation graph with exactly one trigger and no loops;
   - chat settings.
4. **Keep pictures out of Postgres.** Doc images, covers and the chat picture are `data:` URLs today, and they would land in the state tables. Until uploads exist (see Files and pictures), cap their size in the commit check. Then move them to the `timmy-files` bucket.
5. **Tab sync in live mode.** The stream already keeps a workspace's tabs in sync, so in live mode the editor should stop publishing saves over its BroadcastChannel (`src/areas/docs/editor/presence.ts`). It can keep sharing cursors.
6. **Live suites.** Add live suites for the new slices next to the existing `e2e/live/` ones, and run them on staging first.

The API paths below use the backend's `/api/` prefix.

---

## 1. The doc editor

### What the user sees

- **Blocks.** Type "/" for a menu of blocks:
  - text and three heading sizes;
  - to-do, bulleted, numbered and toggle lists;
  - quote, callout, code and divider;
  - image, table, linked sheet table and file link;
  - sub-page, and Summarize with Timmy.

  Markdown shortcuts work too: `#`, `-`, `1.`, `[]`, `>`, `"`, ```` ``` ```` and `---`.
- **Moving and formatting.**
  - Tab nests a block. A toggle holds the blocks indented under it.
  - Each block has **+** and **⋮⋮** handles: drag to move it, or click for Turn into, Colour, Duplicate, Move and Delete.
  - Selecting text opens a formatting bar.
- **Pages.**
  - Each page has an emoji, a cover, a big title and breadcrumbs.
  - The Docs sidebar shows a page tree.
  - The trash holds pages and their sub-pages until you restore or delete them. A trashed page is read-only.
- **Saving.** The page saves 850 ms after typing stops, and a "Saving… / Saved" badge shows which state it's in.
- **Who's here.**
  - Timmy, while it types a summary into the page.
  - The same doc in another tab of this browser, with that tab's cursor.

### How it works now

| Piece | Today | File |
| --- | --- | --- |
| Editor | TipTap (ProseMirror). Every block is one top-level node. Nesting is an `indent` number, not nested nodes. | `src/areas/docs/editor/extensions.ts` |
| Storage | Docs are still saved as Timmy `Block[]`. Each text block keeps plain `text`, which Timmy, drafts and exports read, and adds `rich` (the formatted runs) only when there's formatting. If `rich` no longer matches `text`, it's ignored. | `src/areas/docs/editor/convert.ts` |
| Block ids | Stable and unique (a plugin fixes duplicates after splits and pastes) | `extensions.ts` |
| Sub-pages | A `page` block in the parent, and `parent` on the child file | `src/areas/docs/pages.ts` |
| Trash | The file moves from `files` to `trash`. Sub-pages go with it, marked with `trashRoot`. | `pages.ts` |
| Saving | Debounced at 850 ms. Changes from outside (undo, another tab) replace the editor's content. | `NotionEditor.tsx` |
| Other tab | A BroadcastChannel carries cursors and saves between tabs of one browser | `editor/presence.ts` |
| Summary | Pulls lines from the page (each section's first point, a table's latest row, open to-dos). No model. | `src/areas/docs/summary.ts` |

### Backend: phase 1 (one person editing at a time)

Keep the block JSON. It's already the contract, and every reader (drafts, Ask, export) uses it.

**Tables**

| Table | Columns that matter |
| --- | --- |
| `doc` | `file_id` (pk), `workspace_id`, `template`, `icon`, `cover` (jsonb), `blocks` (jsonb), `version` (int), `updated_by`, `updated_at` |
| `doc_revision` | `file_id`, `version`, `blocks`, `author`, `created_at`. Keep one revision per save burst (for example, at most one every 5 minutes), plus one before any change Timmy makes. This backs "Version history" later. |
| `doc_text` | `file_id`, `block_id`, `text`, `tsv` (tsvector), `embedding` (pgvector). It holds one row per text block, for search and for grounding Ask Timmy. |
| `file` (existing) | Add `parent_id`, `trashed_at`, `trashed_by` and `trash_root_id`. Index `(workspace_id, parent_id)` for the tree. |

**Commands.** These are reducer actions, since the server runs the reducer. Today the editor sends generic `ws` ops. Giving these changes their own action names makes the checks, the audit log and the version check (against the workspace's `state_rev`) easier to follow.

| Command | Rule |
| --- | --- |
| `doc.save {fileId, blocks, baseVersion}` | Saves only if `baseVersion` matches the current version; otherwise it returns a conflict. The client shows the server's copy with a toast, as the PRD says. It validates the blocks against a schema: known types, max depth 8, max 5,000 blocks, max 1 MB. |
| `doc.setLook {fileId, icon?, cover?}` | The cover is a gradient id or an asset id, never an outside URL fetched by the server. An image link the user pastes stays a client-side `<img>`. |
| `page.create {parentId, afterBlockId?}` | Creates the file and the doc, and adds the `page` block to the parent, in one transaction. |
| `page.trash {fileId}` / `page.restore` / `page.purge` | `trash` moves the page and its descendants. `restore` brings back what went together; a sub-page restored without its parent moves to the top level. `purge` deletes the pages and removes the `page` blocks that point to them. |
| `page.rename {fileId, name}` | Same as the existing file rename |

**Rules to enforce on the server**

- Trashed pages are left out of search, Ask Timmy grounding, the ontology and project sources, and can't be edited.
- A pg-boss job purges trashed pages after 30 days (to confirm). The trash dialog should then say so.
- A page's permissions follow its file: the workspace role, and delegates acting for the exec. The `client` role can only read.
- After every save, an indexing job updates `doc_text` and queues ontology extraction. The facts it extracts carry the block id as evidence, so a citation in a draft can link to the exact block.

### Backend: live co-editing (phase 3, or when teams ask for it)

The cursors in the UI are built to plug into real collaboration. The open-source path, all MIT-licensed:

- **[Yjs](https://github.com/yjs/yjs)** holds each doc as a CRDT, so two people can type at once without conflicts.
- **[Hocuspocus](https://github.com/ueberdosis/hocuspocus)** is the Yjs WebSocket server from the TipTap team. We run it ourselves next to the API. It checks a short-lived token from Better Auth on connect, and it loads and stores Yjs updates in Postgres (`doc_ydoc`: the state plus compacted updates).
- **TipTap's `extension-collaboration` and `extension-collaboration-caret`** replace the current save loop and the tab-sync cursors. Yjs "awareness" carries each person's name, colour and selection, so the existing avatar stack and name tags just get real people.
- **Keep `blocks` as the readable copy.** A debounced job turns the Yjs doc back into `Block[]` (the converter already exists in `convert.ts`) and writes `doc.blocks` and `doc_text`, so nothing else changes for drafts, Ask or search.
- **One indent model.** Flat blocks with an `indent` field merge well in Yjs; nested lists do not. Keep the current model.

Cost and effort: one more service to run (WebSocket, sticky sessions), about 3–4 weeks including reconnects, offline edits and permission checks.

### Summarize with Timmy, on the backend

- Make it an agent route, `doc.summarize`, that streams AG-UI events, like Ask.
- The input is the doc's blocks. The output is a few blocks, each claim citing the block ids it came from.
- Keep the truthfulness rule from the simulation: no facts that aren't on the page, and "There's nothing to summarize yet" when the page is empty.
- Writing into a Timmy doc is an inside change, not an outside effect, so it needs no approval. It is:
  - logged in the audit log as "by Timmy";
  - one undo step, as now;
  - saved in a `doc_revision` before it lands.
- With co-editing in place, the agent service connects to Hocuspocus as a Yjs client named "Timmy", so its cursor shows for everyone.
- Model: a small, fast model is enough once it passes an eval of page summaries. Keep today's extractive version as the fallback when the model is down.

---

## 2. Automations

### What the user sees

- **The list.** Library › Automations lists each automation with the apps it uses, its number of steps, when it was last edited and an On/Off switch. **New automation** opens a sheet from the bottom of the screen.
- **The canvas.** A React Flow canvas with zoom, fit, lock and a mini map.
  - Add a block by dragging it in, or by clicking it, which connects it under the selected step.
  - There are six triggers, nine actions, and two logic blocks: If / else and Wait.
  - An automation has exactly one trigger. If / else has Yes and No branches.
- **Step settings.** Settings show the account the step uses and its fields. Text fields accept `{{name}}`-style values from the trigger: chips insert them, and a preview fills them from sample data.
- **Test run.** It walks the flow with the trigger's sample data, ticks each step, greys out the branch not taken, and logs what each step would do. Nothing is sent.

### How it works now

`Automation { id, name, description, on, nodes[], edges[], updated, tests }`. Each node is `{ id, kind, x, y, config }` and each edge is `{ from, to, branch? }`. Block definitions live in `src/areas/automations/catalog.ts`: each has fields, sample data, a one-line summary and what a test run shows. `on` is only a flag; nothing runs.

### Backend design

**Tables**

| Table | Holds |
| --- | --- |
| `automation` | `id`, `workspace_id`, `name`, `description`, `enabled`, `draft_graph` (jsonb), `live_version_id`, `created_by`, `updated_at` |
| `automation_version` | A frozen copy of the graph each time it's turned on or saved while on. Runs always point to a version, so editing never changes a run already in progress. |
| `automation_run` | `version_id`, `trigger_event_id`, `status` (queued, running, waiting, done, failed, cancelled), `context` (jsonb: the trigger's fields plus each step's output), lease columns (the PRD's leased runs), `started_at`, `finished_at`, `error` |
| `automation_step` | `run_id`, `node_id`, `status`, `input`, `output`, `effect_id` (when the step made an effect record), `attempt` |

**Checks before saving or turning on** (the client checks too, but the server decides):

- exactly one trigger;
- no loops: the graph must be acyclic;
- every step reachable from the trigger;
- required fields filled;
- every `{{field}}` exists on the trigger or an earlier step;
- an If / else has at least one branch connected.

**Where triggers come from.** Every trigger is plain code matching events already in the store. No model decides whether an automation fires.

| Trigger | Event source (from the PRD's sync design) |
| --- | --- |
| New email | Gmail or Outlook items from Composio triggers. "From contains" and "subject contains" are matched in code. |
| Form submitted | `/api/hooks/forms/{id}`, the same intake as speed to lead |
| File added to a folder | Drive's polling trigger, filtered by folder id |
| Meeting ends | Calendar sync. A pg-boss job is scheduled for each matching event's end time and moved when the event moves. |
| Deal stage changes | An internal event when a deal-stage effect completes, or when CRM sync sees the change |
| On a schedule | A pg-boss cron per automation, in the workspace's time zone |

**How a run executes**

- One run per `(version, trigger_event_id)`, enforced by a unique index, so a repeated webhook doesn't run twice.
- The runner follows the edges in code.
  - **If / else** is evaluated in code, with the same operators the UI shows.
  - **Wait** saves a checkpoint and schedules a pg-boss job to resume.
- `{{fields}}` are filled by a logic-free template renderer: no code, no filters. Values are escaped for where they go, such as an email body or a CRM field.
- Each step that changes something outside Timmy becomes an **effect record** with the idempotency key `run:{runId}:node:{nodeId}`. Retries can never send twice.

**What each action does, and what gates it**

| Action | Runs as | Gate |
| --- | --- | --- |
| Draft a reply | The agent's drafting route; saves a draft in the connected mailbox through Composio | None. Drafting is allowed in unattended runs (PRD). |
| Ask me first | An approval card. The run waits in `waiting` until someone decides. | The approver comes from policy (the exec, delegates, RevOps). |
| Send the email | Effect record → gateway → Composio send, with the 30-second undo | Needs a person, **unless** the automation has no Ask me first before it and its owner explicitly allowed sending without asking (see below) |
| Update the CRM | Effect record | Routed to RevOps by the workspace's CRM policy |
| Create a task, Add to a doc | Internal writes | None. Undoable, and logged as "by automation". |
| Save to Drive | Effect record through Composio | Allowed by default policy, undoable, logged |
| Add to a campaign | Internal write to the lead list | None. The campaign still only drafts. |
| Notify me | In-app notification, or Slack through Composio | None |

**Sending without asking.** The PRD says sends need a person "unless a rule you wrote covers them". An automation turned on with a Send step and no Ask me first in front of it is such a rule, and that's how it should be treated:

- Turning it on shows a clear confirmation: "This automation sends email without asking you first."
- Only an owner or admin can confirm it.
- It's recorded in the audit log as the rule that allowed each send.
- Sending caps, the 30-second undo and the never-list still apply.

**Safety limits**

- **Loop guard.** Every event carries an `origin` chain. An automation can't fire from its own effects, and chains stop at depth 3.
- **Rate limits.**
  - Each automation has a default limit, for example 100 runs an hour. Past it, the automation pauses and the owner gets a notification.
  - Model calls in runs count against the workspace's spend limits.
- **Failures.** A failed step is retried 3 times with backoff, then the run fails and the owner is told. Five failed runs in a row turn the automation off, with a note explaining why.

**Commands and endpoints**

- `automation.create`, `automation.update {id, graph, name, description}`, `automation.setEnabled {id, enabled, allowSendWithoutAsking?}` and `automation.delete`.
- `POST /api/v1/automations/{id}/test`
  - `{ sample: true }` reproduces today's UI.
  - `{ eventId }` replays a real recent event.
  - Either way it's a **dry run**: effects are built and previewed but never executed, and the steps come back as the same log the UI shows now.
- `GET /api/v1/automations/{id}/runs` backs a "Runs" tab, which is the next UI piece to add: a run list with step-by-step detail and errors.

**Later**

- Ask Timmy can propose an automation: the agent outputs graph JSON that passes the same checks, and the user reviews it on the canvas before turning it on.
- Each block definition in `catalog.ts` should move to a shared package used by both frontend and backend: fields, sample payloads, the check rules and the executor key.

---

## 3. Website chat

### What the user sees

- **Set up**:
  - turn the chat on and set the website;
  - copy the code snippet;
  - picture, business name, colour and greeting;
  - the questions Timmy asks once a visitor leaves an email;
  - help desk answers, which Timmy uses word for word;
  - what happens when someone asks for a person: tell you and wait, offer a call, or take an email;
  - whether to offer a call after the questions.

  A live preview on a mock page answers from these settings.
- **Chats**:
  - Unread, All and Starred tabs, plus search.
  - Each chat shows the visitor's answers and any booking, and flags chats that want a person.
  - **Take over** stops Timmy so you can reply yourself; **Email** starts a follow-up.

### How it works now

- **Settings and chats.** `ChatWidget` holds the settings and `ChatConvo` holds the chats, both in the workspace store.
- **The preview bot** (`respond()` and `matchFaq()` in `src/areas/outbound/Chat.tsx`) is plain code:
  - it matches help desk answers by words;
  - it catches an email address and asks the questions in order;
  - it offers three fixed times;
  - it hands over when someone asks for a person.
- **The snippet** points to `https://timmy.app/chat.js`, which doesn't exist yet.

### Backend design

**Getting the chat onto a customer's site**

- `chat.js` is a tiny loader (a few KB), versioned and served from a CDN on its own domain, for example `chat.timmy.app` (to decide). It adds the bubble and an `<iframe>` pointing to our chat app, and it resizes the iframe through `postMessage`.
- **Why an iframe:**
  - our styles and the customer's can't break each other;
  - our cookies and storage stay ours;
  - the customer's page scripts can't read the conversation.
- **Locking the iframe to the customer's site:**
  - It loads public settings from `GET /api/public/chat/{siteKey}/config`: name, picture, colour, greeting, help desk answers and questions. These are public, cached briefly and carry no secrets.
  - The `siteKey` is tied to the website set in Set up. Every public request checks `Origin`, and the iframe's `frame-ancestors` CSP lists only that site, so the widget can't be lifted onto other sites.

**Conversations**

- **Visitor identity.** A visitor is an anonymous id that the iframe keeps in its own storage. Browsers now partition iframe storage by site, which is what we want. Each chat gets a signed conversation token.
- **Messages.**
  - The visitor sends with `POST /api/public/chat/messages` and receives over SSE (`GET /api/public/chat/stream`). That matches the app's SSE design, with no WebSockets needed.
  - Your side gets chat updates through the existing `/api/v1/stream`.
- **Tables:**
  - `chat_widget` (settings, `site_key`, `allowed_origin`);
  - `chat_visitor`;
  - `chat_conversation` (status, `live`, `urgent`, `starred`, `unread`, `answers` jsonb, `booked_event_id`, `lead_id`);
  - `chat_message` (from: visitor, timmy or a member id; text or attachment);
  - `chat_attachment`.

**How Timmy answers visitors.** This is the riskiest part, because strangers type into it.

- **Plain code first, as in the PRD.**
  - Help desk matches, email capture and question order run as today's `respond()` does.
  - A model is only used for messages the rules can't place, and only to choose between those same actions or to rephrase a help desk answer.
  - Launching rule-based only is a safe, cheap option (see Open questions).
- **What the model may see.** Only this widget's settings: the help desk answers, the questions and the business name, plus the visitor's messages, marked as untrusted. **Never the workspace's mail, docs, CRM or memory.** A visitor must not be able to ask "what did Dana email you?" and get an answer.
- **Tools.** A strict list of five: `capture_email`, `record_answer`, `offer_times`, `book_time` and `hand_off`. No sends, no lookups, no browsing.
- **Model.** A small, fast model (Haiku class) after an eval. The eval needs real visitor questions plus prompt-injection attempts ("ignore your instructions…", fake system messages, requests for other customers' data).
- **Abuse limits.**
  - Rate limits per visitor and per IP.
  - A maximum message length.
  - A bot check (for example Cloudflare Turnstile) after unusual volume.
  - A daily model-spend cap per widget. When it's reached, the chat falls back to rules only.

**What chats turn into**

- **Lead.** When a visitor leaves an email, the lead is created or merged by email in Speed to lead.
  - Source: "Website chat".
  - The answers are stored on the lead.
  - The speed-to-lead clock starts, and the chat links to the lead.
- **Hand-off.** When a visitor asks for a person, the chat is marked urgent. It shows on Today, and you get a notification: in the app, by push, or in Slack through Composio.
- **Take over.** It sets `live`, Timmy stops replying, and your messages go to the visitor. Turning it off lets Timmy answer again.
- **Booking.**
  - Times come from free/busy on the connected calendar, not the three fixed times the preview uses.
  - Booking creates the event and sends the invite to the visitor. Under the PRD, invites need a person "unless a rule you wrote covers them". The **"Offer to book a call"** switch is that rule, and the setup screen should say so in words.
  - Each booking is in the audit log and can be cancelled.
- **Pictures from visitors.**
  - Images only, 5 MB maximum, uploaded straight to the bucket with a presigned URL.
  - Scanned before they're shown.
  - Never passed to the model in v1.
- **Email from a chat** goes through the normal draft and send approval.

**Privacy**

- Chat transcripts are personal data, including EU visitors' data. They need:
  - a retention setting (12 months by default, to confirm);
  - deletion per visitor;
  - a short notice before the email question, linking to the customer's privacy policy.
- Add the chat to the subprocessor list if a model is used.

---

## 4. Tasks board and the Pipeline view

The board's new pieces are lane summaries, quick add, tags, the contact card and drop feedback. They need almost nothing new:

- **Quick add** is `task.create {title, status, projectId?}`. It needs the core task API to accept a status.
- **Lane summaries and tags** are worked out from task fields already in the PRD's `task` table: due date, priority, thread, event and notes.
- **The contact card** reads the task's contact or linked people, which the ontology's Person provides once it exists.
- **Card order (later).** If people want to set the order of cards by hand, add a `position` (fractional index) column then.
- **Ask Timmy's Pipeline view** groups deals by stage and sums their value. On the backend, that's one aggregate query on `deal`.

---

## 5. Files and pictures

Images in docs, page covers, the chat picture and visitors' attachments are `data:` URLs today, so they fit in browser storage. On the server:

1. The client asks `POST /api/v1/uploads {purpose, type, size}`. The server checks the limits and returns a presigned PUT URL to Railway Buckets plus an `asset_id`.
2. The client uploads, then saves `asset:{id}` in the block or setting, instead of the data URL.
3. Pictures are served from short-lived signed URLs. The exception is the chat widget's public picture, which uses a long-lived public URL.
4. Uploads are limited to 10 MB (5 MB for chat visitors), and to image types only for covers and the chat. EXIF data is stripped from photos.

A one-time migration moves existing data URLs into the bucket the first time a demo workspace becomes a real one.

---

## 6. Order of work

This fits into the PRD's phases. Each line is one engineer, and the weeks are guesses.

| Phase (PRD) | Work | Weeks |
| --- | --- | --- |
| Phase 1, private beta | Docs on the server: `doc.save` with versions, revisions, pages, trash and purge, uploads, search and grounding from `doc_text` | 3–5 |
| Phase 1 | Summarize with Timmy as an agent route, with citations | 1 |
| Phase 2, sales and teams | Automation engine v1: email, form and schedule triggers; draft, ask me first, task, notify, CRM (through RevOps), wait and if/else; test-run dry runs; a run history UI | 4–6 |
| Phase 2 | Website chat v1: loader and iframe, public config, conversations over SSE, rule-based replies, leads into Speed to lead, take over, notifications | 4–5 |
| Phase 2 | Website chat: model replies behind the eval, calendar booking, visitor uploads, abuse limits | 2 |
| Phase 3, computer and scale | Live co-editing with Yjs and Hocuspocus, real cursors and presence | 3–4 |
| Phase 3 | More triggers (file added, meeting ends, deal stage) and actions (send without asking, Save to Drive, campaign); Ask Timmy proposes automations | 2–3 |

**Tests.**

- Keep the existing Playwright suites passing in demo mode: `e2e-pages` and `e2e-uis` cover this round.
- Add API tests for every new command, including cross-workspace access attempts.
- Add a test harness for the automation engine with fake connectors (no network).
- Add an eval set for the chat bot that includes prompt-injection attempts.

## 7. Open questions

- [ ] **Co-editing timing.** Do beta teams need two people typing in one doc at once? That decides whether Yjs and Hocuspocus move from phase 3 to phase 2.
- [ ] **Sending from automations.** Should an automation ever be able to send without "Ask me first"? If yes, owners and admins only, as proposed?
- [ ] **Website chat replies at launch.** Rule-based only, which is cheaper and safer, or a model behind the eval?
- [ ] **The chat's domain.** `chat.timmy.app` or another domain for the loader and iframe? The snippet in the app is a placeholder until this is set.
- [ ] **Retention.** How long to keep chat transcripts and trashed pages? This doc proposes 12 months for chats and 30 days for the trash.
- [ ] **Metering.** Do automation runs and chat conversations count against plan limits?
