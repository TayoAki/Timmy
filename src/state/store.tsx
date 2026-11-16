import { createContext, useContext, useEffect, useMemo, useReducer, type Dispatch, type ReactNode } from 'react';
import { ACTIVITY, BOXES, DEALS, NOW, PROJECTS, RULES, THREADS } from '../data/mock';
import type { Activity, Box, Deal, Label, ProjectId, Rule, RuleGroup, Thread } from '../data/types';
import { DECISIONS, type Decision } from '../data/decisions';
import { WS_SEED } from '../data/ws-mock';
import type { WS } from '../data/ws-types';
import { fmtDate, fmtDay, fmtTime, money } from '../lib/format';
import type { ApprovalKind, ApprovalRecord } from './approvals';
import { draftFor } from './drafting';
import { outbound, type OutOp } from './outbound';
import { connect, connectSeed, gate, type Connect, type ConnHelpers, type ConnOp } from './connect';
import { outboundSeed } from '../data/outbound-mock';
import type { Outbound } from '../data/outbound-types';
import { DEFAULT_SCHEDULE, fmtClock, nextRun, scheduleRule, whenLabel, daysLabel, type Schedule } from './schedule';
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
  | { view: 'calendar'; tab: 'week' | 'day'; date?: string }
  | { view: 'docs'; tab: 'recent' | 'meetings' | 'templates' }
  | { view: 'file'; id: string }
  | { view: 'projects'; tab: 'active' | 'archived' }
  | { view: 'project'; id: string; tab: 'overview' | 'tasks' | 'notes' | 'mail' | 'files' | 'ai' }
  | { view: 'contact'; id: string; tab: 'overview' | 'activity'; filter?: string }
  | { view: 'library'; tab: 'prompts' | 'captured' | 'routines' | 'learned' }
  | { view: 'approvals'; tab: 'open' | 'history'; filter?: ApprovalKind }
  | { view: 'outbound'; tab: OutboundTab; list?: string; id?: string; filter?: string }
  | { view: 'campaign'; id: string; tab: 'analytics' | 'leads' | 'sequence' | 'schedule' | 'options' }
  | { view: 'social'; tab: 'overview' | 'create' | 'calendar' | 'trends' }
  | { view: 'connections'; group?: string };

export type OutboundTab = 'leads' | 'campaigns' | 'unibox' | 'speed' | 'calls' | 'templates' | 'channels';

export type Section = 'mail' | 'approvals' | 'activity' | 'people' | 'files' | 'rules' | 'tasks' | 'calendar' | 'docs' | 'projects' | 'library' | 'outbound' | 'social' | 'connections';

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
    case 'projects':
    case 'project':
      return 'projects';
    case 'library':
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
const isDetail = (r: Route) => r.view === 'thread' || r.view === 'file' || r.view === 'contact' || r.view === 'project' || r.view === 'campaign';

/** A new email or reply being written in the compose window. */
export interface ComposeDraft {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  /** Track the reply in [02] Waiting: what they owe you and by when (yyyy-mm-dd). */
  track?: { on?: string; item: string; due?: string } | null;
  project?: string;
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
}

export type Action =
  | { type: 'navigate'; route: Route }
  | { type: 'openThread'; id: string; tab?: ThreadTab }
  | { type: 'back' }
  | { type: 'move'; id: string; box: Box; quiet?: boolean }
  | { type: 'acceptSuggestion'; id: string }
  | { type: 'acceptAll'; ids: string[] }
  | { type: 'toggleStar'; id: string }
  | { type: 'markRead'; id: string; unread?: boolean }
  | { type: 'updateDraft'; id: string; body: string; subject?: string }
  | { type: 'discardDraft'; id: string }
  | { type: 'sendDraft'; id: string; track: boolean; approved?: boolean }
  | { type: 'toggleStep'; id: string; step: string }
  /** Do what a next action says (send, update the deal, decide, block time), then tick it. */
  | { type: 'runStep'; id: string; step: string }
  | { type: 'applyDeal'; id: string; approved?: boolean }
  /** Change a deal's stage or value (from Ask Timmy, after you press Update). */
  | { type: 'editDeal'; id: string; stage?: string; value?: number; approved?: boolean }
  | { type: 'toggleRule'; id: string }
  | { type: 'addRule'; group: RuleGroup; text: string }
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
  | { type: 'reply'; id: string; body: string; track?: { on: string; item: string; due?: string } | null }
  | { type: 'simulateReply'; id: string }
  /** Timmy drafts a nudge or reply; with `note`, the reply says what you asked it to. */
  | { type: 'makeDraft'; id: string; note?: string }
  | { type: 'reset' }
  | { type: 'capture'; open: boolean }
  | { type: 'setSchedule'; schedule: Partial<Schedule> }
  | { type: 'setUrgency'; id: string; level: 'urgent' | 'later' | null }
  | { type: 'setFocus'; on?: boolean }
  | { type: 'setScope'; project: string | null }
  | { type: 'setPrefs'; calm?: boolean; showDeals?: boolean }
  /** Approve or turn down an item in the Approvals queue. */
  | { type: 'resolve'; key: string; option: string; change?: { deal: string; stage: string; value: number }; via?: 'send'; approved?: boolean }
  /** Outbound: leads, campaigns, sending, forms, social. */
  | { type: 'out'; op: OutOp }
  | { type: 'conn'; op: ConnOp }
  | { type: 'client'; to?: string; create?: string }
  /** The exec or RevOps answered a held action (simulated in this preview). */
  | { type: 'release'; id: string; approve: boolean };

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

const initial: State = {
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

let recordSeq = 1;
/** Adds a line to the Approvals history. */
const recorded = (s: Pick<State, 'approvalLog'>, r: Omit<ApprovalRecord, 'id' | 'at'>): ApprovalRecord[] => [
  { id: `ap-${recordSeq++}-${Date.now().toString(36)}`, at: new Date(NOW.getTime() + activitySeq * 60000), ...r },
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
  { id: `live-${activitySeq++}`, at: new Date(NOW.getTime() + activitySeq * 60000), kind, text, threadId },
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

function reducer(s: State, a: Action): State {
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
      return {
        ...s,
        threads: patch(s.threads, a.id, (x) => moveThread(x, a.box)),
        activity: logged(s, `You moved “${t.subject}” to ${tag}`, 'move', t.id),
        toasts: a.quiet ? s.toasts : withToast(s, `Moved to ${tag}`, snap(s)),
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
          x.draft ? { ...x, draft: { ...x.draft, body: a.body, subject: a.subject ?? x.draft.subject } } : x,
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
      };
      const track = a.track && draft.trackAs;
      const promise = promiseIn(draft.body);
      const box: Box = track ? 'waiting' : t.box === 'waiting' ? 'waiting' : promise ? 'follow-up' : 'archived';
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
        history: [...(t.history ?? []), { at: NOW, text: track ? `Sent. Moved to [02] Waiting until ${fmtDay(draft.trackAs!.due)}` : promise ? `Sent. You promised to ${promise}; kept in [01] Follow Up` : 'Sent' }],
      };
      let threads = patch(base.threads, a.id, () => updated);
      let approvalLog = recorded(base, { key: `draft:${t.id}`, kind: 'email', title: draft.subject, choice: track ? 'Sent and tracked' : 'Sent', approved: true, thread: t.id });
      let space = base.ws;
      let deals = base.deals;
      const notes: string[] = [];

      // Tasks this email finishes (not when it only promises to do them later).
      const finished = promise ? [] : (draft.completes ?? []).filter((id) => space.tasks[id] && space.tasks[id]!.status !== 'done');
      if (finished.length) space = applyOps(space, finished.map((id) => wsPatch('tasks', id, { status: 'done' })));

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
          : 'Sent';
      const extra = [settled.length ? `Logged your call: ${settled.join(', ')}` : '', notes.length ? `Timmy ${notes.join(' and ')}` : ''].filter(Boolean).join('. ');
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

    case 'toggleRule':
      return { ...s, rules: s.rules.map((r) => (r.id === a.id ? { ...r, enabled: !r.enabled } : r)) };

    case 'addRule':
      return {
        ...s,
        rules: [...s.rules, { id: `rule-${Date.now()}`, group: a.group, text: a.text, enabled: true, hits: 0 }],
        toasts: withToast(s, 'Rule added. Timmy applies it from the next triage run.'),
      };

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

    case 'ws':
      return {
        ...s,
        ws: applyOps(s.ws, a.ops),
        activity: a.log ? logged(s, a.log, 'file') : s.activity,
        toasts: a.toast ? withToast(s, a.toast, a.undo ? snap(s) : undefined, a.tone) : s.toasts,
      };

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
        messages: [{ id: `${tid}-1`, from: 'me', to: d.to, cc: d.cc, at: NOW, body: d.body.split(/\n\n+/) }],
        ask: track
          ? `${firstName(on)} owes you: ${lowerFirst(track.item)}${due ? ` by ${fmtDay(due)}` : ''}`
          : `You wrote to ${names}`,
        waiting: track ? { on, item: track.item, due, since: NOW } : undefined,
        context: track ? 'Timmy will draft a nudge if the date slips.' : undefined,
        history: [{ at: NOW, text: track ? `Sent and tracked in [02] Waiting${due ? ` until ${fmtDay(due)}` : ''}` : 'Sent' }],
      };
      return {
        ...s,
        compose: null,
        threads: [thread, ...s.threads],
        activity: logged(s, `You sent “${thread.subject}”${track ? ' and Timmy started tracking the reply' : ''}`, 'send', tid),
        toasts: withToast(s, track ? `Sent · tracking in [02] Waiting${due ? ` until ${fmtDay(due)}` : ''}` : `Sent to ${names}`, snap(s)),
      };
    }

    case 'reply': {
      const t = s.threads.find((x) => x.id === a.id);
      if (!t) return s;
      const to = [...new Set(t.messages.map((m) => m.from).filter((p) => p !== 'me'))];
      const msg = { id: `reply-${Date.now().toString(36)}`, from: 'me', to: to.length ? to : t.participants.filter((p) => p !== 'me'), at: NOW, body: a.body.split(/\n\n+/) };
      const track = a.track?.item ? a.track : null;
      const due = dueDate(track?.due);
      const box: Box = track ? 'waiting' : t.box === 'follow-up' || t.box === 'inbox' ? 'archived' : t.box;
      const next: Thread = {
        ...t,
        box,
        draft: undefined,
        unread: false,
        suggestion: undefined,
        messages: [...t.messages, msg],
        waiting: track ? { on: track.on, item: track.item, due, since: NOW } : t.waiting,
        ask: track ? `${firstName(track.on)} owes you: ${lowerFirst(track.item)}${due ? ` by ${fmtDay(due)}` : ''}` : t.ask,
        history: [...(t.history ?? []), { at: NOW, text: track ? `Replied and tracked in [02] Waiting${due ? ` until ${fmtDay(due)}` : ''}` : 'Replied' }],
      };
      const where = track ? `Replied · tracking in [02] Waiting${due ? ` until ${fmtDay(due)}` : ''}` : box === 'archived' ? 'Replied · label cleared and archived' : 'Replied';
      return {
        ...s,
        threads: patch(s.threads, a.id, () => next),
        activity: logged(s, `You replied to “${t.subject}”`, 'send', t.id),
        toasts: withToast(s, where, snap(s)),
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
      return { ...s, scope: p ? p.id : null, toasts: withToast(s, p ? `Showing ${p.name} only` : 'Showing all projects') };
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
      return { ...initial, toasts: withToast(initial, 'Demo data reset') };

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

const Ctx = createContext<{ state: State; dispatch: Dispatch<Action> } | null>(null);

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

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, load);

  useEffect(() => {
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
  }, [state]);

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
