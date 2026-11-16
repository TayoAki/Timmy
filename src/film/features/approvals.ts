// 3. Approvals: one queue, a price decision shown side by side, Keep $62, the Decided log with undo.
import words from './words/approvals.json';
import { feature, film } from './common';
import { closest, css, tab, text, within, type Film, type Move } from '../script';

export default function approvals(): Film {
  const f = feature('approvals', words);
  const { w } = f;
  const emails = w('Emails, price');
  const queue = w('one queue');
  const dana = w('Dana wants');
  const shows = w('shows both');
  const pick = w('Pick one');
  const reply = w('the reply and');
  const every = w('Every decision');

  const filters = css('.filters');
  const filter = (re: RegExp) => text('.filters .filter', re);
  const priceCard = closest(text('.ap-title', /Give Acme \$58/), '.ap-card');
  const facts = within(priceCard, '.ap-facts');
  const keep = within(priceCard, '.ap-actions button', /^Keep \$62$/);
  const decided = tab(/^Decided/);
  const edge: Move['to'] = { edge: [1990, 640] };

  return film(f, {
    start: { view: 'approvals', tab: 'open' },
    cuts: [],
    cards: [],
    cams: [
      { t: 0, d: 0.01, target: 'full' },
      { t: emails + 1.3, d: 0.8, target: filters, zoom: 1.7, dx: 120, dy: 60 },
      { t: queue + 0.3, d: 0.5, target: 'full' },
      { t: dana - 0.1, d: 0.6, target: priceCard, zoom: 1.35 },
      { t: shows + 0.1, d: 0.6, target: facts, zoom: 1.8, dy: 30 },
      { t: pick - 0.4, d: 0.5, target: priceCard, zoom: 1.4, dy: 40 },
      { t: reply + 0.1, d: 0.5, target: css('.toasts .toast:last-child'), zoom: 1.6 },
      { t: every - 0.55, d: 0.4, target: 'full' },
      { t: every + 0.35, d: 0.6, target: css('.ap-history .log-item'), zoom: 1.9, dx: 140 },
      { t: every + 1.35, d: 0.6, target: css('.toasts .toast:last-child'), zoom: 1.6 },
    ],
    dims: [{ t0: shows + 0.7, t1: pick - 0.45, target: facts, pad: 12 }],
    scrolls: [{ t: dana - 0.4, d: 0.45, target: priceCard, offset: 120 }],
    moves: [
      { t: emails + 0.9, d: 0.6, to: filter(/^Emails to send/), oy: 4, bow: 60 },
      { t: w('CRM updates') - 0.2, d: 0.5, to: filter(/^CRM updates/), oy: 4 },
      { t: w('invites') - 0.1, d: 0.45, to: filter(/^Calendar invites/), oy: 4 },
      { t: dana + 0.3, d: 0.6, to: within(priceCard, '.ap-title'), ox: 140, oy: 6, bow: 50 },
      { t: shows + 0.6, d: 0.6, to: facts, ox: 120, oy: 30 },
      { t: pick - 0.35, d: 0.4, to: keep, bow: 40 },
      { t: pick + 0.7, d: 0.45, to: within(priceCard, '.ap-actions'), ox: -220, oy: 70 },
      { t: every - 0.5, d: 0.4, to: decided, bow: 50 },
      { t: every + 0.4, d: 0.6, to: css('.ap-history .log-item'), ox: 120, oy: 10 },
      { t: every + 1.4, d: 0.6, to: text('.toasts button', /^Undo$/), ox: 4, oy: 4, bow: 40 },
      { t: f.recap - 0.6, d: 0.5, to: edge },
    ],
    presses: [
      { t: pick + 0.2, target: keep },
      { t: every - 0.05, target: decided },
    ],
    typing: [],
    keys: [],
  });
}
