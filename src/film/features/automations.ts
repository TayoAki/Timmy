// 13. Automations: the canvas, a trigger, the steps, the if/else branch, {{fields}} from the trigger, then a test run.
import words from './words/automations.json';
import { feature, film } from './common';
import { closest, css, text, type Film, type Move } from '../script';

export default function automations(): Film {
  const f = feature('automations', words);
  const { w } = f;
  const trigger = w('Pick a trigger');
  const steps = w('Add the steps');
  const draft = w('draft a reply');
  const ask = w('ask me first');
  const crm = w('update the CRM');
  const branch = w('Branch with');
  const fill = w('fill in');
  const test = w('Then test');
  const watch = w('watch each');

  const node = (re: RegExp) => closest(text('.ae-node-title', re), '.react-flow__node');
  const panel = css('.ae-panel');
  const testRun = text('.ae-top button, button', /^Test run$/);
  const canvas = css('.ae-canvas');
  const edge: Move['to'] = { edge: [1990, 700] };

  return film(f, {
    start: { view: 'automation', id: 'auto-speed' },
    cuts: [],
    cards: [],
    cams: [
      { t: 0, d: 0.01, target: 'full' },
      { t: trigger + 0.9, d: 0.7, target: node(/^Form submitted$/), zoom: 1.7, dx: 380, dy: 120 },
      { t: steps - 0.2, d: 0.6, target: canvas, zoom: 1.35, dx: -120, dy: 60 },
      { t: branch - 0.2, d: 0.6, target: node(/^If \/ else$/), zoom: 1.8, dy: 60 },
      { t: fill - 0.1, d: 0.6, target: panel, zoom: 1.5, dy: 40 },
      { t: test - 0.2, d: 0.5, target: 'full' },
      { t: watch - 0.2, d: 0.7, target: canvas, zoom: 1.3, dx: 120, dy: 80 },
    ],
    dims: [{ t0: fill + 0.6, t1: test - 0.25, target: panel }],
    scrolls: [],
    moves: [
      { t: trigger + 0.5, d: 0.6, to: node(/^Form submitted$/), bow: 60 },
      { t: draft - 0.2, d: 0.45, to: node(/^Draft a reply$/), bow: 40 },
      { t: ask - 0.2, d: 0.45, to: node(/^Ask me first$/), bow: 40 },
      { t: crm - 0.2, d: 0.45, to: node(/^Update the CRM$/), bow: 40 },
      { t: branch - 0.1, d: 0.5, to: node(/^If \/ else$/), bow: 40 },
      { t: fill - 0.5, d: 0.45, to: node(/^Draft a reply$/), bow: 40 },
      { t: fill + 0.6, d: 0.5, to: panel, ox: 40, oy: 40 },
      { t: test - 0.1, d: 0.5, to: testRun, bow: 50 },
      { t: watch + 0.2, d: 0.6, to: canvas, ox: 300, oy: 200 },
      { t: f.recap - 0.5, d: 0.5, to: edge },
    ],
    presses: [
      { t: trigger + 1.2, target: node(/^Form submitted$/) },
      { t: branch + 0.5, target: node(/^If \/ else$/) },
      { t: fill - 0.05, target: node(/^Draft a reply$/) },
      { t: test + 0.45, target: testRun },
    ],
    typing: [],
    keys: [],
  });
}
