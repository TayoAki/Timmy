import { createContext, useContext, useEffect, useMemo, useReducer, type Dispatch, type ReactNode } from 'react';
import { ACTIVITY, BOXES, DEALS, NOW, PEOPLE, PROJECTS, RULES, THREADS } from '../data/mock';
import type { Activity, Box, Deal, Label, MailFile, MailRule, ProjectId, Rule, RuleGroup, Thread, Waiting } from '../data/types';
import { describeMailRule, RULE_BOXES, senderKey, sweepRule } from './mail-rules';
import { DECISIONS, type Decision } from '../data/decisions';
import { WS_SEED } from '../data/ws-mock';
import type { Invoice, InvoiceKind, LearnedRule, WS } from '../data/ws-types';
import { counts as lineCounts, defaultBilling, newDraft } from './invoices';
import { fmtDate, fmtDay, fmtTime, money } from '../lib/format';
import type { ApprovalKind, ApprovalRecord } from './approvals';
import { draftFor } from './drafting';
import { outbound, type OutOp } from './outbound';
import { connect, connectSeed, gate, type Connect, type ConnHelpers, type ConnOp } from './connect';
import { chat, type ChatOp } from './chat';
import { outboundSeed } from '../data/outbound-mock';
import type { Outbound } from '../data/outbound-types';
import { DEFAULT_SCHEDULE, fmtClock, nextRun, scheduleRule, whenLabel, daysLabel, type Schedule } from './schedule';
import type { MorningRun, PendingEffect } from '../live/types';
import { isLive, liveSuffix } from '../live/clock';
import { applyOps, decisionOps, firstName, midSentence, patch as wsPatch, personFromMail, personName, put, registerPerson, type WsOp, type WsOptions } from './ws';

export type TodayTab = 'brief' | 'triage' | 'drafts';
export type ThreadTab = 'conversation' | 'links' | 'history';

export type Route =
  | { view: 'today'; tab: TodayTab }
  | { view: 'box'; box: Box | ProjectId; tab: string }
  | { view: 'thread'; id: string; tab: ThreadTab }
  | { view: 'activity'; tab: string }
  | { view: 'people'; tab: string; person?: string }
  | { view: 'files'; tab: string; folder: string }
  | { view: 'rules'; tab: RuleGroup }
  | { view: 'appearance' }
  | { view: 'voice' }
  | { view: 'tasks'; tab: 'board' | 'list' | 'review'; project?: string }
  | { view: 'invoices'; tab: 'invoices' | 'quotes' | 'details' }
  | { view: 'invoice'; id: string }
  | { view: 'calendar'; tab: 'week' | 'day'; date?: string }
  | { view: 'docs'; tab: 'recent' | 'meetings' | 'templates' }
  | { view: 'file'; id: string }
  | { view: 'projects'; tab: 'active' | 'archived' }
  | { view: 'project'; id: string; tab: 'overview' | 'tasks' | 'notes' | 'mail' | 'files' | 'ai' }
  | { view: 'contact'; id: string; tab: 'overview' | 'activity'; filter?: string }
  | { view: 'library'; tab: 'prompts' | 'captured' | 'routines' | 'learned' | 'automations' }
  | { view: 'automation'; id: string }
  | { view: 'approvals'; tab: 'open' | 'history'; filter?: ApprovalKind }
  | { view: 'outbound'; tab: OutboundTab; list?: string; id?: string; filter?: string }
  | { view: 'campaign'; id: string; tab: 'analytics' | 'leads' | 'sequence' | 'schedule' | 'options' }
  | { view: 'social'; tab: 'overview' | 'create' | 'calendar' | 'trends' }
  | { view: 'connections'; group?: string };

export type OutboundTab = 'leads' | 'campaigns' | 'drafts' | 'unibox' | 'speed' | 'chat' | 'calls' | 'templates' | 'channels';

export type Section = 'mail' | 'approvals' | 'activity' | 'people' | 'files' | 'rules' | 'tasks' | 'calendar' | 'docs' | 'invoices' | 'projects' | 'library' | 'outbound' | 'social' | 'connections';

export const sectionOf = (r: Route): Section => {
  switch (r.view) {
    case 'activity':
      return 'activity';
    case 'people':
    case 'contact':
      return 'people';
    case 'files':
      return 'files';
    case 'rules':
    case 'appearance':
    case 'voice':
      return 'rules';
    case 'tasks':
      return 'tasks';
    case 'calendar':
      return 'calendar';
    case 'docs':
    case 'file':
      return 'docs';
    case 'invoices':
    case 'invoice':
      return 'invoices';
    case 'projects':
    case 'project':
      return 'projects';
    case 'library':
    case 'automation':
      return 'library';
    case 'approvals':
      return 'approvals';
    case 'outbound':
    case 'campaign':
      return 'outbound';
    case 'social':
      return 'social';
    case 'connections':
      return 'connections';
    default:
      return 'mail';
  }
};

/** Detail screens keep the list you came from as the Back target. */
const isDetail = (r: Route) => r.view === 'thread' || r.view === 'file' || r.view === 'contact' || r.view === 'project' || r.view === 'campaign' || r.view === 'invoice';

/** A new email or reply being written in the compose window. */
export interface ComposeDraft {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  /** Track the reply in [02] Waiting: what they owe you and by when (yyyy-mm-dd). */
  track?: { on?: string; item: string; due?: string } | null;
  project?: string;
  /** Files attached from the person's computer, already uploaded (real workspaces). */
  files?: MailFile[];
  /** The invoice or quote this email sends: sending it marks it sent and ties it to the email. */
  invoice?: string;
}

interface Snapshot {
  threads: Thread[];
  deals: Record<string, Deal>;
  activity: Activity[];
  ws: WS;
  decisions: Decision[];
  approvalLog: ApprovalRecord[];
  dismissed: string[];
  out: Outbound;
}

export interface Toast {
  id: number;
  text: string;
  tone?: 'default' | 'warn';
  undo?: Snapshot;
  /** Live mode: the command Undo takes back on the server. */
  command?: string;
  /** How long the notice stays, when not the usual few seconds (a send's undo window). */
  ms?: number;
}

export interface State {
  threads: Thread[];
  deals: Record<string, Deal>;
  activity: Activity[];
  rules: Rule[];
  route: Route;
  back: Route;
  highlight: string;
  highlightDone: boolean;
  dismissed: string[];
  toasts: Toast[];
  searchOpen: boolean;
  searchQuery: string;
  drawer: 'side' | 'right' | null;
  /** Drive, Docs, Sheets, Slides, Tasks, Calendar, CRM, Projects, AI library. */
  ws: WS;
  compose: ComposeDraft | null;
  capture: boolean;
  /** Choices Timmy brought to you (prices, hiring calls, invites). */
  decisions: Decision[];
  /** Everything you approved or turned down, newest first. */
  approvalLog: ApprovalRecord[];
  /** When the morning run happens. */
  schedule: Schedule;
  /** Focus mode: a calmer screen with only what needs you. */
  focus: boolean;
  /** The project everything is narrowed to, or null for all of them. */
  scope: string | null;
  /** Calm home: fewer badges, a shorter brief, and a quieter focus mode. */
  calm: boolean;
  /** Show deals, the pipeline and the CRM record (off for people outside sales). */
  showDeals: boolean;
  /** Outbound: leads, campaigns, the unibox, limits, forms and social. */
  out: Outbound;
  /** Connected apps, CRM and delegate policies, enrichment, and actions waiting on someone else. */
  conn: Connect;
  /** Agencies: one outbound workspace per client. The active one is `out`; the rest wait here. */
  clients: { active: string; names: Record<string, string>; stash: Record<string, Outbound> };
  /** Live mode: writes Timmy proposed that are waiting for someone's OK, or held for the undo window. Empty in the demo. */
  pending: PendingEffect[];
  /** Live mode: the last scheduled morning run. Null in the demo (which shows its sample run) and before the first one. */
  run: MorningRun | null;
}

export type Action =
  | { type: 'navigate'; route: Route }
  | { type: 'openThread'; id: string; tab?: ThreadTab }
  | { type: 'back' }
  /** `by: 'timmy'` is set by the server when Timmy filed the thread itself (after approval, or in Auto mode). */
  | { type: 'move'; id: string; box: Box; quiet?: boolean; by?: 'timmy' }
  /** Done with an email: it is archived and every to-do that came from it is ticked off, with one Undo for both. */
  | { type: 'done'; id: string }
  /** “No” to Timmy's question whether an email is about a project: it isn't asked again for that email. */
  | { type: 'dismissProjectGuess'; id: string }
  | { type: 'acceptSuggestion'; id: string }
  | { type: 'acceptAll'; ids: string[] }
  | { type: 'toggleStar'; id: string }
  | { type: 'markRead'; id: string; unread?: boolean }
  /** `files`, when given, replaces the files attached to the draft (real workspaces; each was uploaded first). */
  | { type: 'updateDraft'; id: string; body: string; subject?: string; files?: MailFile[] }
  | { type: 'discardDraft'; id: string }
  | { type: 'sendDraft'; id: string; track: boolean; approved?: boolean; seen?: string }
  | { type: 'toggleStep'; id: string; step: string }
  /** Do what a next action says (send, update the deal, decide, block time), then tick it. */
  | { type: 'runStep'; id: string; step: string; seen?: string }
  | { type: 'applyDeal'; id: string; approved?: boolean }
  /** Change a deal's stage or value (from Ask Timmy, after you press Update). */
  | { type: 'editDeal'; id: string; stage?: string; value?: number; approved?: boolean }
  | { type: 'toggleRule'; id: string }
  /** A rule in plain words; with `mail`, a sorting rule plain code applies (src/state/mail-rules.ts). */
  | { type: 'addRule'; group: RuleGroup; text: string; mail?: MailRule }
  | { type: 'removeRule'; id: string }
  /** Puts a thread in a project, or takes it out (null). Its to-dos go with it. */
  | { type: 'setProject'; id: string; project: ProjectId | null }
  | { type: 'dismiss'; key: string }
  | { type: 'setHighlight'; text: string }
  | { type: 'toggleHighlight' }
  | { type: 'toast'; text: string; tone?: Toast['tone'] }
  | { type: 'dismissToast'; id: number }
  | { type: 'restore'; toast: number }
  | { type: 'search'; open: boolean; query?: string }
  | { type: 'drawer'; drawer: State['drawer'] }
  | ({ type: 'ws'; ops: WsOp[] } & WsOptions)
  | { type: 'compose'; draft: ComposeDraft | null }
  | { type: 'sendNew'; draft: ComposeDraft }
  /** A new invoice or quote, numbered here so the server gives the number (src/state/invoices.ts). */
  | { type: 'newInvoice'; kind: InvoiceKind; id: string; contact?: string; project?: string; thread?: string; fromQuote?: string }
  /** What happened to one: paid, accepted, declined, void, or back to how it was before that. */
  | { type: 'invoice'; op: 'paid' | 'accepted' | 'declined' | 'void' | 'reopen'; id: string }
  | { type: 'reply'; id: string; body: string; track?: { on: string; item: string; due?: string } | null; files?: MailFile[] }
  | { type: 'simulateReply'; id: string }
  /** Timmy drafts a nudge or reply; with `note`, the reply says what you asked it to. */
  | { type: 'makeDraft'; id: string; note?: string }
  | { type: 'reset'; quiet?: boolean }
  /** Reads the saved state again (the story puts back what you had before it played). */
  | { type: 'reload'; toast?: string }
  | { type: 'capture'; open: boolean }
  | { type: 'setSchedule'; schedule: Partial<Schedule> }
  | { type: 'setUrgency'; id: string; level: 'urgent' | 'later' | null }
  | { type: 'setFocus'; on?: boolean }
  | { type: 'setScope'; project: string | null }
  | { type: 'setPrefs'; calm?: boolean; showDeals?: boolean }
  /** Approve or turn down an item in the Approvals queue. */
  | { type: 'resolve'; key: string; option: string; change?: { deal: string; stage: string; value: number }; via?: 'send'; approved?: boolean; seen?: string }
  /** Outbound: leads, campaigns, sending, forms, social. */
  | { type: 'out'; op: OutOp }
  | { type: 'conn'; op: ConnOp }
  /** Website chat: a teammate replies to a visitor, takes a chat over, stars, reads or deletes it. */
  | { type: 'chat'; op: ChatOp }
  | { type: 'client'; to?: string; create?: string }
  /** The exec or RevOps answered a held action (simulated in this preview). */
  | { type: 'release'; id: string; approve: boolean }
  /** Live mode: the server's confirmed state, laid over what the browser shows. */
  | { type: 'server'; state: Partial<State>; toast?: { text: string; tone?: Toast['tone']; command?: string; ms?: number } }
  /** Live mode: approve or turn down a write Timmy proposed. */
  | { type: 'effect'; id: string; approve: boolean }
  /** Live mode: take back the change a command made (and any send it was holding). */
  | { type: 'undo'; command: string };

/** Builds a workspace change: dispatch(ws([put('tasks', task)], { toast: 'Task added', undo: true })). */
export const ws = (ops: WsOp[], options: WsOptions = {}): Action => ({ type: 'ws', ops, ...options });

export const ALL_LABELS: Label[] = [...BOXES, ...PROJECTS];
export const labelOf = (id: string, wsState?: WS): Label => {
  const p = wsState?.projects[id];
  if (p) return { id: p.id, num: p.num, name: p.name, hint: p.client ?? '', color: p.color };
  return ALL_LABELS.find((l) => l.id === id) ?? { id: id as ProjectId, num: '··', name: id, hint: '', color: 'var(--c-slate)' };
};
export const boxTag = (box: Box) => {
  const l = labelOf(box);
  return `[${l.num}] ${l.name}`;
};

export const initial: State = {
  threads: THREADS,
  deals: DEALS,
  activity: ACTIVITY,
  rules: RULES,
  route: { view: 'today', tab: 'brief' },
  back: { view: 'today', tab: 'brief' },
  highlight: 'Send Acme the revised quote',
  highlightDone: false,
  dismissed: [],
  toasts: [],
  searchOpen: false,
  searchQuery: '',
  drawer: null,
  ws: WS_SEED,
  compose: null,
  capture: false,
  decisions: DECISIONS,
  approvalLog: [],
  schedule: DEFAULT_SCHEDULE,
  focus: false,
  scope: null,
  calm: false,
  showDeals: true,
  out: outboundSeed(),
  conn: connectSeed(),
  clients: { active: 'own', names: { own: 'Northpeak (your company)' }, stash: {} },
  pending: [],
  run: null,
};

// Leads you've met or added to People show up by name on the calendar and in People.
for (const l of Object.values(initial.out.leads)) if (l.status === 'meeting') registerPerson({ id: l.id, name: `${l.first} ${l.last}`, email: l.email, title: l.title, company: l.company });

/** A new client's outbound workspace: their own offer, no mailboxes, leads or campaigns yet. */
function blankOutbound(client: string, from: Outbound): Outbound {
  return {
    leads: {},
    lists: {},
    offer: { name: `${client} offer`, product: client, audience: '', pain: '', outcome: '', proof: '', cta: 'Open to a quick call next week?', icp: { titles: [], industries: [], minEmployees: 1, maxEmployees: 10000 } },
    templates: Object.fromEntries(Object.values(from.templates).filter((t) => t.builtIn).map((t) => [t.id, t])),
    campaigns: {},
    mailboxes: {},
    channels: from.channels,
    limits: from.limits,
    messages: [],
    forms: {},
    posts: {},
  };
}

let toastSeq = 1;
const connHelpers: ConnHelpers = {
  toast: (st, text, o) => withToast(st, text, o?.undo ? snap(st) : undefined, o?.tone),
  log: (st, text, kind) => logged(st, text, kind),
};
let activitySeq = 1;

const lowerFirst = midSentence;

const snap = (s: State): Snapshot => ({
  threads: s.threads,
  deals: s.deals,
  activity: s.activity,
  ws: s.ws,
  decisions: s.decisions,
  approvalLog: s.approvalLog,
  dismissed: s.dismissed,
  out: s.out,
});

const fmtShortClock = (d: Date) => fmtTime(d).replace(':00', '');

/** When a log line happened: the demo spaces them a minute apart from its fixed clock; a real workspace uses the time. */
const stamp = () => (isLive() ? new Date() : new Date(NOW.getTime() + activitySeq * 60000));

let recordSeq = 1;
/** Adds a line to the Approvals history. */
const recorded = (s: Pick<State, 'approvalLog'>, r: Omit<ApprovalRecord, 'id' | 'at'>): ApprovalRecord[] => [
  { id: `ap-${recordSeq++}-${Date.now().toString(36)}${liveSuffix()}`, at: stamp(), ...r },
  ...s.approvalLog,
];

/**
 * Keeps the CRM in step with what you just did: the deal's last touch and, when
 * you're now waiting on someone, its next step, owner and date. The contact's
 * record follows the deal.
 */
const followDeal = (
  deals: Record<string, Deal>,
  space: WS,
  id: string,
  change: { touch?: string; next?: { item: string; on: string; due?: Date } },
): { deals: Record<string, Deal>; ws: WS } => {
  const deal = deals[id];
  if (!deal) return { deals, ws: space };
  const next: Deal = {
    ...deal,
    lastTouch: change.touch ? `${fmtDate(NOW)} · ${change.touch}` : deal.lastTouch,
    ...(change.next ? { next: change.next.item, owner: change.next.on, due: change.next.due } : {}),
  };
  const c = space.contacts[deal.contact];
  const ops: WsOp[] = c ? [wsPatch('contacts', c.id, { last: NOW, ...(change.next ? { next: change.next.item, owner: change.next.on, due: change.next.due } : {}) })] : [];
  return { deals: { ...deals, [id]: next }, ws: ops.length ? applyOps(space, ops) : space };
};

/** Rewrites text across a deck's slides or a doc's blocks, so a file matches a decision. */
const retext = (space: WS, file: string, replace: [string, string][]): WS => {
  const rep = (x: string) => replace.reduce((acc, [from, to]) => acc.split(from).join(to), x);
  const deck = space.decks[file];
  const doc = space.docs[file];
  const ops: WsOp[] = [];
  if (deck) ops.push(wsPatch('decks', file, { slides: deck.slides.map((sl) => ({ ...sl, title: rep(sl.title), bullets: sl.bullets?.map(rep) })) }));
  if (doc) ops.push(wsPatch('docs', file, { blocks: doc.blocks.map((b) => ('text' in b && typeof b.text === 'string' ? { ...b, text: rep(b.text) } : b)) }));
  if (space.files[file]) ops.push(wsPatch('files', file, { updated: NOW }));
  return ops.length ? applyOps(space, ops) : space;
};

/** Ticks the "update the deal" next action on every thread about this deal. */
const tickDealSteps = (threads: Thread[], deal: string) =>
  threads.map((t) => (t.deal === deal && t.steps?.some((x) => x.run?.do === 'deal' && !x.done) ? { ...t, steps: t.steps.map((x) => (x.run?.do === 'deal' ? { ...x, done: true } : x)) } : t));

/** "I'll send the scorecard by 3" → "send the scorecard by 3". Null when the email makes no promise. */
export const promiseIn = (body: string): string | null => {
  const m = body.replace(/’/g, "'").match(/\bI(?:'ll| will)\s+((?:send|share|get|have|finish|submit|file|add|fill|write|put|do)\b[^.\n!?]*)/i);
  if (!m) return null;
  const what = m[1]!.trim().replace(/\s+/g, ' ');
  // "I'll send an invite" with an invite step is the invite flow, not a promise to remember.
  return /\b(invite|calendar invite)\b/i.test(what) ? null : what.length > 90 ? `${what.slice(0, 88)}…` : what;
};

/** Only the next actions that mean "send this reply" are done when it goes out. */
const isSendStep = (st: { text: string; run?: { do: string } }) => (st.run ? st.run.do === 'send' : /^(send|reply)\b(?!.*\b(invite|receipt|file|deck)\b)/i.test(st.text));

const dueDate = (iso?: string) => {
  if (!iso) return undefined;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, m! - 1, d!, 17, 0);
};

const patch = (threads: Thread[], id: string, fn: (t: Thread) => Thread) =>
  threads.map((t) => (t.id === id ? fn(t) : t));

const logged = (s: State, text: string, kind: Activity['kind'], threadId?: string): Activity[] => [
  { id: isLive() ? `act-${Date.now().toString(36)}-${activitySeq++}${liveSuffix()}` : `live-${activitySeq++}`, at: stamp(), kind, text, threadId },
  ...s.activity,
];

/** One notice at a time: a new one replaces the last, so they never stack over the page. */
const withToast = (_s: State, text: string, undo?: Snapshot, tone?: Toast['tone']): Toast[] => [{ id: toastSeq++, text, undo, tone }];

/** The deal change a sorted email points to, if it's waiting in Approvals: "Brightwave → Closed won". */
const crmWaiting = (s: State, t: Thread): string | null => {
  const deal = t.deal ? s.deals[t.deal] : undefined;
  if (!deal || !t.suggestion?.extra || t.deal !== 'brightwave') return null;
  if (deal.stage === 'Closed won' || s.dismissed.includes(`crm:${deal.id}`)) return null;
  return `Moving ${deal.company} to Closed won`;
};

/** How many times the person has to file a sender's mail the same way before Timmy offers a rule for it. */
export const LEARN_AFTER = 2;

/**
 * A sorting rule to offer after the person moved `t` out of Triage to `box` themselves: when they have now filed
 * mail from the same company (or person) there at least LEARN_AFTER times, no rule covers that sender yet, and they
 * haven't turned the same offer down before. Counted from the activity log, which records each move a person makes.
 */
const learnedFromMoves = (s: State, t: Thread, box: Box): LearnedRule | null => {
  if (!(RULE_BOXES as string[]).includes(box)) return null;
  const key = senderKey(t, PEOPLE.me?.email ?? '');
  if (!key) return null;
  const dismissKey = `learn:${key}:${box}`;
  const id = `learned-mail-${key.replace(/[^a-z0-9]+/gi, '-')}-${box}`;
  if (s.ws.learned[id] || s.dismissed.includes(dismissKey)) return null;
  if (s.rules.some((r) => r.enabled && r.mail?.when.from?.includes(key) && !r.mail.when.subject && !r.mail.when.words && r.mail.then.box)) return null;
  const byId = new Map(s.threads.map((x) => [x.id, x]));
  const ending = ` to ${boxTag(box)}`;
  const times = new Set(
    s.activity
      .filter((e) => e.kind === 'move' && !!e.threadId && e.text.startsWith('You moved') && e.text.endsWith(ending))
      .map((e) => e.threadId!)
      .filter((id) => {
        const x = byId.get(id);
        return !!x && senderKey(x, PEOPLE.me?.email ?? '') === key;
      }),
  ).size;
  if (times < LEARN_AFTER) return null;
  const mail: MailRule = { when: { from: [key] }, then: { box: box as MailRule['then']['box'] } };
  const who = key.startsWith('@') ? `anyone at ${key.slice(1)}` : key;
  return { id, group: 'triage', text: describeMailRule(mail, s.ws.projects), evidence: `You moved ${times} emails from ${who} ${box === 'archived' ? 'to the archive' : `to ${boxTag(box)}`} yourself.`, mail, dismissKey };
};

/** Applies a box change, keeping the data each box needs consistent. */
const moveThread = (t: Thread, box: Box): Thread => {
  const next: Thread = { ...t, box, unread: false, suggestion: undefined };
  if (box === 'follow-up' && t.suggestion?.effort) next.effort = t.suggestion.effort;
  if (box === 'waiting' && !t.waiting) {
    const other = t.participants.find((p) => p !== 'me') ?? 'me';
    next.waiting = { on: other, item: 'A reply', since: NOW };
  }
  if (box !== 'waiting' && t.box === 'waiting' && box !== 'archived') next.waiting = undefined;
  return next;
};

const clipped = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const capFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const openTodos = (tasks: WS['tasks'], threadId: string) => Object.values(tasks).filter((x) => x.thread === threadId && x.status !== 'done');

/** To-dos a sent reply itself does: answering, sending or sharing something, confirming, letting them know. */
const REPLY_DOES = /^(reply|respond|answer|write back|get back|send|share|forward|confirm|email|e-mail|tell|let \S+ know|update|ask|follow up)\b/i;

/**
 * The email's open to-dos a reply ticks off; none when the reply only promises to do them later. Used for replies sent
 * from Timmy here, and for replies the person writes in Gmail or Outlook when sync brings them in (sync/ingest.ts).
 */
export const doneByReply = (tasks: WS['tasks'], threadId: string, body: string) => (promiseIn(body) ? [] : openTodos(tasks, threadId).filter((x) => REPLY_DOES.test(x.title.trim())));

/** "1 to-do" / "3 to-dos". */
const todoCount = (n: number) => (n === 1 ? '1 to-do' : `${n} to-dos`);

/** A weekday `n` working days after `from`, at 5 PM. */
const workingDaysFrom = (from: Date, n: number) => {
  const d = new Date(from);
  d.setHours(17, 0, 0, 0);
  for (let left = n; left > 0; ) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) left--;
  }
  return d;
};

/** The person's own email asks the other side for something: a question, or "could you", "please", "let me know". */
const ASKS = /\?|\b(could you|can you|would you|please|let me know)\b/i;

/**
 * Where an email goes once its to-dos are done: to Waiting when the person's own newest message asked the other side
 * for something (three working days to answer, unless a wait is already set), archived otherwise. Shared with the
 * server, which files an email the same way when a reply written in Gmail or Outlook finishes it (sync/reply-filing.ts).
 */
export function finishedPlace(th: Thread, now: Date = NOW): { box: 'waiting' | 'archived'; waiting?: Waiting } {
  const newest = th.messages[th.messages.length - 1];
  if (!(newest?.from === 'me' && ASKS.test(newest.body.join(' ')))) return { box: 'archived' };
  return { box: 'waiting', waiting: th.waiting ?? { on: counterpart(th), item: 'An answer to your email', due: workingDaysFrom(now, 3), since: now } };
}

/** The email filed where `finishedPlace` says, with the wait it now has and a line in its history. */
export function fileFinished(th: Thread, place: ReturnType<typeof finishedPlace>, note: string, now: Date = NOW): Thread {
  const w = place.waiting;
  return {
    ...moveThread(th, place.box),
    ...(w ? { waiting: w, ask: `${firstName(w.on)} owes you: ${lowerFirst(w.item)}${w.due ? ` by ${fmtDay(w.due)}` : ''}` } : {}),
    history: [...(th.history ?? []), { at: now, text: note }],
  };
}

/** Past this many emails in one change the person is tidying tasks in bulk, and filing that much mail by the way would surprise them. */
const MAX_FOLLOWS = 10;

/**
 * The email follows its tasks. When a change ticks off the last open to-do of an email still in Triage or Follow Up,
 * with no draft of the person's waiting to go, the email is filed: to Waiting when the person's own message is the
 * newest and asked the other side for something (with three working days to answer), archived otherwise. Moving it
 * writes to Gmail or Outlook like any move, and the change's Undo puts it back. Returns what to add to the notice.
 */
function followTasks(s: State, before: WS['tasks']): { state: State; notes: string[] } {
  const after = s.ws.tasks;
  const finished = new Set<string>();
  for (const [id, t] of Object.entries(after)) if (t.thread && t.status === 'done' && before[id] && before[id]!.status !== 'done') finished.add(t.thread);
  let next = s;
  const notes: string[] = [];
  for (const tid of [...finished].slice(0, MAX_FOLLOWS)) {
    const th = next.threads.find((x) => x.id === tid);
    if (!th || (th.box !== 'inbox' && th.box !== 'follow-up') || th.draft || openTodos(after, tid).length) continue;
    const place = finishedPlace(th);
    const waiting = place.waiting;
    const short = clipped(th.subject);
    next = {
      ...next,
      threads: patch(next.threads, tid, (x) => fileFinished(x, place, waiting ? `Its to-dos are done; moved to [02] Waiting for ${firstName(waiting.on)}’s answer` : 'Its to-dos are done; archived')),
      activity: logged(next, waiting ? `“${th.subject}” moved to Waiting: its to-dos are done and your last email asked for an answer` : `“${th.subject}” archived: its to-dos are done`, 'move', tid),
    };
    notes.push(waiting ? `“${short}” now waits for ${firstName(waiting.on)}’s answer` : `nothing is left on “${short}”, so the email is archived`);
  }
  return { state: next, notes };
}

export function reducer(s: State, a: Action): State {
  // Some actions need someone else's OK first: CRM writes (RevOps), and in delegate mode the exec's calls.
  if (a.type === 'applyDeal' || a.type === 'editDeal' || a.type === 'sendDraft' || a.type === 'resolve') {
    const held = gate(s, a, connHelpers);
    if (held) return held;
  }
  switch (a.type) {
    case 'navigate': {
      const back = isDetail(a.route) ? (isDetail(s.route) ? s.back : s.route) : a.route;
      return { ...s, route: a.route, drawer: null, back };
    }

    case 'openThread': {
      const back = isDetail(s.route) ? s.back : s.route;
      return {
        ...s,
        back,
        drawer: null,
        route: { view: 'thread', id: a.id, tab: a.tab ?? 'conversation' },
        threads: patch(s.threads, a.id, (t) => ({ ...t, unread: false })),
      };
    }

    case 'back':
      return { ...s, route: s.back };

    case 'move': {
      const t = s.threads.find((x) => x.id === a.id);
      if (!t || t.box === a.box) return s;
      const tag = boxTag(a.box);
      const moved: State = {
        ...s,
        threads: patch(s.threads, a.id, (x) => moveThread(x, a.box)),
        activity: logged(s, a.by === 'timmy' ? `Timmy filed “${t.subject}” under ${tag}, as asked in the chat` : `You moved “${t.subject}” to ${tag}`, 'move', t.id),
        toasts: a.quiet ? s.toasts : withToast(s, `Moved to ${tag}`, snap(s)),
      };
      // Mail the person sorts out of Triage the same way twice, from the same sender: Timmy offers it as a rule.
      const learned = a.by === 'timmy' || t.box !== 'inbox' ? null : learnedFromMoves(moved, t, a.box);
      return learned ? { ...moved, ws: { ...moved.ws, learned: { ...moved.ws.learned, [learned.id]: learned } } } : moved;
    }

    case 'done': {
      const t = s.threads.find((x) => x.id === a.id);
      if (!t) return s;
      const open = Object.values(s.ws.tasks).filter((x) => x.thread === t.id && x.status !== 'done');
      if (t.box === 'archived' && !open.length) return s;
      const ticked = open.length === 1 ? 'its to-do ticked off' : `its ${open.length} to-dos ticked off`;
      return {
        ...s,
        threads: t.box === 'archived' ? s.threads : patch(s.threads, a.id, (x) => moveThread(x, 'archived')),
        ws: open.length ? { ...s.ws, tasks: { ...s.ws.tasks, ...Object.fromEntries(open.map((x) => [x.id, { ...x, status: 'done' as const }])) } } : s.ws,
        activity: logged(s, `You marked “${t.subject}” done: archived${open.length ? `, ${ticked}` : ''}`, 'move', t.id),
        toasts: withToast(s, open.length ? `Done: archived, ${ticked}` : 'Done: archived', snap(s)),
      };
    }

    case 'acceptSuggestion': {
      const t = s.threads.find((x) => x.id === a.id);
      if (!t?.suggestion) return s;
      const sug = t.suggestion;
      // Sorting files the email; it never changes a deal. A stage change it points to waits in Approvals.
      const crm = crmWaiting(s, t);
      return {
        ...s,
        threads: patch(s.threads, a.id, (x) => moveThread(x, sug.box)),
        activity: logged(s, `Sorted “${t.subject}” to ${boxTag(sug.box)}`, 'triage', t.id),
        toasts: withToast(s, `Sorted to ${boxTag(sug.box)}${crm ? `. ${crm} is waiting for your OK in Approvals` : ''}`, snap(s)),
      };
    }

    case 'acceptAll': {
      let next = s;
      for (const id of a.ids) next = reducer({ ...next, toasts: [] }, { type: 'acceptSuggestion', id });
      const left = next.threads.filter((t) => t.box === 'inbox').length;
      const tail = left === 0 ? 'Inbox zero.' : `${left} left for you.`;
      const crm = a.ids
        .map((id) => s.threads.find((t) => t.id === id))
        .map((t) => (t ? crmWaiting(s, t) : null))
        .filter(Boolean);
      const held = crm.length ? ` ${crm.join(' and ')} ${crm.length === 1 ? 'is' : 'are'} waiting for your OK in Approvals.` : '';
      return { ...next, toasts: withToast(s, `Sorted ${a.ids.length} emails. ${tail}${held}`, snap(s)) };
    }

    case 'toggleStar': {
      const t = s.threads.find((x) => x.id === a.id);
      if (!t) return s;
      const starred = s.threads.filter((x) => x.starred).length;
      if (!t.starred && starred >= 5) {
        return { ...s, toasts: withToast(s, 'Five threads are already starred. Unstar one first: if everything is starred, nothing is.', undefined, 'warn') };
      }
      return { ...s, threads: patch(s.threads, a.id, (x) => ({ ...x, starred: !x.starred })) };
    }

    case 'markRead':
      return { ...s, threads: patch(s.threads, a.id, (x) => ({ ...x, unread: a.unread ?? false })) };

    case 'updateDraft':
      return {
        ...s,
        threads: patch(s.threads, a.id, (x) =>
          x.draft ? { ...x, draft: { ...x.draft, body: a.body, subject: a.subject ?? x.draft.subject, ...(a.files !== undefined ? { files: a.files.length ? a.files : undefined } : {}) } } : x,
        ),
      };

    case 'discardDraft': {
      const t = s.threads.find((x) => x.id === a.id);
      if (!t?.draft) return s;
      return {
        ...s,
        threads: patch(s.threads, a.id, (x) => ({ ...x, draft: undefined })),
        approvalLog: recorded(s, { key: `draft:${t.id}`, kind: 'email', title: t.draft.subject, choice: 'Discarded', approved: false, thread: t.id }),
        toasts: withToast(s, 'Draft discarded', snap(s)),
      };
    }

    case 'sendDraft': {
      const t0 = s.threads.find((x) => x.id === a.id);
      if (!t0?.draft) return s;
      // A decision the email makes for you (the price it quotes, the hiring call
      // it states) is logged as decided, not dropped.
      let base = s;
      const settled: string[] = [];
      for (const dec of s.decisions) {
        if (!dec.whileDraft || dec.thread !== t0.id || dec.chosen) continue;
        const opt = dec.options.find((o) => o.primary);
        if (!opt) continue;
        base = reducer(base, { type: 'resolve', key: `dec:${dec.id}`, option: opt.id, via: 'send' });
        settled.push(opt.label);
      }
      const t = base.threads.find((x) => x.id === a.id)!;
      const draft = t.draft!;
      const msg = {
        id: `sent-${Date.now()}`,
        from: 'me',
        to: draft.to,
        cc: draft.cc,
        at: NOW,
        body: draft.body.split(/\n\n+/),
        attachments: draft.attachments,
        // A thread's draft holds uploaded files (each with its id). The server checks every one before anything is sent.
        ...(draft.files?.length ? { files: draft.files as MailFile[] } : {}),
      };
      const track = a.track && draft.trackAs;
      const promise = promiseIn(draft.body);
      // Tasks this email finishes (not when it only promises to do them later): the ones the draft names, and the
      // email's reply-type to-dos. Any others still open keep it in Follow Up.
      const ticks = promise ? [] : [...new Set([...(draft.completes ?? []).filter((id) => base.ws.tasks[id] && base.ws.tasks[id]!.status !== 'done'), ...doneByReply(base.ws.tasks, t.id, draft.body).map((x) => x.id)])];
      const left = openTodos(base.ws.tasks, t.id).filter((x) => !ticks.includes(x.id)).length;
      const box: Box = track ? 'waiting' : t.box === 'waiting' ? 'waiting' : promise ? 'follow-up' : left ? 'follow-up' : 'archived';
      const steps = t.steps?.map((st) => (isSendStep(st) ? { ...st, done: true } : st));
      const updated: Thread = {
        ...t,
        box,
        draft: undefined,
        steps,
        messages: [...t.messages, msg],
        waiting: track
          ? { on: draft.trackAs!.on, item: draft.trackAs!.item, due: draft.trackAs!.due, since: NOW }
          : t.waiting,
        ask: track
          ? `${firstName(draft.trackAs!.on)} owes you: ${lowerFirst(draft.trackAs!.item)} by ${fmtDay(draft.trackAs!.due)}`
          : promise
            ? `You promised ${firstName(draft.to[0]!)}: ${promise}`
            : t.ask,
        context: track ? 'Timmy will draft a nudge if the date slips.' : promise ? 'Your reply made a promise. This stays in Follow Up until you do it.' : t.context,
        history: [
          ...(t.history ?? []),
          { at: NOW, text: track ? `Sent. Moved to [02] Waiting until ${fmtDay(draft.trackAs!.due)}` : promise ? `Sent. You promised to ${promise}; kept in [01] Follow Up` : left ? `Sent. ${capFirst(todoCount(left))} still open, so it stays in [01] Follow Up` : 'Sent' },
          ...(ticks.length ? [{ at: NOW, text: `The email ticked off: ${ticks.map((id) => base.ws.tasks[id]?.title ?? id).join('; ')}` }] : []),
        ],
      };
      let threads = patch(base.threads, a.id, () => updated);
      let approvalLog = recorded(base, { key: `draft:${t.id}`, kind: 'email', title: draft.subject, choice: track ? 'Sent and tracked' : 'Sent', approved: true, thread: t.id });
      let space = base.ws;
      let deals = base.deals;
      const notes: string[] = [];

      if (ticks.length) space = applyOps(space, ticks.map((id) => wsPatch('tasks', id, { status: 'done' })));

      // The CRM follows: last touch, and what you're now waiting for.
      if (t.deal && deals[t.deal]) {
        const deal = deals[t.deal]!;
        const next = track
          ? { item: draft.trackAs!.item, on: draft.trackAs!.on, due: draft.trackAs!.due }
          : deal.owner === 'me' && t.box !== 'waiting'
            ? { item: `Reply from ${firstName(draft.to[0]!)}`, on: draft.to[0]!, due: undefined }
            : undefined;
        ({ deals, ws: space } = followDeal(deals, space, t.deal, { touch: `You sent “${draft.subject.replace(/^Re:\s*/, '')}”`, next }));
      }

      // This email also asks for what another thread is waiting on, so that thread's nudge isn't needed.
      const also = draft.alsoAsks;
      const sib = also ? threads.find((x) => x.id === also.thread) : undefined;
      if (also && sib?.waiting) {
        const w = sib.waiting;
        const due = also.due ?? w.due;
        const dropped = sib.draft?.kind === 'nudge' ? sib.draft : undefined;
        threads = patch(threads, sib.id, (x) => ({
          ...x,
          draft: dropped ? undefined : x.draft,
          waiting: { ...w, due, since: NOW },
          ask: `${firstName(w.on)} owes you: ${lowerFirst(w.item)}${due ? ` by ${fmtDay(due)}` : ''}`,
          context: `You asked again in “${draft.subject}”. Timmy will draft a nudge if the date slips.`,
          history: [...(x.history ?? []), { at: NOW, text: `Asked again in your reply “${draft.subject}”${dropped ? '; the separate nudge was dropped' : ''}` }],
        }));
        if (dropped) {
          approvalLog = recorded({ approvalLog }, { key: `draft:${sib.id}`, kind: 'email', title: dropped.subject, choice: 'Not needed: your reply asked', approved: false, thread: sib.id });
          notes.push(`dropped the separate nudge to ${firstName(w.on)}`);
        }
        if (sib.deal) ({ deals, ws: space } = followDeal(deals, space, sib.deal, { next: { item: w.item, on: w.on, due } }));
      }

      // Another draft repeats the ask this email just made: take the repeat out.
      for (const other of threads) {
        const al = other.draft?.alsoAsks;
        if (!al || al.thread !== t.id) continue;
        const body = al.without.reduce((b, [from, to]) => b.replace(from, to), other.draft!.body);
        threads = patch(threads, other.id, (x) => ({
          ...x,
          draft: { ...x.draft!, body, alsoAsks: undefined },
          history: [...(x.history ?? []), { at: NOW, text: `Took the repeat ask out of the draft: “${draft.subject}” already asked` }],
        }));
        if (body !== other.draft!.body) notes.push(`took the repeat ask out of “${other.draft!.subject}”`);
      }

      const where = track
        ? `Sent · tracking in [02] Waiting until ${fmtDay(draft.trackAs!.due)}`
        : box === 'archived'
          ? 'Sent · label cleared and archived'
          : left && !promise
            ? `Sent · ${todoCount(left)} still open, kept in Follow Up`
            : 'Sent';
      const ticked = ticks.length ? `Ticked off ${ticks.length === 1 ? `“${clipped(base.ws.tasks[ticks[0]!]?.title ?? '')}”` : todoCount(ticks.length)}` : '';
      const extra = [ticked, settled.length ? `Logged your call: ${settled.join(', ')}` : '', notes.length ? `Timmy ${notes.join(' and ')}` : ''].filter(Boolean).join('. ');
      return {
        ...base,
        threads,
        deals,
        ws: space,
        activity: logged(base, `You sent “${draft.subject}”${track ? ' and Timmy started tracking the reply' : ''}`, 'send', t.id),
        approvalLog,
        toasts: withToast(s, extra ? `${where}. ${extra}.` : where, snap(s)),
      };
    }

    case 'toggleStep':
      return {
        ...s,
        threads: patch(s.threads, a.id, (x) => ({
          ...x,
          steps: x.steps?.map((st) => (st.id === a.step ? { ...st, done: !st.done } : st)),
        })),
      };

    case 'applyDeal': {
      const deal = s.deals[a.id];
      if (!deal) return s;
      // Acme's value follows the price you approved ($58, or $62 if you kept it).
      const kept = s.decisions.find((x) => x.id === 'acme-price')?.chosen?.option === 'hold';
      const nextDeal: Deal =
        a.id === 'acme'
          ? { ...deal, value: kept ? 89280 : 83520, stage: 'Proposal sent', suggestion: undefined }
          : { ...deal, stage: 'Closed won', suggestion: undefined };
      return {
        ...s,
        deals: { ...s.deals, [a.id]: nextDeal },
        threads: tickDealSteps(s.threads, a.id),
        activity: logged(s, `Updated ${deal.company}: ${nextDeal.stage}, ${money(nextDeal.value)}`, 'crm'),
        approvalLog: recorded(s, { key: `crm:${a.id}`, kind: 'crm', title: `Update ${deal.company} to ${nextDeal.stage}, ${money(nextDeal.value)}`, choice: 'Updated', approved: true }),
        toasts: withToast(s, `${deal.company} updated · ${nextDeal.stage}, ${money(nextDeal.value)}`, snap(s)),
      };
    }

    case 'editDeal': {
      const deal = s.deals[a.id];
      if (!deal) return s;
      const next: Deal = { ...deal, stage: a.stage ?? deal.stage, value: a.value ?? deal.value, suggestion: a.stage ? undefined : deal.suggestion };
      const what = [a.stage && a.stage !== deal.stage ? next.stage : '', a.value !== undefined && a.value !== deal.value ? money(next.value) : ''].filter(Boolean).join(', ');
      return {
        ...s,
        deals: { ...s.deals, [a.id]: next },
        threads: tickDealSteps(s.threads, a.id),
        activity: logged(s, `Updated ${deal.company}: ${what}`, 'crm'),
        approvalLog: recorded(s, { key: `crm:${a.id}`, kind: 'crm', title: `Update ${deal.company} to ${what}`, choice: 'Updated from Ask Timmy', approved: true }),
        toasts: withToast(s, `${deal.company} updated · ${what}`, snap(s)),
      };
    }

    case 'runStep': {
      const t = s.threads.find((x) => x.id === a.id);
      const st = t?.steps?.find((x) => x.id === a.step);
      if (!t || !st?.run) return s;
      const tick = (from: State, note: string): State => ({
        ...from,
        threads: patch(from.threads, t.id, (x) => ({
          ...x,
          steps: x.steps?.map((y) => (y.id === st.id ? { ...y, done: true } : y)),
          history: [...(x.history ?? []), { at: NOW, text: note }],
        })),
      });
      const already = (text: string) => tick({ ...s, toasts: withToast(s, text) }, `Ticked “${st.text}”`);
      const run = st.run;
      if (run.do === 'send') {
        if (!t.draft) return already('Nothing left to send: the reply already went out.');
        // sendDraft ticks the send steps and offers Undo.
        return tick(reducer(s, { type: 'sendDraft', id: t.id, track: true }), `Did “${st.text}”`);
      }
      if (run.do === 'deal') {
        const deal = t.deal ? s.deals[t.deal] : undefined;
        if (!deal) return already('This thread has no deal to update.');
        if (deal.stage === 'Closed won' || deal.stage === 'Proposal sent') return already(`${deal.company} is already up to date.`);
        return tick(reducer(s, { type: 'applyDeal', id: deal.id }), `Did “${st.text}”`);
      }
      if (run.do === 'decide') {
        const dec = s.decisions.find((x) => x.id === run.decision);
        if (!dec) return s;
        if (dec.chosen) return already(`Already decided: ${dec.options.find((o) => o.id === dec.chosen!.option)?.label ?? 'done'}.`);
        return tick(reducer(s, { type: 'resolve', key: `dec:${dec.id}`, option: run.option }), `Did “${st.text}”`);
      }
      // Block focus time.
      const [h, m] = run.start.split(':').map(Number);
      const [y, mo, d] = run.day.split('-').map(Number);
      const start = new Date(y!, mo! - 1, d!, h!, m!);
      const end = new Date(start.getTime() + run.minutes * 60000);
      const clash = Object.values(s.ws.events).some((e) => e.start < end && e.end > start && e.kind !== 'personal');
      if (clash) return { ...s, toasts: withToast(s, `${fmtDay(start)} ${fmtShortClock(start)} is taken. Use Block time on the thread to pick another slot.`, undefined, 'warn') };
      const id = `ev-step-${t.id}-${st.id}`;
      const when = `${fmtDay(start)}, ${fmtShortClock(start)}–${fmtShortClock(end)}`;
      return tick(
        {
          ...s,
          ws: applyOps(s.ws, [put('events', { id, title: run.title, start, end, kind: 'focus', with: [], thread: t.id })]),
          activity: logged(s, `Blocked ${when} for “${run.title.replace(/^Focus: /, '')}”`, 'calendar', t.id),
          toasts: withToast(s, `Blocked ${when} for ${run.title.replace(/^Focus: /, '')}`, snap(s)),
        },
        `Blocked ${when}`,
      );
    }

    case 'toggleRule': {
      const rules = s.rules.map((r) => (r.id === a.id ? { ...r, enabled: !r.enabled } : r));
      const rule = rules.find((r) => r.id === a.id);
      // A sorting rule switched back on sorts what is waiting again, the same as a new one.
      if (!rule?.mail || !rule.enabled) return { ...s, rules };
      const swept = sweepRule(s.threads, s.ws.tasks, rule, rules);
      return { ...s, rules, threads: swept.threads, ws: swept.tasks === s.ws.tasks ? s.ws : { ...s.ws, tasks: swept.tasks } };
    }

    case 'addRule': {
      if (!a.mail) {
        return {
          ...s,
          rules: [...s.rules, { id: `rule-${Date.now()}`, group: a.group, text: a.text, enabled: true, hits: 0 }],
          toasts: withToast(s, 'Rule added. Timmy applies it from the next triage run.'),
        };
      }
      const rule: Rule = { id: `rule-${Date.now().toString(36)}${liveSuffix()}`, group: 'triage', text: a.text.trim() || describeMailRule(a.mail, s.ws.projects), enabled: true, hits: 0, mail: a.mail };
      const rules = [...s.rules, rule];
      const swept = sweepRule(s.threads, s.ws.tasks, rule, rules);
      const project = a.mail.then.project ? s.ws.projects[a.mail.then.project] : undefined;
      const done = [
        swept.suggested ? `${swept.suggested} waiting in Triage now ${swept.suggested === 1 ? 'has' : 'have'} it as Timmy’s suggestion` : '',
        swept.placed && project ? `${swept.placed} ${swept.placed === 1 ? 'email' : 'emails'} put in ${project.name}` : '',
      ].filter(Boolean);
      const ahead = a.mail.then.box === 'archived' || a.mail.then.box === 'read-through' ? ' New mail it matches is filed as it arrives, in your mailbox too.' : '';
      return {
        ...s,
        rules,
        threads: swept.threads,
        ws: swept.tasks === s.ws.tasks ? s.ws : { ...s.ws, tasks: swept.tasks },
        activity: logged(s, `Added a sorting rule: ${rule.text}`, 'triage'),
        toasts: withToast(s, `Rule saved.${done.length ? ` ${done.join('; ')}.` : ''}${ahead}`, snap(s)),
      };
    }

    case 'removeRule': {
      const rule = s.rules.find((r) => r.id === a.id);
      if (!rule || rule.locked) return s;
      return { ...s, rules: s.rules.filter((r) => r.id !== a.id), toasts: withToast(s, 'Rule deleted.', snap(s)) };
    }

    case 'setProject': {
      const t = s.threads.find((x) => x.id === a.id);
      if (!t) return s;
      const project = a.project ? s.ws.projects[a.project] : undefined;
      if (a.project && !project) return s;
      if ((t.project ?? null) === (a.project ?? null)) return s;
      const before = t.project ? s.ws.projects[t.project] : undefined;
      // The thread's to-dos follow it, unless the person put one somewhere else themselves.
      const tasks = Object.values(s.ws.tasks).filter((x) => x.thread === t.id && (x.project ?? null) === (t.project ?? null));
      const ws = tasks.length ? { ...s.ws, tasks: { ...s.ws.tasks, ...Object.fromEntries(tasks.map((x) => [x.id, { ...x, project: a.project ?? undefined }])) } } : s.ws;
      const text = project ? `Put “${t.subject}” in ${project.name}` : `Took “${t.subject}” out of ${before?.name ?? 'its project'}`;
      return {
        ...s,
        ws,
        threads: patch(s.threads, a.id, (x) => ({ ...x, project: a.project ?? undefined, maybeProject: undefined, history: [...(x.history ?? []), { at: stamp(), text: project ? `You put this in ${project.name}` : `You took this out of ${before?.name ?? 'its project'}` }] })),
        activity: logged(s, text, 'move', t.id),
        toasts: withToast(s, project ? `In ${project.name}` : `Out of ${before?.name ?? 'the project'}`, snap(s)),
      };
    }

    case 'dismissProjectGuess': {
      const t = s.threads.find((x) => x.id === a.id);
      if (!t?.maybeProject) return s;
      const guess = s.ws.projects[t.maybeProject];
      return {
        ...s,
        threads: patch(s.threads, a.id, (x) => ({
          ...x,
          maybeProject: undefined,
          notProjects: [...new Set([...(x.notProjects ?? []), t.maybeProject!])].slice(-10),
          history: [...(x.history ?? []), { at: stamp(), text: `You said it isn’t about ${guess?.name ?? 'that project'}` }],
        })),
        toasts: withToast(s, `Not ${guess?.name ?? 'that project'}. Timmy won’t ask about it again for this email.`, snap(s)),
      };
    }

    case 'dismiss':
      return { ...s, dismissed: [...s.dismissed, a.key] };

    case 'setHighlight':
      return { ...s, highlight: a.text, highlightDone: false };

    case 'toggleHighlight':
      return { ...s, highlightDone: !s.highlightDone };

    case 'toast':
      return { ...s, toasts: withToast(s, a.text, undefined, a.tone) };

    case 'dismissToast':
      return { ...s, toasts: s.toasts.filter((t) => t.id !== a.id) };

    case 'restore': {
      const t = s.toasts.find((x) => x.id === a.toast);
      if (!t?.undo) return s;
      return { ...s, ...t.undo, toasts: s.toasts.filter((x) => x.id !== a.toast) };
    }

    case 'search':
      return { ...s, searchOpen: a.open, searchQuery: a.query ?? (a.open ? s.searchQuery : '') };

    case 'drawer':
      return { ...s, drawer: s.drawer === a.drawer ? null : a.drawer };

    case 'ws': {
      // Ticking off an email's last to-do files the email too (followTasks); the notice says so and Undo covers both.
      const { state: followed, notes } = followTasks({ ...s, ws: applyOps(s.ws, a.ops) }, s.ws.tasks);
      const filed = notes.length ? `${capFirst(notes.join('; '))}.` : '';
      const toast = a.toast ? (filed ? `${a.toast.replace(/\.$/, '')}. ${filed}` : a.toast) : filed;
      return {
        ...followed,
        activity: a.log ? logged(followed, a.log, 'file') : followed.activity,
        toasts: toast ? withToast(s, toast, a.undo || filed ? snap(s) : undefined, a.tone) : s.toasts,
      };
    }

    case 'compose':
      return { ...s, compose: a.draft };

    case 'capture':
      return { ...s, capture: a.open };

    case 'sendNew': {
      const d = a.draft;
      const tid = `sent-${Date.now().toString(36)}`;
      const track = d.track?.item ? d.track : null;
      const on = track?.on ?? d.to[0] ?? 'me';
      const due = dueDate(track?.due);
      const names = d.to.map(firstName).join(', ');
      const thread: Thread = {
        id: tid,
        subject: d.subject.trim() || '(no subject)',
        box: track ? 'waiting' : 'archived',
        project: d.project,
        participants: [...new Set([...d.to, ...(d.cc ?? []), 'me'])],
        messages: [{ id: `${tid}-1`, from: 'me', to: d.to, cc: d.cc, at: NOW, body: d.body.split(/\n\n+/), ...(d.files?.length ? { files: d.files } : {}) }],
        ask: track
          ? `${firstName(on)} owes you: ${lowerFirst(track.item)}${due ? ` by ${fmtDay(due)}` : ''}`
          : `You wrote to ${names}`,
        waiting: track ? { on, item: track.item, due, since: NOW } : undefined,
        context: track ? 'Timmy will draft a nudge if the date slips.' : undefined,
        history: [{ at: NOW, text: track ? `Sent and tracked in [02] Waiting${due ? ` until ${fmtDay(due)}` : ''}` : 'Sent' }],
      };
      const inv = d.invoice ? s.ws.invoices[d.invoice] : undefined;
      const sentInvoice: Invoice | undefined = inv && inv.status !== 'void' ? { ...inv, status: inv.status === 'draft' ? 'sent' : inv.status, sentAt: NOW, thread: tid } : undefined;
      return {
        ...s,
        compose: null,
        threads: [thread, ...s.threads],
        ...(sentInvoice ? { ws: { ...s.ws, invoices: { ...s.ws.invoices, [sentInvoice.id]: sentInvoice } } } : {}),
        activity: logged(s, `You sent “${thread.subject}”${track ? ' and Timmy started tracking the reply' : ''}`, 'send', tid),
        toasts: withToast(s, track ? `Sent · tracking in [02] Waiting${due ? ` until ${fmtDay(due)}` : ''}` : `Sent to ${names}`, snap(s)),
      };
    }

    case 'newInvoice': {
      if (s.ws.invoices[a.id] || (a.kind !== 'invoice' && a.kind !== 'quote')) return s;
      const settings = s.ws.billing.settings ?? defaultBilling(PEOPLE.me?.company || 'Your business', PEOPLE.me?.email || undefined);
      const quote = a.fromQuote ? s.ws.invoices[a.fromQuote] : undefined;
      if (a.fromQuote && quote?.kind !== 'quote') return s;
      const contact = a.contact ? s.ws.contacts[a.contact] : undefined;
      const thread = a.thread ? s.threads.find((t) => t.id === a.thread) : undefined;
      const who = thread ? counterpart(thread) : undefined;
      // The name the email itself carries for a real mailbox's sender, before one guessed from their address.
      const named = who ? thread?.ext?.people?.[who] : undefined;
      const person = who ? (named ? { name: named.name, email: named.email, company: undefined, internal: false } : (PEOPLE[who] ?? personFromMail(who))) : undefined;
      const client: Invoice['client'] = quote
        ? quote.client
        : contact
          ? { contact: contact.id, name: contact.name, email: contact.email, ...(contact.company ? { company: contact.company } : {}) }
          : person && who !== 'me'
            ? { name: person.name, ...(person.email ? { email: person.email } : {}), ...(person.company && !person.internal ? { company: person.company } : {}) }
            : { name: '' };
      const items = quote ? quote.items.filter(lineCounts).map((l, i) => ({ id: `${a.id}-${i + 1}`, description: l.description, qty: l.qty, unitPrice: l.unitPrice, ...(l.taxRate ? { taxRate: l.taxRate } : {}) })) : undefined;
      const project = quote?.project ?? a.project ?? thread?.project;
      const { invoice, settings: next } = newDraft(settings, a.kind, a.id, new Date(NOW), {
        client,
        ...(items ? { items } : {}),
        ...(project ? { project } : {}),
        ...((quote?.thread ?? a.thread) ? { thread: quote?.thread ?? a.thread } : {}),
        ...(quote ? { fromQuote: quote.id, ...(quote.intro ? { intro: quote.intro } : {}), ...(quote.discount ? { discount: quote.discount } : {}) } : {}),
      });
      const label = a.kind === 'invoice' ? 'Invoice' : 'Quote';
      return {
        ...s,
        ws: { ...s.ws, invoices: { ...s.ws.invoices, [a.id]: invoice }, billing: { ...s.ws.billing, settings: next } },
        route: { view: 'invoice', id: a.id },
        back: s.route,
        activity: logged(s, quote ? `Turned quote ${quote.number} into invoice ${invoice.number}` : `Started ${label.toLowerCase()} ${invoice.number}`, 'file'),
        toasts: withToast(s, quote ? `Invoice ${invoice.number} made from quote ${quote.number}` : `${label} ${invoice.number} started`, snap(s)),
      };
    }

    case 'invoice': {
      const inv = s.ws.invoices[a.id];
      if (!inv) return s;
      const quote = inv.kind === 'quote';
      const at = new Date(NOW);
      let next: Invoice | null = null;
      let said = '';
      if (a.op === 'paid' && !quote && inv.status !== 'paid' && inv.status !== 'void') {
        next = { ...inv, status: 'paid', paidAt: at };
        said = `${inv.number} marked paid`;
      } else if ((a.op === 'accepted' || a.op === 'declined') && quote && inv.status !== 'void') {
        next = a.op === 'accepted' ? { ...inv, status: 'accepted', acceptedAt: at, declinedAt: undefined } : { ...inv, status: 'declined', declinedAt: at, acceptedAt: undefined };
        said = a.op === 'accepted' ? `Quote ${inv.number} accepted. You can turn it into an invoice.` : `Quote ${inv.number} marked declined`;
      } else if (a.op === 'void' && inv.status !== 'paid' && inv.status !== 'void') {
        next = { ...inv, status: 'void', voidedAt: at };
        said = `${inv.number} is void`;
      } else if (a.op === 'reopen' && inv.status !== 'draft' && inv.status !== 'sent') {
        next = { ...inv, status: inv.sentAt ? 'sent' : 'draft', paidAt: undefined, acceptedAt: undefined, declinedAt: undefined, voidedAt: undefined };
        said = `${inv.number} is open again`;
      }
      if (!next) return s;
      // Paid: the email it went out in has nothing more to wait for, so it leaves Waiting (and the mailbox's label).
      const waiting = a.op === 'paid' && inv.thread ? s.threads.find((t) => t.id === inv.thread && t.box === 'waiting') : undefined;
      return {
        ...s,
        ws: { ...s.ws, invoices: { ...s.ws.invoices, [inv.id]: next } },
        threads: waiting ? patch(s.threads, waiting.id, (x) => ({ ...moveThread(x, 'archived'), history: [...(x.history ?? []), { at: NOW, text: `Paid: ${inv.number}. Nothing more to wait for, so it is archived` }] })) : s.threads,
        activity: logged(s, said, 'file'),
        toasts: withToast(s, waiting ? `${said}. Its email left Waiting.` : said, snap(s)),
      };
    }

    case 'reply': {
      const t = s.threads.find((x) => x.id === a.id);
      if (!t) return s;
      const to = [...new Set(t.messages.map((m) => m.from).filter((p) => p !== 'me'))];
      const msg = { id: `reply-${Date.now().toString(36)}`, from: 'me', to: to.length ? to : t.participants.filter((p) => p !== 'me'), at: NOW, body: a.body.split(/\n\n+/), ...(a.files?.length ? { files: a.files } : {}) };
      const track = a.track?.item ? a.track : null;
      const due = dueDate(track?.due);
      // The reply does the email's reply-type to-dos ("Reply to Dana", "Send Sam the deck"); any others keep it in Follow Up.
      const ticked = doneByReply(s.ws.tasks, t.id, a.body);
      const tasks = ticked.length ? { ...s.ws.tasks, ...Object.fromEntries(ticked.map((x) => [x.id, { ...x, status: 'done' as const }])) } : s.ws.tasks;
      const left = openTodos(tasks, t.id).length;
      const box: Box = track ? 'waiting' : t.box === 'follow-up' || t.box === 'inbox' ? (left ? 'follow-up' : 'archived') : t.box;
      const next: Thread = {
        ...t,
        box,
        draft: undefined,
        unread: false,
        suggestion: undefined,
        messages: [...t.messages, msg],
        waiting: track ? { on: track.on, item: track.item, due, since: NOW } : t.waiting,
        ask: track ? `${firstName(track.on)} owes you: ${lowerFirst(track.item)}${due ? ` by ${fmtDay(due)}` : ''}` : t.ask,
        history: [
          ...(t.history ?? []),
          { at: NOW, text: track ? `Replied and tracked in [02] Waiting${due ? ` until ${fmtDay(due)}` : ''}` : box === 'follow-up' && left ? `Replied; ${todoCount(left)} still open, so it stays in [01] Follow Up` : 'Replied' },
          ...(ticked.length ? [{ at: NOW, text: `The reply ticked off: ${ticked.map((x) => x.title).join('; ')}` }] : []),
        ],
      };
      const where = track ? `Replied · tracking in [02] Waiting${due ? ` until ${fmtDay(due)}` : ''}` : box === 'archived' ? 'Replied · label cleared and archived' : box === 'follow-up' && left ? `Replied · ${todoCount(left)} still open, kept in Follow Up` : 'Replied';
      const tickNote = ticked.length ? ` · ticked off ${ticked.length === 1 ? `“${clipped(ticked[0]!.title)}”` : todoCount(ticked.length)}` : '';
      return {
        ...s,
        ws: ticked.length ? { ...s.ws, tasks } : s.ws,
        threads: patch(s.threads, a.id, () => next),
        activity: logged(s, `You replied to “${t.subject}”`, 'send', t.id),
        toasts: withToast(s, `${where}${tickNote}`, snap(s)),
      };
    }

    case 'setSchedule': {
      const schedule = { ...s.schedule, ...a.schedule };
      const next = nextRun(schedule);
      const timeChanged = a.schedule.time !== undefined || a.schedule.days !== undefined;
      return {
        ...s,
        schedule,
        rules: s.rules.map((r) => (r.id === 's1' ? { ...r, text: scheduleRule(schedule) } : r)),
        toasts: timeChanged
          ? withToast(
              s,
              next
                ? `Morning run: ${daysLabel(schedule.days).toLowerCase()} at ${fmtClock(schedule.time)}. Next run ${whenLabel(next)}.`
                : 'Morning run paused. Pick at least one day to restart it.',
              undefined,
              next ? undefined : 'warn',
            )
          : s.toasts,
      };
    }

    case 'setFocus': {
      const on = a.on ?? !s.focus;
      const where = s.scope ? s.ws.projects[s.scope]?.name : null;
      return {
        ...s,
        focus: on,
        drawer: null,
        toasts: withToast(s, on ? `Focus mode on${where ? ` for ${where}` : ''}. Only what needs you is showing.` : 'Focus mode off'),
      };
    }

    case 'setPrefs': {
      const next = { ...s, calm: a.calm ?? s.calm, showDeals: a.showDeals ?? s.showDeals };
      const text =
        a.calm !== undefined && a.calm !== s.calm
          ? a.calm
            ? 'Calm home on: fewer badges and a shorter brief.'
            : 'Calm home off: everything is back.'
          : a.showDeals !== undefined && a.showDeals !== s.showDeals
            ? a.showDeals
              ? 'Deals and the CRM are showing.'
              : 'Deals and the CRM are hidden. Turn them back on in Appearance.'
            : '';
      return { ...next, toasts: text ? withToast(s, text) : s.toasts };
    }

    case 'setScope': {
      if (a.project === s.scope) return s;
      const p = a.project ? s.ws.projects[a.project] : null;
      if (a.project && !p) return s;
      // A screen about one project follows the pick, so the picker never says one project while the page shows
      // another: a project's page or its Mail folder opens the picked project's, on the same tab; on Tasks, a project
      // chosen on the board gives way to the picker (or to every project, for "All projects").
      const r = s.route;
      const route: Route =
        p && r.view === 'project'
          ? { ...r, id: p.id }
          : p && r.view === 'box' && !BOXES.some((b) => b.id === r.box)
            ? { ...r, box: p.id }
            : r.view === 'tasks' && r.project
              ? { ...r, project: undefined }
              : r;
      return { ...s, scope: p ? p.id : null, ...(route !== r ? { route, back: r } : {}), toasts: withToast(s, p ? `Showing ${p.name} only` : 'Showing all projects') };
    }

    case 'setUrgency': {
      const t = s.threads.find((x) => x.id === a.id);
      if (!t) return s;
      const text =
        a.level === 'urgent'
          ? 'Marked urgent. Timmy will rank mail like this higher.'
          : a.level === 'later'
            ? 'Marked as able to wait. It drops out of the urgent list.'
            : 'Timmy ranks this thread again.';
      return {
        ...s,
        threads: patch(s.threads, a.id, (x) => ({ ...x, urgency: a.level ?? undefined })),
        toasts: withToast(s, text, snap(s)),
      };
    }

    case 'resolve': {
      const [kind, id] = a.key.split(':') as [string, string];
      // Live mode: a write Timmy proposed. The server decides; the card leaves the queue.
      if (kind === 'eff') return { ...s, pending: s.pending.filter((e) => e.id !== id) };
      if (kind === 'draft') {
        return reducer(s, a.option === 'send' ? { type: 'sendDraft', id, track: true } : { type: 'discardDraft', id });
      }
      if (kind === 'camp') {
        const c = s.out.campaigns[id];
        if (!c) return s;
        if (a.option === 'launch') return reducer(s, { type: 'out', op: { op: 'launch', id } });
        return {
          ...s,
          out: { ...s.out, campaigns: { ...s.out.campaigns, [id]: { ...c, status: 'draft' } } },
          approvalLog: recorded(s, { key: a.key, kind: 'campaign', title: `Launch “${c.name}”`, choice: 'Not yet', approved: false }),
          toasts: withToast(s, `“${c.name}” moved back to drafts. Launch it from Campaigns when it’s ready.`, snap(s)),
        };
      }
      if (kind === 'crm') {
        const deal = s.deals[id];
        if (!deal) return s;
        if (a.option !== 'apply' || !a.change) {
          return {
            ...s,
            dismissed: [...s.dismissed, a.key],
            approvalLog: recorded(s, { key: a.key, kind: 'crm', title: `Update ${deal.company}`, choice: 'Not now', approved: false }),
            toasts: withToast(s, `Skipped. ${deal.company} stays as it is.`, snap(s)),
          };
        }
        const next: Deal = { ...deal, stage: a.change.stage, value: a.change.value, suggestion: undefined };
        return {
          ...s,
          deals: { ...s.deals, [id]: next },
          threads: tickDealSteps(s.threads, id),
          activity: logged(s, `Updated ${deal.company}: ${next.stage}, ${money(next.value)}`, 'crm'),
          approvalLog: recorded(s, { key: a.key, kind: 'crm', title: `Update ${deal.company} to ${next.stage}, ${money(next.value)}`, choice: 'Updated', approved: true }),
          toasts: withToast(s, `${deal.company} updated · ${next.stage}, ${money(next.value)}`, snap(s)),
        };
      }
      // A decision Timmy brought to you.
      const dec = s.decisions.find((x) => x.id === id);
      const opt = dec?.options.find((o) => o.id === a.option);
      if (!dec || !opt || dec.chosen) return s;
      let threads = s.threads;
      let wsNext = s.ws;
      let compose = s.compose;
      let deals = s.deals;
      for (const e of opt.effects) {
        if (e.do === 'note') wsNext = applyOps(wsNext, decisionOps(wsNext, e.project, e.text, 'Approvals'));
        else if (e.do === 'ws') wsNext = applyOps(wsNext, e.ops);
        else if (e.do === 'compose') compose = e.draft;
        else if (e.do === 'step')
          threads = patch(threads, e.thread, (x) => ({ ...x, steps: x.steps?.map((st) => (st.id === e.step ? { ...st, done: true } : st)) }));
        else if (e.do === 'redraft')
          threads = patch(threads, e.thread, (x) =>
            x.draft ? { ...x, draft: { ...x.draft, body: e.replace.reduce((b, [from, to]) => b.replace(from, to), x.draft.body) } } : x,
          );
        else if (e.do === 'steptext')
          threads = patch(threads, e.thread, (x) => ({ ...x, steps: x.steps?.map((st) => (st.id === e.step ? { ...st, text: e.text } : st)) }));
        else if (e.do === 'retext') wsNext = retext(wsNext, e.file, e.replace);
        else if (e.do === 'dealHint') deals = deals[e.deal] ? { ...deals, [e.deal]: { ...deals[e.deal]!, suggestion: e.text } } : deals;
        else if (e.do === 'cell') {
          const sheet = wsNext.sheets[e.sheet];
          if (sheet?.rows[e.row])
            wsNext = applyOps(wsNext, [
              wsPatch('sheets', e.sheet, { rows: sheet.rows.map((r, i) => (i === e.row ? { ...r, [e.col]: e.value } : r)) }),
              wsPatch('files', e.sheet, { updated: NOW }),
            ]);
        } else if (e.do === 'draft')
          threads = patch(threads, e.thread, (x) => ({
            ...(x.box === 'inbox' ? moveThread(x, 'follow-up') : x),
            draft: e.draft,
            history: [...(x.history ?? []), { at: NOW, text: `Drafted a reply after you chose “${opt.label}”` }],
          }));
      }
      return {
        ...s,
        threads,
        ws: wsNext,
        deals,
        compose,
        decisions: s.decisions.map((x) => (x.id === dec.id ? { ...x, chosen: { option: opt.id, at: NOW } } : x)),
        activity: logged(s, a.via === 'send' ? `Your email settled “${dec.title}”: ${opt.label}` : `You decided “${dec.title}”: ${opt.label}`, 'approval', dec.thread),
        approvalLog: recorded(s, { key: a.key, kind: dec.kind, title: dec.title, choice: a.via === 'send' ? `${opt.label}, by sending the email` : opt.label, approved: !opt.holds, thread: dec.thread }),
        // When the email made the call, the send notice says so; no second notice.
        toasts: a.via === 'send' ? s.toasts : withToast(s, opt.result, snap(s)),
      };
    }

    case 'conn':
      return connect(s, a.op, connHelpers);

    case 'chat':
      return chat(s, a.op, { toast: (st, text) => withToast(st, text) });

    case 'client': {
      const cl = s.clients;
      if (a.create) {
        const id = `client-${Date.now().toString(36)}`;
        return {
          ...s,
          out: blankOutbound(a.create, s.out),
          route: { view: 'outbound', tab: 'templates' },
          clients: { active: id, names: { ...cl.names, [id]: a.create }, stash: { ...cl.stash, [cl.active]: s.out } },
          toasts: withToast(s, `Client workspace “${a.create}” created. Start with their offer; mailboxes, leads, campaigns and the Unibox are their own.`),
        };
      }
      const next = a.to ? cl.stash[a.to] : undefined;
      if (!a.to || a.to === cl.active || !next) return s;
      const { [a.to]: _taken, ...rest } = cl.stash;
      return {
        ...s,
        out: next,
        route: s.route.view === 'campaign' ? { view: 'outbound', tab: 'campaigns' } : s.route,
        clients: { ...cl, active: a.to, stash: { ...rest, [cl.active]: s.out } },
        toasts: withToast(s, `Now in ${cl.names[a.to]}.`),
      };
    }

    case 'release': {
      const h = s.conn.held.find((x) => x.id === a.id);
      if (!h) return s;
      const rest = { ...s, conn: { ...s.conn, held: s.conn.held.filter((x) => x.id !== a.id) } };
      const approver = h.who.replace(/ \(.*\)$/, '');
      if (!a.approve) {
        return {
          ...rest,
          approvalLog: recorded(rest, { key: h.key, kind: h.key.startsWith('crm') ? 'crm' : h.key.startsWith('dec') ? 'decision' : 'email', title: h.title, choice: `Declined by ${approver}`, approved: false }),
          activity: logged(rest, `${approver} declined: ${h.title}`, 'approval'),
          toasts: withToast(rest, `${approver} declined “${h.title}”. Nothing changed.`),
        };
      }
      const done = reducer(rest, h.action);
      // The record says who approved it and who asked.
      const [first, ...older] = done.approvalLog;
      const approvalLog = first && first.key === h.key ? [{ ...first, choice: `${first.choice} · approved by ${approver}${h.by !== 'you' ? `, asked by ${h.by}` : ''}` }, ...older] : done.approvalLog;
      return { ...done, approvalLog, toasts: withToast(done, `${approver} approved: ${h.title}`, snap(rest)) };
    }

    case 'out':
      return outbound(s, a.op, {
        toast: (st, text, o) => withToast(st, text, o?.undo ? snap(st) : undefined, o?.tone),
        log: (st, text, kind) => logged(st, text, kind),
      });

    case 'reset':
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* storage unavailable */
      }
      return { ...initial, toasts: a.quiet ? [] : withToast(initial, 'Demo data reset') };

    case 'reload': {
      const next = load();
      return { ...next, toasts: a.toast ? withToast(next, a.toast) : [] };
    }

    case 'makeDraft': {
      const t = s.threads.find((x) => x.id === a.id);
      if (!t || (t.draft && !a.note)) return s;
      const draft = draftFor(t, a.note);
      const nudge = draft.kind === 'nudge';
      const what = a.note ? `Drafted a reply from your words: “${a.note.trim()}”` : nudge ? 'Drafted a nudge on request' : 'Drafted a reply on request';
      return {
        ...s,
        threads: patch(s.threads, a.id, (x) => ({ ...x, draft, history: [...(x.history ?? []), { at: NOW, text: what }] })),
        toasts: withToast(s, `Timmy drafted a ${nudge ? 'nudge' : 'reply'} to ${firstName(draft.to[0]!)}. Nothing is sent until you approve it.`),
      };
    }

    case 'server':
      return { ...s, ...a.state, toasts: a.toast ? [{ id: toastSeq++, text: a.toast.text, tone: a.toast.tone, command: a.toast.command, ms: a.toast.ms }] : s.toasts };

    case 'effect':
      // The server decides; meanwhile the card leaves the queue.
      return { ...s, pending: s.pending.filter((e) => e.id !== a.id) };

    case 'undo':
      return s;

    case 'simulateReply': {
      const t = s.threads.find((x) => x.id === a.id);
      if (!t?.waiting) return s;
      const who = t.waiting.on;
      const body =
        t.id === 'acme-quote'
          ? ['Hi Taylor,', `Good news: our CFO approved the 120-seat quote at $${acmeSeatPrice(s)} per seat. Please send the order form so we can start on January 1.`, 'Thanks,\nDana']
          : ['Hi Taylor,', `Here’s the ${lowerFirst(t.waiting.item)} you asked for.`, `Thanks,\n${firstName(who)}`];
      const next: Thread = {
        ...t,
        box: 'inbox',
        unread: true,
        messages: [...t.messages, { id: `sim-${Date.now().toString(36)}`, from: who, to: ['me'], at: NOW, body }],
        ask: `${firstName(who)} delivered: ${lowerFirst(t.waiting.item)}`,
        context: 'The item you were waiting on arrived. Archive the thread and record the decision in the project notes.',
        suggestion: {
          box: 'archived',
          confidence: 'high',
          reason: 'The item you were waiting on arrived.',
          extra: t.project ? 'Record the decision in the project’s running notes' : undefined,
        },
        history: [...(t.history ?? []), { at: NOW, text: `${personName(who)} replied: the item arrived` }],
      };
      return {
        ...s,
        threads: patch(s.threads, a.id, () => next),
        activity: logged(s, `${personName(who)} delivered “${t.waiting.item}”`, 'triage', t.id),
        toasts: withToast(s, `${firstName(who)} replied · moved to [00] Inbox`),
      };
    }
  }
}

export const StoreCtx = createContext<{ state: State; dispatch: Dispatch<Action> } | null>(null);
const Ctx = StoreCtx;

/* ───────────── Saved in this browser ───────────── */

const STORAGE_KEY = 'timmy-state-v3';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const PERSISTED = ['threads', 'deals', 'activity', 'rules', 'ws', 'highlight', 'highlightDone', 'dismissed', 'route', 'back', 'decisions', 'approvalLog', 'schedule', 'focus', 'scope', 'out', 'calm', 'showDeals', 'conn', 'clients'] as const;

function load(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initial;
    const saved = JSON.parse(raw, (_k, v) => (typeof v === 'string' && ISO_DATE.test(v) ? new Date(v) : v)) as Partial<State>;
    const next = { ...initial };
    for (const key of PERSISTED) if (saved[key] !== undefined) (next as Record<string, unknown>)[key] = saved[key];
    // Collections added in later versions fall back to the seed.
    next.ws = { ...initial.ws, ...next.ws, docs: { ...initial.ws.docs, ...next.ws.docs } };
    // The Acme order form became a Timmy doc so decisions can rewrite it.
    if (next.ws.files['acme-order-form']?.sample && initial.ws.files['acme-order-form']) next.ws = { ...next.ws, files: { ...next.ws.files, 'acme-order-form': initial.ws.files['acme-order-form'] } };
    // Open decisions pick up the latest options and effects; your choices stay.
    next.decisions = next.decisions.map((d) => {
      const seed = initial.decisions.find((x) => x.id === d.id);
      return seed ? { ...seed, chosen: d.chosen } : d;
    });
    next.out = { ...initial.out, ...next.out };
    // Built-in templates follow the offer now; older saved copies are replaced.
    const templates = { ...next.out.templates };
    for (const t of Object.values(initial.out.templates)) if (t.builtIn && (templates[t.id]?.v ?? 0) < (t.v ?? 0)) templates[t.id] = t;
    next.out = { ...next.out, templates };
    next.conn = { ...initial.conn, ...next.conn, apps: { ...initial.conn.apps, ...next.conn?.apps } };
    for (const l of Object.values(next.out.leads)) if (next.ws.contacts[l.id] || l.status === 'meeting') registerPerson({ id: l.id, name: `${l.first} ${l.last}`, email: l.email, title: l.title, company: l.company });
    for (const c of Object.values(next.ws.contacts)) registerPerson({ id: c.id, name: c.name, email: c.email, title: c.title, company: c.company });
    for (const t of next.threads) for (const p of t.participants) if (p.startsWith('mail:')) registerPerson(personFromMail(p)!);
    return next;
  } catch {
    return initial;
  }
}

/** `ephemeral`: start from the demo seed and save nothing (the cinematic intro). */
export function StoreProvider({ children, ephemeral = false }: { children: ReactNode; ephemeral?: boolean }) {
  const [state, dispatch] = useReducer(reducer, undefined, ephemeral ? () => initial : load);

  useEffect(() => {
    if (ephemeral) return;
    const timer = window.setTimeout(() => {
      try {
        const out: Record<string, unknown> = {};
        for (const key of PERSISTED) out[key] = state[key];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
      } catch {
        /* storage full or unavailable: the session still works */
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [state, ephemeral]);

  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStore outside StoreProvider');
  return v;
}

// ───────────── selectors ─────────────

/** The Acme seat price you settled on: $62 if you kept it, else the $58 tier in the draft. */
export const acmeSeatPrice = (s: Pick<State, 'decisions'>) => (s.decisions.find((x) => x.id === 'acme-price')?.chosen?.option === 'hold' ? 62 : 58);

export const inBox = (threads: Thread[], id: Box | ProjectId) =>
  BOXES.some((b) => b.id === id)
    ? threads.filter((t) => t.box === id)
    : threads.filter((t) => t.project === id && t.box !== 'archived');

export const byNewest = (a: Thread, b: Thread) => lastAt(b).getTime() - lastAt(a).getTime();
export const byOldest = (a: Thread, b: Thread) => lastAt(a).getTime() - lastAt(b).getTime();
export const lastAt = (t: Thread) => t.messages[t.messages.length - 1]!.at;
export const lastFrom = (t: Thread) => t.messages[t.messages.length - 1]!.from;

/** The person to show for a thread: the latest sender who isn't you. */
export const counterpart = (t: Thread) =>
  [...t.messages].reverse().find((m) => m.from !== 'me')?.from ?? t.participants.find((p) => p !== 'me') ?? 'me';

export const isOverdue = (t: Thread) => {
  const due = t.box === 'waiting' ? t.waiting?.due : t.due;
  return !!due && due.getTime() < NOW.getTime();
};
