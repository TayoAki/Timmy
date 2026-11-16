// 11. Speed to lead and calls: connected forms, a new lead on the clock, the first reply, the call list and script.
import words from './words/speed.json';
import { feature, film } from './common';
import { closest, css, nth, tab, text, within, type Film, type Move } from '../script';

export default function speed(): Film {
  const f = feature('speed', words);
  const { w } = f;
  const connect = w('Connect your');
  const typeform = w('Typeform');
  const facebook = w('Facebook');
  const moment = w('The moment');
  const clock = w('the clock starts');
  const drafts = w('Timmy drafts');
  const rather = w('Rather call');
  const urgent = w('most urgent');
  const script = w('a script');

  const formGrid = closest(css('.form-card'), 'ul');
  const formCard = (re: RegExp) => text('.form-card', re);
  const simulate = text('.main button', /Simulate a form lead/);
  const newLead = nth('.spd-card', 0);
  const modal = css('.modal');
  const start = text('.main button', /Start calling/);
  const edge: Move['to'] = { edge: [1990, 700] };

  return film(f, {
    start: { view: 'outbound', tab: 'speed' },
    cuts: [],
    cards: [],
    cams: [
      { t: 0, d: 0.01, target: 'full' },
      { t: connect + 0.3, d: 0.9, target: formGrid, zoom: 1.3 },
      { t: moment - 0.9, d: 0.5, target: 'full' },
      { t: moment + 0.4, d: 0.7, target: newLead, zoom: 1.45 },
      { t: clock - 0.1, d: 0.5, target: newLead, zoom: 1.75, dx: 260, dy: -20 },
      { t: drafts - 0.55, d: 0.4, target: newLead, zoom: 1.45 },
      { t: drafts + 0.3, d: 0.6, target: modal, zoom: 1.35 },
      { t: rather - 0.2, d: 0.45, target: 'full' },
      { t: urgent - 0.3, d: 0.6, target: css('.call-row'), zoom: 1.5, dy: 80 },
      { t: script, d: 0.6, target: css('.call-script'), zoom: 1.6 },
    ],
    dims: [
      { t0: connect + 1.3, t1: moment - 0.95, target: formGrid },
      { t0: script + 0.6, t1: f.recap - 0.2, target: css('.call-script') },
    ],
    scrolls: [
      { t: connect + 0.1, d: 0.5, target: css('.form-card'), offset: 90 },
      { t: moment - 0.9, d: 0.45, target: css('.out-head, .page-title'), offset: 0 },
    ],
    moves: [
      { t: connect + 0.4, d: 0.6, to: formCard(/^Website/), ox: 40, oy: 20, bow: 60 },
      { t: typeform - 0.1, d: 0.5, to: formCard(/^Typeform/), ox: 40, oy: 20 },
      { t: facebook - 0.1, d: 0.5, to: formCard(/Facebook Lead Ads/), ox: 40, oy: 20 },
      { t: moment - 0.75, d: 0.6, to: simulate, bow: 50 },
      { t: moment + 0.7, d: 0.6, to: newLead, ox: 220, oy: -20 },
      { t: drafts - 0.35, d: 0.4, to: within(newLead, 'button', /Reply with times/), bow: 40 },
      { t: drafts + 0.9, d: 0.5, to: modal, ox: 200, oy: 100 },
      { t: rather - 0.1, d: 0.45, to: tab(/^Calls/), bow: 50 },
      { t: urgent - 0.1, d: 0.5, to: css('.call-row'), ox: 200 },
      { t: script - 0.75, d: 0.4, to: start, bow: 40 },
      { t: script + 0.6, d: 0.5, to: edge },
    ],
    presses: [
      { t: moment + 0.1, target: simulate },
      { t: drafts + 0.1, target: within(newLead, 'button', /Reply with times/) },
      { t: rather + 0.2, target: tab(/^Calls/) },
      { t: script - 0.3, target: start },
    ],
    typing: [],
    keys: [{ t: rather - 0.25, key: 'Escape' }],
  });
}
