# Timmy backend: status

Last updated: Nov 16, 2026 (session 1, after Outlook, Drive and Resend). Read this first, then `tests.json`, then `git log`.
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
| Outlook mail (phase 1) | Built. Outlook connects through Composio like Gmail and is a workspace's mailbox in the same way (one mailbox per workspace, Gmail or Outlook). First read of the last 30 then 90 days, new mail and sent mail by event, the nightly check, sending and replying through the gateway with the undo window, and filing written back: Follow Up, Waiting and Read Through become Outlook categories with the same names, and Archived moves the messages to Outlook's Archive folder. HTML bodies are stored and shown as text. Outlook's calendar and OneDrive are not read yet, and the card says so. Tested against the fake provider and checked against Composio's real tool definitions; not yet run on a real mailbox. |
| Google Drive (phase 1) | Built, read-only. Timmy keeps a list of files changed in the last 90 days and from then on (name, kind, owner, when it changed, link), kept current by Drive's events and a nightly pass, and Ask can search it (“find the file …”). Timmy does not open files and writes nothing to Drive. Tested against the fake provider and checked against Composio's real tool definitions; not yet run on a real Drive. |
| Composio toolkit versions | Pinned in config (`composio.toolkitVersions`, overridable with `COMPOSIO_TOOLKIT_VERSIONS`). `server/scripts/check-composio.mts` checks every tool and event the server uses against Composio's API at the pinned versions; it passes. |
| Model layer (OpenRouter), model picker, cost log, spend cap | Built. Real calls made on Claude Opus 5.5. An owner can set the monthly limit in Settings, up to a ceiling the server sets ($200 by default). No fallback model is configured (see decision 6). |
| Agent loop (leased runs, checkpoints, pause for approval), Ask over mail | Built. |
| Reading mail and drafting (phase 1, started early) | Built: the model reads threads people wrote and proposes a sort; the Draft button writes a draft. |
| Filing written back to Gmail (phase 1) | Built. Sorting a thread in Timmy labels it in Gmail (“Timmy Follow Up”, “Timmy Waiting”, “Timmy Read Through”) and leaves it in Gmail's inbox; archiving takes it out of the inbox; Undo files it back. Each write is an effect record approved by the person's own action. Tested against the fake provider; the three Gmail calls were checked against Composio's tool list, not yet run on a real mailbox. |
| Filing from the chat, and Auto mode (phase 1) | Built. Ask Timmy to file or archive a thread and it shows the change with “File it” and “Leave it”. With the setting in Settings › Approvals switched on, Timmy files the one thread you have open when you ask, once per request, and asks about anything else: a judge model decides from your own words and a fixed description of the action, never from the mail. The setting covers a label or archiving only; a send always waits for Send. |
| Waiting (phase 1) | Built. A reply Timmy drafts that asks for something carries what the other person owes and by when (three working days when the email names no date), so “Send & track” moves the thread to Waiting. When the date passes with no answer, the morning run drafts a nudge (5 at most a day); the Draft button on such a thread writes a nudge too. Sending a nudge sets a new date. A reply ends the wait and drops a nudge that was drafted. Nothing is sent without Send. |
| Events written to Google Calendar (phase 1) | Built for new events. An event added in Timmy goes onto the connected Google Calendar after the undo window; with guests Google sends the invitations, so it is approved like an email (an assistant's waits for the exec, and a member using someone else's calendar waits for that person). Undo inside the window means nobody is invited. Once Google has the event, that copy replaces the one made in Timmy, so it shows once. Changing or deleting an existing event is not written back yet. Tested against the fake provider; the Google call was checked against Composio's tool list, not yet run on a real calendar. |
| The morning run (phase 1) | Built. At the time and on the days set in Settings › Schedule, in the workspace's own time zone, Timmy checks the mailbox for anything the triggers missed, reads what people wrote, and drafts replies to what needs an answer (10 at most). It moves nothing and sends nothing; the drafts wait in Approvals. Today and the activity log say what it did. It needs a connected mailbox, and no run time is shown without one. |
| Cold email (phase 2, built early because the decision was made) | Built as decided: Timmy writes it and opens the compose window of the connected mail app (Gmail, or Outlook on the web); nothing cold goes through an API. The lead is marked contacted when sync sees the email in Sent, and replies show in the Unibox. |
| Frontend live mode (`VITE_TIMMY_LIVE=1`) | Built: sign-in, onboarding, state from the API, Connect buttons, model picker, monthly limit, approvals for writes Timmy proposes. The demo is unchanged and still the default build. |
| Railway | `app` (API + live app), `pgvector` and the bucket `timmy-files` exist in `production` and `staging`. Both `app` services have the OpenRouter and Composio keys. |

## Merged in: the Notion-style editor, automations and website chat (Nov 16, 2026)

The UI branch `claude/modest-meitner-59cqpr` was merged into this one, with the owner's OK. It brings four things:

- the block editor for docs, with pages, a page tree and a trash;
- Automations in the AI library;
- Website chat in Outbound;
- the pipeline-style Tasks board.

Its design notes are in `docs/ui-additions-backend.md`.

What changed to make it work on the API:

- **New collections.** `trash`, `automations`, `chat` and `chats` were added to `WS_COLLECTIONS` (`src/live/patches.ts`), so the server keeps them. The new doc fields (icon, cover, and each block's indent, colour and formatting) ride inside `ws.docs`, as before.
- **Chat for new workspaces.** A new workspace starts with the website chat switched off, named after the workspace (`chatWidgetFor` in `src/data/ws-mock.ts`, used by `src/live/blank.ts`).
- **Tab sync.** In live mode the editor no longer passes saved docs between tabs itself, because the stream already does. It still shares cursors.
- **Picture size.** Pictures added in the live app are made smaller (1,000 px JPEG; 1,400 px for covers), so a doc stays under the API's 1 MB limit per command. A page with many pictures can still go over it. Uploads to the `timmy-files` bucket are the fix (see the design notes).
- **Nothing sends.** Automations and website chat save their settings only: nothing runs or sends yet. The chat's code snippet points to a script that doesn't exist yet.
- **New tests.**
  - `server/test/pages.test.ts`: the new state survives a reload from the database.
  - `e2e/live/live-pages.cjs`: type in a doc, icon and cover, trash and restore, draw and save an automation, and change the chat's settings, all through the API.
  - `e2e/e2e-pages.cjs` and `e2e/e2e-uis.cjs` in demo mode.

**Tested before it reached the backend branch.** Everything below was run on the merged code (`36bf1a7` and `49eab34`):

- **Locally:** type checks; 291 of 291 API tests (286 existing and 5 new); 17 of 17 demo suites, 450+ checks; 13 of 13 live suites.
- **On staging:** 12 of 12 live suites, 218 checks, including `live-pages`.
  - Staging's `app` was pointed at the temporary branch `claude/modest-meitner-59cqpr-staging` for the run, then back to this branch.
  - The test hooks were reached through the session's proxy, which holds the staging test token, using the new opt-in `TEST_PROXY` in `e2e/live/lib.cjs`.
- **Production `app`** got the merge only after this, by the push to this branch.

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

## Test results (Nov 16, 2026, all run locally)

| Suite | Result |
| --- | --- |
| API unit and integration (`server/test`, 18 files) | 286 of 286 pass |
| Demo-mode Playwright (`e2e/`, 12 suites, 348 checks) | 12 of 12 pass |
| Live-mode Playwright (`e2e/live/`, 12 suites, 205 checks) | 12 of 12 pass. Eleven run on one server; `live-verify` runs on a server restarted with address confirmation required. |
| Live-mode Playwright against **staging** (Railway) | 11 of 11 pass (199 checks) on build `231dc18`, including the new Outlook and Drive suite. On its first staging run that suite failed at its second connect: my test helper took the Drive connect as finished because the address bar still showed the earlier Outlook one. The helper now waits for each connect's own return trip. The app was not at fault and was not changed for it. |
| Composio tool check (`server/scripts/check-composio.mts`, real API, read-only) | Pass: 21 tools and 8 events exist at the pinned versions and take the arguments the code sends. |
| Real connect links for Outlook and Drive (Composio's real API) | Pass: a link was minted for each through the server's own code, with the pinned versions, and the pending accounts were removed again. Composio accepted the narrower Outlook permission set (`timmy-outlook-a7eae611`: mail and profile only). Nobody has signed in through them yet. |
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
20. **Outlook is asked only for what Timmy uses.** Composio's default sign-in for Outlook asks for calendars, contacts, Teams chat and mailbox settings as well as mail. Timmy asks for mail (read, change, send) and the profile only (`COMPOSIO_SCOPES_OUTLOOK`; set it empty to go back to Composio's defaults if a real connect needs something more). Reading Outlook's calendar later will mean asking each person to connect again. Google is left at Composio's defaults, because Google only lets an app ask for permissions it has been approved for and Composio does not publish which narrower ones its app holds (see "Needs your attention").
19. **Timmy's own mail goes through Resend** (your choice). With it configured, sign-up requires confirming the address, which closes the gap the audit left open (anyone could register an address they don't own).

## Needs your attention

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
- [ ] Which enrichment provider is "treg"?

## What's next

1. Finish phase 0: a real mailbox end to end (connect, backfill, a real email in, a real send out), then repeat the cost measurement on it.
2. Phase 1, in this order: decisions, ontology v1; then reading inside Drive files, Outlook's calendar, calendar changes and deletes, attachments, and reading back changes made in the mailbox. Reading mail, the Draft button, the morning run, filing, Waiting, Outlook mail and the Drive file list are built.
3. Before phase 1 ends: the subagent safety review, which will include the Outlook and Drive code added here.

Known gaps to close in phase 1 (none of them lets anything be sent without approval):
- Calendar: a new event is written to Google Calendar, but a change to an existing event, or deleting one, is not. Event times are sent to Google as UTC instants, which is right for the moment in time but has not been checked on a real calendar for how Google displays them.
- Filing is one-way: a thread sorted or archived in Timmy is labelled or archived in the mailbox, but a thread archived or labelled in Gmail or Outlook itself does not move in Timmy.
- Outlook: the calendar and OneDrive are not read; attachment names are not shown (Gmail's are); a mailbox with no Archive folder cannot be archived to (the filing fails cleanly and says so); a draft left behind by a refused reply is not cleaned up.
- Drive: only names are searched, not contents; a file shared with you long ago and not changed since is not on the list; files in the trash leave the list when Drive announces it, and a missed announcement leaves a stale entry until the file changes.
- Attachments cannot be sent.
- A few demo screens still show sample wording on a real workspace (the "undo anything for 7 days" line on Activity). The sample archive count, the sample "done without asking" list and the templates signed "Taylor" from "Northpeak" are fixed.
- A reply typed in the Unibox to a lead who wrote back is treated like cold email (it opens the mail app). It should go through the normal reply path, with approval and the undo window.

Known debt in the code (from the code-standards review; none of it is a safety gap):
- The Action gateway also keeps the screens' list of waiting actions up to date and calls back into the command engine through registered hooks. Those are three jobs in one module; the screen projection should move out.
- The API's routes are in one file apart from the agent and the test hooks. Settings, connections and audit should each get their own.
- The stand-in providers (`FakeComposio`, `FakeModel`) and the in-process job runner live in the same modules as the real ones. They should move to a `testing/` folder.
- Job payloads are untyped (`Record<string, unknown>`); a typed map of job name to payload would catch a misspelt field at compile time.
- The app database role's password is derived from the owner role's inside the server process. Before outside users, the system role should have a separately held credential (the PRD says so).
- Per-turn tokens, the sandbox interface and the file bucket are not in code yet: the agent's tools run inside the server and never see a key. They arrive with the cloud computer in phase 3.
