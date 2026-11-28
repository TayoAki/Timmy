# Leads that fit the offer, through Treg

Asked on Nov 28, 2026: "What we want is for Timmy to suggest leads for a person's business using Treg and their offer… and can it create cold email sequences for users?"

Then: "yes connect treg, build it with the stand-in first."

That answer changes one standing decision. On Nov 16 the owner said every connection goes through Composio and anything Composio doesn't offer is skipped, so Treg (which has its own token) was set aside. On Nov 28 the owner said to connect Treg. Cold email itself is unchanged: Timmy writes it, and each email opens in the person's own Gmail or Outlook for them to send. A sequence never sends itself.

## What is built

**Treg on the server** (`server/src/treg/client.ts`), following Treg's guide for products that call it for their own customers.
- One team token, `TREG_TOKEN`, on the server only, sent as `X-Treg-Token`.
- Every call is tagged by our own code, never by the model: `X-Treg-Meta: workspace=timmy-<id>,feature=lead-suggest|offer-draft|…`. Treg can then report and cap spend per workspace. A name or an address never goes into the tag.
- Each call has a cost cap, `X-Treg-Route-Max-Cost` ($0.25 by default, `TREG_MAX_COST_USD`). It also carries an `Idempotency-Key`, so a retry within a day is answered from Treg's store and charged once.
- The workspace's monthly limit is checked before every lookup.
- Each call is logged with what it cost (`X-Treg-Cost-Micro`), the provider that answered and Treg's call id (`X-Treg-Call-Id`). It goes in the same usage log as the model and Kontract, so one limit covers all three.
- Refusals are said plainly:
  - The workspace's own limits are told to the person: its Treg allowance for the day, being blocked, or the cost cap.
  - The team account's problems are logged and never shown: balance, funds, the platform's daily cap. The person sees "Finding leads is paused for this server just now."
  - The token, a balance and a top-up link are never repeated.
- The routed lookups used: `treg.companies.search`, `treg.people.search`, `treg.people.email.find` (asked to verify, with the domain matched strictly) and `treg.web.extract`. `treg.people.email.verify` and `treg.companies.enrich` are wired but not yet used.
- A stand-in (`server/src/testing/treg.ts`) answers with made-up companies and people on `.example` domains, and charges like Treg.

**Suggest leads** (`server/src/treg/leads.ts`; Outbound › Leads › Suggest leads; Ask's `suggest_leads`). Steps:
1. Companies like the offer's ideal customer, or what the person asked for ("15 dental practices in Austin"), a page at a time. A company already in the leads is skipped.
2. The person with the ideal customer's job title at each company.
3. Their work email, found and checked in the same call. It is kept only when the check says the mailbox takes mail. Catch-all and unknown addresses are left out, so nothing bounces and nobody is written to at a guessed address.
4. Why each lead fits the offer (the Leads screen's fit score), and which provider each detail came from.
5. A first line for each lead (`{{opener}}`), written by Timmy's model from what the provider said about the company. It is kept only when every figure and name in it is in that description.

The leads go into **Suggested by Timmy**, at most `TREG_LEADS_PER_DAY` (25) per workspace per day. Nobody is contacted.

**The offer from the business's website** (Templates & offer › Draft from my website). Treg reads the page and Timmy's model fills in the offer and the ideal customer. The proof is kept only when its sentence, with a number, is on the page; otherwise it is left empty for the person to add. Nothing is saved until they press Save offer.

**Sequences written by Timmy's model** (New campaign › Timmy writes it, on a real workspace). There are four emails: an opener that starts with `{{opener}}`, a follow-up, one built on the proof, and a polite last note. An optional call step can be added. The model writes only with the merge fields Timmy fills. A step that states a figure the offer doesn't give, uses a merge field Timmy doesn't fill, or links anywhere in the first email is replaced by Timmy's own wording. In the sample demo, and if the model can't be reached, Timmy's own template is used.

**Working a sequence by hand** (the Nov 16 decision stays):
- A campaign on a real workspace needs no sending mailbox.
- Writing to a lead in a campaign starts from their next step, filled in for them. When there is no first line for them, the `{{opener}}` line is left out.
- The email opens in their Gmail or Outlook.
- When the email shows up in Sent, the lead moves to the next step, due after its wait. A reply from them stops the sequence.
- A campaign can't send by itself.

**Tests**
- `server/test/treg.test.ts` (14), covering:
  - the real HTTP client against a local server: headers, costs, each refusal, and that the token and balance are never repeated;
  - the workspace tag;
  - the checks on first lines and steps;
  - suggestions: fit, sources, checked emails, no company twice, the daily and monthly limits, nobody contacted;
  - Treg's refusals;
  - the offer from a website, with and without proof;
  - a sequence with bad steps replaced;
  - a sent email moving a lead to the next step, with launch still refused;
  - Ask's tool, attended only and hidden when Treg is off;
  - roles.
- `e2e/live/live-leads.cjs` (13 checks).

## Turning it on (the owner's step)

On Railway, on the `app` service, add:

| Variable | Value |
| --- | --- |
| `TREG_TOKEN` | The team's org-scoped token from Treg (`treg org agent-new timmy` in Treg's CLI). It must be a team token, not a personal login token. |
| `TREG_MAX_COST_USD` | Optional. The most one lookup may cost; $0.25 if unset. |
| `TREG_LEADS_PER_DAY` | Optional. Leads one workspace may be suggested a day; 25 if unset. |

**Also worth setting in Treg itself:**
- A default daily cap per workspace: `PUT /orgs/<org_id>/budgets/customer` is the guide's per-customer default. Timmy tags with `workspace=…`, so set it on that tag, for example `{"daily_cap_micro": 2000000}` for $2 a day.
- A prepaid balance, or auto top-up. Treg's own guide says per-customer caps are advisory and the balance is the hard limit.

**What it costs** (Treg's catalog, Nov 28):
- A company search: up to $0.30 per hit.
- A people search: up to $0.10.
- A found email: $0.00095 to $0.22. Misses are free.
- A page read: about $0.00025.
- So 10 suggested leads cost roughly a few cents to a dollar, depending on which providers answer.

Each workspace's Treg cost counts toward its Timmy monthly limit.

**To check it after adding the token:**
- Outbound › Leads shows **Suggest leads**.
- The dialog doesn't say "sample data".
- Calls appear in the usage log under `treg:*`.

## Next, in the order I'd build them

1. **"Due today" for sequences.** A list in Outbound of the leads whose next step is due, each one click from their mail app.
2. **Suggest leads on a schedule.** A few each morning, within the day's allowance, as work nobody asked for (its share of the limit).
3. **A company's own facts for the first line.** Read a short excerpt of the company's site with `treg.web.extract`, for a better opener, checked the same way.
4. **Re-check an email** with `treg.people.email.verify` before the first send if it was found more than 30 days earlier.
5. **Leads in the Unibox**, sorted by Timmy when they reply. This already works for leads on a real workspace; suggested leads use the same path.
