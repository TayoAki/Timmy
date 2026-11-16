# Timmy backend: status

Last updated: Nov 16, 2026 (session 1). Read this first, then `tests.json`, then `git log`.
The brief is `docs/fable-build-prompt.md`; the plan is `docs/backend-prd.md`.

## Where things stand

**Phase 0 (foundations) is built and tested locally, and the API is deployed to production. It is not yet proven on a real Gmail account or on a staging environment; both need one step from the owner (see "Needs your attention").**

| Piece | State |
| --- | --- |
| API server (`server/`, Hono on Node) | Built and deployed. Serves the API and the live app from one origin. |
| Postgres with row-level security | Built (`server/migrations/0001_init.sql`). Production runs Postgres 18 from the pgvector template. |
| Sign-in and workspaces (Better Auth: email + password, email link, six roles, invitations) | Built. Email links and invitations are written to an outbox table until a mail provider is chosen. |
| State sync (`POST /api/v1/commands`, `GET /api/v1/stream`) | Built. The server runs the frontend's own reducer and sends patches. |
| Action gateway, effect records, audit log, 30-second undo | Built. |
| Composio: connect, mail backfill, new-mail webhook, calendar sync, item store | Built and tested against the fake provider. The real key works (connect links were minted against the real API); a real Gmail account has not been connected yet. |
| Model layer (OpenRouter), model picker, cost log, spend cap | Built. Real calls made on Claude Opus 5.5. |
| Agent loop (leased runs, checkpoints, pause for approval), Ask over mail | Built. |
| Reading mail and drafting (phase 1, started early) | Built: the model reads threads people wrote and proposes a sort; the Draft button writes a draft. |
| Frontend live mode (`VITE_TIMMY_LIVE=1`) | Built: sign-in, onboarding, state from the API, Connect buttons, model picker, approvals for writes Timmy proposes. The demo is unchanged and still the default build. |
| Railway | `app` (API + live app), `pgvector` and the bucket `timmy-files` exist in **production**. No `staging` environment yet. |

## What is deployed

Railway project `timmy`, environment `production`:

| Service | What it is | URL |
| --- | --- | --- |
| `web` | The demo (unchanged; deploys `claude/modest-meitner-59cqpr`) | https://web-production-c4bbfc9c.up.railway.app |
| `app` | The API and the live app (deploys `claude/funny-keller-5ouhro`, `server/Dockerfile`) | https://app-production-a7a7000d.up.railway.app |
| `pgvector` | Postgres 18 with pgvector. Private network only: its public TCP endpoint was removed. | none |
| `timmy-files` | Bucket for files and, later, sandbox homes. Wired to `app` by reference variables; not used by code yet. | none |

`app` has no provider keys yet, so sign-in and workspaces work there but Connect and Ask answer "not configured". No test sign-ups have been made on production.

## How to run it

```bash
bash scripts/dev.sh          # local Postgres with pgvector, then every suite
bash scripts/dev.sh server   # the API's unit and integration tests
bash scripts/dev.sh demo     # the 12 demo-mode Playwright suites
bash scripts/dev.sh live     # the 6 live-mode Playwright suites (fake providers)
```

Local Postgres stops when the cloud session's worker restarts; `bash scripts/dev.sh db` starts it again.
In a cloud session set `NODE_USE_ENV_PROXY=1` so Node's `fetch` uses the session's proxy (it supplies the OpenRouter key). The Composio key for local smoke runs has to be supplied again in a new session.

Cost measurement: `server/scripts/measure-cost.ts` (the header says how to run it).

## Test results (Nov 16, 2026, all run locally)

| Suite | Result |
| --- | --- |
| API unit and integration (`server/test`, 7 files) | 108 of 108 pass |
| Demo-mode Playwright (`e2e/`, 12 suites, 348 checks) | 12 of 12 pass |
| Live-mode Playwright (`e2e/live/`, 6 suites, 91 checks) | 6 of 6 pass |
| Suites against staging | Not run: there is no staging environment yet |
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

## Decisions made while building (the PRD is updated to match)

1. **One service serves the API and the live app, on one origin.** `up.railway.app` is on the public suffix list, so two Railway subdomains can't share a cookie, and cross-site cookies are blocked in Safari. The existing `web` service is untouched and stays the demo.
2. **The server runs the frontend's reducer.** Each client action is applied by the same reducer code on the stored state, and the difference goes back as patches keyed by entity. An action that would send mail is detected from the reducer's result and turned into an effect record first. Demo-only actions are refused on a real workspace.
3. **Cold email is sent from mailboxes connected through Composio** (owner's instruction, Nov 16), not from a separate SMTP pool.
4. **Twilio (texts and the dialer) is skipped for now** (owner's instruction, Nov 16). Texts and calls stay demo-only.
5. **New mail gets a first sort by plain code** (newsletters, receipts, calendar replies, automated notices), with the reason shown. Only a thread a person wrote is read by the model, once, and the model only proposes: the thread moves when the person accepts it in Triage.
6. **The outage fallback** after Claude Opus 5.5 is `anthropic/claude-opus-5`. It is not user-selectable.

## Needs your attention

- [ ] **Create the `staging` environment.** My Railway tools cannot create an environment. In the Railway dashboard: project `timmy` → environment menu → New environment → name it `staging` → duplicate `production`. That copies `app`, `pgvector`, the bucket and their wiring. Tell me when it exists and I will set its variables and run every suite against it.
- [ ] **Add two secrets to the `app` service** (production, and staging once it exists): `OPENROUTER_API_KEY` and `COMPOSIO_API_KEY`. Or tell me to set them from the keys you pasted.
- [ ] **A test Gmail account** I may send from, and an address I may send to. Connecting it needs a person at Google's consent screen, so you press Connect once.
- [ ] **Turn on backups** for the `pgvector` volume (Railway dashboard → the volume → Backups). There is no tool for it on my side.
- [ ] **Rotate the keys pasted in chat** (two Composio keys, one OpenRouter key) once setup is done. They are not in the repo or in logs.
- [ ] **Composio's Google verification.** Get it confirmed in writing that Composio's managed Google app carries Google's restricted-scope verification and the CASA assessment. Their docs do not say so.
- [ ] **Cold email from the connected account.** Google's API policy forbids sending unsolicited commercial mail through its user-data APIs, and complaints land on the domain used for everyday mail. Also, Composio's Gmail send tool has no custom-header field, so one-click unsubscribe needs their proxy call with a hand-built message.
- [ ] **A mail provider for Timmy's own account mail** (sign-in links, invitations, password resets). Until then email + password works and links wait in an outbox table. Once there is one, invitations should also require a verified email.
- [ ] **The production frontend's branch.** `web` deploys `claude/modest-meitner-59cqpr`; this work is on `claude/funny-keller-5ouhro`. I will not change that service without your OK.
- [ ] **OpenRouter budget for this session.** The key attached to the session has about $11 left; a large eval needs more.
- [ ] Which enrichment provider is "treg"?

## What's next

1. Finish phase 0: the independent safety review (running), staging, a real Gmail account, then the phase 0 report.
2. Phase 1: triage with a model for what plain code can't settle, the brief, drafts on their own route, Waiting, decisions, ontology v1, Outlook and Drive.

Known gaps to close in phase 1 (none of them lets anything be sent without approval):
- Calendar: Google Calendar events are synced in, but events added in Timmy are not written to Google Calendar yet.
- Labels and archive are not written back to Gmail.
- Attachments cannot be sent.
- When someone other than the sender has to approve an email (a delegate's send), the thread shows as sent only after the next sync.
- A few demo screens still show sample wording on a real workspace (the "undo anything for 7 days" line on Activity).
