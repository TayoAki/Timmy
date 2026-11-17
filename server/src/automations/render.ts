/**
 * Filling {{fields}} in a step's text.
 *
 * The values come from the trigger: for a new email they are the sender's name, the subject and the first
 * lines of the message, all written by someone outside. So the renderer does one thing only: it puts each
 * value where its {{name}} stands, as plain text. There is no code in a template, no filters, and a value
 * is never read as a template itself (one pass, so a subject that says "{{email}}" stays those characters).
 *
 * A rendered text only ever becomes words on a screen: a task's title, a line in a doc, a note. It is never
 * used as an address, so nothing a sender writes can decide who an email goes to.
 */
import { redact } from '../lib/log';

export type Fields = Record<string, string>;

/** The longest a single value may be once it is put into a text. */
const MAX_VALUE = 500;
/** The longest a rendered text may be. */
const MAX_TEXT = 2000;
/** Characters that are not words: the ASCII control characters. Line breaks of every kind count as spaces below. */
const CONTROL = /[\x00-\x1f\x7f]+/g;

/** A value as plain words on one line: no control characters, no line breaks, not too long. */
export function plain(value: unknown, max = MAX_VALUE): string {
  return String(value ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** A text as a sentence: it ends with a full stop unless it already ends with one, or with ? ! or …. */
export const sentence = (text: string): string => (/[.!?…]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/** Puts each {{field}} value in place. A field the trigger doesn't have becomes nothing. */
export function render(template: string | undefined, fields: Fields): string {
  return (template ?? '').replace(/\{\{(\w+)\}\}/g, (_whole, key: string) => (Object.hasOwn(fields, key) ? plain(fields[key]) : '')).slice(0, MAX_TEXT);
}

/**
 * What a run keeps. Anything shaped like a key or token is masked first, in every text at every depth:
 * an email can quote one, and a run's stored context is shown on the Runs panel and kept in the database.
 */
export function safe<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => safe(v)) as T;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safe(v)])) as T;
}
