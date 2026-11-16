// 6. Drive: To file (folder and dated name suggested), File it, numbered folders, a real sheet, the full editor.
import words from './words/files.json';
import { feature, film } from './common';
import { css, nth, tab, text, within, type Film, type Move } from '../script';

export default function files(): Film {
  const f = feature('files', words);
  const { w } = f;
  const each = w('For each');
  const folder = w('a folder');
  const dated = w('dated name');
  const check = w('Check it');
  const click = w('file it', check);
  const numbered = w('Folders are');
  const open = w('Open a sheet');
  const real = w('figures are');
  const word = w('Need Word');
  const editors = w('The full editors');

  const card = nth('.dr-card', 0);
  const body = within(card, '.dr-card-body');
  const fileIt = within(card, '.dr-card-foot .btn-primary');
  const table = css('.dr-table');
  const acme = text('.dr-table .table-row', /\[10\]\s*Acme/);
  const sheet = text('.dr-table .table-row', /Quote tracker/);
  const fullEditor = text('.file-mode [role="radio"]', /^Full editor$/);
  const edge: Move['to'] = { edge: [1990, 700] };

  return film(f, {
    start: { view: 'files', tab: 'filing', folder: 'f02' },
    cuts: [],
    cards: [],
    cams: [
      { t: 0, d: 0.01, target: 'full' },
      { t: each + 1.0, d: 0.7, target: card, zoom: 1.45 },
      { t: folder - 0.3, d: 0.6, target: body, zoom: 1.9, dx: -230 },
      { t: dated - 0.25, d: 0.6, target: body, zoom: 1.9, dx: 230 },
      { t: check - 0.1, d: 0.6, target: card, zoom: 1.45, dy: 40 },
      { t: click + 0.3, d: 0.4, target: css('.toasts .toast:last-child'), zoom: 1.6 },
      { t: numbered - 0.55, d: 0.35, target: 'full' },
      { t: numbered + 0.4, d: 0.7, target: table, zoom: 1.35, dx: -120 },
      { t: open - 0.4, d: 0.4, target: 'full' },
      { t: real - 0.2, d: 0.7, target: css('.main'), zoom: 1.3, dy: -60 },
      { t: word - 0.3, d: 0.45, target: fullEditor, zoom: 1.6, dx: 160 },
      { t: editors + 0.1, d: 0.6, target: 'full' },
    ],
    dims: [
      { t0: folder + 0.4, t1: dated - 0.3, target: body },
      { t0: numbered + 1.2, t1: open - 0.45, target: table },
    ],
    scrolls: [],
    moves: [
      { t: each + 1.1, d: 0.6, to: body, ox: -200, oy: -10, bow: 60 },
      { t: dated, d: 0.5, to: body, ox: 200, oy: -10 },
      { t: check + 0.1, d: 0.6, to: fileIt, bow: 50 },
      { t: click + 0.3, d: 0.35, to: fileIt, ox: -200, oy: 60 },
      { t: numbered - 0.5, d: 0.4, to: tab(/^Browse/), bow: 50 },
      { t: numbered + 0.6, d: 0.6, to: nth('.dr-table .table-row', 2), ox: -200 },
      { t: open - 1.0, d: 0.5, to: acme, ox: -200, bow: 40 },
      { t: open - 0.15, d: 0.4, to: sheet, ox: -160, bow: 40 },
      { t: real + 0.4, d: 0.6, to: css('.main'), ox: 300, oy: 60 },
      { t: word - 0.3, d: 0.45, to: fullEditor, bow: 40 },
      { t: editors + 0.5, d: 0.6, to: edge },
    ],
    presses: [
      { t: click, target: fileIt },
      { t: numbered - 0.05, target: tab(/^Browse/) },
      { t: open - 0.55, target: acme },
      { t: open + 0.3, target: sheet },
      { t: word + 0.4, target: fullEditor },
    ],
    typing: [],
    keys: [],
  });
}
