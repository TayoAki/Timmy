// 1. Inbox and mail: triage suggestions with reasons, accept the sure ones, a drafted reply, send & track.
import words from './words/inbox.json';
import { feature, film } from './common';
import { css, nav, nth, text, within, type Film, type Move } from '../script';

export default function inbox(): Film {
  const f = feature('inbox', words);
  const { w } = f;
  const suggests = w('suggests a label');
  const why = w('says why');
  const confirm = w('Confirm the sure');
  const click = w('one click', confirm);
  const open = w('Open a thread');
  const drafted = w('reply is already');
  const send = w('Send it');
  const waiting = w('Waiting until');

  const first = nth('.triage-item', 0);
  const accept = text('.page-head-row button.btn-primary', /^Accept \d+ confident/);
  const draft = css('section.draft[aria-label="Draft reply"]');
  const sendBtn = within(draft, '.draft-send .btn-primary');
  const danaRow = text('.row', /Revised quote for 120/);
  const edge: Move['to'] = { edge: [1990, 620] };

  return film(f, {
    start: { view: 'today', tab: 'triage' },
    cuts: [],
    cards: [],
    cams: [
      { t: 0, d: 0.01, target: 'full' },
      { t: suggests - 0.2, d: 0.9, target: first, zoom: 1.6, dx: 80 },
      { t: why - 0.1, d: 0.6, target: within(first, '.timmy-line'), zoom: 1.85, dx: 160 },
      { t: confirm - 0.35, d: 0.6, target: css('.triage-list'), zoom: 1.2, dy: -160 },
      { t: click + 0.6, d: 0.5, target: 'full' },
      { t: drafted - 0.2, d: 0.7, target: draft, zoom: 1.25, dy: -40 },
      { t: send - 0.1, d: 0.5, target: within(draft, '.draft-foot'), zoom: 1.5, dx: -120 },
      { t: send + 0.4, d: 0.45, target: css('.toasts .toast:last-child'), zoom: 1.45 },
      { t: waiting - 0.55, d: 0.35, target: 'full' },
      { t: waiting + 0.2, d: 0.6, target: danaRow, zoom: 1.5, dx: 200 },
    ],
    dims: [
      { t0: why + 0.4, t1: confirm - 0.4, target: within(first, '.timmy-line'), pad: 8 },
      { t0: waiting + 0.4, t1: f.recap - 0.2, target: danaRow },
    ],
    scrolls: [{ t: drafted - 0.6, d: 0.5, target: draft, offset: 40 }],
    moves: [
      { t: suggests + 0.1, d: 0.8, to: within(first, '.suggest-pill'), ox: 60, oy: 10, bow: 60 },
      { t: confirm - 0.2, d: 0.6, to: accept, bow: 50 },
      { t: click + 0.45, d: 0.5, to: css('.triage-list'), ox: 260, oy: -60 },
      { t: open - 0.45, d: 0.5, to: nav('Revised quote'), ox: 20, bow: 50 },
      { t: drafted + 0.4, d: 0.6, to: within(draft, '.draft-body'), ox: 300, oy: -40 },
      { t: send - 0.35, d: 0.45, to: sendBtn, bow: 40 },
      { t: waiting - 0.75, d: 0.4, to: nav('Waiting'), ox: 20, bow: 60 },
      { t: waiting + 0.3, d: 0.6, to: danaRow, ox: 320, oy: 14 },
      { t: f.recap - 0.6, d: 0.5, to: edge },
    ],
    presses: [
      { t: click, target: accept },
      { t: open, target: nav('Revised quote') },
      { t: send + 0.2, target: sendBtn },
      { t: waiting - 0.3, target: nav('Waiting') },
    ],
    typing: [],
    keys: [],
  });
}
