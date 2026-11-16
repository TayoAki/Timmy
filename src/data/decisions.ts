/*
 * Decisions Timmy brings to you instead of making itself: prices, hiring calls,
 * introductions, invites. Each option says what Timmy will do once you choose,
 * and nothing goes out until you pick one. Email drafts and CRM updates join
 * these in the Approvals queue (see src/state/approvals.ts).
 */
import type { ComposeDraft } from '../state/store';
import { patch, put, type WsOp } from '../state/ws';
import type { Draft } from './types';

/** What choosing an option does. */
export type Effect =
  /** Add a dated line to the project's running notes. */
  | { do: 'note'; project: string; text: string }
  /** Rewrite parts of the thread's draft. */
  | { do: 'redraft'; thread: string; replace: [string, string][] }
  /** Draft a reply on the thread; it then waits in Approvals like any draft. */
  | { do: 'draft'; thread: string; draft: Draft }
  /** Tick a next step on the thread. */
  | { do: 'step'; thread: string; step: string }
  /** Change workspace items: tasks, events, files. */
  | { do: 'ws'; ops: WsOp[] }
  /** Open a new email for you to finish and send. */
  | { do: 'compose'; draft: ComposeDraft }
  /** Rewrite text in a deck or doc (slide titles, bullets, paragraphs) so the file matches the choice. */
  | { do: 'retext'; file: string; replace: [string, string][] }
  /** Set one cell in a sheet. */
  | { do: 'cell'; sheet: string; row: number; col: string; value: string | number }
  /** Reword a next action on a thread. */
  | { do: 'steptext'; thread: string; step: string; text: string };

export interface DecisionOption {
  id: string;
  label: string;
  primary?: boolean;
  /** Puts the decision off rather than making it. */
  holds?: boolean;
  effects: Effect[];
  /** What you're told after choosing. */
  result: string;
}

export interface Decision {
  id: string;
  kind: 'decision' | 'calendar';
  title: string;
  why: string;
  /** Numbers to compare, shown as a short table. */
  facts?: [string, string][];
  who?: string;
  thread?: string;
  project?: string;
  due?: Date;
  /** Timmy's read on how soon this needs you, and why. */
  urgency: 'urgent' | 'soon' | 'later';
  reason: string;
  options: DecisionOption[];
  /** Only matters while the thread's draft is unsent; once it goes out, the email made the call. */
  whileDraft?: boolean;
  /** Set once you choose. */
  chosen?: { option: string; at: Date };
}

const d = (day: number, h = 9, m = 0, month = 10) => new Date(2026, month, day, h, m);

const scorecardDone: Effect[] = [
  { do: 'step', thread: 'interview-feedback', step: 's1' },
  { do: 'ws', ops: [patch('tasks', 't-scorecard', { status: 'done' })] },
];

const JORDAN_DRAFT = 'Short version: strong hire on systems design and solid on debugging. I’d like a second read on collaboration from the team lunch.';

export const DECISIONS: Decision[] = [
  {
    id: 'acme-price',
    kind: 'decision',
    title: 'Give Acme $58 per seat at 120 seats?',
    why: 'Dana asked for flexibility on price at the higher volume. Your 101–250 tier is $58, $4 below the $62 in proposal v3. The drafted reply uses $58.',
    facts: [
      ['At $58 per seat', '$83,520 a year'],
      ['At $62 per seat', '$89,280 a year'],
      ['Difference', '$5,760 a year'],
    ],
    who: 'dana',
    thread: 'acme-quote',
    project: 'acme',
    due: d(17, 17),
    urgency: 'urgent',
    reason: 'Your reply to Dana is due tomorrow and depends on it',
    whileDraft: true,
    options: [
      {
        id: 'approve',
        label: 'Approve $58',
        primary: true,
        effects: [{ do: 'note', project: 'acme', text: 'Approved $58 per seat for 120 seats ($83,520 a year)' }],
        result: 'Approved $58 per seat. Added to the Acme running notes.',
      },
      {
        id: 'hold',
        label: 'Keep $62',
        effects: [
          {
            do: 'redraft',
            thread: 'acme-quote',
            replace: [
              ['120 seats at $58 per seat per month (our 101–250 tier), billed annually: $83,520', '120 seats at $62 per seat per month, billed annually: $89,280'],
              ['• That’s $4 less per seat than the 100-seat price in proposal v3\n', ''],
            ],
          },
          { do: 'note', project: 'acme', text: 'Kept $62 per seat for 120 seats ($89,280 a year)' },
          {
            do: 'retext',
            file: 'proposal-v4',
            replace: [
              ['Pricing: 120 seats at $58', 'Pricing: 120 seats at $62'],
              ['$4 less per seat than v3', 'Same $62 per seat as v3, now for 120 seats'],
            ],
          },
          { do: 'cell', sheet: 'acme-quote', row: 1, col: 'price', value: 62 },
          { do: 'steptext', thread: 'acme-quote', step: 's5', text: 'Update deal value to $89,280' },
        ],
        result: 'Kept $62. Timmy updated the reply to Dana, proposal v4 and the quote tracker; review the reply before you send.',
      },
    ],
  },
  {
    id: 'jordan-hire',
    kind: 'decision',
    title: 'Your call on Jordan Kim, Platform Engineer',
    why: 'Sofia needs your scorecard before the 4:30 PM debrief. Your Friday notes: strong on systems design, solid on debugging, collaboration not yet tested.',
    who: 'sofia',
    thread: 'interview-feedback',
    project: 'hiring',
    due: d(16, 16, 30),
    urgency: 'urgent',
    reason: 'The debrief is at 4:30 PM today',
    whileDraft: true,
    options: [
      {
        id: 'hire',
        label: 'Hire, check collaboration',
        primary: true,
        effects: scorecardDone,
        result: 'Scorecard filled in: hire, with a second read on collaboration. Your reply to Sofia is ready.',
      },
      {
        id: 'strong',
        label: 'Strong hire',
        effects: [
          { do: 'redraft', thread: 'interview-feedback', replace: [[JORDAN_DRAFT, 'Short version: strong hire. Excellent on systems design and debugging, and nothing in the loop worried me on collaboration.']] },
          ...scorecardDone,
        ],
        result: 'Scorecard filled in: strong hire. Timmy updated your reply to Sofia.',
      },
      {
        id: 'no',
        label: 'No hire',
        effects: [
          { do: 'redraft', thread: 'interview-feedback', replace: [[JORDAN_DRAFT, 'Short version: no hire for this role. Solid on debugging, but systems design wasn’t at the level the team needs.']] },
          ...scorecardDone,
        ],
        result: 'Scorecard filled in: no hire. Timmy updated your reply to Sofia.',
      },
    ],
  },
  {
    id: 'northwind-kickoff',
    kind: 'calendar',
    title: 'Send Marcus a kickoff invite for Tue, Dec 1 at 10:00 AM?',
    why: 'Your reply to Marcus says a kickoff invite will follow. You’re free 10:00–10:45 AM on Dec 1, the pilot’s first day.',
    who: 'marcus',
    thread: 'northwind-date',
    project: 'northwind',
    due: d(18, 17),
    urgency: 'soon',
    reason: 'Your task to send it is due Wednesday',
    options: [
      {
        id: 'send',
        label: 'Send invite',
        primary: true,
        effects: [
          {
            do: 'ws',
            ops: [
              put('events', {
                id: 'ev-northwind-kickoff',
                title: 'Northwind pilot kickoff',
                start: d(1, 10, 0, 11),
                end: d(1, 10, 45, 11),
                kind: 'meeting',
                with: ['marcus'],
                thread: 'northwind-date',
                notesDoc: 'northwind-notes',
                docs: ['northwind-sow'],
              }),
              patch('tasks', 't-kickoff', { status: 'done' }),
            ],
          },
          { do: 'step', thread: 'northwind-date', step: 's2' },
        ],
        result: 'Invite sent to Marcus for Tue, Dec 1, 10:00 AM.',
      },
      {
        id: 'wait',
        label: 'Wait for the signed SOW',
        holds: true,
        effects: [],
        result: 'Timmy will ask again when the signed SOW arrives.',
      },
    ],
  },
  {
    id: 'leo-intro',
    kind: 'decision',
    title: 'Introduce Leo Grant to Dana at Acme?',
    why: 'Leo, Brightwave’s founder, wants Dana’s view on procurement tooling. Dana takes your quote to her CFO on Wednesday, so an intro this week could pull her attention from the renewal.',
    who: 'leo',
    thread: 'leo-intro',
    urgency: 'later',
    reason: 'No deadline, and Leo isn’t waiting on anything else',
    options: [
      {
        id: 'later',
        label: 'Offer it after the renewal',
        primary: true,
        effects: [
          {
            do: 'draft',
            thread: 'leo-intro',
            draft: {
              kind: 'reply',
              to: ['leo'],
              subject: 'Re: Intro to Dana at Acme?',
              body: 'Hi Leo,\n\nHappy to. Dana is in the middle of a renewal with us this week, so I’ll make the intro once that wraps, likely the first week of December.\n\nBest,\nTaylor',
              sources: [],
            },
          },
          {
            do: 'ws',
            ops: [
              put('tasks', {
                id: 'task-leo-intro',
                title: 'Introduce Leo Grant to Dana Whitfield',
                status: 'todo',
                due: d(1, 17, 0, 11),
                priority: 'normal',
                created: d(16, 8, 12),
                thread: 'leo-intro',
                contact: 'leo',
              }),
            ],
          },
        ],
        result: 'Timmy drafted a reply to Leo for your approval and added a Dec 1 task for the intro.',
      },
      {
        id: 'now',
        label: 'Ask Dana now',
        effects: [
          {
            do: 'compose',
            draft: {
              to: ['dana'],
              subject: 'Open to an intro to Leo Grant (Brightwave)?',
              body: 'Hi Dana,\n\nLeo Grant, founder of Brightwave, is building procurement tooling and would value 20 minutes of your perspective. Would you be open to an intro? No pressure if the timing is wrong.\n\nBest,\nTaylor',
            },
          },
        ],
        result: 'Your note to Dana is open. Nothing is sent until you press Send.',
      },
      {
        id: 'decline',
        label: 'Decline',
        effects: [
          {
            do: 'draft',
            thread: 'leo-intro',
            draft: {
              kind: 'reply',
              to: ['leo'],
              subject: 'Re: Intro to Dana at Acme?',
              body: 'Hi Leo,\n\nThanks for thinking of me. Dana is in a busy stretch with us right now, so I’ll pass on the intro for now. Happy to share what I’ve seen of how procurement teams evaluate tools.\n\nBest,\nTaylor',
              sources: [],
            },
          },
        ],
        result: 'Timmy drafted a polite no for your approval.',
      },
    ],
  },
];
