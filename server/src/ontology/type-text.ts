/**
 * How the names and values a model read out of other people's mail are spelled, limited and compared.
 * Plain functions with no database behind them. They are the reason a kind's name, a field's name or a value
 * can be shown on a screen and handed back to a model without being trusted: each is one short line of plain
 * text, or it is nothing.
 */
import { standsAlone, words } from './ontology';

/** The most characters a kind's name, a field's name, a value and a stored sentence may have. */
export const MAX_NAME = 40;
export const MAX_LABEL = 30;
export const MAX_VALUE = 120;
export const MAX_QUOTE = 300;

/** Things Timmy already keeps in their own place, and words too vague to be a kind. Never offered as a kind to track. */
export const NOT_A_KIND = new Set(['person', 'people', 'contact', 'company', 'organization', 'organisation', 'meeting', 'event', 'call', 'document', 'file', 'attachment', 'email', 'message', 'thread', 'commitment', 'promise', 'task', 'thing', 'item', 'other']);

const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

/** One line of plain text, or '' when the value is not text, is empty, is longer than allowed, or carries markup brackets. */
export function plain(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const t = v.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  return t.length > 0 && t.length <= max && !/[<>]/.test(t) ? t : '';
}

/**
 * A name for a kind or a field: up to four plain words (letters, digits, hyphens), or '' when it is anything else.
 * Kind and field names end up in front of a model again, so a sentence is never accepted as a name.
 */
export function nameOf(v: unknown, max: number): string {
  const t = plain(v, max);
  return /^\p{L}[\p{L}\p{N}'’-]*( [\p{L}\p{N}'’-]+){0,3}$/u.test(t) ? t : '';
}

const singular = (w: string) => (w.length < 4 ? w : w.endsWith('ies') ? `${w.slice(0, -3)}y` : /(sses|xes|ches|shes)$/.test(w) ? w.slice(0, -2) : w.endsWith('s') && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w);

/** One spelling for a kind however it was written: "Properties", "property" and " Property" are the same kind. */
export function kindKey(name: string): string {
  const parts = name.toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  if (!parts.length) return '';
  return [...parts.slice(0, -1), singular(parts[parts.length - 1]!)].join(' ');
}

/** "Close date" → "close_date". */
export const fieldKey = (label: string) => label.toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');

/** True when the value is really somewhere in the text, whole (not part of a longer word or number), give or take capitals, spacing and curly quotes. */
export const appears = (text: string, value: string) => standsAlone(text, value);

/** What makes two sightings the same thing: the naming value without capitals, spacing or punctuation. "Acme, Inc." is "acme inc". */
export const sameAs = (value: string) => words(value).replace(/[.,;:!?'"()]+/g, '').replace(/\s+/g, ' ').trim();

export const capital = (t: string) => (t ? t[0]!.toUpperCase() + t.slice(1) : t);
