// 10. Campaigns and Unibox: a new campaign, the sequence Timmy writes, Launch within limits, every reply labelled.
import words from './words/outreach.json';
import { feature, film } from './common';
import { closest, css, nth, rail, tab, text, type Film, type Move } from '../script';

export default function outreach(): Film {
  const f = feature('outreach', words);
  const { w } = f;
  const pick = w('Pick your');
  const first = w('a first email');
  const bump = w('a bump');
  const call = w('a call');
  const study = w('a case study');
  const breakup = w('a break-up');
  const launch = w('Launch it');
  const limits = w('safe daily');
  const reply = w('When people');
  const labelled = w('labelled');
  const next = w('your next message');

  const modal = css('.modal');
  const step = (n: number) => nth('.seq-steps .seq-step', n - 1);
  const launchBtn = text('.main button', /^Launch$/);
  const confirm = text('.modal button', /^Launch$/);
  const jamie = closest(text('.main *', /^Jamie Ortega$/), 'button, [role="button"], li, article');
  const suggest = text('.main button', /Confirm today at/);
  const edge: Move['to'] = { edge: [1990, 700] };

  return film(f, {
    start: { view: 'outbound', tab: 'campaigns' },
    cuts: [],
    cards: [],
    cams: [
      { t: 0, d: 0.01, target: 'full' },
      { t: pick + 1.3, d: 0.6, target: modal, zoom: 1.45 },
      { t: first - 0.5, d: 0.5, target: 'full' },
      { t: first - 0.05, d: 0.6, target: step(1), zoom: 1.6, dx: 240, dy: 140 },
      { t: launch - 0.25, d: 0.45, target: 'full' },
      { t: launch + 0.6, d: 0.6, target: modal, zoom: 1.6 },
      { t: limits + 0.4, d: 0.45, target: css('.toasts .toast:last-child'), zoom: 1.5 },
      { t: reply - 0.1, d: 0.4, target: 'full' },
      { t: reply + 1.3, d: 0.6, target: css('.main'), zoom: 1.4, dx: -260, dy: 60 },
      { t: next - 0.6, d: 0.6, target: suggest, zoom: 1.35, dx: -380, dy: -170 },
    ],
    dims: [{ t0: limits - 0.6, t1: limits + 0.15, target: modal, pad: 0 }],
    scrolls: [],
    moves: [
      { t: pick - 0.1, d: 0.6, to: text('.main button', /New campaign/), bow: 50 },
      { t: pick + 1.7, d: 0.5, to: text('.modal button', /Write the sequence/), bow: 40 },
      { t: first + 0.1, d: 0.4, to: step(1), ox: 60 },
      { t: bump, d: 0.35, to: step(2), ox: 60 },
      { t: call, d: 0.35, to: step(3), ox: 60 },
      { t: study, d: 0.35, to: step(4), ox: 60 },
      { t: breakup, d: 0.35, to: step(5), ox: 60 },
      { t: launch - 0.2, d: 0.4, to: launchBtn, bow: 40 },
      { t: launch + 0.6, d: 0.5, to: confirm, bow: 40 },
      { t: reply - 0.05, d: 0.4, to: rail('Outbound'), ox: 4, oy: 4, bow: 50 },
      { t: reply + 0.55, d: 0.4, to: tab(/^Unibox/), bow: 40 },
      { t: labelled - 0.3, d: 0.5, to: jamie, ox: 40, bow: 40 },
      { t: next - 0.3, d: 0.5, to: suggest, bow: 40 },
      { t: f.recap - 0.5, d: 0.5, to: edge },
    ],
    presses: [
      { t: pick + 0.55, target: text('.main button', /New campaign/) },
      { t: pick + 2.3, target: text('.modal button', /Write the sequence/) },
      { t: launch + 0.25, target: launchBtn },
      { t: limits + 0.2, target: confirm },
      { t: reply + 0.4, target: rail('Outbound') },
      { t: reply + 1.0, target: tab(/^Unibox/) },
      { t: labelled + 0.25, target: jamie },
      { t: next + 0.15, target: suggest },
    ],
    typing: [],
    keys: [],
  });
}
