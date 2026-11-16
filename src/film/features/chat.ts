// 12. Website chat: the snippet, colour, greeting and questions, a visitor's pricing question in the live preview, then the chats and Take over.
import words from './words/chat.json';
import { feature, film } from './common';
import { closest, css, nth, text, type Film, type Move } from '../script';

export default function chat(): Film {
  const f = feature('chat', words);
  const { w } = f;
  const paste = w('Paste one');
  const colour = w('pick a colour');
  const greeting = w('a greeting');
  const questions = w('the questions Timmy');
  const visitor = w('A visitor');
  const answers = w('Timmy answers from');
  const email = w('asks for their');
  const every = w('Every chat');
  const take = w('take over');

  const seg = (re: RegExp) => text('.wc-head button, .wc-head [role="radio"]', re);
  const preview = css('.wc-preview-col');
  const input = css('.wc-preview-col input, .wc-preview-col textarea');
  const priya = closest(text('.main *', /^Priya Nair$/), 'button, li, [role="button"]');
  const takeOver = css('[aria-label="Take over this chat"]');
  const edge: Move['to'] = { edge: [1990, 700] };
  const edgeR: Move['to'] = { edge: [1990, 900] };

  return film(f, {
    start: { view: 'outbound', tab: 'chat' },
    cuts: [],
    cards: [],
    cams: [
      { t: 0, d: 0.01, target: 'full' },
      { t: paste + 0.9, d: 0.6, target: css('.wc-code'), zoom: 1.7, dx: 140 },
      { t: colour - 0.1, d: 0.6, target: css('.wc-look'), zoom: 1.35, dx: 300, dy: -40 },
      { t: questions - 0.2, d: 0.6, target: css('.wc-qs'), zoom: 1.5, dx: 200 },
      { t: visitor - 0.2, d: 0.6, target: preview, zoom: 1.4 },
      { t: every - 0.75, d: 0.4, target: 'full' },
      { t: every + 0.9, d: 0.6, target: css('.main'), zoom: 1.3, dx: 120, dy: -60 },
      { t: take - 0.1, d: 0.5, target: takeOver, zoom: 1.6, dx: -260, dy: 120 },
    ],
    dims: [{ t0: take + 0.6, t1: f.recap - 0.2, target: takeOver, pad: 14 }],
    scrolls: [
      { t: colour - 0.2, d: 0.45, target: css('.wc-look'), offset: 60 },
      { t: questions - 0.3, d: 0.45, target: css('.wc-qs'), offset: 120 },
      { t: every - 0.75, d: 0.4, target: seg(/^Chats/), offset: 30 },
    ],
    moves: [
      { t: 1.4, d: 0.4, to: edgeR },
      { t: paste + 0.9, d: 0.6, to: css('.wc-code'), ox: 120, bow: 60 },
      { t: colour + 0.1, d: 0.45, to: nth('.wc-color', 2), bow: 40 },
      { t: greeting - 0.1, d: 0.45, to: css('.wc-look textarea'), ox: 60 },
      { t: questions, d: 0.45, to: css('.wc-qs'), ox: 120 },
      { t: visitor - 0.1, d: 0.5, to: input, bow: 50 },
      { t: email + 1.5, d: 0.5, to: preview, ox: 200, oy: -160 },
      { t: every - 0.3, d: 0.4, to: seg(/^Chats/), bow: 50 },
      { t: every + 0.9, d: 0.5, to: priya, ox: 40 },
      { t: take - 0.3, d: 0.4, to: takeOver, bow: 40 },
      { t: f.recap - 0.5, d: 0.5, to: edge },
    ],
    presses: [
      // Under the Tell card: open the set-up view (not a depicted click).
      { t: 1.0, target: seg(/^Set up$/) },
      { t: colour + 0.6, target: nth('.wc-color', 2) },
      { t: visitor + 0.4, target: input },
      { t: every + 0.1, target: seg(/^Chats/) },
      { t: every + 1.4, target: priya },
      { t: take + 0.2, target: takeOver },
    ],
    typing: [
      { t: visitor + 0.5, text: 'How much does it cost?', cps: 20 },
      { t: email + 0.15, text: 'sam@lumenlabs.io', cps: 20 },
    ],
    keys: [
      { t: answers - 0.2, key: 'Enter' },
      { t: email + 1.1, key: 'Enter' },
    ],
  });
}
