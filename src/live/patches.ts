/**
 * State sync between the browser and the API. Both sides run this file.
 *
 * The reducer's state is split into slices. A patch names a slice and one entity
 * in it, so two changes to different entities never conflict, and applying the
 * same patch twice gives the same result.
 */

export type SliceKind =
  /** An ordered list of items with an `id` (threads, activity). */
  | 'array'
  /** A map from id to item (deals, tasks, leads). */
  | 'record'
  /** One value (the schedule, a switch). */
  | 'value';

export interface SliceSpec {
  name: string;
  path: string[];
  kind: SliceKind;
}

const slice = (name: string, kind: SliceKind): SliceSpec => ({ name, path: name.split('.'), kind });

export const WS_COLLECTIONS = ['folders', 'files', 'docs', 'sheets', 'decks', 'tasks', 'notes', 'events', 'contacts', 'interactions', 'projects', 'prompts', 'routines', 'learned', 'trash', 'automations', 'chat', 'chats', 'invoices', 'billing', 'bids', 'bidding'] as const;

/** Every part of the state the server owns. Anything not listed stays in the browser (the open screen, notices, search). */
export const SLICES: SliceSpec[] = [
  slice('threads', 'array'),
  slice('deals', 'record'),
  slice('activity', 'array'),
  slice('rules', 'array'),
  slice('decisions', 'array'),
  slice('approvalLog', 'array'),
  slice('pending', 'array'),
  slice('highlight', 'value'),
  slice('highlightDone', 'value'),
  slice('dismissed', 'value'),
  slice('schedule', 'value'),
  slice('run', 'value'),
  slice('calm', 'value'),
  slice('showDeals', 'value'),
  slice('clients', 'value'),
  ...WS_COLLECTIONS.map((c) => slice(`ws.${c}`, 'record')),
  slice('out.leads', 'record'),
  slice('out.lists', 'record'),
  slice('out.offer', 'value'),
  slice('out.templates', 'record'),
  slice('out.campaigns', 'record'),
  slice('out.mailboxes', 'record'),
  slice('out.channels', 'record'),
  slice('out.limits', 'value'),
  slice('out.messages', 'array'),
  slice('out.forms', 'record'),
  slice('out.posts', 'record'),
  slice('conn.apps', 'record'),
  slice('conn.crm', 'value'),
  slice('conn.delegate', 'value'),
  slice('conn.enrich', 'value'),
  slice('conn.held', 'array'),
];

export const SLICE_BY_NAME: Record<string, SliceSpec> = Object.fromEntries(SLICES.map((s) => [s.name, s]));

export type Patch =
  /** Add or replace one item. `at` places a new item in an array slice. */
  | { s: string; id: string; v: unknown; at?: 'start' | { after: string } }
  | { s: string; id: string; rm: true }
  /** Replace a value slice. */
  | { s: string; v: unknown }
  /** A new order for an array slice. */
  | { s: string; order: string[] };

type Bag = Record<string, unknown>;
type Item = { id: string };

const read = (state: unknown, path: string[]): unknown => path.reduce<unknown>((o, k) => (o == null ? undefined : (o as Bag)[k]), state);

/** Returns a copy of `state` with `value` at `path`, copying only the objects on the way down. */
export function writeAt<S>(state: S, path: string[], value: unknown): S {
  if (path.length === 0) return value as S;
  const [head, ...rest] = path as [string, ...string[]];
  const base = (state ?? {}) as Bag;
  return { ...base, [head]: writeAt(base[head], rest, value) } as S;
}

/* ───────────── Wire format ───────────── */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Dates travel tagged, as {"$date": "2026-11-17T09:00:00.000Z"}, and only a tag comes back as a Date. Text never
 * does, whatever it looks like: an email whose subject is exactly a timestamp stays a subject. (Until Nov 17, 2026
 * every string shaped like a timestamp came back as a Date, so outside text could put a Date where the screens
 * expect words, and blank them.)
 */
const TAG = '$date';
const HAS_TAG = /\{\s*"\$date"\s*:/;

/**
 * Data written before dates were tagged still has them as plain strings. Such data has no tag anywhere in it,
 * and in it, and only in it, a timestamp is read as a date under the names below, which have only ever held dates.
 */
const DATE_FIELDS = new Set(['added', 'at', 'callbackAt', 'created', 'createdAt', 'date', 'day', 'due', 'end', 'finish', 'finishedAt', 'firstReplyAt', 'last', 'lastSeen', 'launched', 'next', 'nextAt', 'receivedAt', 'sendsAt', 'since', 'start', 'trashed', 'until', 'updated', 'wakeAt']);

export const toWire = (value: unknown): string =>
  JSON.stringify(value, function (this: Record<string, unknown>, key, v: unknown) {
    // A Date has already been turned into its string by the time it gets here; the holder still has the Date.
    const raw = this[key];
    if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : { [TAG]: raw.toISOString() };
    return v;
  });

export const fromWire = <T = unknown>(text: string): T => {
  const legacy = !HAS_TAG.test(text);
  return JSON.parse(text, (k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length === 1 && keys[0] === TAG && typeof o[TAG] === 'string' && ISO_DATE.test(o[TAG] as string)) return new Date(o[TAG] as string);
      return v;
    }
    if (legacy && typeof v === 'string' && DATE_FIELDS.has(k) && ISO_DATE.test(v)) return new Date(v);
    return v;
  }) as T;
};
export const viaWire = <T>(value: T): T => fromWire<T>(toWire(value));

/**
 * JSON drops a field whose value is undefined, so a patch that clears a field (`{ cover: undefined }`) would
 * reach the server empty and change nothing. On the way out such a field is sent as null, as JSON merge patch
 * does; the server reads a null in a patch as “clear this field”.
 */
export function clearsAsNull<A extends { type: string }>(action: A): A {
  const a = action as unknown as { type: string; ops?: { op: string; patch?: Record<string, unknown> }[] };
  if (a.type !== 'ws' || !Array.isArray(a.ops) || !a.ops.some((o) => o.op === 'patch' && o.patch && Object.values(o.patch).includes(undefined))) return action;
  const ops = a.ops.map((o) => (o.op === 'patch' && o.patch ? { ...o, patch: Object.fromEntries(Object.entries(o.patch).map(([k, v]) => [k, v === undefined ? null : v])) } : o));
  return { ...action, ops } as A;
}

const same = (a: unknown, b: unknown) => a === b || toWire(a) === toWire(b);

/* ───────────── Diff ───────────── */

/** The patches that turn `prev` into `next`. Slices whose reference didn't change are skipped. */
export function diffState(prev: unknown, next: unknown): Patch[] {
  const out: Patch[] = [];
  for (const sl of SLICES) {
    const a = read(prev, sl.path);
    const b = read(next, sl.path);
    if (a === b) continue;
    const s = sl.name;
    if (sl.kind === 'value') {
      if (!same(a, b)) out.push({ s, v: b });
      continue;
    }
    if (sl.kind === 'record') {
      const A = (a ?? {}) as Record<string, unknown>;
      const B = (b ?? {}) as Record<string, unknown>;
      for (const id of Object.keys(A)) if (!(id in B)) out.push({ s, id, rm: true });
      for (const id of Object.keys(B)) if (!(id in A) || !same(A[id], B[id])) out.push({ s, id, v: B[id] });
      continue;
    }
    const A = (a ?? []) as Item[];
    const B = (b ?? []) as Item[];
    const before = new Map(A.map((x) => [x.id, x]));
    const after = new Set(B.map((x) => x.id));
    for (const x of A) if (!after.has(x.id)) out.push({ s, id: x.id, rm: true });
    B.forEach((x, i) => {
      const old = before.get(x.id);
      if (!old) out.push({ s, id: x.id, v: x, at: i === 0 ? 'start' : { after: B[i - 1]!.id } });
      else if (!same(old, x)) out.push({ s, id: x.id, v: x });
    });
    const kept = A.filter((x) => after.has(x.id)).map((x) => x.id);
    const keptNow = B.filter((x) => before.has(x.id)).map((x) => x.id);
    if (kept.some((id, i) => id !== keptNow[i])) out.push({ s, order: B.map((x) => x.id) });
  }
  return out;
}

/* ───────────── Apply ───────────── */

export function applyPatches<S>(state: S, patches: Patch[]): S {
  let next = state;
  for (const p of patches) {
    const sl = SLICE_BY_NAME[p.s];
    if (!sl) continue;
    if (sl.kind === 'value') {
      if ('v' in p && !('id' in p)) next = writeAt(next, sl.path, p.v);
      continue;
    }
    if (sl.kind === 'record') {
      if (!('id' in p)) continue;
      const rec = { ...((read(next, sl.path) ?? {}) as Record<string, unknown>) };
      if ('rm' in p) delete rec[p.id];
      else rec[p.id] = p.v;
      next = writeAt(next, sl.path, rec);
      continue;
    }
    const list = [...((read(next, sl.path) ?? []) as Item[])];
    if ('order' in p) {
      const byId = new Map(list.map((x) => [x.id, x]));
      const ordered = p.order.map((id) => byId.get(id)).filter((x): x is Item => !!x);
      const named = new Set(p.order);
      next = writeAt(next, sl.path, [...ordered, ...list.filter((x) => !named.has(x.id))]);
      continue;
    }
    if (!('id' in p)) continue;
    const at = list.findIndex((x) => x.id === p.id);
    if ('rm' in p) {
      if (at >= 0) list.splice(at, 1);
    } else if (at >= 0) {
      list[at] = p.v as Item;
    } else if (p.at === 'start' || p.at === undefined) {
      list.unshift(p.v as Item);
    } else {
      const after = list.findIndex((x) => x.id === (p.at as { after: string }).after);
      if (after >= 0) list.splice(after + 1, 0, p.v as Item);
      else list.push(p.v as Item);
    }
    next = writeAt(next, sl.path, list);
  }
  return next;
}

/** The server-owned part of a state, slice by slice. Used for snapshots. */
export function pickSlices(state: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sl of SLICES) out[sl.name] = read(state, sl.path);
  return out;
}

/** Lays a snapshot's slices over a base state. */
export function withSlices<S>(base: S, slices: Record<string, unknown>): S {
  let next = base;
  for (const sl of SLICES) if (slices[sl.name] !== undefined) next = writeAt(next, sl.path, slices[sl.name]);
  return next;
}
