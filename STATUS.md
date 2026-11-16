# Timmy backend: status

Last updated: Nov 16, 2026 (session 1). Read this first, then `tests.json`, then `git log`.
The brief is `docs/fable-build-prompt.md`; the plan is `docs/backend-prd.md`.

## Where things stand

**Phase 0 (foundations) is built, deployed to staging and production, and tested on staging. It has been through an independent safety review, a code-standards review, a review against the brief, and a security audit with Cloudflare's skill; their findings are fixed or listed below as known debt. The one thing left for phase 0 is a run on a real Gmail account, which needs a person at Google's consent screen (see "Needs your attention").**

| Piece | State |
| --- | --- |
| API server (`server/`, Hono on Node) | Built and deployed. Serves the API and the live app from one origin. |
| Postgres with row-level security | Built (`server/migrations/0001_init.sql`). Production runs Postgres 18 from the pgvector template. |
| Sign-in and workspaces (Better Auth: email + password, email link, six roles, invitations) | Built. Email links and invitations are written to an outbox table until a mail provider is chosen. |
| State sync (`POST /api/v1/commands`, `GET /api/v1/stream`) | Built. The server runs the frontend's own reducer and sends patches. |
| Action gateway, effect records, audit log, 30-second undo | Built. |
| Composio: connect, mail backfill, new-mail webhook, nightly mail check, calendar sync, item store | Built and tested against the fake provider, for Gmail and Google Calendar. Every other app shows as coming soon and the API refuses to connect it. The real key works (connect links were minted against the real API); a real Gmail account has not been connected yet. |
| Model layer (OpenRouter), model picker, cost log, spend cap | Built. Real calls made on Claude Opus 5.5. An owner can set the monthly limit in Settings, up to a ceiling the server sets ($200 by default). No fallback model is configured (see decision 6). |
| Agent loop (leased runs, checkpoints, pause for approval), Ask over mail | Built. |
| Reading mail and drafting (phase 1, started early) | Built: the model reads threads people wrote and proposes a sort; the Draft button writes a draft. |
| Filing written back to Gmail (phase 1) | Built. Sorting a thread in Timmy labels it in Gmail (“Timmy Follow Up”, “Timmy Waiting”, “Timmy Read Through”) and leaves it in Gmail's inbox; archiving takes it out of the inbox; Undo files it back. Each write is an effect record approved by the person's own action. Tested against the fake provider; the three Gmail calls were checked against Composio's tool list, not yet run on a real mailbox. |
| Filing from the chat, and Auto mode (phase 1) | Built. Ask Timmy to file or archive a thread and it shows the change with “File it” and “Leave it”. With the setting in Settings › Approvals switched on, Timmy files what you clearly asked for and asks when unsure: a judge model decides from your own words and a fixed description of the action, never from the mail. The setting covers labels and archiving only; a send always waits for Send. |
| The morning run (phase 1) | Built. At the time and on the days set in Settings › Schedule, in the workspace's own time zone, Timmy checks the mailbox for anything the triggers missed, reads what people wrote, and drafts replies to what needs an answer (10 at most). It moves nothing and sends nothing; the drafts wait in Approvals. Today and the activity log say what it did. It needs a connected mailbox, and no run time is shown without one. |
| Cold email (phase 2, built early because the decision was made) | Built as decided: Timmy writes it and opens Gmail's compose window; nothing cold goes through an API. The lead is marked contacted when sync sees the email in Sent, and replies show in the Unibox. |
| Frontend live mode (`VITE_TIMMY_LIVE=1`) | Built: sign-in, onboarding, state from the API, Connect buttons, model picker, monthly limit, approvals for writes Timmy proposes. The demo is unchanged and still the default build. |
| Railway | `app` (API + live app), `pgvector` and the bucket `timmy-files` exist in `production` and `staging`. Both `app` services have the OpenRouter and Composio keys. |

## What is deployed

Railway project `timmy`. Production:

| Service | What it is | URL |
| --- | --- | --- |
| `web` | The demo (unchanged; deploys `claude/modest-meitner-59cqpr`) | https://web-production-c4bbfc9c.up.railway.app |
| `app` | The API and the live app (deploys `claude/funny-keller-5ouhro`, `server/Dockerfile`) | https://app-production-a7a7000d.up.railway.app |
| `pgvector` | Postgres 18 with pgvector. Private network only: its public TCP endpoint was removed. | none |
| `timmy-files` | Bucket for files and, later, sandbox homes. Wired to `app` by reference variables; not used by code yet. | none |

Production `app` has real providers configured. No test sign-ups have been made on production.

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
bash scripts/dev.sh live     # the 9 live-mode Playwright suites (fake providers)
```

Local Postgres stops when the cloud session's worker restarts; `bash scripts/dev.sh db` starts it again.
In a cloud session set `NODE_USE_ENV_PROXY=1` so Node's `fetch` uses the session's proxy (it supplies the OpenRouter key). The Composio key for local smoke runs has to be supplied again in a new session.

Cost measurement: `server/scripts/measure-cost.ts` (the header says how to run it).

## Test results (Nov 16, 2026, all run locally)

| Suite | Result |
| --- | --- |
| API unit and integration (`server/test`, 12 files) | 206 of 206 pass |
| Demo-mode Playwright (`e2e/`, 12 suites, 348 checks) | 12 of 12 pass |
| Live-mode Playwright (`e2e/live/`, 9 suites, 155 checks) | 9 of 9 pass |
| Live-mode Playwright against **staging** (Railway) | 8 of 8 pass (139 checks) on the build with the morning run. The sign-up suite was run three times to confirm the reload fix. To be run again after each push. |
| Demo suites against a deployed build of this branch | Not run: `web` deploys the older branch, and I won't change that service without your OK |
| Real-provider smoke (real Gmail through Composio) | Not run: needs a test Gmail account connected by a person |

Two changes were made to the existing demo suites, both to make them run correctly, not to make them pass:
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

**A rule I changed because the audit raised it, for you to confirm or reverse:** an email leaves under the name of whoever connected the mailbox. A send from that mailbox by anyone else who is not an owner or admin now waits for the mailbox's owner, the same way a delegate's send waits for the exec. Before, any member could send from the workspace's mailbox on their own approval.

**Found by running the suites on staging:** a change made a moment before the page was reloaded or closed could be lost, because the request that saves it was cut off with the page. It showed up as the sign-up suite failing about half the time on staging and never on one machine. Saves now finish even after the page is gone. A tab also no longer shows its own change twice for a moment when the stream delivers it before the answer to its request. `e2e/live/live-signup.cjs` now reloads immediately after adding a rule, on purpose, and checks the rule is there once.

Not done, by choice: a full content-security policy for scripts (the dictation model loads from a CDN, and the policy needs an inventory first); pinning the Docker base image by digest; rate limits on commands and chat beyond the cap on jobs at once; a narrower database role for the API process (it holds the owner's credentials); cleaning the document viewers' saved files at sign-out. The audit could not check four things from where it ran: stream load on the shared database pools, memory use on a very large mailbox, how long pg-boss keeps finished jobs, and where the prebuilt document-viewer binaries came from.

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
7. **An app can be connected only once Timmy reads it or acts through it.** Outlook and Drive had Connect buttons that led to a connection nothing used. They now show as coming soon, like the rest, until phase 1 builds them.
8. **Auto mode came back once it had something to decide.** It was withdrawn while nothing could use it. It now covers one thing: filing mail in the person's own mailbox when they ask in the chat. Off by default.
9. **Limits.** A workspace's owner or admin can set its monthly model limit ($50 to start) and how many jobs run at once (2 to start), up to ceilings set on the server (`TIMMY_SPEND_CAP_CEILING_USD`, default $200; `TIMMY_CONCURRENT_RUNS_CEILING`, default 4). The ceilings protect whoever pays the model bill until billing exists. The limit on jobs applies to starting new work; a job that is waiting for an approval always resumes.
10. **One everyday mailbox per workspace in phase 0.** It is who "me" is in that workspace's mail. A mailbox per member comes with phase 1.
11. **The first morning run waits for the first mail sync.** A workspace that connects its mailbox after the day's run time still gets that day's run, once the first 30 days of mail are in, if that is within six hours of the set time.
12. **The morning run only prepares.** It drafts for threads you put in Follow Up, and for inbox threads Timmy read as needing a reply with at least medium confidence, where the other person wrote last and the thread is no older than 14 days. It never accepts a triage suggestion for you. Its model cost counts against the half of the monthly limit set aside for work nobody asked for. The workspace's time zone is taken from the owner's browser the first time they open it.
13. **How filing shows in Gmail.** Gmail label names can't contain “/”, so the labels are “Timmy Follow Up”, “Timmy Waiting” and “Timmy Read Through”. A labelled thread stays in Gmail's inbox; only Archived removes it. Say if you would rather labelled threads leave the inbox.

## Needs your attention

- [ ] **Production sign-up is invite-only since the audit.** To create your own account on production, add your address to the `app` service's variables: `TIMMY_SIGNUP_ALLOW=you@example.com` (several addresses, or whole domains like `@example.com`, separated by commas). People you invite to a workspace can sign up without being on the list. `TIMMY_SIGNUP=open` opens it to everyone; I recommend leaving that until a mail provider is in place and sign-ups can verify their address. Staging stays open, which the test suites need.
- [ ] **Confirm or reverse the mailbox rule** (see the audit section): a member's send from a mailbox someone else connected waits for that person.
- [ ] **A test Gmail account** I may send from, and an address I may send to. Connecting it needs a person at Google's consent screen, so you press Connect once.
- [ ] **Turn on backups** for the `pgvector` volume (Railway dashboard → the volume → Backups). There is no tool for it on my side.
- [ ] **Rotate the keys pasted in chat** (two Composio keys, one OpenRouter key) once setup is done. They are not in the repo or in logs.
- [ ] **Composio's Google verification.** Get it confirmed in writing that Composio's managed Google app carries Google's restricted-scope verification and the CASA assessment. Their docs do not say so.
- [ ] **A mail provider for Timmy's own account mail** (sign-in links, invitations, password resets). Until then email + password works and links wait in an outbox table. Once there is one, invitations should also require a verified email.
- [ ] **The production frontend's branch.** `web` deploys `claude/modest-meitner-59cqpr`; this work is on `claude/funny-keller-5ouhro`. I will not change that service without your OK.
- [ ] **An outage fallback model, if you want one.** None is configured (decision 6). Tell me which model to evaluate; I run the eval, show you the numbers, and you decide.
- [ ] **OpenRouter budget for this session.** The key attached to the session has about $11 left; a large eval needs more.
- [ ] Which enrichment provider is "treg"?

## What's next

1. Finish phase 0: a real Gmail account end to end (connect, backfill, a real email in, a real send out), then repeat the cost measurement on it.
2. Phase 1, in this order: Waiting (track what you asked for, draft a nudge when the date slips), calendar events written to Google Calendar, decisions, ontology v1, Outlook and Drive. Reading mail, the Draft button and the morning run are built.

Known gaps to close in phase 1 (none of them lets anything be sent without approval):
- Calendar: Google Calendar events are synced in, but events added in Timmy are not written to Google Calendar yet.
- Filing is one-way: a thread sorted or archived in Timmy is labelled or archived in Gmail, but a thread archived or labelled in Gmail itself does not move in Timmy.
- Attachments cannot be sent.
- A few demo screens still show sample wording on a real workspace (the "undo anything for 7 days" line on Activity). The sample archive count, the sample "done without asking" list and the templates signed "Taylor" from "Northpeak" are fixed.
- A reply typed in the Unibox to a lead who wrote back is treated like cold email (it opens Gmail). It should go through the normal reply path, with approval and the undo window.

Known debt in the code (from the code-standards review; none of it is a safety gap):
- The Action gateway also keeps the screens' list of waiting actions up to date and calls back into the command engine through registered hooks. Those are three jobs in one module; the screen projection should move out.
- The API's routes are in one file apart from the agent and the test hooks. Settings, connections and audit should each get their own.
- The stand-in providers (`FakeComposio`, `FakeModel`) and the in-process job runner live in the same modules as the real ones. They should move to a `testing/` folder.
- Job payloads are untyped (`Record<string, unknown>`); a typed map of job name to payload would catch a misspelt field at compile time.
- The app database role's password is derived from the owner role's inside the server process. Before outside users, the system role should have a separately held credential (the PRD says so).
- Per-turn tokens, the sandbox interface and the file bucket are not in code yet: the agent's tools run inside the server and never see a key. They arrive with the cloud computer in phase 3.
