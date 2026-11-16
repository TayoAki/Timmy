// 5. Docs: the "/" menu, a to-do, the live table from a sheet, drag, Tab to nest, icon and cover, Timmy's summary.
import words from './words/docs.json';
import { feature, film } from './common';
import { closest, css, text, type Film, type Move, type Target } from '../script';

export default function docs(): Film {
  const f = feature('docs', words);
  const { w } = f;
  const slash = w('Type slash');
  const headings = w('headings');
  const todo = w('to-do lists');
  const toggles = w('toggles');
  const tables = w('tables');
  const live = w('a live table');
  const drag = w('Drag blocks');
  const nest = w('nest them');
  const icon = w('give the page');
  const cover = w('a cover');
  const ask = w('Then ask');
  const watch = w('watch it');

  const addBlock = text('.doc-tail button', /Add block/);
  const item = (re: RegExp) => text('.nb-slash-item', re);
  const menu = css('.nb-slash');
  const myTodo = closest(text('.nb-editor .nb-todo', /Send Dana the quote/), '.nb-todo');
  const bullets = (i: number) => () => ([...document.querySelectorAll('.nb-editor > ul, .nb-editor > .nb-bullet, .nb-editor > li')] as HTMLElement[])[i] ?? null;
  const notes = text('.nb-editor > h2, .nb-editor > h3', /^Notes$/);
  const linked = css('.doc-linked');
  const grip = css('.nb-gutter-btn.grip');
  const rocket: Target = () => text('.nb-emoji', /🚀/)() ?? css('.nb-emoji')();
  const edge: Move['to'] = { edge: [1990, 700] };

  return film(f, {
    start: { view: 'file', id: 'acme-quote-summary' },
    cuts: [],
    cards: [],
    cams: [
      { t: 0, d: 0.01, target: 'full' },
      { t: slash + 1.4, d: 0.6, target: addBlock, zoom: 1.4, dy: -200 },
      { t: headings - 0.2, d: 0.6, target: menu, zoom: 1.6 },
      { t: live - 0.15, d: 0.7, target: linked, zoom: 1.5 },
      { t: drag - 0.5, d: 0.6, target: notes, zoom: 1.45, dy: 60 },
      { t: icon - 0.3, d: 0.7, target: css('.pg-titlebox'), zoom: 1.35, dy: -60 },
      { t: cover + 0.2, d: 0.5, target: 'full' },
      { t: ask + 0.2, d: 0.7, target: addBlock, zoom: 1.35, dy: -220 },
      { t: watch - 0.3, d: 0.7, target: addBlock, zoom: 1.65, dx: 120, dy: -170 },
    ],
    dims: [{ t0: live + 0.6, t1: drag - 0.55, target: linked }],
    scrolls: [
      { t: slash + 1.2, d: 0.4, target: addBlock, offset: 520 },
      { t: icon - 0.35, d: 0.4, target: css('.pg-titlebox'), offset: 120 },
      { t: ask, d: 0.4, target: addBlock, offset: 620 },
    ],
    moves: [
      { t: slash + 1.0, d: 0.6, to: addBlock, bow: 60 },
      { t: headings, d: 0.4, to: item(/^Heading 1/), ox: 40, bow: 30 },
      { t: todo, d: 0.35, to: item(/^To-do/), ox: 40 },
      { t: toggles, d: 0.35, to: item(/^Toggle/), ox: 40 },
      { t: toggles + 0.3, d: 0.3, to: item(/^Table/), ox: 40 },
      { t: live + 0.2, d: 0.6, to: linked, ox: 200, oy: -40 },
      { t: drag - 0.45, d: 0.4, to: myTodo, ox: 40 },
      { t: nest + 0.15, d: 0.4, to: myTodo, ox: 60 },
      { t: icon - 0.05, d: 0.5, to: css('.pg-icon'), bow: 50 },
      { t: icon + 0.75, d: 0.4, to: rocket, bow: 30 },
      { t: cover - 0.55, d: 0.45, to: text('.pg-addon', /Add cover/), bow: 40 },
      { t: ask + 0.1, d: 0.5, to: addBlock, bow: 50 },
      { t: watch + 0.5, d: 0.6, to: edge },
    ],
    drags: [{ t: drag + 0.05, d: 0.9, from: grip, to: bullets(1), oy: -14 }],
    presses: [
      { t: slash + 1.65, target: addBlock },
      { t: nest + 0.6, target: myTodo },
      { t: icon + 0.45, target: css('.pg-icon') },
      { t: icon + 1.2, target: rocket },
      { t: cover - 0.05, target: text('.pg-addon', /Add cover/) },
      { t: ask + 0.65, target: addBlock },
    ],
    typing: [
      { t: tables - 0.1, text: 'todo', cps: 14 },
      { t: tables + 0.55, text: 'Send Dana the quote', cps: 16 },
      { t: ask + 0.9, text: 'sum', cps: 12 },
    ],
    keys: [
      { t: tables + 0.42, key: 'Enter' },
      { t: nest + 0.7, key: 'End' },
      { t: nest + 0.8, key: 'Tab' },
      { t: ask + 1.3, key: 'Enter' },
    ],
  });
}
