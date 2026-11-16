You are building the backend for **Timmy**, an AI work assistant, and connecting it to the frontend that already exists. Work end to end: build it, deploy it, and test the whole app until it works on real accounts.

## Where things are
- Repo: `TayoAki/Timmy`. Start from branch `claude/modest-meitner-59cqpr` (the finished frontend). Commit often and push to your session's branch. Don't open a pull request unless I ask.
- **The plan:** `docs/backend-prd.md` (living version: https://claude.ai/artifact/Q5Kzr8u27UVqzUFKdXUVDH). Read all of it before writing code. Where it and this prompt disagree, this prompt wins. Pricing and billing are out of scope for now.
- **Frontend:** Vite + React 19 + TypeScript. All state lives in a reducer (`src/state/store.tsx`), saved to `localStorage` key `timmy-state-v3`. Sample data is in `src/data/*`. Other pieces:
  - outbound: `src/state/outbound.ts`, `src/lib/outbound.ts`
  - connections, RevOps and delegate holds: `src/state/connect.ts`
  - lead logic: `src/state/leads.ts`
  - the in-browser AG-UI agent: `src/agent/*`. It already supports `VITE_TIMMY_AGENT_URL` for a remote AG-UI agent.
- **Hosting:** everything runs in the existing Railway project. The frontend is live at https://web-production-c4bbfc9c.up.railway.app, and Railway deploys the branch automatically. Add the API, Postgres and a bucket as services in that same project.
- **Tests:** `e2e/` holds 12 Playwright suites (about 340 checks). Run them with `bash e2e/run-all.sh`, with `BASE=<url>` for a deployed build. All of them pass today.

## Decisions already made (don't reopen them)
- **Login and workspaces:** Better Auth inside our API. Its organization plugin is the workspace. Roles: owner, admin, member, `assistant` (delegate), `revops`, `client`. Agencies get client workspaces as organizations with a `parent`. Sign-in is email first, plus "Sign in with Google" once I give you a login-only Google client (openid, email, profile). That client is the only Google OAuth app we own.
- **Every app connection is a Composio connect button.** That includes Gmail, Calendar, Drive and Outlook. Use Composio's managed OAuth apps for now, not our own. Keep the auth config ids in config, so we can swap in our own apps later without code changes. The agent pulls data through Composio into our store and acts through Composio tools.
- **Models go through OpenRouter.** Each workspace picks the model that powers Timmy in Settings, from an allowlist of models that pass our eval (tool calling, drafting, refusals).
  - **Default model:** Claude Opus 5.5. Look up its exact OpenRouter model id from the models API; don't guess it. Use reasoning on, with the effort set per route.
  - **Every request:** use prompt caching with `cache_control` breakpoints for Claude, and a fallback model list for outages. Send `provider.zdr: true`, and ask me to turn on zero data retention for the account too. Log each call's cost from OpenRouter's usage data.
  - **Pinned routes:** the auto-mode judge is pinned to a model we test, and users can't change it.
  - **Computer jobs (phase 3):** test whether Anthropic's native computer-use tool works through OpenRouter. If it doesn't, add a direct Anthropic driver behind the same model interface for that route only, and tell me first.
  - **Changing defaults:** don't change the default model, or add one to the allowlist, without my OK. Run the eval, show me the numbers, and let me decide.
- **One agent loop on our own servers,** with the model interface above and a sandbox interface (E2B or Daytona) that runs tools only.
- **Runs are Postgres rows** with a lease and a fence. A run starts immediately, saves a checkpoint when it pauses for approval, and on resume replays exactly the approved call.
- **Every outside write is an effect record:** intended → approved → executing → completed or uncertain, with an idempotency key. It goes through one Action gateway that applies policy, approvals (you, the exec in delegate mode, or RevOps for CRM writes), a 30-second send undo and the audit log.
- **Auto mode:** a judging model that sees only the user's own words, never fetched content. It answers "ask" when unsure, and it is stricter after a run has read outside content. Add an outbound-verb guard and a hard never-list (money, signing, deleting accounts).
- **Credentials:** the agent and the sandbox get short-lived per-turn tokens; the real keys stay server-side.
- **Cost:** routines run plain-code checks before any model call. Each workspace has caps on concurrent runs and monthly spend.
- **Stack:**
  - TypeScript, Hono on Node.
  - Postgres on Railway, from the pgvector template (Railway's default Postgres has no extensions). Row-level security on `workspace_id`. Backups on. The API reads `DATABASE_URL` through a Railway reference variable over the private network.
  - pg-boss as the only job system.
  - A Railway Bucket (S3-compatible) for files and sandbox homes.
  - AG-UI over SSE for chat. `POST /v1/commands` takes the reducer's actions, and `GET /v1/stream` returns state patches over SSE.
- **Ontology:** our own extraction pipeline using NVIDIA Auto Ontology's data model (terms, attributes, relationships), with evidence on every fact and a user Certify step.

## How to work
Build in the PRD's phases. Finish each phase, deploy it and test it before starting the next:
- **Phase 0, foundations.** Better Auth and workspaces, Postgres with RLS, the Composio Gmail and Calendar connection with backfill and triggers, the item store, the agent loop with runs and effect records, the Action gateway, the model picker, and Ask over real mail. Also instrument the cost per user: model tokens including reasoning, Composio calls, and backfill. Report the cost numbers to me before phase 1.
- **Phase 1.** Triage, brief, drafts, Waiting, decisions, ontology v1, Outlook and Drive.
- **Phase 2:**
  - CRM sync with the RevOps queue.
  - The sending service over secondary-domain mailboxes. Never send cold mail through the user's main Gmail connection.
  - Twilio texts and the browser dialer, with 10DLC.
  - Lead sources: Follow Up Boss, Zillow by email parsing for now, and Realtor.com.
  - Enrichment and lead finding within caps, behind a provider interface (Apollo, Clay, People Data Labs, Hunter or any API). I also mentioned "treg", which isn't confirmed, so ask me which provider before wiring a real one.
  - Delegate mode and client workspaces.
- **Phase 3.** The desktop sandbox, routines and channels.

**Connecting the frontend:**
- Move the reducer's persistence onto the API behind a flag.
- Keep a **demo mode** with today's sample data, so the 12 existing suites keep passing.
- Every screen that shows sample data today should show the signed-in user's real data in live mode.

**Testing is part of done:**
- Unit tests, and integration tests against a real Postgres with pgvector, run inside your session. Never test against the production database.
- Fake providers (Composio, OpenRouter, Twilio) so CI is deterministic.
- Smoke tests against the real services behind env flags.
- New Playwright suites for live mode: sign up, connect a test Gmail account, receive a test email, get a triaged item and a draft, approve and send, check the audit log and undo. Also cover switching the model, RevOps holds, delegate holds and tenant isolation (two workspaces must never see each other's data).
- Run the full suite against every Railway deploy.

**Rules that are never broken, each with its own tests:**
- no outside write without an approved effect record or a rule I set;
- no action runs twice;
- no cross-workspace reads;
- no real credential inside a prompt, the sandbox or logs;
- unattended runs send only what a rule covers.

**Credentials and accounts:**
- **What you'll need:**
  - Phase 0: an OpenRouter key and a Composio key.
  - Later: the login-only Google client, Twilio (phase 2) and E2B or Daytona (phase 3).
  - Railway provides Postgres and the bucket, so you don't need credentials for those.
- **OpenRouter key:** this environment may already be connected to OpenRouter, so check that before asking me for a key.
- **Keys you use inside your session:** ask me through the secure credential form when you reach the step that needs one, never in chat. Use the fakes until then.
- **Keys for deployed services:** I add secrets as Railway variables myself. You can set non-secret variables and reference variables with the Railway tools.
- **Test accounts only:** use only the test Gmail and Outlook accounts I give you. Never email, text or call real people.

**Keep me informed:**
- Keep `docs/backend-prd.md` current when you change a decision, with the reason.
- Keep a short `STATUS.md`: what's done, what's deployed, test results, measured cost per user, and what's blocked on me.
- At the end of each phase, report in a few lines and continue unless you're blocked on a credential or a decision only I can make.
