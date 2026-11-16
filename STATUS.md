# Timmy backend: status

Last updated: Nov 16, 2026 (session 1). Read this first, then `tests.json`, then `git log`.
The brief is `docs/fable-build-prompt.md`; the plan is `docs/backend-prd.md`.

## Where things stand

**Phase 0 (foundations) is built, deployed to staging and production, and tested on staging. It has been through an independent safety review, a code-standards review and a review against the brief; their findings are fixed or listed below as known debt. The one thing left for phase 0 is a run on a real Gmail account, which needs a person at Google's consent screen (see "Needs your attention").**

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
bash scripts/dev.sh live     # the 7 live-mode Playwright suites (fake providers)
```

Local Postgres stops when the cloud session's worker restarts; `bash scripts/dev.sh db` starts it again.
In a cloud session set `NODE_USE_ENV_PROXY=1` so Node's `fetch` uses the session's proxy (it supplies the OpenRouter key). The Composio key for local smoke runs has to be supplied again in a new session.

Cost measurement: `server/scripts/measure-cost.ts` (the header says how to run it).

## Test results (Nov 16, 2026, all run locally)

| Suite | Result |
| --- | --- |
| API unit and integration (`server/test`, 9 files) | 156 of 156 pass |
| Demo-mode Playwright (`e2e/`, 12 suites, 348 checks) | 12 of 12 pass |
| Live-mode Playwright (`e2e/live/`, 7 suites, 119 checks) | 7 of 7 pass |
| Live-mode Playwright against **staging** (Railway) | Last full pass was 6 of 6 (91 checks) on the commit before the code review. To be run again on this one once it has deployed. |
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

A second audit, using Cloudflare's security-audit skill, is running on the fixed code.

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

## Decisions made while building (the PRD is updated to match)

1. **One service serves the API and the live app, on one origin.** `up.railway.app` is on the public suffix list, so two Railway subdomains can't share a cookie, and cross-site cookies are blocked in Safari. The existing `web` service is untouched and stays the demo.
2. **The server runs the frontend's reducer.** Each client action is applied by the same reducer code on the stored state, and the difference goes back as patches keyed by entity. An action that would send mail is detected from the reducer's result and turned into an effect record first. Demo-only actions are refused on a real workspace.
3. **Cold email is never sent through Google's API.** (Owner's decision, Nov 16, replacing the earlier "send from the Composio-connected account".) Timmy writes the cold email; pressing Send opens Gmail's own compose window with the recipient, subject and body filled in, and the person sends it from Gmail. Timmy marks the lead as contacted when sync sees the email in Sent, and shows replies in the Unibox. A sequence cannot send itself: each email is one click by a person.
4. **Twilio (texts and the dialer) is skipped for now** (owner's instruction, Nov 16). Texts and calls stay demo-only.
5. **New mail gets a first sort by plain code** (newsletters, receipts, calendar replies, automated notices), with the reason shown. Only a thread a person wrote is read by the model, once, and the model only proposes: the thread moves when the person accepts it in Triage.
6. **There is no outage fallback model yet.** I had set `anthropic/claude-opus-5` as the fallback; the review against the brief pointed out that a fallback reads the same mail as the default, so it is a model added without the eval or your OK. It is removed. The fallback list is supported (`TIMMY_MODEL_FALLBACKS`) and empty; if the default's providers are down, Timmy says so instead of answering from another model. The judge never falls back, whatever the list says.
7. **An app can be connected only once Timmy reads it or acts through it.** Outlook and Drive had Connect buttons that led to a connection nothing used. They now show as coming soon, like the rest, until phase 1 builds them.
8. **Auto mode is not offered in Settings yet.** The only thing it may ever decide is routine filing in the person's own mailbox, and nothing files mail yet, so the setting did nothing. It comes back with label and archive write-back.
9. **Limits.** A workspace's owner or admin can set its monthly model limit ($50 to start) and how many jobs run at once (2 to start), up to ceilings set on the server (`TIMMY_SPEND_CAP_CEILING_USD`, default $200; `TIMMY_CONCURRENT_RUNS_CEILING`, default 4). The ceilings protect whoever pays the model bill until billing exists. The limit on jobs applies to starting new work; a job that is waiting for an approval always resumes.
10. **One everyday mailbox per workspace in phase 0.** It is who "me" is in that workspace's mail. A mailbox per member comes with phase 1.

## Needs your attention

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
2. Phase 1: the brief, Waiting, decisions, ontology v1, Outlook and Drive. (Reading mail with the model and the Draft button are already built.)

Known gaps to close in phase 1 (none of them lets anything be sent without approval):
- Calendar: Google Calendar events are synced in, but events added in Timmy are not written to Google Calendar yet.
- Labels and archive are not written back to Gmail.
- Attachments cannot be sent.
- **The morning run is not scheduled on real workspaces yet.** Timmy reads mail as it arrives and drafts when asked. The Today header and the bottom bar no longer claim a run time, but Settings › Schedule still lets you pick one, and it does nothing yet. This is the first thing phase 1 builds.
- A few demo screens still show sample wording on a real workspace (the "undo anything for 7 days" line on Activity). The sample archive count, the sample "done without asking" list and the templates signed "Taylor" from "Northpeak" are fixed.
- A reply typed in the Unibox to a lead who wrote back is treated like cold email (it opens Gmail). It should go through the normal reply path, with approval and the undo window.

Known debt in the code (from the code-standards review; none of it is a safety gap):
- The Action gateway also keeps the screens' list of waiting actions up to date and calls back into the command engine through registered hooks. Those are three jobs in one module; the screen projection should move out.
- The API's routes are in one file apart from the agent and the test hooks. Settings, connections and audit should each get their own.
- The stand-in providers (`FakeComposio`, `FakeModel`) and the in-process job runner live in the same modules as the real ones. They should move to a `testing/` folder.
- Job payloads are untyped (`Record<string, unknown>`); a typed map of job name to payload would catch a misspelt field at compile time.
- The app database role's password is derived from the owner role's inside the server process. Before outside users, the system role should have a separately held credential (the PRD says so).
- Per-turn tokens, the sandbox interface and the file bucket are not in code yet: the agent's tools run inside the server and never see a key. They arrive with the cloud computer in phase 3.
- The auto-mode judge is built and tested but nothing can reach it in production until a write that only touches the person's own mailbox exists (label and archive, phase 1).
