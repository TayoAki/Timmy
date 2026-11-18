# Timmy powered by CopilotKit, and what to take from OpenBot

Plan, Nov 18, 2026. **Phases 1 and 2 are built (Nov 18); see "What was built" at the end.**

**Sources reviewed:**
- the CopilotKit repository's docs (`showcase/shell-docs`, about 270 pages);
- the OpenBot repository: README, `docs/`, its app's dependencies.

Every claim about CopilotKit below comes from those docs. Where the docs don't say something, I say so.

## In one paragraph

CopilotKit is the layer between an agent and the screens people use it on: the chat, tool results drawn as UI, approval cards in the chat, and, with its paid-tier **Intelligence** service, conversations saved on the server, memory, learned skills, usage analytics, and the same agent in Slack and Teams. It does **not** supply the AI model. Timmy keeps what makes it Timmy: its agent loop, its choice of model (OpenRouter), the approval gateway, mail sorting, rules and projects. **The recommendation:**
1. Put CopilotKit's runtime and chat in front of Timmy's existing agent. Small, and nothing leaves Timmy.
2. Then turn on Intelligence for saved conversations and beta analytics, once you've agreed to what it stores.
3. Then Slack and Teams.

Use OpenBot as a place Timmy can appear (as a Bot and as tools), and as MIT-licensed code to borrow later. Don't rebuild Timmy on top of it.

## The key you sent

- **What it is.** `cpk-…` is an **Intelligence project key** (`CPK_INTELLIGENCE_API_KEY`). It is not a browser key. The docs say to keep it on the server and never expose it to the browser.
- **Where it lives.** It is in my private session file only: not in the repo, the logs or any message. When we turn Intelligence on, you add it to the `app` service in Railway yourself, staging first.
- **Rotate it first.** It was pasted in chat, so make a new one in CopilotKit's dashboard, put the new one in Railway, and delete this one.
- **Not the same as the browser key.** The browser key in CopilotKit's docs is a different credential (`ck_pub_…`); we don't need one for this plan.

## Decisions that are yours

1. **What Intelligence stores, and where.** CopilotKit's cloud keeps each conversation's messages and **every tool call with its arguments and results**. For Timmy that means the text of emails, files and pages the assistant read while answering. Saying yes means:
   - adding CopilotKit to the subprocessors list (`docs/legal/subprocessors.md`);
   - updating the tester's data note (`docs/beta-readiness.md`).

   Phase 1 alone keeps everything in Timmy.
2. **Plan and price.** The free Developer plan includes saved conversations, memory and learning, a limited analytics trial, "usage limits apply", and one seat. Pro and Team are paid; self-hosting needs Team Self-hosted or Enterprise. **The docs state no prices or numeric limits**; they're on CopilotKit's pricing page. Worth asking CopilotKit what "1 seat" and the usage limits mean for a beta with a few testers.
3. **Cloud or self-hosted Intelligence.** Self-hosting needs:
   - Kubernetes (Helm) or AWS ECS;
   - Postgres, Redis and an identity provider;
   - a CopilotKit license.

   Cloud is the only sensible choice for the beta.

## Phase 1: CopilotKit's runtime and chat, on Timmy's own agent (about 3 days)

Nothing leaves Timmy in this phase.

**Server.**
- Mount the CopilotKit runtime inside Timmy's Hono server (`createCopilotHonoHandler` from `@copilotkit/runtime/v2/hono`), at `/api/copilotkit`.
- Its one agent is Timmy's own agent. I'd wrap Timmy's `startRun` as an in-process AG-UI agent, rather than have the runtime call our HTTP endpoint and re-send the session cookie. The person, workspace, role, budget cap and gateway stay exactly as they are.
- `identifyUser` returns the signed-in Timmy user.

**Approvals in the chat.**
- When a run stops for an OK (an email, a filing, a rule), it ends the AG-UI way: `RUN_FINISHED` with an `interrupt`.
- CopilotKit's `useInterrupt` draws Timmy's approval card. "Send", "File it" or "Save rule" sends Timmy's own `effect` decision.
- Nothing about who may approve changes.

**Browser.**
- Replace the chat shell in `src/agent/Assistant.tsx` with `@copilotkit/react-core/v2`: its chat component, or its headless hooks inside Timmy's own design.
- Keep Timmy's widgets as CopilotKit tool renderers (`useRenderTool` for `show_answer`, `show_urgent` and the approval cards). The look stays Timmy's.

**Versions.** Pin exact versions: 1.88.0 (Nov 13, what OpenBot ships) or newer once it has settled. `@ag-ui/client` must match the runtime's copy (Timmy has 1.0.4 today). v1 and `@copilotkit/react-ui` are deprecated; use v2.

**Tests.** The chat suites (`agent.test`, `chat-rules.test`, `live-ask`, `live-chat`, `e2e-ask`, `e2e-agent`) must pass unchanged. A new suite covers approvals through `useInterrupt`.

**What we get.** CopilotKit's maintained chat, streaming and tool-rendering instead of our own, and the base every later phase needs. Intelligence only records runs that pass through this runtime.

## Phase 2: Intelligence, with your key (about 2 days, after decision 1)

- **Saved conversations (AG-UI Streams).** Today Timmy keeps chat history in the browser only (`localStorage`), so it's gone on another device or after clearing the browser. With Intelligence, conversations live on the server, reconnect after a reload, and show on every device.
- **Analytics for the beta.** Activity, reliability, tokens: what testers ask, where runs fail, what they cost. No extra code beyond the runtime.
- **Memory: off at first.** Timmy already has its own memory (the ontology of people, companies and promises, learned rules, decisions), and two memories would disagree. Revisit for personal preferences only.
- **Learned skills: later.** They overlap with Timmy's rules and routines; worth a look after the beta.
- **Setup.** `CPK_INTELLIGENCE_API_KEY` on `app` (you add it, after rotating), `identifyUser` set to Timmy's user id, and the data note and subprocessors list updated.

## Phase 3: Timmy in Slack and Teams (about 3 days)

- **How it works.**
  - Intelligence holds the Slack or Teams app credentials.
  - Timmy's server runs CopilotKit's channel runner (`@copilotkit/channels`, 0.12.0), which needs a long-running Node process; Railway's `app` service already is one.
  - A message to Timmy in Slack runs Timmy's agent, and the answer comes back as Slack blocks (Teams: adaptive cards).
  - Approvals show as cards.
- **Status.** Slack and Teams are generally available on cloud Intelligence; Discord and WhatsApp are "coming soon".
- **Linking accounts.** A Slack person must be linked to their Timmy account by signing in to Timmy once, never by name or email alone, so nobody reaches someone else's mail from Slack.
- **Needs from you.** A Slack workspace to install the app in, and later a Teams tenant.

## Phase 4: OpenBot

**What OpenBot is.** CopilotKit's MIT-licensed "AI coworkers" workspace:
- desktop (Tauri), web, mobile (Expo), Slack and Teams front ends;
- a Hono and Postgres server, the same stack as Timmy;
- Bots with conversations, routines, memory, skills, apps (through Composio, like Timmy), a browser computer of their own, approvals and an activity log.

It needs CopilotKit Intelligence: free on a laptop, a trial licence to evaluate on Kubernetes, a paid licence in production. It does none of Timmy's core work (mail triage, rules, projects, the send gateway).

**a) Timmy inside OpenBot (small, worth doing first).**
- OpenBot accepts any AG-UI endpoint as a Bot, with a write-only authorization header, and any MCP server as governed tools.
- So an OpenBot user can add **Timmy** as a coworker, and Timmy's tools (already at `/mcp`) to their other Bots.
- The one change on our side: Timmy's chat endpoint must also accept a bearer token, not only a browser session. The OAuth tokens Timmy now issues for MCP can do it.
- That gives Timmy a desktop and mobile presence for free, through OpenBot's apps.

**b) Borrow, file by file, when each is needed (MIT, same stack).**
- **Approval answers:** "Allow once", "For this conversation", "Always". Timmy has "approve" and "rules", but nothing per conversation.
- **Routines made by asking:** "every Monday, send my team the numbers" becomes a routine with a start, an action and an end. Timmy's automations are close; the conversational way in is the part to borrow.
- **Skills recorded from a demonstration**, and the activity view.
- **The Bot computer:** Chromium per person, an outbound filter, a supervisor. This is Timmy's phase 3 "computer jobs" in the PRD, which planned E2B or Daytona. It needs Docker or Kubernetes beside Railway; OpenBot's supervisor can't run inside Railway's single container.

**c) Not recommended: running Timmy as OpenBot, or on OpenBot's backend.** We'd trade Timmy's mail product for a general coworker shell and take on Intelligence licensing in production, for features Timmy already has.

## What doesn't change

- **"Lite mode" still runs through MCP:** people use their own Claude or ChatGPT on Timmy's tools. CopilotKit doesn't change who pays for the model.
- **Timmy's model choice, budget caps, approval gateway, audit log and safety rules stay as they are.** CopilotKit sits in front of them, not instead of them.

## Next steps

1. Your OK on **phase 1**. I can start now; nothing leaves Timmy.
2. Your answer on **decision 1** (what Intelligence stores). Then rotate the key and add the new one to `app` in Railway, staging first.
3. If you want Slack: a Slack workspace I can install the app in.
4. Optional: ask CopilotKit about plan limits and what a seat means for a small beta.

## What was built (Nov 18, 2026)

**Phase 1: the runtime and the chat.**
- **Server.** CopilotKit's runtime (`@copilotkit/runtime` 1.89.0, v2, Hono) is mounted at `/api/copilotkit` (`server/src/http/copilotkit.ts`), behind the same sign-in and same-origin check as the rest of the API.
  - Its one agent, `timmy`, is Timmy's own Ask run (`runAsk` in `server/src/http/agent.ts`), in process, as the person who asked: same tools, budget cap, gateway and audit.
  - Each conversation belongs to the person (and workspace) that started it. Another person's request for it is answered "not found".
- **Browser.** The chat's look is unchanged. A live workspace's chat talks to the runtime with CopilotKit's own client (`@copilotkit/core`, loaded on the first question; the demo never downloads it), which handles both modes.
- **Approvals** stay Timmy's own cards in the chat (Send / File it / Save rule), with the same decide endpoint. They were not moved to `useInterrupt`, so the chat suites run unchanged.
- **New for organizing.** Ask now has whats_waiting, list_projects, list_tasks, add_task, complete_task and put_in_project (they were MCP-only), allowed only in a conversation the person is having.
- **Off by default.** The runtime's usage telemetry is switched off (`COPILOTKIT_TELEMETRY_DISABLED`, `DO_NOT_TRACK`), as are Scarf's install analytics.

**Phase 2: Intelligence.**
- **How it switches on.** With `CPK_INTELLIGENCE_API_KEY` on `app`, the runtime runs in Intelligence mode: conversations are kept in CopilotKit's cloud, named after the first question.
- **On another device.** The chat lists the person's saved conversations and opens one by replaying it from CopilotKit's realtime channel, falling back to the saved messages. Deleting a conversation in the chat deletes it there.
- **Ids.** Conversation ids are mapped to the UUIDs Intelligence requires.
- **Off.** Memory and learned skills are left off, as planned.
- **Tested** against the real CopilotKit cloud with your key, on test data only:
  - conversations are created, named and answered;
  - deleting works;
  - another person never sees them.
- **One problem, in CopilotKit's cloud.** Opening a conversation from another browser worked in 2 of 4 runs. In the other two, CopilotKit's cloud recorded nothing for the run (the thread was never updated, 0 events), although the answer reached the browser. Timmy still keeps every conversation in the browser it was had in, so nothing is lost there. Worth raising with CopilotKit.
- **Not built:** Slack and Teams (phase 3), and the OpenBot pieces (phase 4).
