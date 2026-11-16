# Subprocessors

Draft, Nov 16, 2026. Not legal advice.

A subprocessor is another company that handles customers' data on Timmy's behalf. This is the list as the system is built today, with what each one sees. Anything marked **[CONFIRM]** has not been checked with that company and should be before this list is published.

## The list

| Company | What Timmy uses it for | What customer data it handles | Where | Their agreement |
| --- | --- | --- | --- | --- |
| **Railway** (Railway Corp.) | Hosting: the server, the Postgres database, the file bucket | Everything Timmy stores (see `security-measures.md`): accounts, workspace state, synced mail, calendar events and file names, the map of people and promises, the audit log, uploaded files | United States: the server and the database run in Railway's US West region (California), as deployed on Nov 16, 2026. **[CONFIRM]** the bucket's region | Railway publishes a DPA; **[CONFIRM]** it is accepted for this account |
| **Composio** (Composio, Inc.) | Every connection to a customer's own apps (Gmail, Google Calendar, Outlook, Google Drive). Composio runs the sign-in with Google or Microsoft, **holds the access tokens**, and makes each call to those apps on Timmy's behalf | The tokens for each connected account. The content of every call passes through it: mail read and sent, calendar events, file names and file text. **[CONFIRM]** what Composio logs or keeps of that content, and for how long | **[CONFIRM]** | Composio publishes a DPA; **[CONFIRM]** it is accepted for this account |
| **OpenRouter** (OpenRouter, Inc.) | Every model call | The text of each prompt and answer: the person's question, and the parts of their mail, pages or files needed to answer it. Requests are sent with zero-data-retention routing and "deny data collection" (`provider: { zdr: true, data_collection: 'deny' }` in `server/src/providers/model.ts`), so OpenRouter only uses model hosts that keep nothing. **[CONFIRM]** the same policy is enforced at the account level in OpenRouter's settings, and that OpenRouter's own prompt logging is off | US **[CONFIRM]** | OpenRouter publishes terms and a privacy policy; **[CONFIRM]** whether a signed DPA is available |
| **The model host OpenRouter routes to** | Running the model (Claude Opus 5.5, the only model on Timmy's list) | The same prompts and answers | Anthropic, and possibly a cloud host of the same model (Amazon Bedrock, Google Vertex AI). **[CONFIRM]** which hosts are allowed for this account, and restrict the list if the agreement should name them | Through OpenRouter. **[LAWYER]** decide whether the hosts must be named individually |
| **Resend** (Resend, Inc.) | Timmy's own email: sign-in links, address confirmation, invitations, password resets. Not configured in production yet | The recipient's email address and the email's text (which contains a one-time link, never mailbox content) | US **[CONFIRM]** | Resend publishes a DPA; **[CONFIRM]** |

## Not subprocessors

- **Google and Microsoft.** The customer connects their own Google or Microsoft account. Those companies hold that data under the customer's own agreement with them; Timmy reaches it only through the connection the customer grants and can withdraw.
- **Twilio, enrichment providers ("treg", Apollo, Clay and others), CRMs, a sandbox provider.** Named in the product plan, not built, and not connected on any real workspace. Each joins this list before it is switched on.
- **Tools used only during development** (for example a transcript service used once to read public videos). They never see customer data.

## Things for the lawyer to know

- **Google's rules for Gmail data.** Any app that reads Gmail must follow Google's API Services User Data Policy, including its "Limited Use" rules: the data may be used only to provide the features the user sees, may not be sold or used for advertising, may not be read by people except with the user's consent, for security or to comply with law, and may not be used to train general models. Timmy's design follows these (mail is used only to answer the person and prepare their own work; nothing trains a model; model hosts keep nothing). Today the Google sign-in app is Composio's, so Google's review and yearly security assessment are Composio's to hold; if Timmy moves to its own Google app, both become Timmy's.
- **Transfers outside the customer's country.** Every company above is US-based as far as is known. A customer in the EU or UK needs the standard contractual clauses (or the UK addendum) in the agreement, and the same from Timmy to each subprocessor. An EU hosting region is an open product question.
- **Notice of changes.** The draft agreement promises 30 days' notice before a new subprocessor handles customer data. There is no mailing list or page for that yet.
