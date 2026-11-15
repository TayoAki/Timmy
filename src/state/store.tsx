import { createContext, useContext, useEffect, useMemo, useReducer, type Dispatch, type ReactNode } from 'react';
import { ACTIVITY, BOXES, DEALS, NOW, PEOPLE, PROJECTS, RULES, THREADS } from '../data/mock';
import type { Activity, Box, Deal, Label, ProjectId, Rule, RuleGroup, Thread } from '../data/types';
import { DECISIONS, type Decision } from '../data/decisions';
import { WS_SEED } from '../data/ws-mock';
import type { WS } from '../data/ws-types';
import { fmtDay, money } from '../lib/format';
import type { ApprovalKind, ApprovalRecord } from './approvals';
import { DEFAULT_SCHEDULE, fmtClock, nextRun, scheduleRule, whenLabel, daysLabel, type Schedule } from './schedule';
import { applyOps, decisionOps, firstName, personName, registerPerson, type WsOp, type WsOptions } from './ws';

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
  | { view: 'approvals'; tab: 'open' | 'history'; filter?: ApprovalKind };

export type Section = 'mail' | 'approvals' | 'activity' | 'people' | 'files' | 'rules' | 'tasks' | 'calendar' | 'docs' | 'projects' | 'library';

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
    default:
      return 'mail';
  }
};

/** Detail screens keep the list you came from as the Back target. */
const isDetail = (r: Route) => r.view === 'thread' || r.view === 'file' || r.view === 'contact' || r.view === 'project';

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
  | { type: 'sendDraft'; id: string; track: boolean }
  | { type: 'toggleStep'; id: string; step: string }
  | { type: 'applyDeal'; id: string }
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
  | { type: 'makeDraft'; id: string }
  | { type: 'reset' }
  | { type: 'capture'; open: boolean }
  | { type: 'setSchedule'; schedule: Partial<Schedule> }
  | { type: 'setUrgency'; id: string; level: 'urgent' | 'later' | null }
  /** Approve or turn down an item in the Approvals queue. */
  | { type: 'resolve'; key: string; option: string; change?: { deal: string; stage: string; value: number } };

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
};

let toastSeq = 1;
let activitySeq = 1;

/** Lower-cases the first letter unless the word is an acronym ("CFO approval" stays). */
const lowerFirst = (s: string) => (/^[A-Z]{2}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));

const snap = (s: State): Snapshot => ({
  threads: s.threads,
  deals: s.deals,
  activity: s.activity,
  ws: s.ws,
  decisions: s.decisions,
  approvalLog: s.approvalLog,
  dismissed: s.dismissed,
});

let recordSeq = 1;
/** Adds a line to the Approvals history. */
const recorded = (s: State, r: Omit<ApprovalRecord, 'id' | 'at'>): ApprovalRecord[] => [
  { id: `ap-${recordSeq++}-${Date.now().toString(36)}`, at: new Date(NOW.getTime() + activitySeq * 60000), ...r },
  ...s.approvalLog,
];

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

const withToast = (s: State, text: string, undo?: Snapshot, tone?: Toast['tone']): Toast[] =>
  [...s.toasts, { id: toastSeq++, text, undo, tone }].slice(-3);

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
      let deals = s.deals;
      let activity = logged(s, `Sorted “${t.subject}” to ${boxTag(sug.box)}`, 'triage', t.id);
      if (sug.extra && t.deal && deals[t.deal]) {
        deals = { ...deals, [t.deal]: { ...deals[t.deal]!, stage: 'Closed won', suggestion: undefined, lastTouch: 'Nov 15 · Countersigned order form' } };
        activity = [{ id: `live-${activitySeq++}`, at: NOW, kind: 'crm', text: `Moved ${deals[t.deal]!.company} to Closed won and linked the signed form`, threadId: t.id }, ...activity];
      }
      return {
        ...s,
        deals,
        threads: patch(s.threads, a.id, (x) => moveThread(x, sug.box)),
        activity,
        toasts: withToast(s, `Sorted to ${boxTag(sug.box)}${sug.extra ? ' · deal updated' : ''}`, snap(s)),
      };
    }

    case 'acceptAll': {
      let next = s;
      for (const id of a.ids) next = reducer({ ...next, toasts: [] }, { type: 'acceptSuggestion', id });
      const left = next.threads.filter((t) => t.box === 'inbox').length;
      const tail = left === 0 ? 'Inbox zero.' : `${left} left for you.`;
      return { ...next, toasts: withToast(s, `Sorted ${a.ids.length} emails. ${tail}`, snap(s)) };
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
      const t = s.threads.find((x) => x.id === a.id);
      if (!t?.draft) return s;
      const draft = t.draft;
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
      const box: Box = track ? 'waiting' : t.box === 'waiting' ? 'waiting' : 'archived';
      const steps = t.steps?.map((st) => (/send/i.test(st.text) ? { ...st, done: true } : st));
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
          ? `${PEOPLE[draft.trackAs!.on]!.name.split(' ')[0]} owes you: ${lowerFirst(draft.trackAs!.item)} by ${fmtDay(draft.trackAs!.due)}`
          : t.ask,
        context: track ? 'Timmy will draft a nudge if the date slips.' : t.context,
        history: [...(t.history ?? []), { at: NOW, text: track ? `Sent. Moved to [02] Waiting until ${fmtDay(draft.trackAs!.due)}` : 'Sent' }],
      };
      const where = track
        ? `Sent · tracking in [02] Waiting until ${fmtDay(draft.trackAs!.due)}`
        : box === 'archived'
          ? 'Sent · label cleared and archived'
          : 'Sent';
      return {
        ...s,
        threads: patch(s.threads, a.id, () => updated),
        activity: logged(s, `You sent “${draft.subject}”${track ? ' and Timmy started tracking the reply' : ''}`, 'send', t.id),
        approvalLog: recorded(s, { key: `draft:${t.id}`, kind: 'email', title: draft.subject, choice: track ? 'Sent and tracked' : 'Sent', approved: true, thread: t.id }),
        toasts: withToast(s, where, snap(s)),
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
      const nextDeal: Deal =
        a.id === 'acme'
          ? { ...deal, value: 83520, stage: 'Proposal sent', suggestion: undefined }
          : { ...deal, stage: 'Closed won', suggestion: undefined };
      return {
        ...s,
        deals: { ...s.deals, [a.id]: nextDeal },
        activity: logged(s, `Updated ${deal.company}: ${nextDeal.stage}`, 'crm'),
        toasts: withToast(s, `${deal.company} updated · ${nextDeal.stage}`, snap(s)),
      };
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
        else if (e.do === 'draft')
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
        compose,
        decisions: s.decisions.map((x) => (x.id === dec.id ? { ...x, chosen: { option: opt.id, at: NOW } } : x)),
        activity: logged(s, `You decided “${dec.title}”: ${opt.label}`, 'approval', dec.thread),
        approvalLog: recorded(s, { key: a.key, kind: dec.kind, title: dec.title, choice: opt.label, approved: !opt.holds, thread: dec.thread }),
        toasts: withToast(s, opt.result, snap(s)),
      };
    }

    case 'reset':
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* storage unavailable */
      }
      return { ...initial, toasts: withToast(initial, 'Demo data reset') };

    case 'makeDraft': {
      const t = s.threads.find((x) => x.id === a.id);
      if (!t || t.draft) return s;
      const who = [...t.messages].reverse().find((m) => m.from !== 'me')?.from ?? t.participants.find((p) => p !== 'me') ?? 'me';
      const ask = t.ask.replace(/^[A-Z]/, (c) => c.toLowerCase());
      const draft = {
        kind: 'reply' as const,
        to: [who],
        subject: t.subject.startsWith('Re:') ? t.subject : `Re: ${t.subject}`,
        body: `Hi ${firstName(who)},\n\nThanks for this. On your note (${ask}): here is where things stand, and what I need from you to keep it moving.\n\nBest,\nTaylor`,
        sources: (t.docs ?? []).slice(0, 2),
      };
      return {
        ...s,
        threads: patch(s.threads, a.id, (x) => ({ ...x, draft, history: [...(x.history ?? []), { at: NOW, text: 'Drafted a reply on request' }] })),
        toasts: withToast(s, 'Timmy drafted a reply'),
      };
    }

    case 'simulateReply': {
      const t = s.threads.find((x) => x.id === a.id);
      if (!t?.waiting) return s;
      const who = t.waiting.on;
      const body =
        t.id === 'acme-quote'
          ? ['Hi Taylor,', 'Good news: our CFO approved the 120-seat quote at $58 per seat. Please send the order form so we can start on January 1.', 'Thanks,\nDana']
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

const STORAGE_KEY = 'timmy-state-v2';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const PERSISTED = ['threads', 'deals', 'activity', 'rules', 'ws', 'highlight', 'highlightDone', 'dismissed', 'route', 'back', 'decisions', 'approvalLog', 'schedule'] as const;

function load(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initial;
    const saved = JSON.parse(raw, (_k, v) => (typeof v === 'string' && ISO_DATE.test(v) ? new Date(v) : v)) as Partial<State>;
    const next = { ...initial };
    for (const key of PERSISTED) if (saved[key] !== undefined) (next as Record<string, unknown>)[key] = saved[key];
    // Collections added in later versions fall back to the seed.
    next.ws = { ...initial.ws, ...next.ws };
    for (const c of Object.values(next.ws.contacts)) registerPerson({ id: c.id, name: c.name, email: c.email, title: c.title, company: c.company });
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
