# Timmy

Frontend for **Timmy**: an AI layer over Gmail plus its own workspace (Drive, Docs, Sheets, Slides, Calendar, Tasks, a personal CRM and an AI library), so people get a Google Workspace-style suite without paying Google for it. Timmy sorts your inbox, drafts replies from your files, and keeps track of what you owe and what you're waiting on.

![Daily brief](docs/today.png)

This is the frontend only: everything runs in the browser on sample data, and your changes are saved in the browser (Settings › Reset demo data starts over). Gmail is the only service the product will connect to. The clock is fixed at Monday, Nov 16, 2026, 8:12 AM, so due dates and "late" labels stay consistent.

Live preview: https://web-production-c4bbfc9c.up.railway.app (Railway, redeploys on every push to this branch).

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production build
```

## Layout

The shell follows the wireframe: **left rail · sidebar · tabs + main content · right sidebar · bottom bar**.

| Area | What it holds |
| --- | --- |
| Left rail | Today & mail, Approvals, Search (⌘K), Tasks, Calendar, Docs, Projects, People, Drive, AI library, Timmy's activity, Settings |
| Sidebar | Changes with the section. For mail it shows numbered labels, project folders, Starred (max 5) and `[99] Archived` |
| Tabs | Views inside the current page (e.g. Daily brief / Triage / Drafts) |
| Main content | The page itself |
| Right sidebar | Context for whatever is open: next actions, linked file, CRM record, people, today's calendar |
| Bottom bar | Agent status, last/next triage run, counts, theme toggle |

Below 1280px the right sidebar becomes a drawer. Below 900px the sidebar does too.

## How mail is organized

- **[00] Inbox** — not sorted yet. Timmy suggests a label for each email and you confirm in **Triage**, oldest first.
- **[01] Follow Up** — you owe an action. Two-minute replies are drafted and marked *Quick*; bigger work gets a task and a focus block.
- **[02] Waiting** — someone owes you. A thread stays here until the item arrives. A promise to send it doesn't count.
- **[03] Read Through** — reports and how-to emails you'll consult again.
- **[10]–[13] Projects** — mail filed where you'll use it.
- **[99] Archived** — done, still searchable.

The main flow: Dana asks for a revised quote → Timmy finds proposal v3, makes a v4, creates a task, blocks focus time and drafts a reply → **Send & track in Waiting** moves the thread to Waiting with the approval deadline → Timmy suggests the CRM update.

![Thread with Timmy's draft](docs/thread.png)

Files follow a numbered folder structure (`[02] Work › [10] Acme`, at most 5 levels deep) and dated names (`2026-11-13 Acme — Call notes`, `2026-Q4 QBR — Briefing slides`).

## The morning run, urgency and approvals

- **Morning run:** Timmy sorts new mail, ranks it, drafts replies and lines up decisions at the time you pick (default 8:00 AM on weekdays). Change the time from the daily brief or Settings › Schedule; the status bar shows the next run.
- **Urgency:** every open thread is ranked Urgent, Soon or Can wait, with the reasons shown ("Due today at 5:00 PM · Marcus is a priority contact · Says “today”"). The brief leads with only the urgent ones, or everything open if you prefer. Each signal is a rule in Settings › Urgency, and you can mark any thread urgent or able to wait yourself.
- **Approvals:** one queue for everything that needs your OK: emails to send, decisions on price or hiring, CRM updates and calendar invites. Each decision shows the numbers and what Timmy will do for each choice. Nothing is sent without approval, every choice is logged under Decided, and Undo is on the notice that follows.

## Workflows it supports

Each follows Jeff Su's published system.

| Workflow | Where | What you can do |
| --- | --- | --- |
| 1. Drive folders and filing | Drive | Numbered folders (5 deep, 99 = archive), "Where will you use this?" filing with dated names, leave / shortcut / copy for shared files, star 5 at most, description keywords |
| 2. Gmail | Today & mail | Triage into Follow Up / Waiting / Read Through, 2-minute replies, compose with Track in Waiting, Ask Timmy to draft, send a recap |
| 3. Tasks, quick notes, Calendar | Tasks, Calendar | Quick capture (⌘J), thoughts vs. notes, tasks from emails, weekly review queue, block time, daily highlight |
| 4. Docs and meetings | Docs | Create and name in one step, templates, running 1:1 table, team tracker, linked files, recap email |
| 5. Sheets and Slides | Docs | Named-column formulas, linked tables that refresh in docs, decks from layouts, copy slides to [04] Quick Share |
| 6. Project dashboard | Projects | Project home with tasks, notes, mail, files and AI; New task / New note link themselves; active and archived views |
| 7. Personal CRM | People | Start with 10–20 people, one or two priority contacts, reviews by cadence, contact history |
| 8. Browser and AI | AI library, search | Prompts captured then filed by use case, routines, rules learned from your edits, project sources |
| One workday | Mail → Tasks → Calendar → Sheets → Docs → Projects | Email to Follow Up, task, time block, update the tracker (linked doc refreshes), reply asking for approval, Waiting, approval arrives (demo button), decision recorded in the project's running notes |

## Try it

- **Today:** review the draft, accept triage suggestions, update the CRM from a suggestion
- **Thread:** `F` / `W` / `R` / `E` move the thread, `S` stars it, `A` replies, `D` asks Timmy to draft, `Esc` goes back. Edit the draft, then **Send & track**. On a Waiting thread, **Demo: … replies** simulates the answer. Every move can be undone from the toast.
- **Anywhere:** `C` composes, `⌘J` quick-captures a task or note
- **Search:** `⌘K` or `/`. Operators: `from:dana`, `is:waiting`, `project:acme`, `has:draft`, `has:attachment`
- **Rules:** toggle rules or add one in plain language
- **Appearance:** pick Light, Dark or Match system, and one of three dark palettes (Midnight, Graphite, Espresso) from the bottom bar or Settings › Appearance. The choice is saved in the browser.

## Design checks

The [Impeccable](https://impeccable.style) design skill is installed in `.claude/skills/impeccable`. Run its detector against the dev server or the source:

```bash
npx impeccable detect http://localhost:5173
npx impeccable detect src/
```

Known, intentional findings: em-dashes in file names (they're part of the naming convention) and the left-rail tooltip overlapping the sidebar while hovered.

## Code

```
src/
  data/       types.ts + mock.ts (mail), ws-types.ts + ws-mock.ts (workspace seed)
  state/      store.tsx (reducer, undo, saved in the browser), ws.ts (workspace helpers), theme.tsx,
              urgency.ts (ranking), approvals.ts (the queue), schedule.ts (morning run)
  components/ shell (LeftRail, Sidebar, Frame, RightPanel, BottomBar), Compose, SearchPalette, kit.tsx
  views/      mail screens: TodayView, MailboxView, ThreadView, OtherViews, AppearanceView
  areas/      approvals, tasks, calendar, docs (docs, sheets, slides), projects, people, files (Drive), library
  styles/     tokens.css (light + Midnight/Graphite/Espresso), layout, ui, views, kit, one file per area
```

Workspace data changes through one action: `dispatch(ws([put(...), patch(...), remove(...)], { toast, undo }))`. To connect Gmail later, replace the mail half of `src/data/mock.ts` with API calls; the workspace stays local or moves to Timmy's own storage.
