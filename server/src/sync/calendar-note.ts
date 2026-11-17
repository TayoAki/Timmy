/**
 * An event's description on the calendar, as the note Timmy shows and writes.
 *
 * Timmy keeps plain text of a limited length. A description that is longer, or that carries formatting, can't be
 * written back from that copy without losing part of it, so each note says whether it is the whole description.
 */

/** The longest description Timmy keeps and writes as an event's note. */
export const NOTE_MAX = 2000;

/** The note for a description already turned into text. `whole` is false when the provider held more than this text. */
export function noteOf(text: string | null | undefined, whole: boolean): { note?: string; noteWhole: boolean } {
  const clean = String(text ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
  if (!clean) return { noteWhole: whole };
  return clean.length > NOTE_MAX ? { note: clean.slice(0, NOTE_MAX), noteWhole: false } : { note: clean, noteWhole: whole };
}

/** Two notes that say the same thing: the same words, however the provider spaced the lines. */
export const sameNote = (a: string | undefined, b: string | undefined) => (a ?? '').replace(/\s+/g, ' ').trim() === (b ?? '').replace(/\s+/g, ' ').trim();
