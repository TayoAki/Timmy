// 8. Projects and people: the Acme page (due, waiting, decisions, deal), then Dana's contact page.
import words from './words/projects.json';
import { feature, film } from './common';
import { closest, css, text, type Film, type Move } from '../script';

export default function projects(): Film {
  const f = feature('projects', words);
  const { w } = f;
  const gathers = w('gathers');
  const tasks = w('tasks', gathers);
  const mail = w('mail', gathers);
  const files = w('files', gathers);
  const decisions = w('decisions');
  const due = w("See what's");
  const owes = w('who owes');
  const numbers = w('latest numbers');
  const contact = w('Open a contact');
  const next = w('next step');
  const history = w('history');
  const mark = w('Mark the');
  const reminds = w('reminds you');

  const block = (re: RegExp) => closest(text('.pj-block h2', re), '.pj-block');
  const ptab = (re: RegExp) => text('[role="tab"]', re);
  const dana = text('.pj-person', /Dana Whitfield/);
  const card = (re: RegExp) => closest(text('.main h3, .main h2', re), '.card');
  const edge: Move['to'] = { edge: [1990, 700] };

  return film(f, {
    start: { view: 'project', id: 'acme', tab: 'overview' },
    cuts: [],
    cards: [],
    cams: [
      { t: 0, d: 0.01, target: 'full' },
      { t: gathers - 0.3, d: 0.7, target: ptab(/^Mail/), zoom: 1.9, dx: 60, dy: 40 },
      { t: decisions - 0.2, d: 0.6, target: block(/^Latest decisions$/), zoom: 1.6 },
      { t: due - 0.25, d: 0.5, target: block(/^Due soon$/), zoom: 1.65 },
      { t: owes - 0.2, d: 0.5, target: block(/^Waiting on others$/), zoom: 1.65 },
      { t: numbers - 0.2, d: 0.5, target: block(/^Deal$/), zoom: 1.65 },
      { t: contact + 0.4, d: 0.45, target: 'full' },
      { t: next - 0.2, d: 0.6, target: card(/^Relationship$/), zoom: 1.55, dy: 40 },
      { t: history - 0.2, d: 0.6, target: closest(text('.main h2, .main h3', /^Open emails$/), 'section, div'), zoom: 1.5 },
      { t: mark - 0.2, d: 0.6, target: card(/^Relationship$/), zoom: 1.7, dy: -60 },
    ],
    dims: [
      { t0: decisions + 0.4, t1: due - 0.3, target: block(/^Latest decisions$/) },
      { t0: numbers + 0.35, t1: contact - 0.1, target: block(/^Deal$/) },
      { t0: reminds - 0.1, t1: f.recap - 0.2, target: card(/^Relationship$/) },
    ],
    scrolls: [],
    moves: [
      { t: tasks - 0.15, d: 0.45, to: ptab(/^Tasks/), bow: 50 },
      { t: mail - 0.15, d: 0.35, to: ptab(/^Mail/) },
      { t: files - 0.15, d: 0.35, to: ptab(/^Files/) },
      { t: decisions, d: 0.5, to: block(/^Latest decisions$/), ox: 120, oy: -20 },
      { t: due, d: 0.4, to: block(/^Due soon$/), ox: 100 },
      { t: owes, d: 0.4, to: block(/^Waiting on others$/), ox: 100 },
      { t: numbers, d: 0.4, to: block(/^Deal$/), ox: 60 },
      { t: contact - 0.4, d: 0.45, to: dana, bow: 50 },
      { t: next + 0.2, d: 0.6, to: card(/^Relationship$/), ox: 80, oy: 20 },
      { t: mark + 0.1, d: 0.6, to: css('.main .switch'), bow: 40 },
      { t: f.recap - 0.6, d: 0.5, to: edge },
    ],
    presses: [{ t: contact + 0.1, target: dana }],
    typing: [],
    keys: [],
  });
}
