# Timmy backend: status

Last updated: Nov 16, 2026 (session 1). Read this first, then `tests.json`, then `git log`.
The brief is `docs/fable-build-prompt.md`; the plan is `docs/backend-prd.md`.

## Where things stand

**Phase 0 (foundations) is in progress.** The API exists and its safety-critical parts are tested locally. It is not deployed yet, and the frontend is not connected yet.

| Piece | State |
| --- | --- |
| API server (`server/`, Hono on Node) | Built. Boots locally, serves the app and the API from one origin. |
| Postgres schema with row-level security | Built (`server/migrations/0001_init.sql`). |
| Sign-in and workspaces (Better Auth, email + password, email link, six roles) | Built. Email links and invitations are written to an outbox table until a mail provider is chosen. |
| State sync (`POST /api/v1/commands`, `GET /api/v1/stream`) | Built. The server runs the frontend's own reducer and sends patches. |
| Action gateway, effect records, audit log, 30-second undo | Built. |
| Composio: connect, backfill, new-mail webhook, item store | Built against the fake provider. Not yet run against a real Gmail account. |
| Model layer (OpenRouter), model setting, cost log, spend cap | Built. One real call made to confirm the request shape. |
| Agent loop (leased runs, checkpoints, pause for approval), Ask | Built. |
| Frontend live mode | Not started. |
| Railway: API service, Postgres, bucket, staging | Not started. |
| Cost per user, measured | Not measured yet (needs a real mailbox). |

## How to run it

```bash
bash scripts/dev.sh          # local Postgres with pgvector, then every suite
bash scripts/dev.sh server   # only the API's unit and integration tests
```

The API alone: `cd server && DATABASE_URL=postgres://timmy_owner:timmy@localhost:5432/timmy_dev TIMMY_FAKE_PROVIDERS=1 npx tsx src/index.ts`.
In a cloud session set `NODE_USE_ENV_PROXY=1` so Node's `fetch` uses the session's proxy (the proxy supplies the OpenRouter key).

## Test results

| Suite | Result |
| --- | --- |
| API unit and integration (`server/test`, 6 files) | 98 of 98 pass |
| Demo-mode Playwright (`e2e/`, 12 suites) | 12 of 12 pass (last full run: before the reducer was shared with the server; re-run pending) |
| Live-mode Playwright (`e2e/live/`) | Not written yet |

## Decisions made while building (the PRD is updated to match)

1. **One service serves the API and the live app, on one origin.** `up.railway.app` is on the public suffix list, so two Railway subdomains can't share a cookie, and cross-site cookies are blocked in Safari. Serving both from one service keeps sign-in cookies first-party. The existing `web` service is untouched and stays the demo.
2. **The server runs the frontend's reducer.** Each client action is applied by the same reducer code on the stored state, and the difference goes back as patches keyed by entity. An action that would send mail is detected from the reducer's result and turned into an effect record first.
3. **Cold email is sent from mailboxes connected through Composio** (your instruction of Nov 16), not from a separate SMTP pool. See "Needs your attention" for the risk this carries.
4. **Twilio (texts and the dialer) is skipped for now** (your instruction of Nov 16). Texts and calls stay demo-only; the server refuses them on a real workspace.

## Needs your attention

- [ ] **Test Gmail accounts.** I need at least one Gmail account I may send from and one address I may send to. Connecting it takes a person at Google's consent screen, so you will need to press Connect once on staging.
- [ ] **Railway secrets.** When the API service exists, add `OPENROUTER_API_KEY` and `COMPOSIO_API_KEY` to it in staging and production (or tell me to set them from the keys you pasted).
- [ ] **Rotate the keys pasted in chat** (two Composio keys, one OpenRouter key) once setup is done.
- [ ] **Composio's Google verification.** Get it confirmed in writing that Composio's managed Google app carries Google's restricted-scope verification and the CASA assessment. Their docs do not say so.
- [ ] **Cold email from the connected account.** Google's API policy forbids sending unsolicited commercial mail through its user-data APIs, and complaints land on the domain you use for everyday mail. The caps, unsubscribe and bounce pauses stay, but the policy risk sits with whichever Google app the mailbox is connected through. Also: Composio's Gmail send tool has no custom-header field, so one-click unsubscribe (`List-Unsubscribe`) needs their proxy call with a hand-built message.
- [ ] **A mail provider for Timmy's own account mail** (sign-in links, invitations, password resets). Until one is chosen, email + password sign-in works and links wait in an outbox table.
- [ ] **The production frontend's branch.** The `web` service deploys `claude/modest-meitner-59cqpr`; this work is on `claude/funny-keller-5ouhro`. I will not change that service's settings without your OK.
- [ ] **Outage fallback model.** The fallback list is `anthropic/claude-opus-5` after Opus 5.5. It is not user-selectable. Say if you want a different one.
- [ ] **OpenRouter budget for this session.** The key attached to the session has about $11 left; a large eval needs more.
- [ ] Which enrichment provider is "treg"?

## What's next

1. Frontend live mode: sign-in, onboarding, state from the API, Connect buttons, model picker, pending approvals.
2. Railway: staging environment, Postgres from the pgvector template, a bucket, the API service.
3. Live-mode Playwright suites against staging.
4. Safety review by a subagent; phase 0 report with measured cost per user.
