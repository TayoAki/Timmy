/*
 * Ask Timmy: the chat docked at the bottom of the right panel.
 *
 * Answers come from a local engine over the app's own state (no network in this
 * preview). Anything Timmy proposes to change is a list of store actions behind a
 * button; nothing happens until you press it, the same rule as Approvals.
 *
 * The conversation lives in a tiny external store, saved in this browser.
 */
import { NOW, PEOPLE } from '../data/mock';
import type { Thread } from '../data/types';
import type { Block, WEvent, WFile } from '../data/ws-types';
import { dayDiff, dueInfo, fmtDay, fmtTime, money, plural } from '../lib/format';
import { APPROVAL_KINDS, openApprovals } from './approvals';
import { fmtClock, nextRun, whenLabel } from './schedule';
import { counterpart, ws, type Action, type Route, type State } from './store';
import { URGENCY, openThreads, rankThreads, type UrgencyContext } from './urgency';
import { firstName, midSentence, personName, put, todaysEvents, uid } from './ws';
import { parseDue } from '../lib/when';

/* ───────────── Messages ───────────── */

/** A link to somewhere in the app: "thread:acme-quote", "file:proposal-v4", "approvals", "approvals:decision". */
export interface ChatLink {
  label: string;
  href: string;
  sub?: string;
}

/** A button under a reply. Its actions run only when pressed. */
export interface ChatChoice {
  id: string;
  label: string;
  primary?: boolean;
  /** Turns the proposal down; runs nothing. */
  cancel?: boolean;
  actions: Action[];
  /** Shown once pressed, e.g. "Added the task, due Fri, Nov 20." */
  after: string;
  /** Where to go once it's done. */
  open?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'timmy';
  text: string;
  bullets?: string[];
  links?: ChatLink[];
  choices?: ChatChoice[];
  /** The choice you made; the buttons collapse to its note. */
  chosen?: string;
  /** For your messages: the screen you asked from. */
  context?: string;
  at: number;
}

export type Reply = Omit<ChatMessage, 'id' | 'role' | 'at'>;

/* ───────────── Context: what's open ───────────── */

export interface ChatContext {
  label: string;
  route: Route;
}

export function contextOf(s: State, r: Route): ChatContext | null {
  switch (r.view) {
    case 'thread': {
      const t = s.threads.find((x) => x.id === r.id);
      return t ? { label: t.subject, route: r } : null;
    }
    case 'file': {
      const f = s.ws.files[r.id];
      return f ? { label: f.name, route: r } : null;
    }
    case 'project': {
      const p = s.ws.projects[r.id];
      return p ? { label: p.name, route: r } : null;
    }
    case 'contact': {
      const c = s.ws.contacts[r.id];
      return c ? { label: c.name, route: r } : null;
    }
    case 'approvals':
      return { label: 'Approvals', route: r };
    case 'calendar':
      return { label: 'Calendar', route: r };
    case 'today':
      return { label: 'Daily brief', route: r };
    default:
      return null;
  }
}

/** Starter prompts for the screen you're on. */
export function promptsFor(r: Route | null): string[] {
  switch (r?.view) {
    case 'thread':
      return ['Summarize this thread', 'Draft a reply', 'Remind me to follow up Friday', 'What’s urgent?'];
    case 'approvals':
      return ['What needs my approval?', 'Brief me on the pipeline', 'What’s urgent?'];
    case 'file':
      return ['Summarize this file', 'Find related mail', 'What needs my approval?'];
    case 'calendar':
      return ['What’s on today?', 'Find focus time today', 'Move my morning brief to 7:30'];
    case 'project':
      return ['Summarize this project', 'Remind me to send the recap tomorrow', 'Find focus time today'];
    case 'people':
    case 'contact':
      return ['Who should I check in with?', 'Brief me on the pipeline', 'What’s urgent?'];
    default:
      return ['What’s urgent?', 'What needs my approval?', 'Brief me on the pipeline', 'Find focus time today', 'Research competitor pricing'];
  }
}

/* ───────────── Engine ───────────── */

const HELP = [
  'What’s urgent, and why; what’s late',
  'Who owes you what, and nudges for the late ones (“nudge Kenji”)',
  'A brief on one deal or project (“brief me on Acme”), or prep for a meeting',
  'Finding time (“find 30 min with Priya Thursday”), blocking focus time, moving a meeting',
  'Changing a deal’s stage or value, after you confirm',
  'Writing a reply in your words (“say yes, Thursday works”) or making a draft shorter',
  'Outbound: “how’s my campaign doing”, “who replied”, “any new form leads”, “write a campaign for my best leads”',
  'What needs your approval, with the choices to make',
  'Summarize or draft a reply to the email you have open',
  'A pipeline brief from your deals',
  'Today’s schedule, or a focus block in the next free gap',
  'Changing when the morning run happens',
  'Adding a task: “Remind me to …”',
  'Finding files and mail by keyword',
  'Starting a research doc on a strategy or competitor question',
];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lower = midSentence;
const threadLink = (t: Thread, sub?: string): ChatLink => ({ label: t.subject, href: `thread:${t.id}`, sub });
const day = (d: Date, h = 17, m = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);

export { parseDue };

/** Strips the date words from a task title. */
export const tidyTitle = (s: string) =>
  cap(
    s
      .replace(/\b(by|on|before|due)?\s*(today|tonight|tomorrow|next week|end of (the )?day|(this |next )?(sun|mon|tue|wed|thu|fri|sat)[a-z]*)\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/[\s.,;:!?]+$/, '')
      .trim(),
  );

/** "9", "7:30", "9am", "8.45 pm" → "HH:MM" in 15-minute steps. */
export function parseClock(text: string): string | null {
  const m = text.toLowerCase().match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?=\b|$)/);
  if (!m) return null;
  let h = Number(m[1]);
  let min = m[2] ? Number(m[2]) : 0;
  if (h > 23 || min > 59) return null;
  const pm = m[3]?.startsWith('p');
  const am = m[3]?.startsWith('a');
  if (pm && h < 12) h += 12;
  if (am && h === 12) h = 0;
  min = Math.round(min / 15) * 15;
  if (min === 60) {
    min = 0;
    h = (h + 1) % 24;
  }
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** The first free stretch of at least `mins` minutes today between now and 6 PM. */
export function freeSlot(events: WEvent[], mins = 60): { start: Date; end: Date } | null {
  const end = day(NOW, 18);
  let cursor = new Date(Math.ceil(NOW.getTime() / (15 * 60000)) * 15 * 60000);
  const busy = events.filter((e) => e.end > cursor).sort((a, b) => a.start.getTime() - b.start.getTime());
  for (const e of busy) {
    if (e.start.getTime() - cursor.getTime() >= mins * 60000) break;
    if (e.end > cursor) cursor = e.end;
  }
  const stop = new Date(cursor.getTime() + mins * 60000);
  return stop <= end ? { start: cursor, end: stop } : null;
}

export const words = (q: string) =>
  q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
const STOP = new Set(['the', 'and', 'for', 'about', 'with', 'from', 'find', 'search', 'show', 'where', 'look', 'files', 'file', 'mail', 'email', 'emails', 'related', 'any', 'all', 'this', 'that', 'what', 'whats', 'are', 'there', 'can', 'you', 'please', 'doc', 'docs']);

export function threadText(t: Thread) {
  return `${t.subject} ${t.ask} ${t.participants.map((p) => PEOPLE[p]?.name ?? p).join(' ')} ${t.messages.map((m) => m.body.join(' ')).join(' ')}`.toLowerCase();
}

/** The reply to `text`, asked from the screen in `ctx` (or no screen). */
export function reply(s: State, text: string, ctx: ChatContext | null): Reply {
  const q = text.trim();
  const l = q.toLowerCase();
  const r = ctx?.route;
  const uctx: UrgencyContext = { ws: s.ws, deals: s.deals, rules: s.rules };
  const thread = r?.view === 'thread' ? s.threads.find((x) => x.id === r.id) : undefined;
  const file = r?.view === 'file' ? s.ws.files[r.id] : undefined;
  const project = r?.view === 'project' ? s.ws.projects[r.id] : undefined;

  /* Help */
  if (/^(hi|hello|hey|help|\?|what can you do|how do you work)\b/.test(l)) {
    return {
      text: 'Hi Taylor. I work from your mail, calendar, files and deals. I can help with:',
      bullets: HELP,
    };
  }

  /* Morning run time */
  if (/\b(run|brief|triage|morning)\b/.test(l) && /\b(at|to|for)\s*\d/.test(l)) {
    const time = parseClock(l.slice(l.search(/\b(at|to|for)\s*\d/)));
    if (!time) return { text: 'What time should the morning run happen? Try “Run the brief at 7:30 AM”.' };
    const next = nextRun({ ...s.schedule, time });
    return {
      text: `Move the morning run from ${fmtClock(s.schedule.time)} to ${fmtClock(time)}?${next ? ` The next run would be ${whenLabel(next)}.` : ' No days are selected, so it stays paused.'}`,
      choices: [
        { id: 'yes', label: `Run at ${fmtClock(time)}`, primary: true, actions: [{ type: 'setSchedule', schedule: { time } }], after: `The morning run now happens at ${fmtClock(time)}.` },
        { id: 'no', label: 'Keep it', cancel: true, actions: [], after: `Kept ${fmtClock(s.schedule.time)}.` },
      ],
    };
  }

  /* New task */
  const remind = q.match(/^(?:please\s+)?(?:remind me to|add (?:a )?task(?: to)?:?|create (?:a )?task(?: to)?:?|to-?do:?|task:)\s*(.+)$/i);
  if (remind) {
    const raw = remind[1]!;
    const due = parseDue(raw);
    const title = tidyTitle(raw) || cap(raw);
    const id = uid('task');
    const task = {
      id,
      title,
      status: 'todo' as const,
      priority: 'normal' as const,
      created: NOW,
      due,
      project: project?.id ?? thread?.project ?? file?.project,
      thread: thread?.id,
      contact: thread ? counterpart(thread) : undefined,
    };
    const where = task.project ? s.ws.projects[task.project]?.name : undefined;
    return {
      text: `Add “${title}”${due ? `, due ${fmtDay(due)}` : ''}${where ? ` to ${where}` : ''}${thread ? ', linked to this email' : ''}?`,
      choices: [
        {
          id: 'yes',
          label: 'Add task',
          primary: true,
          actions: [ws([put('tasks', task)], { toast: `Task added: ${title}`, undo: true })],
          after: `Added “${title}”${due ? `, due ${fmtDay(due)}` : ''}.`,
        },
        { id: 'no', label: 'Cancel', cancel: true, actions: [], after: 'No task added.' },
      ],
    };
  }

  /* Approvals */
  if (/(approv|decision|decide|sign[- ]?off|my ok|waiting on me|waiting for me)/.test(l)) {
    const items = openApprovals(s);
    if (!items.length) return { text: 'Nothing is waiting for your approval. New drafts and decisions arrive with the next morning run.' };
    const top = items[0]!;
    const counts = (Object.keys(APPROVAL_KINDS) as (keyof typeof APPROVAL_KINDS)[])
      .map((k) => [k, items.filter((a) => a.kind === k).length] as const)
      .filter(([, n]) => n)
      .map(([k, n]) => `${n} ${n === 1 ? APPROVAL_KINDS[k].label.toLowerCase() : APPROVAL_KINDS[k].plural.toLowerCase()}`);
    return {
      text: `${plural(items.length, 'item')} ${items.length === 1 ? 'needs' : 'need'} your OK: ${counts.join(', ')}. First up: ${top.title}\n${top.why}`,
      links: [
        ...items.slice(0, 4).map((a) => ({ label: a.title, href: a.thread ? `thread:${a.thread}` : `approvals:${a.kind}`, sub: `${APPROVAL_KINDS[a.kind].label} · ${URGENCY[a.urgency.level].label}` })),
        { label: `Open all ${items.length} in Approvals`, href: 'approvals' },
      ],
      choices: top.options.map((o) => ({
        id: o.id,
        label: o.label,
        primary: o.primary,
        actions: [{ type: 'resolve', key: top.key, option: o.id, change: top.change }],
        after: `${o.label}: done. It’s logged under Approvals › Decided.`,
      })),
    };
  }

  /* This thread: summary or draft */
  if (thread && /(draft|write|reply|respond|answer)/.test(l)) {
    if (thread.draft) {
      return {
        text: `There’s already a ${thread.draft.kind === 'nudge' ? 'nudge' : 'reply'} drafted to ${personName(thread.draft.to[0]!)}: “${thread.draft.subject}”. Review it in the thread, or approve it in Approvals.`,
        links: [threadLink(thread, 'Draft ready'), { label: 'Approvals', href: 'approvals:email' }],
      };
    }
    const who = counterpart(thread);
    return {
      text: `Draft a reply to ${personName(who)} about “${lower(thread.ask)}”? It goes into the thread for you to edit; nothing is sent.`,
      choices: [
        { id: 'yes', label: 'Draft it', primary: true, actions: [{ type: 'makeDraft', id: thread.id }], after: 'Drafted. It’s in the thread and waiting in Approvals.' },
        { id: 'no', label: 'Not now', cancel: true, actions: [], after: 'No draft made.' },
      ],
    };
  }
  if (thread && /(summar|tl;?dr|catch me up|what('?s| is) (this|going on|it about)|this (thread|email)|key points)/.test(l)) {
    const u = rankThreads([thread], uctx)[0]!.u;
    const last = thread.messages[thread.messages.length - 1]!;
    const open = thread.steps?.filter((x) => !x.done) ?? [];
    const bullets = [
      `${thread.messages.length} ${thread.messages.length === 1 ? 'message' : 'messages'}; the latest is from ${last.from === 'me' ? 'you' : personName(last.from)}, ${fmtDay(last.at)}.`,
      thread.waiting ? `${personName(thread.waiting.on)} owes you: ${lower(thread.waiting.item)}${thread.waiting.due ? ` (promised ${fmtDay(thread.waiting.due)})` : ', no date promised'}.` : '',
      thread.due ? `Due ${dueInfo(thread.due).label.toLowerCase().startsWith('overdue') ? `${dueInfo(thread.due).label.toLowerCase()}` : fmtDay(thread.due)}.` : '',
      `${URGENCY[u.level].label}${u.reasons.length ? `: ${u.reasons.slice(0, 3).join(', ').toLowerCase()}` : ''}.`,
      open.length ? `Next: ${open.map((x) => lower(x.text)).join('; ')}.` : '',
      thread.draft ? `A ${thread.draft.kind === 'nudge' ? 'nudge' : 'reply'} is drafted and waiting for your approval.` : '',
    ].filter(Boolean);
    return {
      text: `${thread.ask}.${thread.context ? `\n${thread.context}` : ''}`,
      bullets,
      choices: thread.draft
        ? undefined
        : [
            { id: 'draft', label: 'Draft a reply', primary: true, actions: [{ type: 'makeDraft', id: thread.id }], after: 'Drafted. It’s in the thread and waiting in Approvals.' },
            { id: 'no', label: 'Not now', cancel: true, actions: [], after: 'No draft made.' },
          ],
    };
  }

  if (!thread && /\bthis (thread|email|message|conversation)\b/.test(l)) {
    return { text: 'Which email do you mean? Open it and ask again, and keep its name in the box so I read it with your question.' };
  }

  /* Urgent */
  if (/(urgent|priorit|what should i|focus on|first|which emails?|reply to first|needs? me|on fire|emergenc)/.test(l)) {
    const ranked = rankThreads(openThreads(s.threads), uctx);
    const urgent = ranked.filter((x) => x.u.level === 'urgent');
    const soon = ranked.filter((x) => x.u.level === 'soon');
    if (!urgent.length) {
      return {
        text: soon.length ? `Nothing is urgent. ${plural(soon.length, 'thing')} need you this week, starting with:` : 'Nothing is urgent, and nothing needs you this week.',
        links: soon.slice(0, 3).map(({ t, u }) => threadLink(t, u.reasons.slice(0, 2).join(' · '))),
      };
    }
    const undrafted = urgent.filter(({ t }) => !t.draft && t.box !== 'waiting');
    return {
      text: `${plural(urgent.length, 'thing')} ${urgent.length === 1 ? 'is' : 'are'} urgent, most pressing first.${soon.length ? ` ${soon.length} more can wait until later this week.` : ''}`,
      links: urgent.map(({ t, u }) => threadLink(t, u.reasons.slice(0, 2).join(' · '))),
      choices: undrafted.length
        ? [
            {
              id: 'draft',
              label: `Draft ${undrafted.length === 1 ? 'a reply' : `${undrafted.length} replies`}`,
              primary: true,
              actions: undrafted.map(({ t }) => ({ type: 'makeDraft', id: t.id }) as Action),
              after: `Drafted ${plural(undrafted.length, 'reply', 'replies')}. They’re waiting in Approvals.`,
            },
            { id: 'no', label: 'Not now', cancel: true, actions: [], after: 'No drafts made.' },
          ]
        : undefined,
    };
  }

  /* Pipeline */
  if (/(pipeline|deals?\b|crm|forecast|revenue|opportunit|quota)/.test(l)) {
    const deals = Object.values(s.deals);
    const open = deals.filter((d) => d.stage !== 'Closed won');
    const won = deals.filter((d) => d.stage === 'Closed won');
    const total = open.reduce((n, d) => n + d.value, 0);
    const late = open.filter((d) => d.due && d.due < NOW);
    const crm = openApprovals(s).filter((a) => a.kind === 'crm');
    return {
      text: `${plural(open.length, 'open deal')} worth ${money(total)}${won.length ? `, and ${won.map((d) => `${d.company} (${money(d.value)})`).join(', ')} closed` : ''}.${late.length ? ` ${late.map((d) => d.company).join(' and ')} ${late.length === 1 ? 'is' : 'are'} past the date set for the next step.` : ''}`,
      bullets: open
        .sort((a, b) => b.value - a.value)
        .map((d) => {
          const due = d.due ? (d.due < NOW ? `${-dayDiff(d.due)}d late` : `due ${fmtDay(d.due)}`) : 'no date';
          return `${d.company}: ${d.stage}, ${money(d.value)}. Next: ${lower(d.next)} (${d.owner === 'me' ? 'you' : firstName(d.owner)}, ${due}).`;
        }),
      links: [...open.map((d) => ({ label: `${d.company} · ${personName(d.contact)}`, href: `contact:${d.contact}` })), ...crm.map((a) => ({ label: a.title, href: 'approvals:crm', sub: 'CRM update waiting' }))],
      choices: crm[0]
        ? crm[0].options.map((o) => ({
            id: o.id,
            label: o.label === 'Update deal' ? `Update ${crm[0]!.title.match(/(?:Move|Update) (\w+)/)?.[1] ?? 'deal'}` : o.label,
            primary: o.primary,
            actions: [{ type: 'resolve', key: crm[0]!.key, option: o.id, change: crm[0]!.change }],
            after: o.primary ? 'Deal updated. It’s logged under Approvals › Decided.' : 'Left as it is.',
          }))
        : undefined,
    };
  }

  /* Focus time */
  if (/(focus (time|block)|block (some )?time|find (me )?time|deep work|time to work)/.test(l)) {
    const events = todaysEvents(s.ws);
    const slot = freeSlot(events, 60);
    const ranked = rankThreads(openThreads(s.threads), uctx).filter(({ t }) => t.box === 'follow-up');
    const what = thread ?? ranked.find(({ t }) => t.effort === 'focus')?.t ?? ranked[0]?.t;
    if (!slot) return { text: 'There’s no free hour left today before 6 PM. Ask me to find time tomorrow from the Calendar.', links: [{ label: 'Calendar', href: 'calendar' }] };
    const title = `Focus: ${what ? what.ask.replace(/ by .*$/, '') : 'Deep work'}`;
    const ev: WEvent = { id: uid('ev'), title, start: slot.start, end: slot.end, kind: 'focus', with: [], thread: what?.id, note: 'Blocked by Timmy from the chat.' };
    return {
      text: `Your next free hour today is ${fmtTime(slot.start)}–${fmtTime(slot.end)}. Block it for “${title.replace('Focus: ', '')}”?`,
      links: what ? [threadLink(what)] : undefined,
      choices: [
        { id: 'yes', label: `Block ${fmtTime(slot.start)}`, primary: true, actions: [ws([put('events', ev)], { toast: `Blocked ${fmtTime(slot.start)}–${fmtTime(slot.end)} for focus`, undo: true, log: `Blocked ${fmtTime(slot.start)}–${fmtTime(slot.end)} for “${title}”` })], after: `Blocked ${fmtTime(slot.start)}–${fmtTime(slot.end)} on your calendar.`, open: 'calendar' },
        { id: 'no', label: 'No thanks', cancel: true, actions: [], after: 'Calendar left as it is.' },
      ],
    };
  }

  /* Today's schedule */
  if (/(calendar|meeting|agenda|schedule|on today|my day|today)/.test(l)) {
    const events = todaysEvents(s.ws);
    const upcoming = events.filter((e) => e.end > NOW);
    const next = upcoming[0];
    return {
      text: events.length
        ? `${plural(events.length, 'event')} today; ${upcoming.length} still ahead.${next ? ` Next: ${next.title} at ${fmtTime(next.start)}${next.note ? `. ${next.note}` : '.'}` : ''}`
        : 'Nothing on your calendar today.',
      bullets: events.map((e) => `${fmtTime(e.start)}–${fmtTime(e.end)} · ${e.title}${e.with.length ? ` (${e.with.map(firstName).join(', ')})` : ''}${e.end <= NOW ? ' · done' : ''}`),
      links: [...upcoming.filter((e) => e.thread).slice(0, 3).map((e) => ({ label: e.title, href: `thread:${e.thread}`, sub: fmtTime(e.start) })), { label: 'Open the calendar', href: 'calendar' }],
    };
  }

  /* People to check in with */
  if (/(check in|catch up with|follow up with|who should i|relationship|reach out|touch base)/.test(l)) {
    const due = Object.values(s.ws.contacts)
      .filter((c) => c.tracked && c.due)
      .sort((a, b) => a.due!.getTime() - b.due!.getTime())
      .slice(0, 5);
    if (!due.length) return { text: 'Nobody in your CRM is due a check-in.', links: [{ label: 'People', href: 'people' }] };
    return {
      text: `${plural(due.length, 'person', 'people')} to get back to, most overdue first:`,
      links: due.map((c) => ({ label: c.name, href: `contact:${c.id}`, sub: `${c.next ?? 'Check in'} · ${dueInfo(c.due!).label}${c.priority ? ' · priority' : ''}` })),
    };
  }

  /* This project */
  if (project && /(summar|status|where are we|catch me up|overview|late|stuck|this project)/.test(l)) {
    const tasks = Object.values(s.ws.tasks).filter((t) => t.project === project.id && t.status !== 'done');
    const late = tasks.filter((t) => t.due && t.due < NOW);
    const mail = s.threads.filter((t) => t.project === project.id && (t.box === 'follow-up' || t.box === 'waiting'));
    const deal = project.deal ? s.deals[project.deal] : undefined;
    const notes = project.notesDoc ? s.ws.docs[project.notesDoc] : undefined;
    const table = notes?.blocks.find((b): b is Extract<Block, { type: 'table' }> => b.type === 'table');
    const latest = table?.rows[0];
    return {
      text: `${project.name}${project.goal ? `: ${project.goal}` : ''}`,
      bullets: [
        `${plural(tasks.length, 'open task')}${late.length ? `, ${late.length} late` : ''}.`,
        `${mail.filter((t) => t.box === 'follow-up').length} emails you owe, ${mail.filter((t) => t.box === 'waiting').length} you’re waiting on.`,
        deal ? `Deal: ${deal.stage}, ${money(deal.value)}. Next: ${lower(deal.next)}.` : '',
        latest ? `Latest decision (${latest[0]}): ${latest[1]}.` : '',
      ].filter(Boolean),
      links: [
        ...late.slice(0, 3).map((t) => ({ label: t.title, href: `project:${project.id}`, sub: `Late since ${fmtDay(t.due!)}` })),
        ...mail.slice(0, 3).map((t) => threadLink(t, t.box === 'waiting' ? 'Waiting' : 'You owe')),
        ...(project.notesDoc ? [{ label: 'Running notes', href: `file:${project.notesDoc}` }] : []),
      ],
    };
  }

  /* This file */
  if (file && /(summar|outline|what('?s| is) in|overview|tl;?dr)/.test(l)) {
    const doc = s.ws.docs[file.id];
    const sheet = s.ws.sheets[file.id];
    const deck = s.ws.decks[file.id];
    const bullets: string[] = [];
    if (doc) {
      for (const b of doc.blocks) {
        if (b.type === 'h2' || b.type === 'h3') bullets.push(b.text);
        else if (b.type === 'table') bullets.push(`Table: ${b.columns.join(', ')} (${plural(b.rows.length, 'row')})`);
        if (bullets.length >= 6) break;
      }
    } else if (sheet) {
      bullets.push(`${plural(sheet.rows.length, 'row')} in “${sheet.table}”`, `Columns: ${sheet.columns.map((c) => c.name).join(', ')}`);
    } else if (deck) {
      bullets.push(...deck.slides.slice(0, 6).map((x, i) => `Slide ${i + 1}: ${x.title}`));
    }
    return {
      text: bullets.length ? `“${file.name}”, last edited ${fmtDay(file.updated)} by ${file.owner === 'me' ? 'you' : personName(file.owner)}.` : `“${file.name}” is a ${file.kind.toUpperCase()} I can’t read inside yet. Open it to view it.`,
      bullets: bullets.length ? bullets : undefined,
    };
  }

  /* Research and competitors */
  if (/(competit|research|strateg|market|benchmark|position|rival|versus|\bvs\.?\b)/.test(l)) {
    const topic = cap(
      q
        .replace(/^(please\s+)?(can you\s+)?(do|run|start|help me with|research|look into|analy[sz]e|study)\s+/i, '')
        .replace(/[?.!]+$/, '')
        .trim(),
    ) || 'Strategy question';
    const reports = s.threads.filter((t) => t.kind === 'report' || /pricing|benchmark|market/i.test(t.subject));
    const id = uid('doc');
    const name = `${NOW.toISOString().slice(0, 10)} Research — ${topic.length > 60 ? `${topic.slice(0, 57)}…` : topic}`;
    const folder = project?.folder ?? 'f03';
    const f: WFile = { id, name, kind: 'doc', folder, updated: NOW, owner: 'me', createdByTimmy: true, project: project?.id };
    const b = (type: 'h2' | 'p' | 'bullet', text: string): Block => ({ id: uid('b'), type, text });
    const blocks: Block[] = [
      b('h2', 'Question'),
      b('p', topic),
      b('h2', 'What we already know'),
      ...(reports.length
        ? reports.slice(0, 3).map((t) => b('bullet', `${t.subject}: ${t.messages[t.messages.length - 1]!.body.slice(0, 2).join(' ')}`))
        : [b('bullet', 'Nothing in your mail or files yet.')]),
      b('h2', 'Competitors to compare'),
      { id: uid('b'), type: 'table', columns: ['Company', 'Pricing', 'Recent moves', 'Source'], rows: [['', '', '', ''], ['', '', '', '']] },
      b('h2', 'Open questions'),
      { id: uid('b'), type: 'todo', text: 'Which customers have mentioned a competitor this quarter?', checked: false },
      { id: uid('b'), type: 'todo', text: 'Where do we win and lose on price?', checked: false },
      b('h2', 'Sources'),
      b('p', 'Add links and files as you go. Timmy cites them in drafts.'),
    ];
    return {
      text: `Web research and competitor tracking aren’t connected in this preview, so I can’t pull outside sources yet. ${reports.length ? `Your mail has ${plural(reports.length, 'related report')} I can start from.` : ''} Want a research doc with an outline to fill in?`,
      links: reports.slice(0, 2).map((t) => threadLink(t, 'From your Read Through')),
      choices: [
        {
          id: 'yes',
          label: 'Start the doc',
          primary: true,
          actions: [ws([put('files', f), put('docs', { id, template: 'blank', blocks })], { toast: `Created “${name}”`, undo: true, log: `Created the doc “${name}”` })],
          after: `Created “${name}”.`,
          open: `file:${id}`,
        },
        { id: 'no', label: 'Not now', cancel: true, actions: [], after: 'No doc created.' },
      ],
    };
  }

  /* Find files and mail */
  const find = l.match(/^(?:find|search(?: for)?|where(?:'?s| is| are)|look for|show me|open)\s+(.+)$/) ?? (/related (mail|email|files?)/.test(l) ? [l, ''] : null);
  if (find) {
    let terms = words(find[1] ?? '');
    if (!terms.length && file) terms = words(file.name.replace(/^\d{4}(-Q\d|-\d{2}(-\d{2})?)?\s*/, '').split('—')[0] ?? '');
    if (!terms.length && project) terms = words(project.name);
    if (!terms.length) return { text: 'What should I look for? Try “Find the Acme proposal” or “Find mail from Marcus”.' };
    const fileHits = Object.values(s.ws.files)
      .filter((f) => !f.shortcutOf)
      .map((f) => ({ f, n: terms.filter((w) => `${f.name} ${f.description ?? ''}`.toLowerCase().includes(w)).length }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n || b.f.updated.getTime() - a.f.updated.getTime())
      .slice(0, 4);
    const mailHits = s.threads
      .map((t) => ({ t, n: terms.filter((w) => threadText(t).includes(w)).length }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 4);
    if (!fileHits.length && !mailHits.length) return { text: `I couldn’t find anything for “${terms.join(' ')}”. Try a person’s name or a project.` };
    return {
      text: `${fileHits.length ? plural(fileHits.length, 'file') : 'No files'} and ${mailHits.length ? plural(mailHits.length, 'email thread') : 'no mail'} match “${terms.join(' ')}”.`,
      links: [
        ...fileHits.map(({ f }) => ({ label: f.name, href: `file:${f.id}`, sub: `${f.kind === 'pdf' ? 'PDF' : cap(f.kind)} · edited ${fmtDay(f.updated)}` })),
        ...mailHits.map(({ t }) => threadLink(t, `${personName(counterpart(t))} · ${t.box === 'archived' ? 'Archived' : cap(t.box.replace('-', ' '))}`)),
      ],
    };
  }

  /* Fallback */
  return {
    text: `I’m not sure how to help with “${q.length > 80 ? `${q.slice(0, 77)}…` : q}” yet. In this preview I can do:`,
    bullets: HELP,
  };
}

/** Where a chat link goes. */
export function routeForHref(href: string): Route | null {
  const [kind, id] = href.split(':') as [string, string | undefined];
  if (kind === 'approvals') return { view: 'approvals', tab: 'open', filter: (id as never) || undefined };
  return null;
}
