# Bids: Timmy on Kontract's engine

Asked on Nov 28, 2026, with Kontract's `ARCHITECTURE.md`: "enable Timmy to support this architecture."

Kontract has four doors into the same code. The one meant for another server is its **engine API** (`/api/v1`): a server keeps its own customers' records and calls Kontract for the public data. Magpie was the first such server; Timmy is now the second. Kontract stores nothing of Timmy's. It sees only which Timmy workspace a call is for, and it meters the calls.

## How it fits

| | Kontract (the engine) | Timmy |
| --- | --- | --- |
| Keeps | Public data: SAM.gov's daily file (about 7,000 notices), state and local bid feeds, what a notice's documents say, USAspending awards, permit feeds | Each workspace's own bids: the copy of the notice, its stage, price lines, subs and their quotes, notes, the proposal page, the to-do for its deadline |
| Is asked | Search notices, read one, read its documents (rules, or Claude), the documents as text, check quotes, past awards, local businesses, a website's facts, permits, contractors pulling permits | Everything a person does with a bid |
| Knows of the other | A workspace id, `timmy-<workspace id>`, on each call. Never a name, an address or a record | The service key, kept on the server only |
| Money | Reports each paid call's cost in `X-Kontract-Cost-Micro` | Checks the workspace's monthly limit before a call that can cost money, and logs every call's cost with the model's usage, so one limit covers both |

The contract is Kontract's own `src/lib/api-v1.ts`, copied as `src/data/kontract-api.ts`. Kontract only adds to it. Anything removed or renamed would be `/api/v2`, so the copy only needs refreshing to pick up new fields.

## What is built (version 1)

**Server**
- `server/src/kontract/client.ts`: the HTTP client.
  - It sends the bearer key and `X-Workspace-Id`, and reads the cost header.
  - A refusal reaches the person in plain words:
    - 401: Timmy's connection isn't set up right (logged; the key is never repeated).
    - 429: Kontract is busy, try again in N seconds, with `Retry-After` passed on.
    - 404: that notice isn't open.
    - Other errors become one generic sentence.
- `callKontract` wraps every call. It checks the monthly limit for `details`, `breakdown`, `subcontractors` and `websites/read`, then makes the call and writes one `usage_event` row (`route` `kontract:<endpoint>`, `model` `kontract`) with the cost, the time taken and whether it worked.
- `server/src/testing/kontract.ts`: a stand-in engine for tests and the live suites. It answers from made-up sample notices (`src/data/bids-sample.ts`), checks quotes against their text, and charges like the real one.
- `server/src/http/bids.ts`: the routes the screens use. Search, a notice, track, read the documents, past awards, local businesses, contractors pulling permits nearby, and a website's facts.
  - Tracking fetches Kontract's own copy of the notice. A screen can't make a bid with a notice of its own; the server refuses `trackBid` from a screen.
- `server/src/agent/bid-tools.ts`: Ask's tools.
  - `search_opportunities`, `get_opportunity`, `read_bid_documents`, `get_past_pricing`, `find_subcontractors`, `list_my_bids` and `track_bid`.
  - Everything from Kontract reaches the model as outside content, like mail.
  - Ask reads documents through Kontract's free `/text` endpoint with Timmy's own model, so reading spends no Kontract credit.
  - Finding businesses and tracking a bid only happen in a conversation someone is having.
  - The tools are offered only while Kontract is set up.
- The server checks every bid and the company record before saving: the stages; whole-cent prices; quantities; up to 60 lines and 60 subs; email and website shapes; and size limits on what came from Kontract.

**Screens** (`src/areas/bids`): a **Bids** section.
- It shows in the rail only where the server has Kontract set up. It always shows in the sample demo.
- **Find**: open notices with filters for what, state, level and services only. Sample notices are labelled. Track starts a bid, and its deadline goes on the to-do list as a high-priority task.
- **My bids**: sorted by deadline, with stage filters and the pipeline's value.
- **Company**: UEI, CAGE, contact, what you do, NAICS codes, states and the usual markup.
- **A bid** has a stage picker, a project picker and four tabs:
  - **Overview**: what the documents say. Each fact (budget, length, site visit, questions due, how it's judged, bonds, requirements, forms to return, wage determinations) shows the words it came from and the document. Below that are the documents' read status and a plain-English read.
  - **Pricing**: past awards with the typical price per year and in total, and who won them. Then your price lines (sub cost, price, amount), "Price at markup", the length in years, totals and margin, and how your price per year compares with the typical award.
  - **Subs**: the subs on the bid, each with a status and their quote.
    - **Ask for a quote** opens the compose window with the request written: the work, the lines to price, the breakdown's questions, and a date two days before the bid is due. It never shows your price or markup. Sending it goes through the mailbox like any email and marks the sub asked.
    - Other actions: find their email on their website, save them to People, or remove them.
    - **Find local businesses** runs a paid search. **Pulling permits near the job** is a free list of contractors who recently pulled building permits nearby.
  - **Proposal**: starts a page in Docs filled from the bid and your company. Every blank is [bracketed], and Timmy never makes up licenses, past performance or figures. The tab also holds the bid's notes.

**Tests**
- `server/test/bids.test.ts` (17). It runs the real HTTP client against a local server and covers: headers, the cost header, each refusal, and that the key is never repeated; workspace ids; search; tracking (Kontract's copy, the to-do, once only, and a screen can't forge one); reading the documents, including a closed notice from the kept copy; past awards; the monthly limit (no paid call is made at the limit, while free calls still work); 429 passed on; the server's refusals; a quote request marking the sub asked and never showing the price; the proposal's blanks; roles; Ask's tools; and the tools disappearing when Kontract is off.
- `e2e/e2e-bids.cjs`: demo, 30 checks.
- `e2e/live/live-bids.cjs`: live, 15 checks.

## Turning it on (the owner's step)

It is off until the server has both variables. On Railway, on the `app` service (staging, production or both), add:

| Variable | Value |
| --- | --- |
| `KONTRACT_URL` | Kontract's public address, e.g. `https://kontract-production.up.railway.app` (no trailing slash) |
| `KONTRACT_SERVICE_KEY` | A key of at least 32 characters, e.g. from `openssl rand -hex 32` |

Then add **the same key** to Kontract's `KONTRACT_SERVICE_KEYS` on the `kontract` service. That variable is comma-separated, so Magpie's key stays and Timmy's is added after a comma.

**To check it:**
- Bids appears in the rail.
- **Find** lists real notices, with no "Sample" label.
- Calls appear in the workspace's usage under `kontract:*`.

**What costs money:** Kontract charges for business search (Google Places, about $0.035 a search), website reading (Firecrawl, about $0.001 a page) and Claude, if Kontract has an Anthropic key (it doesn't yet, so its reading and plain-English breakdowns use its free rules). Search, notices, documents as text, quote checks, past awards and permits are free. Each workspace's Kontract cost counts toward its Timmy monthly limit.

## Next, in the order I'd build them

1. **Claude's reading of the documents, through Timmy's own model.** Page through `/text` (free), have Timmy's model list the scope item by item, and keep an item only if `/quotes` confirms its words are in the documents. This mirrors Kontract's `verifyReading`, but on Timmy's model and limit.
2. **Drafts from Kontract's `/drafts`** (scope of work, outreach, proposal) as an alternative to the template. This only makes sense once Kontract has a Claude key.
3. **Quotes from subs coming back by email.** When a sub replies to the quote request with a price, Timmy proposes it as their quote. The person confirms; it isn't set on its own.
4. **Permit leads for trades.** Kontract's `/permits` with trade tags, as a lead list for workspaces in the trades (fence, roofing, landscaping…), feeding Outbound.
5. **The deadline in the calendar**, a site-visit event, and a reminder when questions are due.
6. **Bids in Timmy's MCP server**, so Claude can work bids on a Timmy account too.
7. **A "government contracting" trade** in onboarding that turns Bids on and asks for the UEI and NAICS codes up front.
