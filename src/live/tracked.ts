/**
 * What Timmy tracks beyond people and companies: the kinds of thing a workspace's trade is about (deals,
 * properties, candidates…). The browser and the server share these shapes.
 *
 * Kind names, field names, values and sentences here were read out of other people's mail by a model.
 * They are plain text to show, never markup and never instructions.
 */

export interface TrackedField {
  key: string;
  label: string;
}

/** The sentence a fact rests on, and the email it was read from. */
export interface TrackedSource {
  quote: string;
  subject: string;
  from: string;
  /** When the email was sent. */
  at: Date;
  /** The mailbox's own key for the thread, to open it from the list. */
  thread?: string;
}

/** A kind Timmy offers to track. Nothing is read out of the mail for it until someone accepts. */
export interface TrackedProposal {
  key: string;
  name: string;
  fields: TrackedField[];
  /** `trade`: it comes with the kind of work chosen at sign-up. `seen`: Timmy noticed it in several threads. */
  why: 'trade' | 'seen';
  /** How many threads it was noticed in. */
  threads: number;
  examples: { name: string; fields: [string, string][]; source: TrackedSource }[];
}

/** A kind someone accepted. Only these are read out of the mail and used. */
export interface TrackedKind {
  id: string;
  key: string;
  name: string;
  fields: TrackedField[];
  /** How many things of this kind Timmy knows. */
  known: number;
}

export interface TrackedThing {
  id: string;
  name: string;
  /** Field key to value. A field the mail never gave is simply absent. */
  fields: Record<string, string>;
  lastSeen: Date;
  sources: TrackedSource[];
}

export interface TrackedOverview {
  proposals: TrackedProposal[];
  tracked: TrackedKind[];
}

/** "property" → "properties", for sentences about a kind. Plain English rules; an odd plural reads slightly off, nothing more. */
export function plural(name: string): string {
  const w = name.trim();
  if (/[^aeiou]y$/i.test(w)) return `${w.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(w)) return `${w}es`;
  return `${w}s`;
}

/** "address" → "an address", "price" → "a price". A plural such as "access notes" is left as it is. */
export const withArticle = (word: string) => (/[^su]s$/i.test(word) ? word : `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`);

/** ["a", "b", "c"] → "a, b and c". */
export const listed = (words: string[]) => (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);
