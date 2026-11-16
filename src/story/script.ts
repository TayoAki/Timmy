/*
 * "Monday, 8:12": the StoryBrand (SB7) story about Timmy, played inside the
 * app on fresh demo data. Each beat sets up a screen, points at one thing,
 * says one or two sentences, and may press a real button. The order matters:
 * later beats rely on what earlier ones did (the $62 decision comes before
 * the reply is sent, so the email quotes $62).
 */
import type { Dispatch } from 'react';
import { assistant } from '../agent/conversations';
import type { Action, Route, State } from '../state/store';

export type Find = string | (() => HTMLElement | null);

export interface Helpers {
  state: () => State;
  dispatch: Dispatch<Action>;
  go: (route: Route) => void;
  wait: (ms: number) => Promise<void>;
  /** Resolves once the condition holds, or after `ms`. */
  until: (test: () => boolean, ms?: number) => Promise<void>;
}

export interface Beat {
  id: string;
  /** The clock in the story, shown above the caption. */
  clock?: string;
  text: string;
  /** Full-screen cards instead of a caption over the app. */
  card?: 'intro' | 'plan' | 'end';
  /** Sets up the screen before the caption shows. */
  setup?: (h: Helpers) => void | Promise<void>;
  /** What to point at; the first one found wins. Nothing found: the caption shows alone. */
  spot?: Find[];
  /** After the caption is read, the cursor moves here and clicks it. */
  press?: Find[];
  /** Runs after the press (or instead of one), e.g. asking Timmy and waiting for the answer. */
  act?: (h: Helpers) => Promise<void>;
}

const vis = (el: Element | null): HTMLElement | null => {
  if (!(el instanceof HTMLElement)) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? el : null;
};

/** The first visible element matching `sel` whose text matches `re`. */
export const withText = (sel: string, re: RegExp, root: ParentNode = document) => () =>
  vis([...root.querySelectorAll(sel)].find((el) => vis(el) && re.test(el.textContent ?? '')) ?? null);

/** A visible element inside the first visible container that matches. */
const within = (container: () => HTMLElement | null, sel: string, re?: RegExp) => () => {
  const c = container();
  if (!c) return null;
  return re ? withText(sel, re, c)() : vis(c.querySelector(sel));
};

const closest = (find: () => HTMLElement | null, sel: string) => () => vis(find()?.closest(sel) ?? null);

export const ASK = 'Write a campaign for my best leads';

const mailGroup = closest(withText('.side-title', /^Mail$/), '.side-group');
const danaRow = closest(withText('.urg-row-title', /Dana a revised quote/), '.urg-row');
const priceCard = closest(withText('.ap-title', /Give Acme \$58/), '.ap-card');
const bookRow = closest(withText('.urg-lead .urg-row-title', /confirmed/), '.urg-row');
const latestToast = () => vis(document.querySelector('.toasts .toast:last-child'));

export const BEATS: Beat[] = [
  {
    id: 'intro',
    card: 'intro',
    text: 'A short story about one Monday morning with Timmy, played in the real app.',
  },
  {
    id: 'pile',
    clock: '8:12 AM',
    text: 'Taylor opens the laptop on Monday, already bracing. Weekends don’t stop the inbox. They let it pile up.',
    setup: (h) => h.go({ view: 'box', box: 'inbox', tab: 'all' }),
    spot: [mailGroup],
  },
  {
    id: 'hum',
    clock: '8:12 AM',
    text: 'Somewhere in there, Dana needs a revised quote before Wednesday’s CFO meeting. Marcus still owes a signed statement of work. A new lead is waiting to hear back.',
  },
  {
    id: 'cost',
    clock: '8:12 AM',
    text: 'That’s the real cost of the inbox. Not the hours. The feeling that it’s running your day. Taylor didn’t start a business to babysit email.',
  },
  {
    id: 'brief',
    clock: '8:13 AM',
    text: 'This Monday is different. Timmy got there first: its morning run sorted the mail at 8:00 and wrote this brief.',
    setup: (h) => h.go({ view: 'today', tab: 'brief' }),
    spot: ['.brief-head + .page-sub', '.brief-head'],
  },
  {
    id: 'urgent',
    clock: '8:13 AM',
    text: 'It doesn’t show the whole pile. Just what needs Taylor today, and why each one can’t wait.',
    spot: ['.urg-list'],
  },
  {
    id: 'open-dana',
    clock: '8:14 AM',
    text: 'First up: Dana’s quote.',
    spot: [danaRow, '.highlight'],
    press: [within(danaRow, '.urg-row-title')],
    act: async (h) => {
      if (h.state().route.view !== 'thread') h.dispatch({ type: 'openThread', id: 'acme-quote' });
      await h.wait(500);
    },
  },
  {
    id: 'draft',
    clock: '8:14 AM',
    text: 'Timmy has already read it. It found proposal v3, made a v4 for 120 seats, and drafted the reply.',
    spot: ['section.draft[aria-label="Draft reply"]'],
  },
  {
    id: 'steps',
    clock: '8:14 AM',
    text: 'It also made the task and blocked 1:00 to 2:30 this afternoon to check the new proposal.',
    spot: [closest(withText('.rp-title', /^Next actions$/), '.rp-section')],
  },
  {
    id: 'catch',
    clock: '8:15 AM',
    text: 'One catch: the draft offers $58 a seat, $4 under the usual price. That’s Taylor’s call, so Timmy asks first.',
    spot: ['section.draft .ap-notes', 'section.draft'],
  },
  {
    id: 'decide',
    clock: '8:15 AM',
    text: 'In Approvals, each choice shows what it changes: $83,520 a year at $58, or $89,280 at $62. Taylor holds at $62.',
    setup: (h) => h.go({ view: 'approvals', tab: 'open' }),
    spot: [priceCard],
    press: [within(priceCard, '.ap-actions button', /^Keep \$62$/)],
  },
  {
    id: 'carried',
    clock: '8:15 AM',
    text: 'One click, and the reply, proposal v4, the order form and the quote tracker all change together.',
    spot: [latestToast],
  },
  {
    id: 'reply-62',
    clock: '8:16 AM',
    text: 'Back in the thread, the reply now quotes $62.',
    setup: (h) => h.dispatch({ type: 'openThread', id: 'acme-quote' }),
    spot: ['section.draft .draft-body', 'section.draft'],
  },
  {
    id: 'send',
    clock: '8:16 AM',
    text: 'Taylor presses Send & track. The thread moves to Waiting, with Dana’s Friday deadline on it.',
    spot: ['section.draft .draft-send'],
    press: [withText('section.draft .draft-send .btn-primary', /Send & track/)],
  },
  {
    id: 'waiting',
    clock: '8:16 AM',
    text: 'Taylor doesn’t have to remember it anymore. Timmy tracks it, and drafts a nudge if Friday slips.',
    spot: [withText('.nav-item', /Waiting/)],
  },
  {
    id: 'book',
    clock: '8:17 AM',
    text: 'Next, a lead from the website form has already answered: “Monday morning works! 9:15 is great.” One click books it.',
    setup: (h) => h.go({ view: 'today', tab: 'brief' }),
    spot: [bookRow],
    press: [within(bookRow, 'button', /^Book/)],
  },
  {
    id: 'booked',
    clock: '8:17 AM',
    text: 'The invite goes out, and the call is on Taylor’s calendar.',
    spot: [latestToast],
  },
  {
    id: 'ask',
    clock: '8:20 AM',
    text: `Then one line to Timmy: “${ASK}.”`,
    setup: async (h) => {
      assistant.newChat();
      assistant.open();
      await h.wait(500);
    },
    spot: ['.ai-shell'],
    act: async (h) => {
      void assistant.ask(ASK);
      await h.wait(400);
      await h.until(() => !assistant.get().running, 15000);
      await h.wait(600);
    },
  },
  {
    id: 'drafted',
    clock: '8:21 AM',
    text: 'Timmy writes the sequence and saves each first email as a draft in Taylor’s own Gmail. Nothing is sent.',
    spot: ['.ai-shell'],
  },
  {
    id: 'triage',
    clock: '8:58 AM',
    text: 'Last, the inbox. Timmy suggested a label for each email. Taylor accepts the ones it’s sure about.',
    setup: (h) => {
      assistant.close();
      h.go({ view: 'today', tab: 'triage' });
    },
    spot: [withText('.btn-primary', /^Accept \d+ confident$/)],
    press: [withText('.btn-primary', /^Accept \d+ confident$/)],
  },
  {
    id: 'sorted',
    clock: '9:00 AM',
    text: 'By 9:00, every email has a place: Follow Up, Waiting or Read Through. Every promise has a date.',
    spot: [mailGroup],
  },
  {
    id: 'lunch',
    clock: '12:30 PM',
    text: 'At lunch, Taylor reads the campaign drafts and sends them, inside the daily limit for cold email.',
    setup: (h) => h.go({ view: 'outbound', tab: 'drafts' }),
    spot: ['.odr-row', '.out-head'],
    press: [withText('.out-head-actions .btn-primary', /^Send all/)],
  },
  {
    id: 'plan',
    card: 'plan',
    text: 'The plan is short.',
  },
  {
    id: 'failure',
    text: 'Without it, Monday goes the old way. The quote goes out late and the deal cools. The lead books with whoever answered first. Sunday night goes to catching up.',
  },
  {
    id: 'success',
    clock: '5:30 PM',
    text: 'At 5:30, Taylor closes the laptop knowing exactly who owes what. Not from working harder. Because nothing slipped.',
    setup: (h) => h.go({ view: 'today', tab: 'brief' }),
    spot: [closest(withText('.tc-title', /I’m waiting on/), '.tri-card')],
  },
  {
    id: 'end',
    card: 'end',
    text: 'Taylor used to be the one who was always a little behind. Now Taylor is the one who never drops a ball.',
  },
];

/**
 * Where each scene starts in the ElevenLabs voiceover (docs/story-voiceover.md, the
 * 3:21 take), and when its button is pressed or its question asked. ?story=play&sync=vo
 * plays to these times so a recording lines up with the voice.
 */
export const VO_SYNC: Record<string, { at: number; press?: number }> = {
  pile: { at: 0 },
  hum: { at: 7.8 },
  cost: { at: 17.6 },
  brief: { at: 27.5 },
  urgent: { at: 35.1 },
  'open-dana': { at: 41.5, press: 42.7 },
  draft: { at: 43.9 },
  steps: { at: 51.9 },
  catch: { at: 58.1 },
  decide: { at: 69.1, press: 83.2 },
  carried: { at: 85.4 },
  'reply-62': { at: 92.5 },
  send: { at: 96.8, press: 98.4 },
  waiting: { at: 103.7 },
  book: { at: 110.3, press: 117.8 },
  booked: { at: 119.1 },
  ask: { at: 123.3, press: 125.3 },
  drafted: { at: 128.0 },
  triage: { at: 136.1, press: 141.2 },
  sorted: { at: 143.5 },
  lunch: { at: 152.1, press: 156.6 },
  plan: { at: 158.8 },
  failure: { at: 180.3 },
  success: { at: 191.7 },
  end: { at: 202.6 },
};

/** Words read at about 4 a second, with a floor and a ceiling. */
export const readTime = (text: string) => Math.min(8000, Math.max(3000, text.split(/\s+/).length * 250 + 1000));
