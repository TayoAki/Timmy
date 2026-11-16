// 4. Ask Timmy: open it, "Plan my day", the steps, then live cards (urgent, approvals, the day), buttons you press.
import words from './words/ask.json';
import { feature, film } from './common';
import { css, nth, within, type Film, type Move } from '../script';

export default function ask(): Film {
  const f = feature('ask', words);
  const { w } = f;
  const open = w('Open Ask');
  const say = w('say what');
  const plan = w('plan my day');
  const reads = w('Timmy reads');
  const cards = w('live cards');
  const urgent = w("what's urgent");
  const waiting = w("what's waiting");
  const meetings = w('your meetings');
  const anything = w('Anything that');
  const button = w('a button you');

  const card = (i: number) => nth('.ai-thread .aw', i);
  const urgentCard = card(0);
  const dayCard = card(1);
  const okCard = card(2);
  const edge: Move['to'] = { edge: [1990, 700] };

  return film(f, {
    start: { view: 'today', tab: 'brief' },
    cuts: [],
    cards: [],
    cams: [
      { t: 0, d: 0.01, target: 'full' },
      { t: open + 0.3, d: 0.5, target: css('.ai-launch'), zoom: 1.5, dy: -100 },
      { t: say + 0.1, d: 0.6, target: css('.ai-input'), zoom: 1.7, dy: 40 },
      { t: reads - 0.1, d: 0.6, target: css('.ai-thread'), zoom: 1.45, dy: -160 },
      { t: cards - 0.3, d: 0.6, target: css('.ai-main'), zoom: 1.15 },
      { t: urgent - 0.3, d: 0.6, target: urgentCard, zoom: 1.45 },
      { t: waiting - 0.25, d: 0.6, target: okCard, zoom: 1.45 },
      { t: meetings - 0.3, d: 0.6, target: dayCard, zoom: 1.45 },
      { t: anything + 0.2, d: 0.6, target: okCard, zoom: 1.6 },
    ],
    dims: [{ t0: button - 0.1, t1: f.recap - 0.25, target: within(okCard, '.aw-actions'), pad: 10 }],
    scrolls: [
      { t: urgent - 0.35, d: 0.4, target: urgentCard, offset: 20 },
      { t: waiting - 0.3, d: 0.4, target: okCard, offset: 20 },
      { t: meetings - 0.35, d: 0.4, target: dayCard, offset: 20 },
      { t: anything + 0.15, d: 0.4, target: okCard, offset: 20 },
    ],
    moves: [
      { t: open + 0.2, d: 0.55, to: css('.ai-launch'), ox: -60, bow: 60 },
      { t: say + 0.5, d: 0.5, to: css('.ai-input'), ox: 160, oy: -10 },
      { t: plan + 1.0, d: 0.6, to: css('.ai-main'), ox: 360, oy: 160 },
      { t: urgent + 0.2, d: 0.6, to: urgentCard, ox: 200, oy: 0 },
      { t: anything + 0.5, d: 0.7, to: within(okCard, '.aw-actions button'), bow: 50 },
      { t: f.recap - 0.6, d: 0.5, to: edge },
    ],
    presses: [
      { t: open + 0.9, target: css('.ai-launch') },
      { t: say + 1.0, target: css('.ai-input') },
    ],
    typing: [{ t: plan - 0.35, text: 'Plan my day', cps: 13 }],
    keys: [{ t: plan + 0.75, key: 'Enter' }],
  });
}
