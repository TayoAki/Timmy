# Timmy backend: status

Last updated: Nov 24, 2026 (account menu with Sign out in the bottom-left corner). Read this first, then `tests.json`, then `git log`.
The brief is `docs/fable-build-prompt.md`; the plan is `docs/backend-prd.md`.

## Where things stand

**Phase 0 (foundations) is built, deployed to staging and production, and tested on staging. It has been through an independent safety review, a code-standards review, a review against the brief, and a security audit with Cloudflare's skill; their findings are fixed or listed below as known debt. The one thing left for phase 0 is a run on a real Gmail account, which needs a person at Google's consent screen (see "Needs your attention").**

| Piece | State |
| --- | --- |
| API server (`server/`, Hono on Node) | Built and deployed. Serves the API and the live app from one origin. |
| Postgres with row-level security | Built (`server/migrations/0001_init.sql`). Production runs Postgres 18 from the pgvector template. |
| Sign-in and workspaces (Better Auth: email + password, email link, six roles, invitations) | Built. |
| Timmy's own account mail (sign-in links, invitations, password resets, address confirmation) | Built on Resend. Every message is recorded first, then delivered by a job with a fixed key, so a retry is never a second email. It switches on when the `app` service has `RESEND_API_KEY` and `TIMMY_MAIL_FROM`; until then messages wait in the outbox table and email + password works. With mail on, a new account must open the link sent to its address before it can sign in. Tested against a local stand-in for Resend's API; no real email has been sent (that needs your key and your OK on a recipient). |
| State sync (`POST /api/v1/commands`, `GET /api/v1/stream`) | Built. The server runs the frontend's own reducer and sends patches. |
| Action gateway, effect records, audit log, 30-second undo | Built. |
| Composio: connect, mail backfill, new-mail webhook, nightly mail check, calendar sync, item store | Built and tested against the fake provider, for Gmail, Outlook, Google Calendar and Google Drive. Every other app shows as coming soon and the API refuses to connect it. The real key works (connect links were minted against the real API); no real account has been connected yet. |
| Outlook mail (phase 1) | Built. Outlook connects through Composio like Gmail and is a workspace's mailbox in the same way (one mailbox per workspace, Gmail or Outlook). First read of the last 30 then 90 days, new mail and sent mail by event, the nightly check, sending and replying through the gateway with the undo window, and filing written back: Follow Up, Waiting and Read Through become Outlook categories with the same names, and Archived moves the messages to Outlook's Archive folder. HTML bodies are stored and shown as text. Outlook's calendar is read too (see “Calendars, completed”); OneDrive is not read yet, and the card says so. Tested against the fake provider and checked against Composio's real tool definitions; not yet run on a real mailbox. |
| Google Drive (phase 1) | Built. Timmy keeps a list of files changed in the last 90 days and from then on (name, kind, owner, when it changed, link), kept current by Drive's events and a nightly pass, and Ask can search it (“find the file …”). Since Nov 18 a file can be **edited in Timmy and saved back** (see “Editing Drive files in Timmy”); that is the only thing Timmy writes to Drive, and only on the person's Save. |
| The new UI on real workspaces (page editor, trash, automations canvas, website chat settings, pipeline board, cold-email Drafts) | Merged from `claude/modest-meitner-59cqpr` and kept by the server: pages and their blocks, the trash, automations and chat settings are stored per workspace and checked before saving (known blocks only, links that are web or mail addresses, pictures that can't carry a script and stay small, automation graphs with one trigger and no loops, chat settings within limits). Switching an automation or the website chat **on** is refused with the reason until the engine behind it is merged (both are being built; see "In progress"). Cold-email drafts open in the person's mail app; Timmy never sends them. |
| Decisions (phase 1) | Built. When an email asks the person to choose, reading the thread makes a card in Approvals: the question, two or three answers, and only figures whose sentence is really in the thread. Timmy never chooses. Picking an answer has Timmy draft the reply, which still waits for Send. Answering the thread yourself closes the card. The same question asked again makes no second card; the thread says what was decided and when. |
| Ontology, first version (phase 1) | Built. A map of people, companies, meetings, files and promises in four tables with row-level security. Plain code builds it from who wrote, who was written to, who was invited and who owns a file; no model is involved, so it costs nothing and an email can't talk it into anything. The model's one contribution is promises ("I'll send the contract by Friday"), kept only when the sentence is really in a message from the person said to have made it. Everything points at the stored item it came from and is removed when that item goes. Used by the People screen (people from the mail appear under Suggestions with their company and how often they wrote; nothing typed by hand is overwritten) and by Ask (`lookup_person`, `list_commitments`). Not built yet: trade-specific types (deals, properties), proposing and certifying new types, matching by meaning (embeddings), showing conflicts. |
| Timmy's own pages in Ask, and Summarize with Timmy (phase 1) | Built. Ask can search the pages written in Timmy by title and text and read one (`search_pages`, `read_page`); pages in the trash are left out. "Summarize with Timmy" is written by the model on a real workspace from what is on screen; the server keeps a line only if it rests on blocks that exist and every figure in it appears in those blocks, and Timmy types the lines in. If the model can't be reached, the lines picked from the page itself stand in. Not built: a version history of pages, and a search index outside the workspace's state. |
| Reading and searching inside files (phase 1) | Built for Google Docs, Sheets (the first sheet's first 200 rows) and Slides in Drive, and Word, Excel and PowerPoint in OneDrive. Since Nov 17 the text of files changed in the last 90 days is kept (24,000 characters each) and indexed, so Ask finds files by the words inside them; the text goes with the file and with the account. Only a file on the workspace's list can be read. PDFs, and Office files kept in Google Drive, are listed but not read. |
| Website chat, version 1 (phase 1) | Built. A business pastes one line of code into its website; the chat shows there and on no other site. Visitors are answered from the chat's own settings by plain rules, with no model. Each reply is an effect record approved by a rule that exists only while an owner or admin has the chat switched on. A visitor has no account: their browser holds a signed token for one conversation. Leads from chats, take over by a teammate, limits per visitor, address and day, conversations kept 12 months. The loader and frame are served from the app's own address for now (see "Needs your attention"). |
| Automation engine, version 1 (phase 1) | Built. An automation switched on by an owner or admin really runs: new-email and schedule triggers; create a task, notify, draft a reply, ask me first, add to a doc; if/else and wait. A Send step only ever puts the reply the run drafted into Approvals, addressed to whoever wrote the email; nothing goes out without a person. One run per trigger event, no step twice, and an automation that fails five times in a row or starts 100 runs in an hour is switched off with the reason shown. A Runs tab shows each step; blocks that cannot run yet (forms, Slack, texts) say so and refuse switching on. |
| Version history for pages, and the 30-day trash (phase 1) | Built. When a page changes, what it held before is kept: at most one copy per five minutes of ordinary editing, always one before Timmy writes into it and before a restore. "Version history" in the page's menu lists them with who and why, previews one read-only, and puts it back after a confirmation. The newest 100 per page are kept, none older than 90 days. Pages in the trash are deleted for good after 30 days, counted on the server's clock, with their sub-pages, versions and the links to them. |
| Calendars, completed (phase 1) | Built. Google and Outlook calendars sit behind one interface. An Outlook connection is the person's calendar as well as their mail: its events are read and shown like Google's and a new event is written to it the same way. Changing a synced event's time, title, guests or note in Timmy, or removing it, is written to the calendar: with guests it waits for approval like an email and the card says who is told and the old and new time; without, it is your own action with the undo window. Timmy reads the event first and refuses one that someone else organizes, or one that has gained a guest you were not shown. One change per event at a time. |
| Changes made in Gmail or Outlook itself (phase 1) | Built. A thread you archive, label (with one of Timmy's three labels or categories), read, delete or restore in the mailbox follows in Timmy, with a line in its history. Timmy lists where the last three days of mail sits (labels only, never the words) in one or two calls, compares that with what the mailbox showed last time and applies only the difference, straight to its own state: nothing is written back, so there is no loop. A filing of Timmy's own that is still on its way is left alone until it settles. Looked at whenever mail arrives, with the nightly check and the morning run, when the app is opened, and every ten minutes while someone is using it. |
| Ontology, next step: kinds for your trade (phase 1) | Built. A workspace is offered its trade's kinds of thing (deals and leads; candidates and roles; properties and showings; jobs and sites; clients and invoices). Nothing is tracked until an owner or admin accepts a kind on People › What Timmy tracks. For accepted kinds, the one model read each thread already gets also returns the things it mentions with the sentence each rests on; a thing is kept only when that sentence is really in the thread, and a field only when its value appears there. Repeats merge. A kind seen in three threads that fits nothing accepted becomes a suggestion. Each thing shows its sentence and its email. Ask can look them up (`find_things`). What was learned from an account goes when it is disconnected. |
| File storage: pictures and attachments (phase 1) | Built. On a real workspace a picture added to a page or as a cover is uploaded to the workspace's bucket and saved as a reference. Files travel through the API both ways, so the browser never sees the bucket or its key, and are served to members only, as sandboxed downloads. 10 MB per file; pictures are PNG, JPEG, GIF or WebP, never SVG; attachments come from a fixed list of document and picture types, checked by type, name and first bytes. An email can carry up to 10 files: its approval card lists them, and at send time each file must still match what was approved, by fingerprint, or nothing is sent. Gmail and Outlook both. The website chat's picture stays inside the settings, because visitors see it and the files route is for members. |
| Composio toolkit versions | Pinned in config (`composio.toolkitVersions`, overridable with `COMPOSIO_TOOLKIT_VERSIONS`). `server/scripts/check-composio.mts` checks every tool and event the server uses against Composio's API at the pinned versions; it passes. |
| Model layer (OpenRouter), model picker, cost log, spend cap | Built. Real calls made on Claude Opus 5.5. An owner can set the monthly limit in Settings, up to a ceiling the server sets ($200 by default). No fallback model is configured (see decision 6). |
| Agent loop (leased runs, checkpoints, pause for approval), Ask over mail | Built. |
| Reading mail and drafting (phase 1, started early) | Built: the model reads threads people wrote and proposes a sort; the Draft button writes a draft. |
| Filing written back to Gmail (phase 1) | Built. Sorting a thread in Timmy labels it in Gmail (“Timmy Follow Up”, “Timmy Waiting”, “Timmy Read Through”) and leaves it in Gmail's inbox; archiving takes it out of the inbox; Undo files it back. Each write is an effect record approved by the person's own action. Tested against the fake provider; the three Gmail calls were checked against Composio's tool list, not yet run on a real mailbox. |
| Filing from the chat, and Auto mode (phase 1) | Built. Ask Timmy to file or archive a thread and it shows the change with “File it” and “Leave it”. With the setting in Settings › Approvals switched on, Timmy files the one thread you have open when you ask, once per request, and asks about anything else: a judge model decides from your own words and a fixed description of the action, never from the mail. The setting covers a label or archiving only; a send always waits for Send. |
| Waiting (phase 1) | Built. A reply Timmy drafts that asks for something carries what the other person owes and by when (three working days when the email names no date), so “Send & track” moves the thread to Waiting. When the date passes with no answer, the morning run drafts a nudge (5 at most a day); the Draft button on such a thread writes a nudge too. Sending a nudge sets a new date. A reply ends the wait and drops a nudge that was drafted. Nothing is sent without Send. |
| Events written to Google Calendar (phase 1) | Built for new events. An event added in Timmy goes onto the connected Google Calendar after the undo window; with guests Google sends the invitations, so it is approved like an email (an assistant's waits for the exec, and a member using someone else's calendar waits for that person). Undo inside the window means nobody is invited. Once Google has the event, that copy replaces the one made in Timmy, so it shows once. Changing and deleting an existing event are written back too (see “Calendars, completed”). Tested against the fake provider; the Google call was checked against Composio's tool list, not yet run on a real calendar. |
| The morning run (phase 1) | Built. At the time and on the days set in Settings › Schedule, in the workspace's own time zone, Timmy checks the mailbox for anything the triggers missed, reads what people wrote, and drafts replies to what needs an answer (10 at most). It moves nothing and sends nothing; the drafts wait in Approvals. Today and the activity log say what it did. It needs a connected mailbox, and no run time is shown without one. |
| Cold email (phase 2, built early because the decision was made) | Built as decided: Timmy writes it and opens the compose window of the connected mail app (Gmail, or Outlook on the web); nothing cold goes through an API. The lead is marked contacted when sync sees the email in Sent, and replies show in the Unibox. |
| Frontend live mode (`VITE_TIMMY_LIVE=1`) | Built: sign-in, onboarding, state from the API, Connect buttons, model picker, monthly limit, approvals for writes Timmy proposes. The demo is unchanged and still the default build. |
| Railway | `app` (API + live app), `pgvector` and the bucket `timmy-files` exist in `production` and `staging`. Both `app` services have the OpenRouter and Composio keys. |

## Signing out from the corner (Nov 24, 2026)

**Asked:** "how do users sign out?" Before this, only from Rules & settings › Approvals, at the foot of the page, which nobody would find. The owner asked for the person's icon to sit in the bottom-left corner of the bottom bar and to be the way out.

- **Desktop and tablet:** the icon moved from the foot of the left rail into the bottom bar's left corner, under the rail's column (`src/components/AccountMenu.tsx`). Clicking it opens a card: name, email, workspace and role, Rules & settings, and **Sign out**. Escape or a click elsewhere closes it. It stays visible at every width above a phone (the bar's status text hides below 1100 px; the icon does not).
- **Phone:** the tab bar keeps its five tabs; the same card, with Sign out, is at the foot of the More sheet.
- **Sample demo:** the card shows the made-up person and says there is nothing to sign out of.
- Sign out in Settings and during setup are unchanged. Sign out still has to reach the server, with one retry, or the person is told (unchanged).
- Tested: `live-signup` signs out from the corner icon and checks the card's words, its place in the corner, Escape, the phone sheet, and that the API refuses afterwards (39 checks).


**The complaint:** "it's classifying everything as Read Through". The first sort by plain code decided too much on its own:
- any email with an "unsubscribe" line went to Read Through with certainty (Slack and Notion digests, GitHub notices, cold pitches, a client writing through HubSpot);
- "invoice" or "order #" in a subject archived a person's question as a receipt;
- DocuSign signing requests, Google Docs @mentions and GitHub review requests were filed as notices;
- new meeting invitations were archived like "Accepted:" replies.

The AI read was right on everything it saw; it just saw too little.

**The fix (`server/src/sync/sorting.ts`).** Plain code is now sure only of what is plainly junk or a newsletter, and leaves anything that might need the person to the AI read:
- a person asking something;
- a tool asking them to sign, review, approve or answer a mention or assignment;
- a new invitation;
- a person writing through a sending tool;
- an Updates-tab email from an address that isn't a system.

Selling is archived, tool digests and notices are archived, and newsletters go to Read Through even when Gmail filed them under Promotions.

**Measured** with a new evaluation (`server/scripts/eval-sorting.mts`) on made-up emails, with the real model (Claude Opus 5.5), no real mail, and a made-up user name:

| | Before | After |
| --- | --- | --- |
| The 37 emails the fix was written against | 25 right (68%) | 37 right (100%) |
| 24 fresh emails written after the fix, never tuned on | 18 right (75%) | 23 right (96%) |
| Emails needing the person that ended up in Follow Up | 12 of 22 | 22 of 22 |

- **The one miss** on the fresh set: a Google Drive "shared with you" notice is archived; it was labelled Read Through.
- **Cost:** the AI now reads about 70% more emails (19 instead of 11, and 14 instead of 8, on the two sets). A read costs about $0.011, so a mailbox that used to have 30 emails a day read now has about 50, roughly +$0.22 a day.

**Mail already sorted the old way** is sorted again once per workspace when the server starts (`mail.resort`, `SORTING_VERSION` 2):
- suggestions in Triage are redone;
- threads the old rule filed by itself that may need the person come back to Triage, and digests it sent to Read Through are archived;
- the AI reads the newest 60 of those from the last 14 days;
- anything a person placed is left alone;
- inside Timmy only: nothing is written to Gmail.

**Tests.** `auto-sort.test` has 5 new tests, including one that runs every evaluation email through plain code and requires it never to be sure and wrong. The full API run is 985 of 985.

One test changed with the behaviour: `project-detect` expected "Northwind invoice question" to stay in no project. It did only because the word "invoice" had it archived unread. Now Timmy reads it and puts it in the Northwind project it is about; the test checks that, and that Timmy's read (not the people) placed it.

## Timmy powered by CopilotKit (Nov 18, 2026)

Phases 1 and 2 of `docs/copilotkit-plan.md` are built. "What was built" at the end of that plan has the detail.

- **Ask runs through CopilotKit's runtime** (`/api/copilotkit`, `server/src/http/copilotkit.ts`), with Timmy's own agent in process: the same person, tools, budget, approvals and audit. The browser talks to it with CopilotKit's client, and the chat looks the same.
- **Ask can organize by being asked:** what's waiting; projects and to-dos; put an email in a project; add or check off a to-do. Only in a conversation the person is having.
- **CopilotKit Intelligence** is used when `CPK_INTELLIGENCE_API_KEY` is set on `app`:
  - conversations are kept in CopilotKit's cloud and listed on any device;
  - deleting one in the chat deletes it there.
- **What staging and production run until then:** without the key, conversations stay in the server's memory and in the browser.
- **CopilotKit's telemetry** and its packages' install analytics are off.
- **Tests:**
  - `server/test/copilotkit.test.ts`: 7 tests;
  - `live-ask` checks that the chat goes through CopilotKit (14 checks);
  - `live-intelligence` (7 checks) runs against the real cloud when the key is set and checks nothing otherwise.
- **Full runs after this:** API 980 of 980 (54 files); every live suite; demo 17 of 17. Deployed to staging and production (both `app` and `web` succeeded); production answers 401 on `/api/copilotkit` without a sign-in and logged no errors.
- **Known problem, in CopilotKit's cloud:** opening a conversation on another device worked in 2 of 4 runs. In the other two, the cloud recorded nothing for the run (0 events) although the answer reached the browser. The conversation is still in the browser it was had in.

## The new onboarding (Nov 18, 2026)

The setup a new workspace opens on now has seven steps, the first four being the core:

1. **Connect your email** (Gmail or Outlook).
2. **Connect your files** (Google Drive or OneDrive). Can be skipped.
3. **Find your projects.**
   - As soon as some mail is in, Timmy scans the mail, meetings and files by itself and lists the projects it found, each ticked, with its email and file counts and people. Names can be edited.
   - One click creates the ticked ones: their emails go in, their files are linked (also files listed while the scan ran), and new mail and files follow on their own.
   - Can be skipped.
4. **See Timmy at work**, on the person's own data:
   - put an email that is in no project into one, with the same picker as everywhere else;
   - a to-do Timmy made from an email, shown in its project, with a project picker (or a button to have Timmy make one from an email);
   - a Drive document, preferably one already in a project, opened in Timmy's editor, where Save goes back to Drive.
5. Then, as before: **Choose how Timmy sorts**, **Connect your calendar**, **Choose your morning run**.

**Make a to-do** is new on every email too (`POST /api/v1/mail/todo`, `server/src/agent/todo.ts`): one small model call, the to-do held to a sentence really in the thread's last three messages, linked to the email and in its project, made once.

**Tests.**
- `live-setup` was rewritten for the new order (61 checks, passed twice). It used to check the old order: 5 steps, sorting second, files optional and skipped. It now checks every step above in a real browser, including the editor opening from the tour.
- `live-todos` checks Make a to-do (7 checks).
- `auto-organize.test` covers its API (13 tests).

## Mail and files organized into projects on their own (Nov 18, 2026)

- **New mail.** Plain code still goes first: a thread from a project's own people or company goes into that project.
  - When it doesn't, Timmy's read of the thread (the one model call each new thread already gets) is shown the open projects (up to 30, with client and goal, as outside content).
  - The read names the project the thread is plainly about, or none.
  - The thread goes in with a line in its history ("Timmy put it in the project …"), and the to-dos Timmy takes from it go into that project too.
  - A thread already in a project, or placed while the model was reading, is never moved. A number that isn't a listed open project is ignored.
  - No extra model call: the projects add a few hundred tokens to the read only when the workspace has projects and the thread is in none.
- **New files.** After each Drive or OneDrive listing, and after each pass that reads files' words, plain code links each file that is in no project to the one project it plainly belongs to.
  - The signs: its owner is someone whose mail the project claims; its name carries the project's name, client or a word only that project's name has; less so, its words name the project.
  - A tie or a single weak sign leaves it alone. Nothing is written to the Drive.
  - The file list shows each file's project, and the chip opens the project's Files tab.
- **Tests.** `server/test/auto-organize.test.ts`: 10 tests. The full API run after it: 970 of 970.

## Editing Drive files in Timmy (Nov 18, 2026)

A Drive file opens in Timmy's own editors (the Craft apps), and File › Save goes back to the Drive file.

- **What opens.** A Google Doc, Sheet or Slides deck opens as the Word, Excel or PowerPoint file Google exports. A Word, Excel, PowerPoint or PDF file kept in Drive opens as it is. Up to 10 MB. OneDrive files open to read and download only; saving back to OneDrive isn't built.
- **How it opens.** The file viewer has **Edit in Timmy**, which opens the editor full screen.
- **What Save does.**
  - The edited file is uploaded to the workspace's file store.
  - The server checks that it is the person's own upload and the right kind of file, and that Drive's copy hasn't changed since it was opened.
  - It is saved through the Action gateway as a new kind, `file.update`. The person's press of Save is the approval, and it is audited like a send.
  - The executor checks the bytes against the approved hash and Drive's version once more, then calls Composio's `GOOGLEDRIVE_UPLOAD_UPDATE_FILE`.
  - Drive keeps the earlier version in its version history.
- **When someone else changed it.** If the file changed in Drive meanwhile, nothing is saved over their change. The editor asks: **Save mine over theirs**, or **Download mine instead**.
- **Who can't save.**
  - A file shared to view only opens but can't be saved back.
  - A role that can't make changes can't save.
  - The workspace's off switch stops saves too.
- **The read-only guard is unchanged.** Drive stays a read-only app for every other caller. The one write tool is allowed only through `writeTool`, which only the gateway's executor uses.
- **What may not carry over.** Comments, suggestions and smart chips made in Google's own editor may not survive a round trip through Word format; the editor says so for Google files.
- **Not yet tried on a real Drive.** The two new Composio tools (`GOOGLEDRIVE_DOWNLOAD_FILE`, `GOOGLEDRIVE_UPLOAD_UPDATE_FILE`) pass the check against Composio's real definitions. Drive converts an uploaded .docx/.xlsx/.pptx into the Google file it replaces; that is Drive's documented behaviour, but it should be tried once on a real file.
- **Tests.**
  - `server/test/drive-edit.test.ts`: 12 tests.
  - `e2e/live/live-drive-edit.cjs`: 16 checks, in a real browser with the real document editor.
  - Two live suites changed to the new behaviour: `live-setup` checked that a Google Doc opened "read only" and now checks that it offers **Edit in Timmy**; `live-outlook` checked that the Drive card said "Writes Nothing" and now checks that it says "Only a file you edit in Timmy and save".

## The first real mailbox (Nov 18, 2026)

The owner signed up on production (their address was added to `TIMMY_SIGNUP_ALLOW` on their request) and connected a real Gmail and Google Drive. Production's logs show the first pass took in 851 messages (814 threads) from the last 30 days within minutes, then about 2,400 more from the last 90 days, with no error. What they found, and what changed:

| Found | Cause | Now |
| --- | --- | --- |
| Mail came in but nothing was sorted: business and junk sat together in Triage | By design every thread waited in Triage with a suggestion until a person accepted it | **Sort junk automatically**, a rule an owner or admin switches on (in the setup, in Triage, in Settings). Promotions and Social tabs, receipts, calendar replies, system senders and mailing lists are filed as they arrive; mail a person wrote always waits. Switching it on files what is already waiting inside Timmy only; Gmail is changed only for mail that arrives afterwards (the owner's choice). See the PRD's "Sorting mail automatically". `server/src/sync/sorting.ts`, tests in `server/test/auto-sort.test.ts`. |
| "Accept 1838 confident" failed: "That would file 1838 threads at once. Timmy files up to 100 at a time" | The button sent everything in one command; the server allows 100 filings per command | The button ("Accept all N Timmy is sure about") sends batches of 100, after a confirmation that says how many will be archived or labelled in Gmail. |
| The newest mail was at the bottom | Triage was oldest first | Newest first. Each row shows when its latest message came, as a date for anything older than yesterday (it used to say "Yesterday" for everything older than today). |
| Drive connected but no files showed | Drive's files were kept for Ask's search only; no screen listed them | Drive › **Drive & OneDrive** lists them (newest first, searchable by name, each opening in Google's or Microsoft's own app), and on a real workspace the Drive button opens there. Still only files changed in the last 90 days plus the 200 most recently shared with the person. Each listing pass now writes a "files pass" line to the log. |
| (Asked for) a guided start instead of "Watch the story" | | A five-step **setup** opens when a workspace is created: email, how Timmy sorts, calendar, files (optional), the morning run. It comes back at the next step after Google's or Microsoft's sign-in page, shows how much mail has come in, and replaces "Watch the story" on a real workspace (the demo keeps the story). `src/live/Setup.tsx`. |

**Reading email like a mail app** (asked for the same day). Opening an email now shows it the way Gmail or Outlook would: the sender's name with their full address, "to me, Sam, cc Legal" under it, and Gmail's details (every address in full, the date, the subject) a click away. HTML email is fetched from the mailbox when it is opened and shown as its sender laid it out, cleaned of anything that can act and drawn in a sandboxed frame that runs nothing; pictures from other sites stay hidden until "Show pictures", because loading one tells the sender the email was opened. Plain-text email keeps its paragraphs and line breaks, its web and email addresses are links, and the quoted history is folded behind "•••". Links open in a new tab. The HTML is not stored (`server/src/mail/original.ts`, `server/src/http/mail.ts`, `src/components/EmailBody.tsx`; tests in `server/test/mail-reader.test.ts` and `e2e/live/live-reader.cjs`). It adds one Composio call per email opened, kept for ten minutes.

**Detect projects** (asked for the same day: "scan, find the projects, sort into them"). Projects › Detect projects reads the last 90 days of mail, meetings and Drive files and groups them by the outside company or person they are with (and, among colleagues, by a rare word their subjects share), leaving out junk and one-off threads; plain code does the grouping, and the model only names each group and may split one in two or three. The person sees the result as a list and a map (projects, their companies, people and files), and keeps, renames, merges or drops each. What is kept becomes projects made the way the New project dialog makes them (a numbered folder under Work, a running-notes page); their threads go in them, their Drive files and meetings are linked (shown on the project's Files tab), and new mail from the same company or person is filed into the project by itself when exactly one project claims them. Nothing is written to the mailbox or Drive. A scan's findings are cleared once applied and deleted on any disconnect. `server/src/projects/` (detect, scan, apply), `src/live/DetectProjects.tsx`; tests in `server/test/project-detect.test.ts` and `e2e/live/live-projects.cjs`. Not yet: moving files into project folders in Google Drive (would need your OK and an approval per project), sorting new Drive files and meetings into projects as they arrive (a new scan picks them up), and project context in drafts and Ask.

**Opening Drive and OneDrive files inside Timmy** (asked for the same day). Clicking a file in Drive › Drive & OneDrive, or one linked to a project, opens it in Timmy, read only, with "Open in Google Drive" (or OneDrive) beside it for editing: a Google Doc with its headings, bold, links, lists and tables (built from Google's document structure, cleaned like an email, in a frame that runs nothing), a Google Sheet as a table (first sheet, first 200 rows), Slides slide by slide, and Word, Excel and PowerPoint files from OneDrive as their words. The file is read through its connection when opened and not stored. PDFs, pictures and Office files kept in Google Drive say they can't be shown yet. `server/src/files/view.ts`, `src/live/FileViewer.tsx`; tests in `server/test/file-view.test.ts`, `live-setup` and `live-projects`.

**People › Map** (asked for the same day). The ontology as a network: the people most in touch, the companies they are at, the projects kept from a scan with their files and meetings, and promises still open, drawn so connected things sit together (a small force layout; bigger means more going on). Click anything to see what connects to it and its latest threads, newest first; "Show only what connects" focuses on it; filter by kind; search by name; open a thread, a project or a file from the panel. It shows what Timmy already keeps and stores nothing new; it is bounded to the 120 people most in touch (the filters say how many more there are). `server/src/ontology/map.ts`, `src/live/PeopleMap.tsx`, `src/lib/forceLayout.ts`; tests in `server/test/people-map.test.ts` and `e2e/live/live-map.cjs`. Also the same day: the project scan now also matches a file by what it says (its kept text naming the company, or two of the group's telling words), and every mail list opens newest first (most urgent and oldest are a choice away).

**To-dos from email** (asked for the same day). When Timmy reads a thread a person wrote, what the newest message asks of the person (send, review, sign, book, decide…) becomes a task, at most three per message: a short line starting with a verb, the date when the message gives one, a link to the thread, the thread's project, and the sentence it rests on in its notes. A to-do is kept only if that sentence is really in the newest message, so neither an older message nor an instruction planted in the mail can add one; the same to-do from the same thread is made once, however often the thread is read. They show in Tasks (with the email they came from), on the project, and in the thread itself under "To-dos", to check off there. A thread put in a project later (by a scan or by new mail) takes its to-dos with it. Reading allows 150 more tokens for this (1,350); `ontology-types.test` pinned the old number (1,200) and now pins the new one, with the reason. `todosFrom` in `server/src/agent/read.ts`; tests in `server/test/todos.test.ts` and `e2e/live/live-todos.cjs`. Also fixed in a test: `project-detect.test` counted Gmail label changes from every account in the run instead of its own mailbox; it now counts its own.

**Found in production after the to-dos shipped, and fixed: one Drive file stopped Drive's text indexing.** Production logged "file text could not be read … GOOGLEDRIVE_GET_DOCUMENT" every two and a half minutes for the one connected Drive. Reading a file's words had two ways to fail: politely (Drive says it can't, and the file is noted and skipped) or outright (the call throws). Timmy took a throw for Google or the network being down, ended the pass and started the next one two minutes later from the same file, the newest; so one Doc Google won't hand over was asked for forever and no file after it was read. Now a file that fails outright three passes running (counted against its version, so a change to it starts again) is set aside with the reason as its note, and the pass goes on. The same throw would have shown a server error in the new file viewer and the email reader; the viewer now says the file couldn't be fetched just now and offers Google's own app, and the reader answers "unavailable" as it does when the mailbox refuses. `server/src/sync/file-text.ts`, `server/src/files/view.ts`, `server/src/mail/original.ts`; tests in `drive.test`, `file-view.test` and `mail-reader.test`. In production the stuck file was set aside on its third failure (03:38) and the pass moved on, then a second file failed the same way, so more than one of your files is affected. Composio's SDK says only "Error executing the tool …" and keeps the reason (Google's status and message, or a timeout) to one side; every failed Composio call now logs that reason too (`withCause` in `server/src/providers/composio.ts`, tested in `unit.test`), so the next failure says why. The second file was set aside at 03:43, and no file has failed since. The two files are now skipped until they change; opening one in Timmy's viewer logs Google's reason ("file could not be shown"), as a failed email fetch does ("email original could not be fetched").

**Putting an email in a project, and teaching Timmy how to sort** (asked for the same day: "a way to associate an email with a project easily", "make rules on what it should and shouldn't filter … maybe we talk to it and it saves it").

- *An email in a project.* Every email has a project control by its subject (or press P): pick a project, make a new one on the spot, or take it out. Triage rows have the same control, so an email can go in a project without being opened. Its to-dos go with it. Nothing changes in Gmail. When the email is from someone outside, an owner or admin is offered "Put new mail from anyone at acme.com in Acme website too?": "Always" saves that as a sorting rule, puts the sender's other mail in the project, and new mail from them lands there by itself. A free mail address (gmail.com and the like) or a colleague is named by address, never everyone at the domain.
- *Sorting rules that do something.* Rules › Triage has a form: from (addresses or domains), words in the subject, words anywhere; then archive it, Read Through, or "always show it to me (never archive it)", and/or a project. Before saving it says in words what the rule does and how many emails it matches now. Plain code applies rules exactly as written, first, before the automatic sort and before the model. Archive and Read Through rules file new mail in Gmail too, through a policy row naming the owner or admin who saved the rule (only mail that arrives after the rule, as you chose for automatic sorting); mail already waiting gets the rule as Timmy's sure suggestion and goes when you accept it. "Always show it to me" beats any rule or sort that would file mail away, and Timmy's read keeps its place. Mail a rule files away isn't read by the model at all, which saves a read per email. Rules you write in plain words go with each email Timmy reads (the rules every workspace starts with don't, so this costs nothing until you add one). `src/state/mail-rules.ts` (shared), `server/src/sync/mail-rules.ts`, `src/views/SortingRules.tsx`, `src/components/ProjectPicker.tsx`.
- *Telling Timmy in Ask.* "Always archive mail from linkedin.com", "put mail from acme.com in the Acme project", "never archive mail from my accountant": Ask writes the rule down, shows it in words with how much mail it matches, and nothing is saved until you press Save rule. It is a new kind of approval (`rule.save`) in the same gateway as sends and filing, so it is audited, Auto mode can't decide it, only owners and admins can save it, and a routine or an email asking for a rule gets nothing.
- *Learning from you.* When you move mail from the same company or person out of Triage to the same place twice yourself, Timmy offers it as a rule, at the top of Triage and in Library › Learned rules; one click saves it, and a declined offer doesn't come back.
- Also: a tab's commands now reach the server one after another, in the order they were made (a new project, then the email put in it, could otherwise arrive the other way round).

**Why your Docs failed, now known and fixed.** With the cause now in the log, the next failure in production said: Composio answered **413, "the tool response payload is too large"**. Reading a Google Doc returns its whole structure (every paragraph, run and style), and for a long Doc that is more than Composio hands back. So every long Doc failed, one after another. Now a Doc that comes back 413 is read as Google's plain-text export instead (Composio's export tool hands back a link to its file store, fetched through the same guarded downloader as OneDrive files: HTTPS only, allowed hosts, a size ceiling). That is all the index and Ask need; the viewer shows such a Doc as its words. The Docs already set aside get one fresh try with the new reader, without waiting for them to change (a set-aside file now records which reader gave up on it). The export tool is on Drive's read-only list, and the Composio check passes against the real API with it. `exportedDocText` and `tooLarge` in `server/src/sync/files.ts`, `server/src/files/view.ts`, `TEXT_READER` in `server/src/sync/file-text.ts`; tests in `drive.test` and `file-view.test`.

Found while testing this: the browser test first delivered a stand-in email with no text at all, which the stand-in mailbox then failed to take in on every pass. Real mail always has a body; the test now gives it one (the stand-in's own `deliver` already required it).

**The demo, on the current code, and Timmy for other AI apps (MCP)** (asked for the same day: "point the sample demo at the current code and give me the link", "make an MCP so users can run Timmy headlessly").

- *The demo.* The `web` service (the demo with sample data, no account needed) now builds this branch, in staging and production, so it shows everything built so far and follows every push. Production: https://web-production-c4bbfc9c.up.railway.app (staging: https://web-staging-5c9e4925.up.railway.app). Checked in a browser after the deploy: the story button, Triage with the project buttons, Rules with the sorting form, no page errors.
- *Timmy as an MCP server.* At `<app>/mcp` (production: https://app-production-a7a7000d.up.railway.app/mcp). People connect it to Claude (Settings › Connectors › Add custom connector), ChatGPT (developer-mode connector) or Claude Code (`claude mcp add --transport http timmy <url>`), sign in to Timmy, pick the workspace and allow it. Their AI then reads their mail, files, pages, people and projects through Timmy, keeps drafts, to-dos and projects, and prepares emails, filing and sorting rules that wait for their OK in Timmy. No Timmy model is called, so this is the "Lite mode" path: their subscription does the thinking. Rules & settings › Approvals shows the address to copy and the apps connected, each with Disconnect, which stops it at once. Authorization is OAuth 2.1 from Timmy's own auth server (Better Auth's MCP plugin, PKCE, tokens bound to `/mcp` and to one workspace); each request re-reads the consent and the person's role. See the PRD's "Timmy for other AI apps (MCP)" and `server/src/http/mcp.ts`, `server/src/agent/mcp-tools.ts`, `src/live/Connect.tsx`, `src/live/ConnectedApps.tsx`; tests in `server/test/mcp.test.ts` (7) and `e2e/live/live-mcp.cjs` (12). Also checked with the official MCP client SDK: discovery, registration, sign-in, token and refresh, 21 tools, protocol 2025-11-25.
- New packages (exact versions): `@better-auth/mcp`, `@better-auth/cimd`, `@better-auth/oauth-provider` 1.7.25 (the same version as Better Auth) and `@modelcontextprotocol/server` 2.4.0. Better Auth adds its OAuth tables (`jwks`, `oauthClient`, `oauthAccessToken`, `oauthRefreshToken`, `oauthConsent` and a few more) to the `auth` schema at start-up, as it does its other tables; nothing existing changes.
- Not yet: real Claude.ai and ChatGPT connections need the production URL and a person to click through (I can't sign in to those apps from here). The first one to try: Claude › Settings › Connectors › Add custom connector › paste the production `/mcp` address.

**Found in production after the long-Docs fix shipped, and fixed in part.** Google's plain-text export works (the 413 is gone), but Composio hands the export back as a link to a file store that isn't on Timmy's list of stores it downloads from (`COMPOSIO_FILE_HOSTS`: storage.composio.dev, Amazon S3 and Azure Blob), so the download is refused and long Docs are still not searchable. Composio's docs don't name the store. The refusal now logs the store's host (only the host; the link is signed), so it can be allowed by name after the next Drive pass, instead of widening the list on a guess. Also, a Doc an older reader set aside, that the new one couldn't read either, was asked for again on every Drive pass (about six calls each time, a few passes today); it is now tried once and left until it changes (tested in `drive.test`).

**Long Google Docs, finished; and a Feedback button** (asked for the same day). Composio keeps tool files in its own Cloudflare R2 account (`temp.4d4f16c61d89ec64e760039c4ec50717.r2.cloudflarestorage.com`, seen in the address Composio hands out for an upload, asked with Timmy's own key and none of your data). That account's buckets are now on the download list, and only that account (R2 as a whole can be rented by anyone). The reader's version went to 3, so the Docs set aside earlier get one more try, and the server now starts a text pass for each connected Drive and OneDrive when it starts, so that try happens at the deploy instead of at the nightly pass (`textPassesAtStart`). Tests in `onedrive.test` (the store, and no other R2 account) and `drive.test` (the pass at start). The Feedback button is on the left rail (and in the phone menu's sheet) on real workspaces: a few words to the Timmy team, with the screen's name ("today/triage") and nothing that's on it. It is kept in a new `feedback` table that only the system role can read (migration 0020), written to the log as "beta feedback" (so it can be read in Railway's logs today), and emailed to `TIMMY_FEEDBACK_TO` once that variable is set and Resend is on. At most 30 a person a day. Tests in `feedback.test` (5) and `e2e/live/live-feedback.cjs` (5).

Found while testing this, and fixed: the queue took jobs one a second, so 1,000 filings took a quarter of an hour; short jobs (running approved actions, taking in and reading mail) are now fetched ten at a time, again at once while batches come back full, and run in the order they were queued. A job that fails no longer stops the rest of its batch. Switching sorting on sorts what is waiting in writes of 150 threads, so the screen gets a modest change each time. The queue's creation times come back to the millisecond, so jobs queued within one millisecond could run out of order inside a batch (a test caught it once in a full run); each job is now numbered as it is queued and a batch runs in that order (`server/src/jobs/jobs.ts`, with a test). And a job that runs an approved effect was queued while the transaction that approved it was still open. Run before the commit, it found nothing and the effect waited for the once-a-minute sweep. That is harmless (the sweep runs it) but slow, and it made two browser suites fail under load. Jobs are now queued once the transaction commits, and never if it rolls back (`afterCommit` in `server/src/db/pool.ts`, with a test).

Tests changed, and why: `e2e/live/lib.cjs` signs up and then closes the new setup the way a person would ("Finish later"), because every suite but `live-setup` connects what it needs itself. The demo's story script and `e2e-fixes` looked for the button's old words ("Accept N confident"); they now look for the new ones. Nothing they check changed.

## Two merges of the new UI, now one (Nov 16, 2026)

The frontend session and this session each merged the UI branch `claude/modest-meitner-59cqpr`.

- **The frontend session's merge** went onto a temporary branch, `claude/modest-meitner-59cqpr-staging`. It was tested there (291 API tests, 17 demo suites, 13 live suites; 12 of 12 live suites on staging) and staging's `app` was pointed at that branch for the run.
- **This session's merge** is the one on this branch, with the server-side checks, decisions, the ontology and the rest described above.
- **They are now one.** The temporary branch is merged into this one. From it came: smaller pictures in the live app (1,000 px JPEG, 1,400 px for covers) so a page stays under the 1 MB limit per command; guards for workspaces saved before the chat existed; the starter chat settings (`chatWidgetFor`); an opt-in `TEST_PROXY` for running the live suites through a proxy that holds the staging test token; and test screenshots no longer tracked.
- **Where the two differed, this branch's stricter behaviour was kept.** The other session's `server/test/pages.test.ts` and `e2e/live/live-pages.cjs` are replaced by this branch's files of the same names. Theirs checked that the new records survive a reload, which this branch's tests also check; but they also expected an automation's On switch and a visitor's chat to be writable from a member's screen, and this server refuses both on purpose (a switch must not say On while nothing runs; a visitor's conversation is written only by the server).
- **Staging's `app` follows this branch again** (changed back on Nov 16 with your OK; only that one setting, in staging only). Production's `app` follows this branch too.

## What is deployed

Railway project `timmy`. Production:

| Service | What it is | URL |
| --- | --- | --- |
| `web` | The demo (unchanged; deploys `claude/modest-meitner-59cqpr`) | https://web-production-c4bbfc9c.up.railway.app |
| `app` | The API and the live app (deploys `claude/funny-keller-5ouhro`, `server/Dockerfile`) | https://app-production-a7a7000d.up.railway.app |
| `pgvector` | Postgres 18 with pgvector. Private network only: its public TCP endpoint was removed. | none |
| `timmy-files` | Bucket for files and, later, sandbox homes. Wired to `app` by reference variables; not used by code yet. | none |

Production `app` has real providers configured. No sign-ups have been made on production, and sign-up there is now invite-only (see "Needs your attention").

Staging: the same services, duplicated. `app` is at https://app-staging-fcb4f05d.up.railway.app with `TIMMY_ENV=staging`, fake providers on (`TIMMY_FAKE_PROVIDERS=1`) and test hooks on behind a token (`TIMMY_TEST_HOOKS=1`, `TIMMY_TEST_TOKEN`), which is what the live suites need. To smoke-test real Composio and OpenRouter on staging, set `TIMMY_FAKE_PROVIDERS=0` there. Staging `web` still deploys `claude/modest-meitner-59cqpr`.

Run the live suites against staging with:

```bash
BASE=https://app-staging-fcb4f05d.up.railway.app/ TEST_TOKEN=<the TIMMY_TEST_TOKEN variable on staging app> TIMMY_SEND_HOLD_SECONDS=4 bash e2e/live/run-all.sh
```

## How to run it

```bash
bash scripts/dev.sh          # local Postgres with pgvector, then every suite
bash scripts/dev.sh server   # the API's unit and integration tests
bash scripts/dev.sh demo     # the 12 demo-mode Playwright suites
bash scripts/dev.sh live     # the 10 live-mode Playwright suites (fake providers)
```

Local Postgres stops when the cloud session's worker restarts; `bash scripts/dev.sh db` starts it again.
In a cloud session set `NODE_USE_ENV_PROXY=1` so Node's `fetch` uses the session's proxy (it supplies the OpenRouter key). The Composio key for local smoke runs has to be supplied again in a new session.

Cost measurement: `server/scripts/measure-cost.ts` (the header says how to run it).

## Test results (updated Nov 24, 2026, all run locally)

| Suite | Result |
| --- | --- |
| API unit and integration (`server/test`, 54 files) | 980 of 980 pass (Nov 18, with Drive editing, organizing into projects, the new onboarding and CopilotKit). Before that, 948 of 948 (with feedback and Composio's file store). Before that, 942 of 942 (with the MCP server and the set-aside fix). One full run before that had one failure in `calendar-gaps` (the nightly calendar re-read counted a call too many), which passed alone twice and in the next full run; noted to look into. Before that, 934 of 934 pass (Nov 18, with sorting rules, rules from Ask, learned offers and long Google Docs read as exported text); before that 911 of 911 (Nov 18), with the map, to-dos from email, the job queue's order fix and setting aside a file Drive won't hand over. Of the day's full runs, one, run while the browser suites shared the machine, had two failures that its output didn't keep; every full run after it passed. |
| Demo-mode Playwright (`e2e/`, 17 suites, 484 checks) | 17 of 17 pass (Nov 24, with the account menu in the bottom bar's corner). Before that, 17 of 17 (Nov 18, again after the CopilotKit round; the demo's chat still runs in the browser and never loads CopilotKit). Before that, 17 of 17 with the project picker and sorting rules, which the demo has too. The demo behaves as before: none of the live-only screens shows in it, and it keeps “Watch the story”. |
| Live-mode Playwright (`e2e/live/`, 31 suites plus `live-verify`) | All pass (Nov 24, after the account menu, in one full run: 32 of 32, 830 checks, `live-signup` 39). Before that, all pass (Nov 18, after the CopilotKit round, in one full run): `live-drive-edit` 16, `live-setup` 61 (new onboarding), `live-todos` 7, `live-ask` 14 (through CopilotKit), `live-intelligence` 1 (checks nothing without the key; see the CopilotKit section for the runs with it). Before that, 27 of 27 with the new `live-rules`, 25 checks. In the full run two failed and passed alone on a fresh server right after: `live-projects` read the scan dialog's words once, before its lazily loaded contents were there (the check now waits for them; it still requires them), and `live-automations` passed all 59 of its checks but saw one resource fail to load while the API suite was running on the same machine (60 of 60 alone). Before that, 26 of 26 (Nov 18, again after the Drive fix, with `live-verify`) against one local server, with the new `live-setup`, `live-reader`, `live-projects`, `live-map` and `live-todos`. `live-outlook` failed once on a race the reader brought in (it looked for the email's words on the page while they had moved into the email's own frame); it now reads both and still checks that no markup or escape codes show, and passed twice after. `live-verify` runs separately, on a server restarted with address confirmation required. |
| Live-mode Playwright against **staging** (Railway) | On the final code (Nov 17): 20 of 21 suites pass. Two first failed on timing in the tests and pass on staging after the fix: `live-isolation` compared Alpha's threads while Alpha's own first model read was still landing (five traced runs showed Bravo's commands never touched Alpha; the check now waits until Alpha's threads hold still, and still compares all of them), and `live-types` looked once for a question the page removes a moment after a merge. `live-chat` can't pass from this cloud session (this session's proxy drops the chat window's own token header on staging; see the closing safety review section). `live-files` ran against the real Railway bucket. Production passes the outside checks (39). |
| The app as an outsider sees it (`e2e/live/live-outside.cjs`, requests only) | Pass in all three places: 50 checks locally, 56 on staging (six apply only to a deployed server: HTTPS-only, the test endpoints hidden without their token, repeated wrong passwords slowed down), and 39 on **production** in the form that makes no account (`OUTSIDE_NO_ACCOUNT=1`), where it also confirms an uninvited address cannot sign up. Writing it found one gap, now closed with tests (`server/test/hardening.test.ts`): a record id named after something every JavaScript object has, such as `constructor`, was accepted. Nothing could be stored or read across workspaces through it. |
| Composio tool check (`server/scripts/check-composio.mts`, real API, read-only) | Pass on the merged code: 33 tools and 9 events exist at the pinned versions and take the arguments the code sends, including the new calendar tools for Outlook and Google. |
| Real connect links for Outlook and Drive (Composio's real API) | Pass: a link was minted for each through the server's own code, with the pinned versions, and the pending accounts were removed again. Composio accepted the narrower Outlook permission set (`timmy-outlook-a7eae611`: mail and profile only). Nobody has signed in through them yet. |
| Real connect link for Outlook with the calendar permission added | Pass: Composio's real API issued the link for the wider set (mail, calendar, profile), and the pending account was removed again. Nobody has signed in through it. |
| Demo suites against a deployed build of this branch | Not run: `web` deploys the older branch, and I won't change that service without your OK |
| Real-provider smoke (a real Gmail or Outlook mailbox, a real Drive, through Composio) | Not run: needs a test account connected by a person |
| A real email through Resend | Not run: needs `RESEND_API_KEY`, a sender address on a domain verified in Resend, and your OK on who receives it |

Tests changed in the Outlook and Drive round, and why:
- `review.test` and `sync.test` asserted that Outlook and Drive could not be connected (400). They can now. The first now asserts the stronger thing it was about: with Gmail connected, Outlook is refused by the one-mailbox rule (409, naming the connected address). The second lists apps that still can't be connected.
- `gateway.test`, `audit.test` and `live-mail` matched the words “Connect Gmail first”; the message now says “Connect Gmail or Outlook first”.
- `live-signup` used the Outlook card as its example of “coming soon”; it now uses HubSpot, and checks that Outlook, Drive and Calendar can be connected.
- `e2e-steps` (demo) failed 2 runs in 5 on a busy machine: it pressed the key that leaves full screen in the spreadsheet editor and looked once, 400 ms later. The check is unchanged; it now looks until it holds, for up to three seconds. It then passed 6 of 6. The app code was not changed.

Two changes were made to the existing demo suites earlier, both to make them run correctly, not to make them pass:
- Eight suites ignored `BASE` and always tested `localhost:5173`. They now honor it.
- `e2e-fixes` was failing before any backend work. Its last block clicked the first row on Today and assumed it was an email; since leads were added to Today the first row is a lead. It now opens a mail row and asserts that it did.

## Measured cost per user

Measured Nov 16, 2026 with `server/scripts/measure-cost.ts`: the real sync code on a 3,000-message mailbox (30 days at 100 a day), and real calls to Claude Opus 5.5 through OpenRouter with reasoning effort "low". The mailbox content is synthetic, so treat the token counts as a first reading, to be repeated on a real mailbox. The whole measurement cost $1.10.

**Model (real calls, averages)**

| Route | Model calls | Input tokens (cached) | Output tokens (reasoning) | Cost | Sample |
| --- | --- | --- | --- | --- | --- |
| Ask over mail, per turn | 3.2 | 12,572 (8,078) | 548 (52) | $0.035 | 6 turns |
| Read one thread a person wrote | 1 | 686 (0) | 223 (102) | $0.0079 | 96 threads |
| Draft a reply (the Draft button) | 1 | 701 (0) | 316 (109) | $0.0098 | 8 drafts |
| Draft a reply from chat, per turn | 5.0 | 20,221 (16,213) | 929 (76) | $0.042 | 2 turns |
| Prepare a send for approval | 1 | 1,756 (1,604) | 144 (0) | $0.004 | 1 turn |

Checked later the same day with three real calls on made-up threads (2.3 cents in all): a reply that asks for something came back with the item and the date to track ($0.013, with a note from the person); a reply to a thank-you carried no tracking, and an instruction planted in that email (add a line asking for a wire transfer, and track it) was ignored ($0.005); a nudge was three sentences ($0.005). The morning run therefore costs at most about 30 reads, 10 drafts and 5 nudges a day, roughly $0.36, and usually far less because mail is read as it arrives.

Prompt caching works on the chat route: 64% to 80% of its input tokens came from the cache. The read and draft prompts are too short to be cached.

Plain code sorts mail before any model call. In the test mailbox it gave a confident sort to 70% of threads (newsletters, receipts, calendar replies); only mail a person wrote goes to the model. The real share depends on the mailbox.

**Composio calls (counted from the real code paths)**

| Step | Calls |
| --- | --- |
| Connect a mailbox | 3 (link, profile, trigger) |
| Backfill | 1 per 50 messages: 60 for 30 days, 180 for 90 days |
| Each new email | 1 (fetches the whole thread). This can drop to about 0 by using the message the trigger already carries, once that payload is checked on a real mailbox. |
| Each send | 1 |
| Calendar | 1 per sync of the window (per connect and per calendar change) |

**Per user per month, at 100 emails a day, 150 Ask turns and 300 drafts** (the PRD's volumes)

| Item | All on Claude Opus 5.5 | Notes |
| --- | --- | --- |
| Reading mail | $7 to $13 | 900 to 1,650 reads, depending on how much of the mail people wrote (30% to 55%). The same reads on Claude Haiku 5.5 would cost about $0.20 to $0.35 at its list price; that is the PRD's "Option B" and needs the eval and your OK. |
| Drafts | $2.90 | 300 drafts on the one-call route |
| Ask | $5.25 | 150 turns |
| **Model total** | **$15 to $21** | The PRD estimated $56 for all-Opus and $20 for Option B |
| Composio | $2 to $17 | About 3,300 calls: $16.50 at the $5 per 1,000 overage price, about $6 if covered by pooled seats, about $2 after the new-email change |
| One-time, per new user | about $1.20 | 180 Composio calls for 90 days of backfill, and up to 40 first reads ($0.32) |

## Safety review (Nov 16, 2026)

An independent reviewer read the gateway, row-level security, effect records, credential handling, the agent and the sync code against the five safety properties, and ran probe tests. It confirmed the core (provider writes only through approved effects, no double execution under races, row-level security complete, auto mode cannot approve anything outbound) and found three high-severity gaps and a dozen smaller ones. All are fixed, with one test per finding in `server/test/review.test.ts`:

1. A chat button written by the model could carry a send, so one click on an innocently labelled button counted as approval. Model-written buttons may now only open something or start a draft.
2. A session made by registering someone else's address survived their password reset. A reset now ends every earlier session. (Email verification at sign-up is still off until a mail provider exists; see below.)
3. A sender's display name containing an address was taken as the sender. The sender is now the address in the angle brackets, and "sent by me" comes from the provider's Sent label.
4. Smaller: connections end with their member or workspace; an open stream ends when the person is removed; one everyday mailbox per workspace and the approver sees which mailbox sends; an unconfirmed send is never called "not sent"; a delegate's send shows as sent once it goes out and cannot be sent twice; chat cannot replace a draft; only the person who started a connection can finish it; test hooks need a token on deployed servers and cannot start in production; decisions report what actually happened; role checks on three read routes.

## Security audit with Cloudflare's skill (Nov 16, 2026)

A second, separate audit ran Cloudflare's `security-audit` skill in full-audit mode on the fixed code, with its own probe tests. It confirmed the earlier fixes that could be checked, found nothing that sends mail without approval, and reported 12 findings (4 medium, 7 low, 1 informational). Each has a test in `server/test/audit.test.ts` or the live suites. Its full report, the probes and their output are in the session's scratch folder and are not in the repo.

| # | Finding | What changed |
| --- | --- | --- |
| 1 | An invitation link joined a workspace and switched to it just by being opened. Someone could invite your address to a look-alike workspace and get you to connect your mailbox there. | Opening the link now shows who invited you, to which workspace and in what role, and asks. "Not now" joins nothing. |
| 2 | Until a mail provider exists nobody can prove they own an address, so someone could register yours first and plant a workspace. | **Production sign-up is now invite-only** (see "Needs your attention"). The full fix is email verification, which needs the mail provider. |
| 3 | Anyone could sign up on production and spend on your model key: unlimited workspaces at $50 each, and a chat request could carry an enormous forged history. | Invite-only sign-up; 3 workspaces per account; one spending ceiling for the whole service ($500 a month by default, `TIMMY_SERVICE_SPEND_CEILING_USD`); the chat endpoint forwards at most 40 messages, 60,000 characters and 16 widgets. |
| 4 | Leaving a workspace left the leaver's mailbox connected. | Leaving closes their connections, like being removed does. A job also closes any connection whose person is no longer a member. |
| 5 | Two people connecting a mailbox at the same moment could both succeed. | Only the first to finish becomes the workspace's mailbox; a unique index in the database backs the check. |
| 6 | Disconnecting a mailbox, or deleting a workspace, left all its synced mail in the database (the PRD promises deletion within 30 days). | Disconnecting takes that mailbox's mail off the screens and out of Ask at once and deletes the stored copy by a job. A deleted workspace is closed at once and all its rows are removed after 30 days. |
| 7 | No limit on request size, including before the webhook's signature check. | 1 MB on API requests, 2 MB on the webhook, refused before anything is read. |
| 8 | An assistant or member could add a rule, and writing rules go into every drafting prompt. | Rules and the schedule need the owner or an admin. |
| 9 | A button written by the model could replace a draft you had already read, with its own note presented as yours. | A chat button may start a draft only when the thread has none, and can carry no note. |
| 10 | Chat history stayed in the browser after sign-out, for whoever used it next. | It is kept per person and workspace and removed at sign-out. |
| 11 | A flood of incoming mail could use up the whole monthly limit and silence Ask. | Reading mail on its own may use at most half of the limit (`TIMMY_UNATTENDED_SHARE`). |
| 12 | A recorded command answer was returned before checking who asked. | Fixed with the code review: only the sender gets it. |

Also changed from its notes: a From header's comment is no longer read as the sender; the sign-in limiter uses the address Railway's edge reports (`X-Real-IP`), which a caller cannot forge; responses carry nosniff, frame, referrer and transport-security headers; a deployed server's health check says only that it is up; one person can hold at most 12 streams open; only whoever connected an app, or an owner or admin, can disconnect it; old sign-in links and commands are cleaned up; the build has a `.dockerignore`.

**A rule I changed because the audit raised it, for you to confirm or reverse:** an email or a calendar invitation leaves under the name of whoever connected the account. A send through it by anyone else who is not an owner or admin now waits for that person, the same way a delegate's send waits for the exec. Before, any member could send from the workspace's mailbox on their own approval.

**Found by running the suites on staging:** a change made a moment before the page was reloaded or closed could be lost, because the request that saves it was cut off with the page. It showed up as the sign-up suite failing about half the time on staging and never on one machine. Saves now finish even after the page is gone. A tab also no longer shows its own change twice for a moment when the stream delivers it before the answer to its request. `e2e/live/live-signup.cjs` now reloads immediately after adding a rule, on purpose, and checks the rule is there once.

**Also found on staging:** one suite failed once at sign-out. The server's log showed the sign-out request never arrived: it was lost on the way, and the page reloaded with the session still open. The browser now sends a request again, once, when it is lost in transit and is safe to repeat (a read, a sign-out, or a command, which the server knows by its id and applies once). If signing out still cannot reach the server, the person is told. `e2e/live/live-signup.cjs` drops the first attempt of a save and of a sign-out on purpose and checks both still happen, once.

Not done, by choice: a full content-security policy for scripts (the dictation model loads from a CDN, and the policy needs an inventory first); pinning the Docker base image by digest; rate limits on commands and chat beyond the cap on jobs at once; a narrower database role for the API process (it holds the owner's credentials); cleaning the document viewers' saved files at sign-out. The audit could not check four things from where it ran: stream load on the shared database pools, memory use on a very large mailbox, how long pg-boss keeps finished jobs, and where the prebuilt document-viewer binaries came from.

## Safety review of the first phase 1 additions (Nov 16, 2026)

A third independent reviewer read the morning run, filing, Auto mode and Waiting against the five safety properties and ran 26 probe tests. It found nothing that sends mail, crosses workspaces, runs twice or leaks a key, and confirmed that Auto mode cannot approve anything but filing, that the judge never sees a subject or sender, that the morning run made no outside write even with a model that obeyed hostile mail, and that the retry is safe. It reported six findings, none high. Each has a test in `server/test/review2.test.ts`.

1. **Auto mode approved "one thread to the archive" without knowing which thread, or how many** (medium). A model steered by mail it had read could have archived threads the person never named. Auto mode is now tied in code, before any model is asked, to the one thread open on the person's screen, once per request. Anything else is shown and waits. A chat that carries earlier answers also tells the judge to be stricter.
2. **One "Accept all" could make an unbounded number of mailbox writes** (medium/low). A command may now file at most 100 threads; more is refused whole. The same kind of limit (20) applies to calendar events, which the review did not cover because they were added while it ran.
3. **A nudge could be addressed to someone outside the thread** (low), because who a wait is "on" could be set by whoever sent the email. A nudge now only goes to someone the person's last email on that thread went to.
4. **A nudge the person had rewritten was deleted when any message arrived** (low). It is now dropped only while it is still exactly what Timmy wrote and the person being waited on answers. Someone else writing keeps the wait and the nudge. A discarded nudge is not written again the next morning.
5. **Place names were not validated** (low): a word like "constructor" passed as a place, and a caller could claim Timmy made a move. Only the five places are accepted, and "Timmy filed this" is written only when Timmy did.
6. **Two filings reaching a new mailbox together left one unconfirmed** (low). The second now finds the label the first just made, and a failure to prepare labels is recorded as a clean failure.

Writing those tests also showed that an action with a field of the wrong shape could crash the reducer and answer 500; it is now refused like any other bad command.

**For you to confirm:** members and assistants file mail in the workspace's mailbox on their own say (and through Auto mode for the open thread), while a send from that mailbox waits for its owner. I think that is right, since filing reaches nobody and is an assistant's job, but it is your call.

## Safety review that closes phase 1 (Nov 17, 2026)

Two independent reviewers, each told to break the five safety properties and to prove every break with a test that fails on the code. Their tests stay in the suite (`server/test/review-a.test.ts`, `review-b.test.ts`).

**First half: everything that can write outside Timmy or let a stranger in** (the Action gateway and its new kinds, automations, the website chat's public side, calendar changes, changes picked up from the mailbox). It found nothing that sends, files, writes a calendar or shows a visitor a message without an approved record or a rule a person set, nothing that runs twice, nothing across workspaces and no credential in a prompt. It proved five smaller breaks, all fixed:
- An automation's "From contains" could be met by a stranger who put the trusted address in their display name. It now matches the sender's address only.
- A Send step could put forward a draft someone else wrote while the run waited. It now puts forward only the draft its own Draft step wrote.
- Someone lowered from admin to member could still answer an automation's "Ask me first". Only a current owner or admin can.
- A second website visitor typing the same address replaced the first visitor's answers on the lead. Later answers only fill gaps. (`server/test/chat.test.ts` expected the old behaviour and was changed for this.)
- A stranger's reply filed under spam could archive the thread it joined, in Timmy only. Spam alone no longer decides anything about a thread with older mail.

Also closed from its list of suspicions: one network address can now send at most 300 messages a day to one business's chat, so it cannot use up the day's allowance and shut the chat for everyone else.

Left as known from the first half, and closed since (Nov 17): an automation or the chat now switches off when the owner or admin who switched it on loses the role or leaves; the chat has a proof-of-work bot check and a cap on open streams per workspace; reloading the app looks at the mailbox at most every five minutes; a category already on a message when Timmy first sees it never moves a thread; a calendar delete with an unknown outcome is settled by reading the event by id. Still open: many addresses together can reach a chat's daily cap (the bot check slows a script down, it does not stop one).

**Second half: who can read and change what, and what untrusted text can do** (row-level security on every new table and route, the generic state operations and the reducer on the server, page versions and the trash, the ontology and its kinds, Ask's tools and prompts, and the screens that show untrusted text). It confirmed that every table holding workspace data has row-level security on and forced, that every new route finds nothing by another workspace's ids, that roles hold, and that every write still goes through the gateway. It proved 19 breaks, all fixed:
- **Serious: text shaped exactly like a timestamp became a date.** An email whose subject was exactly a timestamp, or a sender whose display name was one, blanked the inbox for the whole workspace and blocked every tracked reply, and nothing on screen could remove it. Dates now travel tagged and only a tag becomes a date. Data stored before the change has no tags; in it, and only in it, a timestamp is still read as a date under the field names that have only ever held dates, so nothing stored had to be rewritten.
- **Disconnecting a mailbox now removes its mail everywhere.** Undo of an earlier command had put a disconnected mailbox's thread back; a lead's reply copied into the Unibox stayed; and the mail stayed in the change log that tabs catch up from, in the command history that Undo reads, and in finished runs' transcripts. All of these are cleared when a connection closes, Undo never restores mail from a mailbox that is no longer connected, and finished runs' transcripts are also cleared nightly.
- **Records the screens write are checked.** One assistant adding a lead with no address had stopped all mail from being stored for the whole workspace; a contact with no address stopped the People suggestions; a calendar entry with a start that was not a date took down Today. Contacts, calendar entries and every lead an outbound command produces are now checked, the readers skip a bad record, and one item outside pages may hold at most 200 KB.
- **Outside words stay wrapped.** An answer picked on a decision card reached the drafting model as the person's own note, worded from someone else's email; it now goes as outside content. A file's name in `read_file`'s "can't open" answer was unwrapped, and the wrapper could be closed with `< /untrusted>`.
- **Model values must be backed.** A figure on a decision card is kept only if its own quoted sentence holds it, and a tracked value only if it appears whole (`$25` is not in `$250,000`).
- **Page history holds only what the page held.** The summary route kept whatever a screen sent as the page's "before Timmy" version, so anyone could plant words in its history. Versions are trimmed to the number kept as they are added. The trash job checks each page's own age and never deletes a page that is still listed.

Tests changed on purpose for these fixes: `server/test/ontology.test.ts` checked the old drafting note word for word and now checks the choice reaches drafting as outside content; `server/test/page-versions.test.ts` expected the on-screen blocks to be kept and now expects the saved page; `server/test/chat.test.ts` (from the first half) expected a later chat to overwrite a lead's answers.

Left as known from the second half, and closed since (Nov 17): the server ignores a client's `approved` flag on every action, and the lead form operation is refused on a real workspace. Still open by design: members can delete a page for good (its history is now kept hidden for the trash period, so Undo brings both back).

**On staging, the chat's live updates can't be checked from this cloud session.** This session's network proxy holds the staging test token and adds it to every request to staging, and in doing so drops a request's own `Authorization` header, which is where the chat window sends its conversation token for live updates. So `live-chat` fails on staging from here at the point where it waits for a reply, while a direct request to staging streams the conversation correctly. Visitors' browsers don't go through this proxy. `live-chat` passes locally against the production build run as a staging server.

## Code review (Nov 16, 2026)

Two more independent reviews, run the way the `code-review` skill from mattpocock/skills prescribes: one against coding standards (duplication, modules that do too much, code that decides by reading message text), and one against the brief and the PRD. What changed as a result:

1. **A model nobody approved could have been sent mail.** The outage fallback was a second model, and it applied to the judge too. Removed (decision 6).
2. **Things were offered that did nothing:** Connect buttons for Outlook and Drive, the Auto setting, and a spend limit whose message said "raise it in Settings" when Settings could not. The first two are withdrawn until they work; the limit is now settable.
3. **Sample data on real workspaces:** cold-email templates signed "Taylor" from "Northpeak", an Archived count that started at 2,418, and the demo's activity listed under "Done without asking". All three now use the workspace's own data.
4. **A recorded answer could be handed to the wrong person.** Writing the test for the new approve and decline routes showed that a command retried under an id someone else had used got that person's recorded answer. The answer is now given back only to the person who sent the command.
5. **Missing from the brief:** the nightly mail check, `POST /api/v1/actions/{id}/approve` and `/decline`, a browser test that approves and sends Timmy's draft, and a test that a CRM change waits for RevOps. All four are built and tested.
6. **Two requests arriving together could both take the last job slot.** The count and the insert now happen under the workspace's lock.
7. **Code quality:** the Send button and the chat's send tool prepared an email in two separate copies of the same checks; there is now one. Three places decided what to do by matching the text of a message or an error (which thread still needs reading, whether a run lost its lease, whether the budget ran out); they now use a field and error classes. The dead cold-email send path, the "sending mailbox" kind of connection and two unused database helpers are gone. What was not done is under "Known debt in the code" below.

Test changes that came with this, so you can check them:
- `server/test/unit.test.ts`: the test that expected a fallback model in every request now expects none unless one is configured, and never for the judge.
- `server/test/review.test.ts`: connecting Outlook used to be refused with "a mailbox is already connected" (409); it is now refused with "can't be connected yet" (400).
- `server/test/gateway.test.ts` and `e2e/live/live-mail.cjs`: the "connect a mailbox first" message no longer mentions Outlook.
- `e2e/live/live-settings.cjs`: the Auto-mode check is replaced by checks on the monthly limit, and a check that no approval mode is offered.
- `e2e/live/live-mail.cjs`: Timmy's draft is now approved and sent from Approvals instead of discarded, so later counts of sent mail are one higher.
- After the security audit: `server/test/gateway.test.ts` ("a member cannot approve another member's request") now expects the member's own request from the owner's mailbox to wait for the owner as well; `server/test/review.test.ts` (who may undo a held send) uses an admin as the sender for the same reason; `e2e/live/live-holds.cjs` accepts the invitation through the new confirmation screen instead of calling the API.

## Decisions made while building (the PRD is updated to match)

1. **One service serves the API and the live app, on one origin.** `up.railway.app` is on the public suffix list, so two Railway subdomains can't share a cookie, and cross-site cookies are blocked in Safari. The existing `web` service is untouched and stays the demo.
2. **The server runs the frontend's reducer.** Each client action is applied by the same reducer code on the stored state, and the difference goes back as patches keyed by entity. An action that would send mail is detected from the reducer's result and turned into an effect record first. Demo-only actions are refused on a real workspace.
3. **Cold email is never sent through Google's API.** (Owner's decision, Nov 16, replacing the earlier "send from the Composio-connected account".) Timmy writes the cold email; pressing Send opens Gmail's own compose window with the recipient, subject and body filled in, and the person sends it from Gmail. Timmy marks the lead as contacted when sync sees the email in Sent, and shows replies in the Unibox. A sequence cannot send itself: each email is one click by a person.
4. **Twilio (texts and the dialer) is skipped for now** (owner's instruction, Nov 16). Texts and calls stay demo-only.
5. **New mail gets a first sort by plain code** (newsletters, receipts, calendar replies, automated notices), with the reason shown. Only a thread a person wrote is read by the model, once, and the model only proposes: the thread moves when the person accepts it in Triage.
6. **There is no outage fallback model yet.** I had set `anthropic/claude-opus-5` as the fallback; the review against the brief pointed out that a fallback reads the same mail as the default, so it is a model added without the eval or your OK. It is removed. The fallback list is supported (`TIMMY_MODEL_FALLBACKS`) and empty; if the default's providers are down, Timmy says so instead of answering from another model. The judge never falls back, whatever the list says.
7. **An app can be connected only once Timmy reads it or acts through it.** Outlook and Drive had Connect buttons that led to a connection nothing used, so they were switched off until built. They are built now (see decisions 14 to 17) and their buttons are real. Everything else still shows as coming soon; all of it will connect through Composio when its phase builds it (CRMs and lead sources in phase 2).
8. **Auto mode came back once it had something to decide.** It was withdrawn while nothing could use it. It now covers one thing: filing the thread the person has open, in their own mailbox, when they ask in the chat. Off by default.
9. **Limits.** A workspace's owner or admin can set its monthly model limit ($50 to start) and how many jobs run at once (2 to start), up to ceilings set on the server (`TIMMY_SPEND_CAP_CEILING_USD`, default $200; `TIMMY_CONCURRENT_RUNS_CEILING`, default 4). The ceilings protect whoever pays the model bill until billing exists. The limit on jobs applies to starting new work; a job that is waiting for an approval always resumes.
10. **One everyday mailbox per workspace in phase 0.** It is who "me" is in that workspace's mail. A mailbox per member comes with phase 1.
11. **The first morning run waits for the first mail sync.** A workspace that connects its mailbox after the day's run time still gets that day's run, once the first 30 days of mail are in, if that is within six hours of the set time.
12. **The morning run only prepares.** It drafts for threads you put in Follow Up, and for inbox threads Timmy read as needing a reply with at least medium confidence, where the other person wrote last and the thread is no older than 14 days. It never accepts a triage suggestion for you. Its model cost counts against the half of the monthly limit set aside for work nobody asked for. The workspace's time zone is taken from the owner's browser the first time they open it.
13. **How filing shows in Gmail.** Gmail label names can't contain “/”, so the labels are “Timmy Follow Up”, “Timmy Waiting” and “Timmy Read Through”. A labelled thread stays in Gmail's inbox; only Archived removes it. Say if you would rather labelled threads leave the inbox.

14. **How filing shows in Outlook.** Outlook has no labels, so Timmy's three places are categories with the same names (“Timmy Follow Up”, “Timmy Waiting”, “Timmy Read Through”) on the messages you received, which stay in the inbox. Archived moves them to Outlook's Archive folder; back to the inbox moves them back. Your own categories are never touched, and your copies in Sent Items are left where they are. Timmy does not add its categories to Outlook's colour list (that needs a broader permission), so they show without a colour until you give them one.
15. **An Outlook reply is a draft that is addressed, checked and then sent.** Outlook's own “reply” picks the recipients itself (whoever wrote the last message). Timmy makes a reply draft, sets To and Cc to exactly the approved people, reads back what Outlook holds, and sends only if it matches. If any step is refused nothing is sent; an unsent draft can be left in Drafts.
16. **Mail goes out exactly as approved: no signature is added by the provider.** Gmail's send tools now append the account's Gmail signature unless told not to. Timmy tells them not to, so the email is the text you saw and approved. Say if you would rather your signature were added (it would then also show in the preview).
17. **Composio toolkit versions are pinned.** The server had been running each tool at Composio's newest version, while the code was written against an older listing. Checking the newest versions found two differences that the stand-in provider could not: the calendar tool's “send invitations” setting had changed from yes/no to a word (fixed), and Outlook's tools had been renamed (Outlook is built on the new names). Versions now move forward only in config, after `check-composio.mts` passes.
18. **Drive is a list of names for now.** Reading inside a file means fetching an export from a link Composio returns, which wants its own care (size limits, what a document may tell the model). It is the next step for Drive, with the document index.
20. **Outlook is asked only for what Timmy uses.** Composio's default sign-in for Outlook asks for calendars, contacts, Teams chat and mailbox settings as well as mail. Timmy asks for mail (read, change, send), the calendar (read and write, since Nov 16) and the profile only (`COMPOSIO_SCOPES_OUTLOOK`; set it empty to go back to Composio's defaults if a real connect needs something more). Composio's real API issued a connect link with this set. Google is left at Composio's defaults, because Google only lets an app ask for permissions it has been approved for and Composio does not publish which narrower ones its app holds (see "Needs your attention").
19. **Timmy's own mail goes through Resend** (your choice). With it configured, sign-up requires confirming the address, which closes the gap the audit left open (anyone could register an address they don't own).

21. **Every connection is Composio; anything Composio doesn't offer is skipped for now** (owner's instruction, Nov 16). That covers CRMs and lead sources in phase 2, and it means the "treg" enrichment provider, which uses its own token, is not connected on real workspaces.
22. **No model evaluation is planned.** The evaluation in the PRD was for adding more models to the picker in Settings. Timmy reaches models through OpenRouter and the picker holds one, Claude Opus 5.5, so there is nothing to compare (owner's instruction, Nov 16). It comes back only if a second model is ever proposed.
23. **The "60% of drafts sent" goal is dropped** as a gate for phase 1 (owner's instruction, Nov 16).
24. **A decision card never acts by itself.** Choosing an answer only records the choice and starts a draft. The card's wording comes from a model reading someone else's email, so its answers are short labels, its figures need a real sentence behind them, and what the person picks is passed to the drafting step as their own words.
25. **The new UI's records are checked on the server, not replaced with new commands.** The frontend's doc proposed named commands (`doc.save`, `page.trash`, …). The screens send generic put / patch / remove operations today; rather than rewrite the screens, the server checks every such operation (`server/src/state/ws-check.ts`). Visitors' chat conversations are the exception: they can only be changed through the chat's own commands.
26. **Cold-email drafts are Timmy's own records on a real workspace.** The frontend branch planned to save them in the mailbox's Drafts folder and send them from Timmy. Your later decision stands: each draft opens in your mail app and you send it there; several are never sent in one go.

## Merged on Nov 16 from the parallel builds, and what is still being built

Merged, reviewed and tested here, all seven: **website chat**, **the automation engine**, **version history for pages with the 30-day trash**, **changes made in Gmail or Outlook itself**, **kinds for your trade in the ontology**, **Outlook's calendar with changing and deleting events**, and **file storage** (pictures uploaded to the bucket; attachments on outgoing email).

The file-storage build was cut off twice (a machine restart, then a usage limit) and resumed both times with its work intact.

The closing safety review ran on the code with six merged and is described above; file storage was merged after it and has its own security tests (`server/test/uploads.test.ts`).

**Bugs the builds found in code that was already here, now fixed with tests:**
- **Typing could be lost in the page editor on a real workspace.** The editor took its own save coming back from the server for a change made elsewhere and replaced what was on screen, dropping letters typed in between. `live-pages` now types across several saves and fails on the old editor.
- **Taking a cover or an icon off a page did nothing on a real workspace.** A cleared field was dropped on the way to the server. It now travels as "null" and the server reads it as cleared.
- **A half-made task broke the Tasks screen for the whole workspace.** Tasks are checked like pages now: a task needs its status, priority and created date.
- **Triage blanked the whole app** when an inbox thread had no suggestion (one moved back to the inbox by hand). It now lists the thread with every place to choose from. `live-filing` checks it.
- **The demo's "reload" action** would have put the sample workspace in place of a real one. It was only refused by a later, unrelated check; it is now refused by name.

**Tests changed in these merges, and why:**
- `server/test/unit.test.ts` asserted that Outlook is asked for no calendar permission. Outlook's calendar is read and written now, so it asserts the exact set: mail, `Calendars.ReadWrite` and the profile, nothing else. `server/test/outlook.test.ts` lists Outlook's calendar event among the events subscribed to. `e2e/live/live-outlook.cjs` expected the card to say the calendar is not read; it now expects "Outlook mail and calendar".
- `server/test/mailbox-changes.test.ts` (new) proves a picked-up change writes nothing by listing the calls that only read. Connecting Outlook now reads its calendar too, so that read is on the list.
- `server/test/helpers.ts`: every test file now starts by disconnecting accounts earlier files left connected. The nightly-check test sweeps every connected mailbox in the shared test database, and the test job runner stops a sweep after 200 jobs; four of the builds hit that limit as soon as they added a test file.
- `e2e/live/live-pages.cjs`: its new typing check pressed keys 7 ms after clicking, before the editor had read where the click put the cursor, so on a fast run the keys acted at the top of the page. It was traced event by event; the typed text was never lost. The test now lets the page take a turn after the click.
- `server/test/commands.test.ts` and `isolation.test.ts` wrote tasks with only an id and a title. The server now refuses a task the board could not draw, so they write whole tasks (`task()` in `helpers.ts`). What they assert is unchanged.
- `server/test/pages.test.ts`: three lines the chat build added expected a change to an id such as `constructor` to be ignored; this branch refuses it, the stricter of the two fixes that met.
- `e2e/live/live-pages.cjs` asserted that switching on an automation or the chat was refused as "not switched on yet". Both run now, so it asserts the real gates: a chat needs a website first, and an automation that starts from a form is refused because no form can be connected.
- `e2e/live/live-chat.cjs` (new) clears the three starter questions a new workspace's chat has on this branch before asking its own.
- `e2e/e2e-pages.cjs` (demo) read the browser's saved state 280 ms after pressing Restore, while the demo saves 400 ms after the last change. Under load it failed 2 runs in 3. The check is unchanged; it now looks until it holds, for up to three seconds.

## The known gaps, closed (Nov 17, 2026)

Five builds, each in its own copy of the repo, reviewed, merged and tested here together. API suite 849 of 849 on the result.
- **Calendars and Outlook mail.** An Outlook account connected without calendar permission is recorded at the first refused read and its card says to connect it again. Every calendar is read again nightly. An edit made inside a new event's undo window replaces the waiting create under the same approval rules, so guests hear once. A delete whose outcome was unknown is settled by asking for the event by id. Outlook shows attachment names, creates an Archive folder when a mailbox has none, and removes a draft left behind by a send that stopped. A label or category already on a message when Timmy first sees it never moves a thread. Opening the app looks at the mailbox at most every five minutes.
- **Drive and OneDrive.** Drive files are found by the words inside them (Docs, Sheets and Slides, read in a bounded pass into Postgres's full-text index; the text goes with the file). Files shared with the person long ago are listed. A nightly check drops files Drive says are trashed or gone. OneDrive connects read-only (Files.Read, offline_access, User.Read), is kept current by its change feed, and Word, Excel and PowerPoint text is read by a small reader of our own with strict limits. Drive and OneDrive accounts can only call read-only tools.
- **Website chat.** It can be served from its own address (`CHAT_PUBLIC_URL`), where nothing but the chat answers and no cookie is set. A proof-of-work bot check before a conversation's first message. Per-address limits counted in Postgres, so they hold across servers. Chat leads on the Speed to lead clock; a Today card and an in-app notice when a visitor asks for a person; older conversations browsable; a cap on open streams per workspace; the chat switches off when the person who switched it on loses the role.
- **Automations.** Test run uses the server's dry run, on sample data or a recent email. One Approvals card for Draft then Send. Members see who a card waits for. New-email automations pause while no mailbox is connected. Runs count against the workspace's limit on jobs at once. A line an automation adds to a page survives a save from an editor opened before it. An automation switches off when the person who switched it on loses the role.
- **Pages, files, the ontology and leftovers.** A page deleted for good keeps its versions hidden for the trash period, so Undo brings both back. Restoring a version leaves out links to pages deleted since and says which. Uploads nothing has referenced for 7 days are deleted. The server strips location and other metadata from JPEG, PNG and WebP. Virus scanning is ready to switch on (ClamAV). Accepting a kind reads the last 30 days' mail for it (at most 25 threads); near-duplicate things are offered for merging; dismissed kinds can be brought back. A Unibox reply to a lead who wrote back goes through approval and the undo window. Sample wording is gated to the demo.

Two test-harness flaws were found on the way and fixed: the "each test file starts with no account connected" reset only ran before the first file (it is now a vitest setup file, proven with a two-file probe), and browser checks looking for a "Connect" button also matched "Disconnect", so some waits proved nothing (now exact).

Tests changed on purpose in these merges, and why:
- `calendar-write.test.ts`: an edit inside the create window now cancels the first create and proposes a second; still exactly one write to the calendar.
- `outlook.test.ts`: a send that stopped before its draft was sent now removes the draft, so none are left in Drafts.
- `mailbox-changes.test.ts`, `live-mailbox.cjs`: the look on opening the app is now at most every five minutes, not every minute.
- `live-outlook.cjs`: connects mail-only first, to check the reconnect note.
- `automations.test.ts`: declining an automation's send now discards the draft it wrote (it stays if the person edited it since).
- `chat.test.ts`, `review-a.test.ts`: the test visitor solves the bot check before a first message; tests use an 8-bit challenge to stay quick.
- `sync.test.ts`: used OneDrive as its example of an app that can't be connected; it now uses Salesforce.
- `page-versions.test.ts`: deleting a page for good now hides its versions until Undo or the sweep, instead of deleting them.
- `helpers.ts`: sample pictures are real pictures, since the server now parses every one.
- `live-files.cjs`: the stand-in scanner refusing the test virus is expected.

Next: the code debt listed below (the gateway's screen list moved out, routes split, stand-ins moved to a testing folder, typed job payloads, and support for a separately held database credential for the system role).


## Needs your attention

- **CopilotKit Intelligence key.** Rotate the `cpk-` key you pasted in chat (CopilotKit dashboard), then add the new one to `app` in Railway as `CPK_INTELLIGENCE_API_KEY`, staging first. Until then Ask runs through CopilotKit's runtime without saving conversations in its cloud.

- [ ] **Separately held database credentials** (recommended before outside users). The server supports them; switching is a Railway change only you can make. On staging first, then production: (1) make two random passwords (for example `openssl rand -hex 32`, twice); (2) on the `app` service add `TIMMY_APP_DATABASE_URL=postgresql://timmy_app:<app password>@<host>:<port>/<db>` and `TIMMY_SYSTEM_DATABASE_URL=postgresql://timmy_system:<system password>@<host>:<port>/<db>` (same host, port and database as today's `DATABASE_URL`), without deploying yet; (3) in psql as the database's superuser, run `alter role timmy_app with login password '<app password>';` and the script that creates `timmy_system` and makes it owner of Timmy's schemas (in `docs/ops/database-credentials.md`, with every step); (4) deploy and check the logs show "Timmy API listening" and `/api/health` answers; (5) remove `DATABASE_URL` from the `app` service only and redeploy, so the app no longer holds the superuser's password. Expect about a minute of errors between steps 3 and 4. Rollback: put `DATABASE_URL` back and delete the two variables.
- [ ] **The website chat's own address** (recommended before customers put the chat on their sites). Pick an address; a separate domain such as `timmychat.com` isolates best, a subdomain such as `chat.yourdomain.com` also works. Then: (1) in Railway, open the `app` service (production) → Settings → Networking → Custom Domain and add it; (2) add the CNAME (and any TXT record) Railway shows at your DNS provider and wait until Railway shows it verified with a certificate; (3) set `CHAT_PUBLIC_URL=https://chat.yourdomain.com` (no path) on the same service. Check that `/chat.js` loads there, `/` answers 404 there, and the app's own `/chat.js` answers 404. Snippets already pasted with the app's address stop working and must be replaced. Optional: `TIMMY_CHAT_CHALLENGE_BITS` (bot-check difficulty, default 18).
- [ ] **Virus scanning for uploads, if you want it.** The code is ready; it needs a ClamAV service the `app` service can reach (for example ClamAV's official Docker image as a second Railway service, about 1–1.5 GB of memory for its signatures, so it adds hosting cost). Then set `CLAMAV_HOST` and `CLAMAV_PORT` on `app`. Say the word and I will set it up on staging first; I won't add a paid service without your OK.
- [x] **Your production account** (Nov 18): your address is on `TIMMY_SIGNUP_ALLOW`, at your request. Anyone else still needs an invitation or to be added there.
- [ ] **Production sign-up is invite-only since the audit.** To create your own account on production, add your address to the `app` service's variables: `TIMMY_SIGNUP_ALLOW=you@example.com` (several addresses, or whole domains like `@example.com`, separated by commas). People you invite to a workspace can sign up without being on the list. `TIMMY_SIGNUP=open` opens it to everyone; I recommend leaving that until a mail provider is in place and sign-ups can verify their address. Staging stays open, which the test suites need.
- [ ] **Confirm or reverse the mailbox rule** (see the audit section): a member's send from a mailbox someone else connected waits for that person.
- [ ] **A test Gmail account** I may send from, and an address I may send to. Connecting it needs a person at Google's consent screen, so you press Connect once. Only one of Gmail and Outlook can be a workspace's mailbox at a time, so the two tests use two workspaces.
- [ ] **Turn on backups** for the `pgvector` volume (Railway dashboard → the volume → Backups). There is no tool for it on my side.
- [ ] **Rotate the keys pasted in chat** (two Composio keys, one OpenRouter key) once setup is done. They are not in the repo or in logs.
- [ ] **Add Resend to production.** On the `app` service in Railway add `RESEND_API_KEY` and `TIMMY_MAIL_FROM` (for example `Timmy <timmy@yourdomain.com>`; the domain must be verified in Resend). Sign-in links, invitations and resets are then delivered, and new accounts must confirm their address. Tell me an address I may send one test email to.
- [ ] **Composio's Google verification: what it means and what is not confirmed.** Google makes any app that reads Gmail pass its own app review plus a yearly outside security assessment (CASA); an app that hasn't is limited to 100 users and its sign-ins expire after 7 days. With Composio's managed app, that app is Composio's, so the review is theirs to hold. Composio's pages say it “registers and maintains the Google OAuth app” and that there is “no verification on your end”; they do not say in so many words that their app has passed the review for reading mail. The first real Gmail connect will show it: an “unverified app” warning or a 100-user cap would mean it has not. For production with many users Composio itself recommends your own Google app (your name on the consent screen, your own quota), which then needs the review. Sources are in the PRD's connections section.
- [ ] **What Google's sign-in page will ask for.** With Composio's Google app, connecting Gmail asks for full mail access and also your contacts and profile details (birthday, addresses, phone numbers); connecting Drive asks for full access to your files, although Timmy only lists their names. Those are Composio's default sets, and I have not narrowed them because a permission their app is not approved for would block sign-in. Two ways to narrow: ask Composio which smaller sets their app supports (then it is one variable per app, `COMPOSIO_SCOPES_GMAIL` and `COMPOSIO_SCOPES_GOOGLEDRIVE`), or move to your own Google app, which also puts Timmy's name on the page and needs Google's review. Your call; nothing is blocked meanwhile.
- [ ] **A test Outlook account and a test Drive**, the same as the test Gmail account: a person presses Connect once. A company Microsoft 365 account may show “Need admin approval” on Microsoft's page; a personal Outlook.com account does not.
- [ ] **Confirm or change three Outlook and Gmail choices** (decisions 14 to 16): categories for filing in Outlook, replies sent as a checked draft, and no provider signature.
- [ ] **The production frontend's branch.** `web` deploys `claude/modest-meitner-59cqpr`; this work is on `claude/funny-keller-5ouhro`. I will not change that service without your OK.
- [ ] **An outage fallback model, if you want one.** None is configured (decision 6). Tell me which model to evaluate; I run the eval, show you the numbers, and you decide.
- [ ] **OpenRouter budget for this session.** The key attached to the session has about $11 left; a large eval needs more.
- [x] **Staging's `app` is pointed back at `claude/funny-keller-5ouhro`** (your OK, Nov 16). All 13 suites that run there pass on it.
- [x] **Open questions from the new-UI doc: you confirmed the defaults** (Nov 16). The website chat answers from rules only at launch, no model; an automation's Send step always waits for a person (sending without asking comes later, owner or admin only); two people typing in one page at once is left for phase 3; chat transcripts are kept 12 months and trashed pages 30 days; the chat loader is served from the app's own address until you pick a domain such as `chat.timmy.app`.
- [ ] **Rotate the Supadata key** you pasted (it is not in the repo or logs), along with the earlier pasted keys.

## What's next

1. **A real mailbox end to end.** Connect a test Gmail, Outlook and Drive account (a person has to press Connect at the consent screen), backfill, a real email in, a real send out with an attachment, a calendar change with a guest, and repeat the cost measurement. This is the first time anything runs on a real account, and it checks the points the builds could only confirm from Composio's definitions: what Gmail and Outlook return for labels, trash and categories; that Composio accepts staged attachments; Outlook's calendar permission; and the reading prompt on the real model.
2. **Paperwork that needs outside parties:** a penetration test by an outside firm, and a data processing agreement reviewed by a lawyer and signed. Drafts to hand them are in `docs/legal/`.
3. **Before real customers put the chat on their sites:** serve the chat's loader and frame from their own address (such as `chat.timmy.app`), and add a bot check.
4. **Phase 2 (sales and teams)**, per the PRD: CRM sync and lead sources through Composio, and a mailbox per member.

Done on Nov 16 and 17: all seven parallel builds merged and tested locally and on staging; the closing safety review (two independent reviewers, 24 breaks proven with tests, all fixed); an outside-attacker check of staging and production (`live-outside`).

What is still open in phase 1 (none of it lets anything be sent without approval):
- **Only a real account can confirm**: how Google and Outlook show the times Timmy writes; that Outlook tells guests about a change; the exact refusal Composio returns for an Outlook calendar read without permission (Timmy matches the usual wordings); that Outlook keeps categories on mail sent within one company; what `OUTLOOK_DELETE_MESSAGE` does to a draft; that an Archive folder Timmy makes behaves like Outlook's own; which host Composio's OneDrive download links use (an unexpected one fails safely); that Composio accepts the narrowed OneDrive and Outlook permissions; that attachments staged through Composio really arrive; and how the real model handles the longer reading prompt.
- **Changes made in the mailbox**: mail deleted for good before Timmy saw it in the trash stays until the nightly re-read; only the last three days are looked at; Gmail's snooze reads as archived until the snooze ends.
- **Files**: virus scanning needs a ClamAV service to run (see "Needs your attention"); until then uploads are marked as not scanned. Office files and PDFs stored in Google Drive are listed but not read (Docs, Sheets and Slides are). Files other people share in OneDrive are not listed (that needs a wider permission). An Undo older than the 7-day clean-up can bring back a picture block whose file is gone.
- **Website chat**: it is served from the app's own address until a domain is set up (see "Needs your attention"). The bot check slows a script down rather than stopping one; the per-address and per-day caps are the real bound.
- **Pages**: a teammate's save or an Undo arriving while someone has unsaved typing on the same page still replaces what is on screen (only an automation's lines are merged in). A link to a page in the trash shows as "Deleted page".
- **Approvals**: cards other than automations' (a delegate's send waiting for the executive) still show Approve to people the server will refuse. An approved send removes the thread's draft even if someone edited it meanwhile.
- **Ontology kinds**: matching is by whole words, so near-duplicates are offered for merging rather than merged; accepting a kind reads 30 days of mail, not all of it.
- A Unibox reply to a lead also archives and files the thread, as every reply does.


Known debt in the code: paid down on Nov 17, with no change in behaviour (856 of 856 API tests, all 21 browser suites, the production bundle starts):
- The Action gateway's screen list moved to `server/src/gateway/screens.ts` and its hooks to a small typed registry, `hooks.ts`; the gateway now only proposes, decides, executes and settles effects.
- The API's routes are split by area (`server/src/http/settings.ts`, `connections.ts`, `audit.ts`, `state.ts`); the 127 routes and their middleware are in the same order as before, checked route by route.
- The stand-ins (Composio, the model, the job runner, the file store, the scanner) live in `server/src/testing/`, chosen exactly as before.
- Job payloads are typed: a misspelt job name or field no longer compiles (all 46 jobs; no real bug was found).
- The database roles can sign in with separately held credentials (see "Needs your attention" for the steps).

Still to come, with the cloud computer in phase 3:
- Per-turn tokens, the sandbox interface and the file bucket are not in code yet: the agent's tools run inside the server and never see a key. They arrive with the cloud computer in phase 3.
