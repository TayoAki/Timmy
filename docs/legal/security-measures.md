# What Timmy holds and how it is protected

Draft, Nov 16, 2026; updated Nov 18, 2026. This is Annex 2 of the data processing agreement, and the page to answer a customer's security questions from. It describes the system **as built**; the last section lists what is not in place yet. Each claim here is checked by an automated test unless it says otherwise (`tests.json` lists them).

## Where data is

| What | Where it is kept | Notes |
| --- | --- | --- |
| Accounts (name, email address, password hash, sessions) | Postgres on Railway | Passwords are hashed by the sign-in library (Better Auth, scrypt). Sessions are cookies that only the server can read. |
| A workspace's state: threads as shown on screen, tasks, pages, contacts, rules, settings | Postgres on Railway | One row per piece of state, each carrying its workspace. |
| Synced mail, calendar events and files (the "item store") | Postgres on Railway | The last 90 days of mail, then new mail as it arrives. For files in Google Drive and OneDrive: the name, type, owner and dates, and, so that files can be found by what they say, the text of Google Docs, Sheets and Slides and of Word, Excel and PowerPoint files changed in the last 90 days (at most 24,000 characters each). The text goes when the file is trashed or deleted and when the account is disconnected. Opening a file inside Timmy reads it through its connection at that moment (a Google Doc's formatting is turned into HTML, cleaned like an email and shown in a frame that runs nothing); what is shown is not stored. |
| What Timmy learned: people, companies, promises, decisions, each pointing at the email it came from | Postgres on Railway | Removed when the email it rests on is removed. |
| Projects Timmy found ("Detect projects") | Postgres on Railway | A scan's findings (thread subjects, the names and addresses of the people involved, file and meeting titles) are kept only until the person has chosen what to keep, and are deleted when any account is disconnected. A kept project remembers which files and meetings belong to it (removed with the item) and which company domains or addresses its new mail comes from. |
| Runs of the assistant, proposed and completed actions ("effect records"), model usage, the audit log | Postgres on Railway | The audit log cannot be changed or deleted by the application; it goes only when its workspace is purged. |
| Access tokens for connected Google and Microsoft accounts | **Composio**, not Timmy | Timmy's database holds only an identifier for each connection. Timmy's servers never see a token. |
| Prompts and answers | Not stored by the model provider (zero-data-retention routing) | Timmy stores the conversation in the workspace's state so the user can see it. |
| Uploaded pictures and attachments | The Railway bucket `timmy-files`, under a key that starts with the workspace's id, behind an asset record with row-level security | Files travel through Timmy's server both ways; the browser never sees the bucket or its key. Served only to members of the workspace, as downloads that a browser will not run. Older pictures stored inside a page are still accepted. |

## How one customer is kept apart from another

- Every table that holds customer data has **row-level security** in the database: a query can only see rows of the workspace set for that transaction. The application connects as a database role that cannot switch this off.
- Every request is tied to a signed-in person and a workspace they belong to before any data is read; background jobs carry their workspace and set it the same way.
- Tests create two workspaces and prove that one cannot read, change, search or be told about the other's data, by API, by the assistant's tools, by the event stream and by direct query.

## How outside actions are controlled

- Nothing is written to a mailbox or calendar except through one path (the "Action gateway"). Each action is first stored as a record of exactly what will happen. It runs only if a person approved it or a rule they set covers it.
- Sends wait 30 seconds and can be undone in that time. What is sent is the stored, approved text, not a fresh version.
- An action never runs twice: each has a key that the database enforces as unique, and an action whose outcome is unknown is checked against the mailbox or calendar instead of being repeated.
- Work nobody is watching (the morning run, reading new mail) may prepare drafts and suggestions; it cannot send.
- A fixed list of things is never done whatever the instruction or rule: Timmy never moves money, signs documents, deletes accounts or changes security settings.
- Roles: owner, admin, member, assistant, revops and client, each with a fixed set of things it may do. A member's send from a mailbox someone else connected waits for that person.
- Other AI apps (Claude, ChatGPT, Claude Code) can use Timmy over MCP at `/mcp`, only with an OAuth 2.1 token from Timmy: the person signs in to Timmy, picks one workspace and allows the app on a page that says what it may do. Tokens are signed, expire after an hour, are bound to the MCP endpoint (audience) and name the person and the workspace; PKCE is required and only the authorization-code and refresh grants exist. On every request the person's consent for that app and that workspace, and their membership and role there, are read again, so disconnecting an app or removing a member stops it at once. A connected app works under the same rules as Ask: it can read and keep drafts, to-dos and projects; anything that would send, file mail or save a sorting rule waits for the person's OK in Timmy. It never sees a password or a connected account's key.

## How content from outside is handled

- Email, files, pages and web content given to the model are wrapped and labelled as information from outside, never as instructions. The model's output is treated as untrusted: a figure, a promise or a "decision" it reports is kept only if the sentence it cites is really in the source.
- The step that decides whether an action may run without asking (Auto mode, off by default) sees only the user's own words, never the content of mail.
- HTML email is converted to plain words before it is stored; the stored words are what search, the model and the lists use. When a person opens an email, its original HTML is fetched from the mailbox at that moment, cleaned against a fixed list of formatting tags and attributes (scripts, forms, frames, plugins, event handlers and links other than web, mail and phone are removed), and shown in a sandboxed frame that runs no scripts. Pictures and backgrounds from other sites are loaded only when the person asks, because loading one tells the sender the email was opened. The HTML is not stored; a copy is kept in the server's memory for up to ten minutes, and is not served once the mailbox is disconnected.

## The website chat (visitors with no account)

- A visitor's request names no workspace. The workspace comes from the site key in the customer's code snippet, and the conversation from a token the server signed for that one conversation; a token is worth nothing on another site or another conversation.
- The chat's frame can be shown only on the website the customer named. It runs with a content policy that allows its own script and nothing else.
- Visitors are answered from rules the customer wrote, by plain code. What a visitor types is never given to a model, and is stored and shown as text.
- Each reply is recorded before it is shown, and is shown only while an owner or admin has the chat switched on. The database itself refuses a reply without that record.
- Limits apply per visitor, per network address, per conversation and per day, and the number of open connections is bounded.

## When an account is disconnected

Its mail and calendar events leave the screens and Ask at once, and any project scan's findings are deleted. In the same step they are removed from the record of changes that open tabs catch up from, from the command history that Undo reads, and from copies made elsewhere (a lead's reply in the outbound inbox); finished runs' transcripts are cleared. Undo never puts back mail from a mailbox that is no longer connected. The stored copy is then deleted by a job.

## Secrets

- API keys for Composio, OpenRouter and Resend are environment variables on the server. They are not in the code repository, not in prompts and not in logs; log lines pass through a filter that removes anything shaped like a key or token, and a test greps the logs of a full run for the keys in use.
- The assistant's tools run inside the server and are given no credentials.
- Webhooks from Composio are accepted only with a valid signature and a recent timestamp.

## The web application

- HTTPS only, with HSTS. The app may not be framed by other sites. Standard security headers on every response.
- Requests are limited in size (1 MB; 2 MB for webhooks). A person is limited in how many live connections they hold.
- State-changing requests need the session cookie and are checked against the app's own origin.
- Sign-up on production is by invitation or an allow-list. With the mail provider configured, a new account must confirm its address.
- The sign-in library limits repeated sign-in attempts (its default in production; not separately tested here: it is in the penetration test's scope).

## How long things are kept

| What | How long |
| --- | --- |
| Synced mail, events, files and their text | While the account is connected. Disconnecting removes them from the screens and from Ask at once; the stored copy is deleted by a background job. |
| A workspace | Until deleted by its owner. It is closed at once and every row is deleted 30 days later. |
| Pages in the trash | 30 days, then deleted for good. |
| Earlier versions of a page | The newest 100 per page, none older than 90 days. They go when the page is deleted for good. |
| Website chat conversations | 12 months by default; the owner can choose 1, 3, 6, 12 or 24. A visitor's network address is never stored. |
| The audit log | For the life of the workspace. |
| Server logs | Railway's retention for the plan. **[CONFIRM]** |
| Backups | **Not enabled yet.** |

## Not in place yet

These are known and planned; none is hidden behind a claim above.

- **Backups** of the database volume are not switched on (a setting in Railway's dashboard).
- **Export** of a workspace's data by its owner is not built.
- **Staff access**: there is no staff console, and no record of staff access to the database. Access is whoever holds the Railway project. The application's database role can sign in with a separately held credential, and the server refuses to start if that credential could bypass row-level security; until the owner switches to it on Railway, its password is derived from the owner role's inside the server.
- **Encryption at rest** is whatever Railway provides for volumes and buckets **[CONFIRM with Railway]**; Timmy adds no field-level encryption of its own.
- **An incident response plan** and an on-call contact are not written.
- **An independent penetration test** has not been done (`penetration-test-scope.md` is the brief for one). Internal reviews have: three safety reviews (the last, on Nov 17, by two independent reviewers who proved 24 breaks with tests, all fixed), a security audit and a code review, each with fixes and tests (see `STATUS.md`).
- **SOC 2** is planned (Type I by the paid launch), not started.
- **A real mailbox** has not yet been connected end to end; everything above is tested against stand-ins for Google, Microsoft and the model, and against Composio's real tool definitions.
- **Uploaded files are not scanned for malware.**
- **A full content-security policy for scripts** is not set yet: the app forbids being framed by other sites and sends the standard headers, but does not yet restrict where scripts may load from.
- **Region**: one region. The server and the database run in Railway's US West region (California); the bucket's region is **[CONFIRM]**. There is no EU region.
