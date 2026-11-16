# Timmy

Frontend for **Timmy**: an AI layer over Gmail plus its own workspace (Drive, Docs, Sheets, Slides, Calendar, Tasks, a personal CRM and an AI library), so people get a Google Workspace-style suite without paying Google for it. Timmy sorts your inbox, drafts replies from your files, and keeps track of what you owe and what you're waiting on.

![Daily brief](docs/today.png)

This is the frontend only: everything runs in the browser on sample data, and your changes are saved in the browser (Settings › Reset demo data starts over). Gmail is the only service the product will connect to (the voice option downloads its speech model from Hugging Face once). The clock is fixed at Monday, Nov 16, 2026, 8:12 AM, so due dates and "late" labels stay consistent.

Live preview: https://web-production-c4bbfc9c.up.railway.app (Railway, redeploys on every push to this branch).

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production build
```

## Layout

The shell follows the wireframe: **left rail · sidebar · tabs + main content · right sidebar · bottom bar**.

| Area | What it holds |
| --- | --- |
| Left rail | Today & mail, Approvals, Search (⌘K), Tasks, Calendar, Docs, Projects, People, Drive, AI library, Timmy's activity, Settings |
| Sidebar | A **project picker** on top, then the section's own navigation. For mail: numbered labels, project folders, Starred (max 5) and `[99] Archived` |
| Tabs | Views inside the current page (e.g. Daily brief / Triage / Drafts) |
| Main content | The page itself |
| Right sidebar | Context for whatever is open: next actions, linked file, CRM record, today's calendar |
| Bottom bar | A full app bar: Timmy's status and next run, a large **Ask Timmy** field (⌘I), shortcuts with count badges (Urgent, To approve, Unsorted), **Focus** (⌘.), Search and Appearance |

Below 1280px the right sidebar becomes a drawer. Below 900px the sidebar does too.

## How mail is organized

- **[00] Inbox** — not sorted yet. Timmy suggests a label for each email and you confirm in **Triage**, oldest first.
- **[01] Follow Up** — you owe an action. Two-minute replies are drafted and marked *Quick*; bigger work gets a task and a focus block.
- **[02] Waiting** — someone owes you. A thread stays here until the item arrives. A promise to send it doesn't count.
- **[03] Read Through** — reports and how-to emails you'll consult again.
- **[10]–[13] Projects** — mail filed where you'll use it.
- **[99] Archived** — done, still searchable.

The main flow: Dana asks for a revised quote → Timmy finds proposal v3, makes a v4, creates a task, blocks focus time and drafts a reply → **Send & track in Waiting** moves the thread to Waiting with the approval deadline → Timmy suggests the CRM update.

![Thread with Timmy's draft](docs/thread.png)

Files follow a numbered folder structure (`[02] Work › [10] Acme`, at most 5 levels deep) and dated names (`2026-11-13 Acme — Call notes`, `2026-Q4 QBR — Briefing slides`).

## The morning run, urgency and approvals

- **Morning run:** Timmy sorts new mail, ranks it, drafts replies and lines up decisions at the time you pick (default 8:00 AM on weekdays). Change the time from the daily brief or Settings › Schedule; the status bar shows the next run.
- **Urgency:** every open thread is ranked Urgent, Soon or Can wait, with the reasons shown ("Due today at 5:00 PM · Marcus is a priority contact · Says “today”"). The brief leads with only the urgent ones, or everything open if you prefer. Each signal is a rule in Settings › Urgency, and you can mark any thread urgent or able to wait yourself.
- **Approvals:** one queue for everything that needs your OK: emails to send, decisions on price or hiring, CRM updates and calendar invites. Each decision shows the numbers and what Timmy will do for each choice. Nothing is sent without approval, every choice is logged under Decided, and Undo is on the notice that follows.
- **Approvals know about each other.** A card says what else approving it does ("Sending this also settles *Give Acme $58?* as Approve $58") and warns when two items ask the same person for the same thing. Send the reply that asks Marcus for the SOW and the separate nudge is dropped (and logged); send the nudge first and the repeat ask comes out of the reply. If the sheet a draft quotes from changes (the quote tracker now says $60), the draft and its decision are flagged.
- **Decisions carry through.** Keep $62 rewrites the reply, proposal v4's pricing slides, the quote tracker and the "Update deal value" next action. Sending updates the CRM (last touch, next step, who owns it and when), finishes the tasks the email covers, and ticks only the next actions that meant "send this". Sorting mail never changes a deal: a stage change it points to waits in Approvals.
- **Drafts on request** read like email: a nudge for what someone owes you ("Could you let me know by Wednesday whether the travel budget… is approved?"), or a short holding reply with a date. Tell Timmy what to say ("say yes, Thursday works") and the reply says that; "make it shorter" keeps the ask and the numbers.

## One project, and focus mode

- **Project picker** (top of the sidebar): pick one project and Timmy narrows to it everywhere: the daily brief, mail lists and their counts, Approvals, Tasks, the bottom bar's badges and Ask Timmy. A note on each screen says what's hidden, with "Show all projects".
- **Focus mode** (Focus in the bottom bar, or ⌘. / Ctrl+.): a calmer screen. The right panel, badges, quick actions, summary cards and sidebar extras go; the brief keeps only what needs you. With a project picked, focus mode adds **everything moving on that project** under its urgent mail and approvals: the deal and goal, tasks due, what others owe you, this week's meetings, the latest decisions, key files and the people involved, each opening where you'd act on it. Both choices are remembered.

## Outbound

Find and reach new customers from the same app (rocket in the left rail):

- **Leads:** import a CSV from Apollo, Clay, HubSpot or a sheet (or paste rows). Timmy maps the columns, skips duplicates by email, and keeps unknown columns as custom fields. Every lead gets a **fit score** against your offer's ideal customer, with the reasons; **Qualify account** runs Timmy's check on the account. Filter by list, net new, saved, in campaigns or replied; select leads to qualify, save, delete or add to a campaign.
- **Campaigns:** Timmy writes the sequence from your offer: an A/B first email, a bump, a call, a case study and a break-up. Edit each step (email, call, text, LinkedIn, WhatsApp) with variants, the wait before it, `{{variables}}`, a preview for any lead, Rewrite, and checks for spam words, length, links and shouting. Schedule sets the days, window and time zone, with a day-by-day plan; Options picks mailboxes, the daily limit, stop on reply, plain text and the unsubscribe line. Analytics shows sends per day against the limit, opens, replies, interested, meetings, bounces and results by step. Launching shows the plan first; a campaign Timmy prepared waits in **Approvals**.
- **Limits built in:** at most **30 cold emails a mailbox a day** (Timmy never goes above 50), new mailboxes warm up from 10 a day, sends spread out through the window, follow-ups go before new leads, a reply stops the sequence, bounces over 3% pause it, and one-off cold emails count toward the same limit (past it, they're queued for tomorrow). Texts only go to people who agreed to them, inside quiet hours, with "Reply STOP".
- **Drafts:** when you ask Timmy for a campaign, it saves each cold email as a draft in the Gmail or Outlook account it sends from (connected through Composio, your main account included). Review, edit and send them here, one at a time or all at once; nothing goes out until you do. The Unibox **Sent** view then lists everyone you wrote to who hasn't replied, with the whole history.
- **Unibox:** every reply from every campaign and form, on email, text and calls, labelled (interested, question, meeting, out of office, not interested, wrong person, unsubscribe). Timmy suggests the next message with real free times from your calendar; book the meeting (it lands on your calendar) or add the lead to People.
- **Speed to lead:** connect your website form, Typeform, Webflow, HubSpot, Facebook Lead Ads or any form by webhook. Each new lead gets a live clock against the form's target (5 minutes for a demo request). Timmy can send the first reply in under a minute, text them if they asked, and post to Slack; the page tracks median first reply and the share answered inside the target. "Simulate a form lead" shows it working.
- **Templates & offer:** the offer Timmy writes from (product, audience, pain, hook, outcome, proof, the ask, price, ideal customer) and a library of email, call and text templates.
- **Channels & limits:** sending mailboxes with health, warm-up and daily limits; texts, phone, Slack, LinkedIn, WhatsApp and calendar connections; the guardrails above.

Ask Timmy knows outbound too: "How's my campaign doing?", "Who replied?", "Any new form leads?", "How many cold emails can I send today?", "Write a campaign for my best leads" (it prepares the campaign and leaves the launch to you in Approvals).

## Connections, calls, delegate mode and agencies

- **Connections** (plug icon): one button per app, the way the product will use Composio: Gmail, Calendar and Drive; **Outlook and Microsoft 365** (waits for your Microsoft admin to approve, then connects); **HubSpot, Salesforce, Pipedrive**; lead sources **Follow Up Boss, Zillow (Tech Connect), Realtor.com, Facebook Lead Ads**, which then show up in Speed to lead; enrichment from **Apollo, Clay, People Data Labs, Hunter** or any API; Slack, Twilio and Notion. Each card says what Timmy reads and what it may write. Connecting is simulated in this preview.
- **CRM changes wait for RevOps:** with a CRM connected, deal and stage changes (from Approvals, Ask or the deal card) wait for the RevOps approver you name. They show under Approvals › Waiting on someone else and run once approved; the Decided log says who approved.
- **Treg** is on for every workspace: Timmy picks the best of 100+ data providers for each lookup, through one token, with each call capped by your enrichment budget. Connect Apollo, Clay, People Data Labs or Hunter to use your own account instead.
- **Enrichment and leads Timmy finds:** select leads › **Enrich** fills empty fields only and spends credits. **Find leads** (or Ask "find 15 dental practices in Austin") adds leads that fit your offer to "Found by Timmy", enriched, within a daily limit and a monthly credit budget. Nothing is sent; contacting them still waits for you.
- **Calls:** Outbound › Calls is today's call list: form leads still waiting, callbacks you set, and call steps due in running campaigns. **Start calling** opens one call after another with the campaign's own script; log notes, a callback, a gatekeeper or a yes to texts, and the campaign step moves on.
- **Delegate mode** (Connections): an assistant works on the exec's inbox. External emails and decisions wait for the exec, and the log records who asked and who approved.
- **Client workspaces** (Outbound): agencies switch between clients, each with its own offer, mailboxes, leads, campaigns and Unibox. **Add in bulk** adds many mailboxes at once; **Sending domains** checks SPF, DKIM and DMARC with the fix for anything missing; **Export CSV** and **Client report** download leads and campaign results.
- **Real estate:** book a **showing** at a property address instead of a call.

## The second-simulation fixes

- Waiting form leads and times a lead already agreed to ("Monday 9:15 works") lead **Needs you today**, with a live clock and **Book 9:15**. The booking dialog adds same-day and custom times.
- **Compose** sends to any valid address, says why Send is disabled, and autocomplete no longer swaps a typed name for a near match.
- **Send checks:** Send in Ask and in the Drafts tab shows the email and what it settles first ("Send and approve $58"). Speed-to-lead auto-replies start off.
- **Ask Timmy** texts leads who agreed to texts, finds leads by name, lists today's calls and logs calls with notes; it says plainly what it can't do.
- **One price:** a price decision rewrites the order form and the CRM hint too; templates use the offer's name, product and price.
- **Truthful drafts:** no "my scorecard is in" before it is, a gap for your reason instead of an invented one, a promise ("I'll send it by 3") keeps the thread open, and replies acknowledge every question.
- **Social:** Polish with Timmy edits your post instead of replacing it.

## Social (coming soon)

A preview of the social tab: connect LinkedIn, X, Instagram, Facebook, TikTok, Threads and YouTube; see followers, impressions, engagement and the best time to post; see what's trending in your market; and write posts with Timmy and schedule them on a calendar. It's marked **Coming soon**: numbers are samples, connecting is not live, and posts you schedule are saved in the browser until accounts can connect.

## On a phone, and the calm home

- **Phone:** the left rail and desktop bar become one tab bar: Today (urgent count), Approve, **Ask** in the middle, Calendar, and More (every other section, search, focus, light/dark and settings in a sheet). No tab overlaps another, keyboard hints are hidden on touch screens, the urgent list comes first on the brief, the calendar opens on the day, and only one notice shows at a time.
- **Calm home** ("Calm view" on the brief, or Settings › Appearance): your highlight, your next meeting, the top 3 urgent items and one line for approvals. Only Approvals keeps a badge. In focus mode the calm brief goes quieter still: the highlight and what's next, with the urgent list folded into one line.
- **Show deals and the CRM** (Appearance): turn it off if you're not in sales. Deal values leave the urgency reasons, the CRM record leaves threads, and Ask Timmy suggests "Who owes me?" instead of a pipeline brief.

## Ask Timmy (AG-UI)

Click **Ask Timmy** in the bottom bar or press ⌘I (Ctrl+I) anywhere. It opens a chat workspace with your conversations on the left. Ask in plain words: "Plan my day", "Who owes me?", "Nudge the late ones", "Nudge Kenji", "What's late?", "Brief me on the Acme deal", "Prep me for my 3pm with Priya", "Find 30 min with Priya", "Block 90 minutes tomorrow for the Q1 brief", "Move my 1:1 with Priya to tomorrow afternoon", "Set Brightwave to $40,000", "Calendar Thursday", "Draft an investor update", "What did Timmy do overnight?", and with an email open, "Say yes, Thursday works" or "Make it shorter". Anything that changes something for someone else (an invite, a moved meeting, a deal) is a button you press. When Timmy can't do something yet (social posts, judging tone, writing to an outside CRM), it says so instead of answering a different question. While the chat is open, what you type goes into it, and ⌘I takes you back to the box. Timmy shows the steps it works through, answers, and puts **live widgets from the app** in the conversation: the urgent list with Send and Draft, the approvals queue, today's calendar with free time to block, the pipeline, a thread with its draft and next actions. Widgets read live data and act only when you press their button; following a link closes the chat and takes you there. It knows what you have open ("Using: …", removable), and voice works here too.

Timmy speaks the [AG-UI protocol](https://docs.ag-ui.com) (`@ag-ui/client`): the page sends `RunAgentInput` (messages, the open screen as context, and the widgets as frontend tools in `src/agent/tools.ts`) and renders the events that come back: `STEP_*` for the work, `TEXT_MESSAGE_*` for the answer, `TOOL_CALL_*` for widgets. In this preview the agent runs in the browser over the sample data (`src/agent/agent.ts`, `plan.ts`). Set `VITE_TIMMY_AGENT_URL` to any AG-UI endpoint (LangGraph, Mastra, CrewAI, Pydantic AI or your own) and the same workspace talks to that agent; it can call the same widgets.

## Voice

Talk instead of typing, as in [OpenWhispr](https://github.com/OpenWhispr/openwhispr) (MIT), but in the browser:

- **Mic buttons** in a reply, a new email and Ask Timmy; **push-to-talk** anywhere by holding Ctrl+Shift+Space (changeable). With a text field focused the words land at the cursor; with nothing focused Ask Timmy opens and answers them.
- **Engines** (Settings › Voice): *Private* runs Whisper in your browser (downloaded once from Hugging Face, then cached; audio never leaves the device) and *Fast* uses the browser's own speech recognition (Chrome and Edge send audio to their speech service).
- **Dictionary:** names and companies from your contacts are corrected after transcription ("dana whitefield at north peak" → "Dana Whitfield at Northpeak").

The microphone needs HTTPS (Railway serves it).

## Files: the full editors

Documents, spreadsheets, presentations and PDFs open inside Timmy in full editors (shown as Document, Spreadsheet, Presentation and PDF editor). They are the open-source [Craft apps](https://getartcraft.com/apps) by ArtCraft (MIT or Apache-2.0), unbranded for hosting; their licences ship in `public/craft/<app>/`: [WordCraft](https://github.com/storytold/wordcraft) (.docx, .odt, .rtf, .md…), [GridCraft](https://github.com/storytold/gridcraft) (.xlsx, .xls, .ods, .csv), [DeckCraft](https://github.com/storytold/deckcraft) (.pptx) and [PdfCraft](https://github.com/storytold/pdfcraft) (.pdf). They're Rust apps compiled to WebAssembly and served by this site from `public/craft/<app>/`, so everything stays a web app.

- **Click any file** in Drive, a project or search to open it. PDFs and uploaded office files open straight in their editor. Timmy's own docs, sheets and decks keep the Timmy editor (which Timmy reads for drafts and linked tables) with a switch to the full editor on a .docx/.xlsx/.pptx copy, and a Download button.
- **Full screen:** ⌘\ (Ctrl+\) toggles full screen for any editor, Timmy's or the full ones, even while the full editor has the keyboard. Esc also leaves it.
- **Upload** from Drive or a project's Files tab. The bytes stay in the browser (IndexedDB).
- **Save** inside the app (File › Save) stores the file back in Drive; Save As or an export to another format adds a copy next to it. Unsaved changes are shown and guarded, and a file one app hands to another (for example PDF → Word) opens in the right app.

How it's wired: `src/areas/viewers/CraftViewer.tsx` frames `/craft/<app>/index.html?host=parent` and speaks the apps' host messages ([craft-web-host](https://github.com/storytold/craft-libs/tree/main/crates/web-host): `ready` → `open {name, bytes}`; `save`, `dirty`, `failed`, `handoff`). `src/lib/office.ts` exports Timmy docs, sheets (formulas become cell formulas) and decks. The demo files are in `public/samples` (`npm run samples` regenerates them).

Hosting changes live in `scripts/patches/` (PdfCraft's community button is removed; WordCraft's is switched off through its stored preference). To rebuild the apps (Rust with the `wasm32-unknown-unknown` target and `wasm-bindgen-cli` 0.2.129; about 30 minutes for all four):

```bash
npm run craft
```

Each app's `.wasm` ships gzipped (10–22 MB) and is decompressed in the browser. The apps need WebGPU or WebGL2, which every current browser has.

## Workflows it supports

Each follows Jeff Su's published system.

| Workflow | Where | What you can do |
| --- | --- | --- |
| 1. Drive folders and filing | Drive | Numbered folders (5 deep, 99 = archive), "Where will you use this?" filing with dated names, leave / shortcut / copy for shared files, star 5 at most, description keywords |
| 2. Gmail | Today & mail | Triage into Follow Up / Waiting / Read Through, 2-minute replies, compose with Track in Waiting, Ask Timmy to draft, send a recap |
| 3. Tasks, quick notes, Calendar | Tasks, Calendar | Quick capture (⌘J), thoughts vs. notes, tasks from emails, weekly review queue, block time, daily highlight |
| 4. Docs and meetings | Docs | Create and name in one step, templates, running 1:1 table, team tracker, linked files, recap email |
| 5. Sheets and Slides | Docs | Named-column formulas, linked tables that refresh in docs, decks from layouts, copy slides to [04] Quick Share |
| 6. Project dashboard | Projects | Project home with tasks, notes, mail, files and AI; New task / New note link themselves; active and archived views |
| 7. Personal CRM | People | Start with 10–20 people, one or two priority contacts, reviews by cadence, contact history |
| 8. Browser and AI | AI library, search | Prompts captured then filed by use case, routines, rules learned from your edits, project sources |
| One workday | Mail → Tasks → Calendar → Sheets → Docs → Projects | Email to Follow Up, task, time block, update the tracker (linked doc refreshes), reply asking for approval, Waiting, approval arrives (demo button), decision recorded in the project's running notes |

## Try it

- **Today:** review the draft, accept triage suggestions, update the CRM from a suggestion
- **Next actions** (right panel on a thread): click one and Timmy does it: sends the reply, updates the deal, sends the invite, blocks the time or opens the file. Tick the box to mark one done without doing it.
- **Thread:** the whole conversation is shown with the reply box open below it. `F` / `W` / `R` / `E` move the thread, `S` stars it, `A` replies, `D` asks Timmy to draft, `Esc` goes back. Edit the draft, then **Send & track**. On a Waiting thread, **Demo: … replies** simulates the answer. Every move can be undone from the toast.
- **Anywhere:** `C` composes, `⌘J` quick-captures a task or note, hold Ctrl+Shift+Space to talk
- **Files:** open the Acme project › Files and click the order form (.docx), the MSA redlines (.pdf) or the quote tracker (switch to GridCraft); the Northwind budget (.xlsx) and the Hiring interview loop (.pptx) are in their projects
- **Search:** `⌘K` or `/`. Operators: `from:dana`, `is:waiting`, `project:acme`, `has:draft`, `has:attachment`
- **Rules:** toggle rules or add one in plain language
- **Appearance:** pick Light, Dark or Match system, and one of three dark palettes (Midnight, Graphite, Espresso) from the bottom bar or Settings › Appearance. The choice is saved in the browser.

## Design checks

The [Impeccable](https://impeccable.style) design skill is installed in `.claude/skills/impeccable`. Run its detector against the dev server or the source:

```bash
npx impeccable detect http://localhost:5173
npx impeccable detect src/
```

Known, intentional findings: em-dashes in file names (they're part of the naming convention) and the left-rail tooltip overlapping the sidebar while hovered.

## Code

```
src/
  data/       types.ts + mock.ts (mail), ws-types.ts + ws-mock.ts (workspace seed)
  state/      store.tsx (reducer, undo, saved in the browser), ws.ts (workspace helpers), theme.tsx,
              urgency.ts (ranking), approvals.ts (the queue), schedule.ts (morning run), assistant.ts (answer engine)
  lib/        office.ts (.docx/.xlsx/.pptx export), blobs.ts (file bytes in IndexedDB), dictation.ts + whisper.worker.ts (voice)
public/craft  the four Craft apps' web builds (scripts/build-craft.sh, scripts/package-craft.py)
  components/ shell (LeftRail, Sidebar, Frame, RightPanel, BottomBar), Compose, SearchPalette, kit.tsx
  views/      mail screens: TodayView, MailboxView, ThreadView, OtherViews, AppearanceView, VoiceView
  agent/      Ask Timmy: AG-UI agent (agent.ts, plan.ts), widget tools (tools.ts, widgets.tsx), conversations, the workspace
  areas/      approvals, tasks, calendar, docs (docs, sheets, slides), projects, people, files (Drive), library,
              viewers (the Craft apps: CraftViewer, upload)
  styles/     tokens.css (light + Midnight/Graphite/Espresso), layout, ui, views, kit, one file per area
```

Workspace data changes through one action: `dispatch(ws([put(...), patch(...), remove(...)], { toast, undo }))`. To connect Gmail later, replace the mail half of `src/data/mock.ts` with API calls; the workspace stays local or moves to Timmy's own storage.
