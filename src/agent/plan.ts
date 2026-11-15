/*
 * The local agent's brain: turns a request into the work Timmy shows (steps),
 * what it says, safe work it does straight away (drafting, never sending) and
 * the widgets it puts in the conversation. A server agent speaking AG-UI
 * replaces this; the widgets stay the same.
 */
import { NOW } from '../data/mock';
import { fmtTime, money, plural } from '../lib/format';
import { openApprovals } from '../state/approvals';
import { contextOf, freeSlot, reply } from '../state/assistant';
import type { Action, Route, State } from '../state/store';
import { openThreads, rankThreads } from '../state/urgency';
import { todaysEvents } from '../state/ws';
import type { WidgetName } from './tools';

export interface WidgetCall {
  name: WidgetName;
  args: Record<string, unknown>;
}

export interface Plan {
  /** What Timmy works through, shown as it goes. */
  steps: string[];
  text: string;
  /** Safe work done during the run (drafts only: nothing is sent or changed for others). */
  effects?: Action[];
  calls: WidgetCall[];
}

const lead = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const firstSentence = (s: string) => s.split(/\.\s/)[0]!.replace(/\.$/, '');

export function plan(s: State, text: string, route: Route | null): Plan {
  const l = text.trim().toLowerCase();
  const ctx = route ? contextOf(s, route) : null;
  const thread = route?.view === 'thread' ? s.threads.find((t) => t.id === route.id) : undefined;
  const ranked = rankThreads(openThreads(s.threads), { ws: s.ws, deals: s.deals, rules: s.rules });
  const urgent = ranked.filter((x) => x.u.level === 'urgent');
  const approvals = openApprovals(s);
  const events = todaysEvents(s.ws);
  const upcoming = events.filter((e) => e.end > NOW);

  // "Move my morning brief to 7:30" changes the schedule; the engine below proposes it.
  const scheduleChange = /\b(run|brief|triage|morning)\b/.test(l) && /\b(at|to|for)\s*\d/.test(l);

  /* Plan my day: the morning brief as live widgets. */
  if (!scheduleChange && /(plan (my|the) day|my day|start (my|the) day|morning brief|daily brief|what should i do today|brief me$|catch me up|what did i miss)/.test(l)) {
    const free = freeSlot(events, 60);
    return {
      steps: [`Read ${plural(ranked.length, 'open thread')}`, 'Ranked them by urgency', `Checked today’s ${plural(events.length, 'event')}`, `Collected ${plural(approvals.length, 'item')} waiting on you`],
      text:
        `${urgent.length ? `${plural(urgent.length, 'thing')} need${urgent.length === 1 ? 's' : ''} you today. First up: ${firstSentence(urgent[0]!.t.ask)}.` : 'Nothing is urgent today.'} ` +
        `You have ${plural(upcoming.length, 'meeting')} left${free ? `, and you’re free from ${fmtTime(free.start)}` : ''}. ` +
        `${approvals.length ? `${plural(approvals.length, 'item')} need${approvals.length === 1 ? 's' : ''} your OK.` : ''}`,
      calls: [
        { name: 'show_urgent', args: { limit: 4 } },
        { name: 'show_day', args: {} },
        { name: 'show_approvals', args: { limit: 3 } },
      ],
    };
  }

  /* Draft replies for everything urgent. */
  if (/(draft|write).*(urgent|all|every|replies)/.test(l) && !thread) {
    const missing = urgent.filter((x) => !x.t.draft && x.t.box !== 'waiting');
    return {
      steps: ['Found the urgent threads', missing.length ? `Drafted ${plural(missing.length, 'reply', 'replies')} from your files and past mail` : 'Checked the drafts already waiting'],
      text: missing.length
        ? `I drafted ${plural(missing.length, 'reply', 'replies')}. Nothing is sent: review each one and press Send.`
        : 'Every urgent thread already has a draft or is waiting on someone else. Here they are to review and send:',
      effects: missing.map((x): Action => ({ type: 'makeDraft', id: x.t.id })),
      calls: [{ name: 'show_approvals', args: { kind: 'email' } }],
    };
  }

  /* Pipeline (before approvals: "brief me on the pipeline"). */
  if (!scheduleChange && /(pipeline|deals?\b|crm|forecast|revenue|opportunit|quota)/.test(l)) {
    const open = Object.values(s.deals).filter((d) => d.stage !== 'Closed won');
    const late = open.filter((d) => d.due && d.due < NOW);
    const total = open.reduce((n, d) => n + d.value, 0);
    return {
      steps: [`Read ${plural(Object.keys(s.deals).length, 'deal')} in the CRM`, 'Checked each next step against its date'],
      text: `${money(total)} is open across ${plural(open.length, 'deal')}.${late.length ? ` ${late.map((d) => d.company).join(' and ')} ${late.length === 1 ? 'is' : 'are'} past the next-step date.` : ' Nothing is late.'}`,
      calls: [{ name: 'show_pipeline', args: {} }],
    };
  }

  /* Approvals. */
  if (/(approv|decision|decide|sign[- ]?off|my ok|waiting on me|waiting for me|clear my)/.test(l)) {
    const top = approvals[0];
    return {
      steps: ['Checked drafts, decisions, CRM updates and invites'],
      text: approvals.length
        ? `${plural(approvals.length, 'item')} need${approvals.length === 1 ? 's' : ''} your OK. Most pressing: ${lead(top!.title)}`
        : 'Nothing is waiting for your approval.',
      calls: approvals.length ? [{ name: 'show_approvals', args: {} }] : [],
    };
  }

  /* The open thread: summary or draft. */
  if (thread && /(summar|what.*(about|says?|need)|tl;?dr|catch me up|this thread|this email)/.test(l)) {
    return {
      steps: [`Read ${plural(thread.messages.length, 'message')}`, 'Checked its next actions and files'],
      text: `${thread.ask}.${thread.context ? ` ${thread.context}` : ''}`,
      calls: [{ name: 'show_thread', args: { id: thread.id } }],
    };
  }
  if (thread && /(draft|reply|respond|write back|answer)/.test(l)) {
    return {
      steps: [`Read ${plural(thread.messages.length, 'message')}`, thread.draft ? 'Found the draft from this morning' : 'Drafted a reply from your files and past mail'],
      text: thread.draft ? 'There’s already a draft. Review it and send when it’s right:' : 'Here’s a draft. Nothing is sent until you press Send:',
      effects: thread.draft ? [] : [{ type: 'makeDraft', id: thread.id }],
      calls: [{ name: 'show_thread', args: { id: thread.id } }],
    };
  }

  /* Urgent. */
  if (/(urgent|priorit|what should i|focus on first|which emails?|reply to first|needs? me|on fire|emergenc)/.test(l)) {
    return {
      steps: [`Read ${plural(ranked.length, 'open thread')}`, 'Ranked them by due date, sender, deal size and wording'],
      text: urgent.length
        ? `${plural(urgent.length, 'thing')} need${urgent.length === 1 ? 's' : ''} you today. ${urgent[0]!.u.reasons[0]} on the first.`
        : 'Nothing is urgent. Here’s what’s open, most pressing first:',
      calls: [{ name: 'show_urgent', args: urgent.length ? {} : { level: 'all', limit: 6 } }],
    };
  }

  /* Today's calendar. */
  if (!scheduleChange && /(calendar|meetings?|agenda|schedule today|on today|today|tomorrow)/.test(l) && !/(focus|block|remind|task|run|brief)/.test(l)) {
    const free = freeSlot(events, 60);
    return {
      steps: [`Checked today’s ${plural(events.length, 'event')}`],
      text: `${plural(upcoming.length, 'meeting')} left today${upcoming[0] ? `; next is ${upcoming[0].title} at ${fmtTime(upcoming[0].start)}` : ''}.${free ? ` Your first free hour starts at ${fmtTime(free.start)}.` : ''}`,
      calls: [{ name: 'show_day', args: {} }],
    };
  }

  /* Everything else: the engine's answer, with its links and choices as a widget. */
  const r = reply(s, text, ctx);
  const research = /(competit|research|strateg|market|benchmark)/.test(l);
  const hasWidget = !!(r.bullets?.length || r.links?.length || r.choices?.length);
  return {
    steps: research ? ['Searched your mail and files for related material'] : ['Looked through your mail, calendar, files and deals'],
    text: r.text,
    calls: hasWidget ? [{ name: 'show_answer', args: { bullets: r.bullets ?? [], links: r.links ?? [], choices: r.choices ?? [] } }] : [],
  };
}
