import { createContext, useContext, useMemo, useReducer, type Dispatch, type ReactNode } from 'react';
import { ACTIVITY, BOXES, DEALS, NOW, PEOPLE, PROJECTS, RULES, THREADS } from '../data/mock';
import type { Activity, Box, Deal, Label, ProjectId, Rule, RuleGroup, Thread } from '../data/types';
import { fmtDay } from '../lib/format';

export type TodayTab = 'brief' | 'triage' | 'drafts';
export type ThreadTab = 'conversation' | 'links' | 'history';

export type Route =
  | { view: 'today'; tab: TodayTab }
  | { view: 'box'; box: Box | ProjectId; tab: string }
  | { view: 'thread'; id: string; tab: ThreadTab }
  | { view: 'activity'; tab: string }
  | { view: 'people'; tab: string; person?: string }
  | { view: 'files'; tab: string; folder: string }
  | { view: 'rules'; tab: RuleGroup };

export type Section = 'mail' | 'activity' | 'people' | 'files' | 'rules';

export const sectionOf = (r: Route): Section => {
  if (r.view === 'activity') return 'activity';
  if (r.view === 'people') return 'people';
  if (r.view === 'files') return 'files';
  if (r.view === 'rules') return 'rules';
  return 'mail';
};

interface Snapshot {
  threads: Thread[];
  deals: Record<string, Deal>;
  activity: Activity[];
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
  | { type: 'drawer'; drawer: State['drawer'] };

export const ALL_LABELS: Label[] = [...BOXES, ...PROJECTS];
export const labelOf = (id: string) => ALL_LABELS.find((l) => l.id === id)!;
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
};

let toastSeq = 1;
let activitySeq = 1;

/** Lower-cases the first letter unless the word is an acronym ("CFO approval" stays). */
const lowerFirst = (s: string) => (/^[A-Z]{2}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));

const snap = (s: State): Snapshot => ({ threads: s.threads, deals: s.deals, activity: s.activity });

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
    case 'navigate':
      return { ...s, route: a.route, drawer: null, back: a.route.view === 'thread' ? s.back : a.route };

    case 'openThread': {
      const back = s.route.view === 'thread' ? s.back : s.route;
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
        return { ...s, toasts: withToast(s, 'You have 5 starred threads. Unstar one first — if everything is starred, nothing is.', undefined, 'warn') };
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

    case 'discardDraft':
      return {
        ...s,
        threads: patch(s.threads, a.id, (x) => ({ ...x, draft: undefined })),
        toasts: withToast(s, 'Draft discarded', snap(s)),
      };

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
  }
}

const Ctx = createContext<{ state: State; dispatch: Dispatch<Action> } | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
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
