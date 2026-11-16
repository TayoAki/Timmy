// 2. Daily brief: the morning run, the ranked list with reasons, Book it, a drafted reply, the calendar.
import words from './words/brief.json';
import { feature, film } from './common';
import { closest, css, rail, text, within, type Film, type Move } from '../script';

export default function brief(): Film {
  const f = feature('brief', words);
  const { w } = f;
  const eight = w('At eight');
  const ranks = w('and ranks');
  const reason = w('the reason for');
  const jamie = w('Jamie confirmed');
  const click = w('one click', jamie);
  const marcus = w('Marcus needs');
  const drafted = w('his reply');
  const notes = w('your files');
  const calendar = w('Your calendar sits');

  const jamieRow = closest(text('.urg-lead .urg-row-title', /confirmed/), '.urg-row');
  const book = within(jamieRow, 'button', /^Book/);
  const marcusRow = closest(text('.urg-row-title', /Dec 1 pilot start/), '.urg-row');
  const review = within(marcusRow, 'button', /^Review draft$/);
  const draft = css('section.draft[aria-label="Draft reply"]');
  const source = within(draft, '.draft-head .chips');
  const cal = closest(text('.rp-title', /calendar/i), '.rp-section');
  const edge: Move['to'] = { edge: [1990, 640] };

  return film(f, {
    start: { view: 'today', tab: 'brief' },
    cuts: [],
    cards: [],
    cams: [
      { t: 0, d: 0.01, target: 'full' },
      { t: eight + 1.0, d: 0.6, target: css('.brief-head'), zoom: 1.6, dx: 120, dy: 50 },
      { t: ranks + 0.15, d: 0.6, target: css('.urg-list'), zoom: 1.3 },
      { t: reason - 0.2, d: 0.6, target: marcusRow, zoom: 1.6, dx: 80 },
      { t: jamie - 0.3, d: 0.6, target: jamieRow, zoom: 1.6, dx: 100 },
      { t: click + 0.25, d: 0.45, target: css('.toasts .toast:last-child'), zoom: 1.6 },
      { t: marcus + 0.25, d: 0.45, target: marcusRow, zoom: 1.5, dx: 120 },
      { t: drafted - 0.1, d: 0.7, target: draft, zoom: 1.2, dy: -60 },
      { t: notes - 0.35, d: 0.6, target: source, zoom: 1.7, dx: 160, dy: 40 },
      { t: calendar - 1.0, d: 0.35, target: 'full' },
      { t: calendar + 0.1, d: 0.7, target: cal, zoom: 1.6, dx: -60 },
    ],
    dims: [
      { t0: reason + 0.45, t1: jamie - 0.35, target: marcusRow },
      { t0: notes + 0.3, t1: calendar - 1.05, target: source, pad: 8 },
      { t0: calendar + 0.95, t1: f.recap - 0.2, target: cal },
    ],
    scrolls: [{ t: drafted - 0.3, d: 0.45, target: draft, offset: 60 }],
    moves: [
      { t: eight + 1.1, d: 0.7, to: css('.run-control'), ox: 40, oy: 4, bow: 60 },
      { t: ranks + 0.25, d: 0.6, to: css('.urg-list .urg-row'), ox: 260, oy: 10 },
      { t: reason - 0.1, d: 0.6, to: marcusRow, ox: 40, oy: 16 },
      { t: jamie + 0.4, d: 0.6, to: book, bow: 50 },
      { t: click + 0.35, d: 0.5, to: jamieRow, ox: -160, oy: 50 },
      { t: marcus + 0.3, d: 0.5, to: review, bow: 50 },
      { t: drafted + 0.6, d: 0.6, to: within(draft, '.draft-body'), ox: 300, oy: -60 },
      { t: calendar - 0.8, d: 0.4, to: rail('Today & mail'), ox: 4, oy: 4, bow: 60 },
      { t: calendar + 0.4, d: 0.6, to: cal, ox: -40, oy: 40 },
      { t: f.recap - 0.6, d: 0.5, to: edge },
    ],
    presses: [
      { t: click, target: book },
      { t: marcus + 0.85, target: review },
      { t: calendar - 0.35, target: rail('Today & mail') },
    ],
    typing: [],
    keys: [],
  });
}
