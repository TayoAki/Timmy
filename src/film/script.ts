/*
 * "Monday, 8:12": the walkthrough of the product film, timed to the narration.
 *
 * Every time comes from the word that introduces its beat (vo_words.json, from the
 * Sizzle analyze_audio script), so a new take re-times the film by swapping that
 * file. Visuals land on their phrase, never before.
 *
 * The film is the real app on seeded demo data. The cursor presses the real
 * controls (the harness clicks and types for real at these times), and the
 * camera, dim layer and kinetic type are drawn on top. See BRIEF.md and STORYBOARD.md.
 */
import words from './vo_words.json';
import type { Route } from '../state/store';

/* ───────────── Word timing ───────────── */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9$]/g, '');
const W = (words as { w: string; s: number; e: number }[]).map((x) => ({ ...x, n: norm(x.w) }));

/** When the narration starts saying `phrase` (at or after `after` seconds). */
export function w(phrase: string, after = 0): number {
  const want = phrase.split(/\s+/).map(norm).filter(Boolean);
  for (let i = 0; i < W.length; i++) {
    if (W[i]!.s < after) continue;
    if (want.every((p, k) => W[i + k] && W[i + k]!.n.startsWith(p))) return W[i]!.s;
  }
  throw new Error(`Film script: "${phrase}" isn't in the narration after ${after}s`);
}
/** When the narration finishes `phrase`. */
export function we(phrase: string, after = 0): number {
  const start = w(phrase, after);
  const n = phrase.split(/\s+/).filter((p) => norm(p)).length;
  const i = W.findIndex((x) => x.s === start);
  return W[i + n - 1]!.e;
}
export const VOICE_END = W[W.length - 1]!.e;

/* ───────────── Targets ───────────── */

export type Target = () => HTMLElement | null;

const visible = (el: Element | null): el is HTMLElement => {
  if (!(el instanceof HTMLElement)) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};
/** The first visible element matching `sel` whose text matches `re`. */
export const text = (sel: string, re: RegExp, root: () => ParentNode | null = () => document): Target => () => {
  const r = root();
  return r ? ([...r.querySelectorAll(sel)].find((el) => visible(el) && re.test(el.textContent ?? '')) as HTMLElement | undefined) ?? null : null;
};
export const css = (sel: string): Target => () => {
  const el = document.querySelector(sel);
  return visible(el) ? el : null;
};
/** A left-rail section button. */
const rail = (label: string) => css(`nav.rail [aria-label="${label}"]`);
/** A sidebar item by its name ("Follow Up", "Today", "Drafts"). */
const nav = (name: string): Target => () =>
  ([...document.querySelectorAll('.nav-item')].find((b) => visible(b) && (b.querySelector('.nav-name')?.textContent ?? '').replace(/^\d+/, '').trim().startsWith(name)) as HTMLElement | undefined) ?? null;
const within = (outer: Target, sel: string, re?: RegExp): Target => () => {
  const o = outer();
  if (!o) return null;
  return re ? text(sel, re, () => o)() : ([...o.querySelectorAll(sel)].find(visible) as HTMLElement | undefined) ?? null;
};
const closest = (inner: Target, sel: string): Target => () => {
  const el = inner()?.closest(sel);
  return visible(el ?? null) ? (el as HTMLElement) : null;
};
const tab = (re: RegExp) => text('[role="tab"]', re);
/** The `i`th visible element matching `sel`. */
const nth = (sel: string, i: number): Target => () => ([...document.querySelectorAll(sel)].filter(visible)[i] as HTMLElement | undefined) ?? null;
const mailRow = (re: RegExp) => text('.row', re);

const draft = css('section.draft[aria-label="Draft reply"]');
const danaUrgent = closest(text('.urg-row-title', /Dana a revised quote/), '.urg-row');
const priceCard = closest(text('.ap-title', /Give Acme \$58/), '.ap-card');
const jamieRow = closest(text('.urg-lead .urg-row-title', /confirmed/), '.urg-row');
const rpSection = (re: RegExp) => closest(text('.rp-title', re), '.rp-section');
const mailGroup = closest(text('.side-title', /^Mail$/), '.side-group');

/* ───────────── The timeline ───────────── */

/** The camera eases to frame `target` (or the whole screen) starting at `t`. */
export interface Cam {
  t: number;
  d?: number;
  target: Target | 'full';
  zoom?: number;
  dx?: number;
  dy?: number;
}
/** The cursor travels on a bowed arc to `to` (a target's centre, or a point on the frame edge). */
export interface Move {
  t: number;
  d?: number;
  to: Target | { edge: [number, number] };
  ox?: number;
  oy?: number;
  bow?: number;
}
/** A real click on `target` at `t` (the cursor is already there). */
export interface Press {
  t: number;
  target: Target;
}
export interface Typing {
  t: number;
  text: string;
  cps?: number;
}
export interface Key {
  t: number;
  key: string;
}
/** Scroll the target's scroll container so the target sits `offset` px from its top. */
export interface Scroll {
  t: number;
  d: number;
  target: Target;
  offset?: number;
}
/** Dim everything but the subject. */
export interface Dim {
  t0: number;
  t1: number;
  target: Target;
  pad?: number;
}
/** A kinetic-type moment: the words get the frame to themselves. */
export interface Card {
  t0: number;
  t1: number;
  theme: 'light' | 'dark';
  lines: { t: number; text: string; size?: 'xl' | 'l' | 'm' | 'n'; num?: string }[];
}
/** A cut to a screen, hidden under a card (never a depicted click). */
export interface Cut {
  t: number;
  route: Route;
}

export interface Film {
  start: Route;
  length: number;
  cams: Cam[];
  moves: Move[];
  presses: Press[];
  typing: Typing[];
  keys: Key[];
  scrolls: Scroll[];
  dims: Dim[];
  cards: Card[];
  cuts: Cut[];
}

export function walkthrough(): Film {
  // The beats, by the words that introduce them.
  const somewhere = w('Somewhere in there');
  const dana = w('Dana needs');
  const marcus = w('Marcus still owes');
  const lead = w('A new lead');
  const cost = w("That's the real cost");
  const babysit = w("Taylor didn't start");
  const different = w('This Monday is different');
  const first = w('Timmy got there first');
  const pile = w("It doesn't show");
  const firstUp = w('First up');
  const read = w('Timmy has already read');
  const found = w('It found Proposal');
  const drafted = w('drafted the reply');
  const task = w('It also made the task');
  const blocked = w('blocked one');
  const catchAt = w('One catch');
  const call = w("That's Taylor's call");
  const approvals = w('In approvals');
  const p58 = w('$83', approvals);
  const p62 = w('$89', approvals);
  const holds = w('Taylor holds');
  const oneClick = w('One click and');
  const tracker = w('quote tracker', oneClick);
  const back = w('Back in the thread');
  const presses = w('Taylor presses');
  const moves = w('The thread moves');
  const remember = w("Taylor doesn't have");
  const next = w('Next, a lead');
  const books = w('One click books');
  const invite = w('The invite goes out');
  const line = w('Then one line');
  const write = w('Write a campaign');
  const nothing = w('Nothing is sent');
  const last = w('Last, the inbox');
  const accepts = w('Taylor accepts');
  const nine = w('By nine');
  const follow = w('Follow up');
  const waitingWord = w('waiting', follow);
  const through = w('read through');
  const promise = w('Every promise');
  const lunch = w('At lunch');
  const sends = w('sends them');
  const plan = w('The plan is short');
  const one = w('One, connect');
  const add = w('Add your calendar');
  const two = w('Two, Timmy');
  const why = w('Every suggestion');
  const three = w('Three, you approve');
  const leaves = w('Nothing leaves');
  const without = w('Without it');
  const late = w('The quote goes out late');
  const books2 = w('The lead books');
  const sunday = w('Sunday night');
  const five = w('At five thirty');
  const owes = w('who owes what');
  const because = w('Because nothing');

  const edgeBR: Move['to'] = { edge: [1980, 1000] };
  const edgeR: Move['to'] = { edge: [1990, 560] };

  return {
    start: { view: 'box', box: 'inbox', tab: 'all' },
    length: VOICE_END + 0.9,
    cuts: [
      { t: cost + 0.15, route: { view: 'today', tab: 'brief' } },
      { t: plan + 0.15, route: { view: 'today', tab: 'brief' } },
    ],
    cards: [
      {
        t0: cost - 0.1,
        t1: babysit - 0.15,
        theme: 'light',
        lines: [
          { t: cost, text: 'That’s the real cost of the inbox.', size: 'xl' },
          { t: w('Not the hours'), text: 'Not the hours.', size: 'l' },
          { t: w('The feeling that'), text: 'The feeling that it’s running your day.', size: 'l' },
        ],
      },
      { t0: babysit - 0.15, t1: different - 0.1, theme: 'light', lines: [{ t: babysit, text: 'Taylor didn’t start a business to babysit email.', size: 'xl' }] },
      {
        t0: plan - 0.1,
        t1: without - 0.12,
        theme: 'light',
        lines: [
          { t: plan, text: 'The plan is short.', size: 'l' },
          { t: one, num: '1', text: 'Connect your Gmail.', size: 'm' },
          { t: add, text: 'Add your calendar and Drive when you’re ready.', size: 'n' },
          { t: two, num: '2', text: 'Timmy sorts, drafts and lines up your morning.', size: 'm' },
          { t: why, text: 'Every suggestion says why.', size: 'n' },
          { t: three, num: '3', text: 'You approve what goes out.', size: 'm' },
          { t: leaves, text: 'Nothing leaves without your okay, and every move can be undone.', size: 'n' },
        ],
      },
      {
        t0: without - 0.12,
        t1: five - 0.1,
        theme: 'dark',
        lines: [
          { t: without, text: 'Without it, Monday goes the old way.', size: 'l' },
          { t: late, text: 'The quote goes out late and the deal cools.', size: 'm' },
          { t: books2, text: 'The lead books with whoever answered first.', size: 'm' },
          { t: sunday, text: 'Sunday night goes to catching up.', size: 'm' },
        ],
      },
    ],
    cams: [
      // Hook: the unsorted pile, already in motion; push in as the voice says it piles up.
      { t: 0, d: 0.01, target: 'full' },
      { t: w('Weekends'), d: 1.1, target: css('.main-scroll'), zoom: 1.2, dy: -40 },
      // Follow Up: Dana's quote. Waiting: Marcus's SOW. Outbound: the new lead.
      { t: somewhere, d: 0.7, target: 'full' },
      { t: dana + 0.45, d: 0.8, target: mailRow(/Revised quote/), zoom: 1.6, dx: -120 },
      { t: marcus - 0.95, d: 0.6, target: 'full' },
      { t: marcus + 0.5, d: 0.8, target: mailRow(/SOW|statement of work/i), zoom: 1.6, dx: -120 },
      { t: lead - 0.1, d: 0.8, target: rail('Outbound'), zoom: 1.6, dx: 260, dy: 80 },
      // The turn: the brief Timmy wrote.
      { t: different - 0.05, d: 0.01, target: 'full' },
      { t: first, d: 0.9, target: css('.brief-head + .page-sub'), zoom: 1.55, dx: 120, dy: -30 },
      { t: pile, d: 0.9, target: css('.urg-list'), zoom: 1.3 },
      { t: firstUp + 0.62, d: 0.55, target: danaUrgent, zoom: 1.5, dx: 120 },
      // Dana's thread: the draft, the files it came from, the task and the focus block.
      { t: read, d: 0.8, target: 'full' },
      { t: found + 0.55, d: 0.8, target: css('.link-grid'), zoom: 1.25 },
      { t: drafted - 0.75, d: 0.6, target: 'full' },
      { t: drafted + 0.45, d: 0.8, target: draft, zoom: 1.2, dy: -60 },
      { t: task + 0.1, d: 0.8, target: rpSection(/^Next actions$/), zoom: 1.6 },
      { t: blocked - 0.95, d: 0.6, target: 'full' },
      { t: blocked + 0.45, d: 0.8, target: text('.timeline li', /Blocked 1:00/), zoom: 1.7 },
      { t: catchAt - 0.85, d: 0.6, target: 'full' },
      { t: catchAt + 0.5, d: 0.8, target: within(draft, '.ap-notes'), zoom: 1.6, dy: -80 },
      { t: call + 0.6, d: 0.9, target: 'full' },
      // Approvals: the $58 decision, then Keep $62.
      { t: approvals + 0.35, d: 0.9, target: priceCard, zoom: 1.4 },
      { t: holds - 0.5, d: 0.6, target: within(priceCard, '.ap-actions'), zoom: 1.6, dx: -120 },
      { t: oneClick, d: 0.7, target: css('.toasts .toast:last-child'), zoom: 1.4 },
      // The sheet changed too: the quote tracker, opened from search.
      { t: tracker - 1.6, d: 0.01, target: 'full' },
      { t: tracker - 0.1, d: 0.8, target: css('.sheet-grid'), zoom: 1.45, dy: -40 },
      // Back to the reply, now at $62, and send it.
      { t: back - 0.75, d: 0.6, target: 'full' },
      { t: back + 1.6, d: 0.8, target: within(draft, '.draft-body'), zoom: 1.45 },
      { t: presses - 0.2, d: 0.8, target: within(draft, '.draft-send'), zoom: 1.6, dx: -200 },
      { t: moves + 0.4, d: 0.8, target: mailGroup, zoom: 1.6, dx: 160 },
      { t: remember + 0.9, d: 0.8, target: mailRow(/CFO approval/), zoom: 1.55, dx: -100 },
      // The form lead's time, booked.
      { t: next - 0.6, d: 0.55, target: 'full' },
      { t: next + 0.9, d: 0.8, target: jamieRow, zoom: 1.6, dx: 60 },
      { t: invite, d: 0.8, target: rpSection(/calendar/i), zoom: 1.5 },
      // One line to Timmy.
      { t: line, d: 0.8, target: css('.ai-launch'), zoom: 1.6, dy: -120 },
      { t: write - 0.25, d: 0.6, target: css('.ai-shell'), zoom: 1.05 },
      { t: nothing + 1.1, d: 0.7, target: css('.odr-list'), zoom: 1.25, dy: -60 },
      // Triage, and every email in its place.
      { t: last - 0.5, d: 0.5, target: 'full' },
      { t: last + 1.6, d: 0.8, target: text('.btn-primary', /^Accept \d+ confident$/), zoom: 1.5, dx: -360, dy: 120 },
      { t: nine, d: 0.8, target: mailGroup, zoom: 1.7, dx: 160 },
      // Lunch: send the drafts.
      { t: lunch - 0.5, d: 0.5, target: 'full' },
      { t: lunch + 1.4, d: 0.8, target: css('.out-head'), zoom: 1.45, dy: 60 },
      { t: sends + 0.55, d: 0.7, target: css('.toasts .toast:last-child'), zoom: 1.4 },
      // 5:30: who owes what.
      { t: five - 0.05, d: 0.01, target: 'full' },
      { t: five + 1.6, d: 0.9, target: css('.main-scroll'), zoom: 1.3, dy: -60 },
      { t: owes, d: 0.8, target: mailRow(/CFO approval/), zoom: 1.5, dx: -100 },
      { t: because, d: 2.0, target: 'full' },
    ],
    dims: [
      { t0: dana + 1.2, t1: marcus + 0.2, target: mailRow(/Revised quote/) },
      { t0: marcus + 1.2, t1: lead, target: mailRow(/SOW|statement of work/i) },
      { t0: first + 0.9, t1: pile, target: css('.brief-head + .page-sub'), pad: 14 },
      { t0: found + 1.3, t1: drafted + 0.3, target: text('.link-card', /proposal v4/i) },
      { t0: task + 0.9, t1: blocked, target: rpSection(/^Next actions$/) },
      { t0: blocked + 1.2, t1: catchAt, target: text('.timeline li', /Blocked 1:00/) },
      { t0: catchAt + 1.3, t1: call + 0.5, target: within(draft, '.ap-notes') },
      { t0: approvals + 1.2, t1: holds - 0.6, target: priceCard },
      { t0: tracker + 0.7, t1: back, target: text('.sheet-grid tbody tr', /62/) },
      { t0: back + 2.4, t1: presses - 0.3, target: within(draft, '.draft-body') },
      { t0: remember + 1.7, t1: next, target: mailRow(/CFO approval/) },
      { t0: next + 1.7, t1: books - 0.4, target: jamieRow },
      { t0: invite + 0.8, t1: line, target: text('.rp-section li, .rp-section button, .rp-section div', /Intro call: Jamie/) },
      { t0: nine + 0.8, t1: lunch, target: mailGroup, pad: 6 },
      { t0: owes + 0.8, t1: because, target: mailRow(/CFO approval/) },
    ],
    scrolls: [
      { t: firstUp, d: 0.6, target: danaUrgent, offset: 260 },
      // The thread opens on the conversation; bring Timmy's draft up into view.
      { t: read + 0.2, d: 0.6, target: draft, offset: 60 },
      { t: drafted + 0.12, d: 0.4, target: draft, offset: 60 },
      { t: catchAt + 0.15, d: 0.4, target: within(draft, '.ap-notes'), offset: 320 },
      { t: back + 1.25, d: 0.4, target: within(draft, '.draft-body'), offset: 100 },
      { t: presses - 1.0, d: 0.6, target: within(draft, '.draft-send .btn-primary'), offset: 640 },
      { t: five + 0.2, d: 0.01, target: css('.main-scroll'), offset: 0 },
    ],
    moves: [
      // Enter from the bottom-right edge and scan the pile.
      { t: 1.0, d: 0.9, to: nth('.row', 1), ox: 260, oy: 6, bow: 60 },
      { t: 3.4, d: 0.9, to: nth('.row', 3), ox: 300, oy: 6 },
      { t: 5.6, d: 0.8, to: nth('.row', 5), ox: 280, oy: 6 },
      { t: somewhere + 0.1, d: 0.8, to: nav('Follow Up'), ox: 40, bow: 80 },
      { t: dana + 1.3, d: 0.7, to: mailRow(/Revised quote/), ox: 380, oy: 10 },
      { t: marcus - 0.7, d: 0.7, to: nav('Waiting'), ox: 40, bow: 70 },
      { t: marcus + 1.3, d: 0.7, to: mailRow(/SOW|statement of work/i), ox: 380, oy: 10 },
      { t: lead - 0.3, d: 0.8, to: rail('Outbound'), ox: 6, oy: 6, bow: 60 },
      { t: cost - 0.9, d: 0.7, to: edgeR },
      // The brief.
      { t: first + 1.2, d: 0.9, to: css('.run-control'), ox: 70, oy: 4, bow: 70 },
      { t: pile + 1.4, d: 0.8, to: nth('.urg-list .urg-row', 2), ox: 300, oy: 12 },
      { t: pile + 3.8, d: 0.7, to: nth('.urg-list .urg-row', 3), ox: 300, oy: 12 },
      { t: firstUp + 0.65, d: 0.5, to: within(danaUrgent, 'button.btn'), bow: 50 },
      // Dana's thread.
      { t: read + 0.4, d: 0.7, to: draft, ox: 260, oy: -140 },
      { t: found - 0.15, d: 0.6, to: tab(/^Files & links/), ox: 10, bow: 50 },
      { t: found + 1.2, d: 0.7, to: text('.link-card', /proposal v4/i), ox: 60, oy: 40 },
      { t: drafted - 0.6, d: 0.6, to: tab(/^Conversation/), ox: 10, bow: 40 },
      { t: task + 0.6, d: 0.8, to: rpSection(/^Next actions$/), ox: 90, oy: -40, bow: 60 },
      { t: blocked - 0.55, d: 0.55, to: tab(/^Timmy.s log/), ox: 10, bow: 40 },
      { t: catchAt - 0.5, d: 0.5, to: tab(/^Conversation/), ox: 10, bow: 40 },
      { t: catchAt + 1.2, d: 0.7, to: within(draft, '.ap-notes'), ox: 280, oy: 36 },
      { t: call + 0.9, d: 1.0, to: rail('Approvals'), ox: 4, oy: 4, bow: 90 },
      // Approvals.
      { t: approvals + 1.0, d: 0.7, to: within(priceCard, '.ap-facts'), ox: -60, oy: 34 },
      { t: p58 - 0.1, d: 0.6, to: text('.ap-facts div', /At \$58/), ox: 30, oy: 30 },
      { t: p62 - 0.1, d: 0.6, to: text('.ap-facts div', /At \$62/), ox: 30, oy: 30 },
      { t: holds - 0.55, d: 0.6, to: within(priceCard, '.ap-actions button', /^Keep \$62$/), bow: 40 },
      { t: holds + 1.4, d: 0.6, to: within(priceCard, '.ap-actions'), ox: -220, oy: 70 },
      // Search for the quote tracker and open it.
      { t: tracker - 0.55, d: 0.45, to: text('.palette button, .palette li, .palette [role="option"], .palette a', /Quote tracker/i), ox: 40, bow: 30 },
      { t: tracker + 0.6, d: 0.6, to: css('.sheet-grid'), ox: 300, oy: 140 },
      // Back to the thread: Today & mail, then the starred thread.
      { t: back - 0.3, d: 0.5, to: rail('Today & mail'), ox: 4, oy: 4, bow: 60 },
      { t: back + 0.45, d: 0.6, to: nav('Revised quote'), ox: 20, bow: 40 },
      { t: back + 1.8, d: 0.6, to: within(draft, '.draft-body'), ox: 300, oy: -60 },
      { t: presses - 0.4, d: 0.8, to: within(draft, '.draft-send .btn-primary'), bow: 50 },
      { t: moves + 0.5, d: 0.7, to: nav('Waiting'), ox: 120, bow: 60 },
      { t: remember + 0.5, d: 0.3, to: nav('Waiting'), ox: 40 },
      { t: remember + 1.5, d: 0.7, to: mailRow(/CFO approval/), ox: 420, oy: 10 },
      // The lead's 9:15.
      { t: next - 0.2, d: 0.6, to: nav('Today'), ox: 30, bow: 60 },
      { t: next + 1.6, d: 0.7, to: jamieRow, ox: 120, oy: 22 },
      { t: books - 0.45, d: 0.55, to: within(jamieRow, 'button', /^Book/), bow: 40 },
      { t: books + 1.0, d: 0.6, to: jamieRow, ox: -40, oy: 60 },
      // Ask Timmy.
      { t: line + 0.2, d: 0.6, to: css('.ai-launch'), ox: -80, bow: 50 },
      { t: write + 2.4, d: 0.6, to: css('.ai-input'), ox: 180, oy: -60 },
      { t: nothing - 0.2, d: 0.7, to: text('.ai-shell button', /^Open the drafts$/), bow: 50 },
      // Triage.
      { t: last - 0.45, d: 0.55, to: rail('Today & mail'), ox: 4, oy: 4, bow: 50 },
      { t: last + 0.45, d: 0.5, to: tab(/^Triage/), ox: 10, bow: 50 },
      { t: accepts - 0.9, d: 0.7, to: text('.btn-primary', /^Accept \d+ confident$/), bow: 50 },
      { t: nine + 0.6, d: 0.7, to: nav('Follow Up'), ox: 150 },
      { t: follow - 0.1, d: 0.4, to: nav('Follow Up'), ox: 150 },
      { t: waitingWord - 0.1, d: 0.4, to: nav('Waiting'), ox: 150 },
      { t: through - 0.1, d: 0.4, to: nav('Read Through'), ox: 150 },
      { t: promise, d: 0.5, to: nav('Waiting'), ox: 150 },
      // Lunch: Outbound, Drafts, Send all.
      { t: lunch - 0.2, d: 0.6, to: rail('Outbound'), ox: 4, oy: 4, bow: 60 },
      { t: lunch + 0.6, d: 0.6, to: nav('Drafts'), ox: 30, bow: 40 },
      { t: sends - 0.5, d: 0.7, to: text('.out-head-actions .btn-primary', /^Send all/), bow: 50 },
      { t: sends + 1.4, d: 0.6, to: css('.odr-list'), ox: 320, oy: 60 },
      { t: plan - 0.8, d: 0.7, to: edgeBR },
      // 5:30.
      { t: five + 0.5, d: 0.8, to: nav('Waiting'), ox: 40, bow: 60 },
      { t: owes - 0.4, d: 0.6, to: mailRow(/CFO approval/), ox: 420, oy: 10 },
      { t: because + 0.6, d: 1.0, to: edgeBR },
    ],
    presses: [
      { t: dana + 0.35, target: nav('Follow Up') },
      { t: marcus + 0.15, target: nav('Waiting') },
      { t: firstUp + 1.25, target: within(danaUrgent, 'button.btn') },
      { t: found + 0.5, target: tab(/^Files & links/) },
      { t: drafted, target: tab(/^Conversation/) },
      { t: blocked + 0.05, target: tab(/^Timmy.s log/) },
      { t: catchAt + 0.05, target: tab(/^Conversation/) },
      { t: call + 2.0, target: rail('Approvals') },
      { t: holds + 0.15, target: within(priceCard, '.ap-actions button', /^Keep \$62$/) },
      { t: tracker - 0.05, target: text('.palette button, .palette li, .palette [role="option"], .palette a', /Quote tracker/i) },
      { t: back + 0.25, target: rail('Today & mail') },
      { t: back + 1.1, target: nav('Revised quote') },
      { t: presses + 0.6, target: within(draft, '.draft-send .btn-primary') },
      { t: remember + 0.85, target: nav('Waiting') },
      { t: next + 0.45, target: nav('Today') },
      { t: books + 0.15, target: within(jamieRow, 'button', /^Book/) },
      { t: line + 0.85, target: css('.ai-launch') },
      { t: nothing + 0.55, target: text('.ai-shell button', /^Open the drafts$/) },
      { t: last + 0.2, target: rail('Today & mail') },
      { t: last + 1.0, target: tab(/^Triage/) },
      { t: accepts - 0.15, target: text('.btn-primary', /^Accept \d+ confident$/) },
      { t: lunch + 0.45, target: rail('Outbound') },
      { t: lunch + 1.25, target: nav('Drafts') },
      { t: sends + 0.25, target: text('.out-head-actions .btn-primary', /^Send all/) },
      { t: five + 1.35, target: nav('Waiting') },
    ],
    // Search: ⌘K, then "quote tracker" at a human pace. The campaign line, typed.
    keys: [
      { t: oneClick + 2.3, key: 'Control+k' },
      { t: write + 2.35, key: 'Enter' },
    ],
    typing: [
      { t: oneClick + 2.7, text: 'quote tracker', cps: 16 },
      { t: write, text: 'Write a campaign for my best leads', cps: 16 },
    ],
  };
}
