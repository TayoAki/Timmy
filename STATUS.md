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
| Composio: connect, backfill, new-mail webhook, item store | Built and tested against the fake provider. The real key works; a real Gmail account has not been connected yet. |
| Model layer (OpenRouter), model picker, cost log, spend cap | Built. Real calls made on Claude Opus 5.5. |
| Agent loop (leased runs, checkpoints, pause for approval), Ask over mail | Built. |
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
| API unit and integration (`server/test`, 6 files) | 98 of 98 pass |
| Demo-mode Playwright (`e2e/`, 12 suites, 348 checks) | 12 of 12 pass |
| Live-mode Playwright (`e2e/live/`, 6 suites, 88 checks) | 6 of 6 pass |
| Suites against staging | Not run: there is no staging environment yet |
| Real-provider smoke (real Gmail through Composio) | Not run: needs a test Gmail account connected by a person |

Two changes were made to the existing demo suites, both to make them run correctly, not to make them pass:
- Eight suites ignored `BASE` and always tested `localhost:5173`. They now honor it.
- `e2e-fixes` was failing before any backend work. Its last block clicked the first row on Today and assumed it was an email; since leads were added to Today the first row is a lead. It now opens a mail row and asserts that it did.

## Measured cost per user (phase 0)

Measured with `server/scripts/measure-cost.ts`: the real sync code on a 3,000-message mailbox (30 days at 100 a day), and real calls to Claude Opus 5.5 through OpenRouter with reasoning effort "low". The mailbox content is synthetic, so the token counts are a first reading, to be repeated on a real mailbox.

**Model (real calls)**

| Route | Model calls per turn | Input tokens (of which cached) | Output tokens (of which reasoning) | Cost per turn |
| --- | --- | --- | --- | --- |
| Ask over mail | 3.2 | 12,572 (8,078) | 548 (52) | $0.035 |
| Draft a reply from chat | 5.0 | 20,221 (16,213) | 929 (76) | $0.042 |
| Prepare a send for approval | 1.0 | 1,756 (1,604) | 144 (0) | $0.004 |
| Read every new item | 0 | 0 | 0 | $0 (plain code only in phase 0) |

Prompt caching is working: 64% to 80% of input tokens were served from the cache.

**Composio calls (counted from the real code paths)**

| Step | Calls |
| --- | --- |
| Connect a mailbox | 3 (link, profile, trigger) |
| Backfill | 1 per 50 messages: 60 for 30 days, 180 for 90 days |
| Each new email | 1 (fetches the whole thread). This can drop to about 0 by using the message the trigger already carries; not done yet. |
| Each send | 1 |

**Per user per month, at 100 emails a day, 150 Ask turns and 300 drafts** (the PRD's volumes)

| Item | Cost |
| --- | --- |
| Ask | $5.25 |
| Drafts | $12.60 (through the chat path; a single-call drafting route in phase 1 should cost less) |
| Reading items | $0 now. Plain code gave a confident first sort to 70% of threads in the test mailbox; phase 1 sends only the rest to a model. |
| Composio | about 3,300 calls: $16.50 at the $5 per 1,000 overage price, or about $6 if covered by pooled seats (10,000 calls per $18 seat). About $2 after the new-email change above. |
| One-time backfill (90 days) | 180 Composio calls (about $0.90 at the overage price); no model cost in phase 0 |

So phase 0 as built is about **$18 of model cost and $2 to $17 of Composio cost per user per month**, in line with the PRD's estimate. The largest lever is the per-email Composio call.

## Decisions made while building (the PRD is updated to match)

1. **One service serves the API and the live app, on one origin.** `up.railway.app` is on the public suffix list, so two Railway subdomains can't share a cookie, and cross-site cookies are blocked in Safari. The existing `web` service is untouched and stays the demo.
2. **The server runs the frontend's reducer.** Each client action is applied by the same reducer code on the stored state, and the difference goes back as patches keyed by entity. An action that would send mail is detected from the reducer's result and turned into an effect record first. Demo-only actions are refused on a real workspace.
3. **Cold email is sent from mailboxes connected through Composio** (owner's instruction, Nov 16), not from a separate SMTP pool.
4. **Twilio (texts and the dialer) is skipped for now** (owner's instruction, Nov 16). Texts and calls stay demo-only.
5. **New mail gets a first sort by plain code** (newsletters, receipts, calendar replies, automated notices), with the reason shown. A model is not called for it in phase 0.
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
- Calendar: events added in Timmy are not written to Google Calendar yet, and Google Calendar events are not synced in.
- Labels and archive are not written back to Gmail.
- Attachments cannot be sent.
- When someone other than the sender has to approve an email (a delegate's send), the thread shows as sent only after the next sync.
- A few demo screens still show sample wording on a real workspace (the "undo anything for 7 days" line on Activity).
