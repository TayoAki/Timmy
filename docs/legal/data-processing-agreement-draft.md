# Data Processing Agreement (draft)

Draft for a lawyer's review, Nov 16, 2026. **Not legal advice and not fit to sign as it stands.** Written by the engineer who built the system so that the facts are right; the legal terms are placeholders in common form. **[LAWYER]** marks a decision for counsel. **[FILL IN]** marks a fact to supply.

---

This agreement is between **[FILL IN: company legal name and address]** ("Timmy", "we") and the customer named in the order or sign-up it attaches to ("Customer", "you"). It forms part of the agreement under which you use the Timmy service (the "Main Agreement") and applies whenever we handle personal data for you.

## 1. Who is who

1.1 You decide why and how personal data in your workspace is used. You are the **controller** (or a processor acting for your own client). We handle it only to provide the service to you. We are your **processor**.

1.2 We are a controller only for the small set of data we need to run our own business: the account details of the people who sign in (name, email address, password hash), billing records, and security logs. Our privacy policy covers that data. **[LAWYER]** confirm the split, and whether the audit log of a workspace is processor or controller data.

1.3 Words used here that are defined in data protection law (the EU and UK GDPR, the California Consumer Privacy Act and similar laws that apply to you) have the meaning given there. Under the CCPA we are your **service provider**: we do not sell or share personal data, and we do not keep, use or disclose it for any purpose other than providing the service. **[LAWYER]** add other state laws as needed.

## 2. What we do with the data

2.1 **Only on your instructions.** We handle personal data only to provide the service as described in the Main Agreement and Annex 1, and as you direct through the product (connecting an app, setting a rule, approving an action). If the law requires us to do otherwise we will tell you first unless the law forbids it.

2.2 **No other use.** We do not use your data to train models, do not sell it, do not use it for advertising, and do not combine it with other customers' data. Model providers we send it to are bound to keep nothing after answering (Annex 3).

2.3 **Data from Google accounts.** Our use of information received from Google APIs follows Google's API Services User Data Policy, including the Limited Use requirements.

2.4 **Outside actions need a person or a rule.** The service sends an email, changes a mailbox or writes to a calendar only after a person in your workspace approved that action or set a rule that covers it. Every such action is recorded in your workspace's audit log.

## 3. People

3.1 Everyone at Timmy who can reach customer data is bound by a duty of confidentiality.

3.2 Our staff do not read the content of your mail, files or pages except (a) at your request, to help you, (b) to investigate a security incident or a fault, limited to what that needs, or (c) where the law requires it. **[FILL IN]** There is no staff tool for reading customer data today; database access is held by **[FILL IN: who]**. A record of staff access is planned and not yet built (see Annex 2, "Not in place yet").

## 4. Security

4.1 We keep the measures described in Annex 2 and will not make them materially weaker during this agreement.

4.2 **Incidents.** If we become aware of a breach of security that leads to personal data in your workspace being lost, changed, disclosed or reached without permission, we will tell you without undue delay and within **[LAWYER: 48 or 72]** hours, with what we know: what happened, what data and roughly how many people, what we have done, and who to contact. We will keep you informed as we learn more and help you meet your own duties to notify.

## 5. Other companies we use (subprocessors)

5.1 You agree that we may use the subprocessors listed in Annex 3.

5.2 We will tell you at least **30 days** before a new subprocessor starts handling your data **[FILL IN: how — a page and an email list]**. If you object on reasonable data-protection grounds and we cannot offer a way round, you may end the affected service and receive a refund of fees paid in advance for the remaining period. **[LAWYER]**

5.3 We put each subprocessor under terms that protect your data to at least the standard of this agreement, and we remain responsible to you for what they do.

## 6. Helping you

6.1 **Requests from individuals.** If a person asks us directly to see, correct or delete their data and it concerns your workspace, we pass the request to you and do not answer it ourselves. The product lets you delete a connected account's stored data (by disconnecting it) and delete the whole workspace. **[FILL IN]** An export of a workspace's data is planned and not yet built; until it is, we will produce one on request within **[FILL IN]** days.

6.2 **Assessments.** We will give you the information you reasonably need for a data protection impact assessment or a consultation with a regulator about your use of the service.

## 7. Moving data between countries

7.1 We store and process data in **[FILL IN: region — see Annex 3]**.

7.2 Where your data is subject to EU, UK or Swiss law and is transferred to a country without an adequacy decision, the EU Standard Contractual Clauses (module two, controller to processor; module three where you are a processor), the UK Addendum and the Swiss amendments apply and are incorporated by reference, with the details in the annexes. **[LAWYER]** complete: governing law and forum for the clauses, the docking clause, the option chosen for subprocessors (general authorisation, clause 9(a) option 2, 30 days), and whether we rely on the EU–US Data Privacy Framework for any subprocessor.

## 8. When the agreement ends

8.1 **Deletion.** When you disconnect an app, the content we synced from that account is removed from your screens and from Ask at once and deleted from our database by a background job. When you delete your workspace it is closed at once and every row of it is deleted **30 days** later. Backups, once enabled, age out within **[FILL IN]** days.

8.2 **Return.** Before deletion you may ask for a copy of your workspace's data (see 6.1).

8.3 We may keep data longer only where the law requires it, and then only for that purpose.

## 9. Showing that we comply

9.1 We will make available the information needed to show we meet this agreement, including a summary of our most recent independent penetration test and, once we hold one, our SOC 2 report. **[FILL IN]** Neither exists yet: the first penetration test is being commissioned and SOC 2 Type I is planned for the paid launch.

9.2 **Audits.** Not more than once a year (or after an incident, or when a regulator requires it), on 30 days' written notice, you or an independent auditor bound by confidentiality may audit our compliance, at your cost, in a way that does not expose other customers' data. **[LAWYER]**

## 10. General

10.1 If this agreement and the Main Agreement conflict about personal data, this one wins. The Standard Contractual Clauses win over both.

10.2 Liability under this agreement is subject to the limits in the Main Agreement. **[LAWYER]** decide whether data-protection liability has its own cap.

10.3 This agreement lasts for as long as we handle personal data for you.

---

## Annex 1: Details of the processing

| | |
| --- | --- |
| **Subject matter** | Providing Timmy, an assistant for work email, calendar, documents and tasks. |
| **Duration** | The term of the Main Agreement, plus the deletion periods in section 8. |
| **Nature and purpose** | Reading the customer's connected mail, calendar and files; sorting and summarising them; drafting replies; proposing and, once approved, carrying out actions (sending an email, filing a thread, writing a calendar event); answering the user's questions about their own work; keeping the workspace's own pages, tasks and contacts; answering visitors on the customer's website chat from rules the customer wrote. |
| **Whose data** | The customer's users (owners, admins, members and other roles). People the customer corresponds with: senders and recipients of email, meeting guests, people named in mail, files and pages. Leads and contacts the customer records. Visitors to the customer's website who use the chat. |
| **What data** | Names, email addresses, job titles and companies. The content and headers of email in the connected mailbox (the last 90 days are synced, then new mail as it arrives) and attachment names. Calendar events (title, time, place, guests, notes). Names of files in the connected drive and, when a user asks Timmy to read one, its text at that moment (not stored). What Timmy derived from these: which thread needs a reply, promises made and awaited with the sentence each rests on, open decisions, and a list of people and companies. Pages, tasks, rules and settings written in the workspace. Website chat conversations and the contact details a visitor chooses to give. Files and pictures uploaded to the workspace. An audit log of actions. |
| **Special categories** | None are asked for. Email and documents may contain them incidentally. The customer is responsible for having a lawful basis to connect the accounts it connects. **[LAWYER]** |
| **Frequency** | Continuous. |
| **Retention** | See Annex 2, "How long things are kept". |

## Annex 2: Security measures

See `security-measures.md` in this folder, which is this annex.

## Annex 3: Subprocessors

See `subprocessors.md` in this folder, which is this annex.
