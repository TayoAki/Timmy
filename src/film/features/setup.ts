// 14. Connections and rules: each app says what Timmy reads and writes, a rule in plain English, and what Timmy learned.
import words from './words/setup.json';
import { feature, film } from './common';
import { closest, css, rail, text, within, type Film, type Move } from '../script';

export default function setup(): Film {
  const f = feature('setup', words);
  const { w } = f;
  const mail = w('Connect your mail');
  const calendar = w('calendar', mail);
  const drive = w('Drive', mail);
  const crm = w('CRM', mail);
  const each = w('each card');
  const writes = w('what it writes');
  const teach = w('Then teach');
  const like = w('like anything');
  const edit = w('When you edit');

  const card = (re: RegExp) => closest(text('.conn-name strong', re), '.conn-card');
  const gmail = card(/^Gmail$/);
  const ruleInput = css('.main input[placeholder^="Add a rule"]');
  const addRule = text('.main button', /^Add rule$/);
  const corrections = closest(text('.rp-title, h3, h4', /Recent corrections/), 'section, .rp-section');
  const edge: Move['to'] = { edge: [1990, 700] };

  return film(f, {
    start: { view: 'connections' },
    cuts: [],
    cards: [],
    cams: [
      { t: 0, d: 0.01, target: 'full' },
      { t: mail + 1.0, d: 0.7, target: css('.conn-grid'), zoom: 1.35, dy: 40 },
      { t: crm - 0.2, d: 0.6, target: card(/^HubSpot$/), zoom: 1.4, dx: 300, dy: -20 },
      { t: each - 0.1, d: 0.6, target: within(gmail, '.conn-dl'), zoom: 2.0 },
      { t: teach - 0.6, d: 0.4, target: 'full' },
      { t: teach + 0.4, d: 0.6, target: ruleInput, zoom: 1.5, dy: -120 },
      { t: edit - 0.2, d: 0.6, target: corrections, zoom: 1.7, dx: -60 },
    ],
    dims: [
      { t0: each + 0.6, t1: teach - 0.65, target: within(gmail, '.conn-dl') },
      { t0: edit + 0.5, t1: f.recap - 0.2, target: corrections },
    ],
    scrolls: [{ t: crm - 0.4, d: 0.5, target: card(/^HubSpot$/), offset: 120 }],
    moves: [
      { t: mail + 0.6, d: 0.6, to: gmail, ox: 40, bow: 60 },
      { t: calendar - 0.1, d: 0.45, to: card(/^Google Calendar$/), ox: 40 },
      { t: drive - 0.1, d: 0.45, to: card(/^Google Drive$/), ox: 40 },
      { t: crm + 0.3, d: 0.5, to: card(/^HubSpot$/), ox: 40 },
      { t: each + 0.2, d: 0.5, to: within(gmail, '.conn-dl'), ox: 80 },
      { t: writes - 0.1, d: 0.4, to: within(gmail, '.conn-dl'), ox: 80, oy: 30 },
      { t: teach - 0.6, d: 0.45, to: rail('Rules & settings'), ox: 4, oy: 4, bow: 60 },
      { t: teach + 0.3, d: 0.45, to: ruleInput, ox: -120, bow: 40 },
      { t: like + 2.6, d: 0.4, to: addRule, bow: 30 },
      { t: edit, d: 0.6, to: corrections, ox: -40, oy: 40 },
      { t: f.recap - 0.5, d: 0.5, to: edge },
    ],
    presses: [
      { t: teach - 0.1, target: rail('Rules & settings') },
      { t: teach + 0.8, target: ruleInput },
      { t: like + 3.05, target: addRule },
    ],
    typing: [{ t: teach + 0.95, text: 'Anything from Acme legal goes to Follow Up', cps: 22 }],
    keys: [],
  });
}
