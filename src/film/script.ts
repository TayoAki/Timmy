/*
 * The product film (v2, Demo2Win "Tell-Show-Tell"), timed to the narration.
 *
 * It opens on the problem with no software on screen, reveals the app in 3D at
 * "This is Timmy", then walks six parts: what needs you, the files, the deals,
 * new customers, the emails, and speed to lead. Each part is told on a card,
 * shown in the app with real clicks, then recapped. A dark recap card hands over
 * to the 3D close (?intro&close&from=11.05), which lands "Never drop a ball."
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

const draft = css('section.draft[aria-label="Draft reply"]');
const priceCard = closest(text('.ap-title', /Give Acme \$58/), '.ap-card');
const jamieRow = closest(text('.urg-lead .urg-row-title', /confirmed/), '.urg-row');
const mailGroup = closest(text('.side-title', /^Mail$/), '.side-group');
const marcusRow = closest(text('.urg-row-title', /Dec 1 pilot start/), '.urg-row');
const source = within(draft, '.draft-head .chip');
const pjBlock = (re: RegExp) => closest(text('.pj-block h2', re), '.pj-block');
const modal = css('.modal');
const modalBtn = (re: RegExp) => within(modal, 'button', re);
const linkCard = (re: RegExp) => text('.link-card', re);
const firstLead = nth('.lead-table tbody tr', 0);
const fitChip = within(firstLead, 'td:nth-child(5) > *');
const limits = closest(text('.rp-title', /Today.s limits/), '.rp-section');
const formGrid = closest(css('.form-card'), 'ul');
const formCard = (re: RegExp) => text('.form-card', re);
const newLead = nth('.spd-card', 0);
const rpSection = (re: RegExp) => closest(text('.rp-title', re), '.rp-section');
const foundList = text('.nav-item', /Found by Timmy/);

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
  lines: { t: number; text: string; size?: 'xl' | 'l' | 'm' | 'n' | 'eye' | 'lede'; num?: string; mark?: boolean }[];
}
/** A cut to a screen, hidden under a card (never a depicted click). */
export interface Cut {
  t: number;
  route: Route;
}

/** The reveal: the app swings in from the dark between t0 and t1. */
export interface Swing {
  t0: number;
  t1: number;
}

export interface Film {
  start: Route;
  length: number;
  swing?: Swing;
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
  const decides = w('your inbox decides');
  const quotes = w('Quotes to send');
  const people = w('people to chase');
  const buried = w('files buried');
  const cold = w('and new leads go cold');
  const whatIf = w('What if it was all');
  const thisIs = w('This is Timmy');
  const shouldnt = w("You shouldn't have");
  const morning = w('Each morning');
  const shows = w('and shows you');
  const why = w('why', shows);
  const reply = w('When something needs');
  const using = w('using your own');
  const check = w('You check it');
  const sendIt = w('you send it', check);
  const nothing = w('Nothing goes out without');
  const next = w('Next, the files');
  const behind = w('the files behind');
  const connects = w('Timmy connects');
  const organizes = w('organizes everything');
  const links = w('and links each');
  const docs = w('Docs, slides');
  const sheets = w('sheets', docs);
  const start = w('Start a new one');
  const flight = w('the deals in flight');
  const every = w('Every project');
  const tasks = w('See the tasks');
  const latest = w('the latest version');
  const owes = w('who owes what');
  const change = w('Change the price');
  const together = w('update together');
  const customers = w('Now, new customers');
  const afternoon = w('A good lead list');
  const tell = w('Tell Timmy who');
  const finds = w('It finds businesses');
  const scores = w('scores each one');
  const fills = w('fills in the contact');
  const turns = w('and turns your best');
  const campaign = w('Ask for a campaign');
  const lands = w('Each email lands');
  const limitsAt = w('within daily limits');
  const readThem = w('You read them');
  const sendThem = w('you send them', readThem);
  const finds1 = w('And when a lead finds');
  const speed = w('speed wins');
  const connect = w('Connect your website');
  const typeform = w('type form');
  const facebook = w('or Facebook');
  const moment = w('The moment a lead');
  const drafts1 = w('Timmy drafts the first');
  const book = w('You can book');
  const stops = w('so your inbox stops');
  const sorts = w('Timmy sorts it');
  const draftsIt = w('drafts it', sorts);
  const filesIt = w('files it', sorts);
  const tracksIt = w('tracks it', sorts);
  const findsNext = w('and finds your next');
  // The film cuts to the 3D close just before the last line ("And nothing goes out until you say so").
  const close = w('And nothing goes out until') - 0.14;

  const edgeR: Move['to'] = { edge: [1990, 560] };
  const edgeBR: Move['to'] = { edge: [1980, 1000] };
  const swing = { t0: thisIs + 0.6, t1: thisIs + 2.4 };
  // The sheet and the new doc open in the full editor (the spreadsheet and document apps).
  const fullEditor = text('.file-mode [role="radio"]', /^Full editor$/);

  return {
    start: { view: 'box', box: 'inbox', tab: 'all' },
    length: close,
    swing,
    // Cuts happen under a card, never as a depicted click.
    cuts: [
      { t: next + 0.1, route: { view: 'files', tab: 'browse', folder: 'f02' } },
      { t: flight + 0.12, route: { view: 'project', id: 'acme', tab: 'overview' } },
      { t: customers + 0.1, route: { view: 'outbound', tab: 'leads' } },
      { t: finds1 + 0.1, route: { view: 'outbound', tab: 'speed' } },
    ],
    cards: [
      // Tell: the problem, with no software on screen.
      {
        t0: 0,
        t1: quotes - 0.12,
        theme: 'dark',
        lines: [
          { t: -0.3, text: 'If you run a small business,', size: 'lede' },
          { t: decides, text: 'your inbox decides your day.', size: 'xl' },
        ],
      },
      {
        t0: quotes - 0.12,
        t1: whatIf - 0.12,
        theme: 'dark',
        lines: [
          { t: quotes, text: 'Quotes to send.', size: 'l' },
          { t: people, text: 'People to chase.', size: 'l' },
          { t: buried, text: 'Files buried three folders deep.', size: 'l' },
          { t: cold, text: 'New leads going cold while you reply.', size: 'l' },
        ],
      },
      { t0: whatIf - 0.12, t1: thisIs - 0.1, theme: 'dark', lines: [{ t: whatIf, text: 'What if it was all handled before you sat down?', size: 'xl' }] },
      { t0: thisIs - 0.1, t1: swing.t0 + 0.2, theme: 'dark', lines: [{ t: thisIs, text: 'This is Timmy.', size: 'xl', mark: true }] },
      // 1. What needs you: told by the voice over the unsorted pile, recapped here.
      { t0: nothing - 0.12, t1: next - 0.05, theme: 'light', lines: [{ t: nothing, text: 'Nothing goes out without you.', size: 'xl' }] },
      // 2. The files.
      {
        t0: next - 0.05,
        t1: connects - 0.12,
        theme: 'light',
        lines: [
          { t: next, text: 'Drive, docs, slides and sheets', size: 'eye' },
          { t: behind, text: 'The files behind the work.', size: 'xl' },
        ],
      },
      // 3. The deals (the new doc stays on screen through "Then,").
      {
        t0: flight - 0.02,
        t1: every - 0.12,
        theme: 'light',
        lines: [
          { t: flight, text: 'Projects and proposals', size: 'eye' },
          { t: flight + 0.08, text: 'The deals in flight.', size: 'xl' },
        ],
      },
      // 4. New customers.
      {
        t0: customers - 0.12,
        t1: tell - 0.3,
        theme: 'light',
        lines: [
          { t: customers, text: 'Finding leads', size: 'eye' },
          { t: customers + 0.5, text: 'New customers.', size: 'xl' },
          { t: afternoon, text: 'A good lead list usually eats a whole afternoon.', size: 'm' },
        ],
      },
      // 6. Speed to lead.
      {
        t0: finds1 - 0.12,
        t1: connect - 0.1,
        theme: 'light',
        lines: [
          { t: finds1, text: 'Speed to lead', size: 'eye' },
          { t: finds1 + 0.1, text: 'When a lead finds you first,', size: 'l' },
          { t: speed, text: 'speed wins.', size: 'xl' },
        ],
      },
      // Close: the opening line, turned around, then the recap. The 3D close follows.
      { t0: stops - 0.12, t1: sorts - 0.12, theme: 'dark', lines: [{ t: stops, text: 'Your inbox stops deciding your day.', size: 'xl' }] },
      {
        t0: sorts - 0.12,
        t1: close,
        theme: 'dark',
        lines: [
          { t: sorts, text: 'Timmy', size: 'eye' },
          { t: sorts + 0.05, text: 'Sorts it.', size: 'l' },
          { t: draftsIt, text: 'Drafts it.', size: 'l' },
          { t: filesIt, text: 'Files it.', size: 'l' },
          { t: tracksIt, text: 'Tracks it.', size: 'l' },
          { t: findsNext, text: 'Finds your next customers.', size: 'l' },
        ],
      },
    ],
    cams: [
      { t: 0, d: 0.01, target: 'full' },
      // 1. The unsorted pile, then the sorted mail, the brief and Marcus's ready reply.
      { t: shouldnt - 0.1, d: 1.4, target: css('.main-scroll'), zoom: 1.18, dy: -40 },
      { t: morning - 0.3, d: 0.55, target: 'full' },
      { t: morning + 0.35, d: 0.7, target: mailGroup, zoom: 1.6, dx: 160 },
      { t: shows - 0.3, d: 0.45, target: 'full' },
      { t: shows + 0.55, d: 0.8, target: css('.urg-list'), zoom: 1.3 },
      { t: why - 0.95, d: 0.7, target: marcusRow, zoom: 1.55, dx: 120 },
      { t: reply + 0.55, d: 0.75, target: draft, zoom: 1.2, dy: -60 },
      { t: using - 0.2, d: 0.7, target: source, zoom: 1.7, dx: 200, dy: 60 },
      { t: check + 0.4, d: 0.7, target: within(draft, '.draft-body'), zoom: 1.4 },
      { t: sendIt - 0.55, d: 0.5, target: within(draft, '.draft-send'), zoom: 1.55, dx: -200 },
      { t: sendIt + 0.25, d: 0.45, target: 'full' },
      // 2. Drive's numbered folders, the thread's files, a real sheet, a new doc from a template.
      { t: next + 0.15, d: 0.01, target: 'full' },
      { t: connects + 0.25, d: 1.2, target: css('.dr-table'), zoom: 1.12, dx: -120 },
      { t: organizes + 0.1, d: 1.0, target: css('.dr-table'), zoom: 1.35 },
      { t: links - 0.75, d: 0.45, target: 'full' },
      { t: links + 1.15, d: 0.7, target: css('.link-grid'), zoom: 1.3 },
      { t: docs + 0.1, d: 0.35, target: 'full' },
      { t: docs + 0.95, d: 0.8, target: css('.craft-stage'), zoom: 2.0, dx: -255, dy: -120 },
      { t: start - 0.75, d: 0.4, target: 'full' },
      { t: start + 0.35, d: 0.6, target: modal, zoom: 1.3 },
      { t: start + 1.9, d: 0.45, target: 'full' },
      { t: start + 2.65, d: 0.7, target: css('.craft'), zoom: 1.2, dy: -40 },
      // 3. The Acme project page, then Keep $62 and the reply it rewrote.
      { t: flight + 0.15, d: 0.01, target: 'full' },
      { t: every + 0.4, d: 1.4, target: css('.pj-title-row'), zoom: 1.35, dy: 120 },
      { t: tasks - 0.1, d: 0.6, target: pjBlock(/^Due soon$/), zoom: 1.65 },
      { t: latest - 0.1, d: 0.6, target: pjBlock(/^Key files$/), zoom: 1.65 },
      { t: owes - 0.25, d: 0.6, target: pjBlock(/^Waiting on others$/), zoom: 1.65 },
      { t: change - 0.65, d: 0.4, target: 'full' },
      { t: change + 0.4, d: 0.5, target: priceCard, zoom: 1.4 },
      { t: change + 1.05, d: 0.55, target: css('.toasts .toast:last-child'), zoom: 1.35 },
      { t: together - 1.75, d: 0.4, target: 'full' },
      { t: together - 0.15, d: 0.6, target: within(draft, '.draft-body'), zoom: 1.45 },
      // 4. Find leads: the ask, the scored list, the list it lands in.
      { t: customers + 0.15, d: 0.01, target: 'full' },
      { t: tell + 0.3, d: 0.6, target: modal, zoom: 1.35 },
      { t: finds + 0.2, d: 0.45, target: 'full' },
      { t: finds + 0.9, d: 0.9, target: css('.lead-table'), zoom: 1.2, dy: -120 },
      { t: scores - 0.1, d: 0.6, target: fitChip, zoom: 1.7, dy: 160 },
      { t: fills - 0.1, d: 0.6, target: within(firstLead, 'td:nth-child(2)'), zoom: 1.7, dx: 200, dy: 160 },
      { t: turns + 0.1, d: 0.8, target: foundList, zoom: 1.7, dx: 260, dy: -60 },
      // 5. The campaign for those leads: one line to Timmy, the drafts, the daily limits, Send all.
      { t: campaign - 0.45, d: 0.45, target: 'full' },
      { t: campaign + 0.25, d: 0.6, target: css('.ai-shell'), zoom: 1.05 },
      { t: lands + 0.25, d: 0.7, target: css('.odr-list'), zoom: 1.25, dy: -60 },
      { t: limitsAt - 0.15, d: 0.6, target: limits, zoom: 1.7 },
      { t: readThem - 0.3, d: 0.7, target: css('.out-head'), zoom: 1.4, dy: 60 },
      { t: sendThem + 0.35, d: 0.55, target: limits, zoom: 1.6 },
      // 6. The connected forms, a new lead on the clock, the first reply, then Book.
      { t: finds1 + 0.2, d: 0.01, target: 'full' },
      { t: connect, d: 1.0, target: formGrid, zoom: 1.3 },
      { t: moment - 1.0, d: 0.5, target: 'full' },
      { t: moment + 0.3, d: 0.7, target: newLead, zoom: 1.45 },
      { t: drafts1 + 0.3, d: 0.6, target: modal, zoom: 1.3 },
      { t: book - 0.55, d: 0.4, target: 'full' },
      { t: book + 0.3, d: 0.6, target: jamieRow, zoom: 1.5, dx: 60 },
      { t: book + 1.15, d: 0.5, target: rpSection(/calendar/i), zoom: 1.45 },
    ],
    // The soft dim: everything but the subject goes grey while the voice is on it.
    dims: [
      { t0: why - 0.25, t1: reply - 0.15, target: marcusRow },
      { t0: using + 0.5, t1: check + 0.3, target: source, pad: 8 },
      { t0: organizes + 0.9, t1: links - 0.8, target: css('.dr-table') },
      { t0: links + 1.85, t1: docs - 0.05, target: css('.link-grid') },
      { t0: sheets + 0.05, t1: start - 0.8, target: css('.craft-stage') },
      { t0: tasks + 0.45, t1: latest - 0.15, target: pjBlock(/^Due soon$/) },
      { t0: latest + 0.45, t1: owes - 0.3, target: pjBlock(/^Key files$/) },
      { t0: owes + 0.35, t1: change - 0.7, target: pjBlock(/^Waiting on others$/) },
      { t0: together + 0.45, t1: customers - 0.15, target: within(draft, '.draft-body') },
      { t0: scores + 0.5, t1: fills - 0.15, target: fitChip, pad: 6 },
      { t0: fills + 0.5, t1: turns - 0.1, target: firstLead },
      { t0: turns + 0.95, t1: campaign - 0.5, target: foundList, pad: 6 },
      { t0: limitsAt + 0.5, t1: readThem - 0.35, target: limits },
      { t0: connect + 1.1, t1: moment - 1.05, target: formGrid },
      { t0: moment + 1.0, t1: drafts1 - 0.15, target: newLead },
      { t0: book + 1.7, t1: stops - 0.15, target: rpSection(/calendar/i) },
    ],
    scrolls: [
      { t: reply + 0.35, d: 0.45, target: draft, offset: 60 },
      { t: check - 0.1, d: 0.45, target: within(draft, '.draft-send .btn-primary'), offset: 700 },
      { t: change, d: 0.35, target: priceCard, offset: 160 },
      { t: together - 0.65, d: 0.4, target: within(draft, '.draft-body'), offset: 100 },
      { t: finds1 + 0.3, d: 0.01, target: css('.form-card'), offset: 90 },
      { t: moment - 1.0, d: 0.45, target: css('.out-head, .page-title'), offset: 0 },
    ],
    moves: [
      // 1.
      { t: shouldnt + 0.1, d: 0.9, to: nth('.row', 1), ox: 260, oy: 6, bow: 60 },
      { t: shouldnt + 1.1, d: 0.8, to: nth('.row', 3), ox: 300, oy: 6 },
      { t: shouldnt + 2.0, d: 0.7, to: nth('.row', 5), ox: 280, oy: 6 },
      { t: morning - 0.1, d: 0.6, to: nav('Follow Up'), ox: 120, bow: 60 },
      { t: morning + 0.8, d: 0.35, to: nav('Waiting'), ox: 120 },
      { t: morning + 1.2, d: 0.35, to: nav('Read Through'), ox: 120 },
      { t: shows - 0.25, d: 0.45, to: nav('Today'), ox: 30, bow: 40 },
      { t: shows + 0.8, d: 0.8, to: nth('.urg-list .urg-row', 1), ox: 300, oy: 12 },
      { t: why - 0.8, d: 0.6, to: marcusRow, ox: 60, oy: 14 },
      { t: reply - 0.35, d: 0.5, to: within(marcusRow, 'button', /^Review draft$/), bow: 50 },
      { t: reply + 0.9, d: 0.6, to: draft, ox: 260, oy: -140 },
      { t: using - 0.1, d: 0.6, to: source, ox: 40, oy: 4 },
      { t: check + 0.5, d: 0.6, to: within(draft, '.draft-body'), ox: 300, oy: -40 },
      { t: sendIt - 0.5, d: 0.5, to: within(draft, '.draft-send .btn-primary'), bow: 50 },
      { t: nothing - 0.6, d: 0.5, to: edgeR },
      // 2.
      { t: organizes + 0.3, d: 0.8, to: text('.dr-table .table-row', /\[10\]\s*Acme/), ox: -120, bow: 60 },
      { t: organizes + 1.2, d: 0.6, to: text('.dr-table .table-row', /\[11\]\s*Northwind/), ox: -120 },
      { t: links - 0.7, d: 0.45, to: rail('Today & mail'), ox: 4, oy: 4, bow: 60 },
      { t: links - 0.05, d: 0.45, to: nav('Revised quote'), ox: 20, bow: 40 },
      { t: links + 0.6, d: 0.45, to: tab(/^Files & links/), ox: 10, bow: 40 },
      { t: links + 1.6, d: 0.6, to: linkCard(/proposal v4/i), ox: 40, oy: 20 },
      { t: docs - 0.5, d: 0.45, to: linkCard(/Pricing tiers/), bow: 40 },
      { t: docs + 0.2, d: 0.4, to: fullEditor, bow: 40 },
      { t: docs + 1.0, d: 0.8, to: css('.craft-stage'), ox: -260, oy: -170, bow: 60 },
      { t: start - 0.8, d: 0.4, to: rail('Docs'), ox: 4, oy: 4, bow: 60 },
      { t: start - 0.25, d: 0.45, to: text('.main button.btn-primary', /^New doc$/), bow: 40 },
      { t: start + 0.5, d: 0.4, to: modalBtn(/^Project recap$/), bow: 40 },
      { t: start + 0.9, d: 0.3, to: css('.modal input'), ox: 120, bow: 30 },
      { t: start + 1.45, d: 0.35, to: modalBtn(/^Create doc$/), bow: 40 },
      { t: start + 1.95, d: 0.35, to: fullEditor, bow: 40 },
      { t: start + 2.7, d: 0.6, to: css('.craft-stage'), ox: -200, oy: -60, bow: 50 },
      { t: flight - 0.5, d: 0.4, to: edgeR },
      // 3.
      { t: tasks + 0.1, d: 0.6, to: text('.pj-block li, .pj-block div', /^Revise Acme quote/), ox: 40, oy: 10 },
      { t: owes - 0.05, d: 0.6, to: text('.pj-block li, .pj-block div', /MSA redline comments/), ox: 60, oy: 10 },
      { t: change - 0.55, d: 0.4, to: rail('Approvals'), ox: 4, oy: 4, bow: 60 },
      { t: change + 0.3, d: 0.45, to: within(priceCard, '.ap-actions button', /^Keep \$62$/), bow: 40 },
      { t: change + 1.2, d: 0.5, to: within(priceCard, '.ap-actions'), ox: -220, oy: 70 },
      { t: together - 1.7, d: 0.4, to: rail('Today & mail'), ox: 4, oy: 4, bow: 60 },
      { t: together - 1.1, d: 0.4, to: nav('Revised quote'), ox: 20, bow: 40 },
      { t: together, d: 0.6, to: within(draft, '.draft-body'), ox: 300, oy: -60 },
      { t: customers - 0.6, d: 0.5, to: edgeR },
      // 4.
      { t: tell - 0.35, d: 0.5, to: text('.main button.btn', /^Find leads$/), bow: 50 },
      { t: tell + 1.0, d: 0.5, to: css('.modal input'), ox: 160 },
      { t: finds - 0.4, d: 0.45, to: modalBtn(/Find and add/), bow: 40 },
      { t: scores - 0.1, d: 0.6, to: fitChip, ox: 30, oy: 12 },
      { t: fills - 0.1, d: 0.6, to: within(firstLead, 'td:nth-child(2)'), ox: 60, oy: 12 },
      { t: turns + 0.2, d: 0.7, to: foundList, ox: 40, bow: 60 },
      // 5.
      { t: campaign - 0.45, d: 0.45, to: css('.ai-launch'), ox: -80, bow: 50 },
      { t: campaign + 2.05, d: 0.6, to: css('.ai-input'), ox: 180, oy: -60 },
      { t: lands - 0.55, d: 0.5, to: text('.ai-shell button', /^Open the drafts$/), bow: 50 },
      { t: lands + 0.9, d: 0.6, to: css('.odr-list'), ox: 280, oy: -40 },
      { t: readThem - 0.2, d: 0.5, to: text('.out-head-actions .btn-primary', /^Send all/), ox: -240, oy: 120, bow: 40 },
      { t: sendThem - 0.3, d: 0.4, to: text('.out-head-actions .btn-primary', /^Send all/), bow: 30 },
      { t: finds1 - 0.6, d: 0.5, to: edgeBR },
      // 6.
      { t: connect + 0.4, d: 0.6, to: formCard(/^Website/), ox: 40, oy: 20, bow: 60 },
      { t: typeform - 0.1, d: 0.5, to: formCard(/^Typeform/), ox: 40, oy: 20 },
      { t: facebook - 0.1, d: 0.5, to: formCard(/Facebook Lead Ads/), ox: 40, oy: 20 },
      { t: moment - 0.75, d: 0.6, to: text('.main button', /Simulate a form lead/), bow: 50 },
      { t: moment + 0.7, d: 0.6, to: newLead, ox: 220, oy: -20 },
      { t: drafts1 - 0.35, d: 0.4, to: within(newLead, 'button', /Reply with times/), bow: 40 },
      { t: drafts1 + 0.9, d: 0.5, to: modalBtn(/^Send$/), ox: -180, oy: -60, bow: 40 },
      { t: book - 0.95, d: 0.35, to: modalBtn(/^Send$/), bow: 20 },
      { t: book - 0.45, d: 0.4, to: rail('Today & mail'), ox: 4, oy: 4, bow: 60 },
      { t: book + 0.35, d: 0.5, to: within(jamieRow, 'button', /^Book/), bow: 40 },
      { t: stops - 0.6, d: 0.5, to: edgeBR },
    ],
    presses: [
      // 1.
      { t: shows + 0.25, target: nav('Today') },
      { t: reply + 0.2, target: within(marcusRow, 'button', /^Review draft$/) },
      { t: sendIt + 0.12, target: within(draft, '.draft-send .btn-primary') },
      // 2.
      { t: links - 0.2, target: rail('Today & mail') },
      { t: links + 0.45, target: nav('Revised quote') },
      { t: links + 1.1, target: tab(/^Files & links/) },
      { t: docs + 0.02, target: linkCard(/Pricing tiers/) },
      { t: docs + 0.65, target: fullEditor },
      { t: start - 0.35, target: rail('Docs') },
      { t: start + 0.25, target: text('.main button.btn-primary', /^New doc$/) },
      { t: start + 0.9, target: modalBtn(/^Project recap$/) },
      { t: start + 1.22, target: css('.modal input') },
      { t: start + 1.82, target: modalBtn(/^Create doc$/) },
      { t: start + 2.35, target: fullEditor },
      // 3.
      { t: change - 0.1, target: rail('Approvals') },
      { t: change + 0.75, target: within(priceCard, '.ap-actions button', /^Keep \$62$/) },
      { t: together - 1.3, target: rail('Today & mail') },
      { t: together - 0.7, target: nav('Revised quote') },
      // 4.
      { t: tell + 0.15, target: text('.main button.btn', /^Find leads$/) },
      { t: finds + 0.08, target: modalBtn(/Find and add/) },
      // 5.
      { t: campaign + 0.05, target: css('.ai-launch') },
      { t: lands - 0.05, target: text('.ai-shell button', /^Open the drafts$/) },
      { t: sendThem + 0.2, target: text('.out-head-actions .btn-primary', /^Send all/) },
      // 6.
      { t: moment + 0.1, target: text('.main button', /Simulate a form lead/) },
      { t: drafts1 + 0.1, target: within(newLead, 'button', /Reply with times/) },
      { t: book - 0.7, target: modalBtn(/^Send$/) },
      { t: book - 0.05, target: rail('Today & mail') },
      { t: book + 0.95, target: within(jamieRow, 'button', /^Book/) },
    ],
    keys: [{ t: campaign + 1.95, key: 'Enter' }],
    typing: [
      { t: start + 1.3, text: 'Acme', cps: 14 },
      { t: tell + 0.6, text: '15 dental practices in Austin', cps: 22 },
      { t: campaign + 0.4, text: 'Write a campaign for my best leads', cps: 24 },
    ],
  };
}
