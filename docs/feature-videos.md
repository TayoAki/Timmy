# Feature videos: 14 films, 30 seconds each, Demo2Win

One 30-second film per feature area in Tell, Show, Tell form, narrated, and played by the real app (the film director drives the demo with real clicks and typing).

## Format

- **Tell (about 0 to 6 s):** a dark card names the area, states the problem, and says what Timmy does about it. This card is also the poster frame.
- **Show (about 6 to 24 s):** the app swings in, and the cursor does the work with real clicks, timed to the narration's words.
- **Tell (about 24 to 30 s):** the recap on a dark card, then the lockup: the mark, "Timmy" and "Try the demo".
- **Specs:** 1920×1080 at 30 fps for review (a 60 fps master renders the same way). Narration plus the "Calm Confidence" bed, mixed to −14 LUFS. An SRT file sits beside each video, with no burned-in captions.

## How to play, render and re-time

- **Play:** `?film=<id>` (for example `?film=inbox`) plays one film in the browser. The choreography is in `src/film/features/<id>.ts`.
- **Script and timings:** `src/film/features/vo.json` holds the scripts. Each film's word timings are in `src/film/features/words/<id>.json`.
- **Render:** `FILM=<id> FPS=30 SCALE=1 OUT=<dir> BASE=<static build> node scripts/film/render.cjs`.
- **Mix:** `python3 scripts/film/mix_feature.py --voice … --bed … --words … --show … --section … --out …`.
- **Captions:** `python3 scripts/film/srt.py src/film/features/words/<id>.json <id>.srt`.
- **Narration:** a scratch voice made locally with an open-source text-to-speech model (Kokoro, Apache-2.0, stock voice "af_heart"). No text went to an outside AI service. For the final read, generate each script as its own take (for example in ElevenLabs), transcribe it to word timings, and replace `words/<id>.json`. The film re-times itself to the new take.

## Truth boundary (all films)

- **What's on screen:** the product in demo mode on its sample data (Taylor at Northpeak; Dana, Marcus, Jamie and the others). Every click shown is a real click causing its real result.
- **Nothing is sent.** The demo never sends email, texts or invites.
- **Names:** no vendor names beyond the user's own apps (Gmail, Google Calendar and Drive, Outlook, the CRMs) and the form sources the product lists. On the film route, the import dialog and the Connections page leave out the data and integration providers.
- **No measured numbers:** no user counts or measured speeds. The clocks and counts shown are the demo's.
- **Not live yet:** features that aren't live are shown as they work in the demo, with no claim that they run today (see each film's note).

## The films

### 1. Inbox and mail: "Mail that files itself" (`?film=inbox`)

**Tell:** Your inbox is a to-do list someone else wrote. Timmy turns it into one you can finish.

**Show:** Every morning, Timmy suggests a label for each new email, and says why. Confirm the sure ones in one click. Open a thread, and the reply is already drafted. Send it, and Timmy tracks it in Waiting until they answer.

**Tell (recap):** Sorted, answered and tracked. An inbox you can finish. *Lockup: Timmy · Try the demo.*

On screen:
- Triage: Timmy's label suggestion and its reason on each new email ("Calendar reply. Matches your rule").
- Accept 4 confident: four emails file at once; the toast says 3 are left for you.
- Dana's "Revised quote for 120 seats?" thread: the drafted reply, its sources and checks.
- Send & track in Waiting: the toast reads "tracking in [02] Waiting until Fri, Nov 20"; the thread waits in 02 Waiting.

Truth note: Demo data; the send is the demo's, nothing leaves the browser.

### 2. Daily brief: "Your morning, already sorted" (`?film=brief`)

**Tell:** Most mornings start with an hour of sorting. With Timmy, it's done before you sit down.

**Show:** At eight, Timmy sorts the night's mail and ranks what needs you today, with the reason for each. Jamie confirmed a time, so book it in one click. Marcus needs a pilot date, so his reply is drafted from your files. Your calendar sits right beside it.

**Tell (recap):** Sorted, ranked and drafted. You just decide. *Lockup: Timmy · Try the demo.*

On screen:
- Daily brief: "Good morning, Taylor", the 8:00 AM morning run, "Timmy sorted 33 emails".
- Needs you today: the ranked list; the camera holds on Marcus's row and its reasons.
- Book 9:15 AM on Jamie's confirmation; the invite toast.
- Review draft on Marcus's row: the reply drafted from the pilot SOW.
- Back to the brief: today's calendar in the right panel.

Truth note: The booking toast says "Invite sent"; in the demo nothing is sent.

### 3. Approvals: "Nothing goes out without you" (`?film=approvals`)

**Tell:** An assistant that acts on its own is a risk. Timmy prepares the work, then waits for you.

**Show:** Emails, price calls, CRM updates and invites all land in one queue. Dana wants a lower price. Timmy shows both options side by side, with the yearly difference. Pick one, and the reply and the quote follow your call. Every decision is logged, with undo.

**Tell (recap):** Timmy prepares. You decide. *Lockup: Timmy · Try the demo.*

On screen:
- The Approvals queue and its filters: emails to send, decisions, CRM updates, calendar invites.
- Give Acme $58 per seat? The side-by-side math: $83,520 vs $89,280 a year, $5,760 difference.
- Keep $62: the toast lists everything it updated (the reply, proposal v4, order form, tracker, CRM hint).
- Decided: the logged decision, then the toast's Undo.

Truth note: Undo is offered from the notice after each decision, as shown.

### 4. Ask Timmy: "Just ask" (`?film=ask`)

**Tell:** Finding what matters means digging through mail, meetings and files. Or you could just ask.

**Show:** Open Ask Timmy from anywhere and say what you need, like plan my day. Timmy reads your mail, calendar and files, and answers with live cards: what's urgent, what's waiting on you, and your meetings. Anything that affects someone else is a button you press.

**Tell (recap):** Ask in plain words. Timmy does the digging. *Lockup: Timmy · Try the demo.*

On screen:
- Ask Timmy opens from the bar at the bottom.
- "Plan my day" is typed and sent; the steps tick (read 16 threads, ranked, checked 5 events, collected 11 items).
- The answer's live cards: the urgent list, today's schedule, and Waiting for your OK with its buttons.

Truth note: The demo's Timmy runs in the browser on the sample data; the live product runs the same requests on the backend.

### 5. Docs: "Docs that write with you" (`?film=docs`)

**Tell:** Notes end up scattered in apps you never open twice. Timmy keeps them in one editor.

**Show:** Type slash to add any block: headings, to-do lists, toggles, tables, or a live table from a sheet. Drag blocks around, nest them with Tab, and give the page an icon and a cover. Then ask Timmy to summarize it, and watch it type with its own cursor.

**Tell (recap):** One editor for every note, and Timmy writes in it too. *Lockup: Timmy · Try the demo.*

On screen:
- The Acme revised-quote page. Add block opens the "/" menu: text, headings, to-do, bullets, toggles, tables.
- A to-do is added ("Send Dana the quote"); the live table linked to the quote tracker sheet.
- The to-do is dragged by its ⋮⋮ handle and nested with Tab.
- A new icon from the emoji picker, then Add cover.
- /summary: Timmy types a summary in with its own named cursor; the toast says Ctrl+Z takes it out.

Truth note: Shown on the demo's sample page; nothing is saved on the film route.

### 6. Drive, sheets and editors: "Files where you'll look for them" (`?film=files`)

**Tell:** Attachments pile up with names like final, final two. Timmy files them where you'll use them.

**Show:** For each attachment, Timmy suggests a folder and a dated name. Check it, and click file it. Folders are numbered, so they always sort the same way. Open a sheet, and the figures are real. Need Word or Excel? The full editors open right here.

**Tell (recap):** Filed once. Found every time. *Lockup: Timmy · Try the demo.*

On screen:
- To file: the folder Timmy suggests (Suggested chip) and the dated name with Year/Quarter/Month/Day.
- File it: "Filed in [02] Work › [01] Management".
- Browse: the numbered folders ([01] Management, [10] Acme, [11] Northwind…).
- [10] Acme › the quote tracker sheet with real figures, then the Full editor.

Truth note: The full editor is the open-source spreadsheet app built into Timmy.

### 7. Tasks and calendar: "Your week on one plan" (`?film=plan`)

**Tell:** Tasks live in one app and meetings in another. Timmy puts them on one plan.

**Show:** Tasks from your email land on the board, with the project, the due date and who it's for. Drag a card to move it along. Capture a thought before it slips. On the calendar, Timmy blocks focus time for the work that's due, and preps you for your next meeting.

**Tell (recap):** Every task on the board, and the time to do it. *Lockup: Timmy · Try the demo.*

On screen:
- Tasks board: "Revise Acme quote to 120 seats" with From email, Acme Renewal, Tomorrow and Dana.
- The card is dragged from To do to In progress (toast).
- Quick capture (Ctrl+J): "Ask Raj if SSO needs its own contract" lands as a task.
- Calendar: the focus block "Focus: Revised Acme quote" and Prep for your next meeting.

Truth note: Ctrl+J is the shortcut on Windows and Linux (⌘J on a Mac).

### 8. Projects and people: "Every deal on one page" (`?film=projects`)

**Tell:** A deal's story is spread across threads, files and your memory. Timmy keeps it on one page.

**Show:** Each project gathers its tasks, mail, files and decisions. See what's due, who owes you what, and the latest numbers. Open a contact, and their next step, deal value and history are right there. Mark the people who matter, and Timmy reminds you to check in.

**Tell (recap):** One page per deal. Every person in context. *Lockup: Timmy · Try the demo.*

On screen:
- [10] Acme Renewal: the Tasks, Mail and Files tabs, then Latest decisions.
- Due soon, Waiting on others, and the Deal block ($74,400, Negotiation).
- Dana Whitfield's contact page: the Relationship card (next step, deal, source, cadence) and her open emails.
- Tracking and the weekly cadence: Timmy's check-in reminder.

Truth note: "Timmy reminds you to check in": the contact's weekly cadence and next check-in date, as shown on the card.

### 9. Find leads: "A lead list in a minute" (`?film=leads`)

**Tell:** A good lead list usually eats a whole afternoon. Tell Timmy who you're looking for instead.

**Show:** Describe the customers you want. Timmy finds matching businesses, scores each one against your offer, and fills in the contact details. The best fits come first, and each lead shows why it fits. Already have a list? Import it, and Timmy scores those too.

**Tell (recap):** Describe your customer. Get a scored list back. *Lockup: Timmy · Try the demo.*

On screen:
- Find leads: "15 dental practices in Austin", then Find and add ("enriched with your data provider… Nothing was sent").
- The Fit column (Excellent 99) and the contact column.
- Best fit first; the first lead's panel: Fit with your offer and its reasons.
- Import CSV: paste rows or choose a file.

Truth note: In the demo the found leads are sample results. The data provider is not named on the film route.

### 10. Campaigns and Unibox: "Outreach that sounds like you" (`?film=outreach`)

**Tell:** Most cold email tools blast templates and hope. Timmy writes every step, and you approve the launch.

**Show:** Pick your leads, and Timmy writes the whole sequence: a first email, a bump, a call, a case study and a break-up. Launch it, and every mailbox stays inside safe daily limits. When people reply, the Unibox gathers every answer in one place, labelled, with your next message ready.

**Tell (recap):** Written by Timmy. Launched by you. *Lockup: Timmy · Try the demo.*

On screen:
- New campaign: Best fits, "Timmy writes it", then Write the sequence.
- The five steps: first email, bump, call, case study, break-up.
- Launch: the confirm card (22 new emails a day, 9–5, first sends today: 8), then the launched toast.
- Unibox: every reply labelled (Interested, Meeting booked, Out of office…); Jamie Ortega's thread and the suggested Confirm today at 9:15 AM.

Truth note: Launch confirms the schedule; in the demo nothing is sent. The sequence includes a call step, so the voice says "a call".

### 11. Speed to lead and calls: "Answer first" (`?film=speed`)

**Tell:** When a lead fills in your form, the first reply has the edge. Timmy puts every new lead on the clock.

**Show:** Connect your website form, Typeform or Facebook lead ads. The moment a lead arrives, the clock starts, and Timmy drafts a first reply with times to meet. Rather call? Your call list puts the most urgent first, with a script ready.

**Tell (recap):** Every lead answered fast. Every call ready. *Lockup: Timmy · Try the demo.*

On screen:
- Speed to lead: the connected forms (website, Typeform; Facebook Lead Ads to connect).
- Simulate a form lead: Aisha Bello arrives and the clock starts at 0:00.
- Reply with times: the first reply, drafted with two times.
- Calls: the call list, Start calling, the script for Alex Kim.

Truth note: "The first reply has the edge" is a general claim, not a measured one. Facebook Lead Ads is shown as not connected yet, which matches the screen.

### 12. Website chat: "A website chat that books calls" (`?film=chat`)

**Tell:** Visitors leave your site with questions nobody answered. Timmy answers them for you.

**Show:** Paste one line of code, then pick a colour, a greeting and the questions Timmy asks. A visitor asks about pricing, and Timmy answers from your help desk, then asks for their email and your questions. Every chat lands here, and you can take over anytime.

**Tell (recap):** Questions answered. Leads captured. Calls booked. *Lockup: Timmy · Try the demo.*

On screen:
- Website chat › Set up: the snippet, the colour (orange), the greeting, the questions Timmy asks.
- In the live preview a visitor asks "How much does it cost?"; Timmy answers from the help desk and asks for their email.
- The visitor gives an email; Timmy thanks them and asks the first question.
- Chats: Priya Nair's conversation, then Take over.

Truth note: The preview bot is rule-based and the chat isn't installed on a live site yet (its backend isn't built). The recap's "Calls booked" matches Leo Martins's booked chat in the list, but no booking is shown in the preview.

### 13. Automations: "Draw it once" (`?film=automations`)

**Tell:** The same follow-ups, every day, by hand. Draw them once instead.

**Show:** Pick a trigger, like a form submitted or a meeting ending. Add the steps: draft a reply, ask me first, update the CRM. Branch with if and else, and fill in names from the trigger. Then test run it, and watch each step tick off on sample data.

**Tell (recap):** Draw the workflow once. Timmy still asks before anything goes out. *Lockup: Timmy · Try the demo.*

On screen:
- "Reply to new leads in 5 minutes": the Form submitted trigger and its settings.
- The steps on the canvas: Draft a reply, Ask me first, Update the CRM.
- If / else: "If budget more than 5000" with Yes and No branches.
- Draft a reply's settings: the {{name}} chips and the filled-in preview.
- Test run: steps tick off on sample data, the branch not taken greys out, and the log says nothing is sent.

Truth note: Automations save their settings but don't run on their own yet (their runner isn't built). The film shows only the canvas and a test run on sample data, which is how the product works today.

### 14. Connections and rules: "Set up in plain English" (`?film=setup`)

**Tell:** Most assistants take weeks to set up. Timmy needs your apps and a few plain sentences.

**Show:** Connect your mail, calendar, Drive and CRM, and each card says what Timmy reads and what it writes. Then teach it in plain English, like anything from Acme legal goes to Follow Up. When you edit a draft, Timmy learns from that too.

**Tell (recap):** Connect your apps. Say how you work. *Lockup: Timmy · Try the demo.*

On screen:
- Connections: Gmail, Google Calendar and Drive connected; the CRM cards. Each card's Reads and Writes.
- Rules & settings › Triage: "Anything from Acme legal goes to Follow Up" typed and added.
- Recent corrections: what Timmy learned from your edits.

Truth note: Connecting is simulated in the demo. The page's mention of the integration layer is hidden on the film route.

## Not covered by these 14

Voice (push-to-talk and dictation), delegate mode and client workspaces for agencies, the phone layout, and Social (coming soon). Each could be its own film in the same format.
