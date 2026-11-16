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

export const WS_COLLECTIONS = ['folders', 'files', 'docs', 'sheets', 'decks', 'tasks', 'notes', 'events', 'contacts', 'interactions', 'projects', 'prompts', 'routines', 'learned'] as const;

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
function write<S>(state: S, path: string[], value: unknown): S {
  if (path.length === 0) return value as S;
  const [head, ...rest] = path as [string, ...string[]];
  const base = (state ?? {}) as Bag;
  return { ...base, [head]: write(base[head], rest, value) } as S;
}

/* ───────────── Wire format ───────────── */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Dates travel as ISO strings and come back as Dates, the same way the browser's saved state does. */
export const toWire = (value: unknown): string => JSON.stringify(value);
export const fromWire = <T = unknown>(text: string): T => JSON.parse(text, (_k, v) => (typeof v === 'string' && ISO_DATE.test(v) ? new Date(v) : v)) as T;
export const viaWire = <T>(value: T): T => fromWire<T>(toWire(value));

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
      if ('v' in p && !('id' in p)) next = write(next, sl.path, p.v);
      continue;
    }
    if (sl.kind === 'record') {
      if (!('id' in p)) continue;
      const rec = { ...((read(next, sl.path) ?? {}) as Record<string, unknown>) };
      if ('rm' in p) delete rec[p.id];
      else rec[p.id] = p.v;
      next = write(next, sl.path, rec);
      continue;
    }
    const list = [...((read(next, sl.path) ?? []) as Item[])];
    if ('order' in p) {
      const byId = new Map(list.map((x) => [x.id, x]));
      const ordered = p.order.map((id) => byId.get(id)).filter((x): x is Item => !!x);
      const named = new Set(p.order);
      next = write(next, sl.path, [...ordered, ...list.filter((x) => !named.has(x.id))]);
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
    next = write(next, sl.path, list);
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
  for (const sl of SLICES) if (slices[sl.name] !== undefined) next = write(next, sl.path, slices[sl.name]);
  return next;
}
