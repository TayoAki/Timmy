/*
 * The feature films: one 30-second Demo2Win film per feature area, Tell, Show, Tell.
 *
 *   Tell   a dark card: the area, the problem, and what Timmy does about it (the poster frame);
 *   Show   the real app swings in, and the cursor does the work with real clicks, timed to the voice;
 *   Tell   the recap on a dark card, then the lockup: the mark, "Timmy" and "Try the demo".
 *
 * The scripts are in vo.json (and docs/feature-videos.md). Each film's word timings are in
 * words/<id>.json, from its narration, so a new take re-times the film by swapping that file.
 * Play one with ?film=<id>; render it with FILM=<id> node scripts/film/render.cjs.
 */
import vo from './vo.json';
import { timing, type Card, type Film, type Swing, type Word } from '../script';

/** Every feature film runs exactly this long. */
export const LENGTH = 30;

export interface Script {
  id: string;
  title: string;
  area: string;
  tell: string;
  show: string;
  recap: string;
}
export const SCRIPTS = vo as Script[];

const count = (s: string) => s.split(/\s+/).filter(Boolean).length;
const sentences = (s: string) => s.match(/[^.?!]+[.?!]+/g)?.map((x) => x.trim()) ?? [s];

/** The timing for one feature film: phrase lookups, section starts, and its Tell cards. */
export function feature(id: string, words: Word[]) {
  const sc = SCRIPTS.find((f) => f.id === id);
  if (!sc) throw new Error(`No feature film script "${id}"`);
  const T = timing(words, `${id} narration`);
  const nT = count(sc.tell);
  const nS = count(sc.show);
  /** When the narration starts each sentence of a section, from that section's first word. */
  const lines = (text: string, first: number) => {
    let i = first;
    return sentences(text).map((line) => {
      const at = words[i]!.s;
      i += count(line);
      return { at, line };
    });
  };
  const show = words[nT]!.s;
  const recap = words[nT + nS]!.s;
  const end = T.end;
  const swing: Swing = { t0: show - 0.05, t1: show + 1.55 };
  const tell = lines(sc.tell, 0);
  const open: Card = {
    t0: 0,
    t1: show + 0.15,
    theme: 'dark',
    lines: [
      { t: -0.3, text: sc.area, size: 'eye' },
      ...tell.map((l, i) => ({ t: i === 0 ? -0.3 : l.at, text: l.line, size: 'l' as const })),
    ],
  };
  // The recap, then the lockup on its own card (the two swap words without showing the app).
  const lockAt = end + 0.35;
  const close: Card[] = [
    { t0: recap - 0.15, t1: lockAt, theme: 'dark', lines: lines(sc.recap, nT + nS).map((l) => ({ t: l.at, text: l.line, size: 'xl' as const })) },
    {
      t0: lockAt,
      t1: LENGTH + 0.1,
      theme: 'dark',
      lines: [
        { t: lockAt + 0.05, text: 'Timmy', size: 'xl', mark: true },
        { t: lockAt + 0.45, text: 'Try the demo', size: 'lede' },
      ],
    },
  ];
  return { ...T, sc, show, recap, end, swing, open, close };
}

/** A feature film with its Tell cards and reveal around the Show the caller choreographs. */
export function film(f: ReturnType<typeof feature>, show: Omit<Film, 'length' | 'swing'> & Partial<Pick<Film, 'swing'>>): Film {
  return { ...show, length: LENGTH, swing: show.swing ?? f.swing, cards: [f.open, ...show.cards, ...f.close] };
}
