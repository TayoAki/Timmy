import type { State } from '../../../src/state/store';
import { blankState } from '../../../src/live/blank';
import { SLICES, SLICE_BY_NAME, applyPatches, diffState, fromWire, toWire, writeAt, type Patch } from '../../../src/live/patches';
import type { Tx } from '../db/pool';
import { keepPageVersions } from '../pages/versions';

export interface WorkspaceRow {
  id: string;
  name: string;
  trade: string;
  timezone: string;
  owner_name: string | null;
  owner_email: string | null;
  model_id: string | null;
  approval_mode: 'ask' | 'auto';
  max_concurrent_runs: number;
  monthly_spend_cap_usd: number;
  kill_switch: boolean;
  state_rev: number;
}

export interface Loaded {
  workspace: WorkspaceRow;
  rev: number;
  state: State;
  /** Position of each item in the array slices. */
  ords: Map<string, Map<string, number>>;
}

export interface PreImage {
  s: string;
  id: string;
  /** The document before the change, in wire form; null when it didn't exist. */
  before: string | null;
  ord: number;
}

export interface Commit {
  rev: number;
  patches: Patch[];
  pre: PreImage[];
  next: Loaded;
}

/** Log-like slices grow without bound; the working copy holds the newest of each. */
const WINDOW: Record<string, number> = { activity: 400, approvalLog: 400 };

const cache = new Map<string, Loaded>();
const CACHE_MAX = 200;

/** Call after the transaction that produced `loaded` has committed. */
export function remember(loaded: Loaded) {
  cache.delete(loaded.workspace.id);
  cache.set(loaded.workspace.id, loaded);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
}
export function forget(workspaceId?: string) {
  if (workspaceId) cache.delete(workspaceId);
  else cache.clear();
}

/** Postgres refuses the NUL character inside jsonb strings; mail bodies sometimes carry one. */
const clean = (wire: string) => wire.replace(/\\u0000/g, '');

const firstName = (name: string | null) => (name ?? '').trim().split(/\s+/)[0] || 'me';

export function blankFor(ws: WorkspaceRow): State {
  return blankState({ first: firstName(ws.owner_name), company: ws.name });
}

async function writeDocs(tx: Tx, workspaceId: string, rev: number, docs: { s: string; id: string; wire: string; ord: number }[]) {
  if (!docs.length) return;
  await tx.query(
    `insert into state_doc (workspace_id, slice, id, data, ord, rev)
     select $1, t.s, t.i, t.d::jsonb, t.o, $2 from unnest($3::text[], $4::text[], $5::text[], $6::float8[]) as t(s, i, d, o)
     on conflict (workspace_id, slice, id) do update set data = excluded.data, ord = excluded.ord, rev = excluded.rev, updated_at = now()`,
    [workspaceId, rev, docs.map((d) => d.s), docs.map((d) => d.id), docs.map((d) => clean(d.wire)), docs.map((d) => d.ord)],
  );
}

/** Turns a whole state into rows, for a workspace's first save. */
function rowsOf(state: State) {
  const rows: { s: string; id: string; wire: string; ord: number }[] = [];
  const ords = new Map<string, Map<string, number>>();
  for (const sl of SLICES) {
    const v = sl.path.reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], state);
    if (sl.kind === 'value') rows.push({ s: sl.name, id: '_', wire: toWire({ v: v ?? null }), ord: 0 });
    else if (sl.kind === 'record') for (const [id, item] of Object.entries((v ?? {}) as Record<string, unknown>)) rows.push({ s: sl.name, id, wire: toWire(item), ord: 0 });
    else {
      const m = new Map<string, number>();
      ((v ?? []) as { id: string }[]).forEach((item, i) => {
        rows.push({ s: sl.name, id: item.id, wire: toWire(item), ord: i });
        m.set(item.id, i);
      });
      ords.set(sl.name, m);
    }
  }
  return { rows, ords };
}

/**
 * The workspace's current state, in the reducer's shape. Reads from memory when
 * the stored revision matches, so most commands cost one small query.
 * Call inside `withWorkspace({ lock: true })` when the result will be changed.
 */
export async function loadState(tx: Tx, workspaceId: string): Promise<Loaded> {
  const { rows: wsRows } = await tx.query('select * from workspace where id = $1', [workspaceId]);
  const workspace = wsRows[0] as WorkspaceRow | undefined;
  if (!workspace) throw new Error('workspace not found');

  const hit = cache.get(workspaceId);
  if (hit && hit.rev === workspace.state_rev && workspace.state_rev > 0) return { ...hit, workspace };

  const blank = blankFor(workspace);
  if (workspace.state_rev === 0) {
    const { rows, ords } = rowsOf(blank);
    await writeDocs(tx, workspaceId, 1, rows);
    await tx.query('update workspace set state_rev = 1 where id = $1', [workspaceId]);
    return { workspace: { ...workspace, state_rev: 1 }, rev: 1, state: blank, ords };
  }

  const values = new Map<string, unknown>();
  const records = new Map<string, Record<string, unknown>>();
  const arrays = new Map<string, { id: string }[]>();
  const ords = new Map<string, Map<string, number>>();
  const windowed = Object.keys(WINDOW);
  const { rows } = await tx.query(
    `select slice, id, data::text as data, ord from state_doc where workspace_id = $1 and slice <> all($2::text[]) order by slice, ord`,
    [workspaceId, windowed],
  );
  for (const name of windowed) {
    const r = await tx.query(`select slice, id, data::text as data, ord from state_doc where workspace_id = $1 and slice = $2 order by ord limit $3`, [workspaceId, name, WINDOW[name]]);
    rows.push(...r.rows);
  }
  for (const r of rows) {
    const sl = SLICE_BY_NAME[r.slice as string];
    if (!sl) continue;
    const data = fromWire(r.data as string);
    if (sl.kind === 'value') values.set(sl.name, (data as { v: unknown }).v);
    else if (sl.kind === 'record') {
      if (!records.has(sl.name)) records.set(sl.name, {});
      records.get(sl.name)![r.id as string] = data;
    } else {
      if (!arrays.has(sl.name)) arrays.set(sl.name, []);
      arrays.get(sl.name)!.push(data as { id: string });
      if (!ords.has(sl.name)) ords.set(sl.name, new Map());
      ords.get(sl.name)!.set(r.id as string, r.ord as number);
    }
  }
  const patches: Patch[] = [];
  let state = blank;
  for (const sl of SLICES) {
    if (sl.kind === 'value') {
      if (values.has(sl.name)) patches.push({ s: sl.name, v: values.get(sl.name) });
    } else if (sl.kind === 'record') {
      // Replace the whole record: the blank's defaults only stand in for slices that were never saved.
      state = writeAt(state, sl.path, records.get(sl.name) ?? {});
    } else {
      state = writeAt(state, sl.path, arrays.get(sl.name) ?? []);
      if (!ords.has(sl.name)) ords.set(sl.name, new Map());
    }
  }
  state = applyPatches(state, patches);
  const loaded = { workspace, rev: workspace.state_rev, state, ords };
  remember(loaded);
  return loaded;
}

/**
 * Saves the difference between the loaded state and `next`, and records it as
 * one revision. Returns null when nothing the server owns changed.
 * The caller commits the transaction, then calls `remember(commit.next)`.
 */
export async function commitState(tx: Tx, cur: Loaded, next: State, origin = 'command'): Promise<Commit | null> {
  const raw = diffState(cur.state, next);
  if (!raw.length) return null;
  // Round-trip through the wire format, so what is cached equals what clients receive.
  const patches = fromWire<Patch[]>(clean(toWire(raw)));
  const workspaceId = cur.workspace.id;
  const rev = cur.rev + 1;
  const ords = new Map([...cur.ords].map(([k, v]) => [k, new Map(v)]));
  const pre: PreImage[] = [];
  const upserts: { s: string; id: string; wire: string; ord: number }[] = [];
  const removes: { s: string; id: string }[] = [];
  const state = applyPatches(cur.state, patches);

  const before = (sl: (typeof SLICES)[number], id: string): unknown => {
    const v = sl.path.reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], cur.state);
    if (sl.kind === 'record') return (v as Record<string, unknown> | undefined)?.[id];
    if (sl.kind === 'array') return (v as { id: string }[] | undefined)?.find((x) => x.id === id);
    return v;
  };

  for (const p of patches) {
    const sl = SLICE_BY_NAME[p.s]!;
    if (sl.kind === 'value') {
      if ('order' in p || 'id' in p) continue;
      pre.push({ s: p.s, id: '_', before: toWire({ v: before(sl, '_') ?? null }), ord: 0 });
      upserts.push({ s: p.s, id: '_', wire: toWire({ v: p.v ?? null }), ord: 0 });
      continue;
    }
    if ('order' in p) continue;
    if (!('id' in p)) continue;
    const old = before(sl, p.id);
    const m = sl.kind === 'array' ? ords.get(p.s) ?? ords.set(p.s, new Map()).get(p.s)! : null;
    pre.push({ s: p.s, id: p.id, before: old === undefined ? null : toWire(old), ord: m?.get(p.id) ?? 0 });
    if ('rm' in p) {
      removes.push({ s: p.s, id: p.id });
      m?.delete(p.id);
    } else {
      upserts.push({ s: p.s, id: p.id, wire: toWire(p.v), ord: m?.get(p.id) ?? Number.NaN });
    }
  }

  // Give new array items a position between their neighbours.
  for (const sl of SLICES) {
    if (sl.kind !== 'array') continue;
    const fresh = upserts.filter((u) => u.s === sl.name && Number.isNaN(u.ord));
    const reorder = patches.some((p) => p.s === sl.name && 'order' in p);
    if (!fresh.length && !reorder) continue;
    const list = sl.path.reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], state) as { id: string }[];
    const m = ords.get(sl.name) ?? ords.set(sl.name, new Map()).get(sl.name)!;
    if (reorder) {
      const moved: { s: string; id: string; ord: number }[] = [];
      list.forEach((x, i) => {
        if (m.get(x.id) !== i) moved.push({ s: sl.name, id: x.id, ord: i });
        m.set(x.id, i);
      });
      for (const u of upserts) if (u.s === sl.name) u.ord = m.get(u.id)!;
      const untouched = moved.filter((x) => !upserts.some((u) => u.s === x.s && u.id === x.id));
      if (untouched.length) {
        await tx.query(
          `update state_doc d set ord = t.o, rev = $2 from unnest($3::text[], $4::float8[]) as t(i, o) where d.workspace_id = $1 and d.slice = $5 and d.id = t.i`,
          [workspaceId, rev, untouched.map((x) => x.id), untouched.map((x) => x.ord), sl.name],
        );
      }
      continue;
    }
    const isNew = new Set(fresh.map((u) => u.id));
    for (let i = 0; i < list.length; i++) {
      const id = list[i]!.id;
      if (!isNew.has(id) || m.has(id)) continue;
      const prevOrd = i > 0 ? m.get(list[i - 1]!.id) : undefined;
      let nextOrd: number | undefined;
      for (let j = i + 1; j < list.length && nextOrd === undefined; j++) nextOrd = m.get(list[j]!.id);
      const ord = prevOrd === undefined ? (nextOrd === undefined ? 0 : nextOrd - 1) : nextOrd === undefined ? prevOrd + 1 : (prevOrd + nextOrd) / 2;
      m.set(id, ord);
      fresh.find((u) => u.id === id)!.ord = ord;
    }
    for (const u of fresh) if (Number.isNaN(u.ord)) u.ord = 0;
  }

  await writeDocs(tx, workspaceId, rev, upserts);
  if (removes.length) {
    await tx.query(`delete from state_doc d using unnest($2::text[], $3::text[]) as t(s, i) where d.workspace_id = $1 and d.slice = t.s and d.id = t.i`, [workspaceId, removes.map((r) => r.s), removes.map((r) => r.id)]);
  }
  // A page whose contents this save replaces has its earlier contents kept as a version (see pages/versions.ts).
  await keepPageVersions(tx, workspaceId, cur.state, patches, origin);
  await tx.query('insert into state_change (workspace_id, rev, patches, origin) values ($1, $2, $3::jsonb, $4)', [workspaceId, rev, clean(toWire(patches)), origin]);
  await tx.query('update workspace set state_rev = $2 where id = $1', [workspaceId, rev]);
  await tx.query('select pg_notify($1, $2)', ['timmy_state', `${workspaceId}:${rev}`]);

  return { rev, patches, pre, next: { workspace: { ...cur.workspace, state_rev: rev }, rev, state, ords } };
}

/** Patches made after `since`, oldest first, or null when too old to replay (the client reloads). */
export async function changesSince(tx: Tx, workspaceId: string, since: number): Promise<{ rev: number; patches: Patch[]; command?: string }[] | null> {
  const { rows } = await tx.query('select rev, patches::text as patches, origin from state_change where workspace_id = $1 and rev > $2 order by rev limit 500', [workspaceId, since]);
  if (rows.length && (rows[0].rev as number) !== since + 1) return null;
  // A change made by a command says which one, so the tab that sent it knows its own change when it comes back on the stream.
  return rows.map((r) => ({ rev: r.rev as number, patches: fromWire<Patch[]>(r.patches as string), ...(String(r.origin ?? '').startsWith('cmd:') ? { command: String(r.origin).slice(4) } : {}) }));
}
