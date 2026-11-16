# Penetration test: scope and brief

Draft, Nov 16, 2026, for an outside testing firm. It tells you what Timmy is, where to test, what the system claims about itself, and the rules. Engineering contact: **[FILL IN]**.

## What Timmy is

An assistant for work email. A person signs up, creates a workspace, and connects their Gmail or Outlook, calendar and Google Drive through Composio (a third party that holds the access tokens). Timmy reads their mail, sorts it, drafts replies, and proposes actions that the person approves. It has its own pages (a document editor), tasks, contacts, automations and an embeddable website chat. A language model (through OpenRouter) reads mail and answers questions.

One Node service (Hono, TypeScript) serves the API and the web app on one origin. Postgres with row-level security holds everything. Background work runs in the same service from a job queue in Postgres.

## Where to test

- **In scope: the staging app only**, https://app-staging-fcb4f05d.up.railway.app . Sign-up is open there. It runs with stand-ins for Google, Microsoft and the model, so nothing you do reaches a real mailbox. Create as many accounts and workspaces as you need.
- Source code is available to you (a white-box test is wanted). **[FILL IN: how access is given]**
- A token for the staging test endpoints (`/api/test/*`: they deliver a fake email, read the fake mailbox, and so on) is given on request. Those endpoints exist only where `TIMMY_TEST_HOOKS=1`; **finding them reachable on production, or reachable on staging without the token, is a finding.**
- **Out of scope:** the production app (https://app-production-a7a7000d.up.railway.app) except for passive checks agreed in advance (headers, TLS, that sign-up is closed, that test endpoints are absent); the demo site; Railway's, Composio's, OpenRouter's, Google's and Microsoft's own infrastructure; denial of service by volume; social engineering; physical access.

## What the system claims — please try to break each one

1. **No outside write without approval.** No email is sent, no mailbox or calendar is changed, unless a person approved that exact action or set a rule that covers it. Try: the commands endpoint, replaying or altering an approved action, changing the text between approval and send, approving as the wrong person or role, racing the 30-second undo, the automation engine's Send step, the website chat's replies.
2. **No action runs twice.** Try: replays, concurrent identical requests, retries after forced errors.
3. **No reads across workspaces.** Two workspaces, A and B. From A, try to read, change, search, be notified of, or infer anything in B: by id in every route, through the event stream, through the assistant's tools, through uploaded-file addresses, page versions, automations, chat conversations, invitations and the connect flow.
4. **No credential reaches a prompt, a response or a log.** Try to make the app return or log a key, a session, or a Composio token.
5. **Unattended work only prepares.** The morning run and the reading of new mail may draft and suggest; they must not send.
6. **Content from outside is never obeyed.** Deliver emails (through the test endpoint) that try to instruct the assistant: to send mail, to reveal other threads, to change rules, to file or delete, to put links or markup in its answers. Try the same through a page's text, a file's name and contents, a calendar event, a visitor's chat message, and a lead's reply. Note that staging's model is a rule-based stand-in: it shows the plumbing, not a real model's weaknesses. **[FILL IN]** whether a second pass against a real model is wanted (it has a per-workspace spending limit).
7. **Roles hold.** Owner, admin, member, assistant, revops, client. Try to act above a role, to raise your own role, to accept an invitation meant for someone else, and to keep access after removal.

## Areas that deserve attention

- **Sign-in and sessions** (Better Auth: email and password, email links): fixation, reset and confirmation links, enumeration of addresses, brute-force limits, cookie settings.
- **The connect flow**: the callback from Composio, state handling, connecting an account into someone else's workspace, the one-mailbox-per-workspace rule.
- **Webhooks** (`/api/hooks/composio`): signature, replay, events for another workspace's connection.
- **The generic state operations** (`POST /api/v1/commands` with `{type:'ws', ops:[…]}`): the server checks each operation (`server/src/state/ws-check.ts`); look for a record or field it lets through that it should not, stored script, oversized or deeply nested input.
- **The document editor**: stored cross-site scripting through blocks, links, embeds, picture addresses and page names.
- **Uploads** (when merged): content type and extension handling, serving an uploaded file as active content on the app's origin, another workspace's files, the signing of upload addresses.
- **The website chat** (when merged): the public endpoints (`/api/public/chat/…`), the loader script and frame, which sites may embed it, forging or reusing a conversation token, reading another visitor's conversation, using the chat to reach workspace data, limits against flooding.
- **Automations** (when merged): making one run that an owner or admin did not switch on, loops, a step acting with more authority than the person who built it.
- **The event stream** (`/api/v1/stream`): events for another person or workspace, resuming from a forged position.
- **Server-side requests**: anywhere the server fetches an address a user supplied.
- **Headers and browser protections**: content security policy, framing, cross-site request forgery on state-changing routes, cross-origin rules.
- **Dependencies and the container image.**

## Rules

- Staging only, as above. Stop and call the contact if you reach data that is not yours and not created by the test, or anything that looks like a real person's mailbox.
- No volume-based denial of service. A single request that takes the service down is a finding: report it, don't repeat it.
- Do not exfiltrate secrets you find beyond what is needed to prove the finding; report them the same day so they can be rotated.
- Testing window, source IPs and a daily check-in: **[FILL IN]**.

## What we want back

- For each finding: what it is, how to reproduce it step by step, what it lets an attacker do, a severity (with the scoring method you use), and the fix you recommend.
- A statement for each of the seven claims above: held, broken, or not testable and why.
- A short summary a customer's security team can read (it will be shared under the data processing agreement).
- A retest of fixed findings.
