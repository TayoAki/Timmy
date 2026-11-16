/*
 * The everyday asks Timmy's testers typed that the first version missed: who
 * owes me, nudge someone, what's late, brief me on one deal, prep a meeting,
 * find time, move a meeting, change a deal, a named day's calendar, and "make
 * it shorter / say yes Thursday" on the email you have open.
 *
 * Each handler returns a Plan or null. Anything that changes something for
 * others (an invite, a moved meeting, a deal) is a choice you press; drafts are
 * the only work done straight away. When Timmy can't do something, it says so
 * plainly instead of answering a different question.
 */
import { NOW, PEOPLE } from '../data/mock';
import type { Deal, Thread } from '../data/types';
import type { Project, WEvent } from '../data/ws-types';
import { dayDiff, dueInfo, fmtDay, fmtTime, money, plural } from '../lib/format';
import { atHour, parseDue, weekdayWord } from '../lib/when';
import type { ChatChoice, ChatLink } from '../state/assistant';
import { draftFor, readInstruction, shorter } from '../state/drafting';
import { scopedApprovals, scopedThreads } from '../state/scope';
import { counterpart, ws, type Action, type State } from '../state/store';
import { eventsOn, firstName, isoDay, midSentence, patch, personName, put, uid } from '../state/ws';
import type { Plan, WidgetCall } from './plan';
import type { Campaign } from '../data/outbound-types';
import { fitOf, liveNow, pct, project, statsOf, writeSequence } from '../lib/outbound';
import { coldToday, ctxOf } from '../state/outbound';
import { callLead, callList, findLead, findNewLeads, logCallNotes, textLead } from './outboundIntents';

/* ───────────── Reading the request ───────────── */

/** A person named in the request ("nudge Kenji", "my 1:1 with Priya"). */
export function personIn(l: string): string | undefined {
  for (const [id, p] of Object.entries(PEOPLE)) {
    if (id === 'me' || p.bot) continue;
    const first = p.name.split(' ')[0]!.toLowerCase();
    if (first.length > 2 && new RegExp(`\\b${first}\\b`).test(l)) return id;
  }
  return undefined;
}

/** A deal named by its company ("the Acme deal", "Brightwave"). */
const dealIn = (s: State, l: string): Deal | undefined =>
  Object.values(s.deals).find((d) => new RegExp(`\\b${d.company.split(' ')[0]!.toLowerCase()}\\b`).test(l));

/** A project named by its name or first word ("Acme Renewal", "hiring"). */
const projectIn = (s: State, l: string): Project | undefined =>
  Object.values(s.ws.projects)
    .filter((p) => p.status === 'active')
    .find((p) => l.includes(p.name.toLowerCase()) || (p.name.split(' ')[0]!.length > 3 && new RegExp(`\\b${p.name.split(' ')[0]!.toLowerCase()}\\b`).test(l)));

/** "30 min", "90 minutes", "2 hours", "an hour", "half an hour". */
function minutesIn(l: string): number | undefined {
  if (/half an hour|\b30\s*-?\s*min/.test(l)) return 30;
  const h = l.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/);
  if (h) return Math.round(parseFloat(h[1]!) * 60);
  const m = l.match(/(\d+)\s*(?:m|min|mins|minute|minutes)\b/);
  if (m) return Number(m[1]);
  if (/\b(an|one) hour\b/.test(l)) return 60;
  if (/\btwo hours\b/.test(l)) return 120;
  return undefined;
}

/** The day asked about: "tomorrow", "Thursday", "today" (the default). */
const dayIn = (l: string): Date => {
  const d = parseDue(l);
  return d ? atHour(d, 0) : atHour(NOW, 0);
};

/** Morning, afternoon or the working day. */
const partIn = (l: string): [number, number] => (/\bmorning\b/.test(l) ? [9, 12] : /\bafternoon\b/.test(l) ? [12, 18] : /\bevening\b/.test(l) ? [17, 19] : [9, 18]);

/** "3pm", "3:30 pm", "at 10" → hours and minutes. */
const clockIn = (l: string): [number, number] | undefined => {
  const m = l.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ?? l.match(/\bat (\d{1,2})(?::(\d{2}))?\b/);
  if (!m) return undefined;
  let h = Number(m[1]);
  if (m[3] === 'pm' && h < 12) h += 12;
  if (!m[3] && h < 8) h += 12;
  return [h, m[2] ? Number(m[2]) : 0];
};

/** The first free stretch of `mins` on a day, inside working hours (or the part of day asked for). */
function slotOn(s: State, day: Date, mins: number, part: [number, number] = [9, 18]): { start: Date; end: Date } | null {
  let cursor = atHour(day, part[0]);
  const end = atHour(day, part[1]);
  if (dayDiff(day) === 0 && NOW > cursor) cursor = new Date(Math.ceil(NOW.getTime() / 9e5) * 9e5);
  const busy = eventsOn(s.ws, day)
    .filter((e) => e.end > cursor)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  for (const e of busy) {
    if (e.start.getTime() - cursor.getTime() >= mins * 60000) break;
    if (e.end > cursor) cursor = e.end;
  }
  const stop = new Date(cursor.getTime() + mins * 60000);
  return stop <= end ? { start: cursor, end: stop } : null;
}

const words = (x: string) => new Set(x.toLowerCase().match(/[a-z0-9:]{3,}/g) ?? []);

/** The meeting the request is about: by time, person or title words; soonest first. */
function eventIn(s: State, l: string): WEvent | undefined {
  const who = personIn(l);
  const clock = clockIn(l);
  const day = parseDue(l);
  const asked = words(l);
  const scored = Object.values(s.ws.events)
    .filter((e) => e.end > NOW && e.kind !== 'personal')
    .map((e) => {
      let score = 0;
      if (who && e.with.includes(who)) score += 3;
      if (clock && e.start.getHours() === clock[0] && e.start.getMinutes() === clock[1] && (!day || dayDiff(e.start) === dayDiff(day))) score += 4;
      if (/\b1:1\b|one[- ]on[- ]one/.test(l) && /1:1/.test(e.title)) score += 2;
      score += [...words(e.title)].filter((w) => asked.has(w) && w !== 'with').length * 2;
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.e.start.getTime() - b.e.start.getTime());
  return scored[0]?.e;
}

const when = (d: Date) => `${weekdayWord(d) === 'today' || weekdayWord(d) === 'tomorrow' ? weekdayWord(d) : fmtDay(d)} ${fmtTime(d)}`;
const span = (a: Date, b: Date) => `${fmtDay(a)}, ${fmtTime(a)}–${fmtTime(b)}`;
const threadLink = (t: Thread, sub?: string): ChatLink => ({ label: t.subject, href: `thread:${t.id}`, sub });
const answer = (args: { bullets?: string[]; links?: ChatLink[]; choices?: ChatChoice[]; preview?: string }): WidgetCall => ({
  name: 'show_answer',
  args: { bullets: args.bullets ?? [], links: args.links ?? [], choices: args.choices ?? [], preview: args.preview },
});
const no = (after: string): ChatChoice => ({ id: 'no', label: 'Not now', cancel: true, actions: [], after });

const lateBy = (d: Date) => {
  const n = -dayDiff(d);
  return n <= 0 ? `due ${fmtDay(d)}` : `${plural(n, 'day')} late`;
};

/* ───────────── Handlers ───────────── */

/** Social posts and other apps aren't connected; say so and offer what does work. */
function cantReach(_s: State, l: string): Plan | null {
  const social = l.match(/\b(instagram|facebook|linkedin|twitter|tiktok|tweet|social media|slack|whatsapp)\b/);
  if (!social) return null;
  if (social[1] === 'slack')
    return { steps: ['Checked what Timmy is connected to'], text: 'Timmy posts new form leads to your Slack channel (Outbound › Speed to lead), but it can’t send other Slack messages from the chat yet. I can draft an email instead.', calls: [] };
  const what = social[1] === 'tweet' ? 'post to Twitter' : `use ${social[1]![0]!.toUpperCase()}${social[1]!.slice(1)}`;
  return {
    steps: ['Checked what Timmy is connected to'],
    text: `I can’t ${what} yet; social posting is coming soon. Timmy can email anyone, and text or call leads who agreed to it in Outbound. Tell me who and what to say.`,
    calls: [],
  };
}

/** "Any angry customers?", "who didn't show up?": no tone or attendance data, so say so and show what is urgent. */
function cantSense(_s: State, l: string): Plan | null {
  if (!/\b(angry|upset|furious|complain\w*|unhappy|frustrated|no[- ]?shows?|didn'?t show|did not show)\b/.test(l)) return null;
  const noshow = /show/.test(l);
  return {
    steps: ['Checked what Timmy can read'],
    text: noshow
      ? 'I can’t see who missed a meeting or a job: attendance isn’t connected. Here’s what Timmy ranks as urgent right now instead:'
      : 'I don’t judge tone yet, so I can’t pick out angry customers. Urgent mail does rise to the top: anything that says “today”, comes from a priority contact or has a deal on the line. Here it is:',
    calls: [{ name: 'show_urgent', args: { limit: 5 } }],
  };
}

/** "What did Timmy do overnight?" */
function overnight(s: State, l: string): Plan | null {
  if (!/(what did (you|timmy) do|overnight|while i was (away|out|asleep)|since (last night|this morning)|what have you done|your activity|activity log)/.test(l)) return null;
  const today = s.activity.filter((a) => dayDiff(a.at) === 0 && a.at <= NOW).sort((a, b) => a.at.getTime() - b.at.getTime());
  return {
    steps: ['Read Timmy’s activity log'],
    text: today.length ? `Since the morning run, Timmy did ${plural(today.length, 'thing')}. Each one can be undone for 7 days from the activity log.` : 'Timmy hasn’t done anything yet today.',
    calls: [answer({ bullets: today.slice(0, 12).map((a) => `${fmtTime(a.at)} · ${a.text}`), links: [{ label: 'Open Timmy’s activity', href: 'activity' }] })],
  };
}

/** With an email open: "make it shorter", or "say yes, Thursday works" / "tell him I'll do the intro this week". */
function editOpenDraft(_s: State, l: string, text: string, thread?: Thread): Plan | null {
  if (!thread) return null;
  if (/\b(shorter|shorten|trim|tighten|more concise|too long|cut it down)\b/.test(l) && !/\b(say|tell|yes|no)\b/.test(l)) {
    if (!thread.draft) return { steps: ['Looked for a draft on this email'], text: 'There’s no draft on this email yet. Ask me to draft a reply first.', calls: [] };
    const short = shorter(thread.draft.body);
    if (!short) return { steps: ['Read the draft'], text: 'The draft is already about as short as it can be without losing the ask.', calls: [{ name: 'show_thread', args: { id: thread.id } }] };
    return {
      steps: ['Read the draft', 'Kept the ask, the numbers and the sign-off'],
      text: `Here’s a shorter version: ${thread.draft.body.length - short.length} characters lighter. Use it, and it replaces the draft. Nothing is sent.`,
      calls: [
        answer({
          preview: short,
          choices: [
            { id: 'yes', label: 'Use the shorter version', primary: true, actions: [{ type: 'updateDraft', id: thread.id, body: short }], after: 'Draft shortened. Review it on the email and send when it’s right.' },
            no('Kept the draft as it was.'),
          ],
        }),
      ],
    };
  }
  const asks = /^(please\s+)?(draft|write|reply|respond|answer|tell|let (him|her|them)|say|yes|yeah|sure|no\b|decline|make it)/.test(l);
  if (!asks) return null;
  const said = readInstruction(text);
  if (!said.said) return null;
  const draft = draftFor(thread, text);
  return {
    steps: [`Read ${plural(thread.messages.length, 'message')}`, 'Wrote the reply in your words'],
    text: `Here’s the reply to ${firstName(draft.to[0]!)}.${thread.draft ? ' Using it replaces the current draft.' : ''} Nothing is sent until you press Send.`,
    calls: [
      answer({
        preview: `To ${personName(draft.to[0]!)} · ${draft.subject}\n\n${draft.body}`,
        choices: [
          { id: 'yes', label: thread.draft ? 'Replace the draft' : 'Use this draft', primary: true, actions: [{ type: 'makeDraft', id: thread.id, note: text }], after: 'Drafted. It’s on the email and waiting in Approvals.', open: `thread:${thread.id}` },
          no('No draft made.'),
        ],
      }),
    ],
  };
}

/** "Who owes me?", "what am I waiting on?", "nudge the late ones". */
function owedToMe(s: State, l: string): Plan | null {
  if (!/(owes? me|owed to me|what am i waiting|waiting on (anyone|someone|people|others|them)|who('s| is) (late|holding)|outstanding (items|asks)|chase|nudge (the late|everyone|them|all|people))/.test(l)) return null;
  const waiting = scopedThreads(s, s.threads.filter((t) => t.box === 'waiting' && t.waiting)).sort(
    (a, b) => (a.waiting!.due?.getTime() ?? Infinity) - (b.waiting!.due?.getTime() ?? Infinity),
  );
  if (!waiting.length) return { steps: ['Checked [02] Waiting'], text: 'Nobody owes you anything right now.', calls: [] };
  const late = waiting.filter((t) => (t.waiting!.due && t.waiting!.due < NOW) || (!t.waiting!.due && -dayDiff(t.waiting!.since) >= 5));
  const nudge = /\b(nudge|chase|follow up|ping|remind them)\b/.test(l);
  const toDraft = nudge ? late.filter((t) => !t.draft) : [];
  const names = late.map((t) => firstName(t.waiting!.on));
  const ready = late.filter((t) => t.draft).map((t) => firstName(t.waiting!.on));
  const drafted = toDraft.map((t) => firstName(t.waiting!.on));
  const and = (xs: string[]) => xs.join(' and ');
  return {
    steps: [`Read ${plural(waiting.length, 'thread')} in [02] Waiting`, 'Checked each promised date', ...(toDraft.length ? [`Drafted ${plural(toDraft.length, 'nudge')}`] : [])],
    text:
      `${plural(waiting.length, 'person', 'people')} owe${waiting.length === 1 ? 's' : ''} you something.` +
      (late.length ? ` ${names.join(' and ')} ${late.length === 1 ? 'is' : 'are'} late.` : ' Nobody is late.') +
      (nudge
        ? (drafted.length ? ` I drafted ${drafted.length === 1 ? 'a nudge' : 'nudges'} to ${and(drafted)}.` : '') +
          (ready.length ? ` ${and(ready)} already ${ready.length === 1 ? 'has' : 'have'} one waiting.` : '') +
          (late.length ? ' Nothing is sent until you approve.' : '')
        : late.length
          ? ' Want nudges? Press Draft nudge on a row, or ask “nudge the late ones”.'
          : ''),
    effects: toDraft.map((t): Action => ({ type: 'makeDraft', id: t.id })),
    calls: [{ name: 'show_waiting', args: {} }],
  };
}

/** Whether what you asked about is the thing they owe ("scorecard" vs "mockups for the onboarding flow"). */
const topicMatches = (topic: string, item: string) => {
  const want = [...words(topic)].filter((w) => !['the', 'his', 'her', 'their', 'and', 'for', 'about'].includes(w));
  const have = words(item);
  return want.length === 0 || want.some((w) => have.has(w) || [...have].some((h) => h.startsWith(w.slice(0, 5)) && w.length > 4));
};

/** "Nudge Kenji", "chase Hannah about the redlines". */
function nudgePerson(s: State, l: string): Plan | null {
  const m = l.match(/\b(nudge|chase|ping|follow up with|follow-up with|remind)\s+(\w+)/);
  if (!m || /^(me|them|the|everyone|all|people|him|her|those|late|up)$/.test(m[2]!)) return null;
  const who = personIn(m[2]!) ?? personIn(l);
  if (!who) return { steps: ['Looked for that person'], text: `I don’t know anyone called “${m[2]}”. Try their first name as it appears in your mail.`, calls: [] };
  const t = s.threads.find((x) => x.box === 'waiting' && x.waiting?.on === who);
  // What you asked about: "remind Kenji to submit his scorecard", "chase Hannah about the redlines".
  const topic = l.match(/\b(?:about|to (?:send|submit|share|finish|file|do|add|get)|for)\s+(?:his |her |their |the |my |our )?(.+?)(?:\s+by\b.*)?[?.!]*$/)?.[1]?.trim();
  const unrelated = t && topic && !topicMatches(topic, t.waiting!.item);
  if (t && unrelated) {
    const what = topic!.replace(/^(a|an)\s+/, '');
    return {
      steps: ['Checked [02] Waiting', `${firstName(who)} owes you the ${midSentence(t.waiting!.item)}, not the ${what}`],
      text: `${firstName(who)} isn’t on the hook for the ${what} in Waiting; what they owe you is the ${midSentence(t.waiting!.item)}. Want a new email about the ${what} instead?`,
      calls: [
        answer({
          choices: [
            { id: 'yes', label: `Write to ${firstName(who)} about the ${what}`, primary: true, actions: [{ type: 'compose', draft: { to: [who], subject: `Your ${what}?`, body: `Hi ${firstName(who)},\n\nQuick reminder about your ${what}. Could you send it over when you can?\n\nThanks,\nTaylor` } }], after: 'Your email is open. Nothing is sent until you press Send.' },
            { id: 'nudge', label: `Nudge about the ${midSentence(t.waiting!.item)}`, actions: t.draft ? [] : [{ type: 'makeDraft', id: t.id }], after: 'The nudge is on the email.', open: `thread:${t.id}` },
            no('Nothing sent.'),
          ],
        }),
      ],
    };
  }
  if (!t) {
    return {
      steps: ['Checked [02] Waiting'],
      text: `${firstName(who)} doesn’t owe you anything right now. Want to email them anyway?`,
      calls: [answer({ choices: [{ id: 'yes', label: `Write to ${firstName(who)}`, primary: true, actions: [{ type: 'compose', draft: { to: [who], subject: '', body: `Hi ${firstName(who)},\n\n\n\nBest,\nTaylor` } }], after: 'Your email is open. Nothing is sent until you press Send.' }, no('No email started.')] })],
    };
  }
  return {
    steps: [`Found what ${firstName(who)} owes you`, t.draft ? 'Found the nudge Timmy drafted this morning' : 'Drafted a nudge'],
    text: `${firstName(who)} owes you the ${midSentence(t.waiting!.item)}${t.waiting!.due ? `, ${lateBy(t.waiting!.due)}` : ''}. ${t.draft ? 'There’s a nudge ready.' : 'Here’s a nudge.'} Review it and send when it’s right.`,
    effects: t.draft ? [] : [{ type: 'makeDraft', id: t.id }],
    calls: [{ name: 'show_thread', args: { id: t.id } }],
  };
}

/** "What's late?", "which deals are late?", "what's at risk this quarter?" */
function late(s: State, l: string): Plan | null {
  if (!/\b(late|overdue|behind|slipping|slipped|at risk|risky|stalled|past due)\b/.test(l) || /\blater\b/.test(l)) return null;
  const dealsOnly = /\b(deal|deals|pipeline|quarter|forecast|revenue)\b/.test(l);
  const deals = Object.values(s.deals).filter((d) => d.stage !== 'Closed won' && d.stage !== 'Closed lost');
  const dealRisk = deals
    .map((d) => {
      const why: string[] = [];
      if (d.due && d.due < NOW) why.push(`next step ${lateBy(d.due)}`);
      if (d.owner !== 'me' && d.due && d.due < NOW) why.push(`waiting on ${firstName(d.owner)}`);
      if (/at risk|risk|quarter/.test(l) && d.stage === 'Negotiation') why.push('still in negotiation');
      return { d, why };
    })
    .filter((x) => x.why.length);
  const waits = scopedThreads(s, s.threads.filter((t) => t.box === 'waiting' && t.waiting?.due && t.waiting.due < NOW));
  const silent = scopedThreads(s, s.threads.filter((t) => t.box === 'waiting' && t.waiting && !t.waiting.due && -dayDiff(t.waiting.since) >= 5));
  const mine = scopedThreads(s, s.threads.filter((t) => t.box === 'follow-up' && t.due && t.due < NOW));
  const tasks = Object.values(s.ws.tasks).filter((t) => t.status !== 'done' && t.due && t.due < NOW && (!s.scope || t.project === s.scope));
  const bullets = dealsOnly
    ? dealRisk.map(({ d, why }) => `${d.company} (${d.stage}, ${money(d.value)}): ${why.join(', ')}. Next: ${midSentence(d.next)}.`)
    : [
        ...waits.map((t) => `${firstName(t.waiting!.on)} owes you the ${midSentence(t.waiting!.item)}, ${lateBy(t.waiting!.due!)}.`),
        ...silent.map((t) => `${firstName(t.waiting!.on)} hasn’t answered about the ${midSentence(t.waiting!.item)} in ${plural(-dayDiff(t.waiting!.since), 'day')}.`),
        ...mine.map((t) => `You owe: ${midSentence(t.ask)}.`),
        ...tasks.map((t) => `Task: ${t.title}, ${lateBy(t.due!)}.`),
        ...dealRisk.map(({ d, why }) => `${d.company}: ${why.join(', ')}.`),
      ];
  const n = bullets.length;
  const summary = dealsOnly
    ? n
      ? `${plural(n, 'deal')} ${n === 1 ? 'needs' : 'need'} attention.`
      : 'No open deal is past its next-step date.'
    : n
      ? `${plural(n, 'thing')} ${n === 1 ? 'is' : 'are'} late.`
      : 'Nothing is late.';
  const links: ChatLink[] = dealsOnly
    ? dealRisk.map(({ d }) => ({ label: `${d.company} · ${personName(d.contact)}`, href: `contact:${d.contact}` }))
    : [...waits.map((t) => threadLink(t, 'Waiting · late')), ...silent.map((t) => threadLink(t, 'Waiting · no reply')), ...mine.map((t) => threadLink(t, 'You owe · late'))].slice(0, 5);
  return {
    steps: [dealsOnly ? `Checked ${plural(deals.length, 'open deal')} against their dates` : 'Checked Waiting, your follow-ups, tasks and deals against their dates'],
    text: summary + ([...waits, ...silent].some((t) => !t.draft) && !dealsOnly ? ' Ask “nudge the late ones” and I’ll draft the nudges.' : ''),
    calls: n ? [answer({ bullets, links })] : [],
  };
}

/** "Update the Brightwave deal value to $40,000", "move Northwind to closed won". */
const STAGES = ['Closed won', 'Closed lost', 'Negotiation', 'Proposal sent', 'Contracting', 'Contract sent', 'Discovery'];
function editDeal(s: State, l: string): Plan | null {
  const verb = /\b(update|change|set|move|mark|make)\b/.test(l);
  const stage = STAGES.find((x) => l.includes(x.toLowerCase()));
  const money$ = l.match(/\$\s?([\d,]+(?:\.\d+)?)\s*(k)?\b/);
  if (!verb || (!stage && !money$ && !/\b(deal|value|amount|stage)\b/.test(l))) return null;
  const deal = dealIn(s, l);
  if (!deal) {
    if (!stage && !money$) return null;
    return { steps: ['Looked for the deal'], text: `Which deal? Your open deals are ${Object.values(s.deals).map((d) => d.company).join(', ')}.`, calls: [] };
  }
  const value = money$ ? Math.round(parseFloat(money$[1]!.replace(/,/g, '')) * (money$[2] ? 1000 : 1)) : undefined;
  if (!stage && value === undefined) {
    return { steps: [`Read the ${deal.company} deal`], text: `What should change on ${deal.company}? It’s ${deal.stage} at ${money(deal.value)}. Try “set ${deal.company.split(' ')[0]} to $40,000” or “move it to Closed won”.`, calls: [] };
  }
  const parts = [stage && stage !== deal.stage ? `${deal.stage} → ${stage}` : '', value !== undefined && value !== deal.value ? `${money(deal.value)} → ${money(value)}` : ''].filter(Boolean);
  if (!parts.length) return { steps: [`Read the ${deal.company} deal`], text: `${deal.company} is already ${deal.stage} at ${money(deal.value)}.`, calls: [] };
  return {
    steps: [`Read the ${deal.company} deal`, 'Prepared the change for your OK'],
    text: `Update ${deal.company}: ${parts.join(', ')}? Nothing changes until you press Update.`,
    calls: [
      answer({
        choices: [
          { id: 'yes', label: `Update ${deal.company.split(' ')[0]}`, primary: true, actions: [{ type: 'editDeal', id: deal.id, stage, value }], after: `${deal.company} updated. It’s logged under Approvals › Decided.` },
          no(`${deal.company} left as it is.`),
        ],
        links: [{ label: `${deal.company} · ${personName(deal.contact)}`, href: `contact:${deal.contact}` }],
      }),
    ],
  };
}

/** "Move my 1:1 with Priya to tomorrow afternoon". */
function reschedule(s: State, l: string): Plan | null {
  if (!/\b(move|reschedule|push|shift|bump)\b/.test(l) || /\b(run|brief|triage|deal|closed|stage|\$)\b/.test(l)) return null;
  const e = eventIn(s, l.replace(/\bto (tomorrow|today|next week|\w+day)\b.*$/, ''));
  if (!e) return { steps: ['Looked through your calendar'], text: 'I couldn’t find that meeting on your calendar. Try its name or who it’s with, like “move my 1:1 with Priya to tomorrow”.', calls: [] };
  const target = l.match(/\bto (.+)$/)?.[1] ?? '';
  const day = parseDue(target) ? atHour(parseDue(target)!, 0) : atHour(e.start, 0);
  const mins = Math.round((e.end.getTime() - e.start.getTime()) / 60000);
  const clock = clockIn(target);
  let slot: { start: Date; end: Date } | null;
  if (clock) {
    const start = atHour(day, clock[0], clock[1]);
    slot = { start, end: new Date(start.getTime() + mins * 60000) };
  } else slot = slotOn({ ...s, ws: { ...s.ws, events: Object.fromEntries(Object.entries(s.ws.events).filter(([id]) => id !== e.id)) } }, day, mins, partIn(target));
  if (!slot) return { steps: [`Checked ${weekdayWord(day)}’s calendar`], text: `There’s no free ${mins}-minute slot ${weekdayWord(day)}${/afternoon|morning/.test(target) ? ` ${partIn(target)[0] < 12 ? 'morning' : 'afternoon'}` : ''}. Try another day.`, calls: [] };
  const people = e.with.map(firstName);
  const label = `Move to ${when(slot.start)}`;
  return {
    steps: ['Found the meeting', `Checked ${weekdayWord(day)}’s calendar for a free ${mins} minutes`],
    text: `Move “${e.title}” from ${when(e.start)} to ${when(slot.start)}?${people.length ? ` ${people.join(' and ')} ${people.length === 1 ? 'gets' : 'get'} the updated invite.` : ''}`,
    calls: [
      answer({
        choices: [
          {
            id: 'yes',
            label,
            primary: true,
            actions: [ws([patch('events', e.id, { start: slot.start, end: slot.end })], { toast: `Moved “${e.title}” to ${when(slot.start)}`, undo: true, log: `Moved “${e.title}” to ${span(slot.start, slot.end)}${people.length ? `; updated the invite for ${people.join(', ')}` : ''}` })],
            after: `Moved to ${when(slot.start)}.`,
            open: 'calendar',
          },
          no('Left the meeting where it was.'),
        ],
      }),
      { name: 'show_day', args: { date: isoDay(day) } },
    ],
  };
}

/** "Find me 30 min with Priya", "block 90 minutes tomorrow for the Q1 campaign brief", "block 2 hours Wed for the board deck". */
function findTime(s: State, l: string, thread?: Thread): Plan | null {
  if (!/(find (me )?(some )?(time|\d|an? (hour|half)|a slot)|block|focus (time|block)|deep work|book (time|a slot)|set up (a )?(meeting|call)|schedule (time|a (meeting|call)|\d)|time with)/.test(l)) return null;
  const mins = minutesIn(l) ?? 60;
  const day = dayIn(l);
  const part = partIn(l);
  const who = personIn(l.replace(/\bfor\b.*$/, '')) ?? (/\bwith\b/.test(l) ? personIn(l) : undefined);
  const slot = slotOn(s, day, mins, part);
  if (!slot) {
    const next = slotOn(s, atHour(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1), 0), mins);
    return {
      steps: [`Checked ${weekdayWord(day)}’s calendar`],
      text: `${weekdayWord(day) === 'today' ? 'Today has' : `${weekdayWord(day)[0]!.toUpperCase()}${weekdayWord(day).slice(1)} has`} no free ${mins} minutes${part[0] !== 9 || part[1] !== 18 ? ' in that part of the day' : ''}.${next ? ` The next opening is ${span(next.start, next.end)}. Ask for that day and I’ll hold it.` : ''}`,
      calls: [{ name: 'show_day', args: { date: isoDay(day) } }],
    };
  }
  const topicRaw = l.match(/\bfor (?:the |my |a |an )?(.+?)(?:\s+(?:today|tomorrow|on \w+|this \w+|next \w+|\w+day))?[?.!]*$/)?.[1];
  const topic = topicRaw && !/^\d|^(an? )?(hour|half|minutes?)/.test(topicRaw) ? topicRaw.replace(/\s+(tomorrow|today|morning|afternoon)$/, '') : thread ? thread.ask.replace(/ by .*$/, '') : undefined;
  const title = who ? `${topic ? `${topic[0]!.toUpperCase()}${topic.slice(1)}` : `Time with ${firstName(who)}`}` : `Focus: ${topic ? `${topic[0]!.toUpperCase()}${topic.slice(1)}` : 'Deep work'}`;
  const ev = { id: uid('ev'), title, start: slot.start, end: slot.end, kind: who ? ('meeting' as const) : ('focus' as const), with: who ? [who] : [], thread: thread?.id, note: who ? 'Invite sent by Timmy after you approved it in Ask Timmy.' : 'Blocked by Timmy from Ask Timmy.' };
  const range = span(slot.start, slot.end);
  return {
    steps: [`Checked ${weekdayWord(day)}’s calendar`, `Found ${mins} free minutes${who ? ` for you and ${firstName(who)}` : ''}`],
    text: who
      ? `You’re free ${range}. Send ${firstName(who)} an invite for “${title}”? I can only see your calendar, so ${firstName(who)} may need to move something.`
      : `You’re free ${range}. Block it for “${title.replace('Focus: ', '')}”?`,
    calls: [
      answer({
        choices: [
          {
            id: 'yes',
            label: who ? `Send invite for ${fmtTime(slot.start)}` : `Block ${fmtTime(slot.start)}–${fmtTime(slot.end)}`,
            primary: true,
            actions: [ws([put('events', ev)], { toast: who ? `Invite sent to ${firstName(who)} for ${range}` : `Blocked ${range} for focus`, undo: true, log: who ? `Sent ${firstName(who)} an invite for “${title}”, ${range}` : `Blocked ${range} for “${title}”` })],
            after: who ? `Invite sent for ${range}.` : `Blocked ${range} on your calendar.`,
            open: 'calendar',
          },
          no('Calendar left as it is.'),
        ],
      }),
      { name: 'show_day', args: { date: isoDay(day) } },
    ],
  };
}

/** "Prep me for the Northwind pilot planning meeting", "what do I need before my 3pm with Priya?" */
function prepMeeting(s: State, l: string): Plan | null {
  if (!/(prep|prepare|ready for|before (my|the)|agenda for|brief me (on|for) (my|the) .*(meeting|1:1|call|sync|debrief|standup|kickoff|planning|review))/.test(l)) return null;
  const e = eventIn(s, l) ?? Object.values(s.ws.events).filter((x) => x.start > NOW && x.kind === 'meeting').sort((a, b) => a.start.getTime() - b.start.getTime())[0];
  if (!e) return { steps: ['Looked through your calendar'], text: 'You have no meetings coming up.', calls: [] };
  const people = e.with;
  const threads = s.threads.filter((t) => t.box !== 'archived' && t.box !== 'read-through' && t.participants.some((p) => people.includes(p)));
  const theyOwe = threads.filter((t) => t.box === 'waiting' && t.waiting && people.includes(t.waiting.on));
  const youOwe = threads.filter((t) => t.box === 'follow-up' || (t.box === 'inbox' && t.suggestion?.box === 'follow-up'));
  const approvals = scopedApprovals(s).filter((a) => a.who && people.includes(a.who));
  const notes = e.notesDoc ? s.ws.docs[e.notesDoc] : undefined;
  const table = notes?.blocks.find((b) => b.type === 'table') as { rows: string[][] } | undefined;
  const agenda = table?.rows[0]?.[1];
  const files = [...(e.docs ?? []), ...(e.notesDoc ? [e.notesDoc] : [])].filter((id) => s.ws.files[id]);
  const bullets = [
    agenda ? `On the agenda: ${agenda}.` : '',
    e.note ?? '',
    ...theyOwe.map((t) => `${firstName(t.waiting!.on)} owes you the ${midSentence(t.waiting!.item)}${t.waiting!.due ? `, ${lateBy(t.waiting!.due)}` : ', no date promised'}. Ask in the meeting.`),
    ...youOwe.map((t) => `You owe ${personName(counterpart(t)).split(' ')[0]}: ${midSentence(t.ask)}.`),
    ...approvals.map((a) => `Waiting on your OK: ${a.title}`),
  ].filter(Boolean);
  return {
    steps: ['Found the meeting', 'Read the notes doc and linked files', `Checked open mail with ${people.map(firstName).join(', ') || 'attendees'}`],
    text: `“${e.title}” is ${when(e.start)}${people.length ? ` with ${people.map(personName).join(', ')}` : ''}. ${bullets.length ? 'Here’s what to bring:' : 'Nothing open with them right now.'}`,
    calls: [
      answer({
        bullets,
        links: [...files.map((id) => ({ label: s.ws.files[id]!.name, href: `file:${id}`, sub: id === e.notesDoc ? 'Meeting notes' : 'Linked file' })), ...[...theyOwe, ...youOwe].slice(0, 3).map((t) => threadLink(t))],
      }),
    ],
  };
}

/** "Brief me on the Acme deal", "where are we with Northwind?" */
function briefOne(s: State, l: string): Plan | null {
  if (!/(brief|status|update me|where are we|how'?s|how is|what'?s (going on|happening|the latest)|catch me up|tell me about|summar|latest on)/.test(l)) return null;
  const deal = dealIn(s, l);
  const project = projectIn(s, l) ?? (deal ? Object.values(s.ws.projects).find((p) => p.deal === deal.id) : undefined);
  if (!deal && !project) return null;
  const pid = project?.id;
  const d = deal ?? (project?.deal ? s.deals[project.deal] : undefined);
  const threads = s.threads.filter((t) => (pid && t.project === pid) || (d && t.deal === d.id));
  const youOwe = threads.filter((t) => t.box === 'follow-up');
  const theyOwe = threads.filter((t) => t.box === 'waiting' && t.waiting);
  const approvals = scopedApprovals({ ...s, scope: pid ?? null }).filter((a) => !pid || a.project === pid || (d && a.change?.deal === d.id));
  const tasks = pid ? Object.values(s.ws.tasks).filter((t) => t.project === pid && t.status !== 'done') : [];
  const notes = project?.notesDoc ? s.ws.docs[project.notesDoc] : undefined;
  const table = notes?.blocks.find((b) => b.type === 'table') as { rows: string[][] } | undefined;
  const meeting = Object.values(s.ws.events)
    .filter((e) => e.start > NOW && (d ? e.with.includes(d.contact) : false))
    .sort((a, b) => a.start.getTime() - b.start.getTime())[0];
  const name = d?.company ?? project!.name;
  const bullets = [
    d ? `Deal: ${d.stage}, ${money(d.value)}. Next: ${midSentence(d.next)} (${d.owner === 'me' ? 'you' : firstName(d.owner)}${d.due ? `, ${d.due < NOW ? lateBy(d.due) : `due ${fmtDay(d.due)}`}` : ''}).` : '',
    project?.goal ? `Goal: ${project.goal}` : '',
    ...youOwe.map((t) => `You owe: ${midSentence(t.ask)}${t.due ? ` (${dueInfo(t.due).label.toLowerCase()})` : ''}.`),
    ...theyOwe.map((t) => `${firstName(t.waiting!.on)} owes you the ${midSentence(t.waiting!.item)}${t.waiting!.due ? `, ${t.waiting!.due < NOW ? lateBy(t.waiting!.due) : `due ${fmtDay(t.waiting!.due)}`}` : ''}.`),
    approvals.length ? `${plural(approvals.length, 'item')} waiting on your OK: ${approvals.map((a) => a.title).join('; ')}` : '',
    tasks.length ? `${plural(tasks.length, 'open task')}${tasks.some((t) => t.due && t.due < NOW) ? ', some late' : ''}.` : '',
    table?.rows[0] ? `Latest decision (${table.rows[0][0]}): ${table.rows[0][1]}.` : '',
    meeting ? `Next meeting: ${meeting.title}, ${when(meeting.start)}.` : '',
  ].filter(Boolean);
  return {
    steps: [`Read the ${name} ${d ? 'deal' : 'project'}`, `Checked ${plural(threads.length, 'email thread')}, tasks and approvals`],
    text: `Here’s where ${name} stands.`,
    calls: [
      answer({
        bullets,
        links: [
          ...(pid ? [{ label: project!.name, href: `project:${pid}`, sub: 'Project' }] : []),
          ...(d ? [{ label: `${d.company} · ${personName(d.contact)}`, href: `contact:${d.contact}`, sub: 'CRM record' }] : []),
          ...youOwe.slice(0, 2).map((t) => threadLink(t, 'You owe')),
          ...theyOwe.slice(0, 2).map((t) => threadLink(t, 'Waiting')),
        ],
      }),
    ],
  };
}

/** "What's on Thursday?", "calendar Thursday": a named day, not today. */
function namedDay(s: State, l: string): Plan | null {
  if (!/(calendar|schedule|meetings?|agenda|what'?s on|am i free|busy|free time)/.test(l) || /\b(block|find|move|reschedule|prep)\b/.test(l)) return null;
  const d = parseDue(l);
  if (!d || dayDiff(d) === 0) return null;
  const day = atHour(d, 0);
  const events = eventsOn(s.ws, day).filter((e) => e.kind !== 'personal');
  const label = weekdayWord(day);
  return {
    steps: [`Checked ${label}’s calendar`],
    text: events.length ? `${plural(events.length, 'event')} ${label}: first is ${events[0]!.title} at ${fmtTime(events[0]!.start)}.` : `Nothing on your calendar ${label}.`,
    calls: [{ name: 'show_day', args: { date: isoDay(day) } }],
  };
}

/** "Draft a quick investor update", "write a status update". */
function newUpdate(s: State, l: string): Plan | null {
  const m = l.match(/(draft|write|start|prepare)\s+(?:me\s+)?(?:a |an |the |my )?(?:quick |short |weekly |monthly )?(investor|status|team|project|board|weekly|monthly)?\s*update/);
  if (!m) return null;
  const kind = m[2] ?? 'status';
  const won = Object.values(s.deals).filter((d) => d.stage === 'Closed won');
  const open = Object.values(s.deals).filter((d) => d.stage !== 'Closed won');
  const late = Object.values(s.ws.tasks).filter((t) => t.status !== 'done' && t.due && t.due < NOW);
  const subject = `${kind === 'investor' ? 'Investor' : kind === 'board' ? 'Board' : kind === 'team' ? 'Team' : 'Status'} update · ${NOW.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`;
  const body = [
    'Hi all,',
    'A quick update.',
    `Wins\n${won.length ? won.map((d) => `• ${d.company} closed, ${money(d.value)}`).join('\n') : '• '}`,
    `Pipeline\n• ${money(open.reduce((n, d) => n + d.value, 0))} open across ${plural(open.length, 'deal')}\n${open.map((d) => `• ${d.company}: ${d.stage}, ${money(d.value)}`).join('\n')}`,
    `Risks\n${late.length ? late.map((t) => `• ${t.title}`).join('\n') : '• '}`,
    'Asks\n• ',
    'Best,\nTaylor',
  ].join('\n\n');
  return {
    steps: ['Pulled wins and pipeline from the CRM', 'Checked late tasks for risks'],
    text: `I started ${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind} update from your deals and tasks. Add the recipients and the asks; nothing is sent until you press Send.`,
    calls: [
      answer({
        preview: `${subject}\n\n${body}`,
        choices: [{ id: 'yes', label: 'Open it to finish', primary: true, actions: [{ type: 'compose', draft: { to: [], subject, body } }], after: 'Your update is open in a new email.' }, no('No email started.')],
      }),
    ],
  };
}

/** "Draft a reply to the customer complaining about the AC install" with no email open. */
function replyToSomething(s: State, l: string, thread?: Thread): Plan | null {
  if (thread || !/^(please\s+)?(draft|write|reply|respond|answer)\b.*\b(to|about|for)\b/.test(l) || /\b(urgent|all|every|everything|replies)\b/.test(l)) return null;
  const who = personIn(l);
  const terms = [...words(l.replace(/^(please\s+)?(draft|write|reply|respond|answer)( a| the)?( reply| response| email)?( to| about| for)?/, ''))].filter((w) => !['the', 'customer', 'about', 'reply', 'email', 'complaining', 'who', 'that', 'with', 'them', 'him', 'her'].includes(w));
  const hit =
    (who && s.threads.find((t) => t.box !== 'archived' && counterpart(t) === who)) ||
    s.threads
      .filter((t) => t.box !== 'archived')
      .map((t) => ({ t, n: terms.filter((w) => `${t.subject} ${t.ask} ${t.messages.map((m) => m.body.join(' ')).join(' ')}`.toLowerCase().includes(w)).length }))
      .filter((x) => x.n >= Math.min(2, terms.length))
      .sort((a, b) => b.n - a.n)[0]?.t;
  if (!hit) {
    return {
      steps: ['Searched your open mail'],
      text: `I couldn’t find an email about “${l.match(/\babout (.+?)[?.!]*$/)?.[1] ?? (terms.slice(0, 4).join(' ') || l)}”. Open the email and ask again, or tell me who it’s from.`,
      calls: [],
    };
  }
  return {
    steps: [`Found “${hit.subject}”`, hit.draft ? 'Found the draft from this morning' : 'Drafted a reply'],
    text: hit.draft ? `There’s already a draft on “${hit.subject}”. Review it and send when it’s right:` : `Here’s a draft for “${hit.subject}”. Open the email to say more, or ask me to change it there.`,
    effects: hit.draft ? [] : [{ type: 'makeDraft', id: hit.id }],
    calls: [{ name: 'show_thread', args: { id: hit.id } }],
  };
}

/** Actions Timmy can't take yet: say so, instead of answering something else. */
function cantDo(_s: State, l: string): Plan | null {
  const m = l.match(/^(?:please\s+)?(?:can you\s+|could you\s+)?(cancel|delete|remove|decline|accept|rsvp|forward|unsubscribe|pay|order|buy|sign|share|upload|print|translate)\b/);
  if (!m) return null;
  return {
    steps: ['Checked what Timmy can do'],
    text: `I can’t ${m[1]} things from the chat yet. I can draft emails, find and block time, move a meeting, update a deal, add tasks, and brief you on mail, meetings and deals. Each change waits for your OK.`,
    calls: [],
  };
}

/* ───────────── Outbound ───────────── */

/** "How's my campaign doing?" */
function outboundStats(s: State, l: string): Plan | null {
  if (!/\b(campaigns?|outbound|cold emails?|sequences?|outreach)\b/.test(l) || !/(how|doing|going|stats|performing|results|numbers|working)/.test(l)) return null;
  const active = Object.values(s.out.campaigns).filter((c) => c.status === 'active' || c.status === 'paused');
  if (!active.length) return { steps: ['Checked your campaigns'], text: 'No campaign is running. Ask me to write one for your best-fit leads.', calls: [] };
  const bullets = active.map((c) => {
    const st = statsOf(c, s.out.leads, s.out.messages);
    return `${c.name}${c.status === 'paused' ? ' (paused)' : ''}: ${st.sent} emails, ${pct(st.opened, st.sent - st.bounced)} opened, ${pct(st.replied, st.contacted)} replied, ${st.interested} interested, ${st.meetings} booked.`;
  });
  const hot = Object.values(s.out.leads).filter((x) => x.status === 'interested').length;
  return {
    steps: [`Read ${plural(active.length, 'campaign')}`, 'Counted sends, opens and replies'],
    text: `${bullets.length === 1 ? 'Here’s how it’s doing.' : 'Here’s how they’re doing.'}${hot ? ` ${plural(hot, 'lead')} ${hot === 1 ? 'is' : 'are'} interested and waiting on you in the unibox.` : ''}`,
    calls: [answer({ bullets, links: [...active.map((c) => ({ label: c.name, href: `campaign:${c.id}`, sub: 'Analytics' })), ...(hot ? [{ label: 'Open the unibox', href: 'outbound:unibox' }] : [])] })],
  };
}

/** "Who replied?", "any hot leads?" */
function outboundReplies(s: State, l: string): Plan | null {
  if (!/(who replied|any replies|new replies|replies from|unibox|hot leads|interested leads|who('?s| is) interested)/.test(l)) return null;
  const leads = Object.values(s.out.leads).filter((x) => x.unread || x.status === 'interested');
  if (!leads.length) return { steps: ['Read the unibox'], text: 'No new or open replies from outbound.', calls: [] };
  return {
    steps: ['Read the unibox', 'Sorted replies by label'],
    text: `${plural(leads.length, 'lead')} need${leads.length === 1 ? 's' : ''} a reply. Timmy has a suggested answer ready on each.`,
    calls: [
      answer({
        links: leads.map((x) => ({ label: `${x.first} ${x.last}, ${x.company}`, href: `unibox:${x.id}`, sub: x.label === 'question' ? 'Asked a question' : x.unread ? 'Unread' : 'Interested' })),
      }),
    ],
  };
}

/** "Any new form leads?", "speed to lead" */
function formLeads(s: State, l: string): Plan | null {
  if (!/(form leads?|speed to lead|inbound leads?|website leads?|demo requests?|new leads?)/.test(l)) return null;
  const waiting = Object.values(s.out.leads).filter((x) => x.source === 'form' && !x.firstReplyAt && x.status !== 'not-interested');
  const today = Object.values(s.out.leads).filter((x) => x.source === 'form' && x.receivedAt && dayDiff(x.receivedAt) === 0);
  return {
    steps: ['Checked your connected forms'],
    text: waiting.length
      ? `${plural(waiting.length, 'form lead')} ${waiting.length === 1 ? 'is' : 'are'} waiting for a first reply: ${waiting.map((x) => `${x.first} (${Math.max(1, Math.round((liveNow().getTime() - x.receivedAt!.getTime()) / 60000))} min)`).join(', ')}. Answer inside a few minutes and you’re far more likely to reach them.`
      : `Nobody is waiting. ${plural(today.length, 'form lead')} came in today, and each got a first reply.`,
    calls: [answer({ links: [...waiting.map((x) => ({ label: `${x.first} ${x.last}, ${x.company}`, href: `unibox:${x.id}`, sub: 'Waiting for a first reply' })), { label: 'Open Speed to lead', href: 'outbound:speed' }] })],
  };
}

/** "How many cold emails can I send today?" */
function sendingLimits(s: State, l: string): Plan | null {
  if (!/(sending limits?|daily limits?|cold[- ]emails? (today|left|limit)|cold[- ]email limit|email limits?|how many (cold )?(emails|texts|calls)|(emails|texts|calls)? left today|text limits?|my limits?)/.test(l)) return null;
  const t = coldToday(s);
  return {
    steps: ['Checked your mailboxes'],
    text: `${t.sent} of ${t.cap} cold emails sent today across ${plural(Object.keys(s.out.mailboxes).length, 'mailbox', 'mailboxes')}, so ${t.left} left. Each mailbox stays at or under ${s.out.limits.perMailbox} a day, and new ones warm up from ${s.out.limits.rampStart}.${s.out.channels.sms ? ` Texts: ${s.out.channels.sms.sentToday ?? 0} of ${s.out.channels.sms.dailyLimit ?? 0}.` : ''}${s.out.channels.call ? ` Calls: ${s.out.channels.call.sentToday ?? 0} of ${s.out.channels.call.dailyLimit ?? 0}.` : ''}`,
    calls: [answer({ links: [{ label: 'Channels & limits', href: 'outbound:channels' }] })],
  };
}

/** "Write a cold campaign for my best leads": Timmy prepares it; you launch it from Approvals. */
function writeCampaign(s: State, l: string): Plan | null {
  if (!/(write|draft|start|create|set up|build|launch|prepare)\b.*\b(cold (email|campaign|outreach)|outreach|campaign|sequence|outbound|emails? (to|for) (my )?(best |new )?leads)/.test(l)) return null;
  const pool = Object.values(s.out.leads)
    .filter((x) => x.status === 'new' && !x.campaign && x.email && x.source !== 'form')
    .map((x) => ({ x, fit: fitOf(x, s.out.offer) }))
    .filter(({ fit }) => fit.score >= 70)
    .sort((a, b) => b.fit.score - a.fit.score);
  if (!pool.length) return { steps: ['Looked for net-new leads that fit your offer'], text: 'There are no net-new leads that fit your offer well. Import a list in Outbound › Leads and ask again.', calls: [{ name: 'show_answer', args: { bullets: [], links: [{ label: 'Import leads', href: 'outbound:leads' }], choices: [] } }] };
  const id = `camp-${Date.now().toString(36)}`;
  const boxes = Object.values(s.out.mailboxes).filter((m) => !Object.values(s.out.campaigns).some((c) => c.status === 'active' && c.options.mailboxes.includes(m.id)));
  const c: Campaign = {
    id,
    name: `${s.out.offer.name[0]!.toUpperCase()}${s.out.offer.name.slice(1)}: best fits`,
    status: 'review',
    byTimmy: true,
    created: NOW,
    leads: [],
    steps: writeSequence(s.out.offer, { call: !!s.out.channels.call?.connected }),
    schedule: { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', tz: 'America/New_York' },
    options: { dailyLimit: Math.min(s.out.limits.perMailbox, 30), mailboxes: (boxes.length ? boxes : Object.values(s.out.mailboxes)).slice(0, 1).map((m) => m.id), stopOnReply: true, trackOpens: false, unsubscribe: true, plainText: true },
  };
  const ids = pool.map(({ x }) => x.id);
  const plan = project({ ...c, leads: ids }, s.out.leads, ctxOf(s));
  return {
    steps: [`Picked ${plural(ids.length, 'net-new lead')} that fit “${s.out.offer.name}”`, `Wrote a ${c.steps.length}-step sequence from your offer`, 'Checked it against your sending limits'],
    text: `I wrote “${c.name}” for ${plural(ids.length, 'lead')}: ${c.steps.map((x) => (x.channel === 'call' ? 'a call' : 'an email')).join(', ')}. At ${c.options.dailyLimit} a day it finishes ${plan.finish ? fmtDay(plan.finish) : 'within two weeks'}. Nothing goes out until you launch it from Approvals.`,
    effects: [
      { type: 'out', op: { op: 'campaign', campaign: c, quiet: true } },
      { type: 'out', op: { op: 'addToCampaign', id, leads: ids } },
    ],
    calls: [answer({ bullets: pool.slice(0, 5).map(({ x, fit }) => `${x.first} ${x.last}, ${x.title} at ${x.company} (fit ${fit.score})`), links: [{ label: 'Review the sequence', href: `campaign:${id}` }, { label: 'Approvals', href: 'approvals:campaign' }] })],
  };
}

/** Runs the handlers in order; the first that recognises the request answers it. */
export function intents(s: State, text: string, thread?: Thread): Plan | null {
  const l = text.trim().toLowerCase();
  const handlers: ((s: State, l: string) => Plan | null)[] = [
    (st, x) => textLead(st, x, text),
    (st, x) => logCallNotes(st, x, text),
    callList,
    callLead,
    (st, x) => findNewLeads(st, x, text),
    cantReach,
    overnight,
    (st, x) => editOpenDraft(st, x, text, thread),
    newUpdate,
    outboundStats,
    outboundReplies,
    writeCampaign,
    formLeads,
    sendingLimits,
    findLead,
    (st, x) => replyToSomething(st, x, thread),
    cantSense,
    nudgePerson,
    owedToMe,
    editDeal,
    reschedule,
    (st, x) => findTime(st, x, thread),
    prepMeeting,
    late,
    briefOne,
    namedDay,
    cantDo,
  ];
  for (const h of handlers) {
    const p = h(s, l);
    if (p) return p;
  }
  return null;
}
