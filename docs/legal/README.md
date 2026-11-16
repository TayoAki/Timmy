# Paperwork for outside parties

Two things on the phase 1 list cannot be finished from inside the engineering work: a **penetration test** (it has to be done by people who did not build the system) and a **data processing agreement** (it has to be reviewed by a lawyer and signed by a company). The files here are what to hand those people so they can start without a discovery call.

| File | Who it is for | What it is |
| --- | --- | --- |
| `data-processing-agreement-draft.md` | A lawyer | A first draft of the agreement Timmy signs with each customer. Every place a lawyer has to decide something is marked **[LAWYER]**; every fact someone has to fill in is marked **[FILL IN]**. |
| `subprocessors.md` | A lawyer; later, the public website | The other companies that handle customer data on Timmy's behalf, what each one sees, and what is still to confirm with each. |
| `security-measures.md` | A lawyer (it is Annex 2 of the agreement); a security reviewer; a customer's security questionnaire | What data Timmy holds, where, for how long, and the protections that are really in the code today. It also lists what is **not** in place yet. |
| `penetration-test-scope.md` | A penetration-testing firm | What to attack, where, with which accounts, the claims the system makes that they should try to break, and the rules of the engagement. |

These are drafts written by the engineer who built the system. They are accurate about the system as of the date in each file. They are **not legal advice**, and the agreement is not fit to sign until a lawyer has been through it.

## What still needs a person outside the build

- [ ] A lawyer reviews `data-processing-agreement-draft.md` and `subprocessors.md`, and decides the open points marked **[LAWYER]**.
- [ ] The company signs a data processing agreement with each subprocessor (Railway, Composio, OpenRouter, Resend), or confirms that their standard terms already include one. `subprocessors.md` says where each one publishes theirs.
- [ ] A penetration-testing firm is engaged with `penetration-test-scope.md`. Their findings come back to engineering and each one is fixed with a test.
- [ ] Google's security assessment (CASA) and app review, if Timmy moves from Composio's Google app to its own (see `STATUS.md`, "Needs your attention").
