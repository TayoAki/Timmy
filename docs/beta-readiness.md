# Beta readiness: what to fix before a tester starts

Updated Nov 18, 2026.

- **Production app:** https://app-production-a7a7000d.up.railway.app
- **Demo (sample data, no account):** https://web-production-c4bbfc9c.up.railway.app

**Verdict:** ready for **one tester you trust** once the four items in "Before they sign up" are done. Everything in "First week" should be done while they test. "Before strangers" is not needed for a friendly tester, but is needed before a public beta.

---

## Before they sign up (blockers)

| # | What | Why | Who | Time |
| --- | --- | --- | --- | --- |
| 1 | **Add the tester's email to the sign-up allowlist** (`TIMMY_SIGNUP_ALLOW` on the `app` service) | Sign-up is invite-only. Without this they can't create an account. | You send me the address; I add it. | 2 min |
| 2 | **Turn on backups for the database volume.** In Railway, open the `pgvector` volume, then Backups. | With no backups, a database failure loses everything they make only in Timmy: rules, to-dos, projects, pages, decisions. Their email stays safe in Gmail. | You (I can't do this from here) | 2 min |
| 3 | **Brief the tester** (draft below) | No password resets yet; Google's permission screen; nothing sends without their click; the known gaps | You | 5 min |
| 4 | **Get their OK on where their data goes** (draft below) | There is no privacy policy yet. Their mail passes through Composio (the connection to Google) and OpenRouter (the AI), and the database is on Railway. | You | 2 min |

## In the first week of testing

| # | What | Why | Who | Time |
| --- | --- | --- | --- | --- |
| 5 | **Turn on Timmy's own email (Resend).** Add `RESEND_API_KEY` and `TIMMY_MAIL_FROM` (e.g. `Timmy <timmy@yourdomain.com>`, domain verified in Resend) to `app`. | Without it there are no password resets, no email sign-in links and no invitation emails. A tester who forgets their password is locked out until I step in. | You add the variables; I send one test email, to an address you name | 15 min |
| 6 | ✅ **Done Nov 18: long Google Docs searchable** | Long Docs are read as Google's plain-text export, fetched from Composio's own file store (now on the download list), and the ones set aside earlier are read again when the server starts. | Me | Done |
| 7 | **A "Delete workspace" / "Delete account" button** | The server supports it, but no screen offers it. A tester who wants out can disconnect Gmail (which deletes the mail Timmy kept) but can't delete their workspace themselves. | Me. Until it's built, I delete on request. | Half a day |
| 8 | ✅ **Done Nov 18: a Feedback button** (left rail and phone menu) | Read it in Railway's logs (search "beta feedback"); set `TIMMY_FEEDBACK_TO` on `app` to have it emailed once Resend is on. | Me | Done |
| 9 | **Watch for errors** | No alerting is set up; errors only show in Railway's logs. | Me: I check production logs daily during the beta. Real alerting (e.g. Sentry) comes before strangers. | Daily |
| 10 | **Rotate the keys pasted in chat**: two Composio keys, one OpenRouter key, one Supadata key | They aren't in the repo or the logs, but they were pasted in a chat. | You (make new ones, put them in Railway, delete the old ones) | 15 min |
| 11 | **Decide on AI cost per email read** | Reads use Claude Opus 5.5: about $0.008 per email a person wrote (junk is sorted without AI). A tester getting 100 such emails a day costs about $0.80 a day. Each workspace is capped at $50 a month; when it hits the cap, Timmy stops reading until the cap is raised. | Your call: keep it, or I compare Haiku 5.5 on the same emails, show you the numbers, and you decide | None now |

## Before strangers (not needed for one trusted tester)

| # | What | Who |
| --- | --- | --- |
| 12 | **Privacy policy and terms** on the site, with a checkbox at sign-up. A data processing agreement draft is in `docs/legal/`. | You and a lawyer |
| 13 | **Separately held database passwords**, so the app no longer holds the superuser's (steps in STATUS.md, "Needs your attention", and `docs/ops/database-credentials.md`) | You (a Railway change) |
| 14 | **Your own Google app and Google's verification.** Gmail access needs Google's review plus a yearly security assessment. With Composio's app, the review is Composio's, and it isn't confirmed that their app has passed. If it hasn't, there's a 100-user cap and sign-ins expire after 7 days. | You; takes weeks |
| 15 | **Narrower Google permissions.** Today's sign-in asks for all of Drive, contacts and profile details (Composio's defaults). | You decide; then one setting per app |
| 16 | **Open sign-up with email confirmation** (needs #5) | Me, on your OK |
| 17 | **Penetration test** (scope in `docs/legal/penetration-test-scope.md`) | You (an outside firm) |
| 18 | **A real Outlook test** (only Gmail has been tried for real, by you) | You press Connect once; I run the checks |
| 19 | **Virus scanning for uploads** (optional; adds a paid service) | Me, on your OK |
| 20 | **Look into the calendar test that failed once** in a full run (passed alone twice and in the next full run) | Me |

---

## What the tester can try today

- Sign up, then a guided setup: connect Gmail, choose how junk is sorted, Google Calendar, Drive (optional), the morning run.
- Triage, newest first, with Timmy's suggestion for each email; "Accept all Timmy is sure about"; optional automatic junk sorting (new mail only touches Gmail).
- An email reader that shows the email as the sender laid it out, with links, full addresses and pictures on request.
- To-dos taken from what emails ask, to check off in the email, in Tasks, or on the project.
- Projects: detect them from mail and Drive, put any email in a project (or press P), and "always" for a sender.
- Sorting rules: in Rules & settings, by asking Timmy ("always archive mail from linkedin.com"), or by accepting one Timmy offers after they file the same sender's mail twice.
- Drafts and replies. Nothing is sent until they press Send, with a 30-second undo.
- Ask Timmy about their mail, files and people.
- People › Map, and Drive files opened inside Timmy, and edited there: **Edit in Timmy** opens a Google Doc, Sheet or Slides deck (or a Word, Excel, PowerPoint or PDF file in Drive) in Timmy's editor, and Save goes back to the Drive file. Drive keeps the earlier version.
- Their own Claude or ChatGPT connected to Timmy (Rules & settings › Approvals has the address).

## Known gaps to tell them about

- No password reset by email yet (#5).
- PDFs and Office files kept in Drive are listed but not read.
- No delete button for the workspace or account yet (#7); ask you instead.
- Gmail's permission screen asks for more than Timmy uses (#15), and may show a warning about an unverified app (#14).
- Outlook hasn't been tried with a real account (#18).

---

## Draft: message to the tester

> Hi [name],
>
> Thanks for trying Timmy. Here's how to start:
>
> 1. Go to https://app-production-a7a7000d.up.railway.app and choose **Create an account** with this email address: [their email]. **Save your password**; password reset by email isn't switched on yet.
> 2. Name your workspace. The setup walks you through connecting Gmail, your calendar and (if you like) Google Drive.
> 3. Google's sign-in page will mention Composio, the service Timmy uses to talk to Google. It asks for wide access (including all of Drive and your contacts): those are its standard settings. Timmy only uses your mail, your calendar and your files, and it changes a file in Drive only when you edit it in Timmy and press Save. If Google warns that the app isn't verified, that's expected during the beta.
>
> Good to know:
> - **Nothing is ever sent without your click**, and every send can be undone for 30 seconds.
> - Junk is only filed away automatically if you switch on "Sort junk automatically". Even then, existing mail in Gmail is left alone; only new mail is filed there.
> - It's a beta: some things are rough (PDFs in Drive aren't read yet, for one). The **Send feedback** button on the left sends anything odd straight to me.
> - Disconnecting Gmail (Connections) deletes the mail Timmy kept. If you want your whole workspace deleted, tell me.
>
> Please send anything odd, confusing or broken to [your email or number], with a screenshot if you can.
>
> Thanks!

## Draft: their OK on data (send with the message, or ask in person)

> Timmy is in beta and doesn't have a published privacy policy yet. So you know: when you connect Gmail, Calendar or Drive, Timmy reads them through Composio (the connection to Google) and keeps a copy of your recent mail, and the names and text of your recent Google Docs, Sheets and Slides (so you can search them), in its database on Railway (US). To sort emails and write drafts, Timmy sends the text of emails people wrote to you to an AI model (Anthropic's Claude) through OpenRouter. Nothing is sold or shared with anyone else. You can disconnect any account at any time, which deletes what Timmy kept from it, and ask me to delete your workspace entirely. Reply "OK" if you're happy to test on those terms.
