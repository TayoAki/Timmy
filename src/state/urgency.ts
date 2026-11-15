/*
 * Urgency ranking. Every open thread gets a level (Urgent, Soon, Can wait) and
 * the plain-language reasons behind it, so the brief can lead with only what
 * needs you today. Each signal is a rule in Settings › Urgency; switching a rule
 * off removes that signal. Marking a thread yourself overrides the ranking.
 */
import { useMemo } from 'react';
import { NOW, PEOPLE } from '../data/mock';
import type { Deal, Rule, Thread } from '../data/types';
import type { WS } from '../data/ws-types';
import { dayDiff, fmtTime, money } from '../lib/format';
import { counterpart, useStore } from './store';
import { firstName, todaysEvents } from './ws';

export type Urgency = 'urgent' | 'soon' | 'later';

export interface UrgencyInfo {
  level: Urgency;
  score: number;
  /** Why, strongest reason first. */
  reasons: string[];
  /** You set the level yourself. */
  manual?: boolean;
}

export const URGENCY: Record<Urgency, { label: string; hint: string; rank: number }> = {
  urgent: { label: 'Urgent', hint: 'Needs you today', rank: 2 },
  soon: { label: 'Soon', hint: 'This week', rank: 1 },
  later: { label: 'Can wait', hint: 'No time pressure', rank: 0 },
};

/** The rule behind each signal (Settings › Urgency). */
export const SIGNAL_RULES = { due: 'u1', late: 'u2', words: 'u3', priority: 'u4', deal: 'u5', meeting: 'u6', bots: 'u7' } as const;

const URGENT_WORDS = /\b(urgent(ly)?|asap|today|tonight|end of (the )?day|eod|immediately|right away|outage|cancel\w*|escalat\w*)\b/i;

export interface UrgencyContext {
  ws: WS;
  deals: Record<string, Deal>;
  rules: Rule[];
}

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
const weekday = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'long' });

export function urgencyOf(t: Thread, ctx: UrgencyContext): UrgencyInfo {
  const on = (id: string) => ctx.rules.find((r) => r.id === id)?.enabled ?? true;
  const reasons: { w: number; text: string }[] = [];
  const add = (w: number, text: string) => reasons.push({ w, text });

  const finish = (level: Urgency, score: number): UrgencyInfo => {
    const list = [...reasons].sort((a, b) => b.w - a.w).map((r) => r.text);
    if (t.urgency === 'urgent') return { level: 'urgent', score: Math.max(score, 100), reasons: ['You marked it urgent', ...list], manual: true };
    if (t.urgency === 'later') return { level: 'later', score: 0, reasons: ['You marked it as able to wait', ...list], manual: true };
    return { level, score, reasons: list };
  };

  if (t.box === 'archived' || t.box === 'read-through') return finish('later', 0);

  const who = t.box === 'waiting' && t.waiting ? t.waiting.on : counterpart(t);
  if (PEOPLE[who]?.bot && on(SIGNAL_RULES.bots)) {
    add(0, 'Automated sender');
    return finish('later', 0);
  }
  if (t.box === 'inbox' && t.suggestion && t.suggestion.box !== 'follow-up' && t.suggestion.confidence === 'high') {
    add(0, 'Timmy will file it for you');
    return finish('later', 0);
  }

  // Time pressure.
  let time = 0;
  if (t.box === 'waiting') {
    const w = t.waiting;
    if (w?.due && w.due < NOW && on(SIGNAL_RULES.late)) {
      time = 50;
      add(50, `${days(-dayDiff(w.due))} past the promised date`);
    } else if (w && !w.due && on(SIGNAL_RULES.late) && -dayDiff(w.since) >= 5) {
      time = 25;
      add(25, `No reply in ${days(-dayDiff(w.since))}`);
    }
    if (time === 0) {
      reasons.length = 0;
      add(0, w?.due ? `Promised by ${weekday(w.due)}; nothing to do yet` : 'Nothing to do yet');
      return finish('later', 0);
    }
  } else if (t.due && on(SIGNAL_RULES.due)) {
    const diff = dayDiff(t.due);
    if (t.due < NOW) {
      time = 50;
      add(50, diff === 0 ? `Was due at ${fmtTime(t.due)}` : `${days(-diff)} late`);
    } else if (diff === 0) {
      time = 50;
      add(50, `Due today at ${fmtTime(t.due)}`);
    } else if (diff === 1) {
      time = 25;
      add(25, 'Due tomorrow');
    } else if (diff < 7) {
      time = diff <= 3 ? 20 : 15;
      add(time, `Due ${weekday(t.due)}`);
    }
  }

  // What they wrote.
  if (t.box !== 'waiting' && on(SIGNAL_RULES.words)) {
    const last = [...t.messages].reverse().find((m) => m.from !== 'me');
    const hit = last?.body.join(' ').match(URGENT_WORDS);
    if (hit) add(15, `Says “${hit[0].toLowerCase()}”`);
  }

  // Who and what's at stake.
  if (on(SIGNAL_RULES.priority) && ctx.ws.contacts[who]?.priority) add(20, `${firstName(who)} is a priority contact`);
  const deal = t.deal ? ctx.deals[t.deal] : undefined;
  if (on(SIGNAL_RULES.deal) && deal && deal.stage !== 'Closed won') {
    add(deal.value >= 50000 ? 20 : 10, `${money(deal.value)} ${deal.company} deal`);
  }
  if (on(SIGNAL_RULES.meeting)) {
    const meet = todaysEvents(ctx.ws).find((e) => e.with.includes(who) && e.end > NOW);
    if (meet) add(10, `You meet ${firstName(who)} at ${fmtTime(meet.start)}`);
  }

  const score = reasons.reduce((sum, r) => sum + r.w, 0);
  return finish(score >= 50 ? 'urgent' : score >= 15 ? 'soon' : 'later', score);
}

/** Higher is more urgent. */
export const urgencyRank = (u: UrgencyInfo) => URGENCY[u.level].rank * 1000 + u.score;

const dueTime = (t: Thread) => (t.box === 'waiting' ? t.waiting?.due : t.due)?.getTime() ?? Infinity;

/** Threads with their urgency, most urgent first; ties go to the earliest due date. */
export const rankThreads = (threads: Thread[], ctx: UrgencyContext) =>
  threads
    .map((t) => ({ t, u: urgencyOf(t, ctx) }))
    .sort((a, b) => urgencyRank(b.u) - urgencyRank(a.u) || dueTime(a.t) - dueTime(b.t));

/** Open mail that might need you: Follow Up, Waiting and unsorted. */
export const openThreads = (threads: Thread[]) => threads.filter((t) => t.box === 'follow-up' || t.box === 'waiting' || t.box === 'inbox');

export function useUrgency() {
  const { state } = useStore();
  const ctx = useMemo<UrgencyContext>(() => ({ ws: state.ws, deals: state.deals, rules: state.rules }), [state.ws, state.deals, state.rules]);
  return {
    ctx,
    of: (t: Thread) => urgencyOf(t, ctx),
    rank: (threads: Thread[]) => rankThreads(threads, ctx),
  };
}
