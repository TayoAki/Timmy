# End-to-end tests

Playwright scripts that drive the real app in Chromium, desktop (1440×900) and an emulated iPhone 13. Each suite clears `localStorage` and starts from the sample data. They print `ok - …` (or `PASS …`) per check and exit non-zero on the first failure.

| Suite | Covers |
| --- | --- |
| `e2e.cjs` | Core workday: triage, drafts, docs, capture, Drive filing, CRM, projects, calendar |
| `e2e-approvals.cjs` | Approvals queue, decisions, urgency, Decided log |
| `e2e-steps.cjs` | Next actions, full-screen editors |
| `e2e-agent.cjs`, `e2e-ask.cjs` | Ask Timmy (AG-UI): widgets, intents, honest "can't" answers |
| `e2e-focus.cjs` | Project scope and focus mode |
| `e2e-voice.cjs` | Dictation |
| `e2e-fixes.cjs` | First-simulation fixes |
| `e2e-outbound.cjs` | Leads, campaigns, Unibox, limits, speed to lead, social |
| `e2e-calm-phone.cjs` | Phone tab bar and the calm home |
| `e2e-round3.cjs` | Second-simulation fixes: leads on Today, any address, accepted times, send checks, Ask and outbound, one price, truthful drafts, polish |
| `e2e-round3b.cjs` | Connections, RevOps approvals, Outlook, lead sources, enrichment and finding leads, calls, delegate mode, client workspaces, mailboxes, import checks, showings |
| `e2e-round4.cjs` | Treg on by default, cold email as drafts in the connected account, the Unibox Sent view, the conversation banner and form-card layout |
| `e2e-story.cjs` | The story demo ("Monday, 8:12"): plays on fresh data, keeps $62, sends Dana's reply, books the lead, drafts and sends the campaign, sorts triage, ends on the call to action, and puts your own demo back when closed |

Run everything with `bash e2e/run-all.sh` (local dev server) or with `BASE=<url>` for a deployed build. When the backend lands, keep these passing in demo mode and add suites that run against a seeded test workspace.
