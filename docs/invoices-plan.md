# Invoices and quotes: research and plan

Asked on Nov 27, 2026: "research and add in creating invoices and etc; we can use the Tiptap editor and PandaDoc for inspiration." Version 1 is built (below). What comes after it is listed under "Version 2", for the owner to choose from. Some of it needs the owner's OK and their own keys.

## What the research found (checked Nov 27, 2026)

**PandaDoc.**
- Quotes, proposals and contracts are documents built from templates. Square-bracket variables such as `[Client.FirstName]` are filled from the contact, the system or the person.
- A pricing block holds the lines: quantity, unit price, a discount and tax per line or on the total, and optional items the client can tick. The total discount comes off the subtotal after line discounts.
- Statuses: draft, sent, viewed, waiting for payment, paid, completed, declined, voided (expired).
- The client needs no account. They press Start, fill the marked fields and accept; a decline needs a reason and locks the document.
- A completed document gets a certificate on its last page: who signed, their verified email, IP address, and sent, viewed and completed times.
- Reminders go every 5 days, at most 10. Documents expire after 60 days by default, with a warning a day before.
- Payments: Stripe, Square, PayPal, QuickBooks Payments, Authorize.net.
- QuickBooks: an estimate is created when the document is sent and an invoice when it is completed.
- Every quote-to-cash feature is on the $49-a-seat plan, so a small-business tool can undercut it there.

**Tiptap** (already in Timmy at 3.32, MIT).
- The editor, tables (with merged cells), collaboration and the static renderer (HTML on the server, no browser) are free.
- PDF export, comments and DOCX are paid, and the paid PDF export sends documents to Tiptap's servers. We don't need it: Timmy makes the PDF itself.
- A variable chip is an inline atom node, like the free Mention extension.
- A pricing table is a block atom node holding its lines as attributes, with a React view for editing.
- BlockNote (its PDF export is GPL or paid) and Lexical (needs a virtual DOM on the server) fit less well.

**US invoices.**
- There is no federal list of required fields for private invoices. The federal "proper invoice" rule for government contracts (FAR 52.232-25) is the best checklist:
  - seller name and address, invoice number and date;
  - each line's description, quantity, unit price and amount;
  - payment terms and where to send payment;
  - a contact for questions.
- Common practice adds the buyer, a due date, subtotal, tax and total.
- Sales tax differs by state and town, and some states (Texas, for one) require it shown separately. Version 1 has a tax rate per line and a separate tax line.

**E-signatures.**
- Under ESIGN (federal) and UETA (state law), clicking "I accept" can be a signature when:
  1. it is a clear act of accepting;
  2. both sides agreed to deal electronically;
  3. there is evidence of who did it (the email link they used, the IP address, the times);
  4. an unchanged copy is kept that both sides can get.
- Consumer deals need ESIGN's consent disclosures.
- Wills, family law and court papers are excluded.

The full brief, with its 53 sources, is in the session's notes. The points above are the parts the plan rests on.

## Version 1 (built, Nov 27–28, 2026)

- **Invoices & quotes** is a section in the left rail (and under More on a phone). It has three tabs:
  - Invoices: outstanding, overdue, paid in the last 30 days, drafts; filters for each.
  - Quotes: waiting for an answer, accepted, expired, drafts.
  - Business details.
- **One record for both** (`Invoice` in `src/data/ws-types.ts`):
  - kind, number, status, client, issued and due dates, currency, lines, a discount, an intro, notes, terms;
  - the project and email it belongs to, and the quote it came from.
  - Lines: description, quantity (decimals allowed), unit price in whole cents, a tax rate, and on quotes "optional" with "chosen".
- **Sums** (`src/state/invoices.ts`):
  - plain code, in whole cents; each line is rounded once;
  - a percentage or amount discount comes off the subtotal and lowers the tax in proportion;
  - an amount discount is never more than the subtotal;
  - an optional line counts only when chosen.
- **Numbers** come from the business details (INV-0001, Q-0001 by default). The server gives them out in order (`newInvoice` in the shared reducer) and refuses a number another invoice of the same kind already has.
- **The page** is laid out the way it prints:
  - the business block, INVOICE or QUOTE, the dates, Bill to (pick a contact or type), what it is for;
  - lines with quantity, price, tax and amount; totals with the discount; notes, terms, how to pay.
  - It is editable while it is a draft. Once sent, it is what was sent; to change it, void it and start a new one.
- **PDF**: made on the server with pdfkit (`server/src/invoices/pdf.ts`), downloadable from the invoice. In the sample demo, the PDF button prints the page alone (or saves it as a PDF).
- **Send** opens the compose window, already written:
  - subject "Invoice INV-0001 from …", the amount, the due date and how to pay;
  - the PDF attached, the project set, and the payment tracked in Waiting until the due date.
  - Nothing goes out until the person presses Send. Sending marks the invoice sent and links its email.
- **Mark paid** ends the wait: the email leaves Waiting.
- **For quotes**:
  - Mark accepted or Declined.
  - Turn into an invoice copies the lines the client chose, the discount and the intro.
- **Void** keeps it for the records. **Open it again** undoes paid, accepted, declined or void. **Delete draft** removes it, with undo.
- **Projects**:
  - each invoice and quote has a project, chosen on its page and changeable at any time;
  - each project's page has an Invoices tab (billed, owed, overdue, paid, quotes waiting, and its list);
  - the sidebar's project picker narrows the invoices screens;
  - a draft started with a project picked, or from a project's tab, is that project's.
- **Bill for this** on an email (Make an invoice / Make a quote) starts a draft for the person who wrote, in the email's project.
  - On a real workspace, one small model call lists the lines the email prices.
  - A line is kept only when the sentence it rests on is really in the email and the price is written in that sentence.
  - A quantity the sentence doesn't give becomes 1.
  - The email is treated as information only, never as instructions.
- **Checked by the server** (`server/src/state/ws-check.ts`) before anything is saved:
  - known kinds and statuses for each kind;
  - whole-cent prices and sensible quantities, tax from 0 to 100%, a discount within bounds;
  - a currency code, an email that looks like one, text limits, at most 200 lines;
  - business details can be changed but not removed.
- **Who can**: anyone whose role can work in the workspace. Read-only roles (RevOps, viewers) can see and download but not start, change or send.
- **Tested**:
  - `server/test/invoices.test.ts` (15): sums, numbering, refusals, projects, quote to invoice, send and paid, the PDF and its attachment, Bill for this, roles.
  - `e2e/e2e-invoices.cjs` (demo, 44 checks).
  - `e2e/live/live-invoices.cjs` (live, 24 checks).

## Pay online with Stripe (built Nov 28, 2026, against a stand-in; off until Stripe's keys are set)

Option 2 below, built when asked: "build the payment link on invoices".

**How the money moves (Stripe Connect, Accounts v2, the setup Stripe recommends for software platforms):**
- Timmy is the platform. Each business gets **its own Stripe account**, made by Timmy when an owner or admin presses **Connect Stripe** in Business details.
  - The account is prefilled with the business name and billing email.
  - The business fills in who it is and its bank on **Stripe's own onboarding page**, then comes back to Timmy.
  - It has the full Stripe Dashboard. Stripe charges its fee to the business and covers losses (`fees_collector` and `losses_collector` are `stripe`).
- An invoice's **"Pay online" link** is a Stripe Payment Link on that account (a direct charge): Stripe's page takes the card, so card details never reach Timmy.
  - Each link is good for one payment (`restrictions.completed_sessions.limit = 1`) and for the invoice's total at that moment.
  - **No application fee**: what the client pays, less Stripe's fee, is the business's.
- **Paid** is what Stripe says, through a signed event to `POST /api/hooks/stripe`, or a "Check Stripe" on the invoice when an event didn't come.

**What the person sees:**
- **Business details › Get paid online**:
  - Connect Stripe, with the country the business is registered in;
  - "Stripe still needs a few details" (Carry on with Stripe);
  - "Stripe is checking your details" (Check again);
  - "Card payments are on" (Open Stripe, Disconnect).
- **On an invoice**:
  - "Sending it adds a Pay online link" (or Make the link now);
  - once made, the link with Copy and Check Stripe;
  - when paid, "Paid online Nov 28: $1,800.00 through Stripe";
  - while a bank payment clears, "Sam started a bank payment… it clears in a few days".
- **Send** makes the link first, so **the email and the PDF both carry it**: "Pay online by card: …", then the business's own "Or pay: …" text. The invoice page shows it too.
- **Paid through it**:
  - the invoice is marked paid and its email leaves Waiting;
  - the activity log says "INV-0001 paid online: $1,800.00 from Sam Rivera".
- **A bank payment** (ACH, SEPA) is marked paid when it clears; if it fails, the invoice stays open and the person is told.

**Safety:**
- **Making a link is an outside write**, so it goes through the Action gateway as `invoice.link`, like a send. The person's press is the approval, and it is recorded and audited.
  - Only a person's click can propose one (`PERSON_ONLY` in `server/src/gateway/policy.ts`). Timmy on its own can't, and neither can a rule or an unattended run.
  - It moves no money: the client chooses to pay, into the business's account. Refunds, payouts and charges stay on the never-list.
- **Switching a link off** (`invoice.unlink`) happens when the person marks the invoice paid by hand or voids it, approved by that same click, so the client can't pay twice.
- **Changed total:** a link for an old total isn't offered. A draft whose total changes gets a new link and the old one is switched off.
- **The link is the server's to write.** A screen saving an invoice can't set it, change its address, drop it or say it was paid (`keepPayLinks` in `ws-check.ts`). Only Stripe says an invoice was paid online (`invoicePayment` is refused from screens).
- **The business's Stripe account id** is kept on the server (`payment_account`, with row-level security), never in the workspace's state. Only an owner or admin connects or disconnects it, so nobody else can point payments elsewhere.
- **Each event is checked before it is read:**
  - the signature and its age;
  - its mode (live or test);
  - the connected account, which says whose it is;
  - the workspace and the invoice named in its metadata;
  - the link the invoice carries.
  - An event seen before is not applied twice.
- **A payment that arrives after the invoice was paid by hand or voided** is recorded, and the person is told to refund it in Stripe if it shouldn't have been paid. An invoice paid online can't be "opened again" in Timmy: a refund is made in Stripe.
- **Disconnecting** stops new links. Links already sent still mark their invoice paid.

**In the sample demo:**
- Stripe counts as connected, and links go nowhere (`https://pay.stripe-standin.example/…`).
- "Sample: the client pays" shows the paid state.

**Files:**
- Server: `server/src/payments/` (`stripe.ts` the client, `accounts.ts`, `links.ts`, `events.ts`), `server/src/http/payments.ts`, `server/migrations/0021_payment_account.sql`.
- Stand-in: `server/src/testing/stripe.ts`.
- Screens: `src/areas/invoices/Pay.tsx`.

**Tested:**
- `server/test/payments.test.ts` (16), covering:
  - the real client against a local server, including its form fields, v2 JSON, headers and refusals in plain words;
  - signatures; connecting and roles; links through the gateway;
  - forged links refused; changed totals;
  - paid, bank payments and failed ones;
  - the event checks; paid by hand or voided; Check Stripe;
  - person-only; Stripe off; disconnected.
- `e2e/live/live-pay.cjs` (14):
  - connect through Stripe's (stand-in) page;
  - send with the link in the email and PDF;
  - paid by Stripe's event;
  - Check Stripe.
- `e2e/e2e-pay.cjs` (demo, 11).

**To switch it on** (the owner's step): see STATUS.md, "Needs your attention".

## Version 2: options to choose from

In the order I would build them. Each is its own piece of work.

1. **A share link with click-to-accept and pay** (the PandaDoc core):
   - The client opens a link with no account and sees the quote. They tick optional lines (if allowed), type their name, tick "I agree to sign electronically", and accept, or decline with a reason.
   - Timmy records who, when, from where and what was shown, and puts a certificate on the last page of the PDF.
   - The signed PDF is emailed to both sides.
   - Needs: a public page on the app's address (like the website chat's), signed tokens, and a records table. No outside service.
   - Each acceptance is the client's act, not Timmy's.
2. **Pay now with Stripe**: built (see above). Off until Stripe's keys are on Railway.
3. **Viewed, reminders and expiry**:
   - "Viewed" when the link is opened.
   - The morning run drafts a reminder every 5 days for an unpaid invoice or unanswered quote, at most 10. As with nudges, they wait for Send.
   - Quotes expire on their date, with a warning the day before.
4. **A pricing table in pages**: a Tiptap block for proposals written in Timmy's page editor, with the same lines and sums, and `[Client.Name]`-style variables filled from the contact. A proposal page can then become a quote.
5. **Templates**: saved lines, terms and intros, for example "Monthly retainer", picked when starting a draft.
6. **Ask can make and find invoices**: "Bill Dana for the November work", "What's overdue?". Through the same records, with drafts waiting for the person.
7. **QuickBooks Online or Xero sync**: an estimate when a quote is sent, an invoice when it is accepted or sent, paid status back. Needs the connection through Composio and your OK.
8. **Later**: approvals before sending over an amount, signing order, recurring invoices, credit notes, multi-currency totals, tax by customer and exemption certificates.

## Not done, and why

- **No email goes out by itself**: sending is always the person's Send in the compose window, through the gateway with the undo window.
- **Stripe is built but off**: it needs Timmy's Stripe platform account with Connect, and its keys on Railway (see STATUS.md).
- **No e-signature yet**: Mark accepted is the person's own record that the client said yes. It is not a signature (option 1).
- **Tax is a rate per line**: it is not worked out from the client's address.
