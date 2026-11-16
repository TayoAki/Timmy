// 9. Find leads: describe them, the scored list, the contact details, why each fits, and import.
import words from './words/leads.json';
import { feature, film } from './common';
import { closest, css, nth, text, within, type Film, type Move } from '../script';

export default function leads(): Film {
  const f = feature('leads', words);
  const { w } = f;
  const describe = w('Describe the');
  const finds = w('Timmy finds');
  const scores = w('scores each');
  const fills = w('fills in');
  const best = w('The best');
  const why = w('each lead shows');
  const already = w('Already have');
  const imp = w('Import it');
  const too = w('scores those');

  const modal = css('.modal');
  const findBtn = text('.main button.btn', /^Find leads$/);
  const first = nth('.lead-table tbody tr', 0);
  const fit = within(first, 'td:nth-child(5) > *');
  const who = within(first, 'td:nth-child(2)');
  const fitPanel = closest(text('.rp-title', /Fit with your offer/), '.rp-section');
  const importBtn = text('.main button', /Import CSV/);
  const edge: Move['to'] = { edge: [1990, 700] };

  return film(f, {
    start: { view: 'outbound', tab: 'leads' },
    cuts: [],
    cards: [],
    cams: [
      { t: 0, d: 0.01, target: 'full' },
      { t: describe + 1.7, d: 0.6, target: modal, zoom: 1.5 },
      { t: finds + 1.2, d: 0.5, target: 'full' },
      { t: scores - 0.3, d: 0.6, target: fit, zoom: 1.75, dy: 160 },
      { t: fills - 0.15, d: 0.6, target: who, zoom: 1.75, dx: 200, dy: 160 },
      { t: best - 0.2, d: 0.6, target: css('.lead-table'), zoom: 1.25, dy: -140 },
      { t: why + 0.3, d: 0.6, target: fitPanel, zoom: 1.7, dx: -100 },
      { t: imp - 0.3, d: 0.45, target: 'full' },
      { t: imp + 0.5, d: 0.6, target: modal, zoom: 1.4 },
    ],
    dims: [
      { t0: scores + 0.4, t1: fills - 0.2, target: fit, pad: 6 },
      { t0: fills + 0.5, t1: best - 0.25, target: first },
      { t0: why + 0.95, t1: already + 0.6, target: fitPanel },
    ],
    scrolls: [],
    moves: [
      { t: describe + 0.8, d: 0.5, to: findBtn, bow: 50 },
      { t: describe + 1.8, d: 0.4, to: css('.modal input'), ox: 160 },
      { t: finds + 0.2, d: 0.45, to: text('.modal button', /Find and add/), bow: 40 },
      { t: scores - 0.1, d: 0.6, to: fit, ox: 30, oy: 12 },
      { t: fills - 0.1, d: 0.6, to: who, ox: 60, oy: 12 },
      { t: why - 0.4, d: 0.5, to: who, bow: 40 },
      { t: already, d: 0.6, to: importBtn, bow: 50 },
      { t: too + 0.4, d: 0.6, to: edge },
    ],
    presses: [
      { t: describe + 1.3, target: findBtn },
      { t: finds + 0.7, target: text('.modal button', /Find and add/) },
      { t: why + 0.05, target: who },
      { t: imp + 0.1, target: importBtn },
    ],
    typing: [{ t: describe + 1.6, text: '15 dental practices in Austin', cps: 26 }],
    keys: [],
  });
}
