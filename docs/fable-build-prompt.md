You are building the backend for **Timmy**, an AI work assistant, and connecting it to the frontend that already exists. Work end to end: build it, deploy it, and test the whole app until it works on real accounts.

**You own the backend.** You are its owner and long-term maintainer, and its design is up to you, within the decisions below. The frontend is finished and tested. Change it only where connecting it to the API needs a change, and keep every behavior it has today in demo mode.

## Where things are
- Repo: `TayoAki/Timmy`. Start from branch `claude/modest-meitner-59cqpr`. Commit and push to your session's branch often, because the container can be reclaimed between sessions. Don't open a pull request unless I ask.
- **The plan:** `docs/backend-prd.md` (living version: https://claude.ai/artifact/Q5Kzr8u27UVqzUFKdXUVDH). Read all of it before writing code. Where it and this prompt disagree, this prompt wins. Pricing and billing are out of scope for now.
- **Frontend:** Vite + React 19 + TypeScript. All state lives in a reducer (`src/state/store.tsx`), saved to `localStorage` key `timmy-state-v3`. Sample data is in `src/data/*`. Other pieces:
  - outbound: `src/state/outbound.ts`, `src/lib/outbound.ts`
  - connections, RevOps and delegate holds: `src/state/connect.ts`
  - lead logic: `src/state/leads.ts`
  - the in-browser AG-UI agent: `src/agent/*`. It already supports `VITE_TIMMY_AGENT_URL` for a remote AG-UI agent.
- **Hosting:** everything runs in the existing Railway project. The frontend is live at https://web-production-c4bbfc9c.up.railway.app, and Railway deploys the branch automatically. Add the API, Postgres and a bucket as services in that project.
- **Tests:** `e2e/` holds 12 Playwright suites (about 340 checks). Run them with `bash e2e/run-all.sh`, with `BASE=<url>` for a deployed build. All of them pass today.
- **Library docs:** Better Auth, Composio, OpenRouter, pg-boss and Railway change often, and some of what you remember may be out of date. Check their current docs before you write code against them. Composio, for example, now steers agents toward its sessions API.

## Decisions already made
Treat these as settled. If one doesn't work in practice, tell me what you found and propose a change. Meanwhile, keep building the parts that don't depend on it.

- **Login and workspaces:** Better Auth inside our API. Its organization plugin is the workspace. Roles: owner, admin, member, `assistant` (delegate), `revops`, `client`. Agencies get client workspaces as organizations with a `parent`. Sign-in is Better Auth only: email and password, or an email link. There is no Sign in with Google or Microsoft, and we own no Google OAuth app.
- **Every app connection is a Composio connect button.** That includes Gmail, Calendar, Drive and Outlook. Use Composio's managed OAuth apps for now, because they spare us Google's app review at launch. Keep the auth config ids in config, so we can swap in our own apps later without code changes. The agent pulls data through Composio into our store and acts through Composio tools.
- **Models go through OpenRouter.** Each workspace picks the model that powers Timmy in Settings, from an allowlist of models that pass our eval (tool calling, drafting, refusals).
  - **Default model:** Claude Opus 5.5. Look up its exact OpenRouter model id from the models API instead of guessing it. Turn reasoning on, with the effort set per route.
  - **Every request:** use prompt caching with `cache_control` breakpoints for Claude, and a fallback model list for outages. Send `provider.zdr: true` so mail only reaches endpoints that keep no data. Log each call's cost from OpenRouter's usage data.
  - **Pinned routes:** the auto-mode judge is pinned to a model we test, and users can't change it. A weaker judge would weaken every approval.
  - **Computer jobs (phase 3):** no native computer-use tool. The agent drives a headless browser in the sandbox with Playwright, reading the page's accessibility tree, through ordinary function tools. That way any model on the allowlist can run them. Screenshots are only for showing the user what happened. There is no desktop.
  - **Changing models:** get my OK before you change the default model or add one to the allowlist. Run the eval, show me the numbers, and let me decide.
- **One agent loop on our own servers,** with the model interface above and a sandbox interface (E2B or Daytona) that runs tools only.
- **Runs are Postgres rows** with a lease and a fence. A run starts immediately, saves a checkpoint when it pauses for approval, and on resume replays exactly the approved call.
- **Every outside write is an effect record:** intended → approved → executing → completed or uncertain, with an idempotency key. It goes through one Action gateway that applies policy, routes approvals (to the workspace user, to the exec in delegate mode, or to RevOps for CRM writes), holds sends for a 30-second undo and writes the audit log.
- **Auto mode:** a judging model that sees only the user's own words, never fetched content, because fetched mail and web pages can carry injected instructions. It answers "ask" when unsure, and it is stricter after a run has read outside content. Add an outbound-verb guard and a fixed list of actions it can never approve (moving money, signing, deleting accounts).
- **Credentials:** the agent and the sandbox get short-lived per-turn tokens; the real keys stay server-side.
- **Cost:** routines run plain-code checks before any model call. Each workspace has caps on concurrent runs and monthly spend.
- **Stack:**
  - TypeScript, Hono on Node.
  - Postgres on Railway, from the pgvector template (Railway's default Postgres has no extensions). Row-level security on `workspace_id`. Backups on. The API reads `DATABASE_URL` through a Railway reference variable over the private network.
  - pg-boss as the only job system.
  - A Railway Bucket (S3-compatible) for files and sandbox homes.
  - AG-UI over SSE for chat. `POST /v1/commands` takes the reducer's actions, and `GET /v1/stream` returns state patches over SSE.
- **Ontology:** our own extraction pipeline using NVIDIA Auto Ontology's data model (terms, attributes, relationships), with evidence on every fact and a user Certify step.

## The product's safety properties
The product must hold each of these, and each needs its own tests:
- no outside write without an approved effect record or a rule the user set;
- no action runs twice;
- no cross-workspace reads;
- no real credential inside a prompt, the sandbox or logs;
- unattended runs send only what a rule covers.

## How to work
Build in the PRD's phases. Finish each phase, deploy it and test it before you start the next:
- **Phase 0, foundations.** Better Auth and workspaces, Postgres with RLS, the Composio Gmail and Calendar connection with backfill and triggers, the item store, the agent loop with runs and effect records, the Action gateway, the model picker, and Ask over real mail. Also measure the cost per user: model tokens including reasoning, Composio calls, and backfill. Put the numbers in your phase 0 report and keep going.
- **Phase 1.** Triage, brief, drafts, Waiting, decisions, ontology v1, Outlook and Drive.
- **Phase 2:**
  - CRM sync with the RevOps queue.
  - The sending service over secondary-domain mailboxes. Cold mail never goes through the user's main Gmail connection, because complaints there would hurt the domain they use for everyday mail.
  - Twilio texts and the browser dialer, with 10DLC.
  - Lead sources: Follow Up Boss, Zillow by email parsing for now, and Realtor.com.
  - Enrichment and lead finding within caps, behind a provider interface (Apollo, Clay, People Data Labs, Hunter or any API). I also mentioned "treg". I haven't confirmed which provider that is, so ask me before you connect a real one.
  - Delegate mode and client workspaces.
- **Phase 3.** The cloud computer (shell and headless browser in the sandbox), routines and channels.

**This will take more than one session.** Your context will be compacted on long runs, and a later session may start fresh from the repo. Keep these current, so that you or a new session can pick up from files alone:
- `STATUS.md`: what's done, what's deployed, test results, measured cost per user, what's next, and what's blocked on me.
- A test checklist (for example `tests.json`) with each planned test and its status.
- `scripts/dev.sh`, which starts a local Postgres with pgvector and runs every test suite.
- Git history: commit after each working step.

Don't stop early because of context; save your state to these files and continue.

**Connecting the frontend:**
- Move the reducer's persistence onto the API behind a flag.
- Keep a **demo mode** with today's sample data. The 12 existing suites run against it, and I use it for demos.
- Every screen that shows sample data today should show the signed-in user's real data in live mode.

**Testing is part of done:**
- Unit tests, and integration tests against a local Postgres with pgvector, run inside your session.
- Fake providers (Composio, OpenRouter, Twilio) so CI is deterministic.
- Smoke tests against the real services behind env flags.
- A `staging` environment in the Railway project. Run the live suites against staging, so test sign-ups never land in production.
- New Playwright suites for live mode: sign up, connect a test Gmail account, receive a test email, get a triaged item and a draft, approve and send, check the audit log and undo. Also cover switching the model, RevOps holds, delegate holds and tenant isolation (two workspaces must never see each other's data).
- Run the full suite against every staging deploy.
- Fix the code, not the tests. Don't skip, weaken or delete a test to get a green run. If a test is wrong, tell me why and what you changed.
- Before each phase ends, have a subagent review the safety-critical code (the gateway, RLS, effect records, credential handling) against the safety properties above. Don't start subagents for small lookups; they add to the session's cost.

## What needs my go-ahead
You can do these without asking:
- write and refactor backend code, add dependencies, and run tests and migrations on local and staging databases;
- create the Railway services this prompt names (API, Postgres from the pgvector template, a bucket, a staging environment), and set non-secret and reference variables;
- deploy to staging and production, and push to your session's branch;
- send test email and texts between the test accounts I give you;
- retry, fix or work around failing calls, timeouts and flaky tests.

Ask me first before you:
- run a migration that drops or rewrites data in production;
- delete a Railway service, volume, bucket or environment, or change the existing frontend service's settings;
- send an email, text or call to anyone outside the test accounts I give you;
- change the default model or the allowlist, or connect a real enrichment provider.

**Credentials:**
- Phase 0 needs an OpenRouter key and a Composio key. Later phases need Twilio (phase 2) and E2B or Daytona (phase 3). Railway provides Postgres and the bucket.
- This environment may already be connected to OpenRouter. Check before you ask me for a key.
- For keys you use inside your session, ask me through the secure credential form when you reach the step that needs one, never in chat. Use the fakes until then.
- For deployed services, I add secrets as Railway variables myself.
- Composio says its Google app already has Google's verification and security assessment (CASA). Put "get that confirmed in writing" on my list in `STATUS.md`.

## Finishing work
Please avoid stopping while you still owe work I asked for. Be persistent and don't stop unless needed. Status notes are welcome, and so is asking me about open decisions, but carry on with work that doesn't depend on my answer. If you notice yourself offering to wait or inviting me to redirect you, proceed with the next part of the task instead.

You will meet ordinary obstacles like errors, timeouts, empty results or failing tools. Diagnose them first, and when they aren't real blockers, work through them with the access you have: wait and retry, fix the request, or use another tool or source. If something is a deliberate blocker, such as access I withheld or a safety guardrail, leave it alone, say plainly what you found, and look for another safe way forward. Stopping before the task is complete is rarely right: only when the work can't move forward without my input, or the blocker is deliberate. This doesn't remove the go-ahead the list above requires.

## Communicating clearly
At the end of each phase, write me a short report and keep going. Write it for an intelligent reader who hasn't seen your tool calls, your reasoning or the files you opened. Put the key points first: what works now, what's deployed, test results, cost per user, and anything you need from me. Use plain words and full sentences, and don't use names or abbreviations you made up during the work. Keep `docs/backend-prd.md` current when you change a decision, with the reason.
