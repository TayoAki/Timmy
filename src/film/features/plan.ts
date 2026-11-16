// 7. Tasks and calendar: cards from email, drag along, quick capture, focus blocks and meeting prep.
import words from './words/plan.json';
import { feature, film } from './common';
import { closest, css, rail, text, within, type Film, type Move } from '../script';

export default function plan(): Film {
  const f = feature('plan', words);
  const { w } = f;
  const land = w('land on');
  const project = w('the project');
  const due = w('due date');
  const who = w("who it's");
  const drag = w('Drag a card');
  const capture = w('Capture a');
  const calendar = w('On the calendar');
  const focus = w('blocks focus');
  const preps = w('preps you');

  const card = closest(text('.tk-card', /Revise Acme quote/), '.tk-card');
  const lane = (re: RegExp) => closest(text('.tk-col-title', re), '.tk-col');
  const focusBlock = text('.main [class*="ev"], .main button, .main div', /^Focus: Revised Acme quote/);
  const prep = closest(text('.rp-title', /Prep for your next/), '.rp-section');
  const edge: Move['to'] = { edge: [1990, 700] };

  return film(f, {
    start: { view: 'tasks', tab: 'board' },
    cuts: [],
    cards: [],
    cams: [
      { t: 0, d: 0.01, target: 'full' },
      { t: land, d: 0.7, target: card, zoom: 1.9, dx: 60 },
      { t: drag - 0.4, d: 0.5, target: css('.tk-board'), zoom: 1.2, dx: 60, dy: -120 },
      { t: capture - 0.2, d: 0.5, target: 'full' },
      { t: capture + 0.5, d: 0.6, target: css('.modal'), zoom: 1.5 },
      { t: capture + 2.2, d: 0.4, target: 'full' },
      { t: focus - 0.2, d: 0.7, target: focusBlock, zoom: 1.9 },
      { t: preps - 0.3, d: 0.7, target: prep, zoom: 1.6, dx: -80 },
    ],
    dims: [
      { t0: focus + 0.6, t1: preps - 0.35, target: focusBlock, pad: 8 },
      { t0: preps + 0.45, t1: f.recap - 0.2, target: prep },
    ],
    scrolls: [],
    moves: [
      { t: land + 0.2, d: 0.6, to: within(card, '.tk-card-top'), ox: 60, bow: 60 },
      { t: project - 0.1, d: 0.4, to: text('.tk-card *', /^Acme Renewal$/), ox: 30 },
      { t: due - 0.1, d: 0.4, to: text('.tk-card button, .tk-card span', /^Tomorrow$/), ox: 10 },
      { t: who - 0.1, d: 0.4, to: text('.tk-card *', /^Dana$/), ox: 10 },
      { t: drag - 0.6, d: 0.5, to: card, bow: 50 },
      { t: capture + 1.6, d: 0.5, to: css('.modal'), ox: 260, oy: 80 },
      { t: capture + 2.3, d: 0.45, to: rail('Calendar'), ox: 4, oy: 4, bow: 50 },
      { t: focus + 0.2, d: 0.6, to: focusBlock, ox: 30 },
      { t: preps + 0.1, d: 0.6, to: prep, ox: -60, oy: 30 },
      { t: f.recap - 0.6, d: 0.5, to: edge },
    ],
    drags: [{ t: drag + 0.1, d: 1.0, from: card, to: lane(/^In progress/), oy: 40 }],
    presses: [{ t: calendar + 0.05, target: rail('Calendar') }],
    typing: [{ t: capture + 0.45, text: 'Ask Raj if SSO needs its own contract', cps: 26 }],
    keys: [
      { t: capture - 0.05, key: 'Control+j' },
      { t: capture + 2.05, key: 'Enter' },
    ],
  });
}
