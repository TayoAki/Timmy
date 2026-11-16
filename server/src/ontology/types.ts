/**
 * The ontology's next step: things specific to the workspace's trade (deals, properties, candidates…).
 *
 * A workspace starts with its trade's kinds proposed, not active. Nothing is read out of the mail for a kind
 * until someone who may set the workspace's policy accepts it. From then on the one read every thread already
 * gets (`agent/read.ts`) also returns the things of accepted kinds it found, each with its fields and the
 * sentence it rests on. Nothing in this file calls a model.
 *
 * What the model returns is its reading of other people's mail, so none of it is taken on trust:
 *   - a thing is kept only when its sentence is really in a stored message of the thread, and that message
 *     becomes its evidence;
 *   - a field is kept only when its value appears in the thread;
 *   - names and values are short plain text. They are shown as text and handed to a model only as outside content.
 *
 * The same read may name a kind of thing the thread is about that the workspace does not track. Those are only
 * counted, one per kind and thread. A kind seen in three different threads is offered to the person, with examples.
 */
import type { TrackedField, TrackedKind, TrackedOverview, TrackedProposal, TrackedSource, TrackedThing } from '../../../src/live/tracked';
import type { Tx } from '../db/pool';
import { withWorkspace } from '../db/pool';
import { audit } from '../gateway/gateway';
import { newId } from '../lib/ids';
import { quoted, settleThings } from './ontology';
import { MAX_LABEL, MAX_NAME, MAX_QUOTE, MAX_VALUE, NOT_A_KIND, appears, capital, fieldKey, kindKey, nameOf, plain, sameAs } from './type-text';

/* ───────────── Limits ───────────── */

/** How many things, and how many untracked kinds, one thread's read may add. The read's prompt asks for the same. */
const THINGS_PER_THREAD = 3;
const KINDS_PER_THREAD = 2;
/** A kind is offered once it has been seen in this many different threads. */
const PROPOSE_AFTER = 3;
/** A kind Timmy noticed gets the field that names it and at most this many more. */
const SEEN_FIELDS = 3;

/* ───────────── The kinds each trade starts with ───────────── */

interface Starter {
  key: string;
  name: string;
  fields: TrackedField[];
}

const starter = (name: string, ...labels: string[]): Starter => ({ key: kindKey(name), name, fields: labels.map((label) => ({ key: fieldKey(label), label })) });

/** The first field of every kind is the one that names the thing: two sightings with the same value there are the same thing. */
export const TRADE_TYPES: Record<string, Starter[]> = {
  sales: [starter('Deal', 'company', 'value', 'stage', 'close date'), starter('Lead', 'name', 'company', 'source')],
  recruiting: [starter('Candidate', 'name', 'role', 'stage'), starter('Role', 'title', 'team', 'location')],
  'real-estate': [starter('Property', 'address', 'price', 'status'), starter('Showing', 'property', 'date', 'who')],
  'home-services': [starter('Job', 'customer', 'address', 'date', 'price'), starter('Site', 'address', 'access notes')],
  consulting: [starter('Client', 'name', 'contact', 'retainer'), starter('Invoice', 'client', 'amount', 'due date')],
  agency: [starter('Client', 'name', 'contact', 'retainer'), starter('Invoice', 'client', 'amount', 'due date')],
};

/* ───────────── The workspace's kinds ───────────── */

interface TypeRow {
  id: string;
  key: string;
  name: string;
  fields: TrackedField[];
  status: 'proposed' | 'certified' | 'dismissed';
  source: 'trade' | 'seen';
}

/**
 * Every kind the workspace has: proposed, accepted or dismissed. The first time it is asked for, the kinds of
 * the trade chosen at sign-up are added as proposals. Proposed means offered: nothing is read for them yet.
 */
async function typesOf(tx: Tx, workspaceId: string): Promise<TypeRow[]> {
  const load = async () => (await tx.query(`select id, key, name, fields, status, source from tracked_type where workspace_id = $1 order by created_at, name`, [workspaceId])).rows as TypeRow[];
  const rows = await load();
  if (rows.some((r) => r.source === 'trade')) return rows;
  const trade = (await tx.query('select trade from workspace where id = $1', [workspaceId])).rows[0]?.trade as string | undefined;
  // The trade is a word the sign-up form sent. One this list does not hold as its own entry has no kinds.
  const starters = trade && Object.hasOwn(TRADE_TYPES, trade) ? TRADE_TYPES[trade]! : [];
  if (!starters.length) return rows;
  for (const s of starters) {
    await tx.query(`insert into tracked_type (id, workspace_id, key, name, fields, status, source) values ($1, $2, $3, $4, $5::jsonb, 'proposed', 'trade') on conflict (workspace_id, key) do nothing`, [newId('typ'), workspaceId, s.key, s.name, JSON.stringify(s.fields)]);
  }
  return load();
}

const certified = (types: TypeRow[]) => types.filter((t) => t.status === 'certified');
/** The kind a name refers to, by its fixed spelling or by the name the workspace gave it. */
const kindNamed = (types: TypeRow[], name: string) => {
  const key = kindKey(name);
  return key ? types.find((t) => t.key === key || kindKey(t.name) === key) : undefined;
};

/** The kinds this workspace has accepted. Only these are read out of the mail. */
export async function certifiedTypes(workspaceId: string): Promise<{ name: string; fields: TrackedField[] }[]> {
  return withWorkspace({ workspaceId }, async (tx) => certified(await typesOf(tx, workspaceId)).map((t) => ({ name: t.name, fields: t.fields })));
}

/** How the reading step is told what the workspace tracks: one line per kind, with names and field names only. */
export const typesForPrompt = (types: { name: string; fields: TrackedField[] }[]) => types.map((t) => `- ${t.name}: ${t.fields.map((f) => f.label).join(', ')}`).join('\n');

/* ───────────── Keeping what a thread's read found ───────────── */

interface Message {
  id: string;
  occurred_at: Date;
  subject: string | null;
  text: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Stores one thing with the message that shows it, or adds that message to the thing if Timmy already knows it. */
async function keepThing(tx: Tx, workspaceId: string, type: TypeRow, fields: Record<string, string>, source: { itemId: string; at: Date; quote: string }): Promise<void> {
  const naming = fields[type.fields[0]!.key]!;
  const { rows } = await tx.query(
    `insert into entity (id, workspace_id, type, type_id, key, name, first_seen, last_seen) values ($1, $2, 'thing', $3, $4, $5, $6, $6)
     on conflict (workspace_id, type, key) do update set first_seen = least(entity.first_seen, excluded.first_seen), last_seen = greatest(entity.last_seen, excluded.last_seen)
     returning id`,
    [newId('ent'), workspaceId, type.id, `${type.id}:${sameAs(naming)}`.slice(0, 400), naming, source.at],
  );
  const id = rows[0]!.id as string;
  // One row per thing and message. A second look at the same message adds to what it said and counts nothing twice.
  const seen = await tx.query(
    `insert into evidence (workspace_id, entity_id, item_id, quote, fields) values ($1, $2, $3, $4, $5::jsonb)
     on conflict (entity_id, item_id) where relation_id is null do update set quote = excluded.quote, fields = coalesce(evidence.fields, '{}'::jsonb) || excluded.fields
     returning (xmax = 0) as fresh`,
    [workspaceId, id, source.itemId, source.quote.slice(0, MAX_QUOTE), JSON.stringify(fields)],
  );
  if (seen.rows[0]?.fresh) await tx.query('update entity set mentions = mentions + 1 where id = $1', [id]);
  // The thing's fields are whatever its evidence says, newest message first: a later email updates a stage or a price.
  await settleThings(tx, workspaceId, id);
}

/**
 * Keeps what the model's read of one thread found: things of accepted kinds, and sightings of kinds the
 * workspace does not track. `rawThings` and `rawKinds` are the model's output as it came; anything that is
 * not the expected shape, or that the thread's own words do not back, is dropped without a trace.
 */
export async function noteThings(tx: Tx, workspaceId: string, thread: { threadKey: string; connectionId: string }, rawThings: unknown, rawKinds: unknown): Promise<{ things: number; sightings: number }> {
  const things = (Array.isArray(rawThings) ? rawThings : []).slice(0, THINGS_PER_THREAD).filter(isRecord);
  const kinds = (Array.isArray(rawKinds) ? rawKinds : []).slice(0, KINDS_PER_THREAD).filter(isRecord);
  const kept = { things: 0, sightings: 0 };
  if (!things.length && !kinds.length) return kept;

  const types = await typesOf(tx, workspaceId);
  const messages = (
    await tx.query(
      `select i.id, i.occurred_at, i.subject, b.text from item i left join item_body b on b.item_id = i.id
       where i.workspace_id = $1 and i.connection_id = $2 and i.kind = 'message' and i.thread_key = $3 order by i.occurred_at desc limit 20`,
      [workspaceId, thread.connectionId, thread.threadKey],
    )
  ).rows as Message[];
  // Everything the thread says, subject lines included: a value has to be somewhere in here to be kept.
  const said = messages.map((m) => `${m.subject ?? ''}\n${m.text ?? ''}`).join('\n');
  const sentence = (quote: unknown) => {
    const q = typeof quote === 'string' ? quote.trim() : '';
    const from = q ? messages.find((m) => quoted(m.text ?? '', q)) : undefined;
    return from ? { itemId: from.id, at: new Date(from.occurred_at), quote: q } : null;
  };
  const stated = (v: unknown) => {
    const value = plain(v, MAX_VALUE);
    return value && appears(said, value) ? value : '';
  };

  for (const t of things) {
    const type = typeof t.kind === 'string' ? kindNamed(certified(types), t.kind) : undefined;
    const source = sentence(t.quote);
    if (!type || !source || !isRecord(t.fields)) continue;
    const given = new Map(Object.entries(t.fields).map(([label, value]) => [fieldKey(label), value]));
    const fields: Record<string, string> = {};
    for (const f of type.fields) {
      const value = stated(given.get(f.key));
      if (value) fields[f.key] = value;
    }
    // Without the field that names it there is no telling which thing this is.
    if (!sameAs(fields[type.fields[0]!.key] ?? '')) continue;
    await keepThing(tx, workspaceId, type, fields, source);
    kept.things++;
  }

  for (const k of kinds) {
    const label = nameOf(k.kind, MAX_NAME);
    const kind = kindKey(label);
    const name = stated(k.name);
    const source = sentence(k.quote);
    if (!kind || NOT_A_KIND.has(kind) || !sameAs(name) || !source || !Array.isArray(k.fields)) continue;
    // A kind the workspace tracks is read as a thing, not counted; one it dismissed is not counted again.
    const known = kindNamed(types, label);
    if (known && known.status !== 'proposed') continue;
    const pairs: [string, string][] = [];
    for (const pair of k.fields.slice(0, SEEN_FIELDS + 1)) {
      if (!Array.isArray(pair)) continue;
      const field = nameOf(pair[0], MAX_LABEL).toLowerCase();
      const value = stated(pair[1]);
      if (field && value && !pairs.some((p) => fieldKey(p[0]) === fieldKey(field))) pairs.push([field, value]);
    }
    const { rowCount } = await tx.query(
      `insert into type_sighting (workspace_id, kind, connection_id, thread_key, item_id, name, fields, quote) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       on conflict (workspace_id, kind, connection_id, thread_key) do nothing`,
      [workspaceId, known?.key ?? kind, thread.connectionId, thread.threadKey, source.itemId, name, JSON.stringify(pairs), source.quote.slice(0, MAX_QUOTE)],
    );
    kept.sightings += rowCount ?? 0;
  }
  return kept;
}

/* ───────────── Proposals ───────────── */

interface Sighting {
  item_id: string;
  name: string;
  fields: [string, string][];
  quote: string;
  occurred_at: Date;
  subject: string | null;
  sender: string | null;
  sender_name: string | null;
  thread_key: string | null;
}

const FROM_A_CONNECTED_ACCOUNT = `c.status = 'active'`;

/** Where a kind was seen, newest first. Mail from a disconnected account no longer counts, even before it is deleted. */
async function sightingsOf(tx: Tx, workspaceId: string, kind: string): Promise<Sighting[]> {
  const { rows } = await tx.query(
    `select s.item_id, s.name, s.fields, s.quote, i.occurred_at, i.subject, i.sender, i.meta->>'senderName' as sender_name, i.thread_key
     from type_sighting s join item i on i.id = s.item_id join connection c on c.id = s.connection_id
     where s.workspace_id = $1 and s.kind = $2 and ${FROM_A_CONNECTED_ACCOUNT} order by i.occurred_at desc limit 50`,
    [workspaceId, kind],
  );
  return rows as Sighting[];
}

const sourceOf = (r: { quote: string | null; subject: string | null; sender: string | null; sender_name: string | null; occurred_at: Date; thread_key: string | null }): TrackedSource => ({
  quote: r.quote ?? '',
  subject: r.subject ?? '',
  from: r.sender_name || r.sender || '',
  at: new Date(r.occurred_at),
  ...(r.thread_key ? { thread: r.thread_key } : {}),
});

/**
 * What a kind Timmy noticed would look like if it were tracked: its name, the field that names each thing, and
 * the few other fields most threads gave. The naming field is the one whose value is what the thread called
 * the thing ("12 Oak Street" is both the property's name and its address); failing that it is simply "name".
 */
function shapeOf(kind: string, seen: Sighting[]): { name: string; fields: TrackedField[] } {
  const counts = new Map<string, { label: string; threads: number; naming: number }>();
  for (const s of seen) {
    for (const [label, value] of s.fields) {
      const key = fieldKey(label);
      const c = counts.get(key) ?? { label, threads: 0, naming: 0 };
      c.threads++;
      if (sameAs(value) === sameAs(s.name)) c.naming++;
      counts.set(key, c);
    }
  }
  const all = [...counts].map(([key, c]) => ({ key, ...c }));
  const naming = all.filter((f) => f.naming * 2 > seen.length).sort((a, b) => b.naming - a.naming)[0];
  const first: TrackedField = naming ? { key: naming.key, label: naming.label } : { key: 'name', label: 'name' };
  // A field only one thread mentioned says little about the kind.
  const rest = all.filter((f) => f.key !== first.key && f.threads >= 2).sort((a, b) => b.threads - a.threads).slice(0, SEEN_FIELDS);
  return { name: capital(kind), fields: [first, ...rest.map((f) => ({ key: f.key, label: f.label }))] };
}

const proposalOf = (key: string, name: string, fields: TrackedField[], why: 'trade' | 'seen', seen: Sighting[]): TrackedProposal => ({
  key,
  name,
  fields,
  why,
  threads: seen.length,
  examples: seen.slice(0, 3).map((s) => ({ name: s.name, fields: s.fields, source: sourceOf(s) })),
});

/** The kinds Timmy noticed often enough to offer, that nobody has decided on yet. */
async function seenOftenEnough(tx: Tx, workspaceId: string, types: TypeRow[]): Promise<string[]> {
  const { rows } = await tx.query(
    `select s.kind from type_sighting s join connection c on c.id = s.connection_id
     where s.workspace_id = $1 and ${FROM_A_CONNECTED_ACCOUNT} group by s.kind having count(*) >= $2 order by count(*) desc, s.kind limit 20`,
    [workspaceId, PROPOSE_AFTER],
  );
  return rows.map((r) => r.kind as string).filter((kind) => !kindNamed(types, kind));
}

/** A thing counts while a stored message from a connected account still shows it. */
const STILL_SHOWN = `exists (select 1 from evidence e join item i on i.id = e.item_id join connection c on c.id = i.connection_id where e.entity_id = n.id and e.relation_id is null and ${FROM_A_CONNECTED_ACCOUNT})`;

/** The review screen's content: what Timmy offers to track, and what is tracked with how many of each it knows. */
export async function trackedOverview(workspaceId: string): Promise<TrackedOverview> {
  return withWorkspace({ workspaceId }, async (tx) => {
    const types = await typesOf(tx, workspaceId);
    const proposals: TrackedProposal[] = [];
    for (const t of types.filter((x) => x.status === 'proposed')) proposals.push(proposalOf(t.key, t.name, t.fields, 'trade', await sightingsOf(tx, workspaceId, t.key)));
    for (const kind of await seenOftenEnough(tx, workspaceId, types)) {
      const seen = await sightingsOf(tx, workspaceId, kind);
      const shape = shapeOf(kind, seen);
      proposals.push(proposalOf(kind, shape.name, shape.fields, 'seen', seen));
    }
    const { rows } = await tx.query(`select n.type_id, count(*)::int as known from entity n where n.workspace_id = $1 and n.type = 'thing' and ${STILL_SHOWN} group by n.type_id`, [workspaceId]);
    const known = new Map(rows.map((r) => [r.type_id as string, r.known as number]));
    const tracked: TrackedKind[] = certified(types).map((t) => ({ id: t.id, key: t.key, name: t.name, fields: t.fields, known: known.get(t.id) ?? 0 }));
    return { proposals, tracked };
  });
}

/* ───────────── Deciding: accept, dismiss, rename, remove a field, stop ───────────── */

export type Decided<T = object> = ({ ok: true } & T) | { ok: false; status: 400 | 404 | 409; error: string };

interface By {
  workspaceId: string;
  userId: string;
}

const NAME_RULE = `A name is up to four plain words, at most ${MAX_NAME} characters.`;

/** A new name must not be one another kind already answers to, or the mail could not be told which is meant. */
const nameTaken = (types: TypeRow[], name: string, self?: string) => types.some((t) => t.id !== self && t.status !== 'dismissed' && (t.key === kindKey(name) || kindKey(t.name) === kindKey(name)));

/**
 * Accepts a proposed kind, optionally under another name. From now on threads are read for it. What Timmy
 * had already noticed of this kind (the examples the proposal showed) becomes the first things it knows.
 */
export async function acceptKind(by: By, key: string, newName?: unknown): Promise<Decided<{ id: string; adopted: number }>> {
  return withWorkspace({ workspaceId: by.workspaceId, userId: by.userId, lock: true }, async (tx) => {
    const types = await typesOf(tx, by.workspaceId);
    let type = types.find((t) => t.key === key);
    if (type?.status === 'certified') return { ok: true, id: type.id, adopted: 0 };
    const offered = type ? true : (await seenOftenEnough(tx, by.workspaceId, types)).includes(key);
    if (!offered) return { ok: false, status: 404, error: 'Timmy hasn’t proposed tracking that.' };
    const seen = await sightingsOf(tx, by.workspaceId, key);
    const shape = type ? { name: type.name, fields: type.fields } : shapeOf(key, seen);
    const name = newName === undefined ? shape.name : nameOf(newName, MAX_NAME);
    if (!name) return { ok: false, status: 400, error: NAME_RULE };
    if (nameTaken(types, name, type?.id)) return { ok: false, status: 409, error: 'Something you track or were offered already has that name.' };
    const id = type?.id ?? newId('typ');
    if (type) await tx.query(`update tracked_type set name = $3, status = 'certified', decided_by = $4, decided_at = now() where id = $1 and workspace_id = $2`, [id, by.workspaceId, name, by.userId]);
    else await tx.query(`insert into tracked_type (id, workspace_id, key, name, fields, status, source, decided_by, decided_at) values ($1, $2, $3, $4, $5::jsonb, 'certified', 'seen', $6, now())`, [id, by.workspaceId, key, name, JSON.stringify(shape.fields), by.userId]);
    type = { id, key, name, fields: shape.fields, status: 'certified', source: type?.source ?? 'seen' };

    // The sightings were checked against their threads when they were counted, so they can be kept as they are.
    let adopted = 0;
    for (const s of [...seen].reverse()) {
      const given = new Map(s.fields.map(([label, value]) => [fieldKey(label), value]));
      // Named by the kind's first field when the thread gave it, otherwise by what the thread called the thing.
      const named = given.get(type.fields[0]!.key);
      const fields: Record<string, string> = { [type.fields[0]!.key]: named && sameAs(named) ? named : s.name };
      for (const f of type.fields.slice(1)) if (given.has(f.key)) fields[f.key] = given.get(f.key)!;
      await keepThing(tx, by.workspaceId, type, fields, { itemId: s.item_id, at: new Date(s.occurred_at), quote: s.quote });
      adopted++;
    }
    await tx.query('delete from type_sighting where workspace_id = $1 and kind = $2', [by.workspaceId, key]);
    await audit(tx, by.workspaceId, { actor: by.userId, action: 'tracking.accepted', detail: { kind: key, name, fields: type.fields.map((f) => f.label) } });
    return { ok: true, id, adopted };
  });
}

/** Turns a proposal down. The kind is remembered so it is not proposed again, and what was counted for it is forgotten. */
export async function dismissKind(by: By, key: string): Promise<Decided> {
  return withWorkspace({ workspaceId: by.workspaceId, userId: by.userId, lock: true }, async (tx) => {
    const types = await typesOf(tx, by.workspaceId);
    const type = types.find((t) => t.key === key);
    if (type?.status === 'dismissed') return { ok: true };
    if (type?.status === 'certified') return { ok: false, status: 409, error: 'That is being tracked. Stop tracking it instead.' };
    if (!type && !(await seenOftenEnough(tx, by.workspaceId, types)).includes(key)) return { ok: false, status: 404, error: 'Timmy hasn’t proposed tracking that.' };
    if (type) await tx.query(`update tracked_type set status = 'dismissed', decided_by = $3, decided_at = now() where id = $1 and workspace_id = $2`, [type.id, by.workspaceId, by.userId]);
    else await tx.query(`insert into tracked_type (id, workspace_id, key, name, status, source, decided_by, decided_at) values ($1, $2, $3, $4, 'dismissed', 'seen', $5, now())`, [newId('typ'), by.workspaceId, key, capital(key), by.userId]);
    await tx.query('delete from type_sighting where workspace_id = $1 and kind = $2', [by.workspaceId, key]);
    await audit(tx, by.workspaceId, { actor: by.userId, action: 'tracking.dismissed', detail: { kind: key } });
    return { ok: true };
  });
}

const NOT_TRACKED: Decided<never> = { ok: false, status: 404, error: 'That isn’t something Timmy tracks.' };

/** Renames a tracked kind, or removes one of its fields. The field that names each thing stays. */
export async function changeKind(by: By, id: string, change: { name?: unknown; removeField?: unknown }): Promise<Decided> {
  return withWorkspace({ workspaceId: by.workspaceId, userId: by.userId, lock: true }, async (tx) => {
    const types = await typesOf(tx, by.workspaceId);
    const type = certified(types).find((t) => t.id === id);
    if (!type) return NOT_TRACKED;
    if (change.name !== undefined) {
      const name = nameOf(change.name, MAX_NAME);
      if (!name) return { ok: false, status: 400, error: NAME_RULE };
      if (nameTaken(types, name, type.id)) return { ok: false, status: 409, error: 'Something you track or were offered already has that name.' };
      await tx.query('update tracked_type set name = $3 where id = $1 and workspace_id = $2', [type.id, by.workspaceId, name]);
      await audit(tx, by.workspaceId, { actor: by.userId, action: 'tracking.renamed', detail: { kind: type.key, from: type.name, to: name } });
    }
    if (change.removeField !== undefined) {
      const at = type.fields.findIndex((f) => f.key === change.removeField);
      if (at < 0) return { ok: false, status: 404, error: 'That kind has no such field.' };
      if (at === 0) return { ok: false, status: 400, error: 'The first field names each one, so it has to stay.' };
      const field = type.fields[at]!;
      await tx.query('update tracked_type set fields = $3::jsonb where id = $1 and workspace_id = $2', [type.id, by.workspaceId, JSON.stringify(type.fields.filter((f) => f.key !== field.key))]);
      // What was learned for that field is forgotten, not hidden: it leaves the evidence and so the things themselves.
      await tx.query(`update evidence e set fields = e.fields - $3::text from entity n where n.id = e.entity_id and n.workspace_id = $1 and n.type_id = $2 and e.fields ? $3::text`, [by.workspaceId, type.id, field.key]);
      await settleThings(tx, by.workspaceId);
      await audit(tx, by.workspaceId, { actor: by.userId, action: 'tracking.field-removed', detail: { kind: type.key, field: field.label } });
    }
    return { ok: true };
  });
}

/** Stops tracking a kind: everything learned of it is removed, and it is not proposed again. */
export async function stopTracking(by: By, id: string): Promise<Decided<{ removed: number }>> {
  return withWorkspace({ workspaceId: by.workspaceId, userId: by.userId, lock: true }, async (tx) => {
    const type = certified(await typesOf(tx, by.workspaceId)).find((t) => t.id === id);
    if (!type) return NOT_TRACKED;
    // The evidence rows go with their things.
    const gone = await tx.query(`delete from entity where workspace_id = $1 and type = 'thing' and type_id = $2`, [by.workspaceId, type.id]);
    await tx.query(`update tracked_type set status = 'dismissed', decided_by = $3, decided_at = now() where id = $1 and workspace_id = $2`, [type.id, by.workspaceId, by.userId]);
    await audit(tx, by.workspaceId, { actor: by.userId, action: 'tracking.stopped', detail: { kind: type.key, removed: gone.rowCount ?? 0 } });
    return { ok: true, removed: gone.rowCount ?? 0 };
  });
}

/* ───────────── Reading what is tracked ───────────── */

interface ThingRow {
  id: string;
  type_id: string;
  name: string;
  attrs: Record<string, unknown>;
  last_seen: Date;
}

/** Each thing with its fields (only the ones its kind still has) and the sentences and emails it rests on. */
async function withSources(tx: Tx, rows: ThingRow[], types: TypeRow[], perThing: number): Promise<(TrackedThing & { kind: TypeRow })[]> {
  if (!rows.length) return [];
  const evidence = await tx.query(
    `select e.entity_id, e.quote, i.subject, i.sender, i.meta->>'senderName' as sender_name, i.occurred_at, i.thread_key
     from evidence e join item i on i.id = e.item_id join connection c on c.id = i.connection_id
     where e.entity_id = any($1::text[]) and e.relation_id is null and ${FROM_A_CONNECTED_ACCOUNT} order by i.occurred_at desc`,
    [rows.map((r) => r.id)],
  );
  const sources = new Map<string, TrackedSource[]>();
  for (const e of evidence.rows) {
    const list = sources.get(e.entity_id as string) ?? [];
    if (list.length < perThing) list.push(sourceOf(e as Parameters<typeof sourceOf>[0]));
    sources.set(e.entity_id as string, list);
  }
  return rows.flatMap((r) => {
    const kind = types.find((t) => t.id === r.type_id);
    if (!kind) return [];
    const fields: Record<string, string> = {};
    for (const f of kind.fields) if (typeof r.attrs[f.key] === 'string') fields[f.key] = r.attrs[f.key] as string;
    return [{ id: r.id, name: r.name, fields, lastSeen: new Date(r.last_seen), sources: sources.get(r.id) ?? [], kind }];
  });
}

/** The things of one tracked kind, the most recently mentioned first. Null when the kind is not tracked. */
export async function thingsOf(workspaceId: string, typeId: string, limit = 200): Promise<TrackedThing[] | null> {
  return withWorkspace({ workspaceId }, async (tx) => {
    const types = certified(await typesOf(tx, workspaceId));
    if (!types.some((t) => t.id === typeId)) return null;
    const { rows } = await tx.query(`select n.id, n.type_id, n.name, n.attrs, n.last_seen from entity n where n.workspace_id = $1 and n.type = 'thing' and n.type_id = $2 and ${STILL_SHOWN} order by n.last_seen desc, n.name limit $3`, [workspaceId, typeId, limit]);
    return (await withSources(tx, rows as ThingRow[], types, 5)).map(({ kind: _kind, ...thing }) => thing);
  });
}

/**
 * For Ask: tracked things matching a kind, some words, or both; the most recently mentioned first.
 * Also says which kinds are tracked, so "no deals" can be told apart from "deals are not tracked".
 */
export async function findThings(workspaceId: string, ask: { type?: string; query?: string }, limit = 8) {
  return withWorkspace({ workspaceId }, async (tx) => {
    const types = certified(await typesOf(tx, workspaceId));
    const tracked = types.map((t) => t.name);
    const kind = ask.type ? kindNamed(types, ask.type) : undefined;
    if (!types.length || (ask.type && !kind)) return { tracked, things: [] };
    // The characters that mean "anything" in a pattern are taken out, so a search for "%" finds nothing instead of everything.
    const terms = (ask.query ?? '').split(/\s+/).map((w) => w.replace(/[%_\\]/g, '')).filter((w) => w.length > 1).slice(0, 6).map((w) => `%${w}%`);
    if (ask.query?.trim() && !terms.length) return { tracked, things: [] };
    const { rows } = await tx.query(
      `select n.id, n.type_id, n.name, n.attrs, n.last_seen from entity n
       where n.workspace_id = $1 and n.type = 'thing' and n.type_id = any($2::text[]) and ${STILL_SHOWN}
         and ($3::text[] = '{}' or n.name ilike any($3::text[]) or exists (select 1 from jsonb_each_text(n.attrs) a where a.value ilike any($3::text[])))
       order by (select count(*) from unnest($3::text[]) w where n.name ilike w) desc, n.last_seen desc limit $4`,
      [workspaceId, kind ? [kind.id] : types.map((t) => t.id), terms, limit],
    );
    const things = (await withSources(tx, rows as ThingRow[], types, 2)).map((t) => ({
      kind: t.kind.name,
      name: t.name,
      // Under the field's own label, the way the person sees it on the screen.
      fields: Object.fromEntries(t.kind.fields.filter((f) => t.fields[f.key]).map((f) => [f.label, t.fields[f.key]!])),
      last_mentioned: t.lastSeen.toISOString(),
      rests_on: t.sources.map((s) => ({ sentence: s.quote, email: s.subject, from: s.from, at: s.at.toISOString() })),
    }));
    return { tracked, things };
  });
}
