/**
 * The ontology, first version: a map of who and what a workspace's mail, calendar and files are about.
 *
 * Plain code builds almost all of it, from fields the providers already give: who wrote, who was written to,
 * who was invited, who owns a file. No model reads anything here, so it costs nothing and cannot be talked
 * into anything by an email. The one thing a model adds is commitments ("I'll send the contract by Friday"),
 * and those are kept only when the words they rest on are really in the message (see `noteCommitments`).
 *
 * Everything points at the stored item it came from. When an account is disconnected its items are deleted,
 * the pointers go with them, and whatever nothing points at any more is removed (`pruneOntology`).
 */
import { createHash } from 'node:crypto';
import { withWorkspace, type Tx } from '../db/pool';
import { newId } from '../lib/ids';

export type EntityType = 'person' | 'organization' | 'meeting' | 'document' | 'commitment';
export type RelationKind = 'works_at' | 'attended' | 'owns' | 'promised_by' | 'owed_to';

/** Addresses anyone can get. The domain says nothing about where the person works. */
const PERSONAL_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'fastmail.com', 'hey.com', 'zoho.com', 'yandex.com', 'mail.com']);
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);
/** Mailboxes no person sits behind. They are senders, not people to know. */
const AUTOMATED = /^(no-?reply|do-?not-?reply|notifications?|notify|mailer(-daemon)?|news(letter)?|updates?|digest|marketing|billing|receipts?|invoices?|orders?|accounts?|alerts?|bounces?|postmaster|hello|team|info|support|help|sales|admin|contact|calendar-notification|drive-shares-(dm-)?noreply)([+._-].*)?$/i;
const BULK = /^CATEGORY_(PROMOTIONS|SOCIAL|FORUMS|UPDATES)$/;

/** "mail.acme.co.uk" → the domain a company owns ("acme.co.uk"), or null for personal mail. */
export function companyDomain(email: string): string | null {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  const parts = domain.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  const tail = parts.length >= 3 && parts[parts.length - 1]!.length === 2 && SECOND_LEVEL.has(parts[parts.length - 2]!) ? 3 : 2;
  const own = parts.slice(-tail).join('.');
  return PERSONAL_MAIL.has(own) || PERSONAL_MAIL.has(domain) ? null : own;
}

/** A readable name for a company known only by its domain: "northwind-health.com" → "Northwind Health". */
export const nameFromDomain = (domain: string) =>
  domain
    .split('.')[0]!
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');

export const isAutomatedSender = (email: string, labels: string[] = []) => AUTOMATED.test(email.split('@')[0] ?? '') || labels.some((l) => BULK.test(l));

/* ───────────── Writing ───────────── */

async function upsertEntity(tx: Tx, workspaceId: string, type: EntityType, key: string, name: string, attrs: Record<string, unknown>, seen: Date): Promise<string> {
  const { rows } = await tx.query(
    `insert into entity (id, workspace_id, type, key, name, attrs, first_seen, last_seen)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $7)
     on conflict (workspace_id, type, key) do update set
       -- A name, once known, is kept: a later message that carries none must not blank it.
       name = case when entity.name = '' then excluded.name else entity.name end,
       attrs = entity.attrs || excluded.attrs,
       first_seen = least(entity.first_seen, excluded.first_seen),
       last_seen = greatest(entity.last_seen, excluded.last_seen)
     returning id`,
    [newId('ent'), workspaceId, type, key.slice(0, 400), name.replace(/\u0000/g, '').slice(0, 300), JSON.stringify(attrs).replace(/\\u0000/g, ''), seen],
  );
  return rows[0]!.id as string;
}

async function relate(tx: Tx, workspaceId: string, kind: RelationKind, from: string, to: string): Promise<string> {
  const { rows } = await tx.query(
    `insert into relation (id, workspace_id, kind, from_id, to_id) values ($1, $2, $3, $4, $5)
     on conflict (workspace_id, kind, from_id, to_id) do update set kind = excluded.kind returning id`,
    [newId('rel'), workspaceId, kind, from, to],
  );
  return rows[0]!.id as string;
}

/** Records that an item is why Timmy knows of an entity. Counted once per item, however often the item is looked at. */
async function seenIn(tx: Tx, workspaceId: string, entityId: string, itemId: string, quote?: string): Promise<void> {
  const { rowCount } = await tx.query(`insert into evidence (workspace_id, entity_id, item_id, quote) values ($1, $2, $3, $4) on conflict (entity_id, item_id) where relation_id is null do nothing`, [workspaceId, entityId, itemId, quote ?? null]);
  if (rowCount) await tx.query('update entity set mentions = mentions + 1 where id = $1', [entityId]);
}

async function shownBy(tx: Tx, workspaceId: string, relationId: string, itemId: string): Promise<void> {
  await tx.query(`insert into evidence (workspace_id, relation_id, item_id) values ($1, $2, $3) on conflict (relation_id, item_id) where relation_id is not null do nothing`, [workspaceId, relationId, itemId]);
}

/** A person, and the company their address belongs to when it is a company's. Returns the person's id. */
async function notePerson(tx: Tx, workspaceId: string, email: string, name: string, itemId: string, seen: Date): Promise<string> {
  const person = await upsertEntity(tx, workspaceId, 'person', email, name, {}, seen);
  await seenIn(tx, workspaceId, person, itemId);
  // A second name for the same address is kept as another name they go by, never as a replacement.
  if (name) await tx.query(`insert into term (workspace_id, entity_id, term) select $1, $2, $3 where exists (select 1 from entity where id = $2 and lower(name) <> lower($3)) on conflict do nothing`, [workspaceId, person, name.slice(0, 300)]);
  const domain = companyDomain(email);
  if (domain) {
    const org = await upsertEntity(tx, workspaceId, 'organization', domain, nameFromDomain(domain), { nameFrom: 'domain' }, seen);
    await seenIn(tx, workspaceId, org, itemId);
    await shownBy(tx, workspaceId, await relate(tx, workspaceId, 'works_at', person, org), itemId);
  }
  return person;
}

interface ItemRow {
  id: string;
  connection_id: string;
  kind: 'message' | 'event' | 'file' | 'record';
  external_id: string;
  occurred_at: Date;
  sender: string | null;
  recipients: { to?: string[]; cc?: string[] } | null;
  subject: string | null;
  snippet: string | null;
  labels: string[];
  direction: 'in' | 'out' | null;
  meta: Record<string, unknown>;
  mine: string | null;
}

const ADDRESS = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[a-z]{2,}$/i;

async function noteItem(tx: Tx, workspaceId: string, it: ItemRow): Promise<void> {
  const mine = (it.mine ?? '').toLowerCase();
  const seen = new Date(it.occurred_at);
  const known = (email: unknown): email is string => typeof email === 'string' && ADDRESS.test(email) && email.toLowerCase() !== mine && !isAutomatedSender(email);
  if (it.kind === 'message') {
    if (it.direction === 'out') {
      // People the mailbox's owner wrote to. Their names are not in the item; an address is enough to know them by.
      for (const email of [...(it.recipients?.to ?? []), ...(it.recipients?.cc ?? [])].slice(0, 30)) if (known(email)) await notePerson(tx, workspaceId, email.toLowerCase(), '', it.id, seen);
    } else if (known(it.sender) && !isAutomatedSender(it.sender, it.labels)) {
      await notePerson(tx, workspaceId, it.sender.toLowerCase(), String(it.meta.senderName ?? ''), it.id, seen);
    }
  } else if (it.kind === 'event') {
    const people = (it.recipients?.to ?? []).filter(known).slice(0, 50);
    if (!people.length) return;
    const meeting = await upsertEntity(tx, workspaceId, 'meeting', `${it.connection_id}:${it.external_id}`, it.subject ?? '', { start: seen.toISOString(), end: it.meta.end ?? null }, seen);
    await seenIn(tx, workspaceId, meeting, it.id);
    const names = new Map(((it.meta.attendees ?? []) as { email?: string; name?: string }[]).map((a) => [String(a.email ?? '').toLowerCase(), a.name ?? '']));
    for (const email of people) await shownBy(tx, workspaceId, await relate(tx, workspaceId, 'attended', await notePerson(tx, workspaceId, email.toLowerCase(), names.get(email.toLowerCase()) ?? '', it.id, seen), meeting), it.id);
  } else if (it.kind === 'file') {
    const doc = await upsertEntity(tx, workspaceId, 'document', `${it.connection_id}:${it.external_id}`, it.subject ?? '', { kind: it.snippet ?? 'File', link: it.meta.link ?? null }, seen);
    await seenIn(tx, workspaceId, doc, it.id);
    if (known(it.sender)) await shownBy(tx, workspaceId, await relate(tx, workspaceId, 'owns', await notePerson(tx, workspaceId, it.sender.toLowerCase(), String(it.meta.ownerName ?? ''), it.id, seen), doc), it.id);
  }
}

/**
 * Reads the items that have not been looked at yet and adds what they show to the map. Runs in batches;
 * `more` says whether another batch is waiting. Looking at an item twice changes nothing.
 */
export async function noteItems(workspaceId: string, batch = 200): Promise<{ items: number; more: boolean }> {
  return withWorkspace({ workspaceId }, async (tx) => {
    const { rows } = await tx.query(
      `select i.id, i.connection_id, i.kind, i.external_id, i.occurred_at, i.sender, i.recipients, i.subject, i.snippet, i.labels, i.direction, i.meta, c.account_label as mine
       from item i join connection c on c.id = i.connection_id
       where i.workspace_id = $1 and i.ontology_at is null and c.status = 'active'
       order by i.created_at limit $2 for update of i skip locked`,
      [workspaceId, batch],
    );
    for (const it of rows as ItemRow[]) await noteItem(tx, workspaceId, it);
    if (rows.length) await tx.query('update item set ontology_at = now() where id = any($1::text[])', [rows.map((r) => r.id)]);
    return { items: rows.length, more: rows.length === batch };
  });
}

/* ───────────── Commitments ───────────── */

export interface Commitment {
  /** Who owes it: the other person ("them") or the mailbox's owner ("me"). */
  who: 'them' | 'me';
  what: string;
  /** YYYY-MM-DD, when the message names a date. */
  due?: string;
  /** The words in the message this rests on, copied exactly. */
  quote: string;
}

export const words = (t: string) => t.toLowerCase().replace(/[\s ]+/g, ' ').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();

/** True when the quote is really in the text, give or take spacing and curly quotes. A model's paraphrase is not a quote. */
export const quoted = (text: string, quote: string) => quote.trim().length >= 8 && words(text).includes(words(quote));

/**
 * Keeps the commitments a model read out of a thread, each only if its quote is in one of the thread's own
 * stored messages. That message becomes the evidence. Returns how many were kept.
 */
export async function noteCommitments(tx: Tx, workspaceId: string, thread: { id: string; threadKey: string; connectionId: string; counterpart?: string }, list: Commitment[]): Promise<number> {
  const { rows } = await tx.query(
    `select i.id, i.sender, i.direction, i.occurred_at, b.text from item i left join item_body b on b.item_id = i.id
     where i.workspace_id = $1 and i.connection_id = $2 and i.kind = 'message' and i.thread_key = $3 order by i.occurred_at desc limit 20`,
    [workspaceId, thread.connectionId, thread.threadKey],
  );
  let kept = 0;
  for (const c of list.slice(0, 5)) {
    const what = c.what.replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!what || (c.who !== 'them' && c.who !== 'me')) continue;
    // A promise by the other person has to be in their message; one by the owner, in a message the owner sent.
    const source = rows.find((r) => (c.who === 'me' ? r.direction === 'out' : r.direction !== 'out') && quoted(String(r.text ?? ''), c.quote));
    if (!source) continue;
    const due = c.due && /^\d{4}-\d{2}-\d{2}$/.test(c.due) && !Number.isNaN(new Date(c.due).getTime()) ? c.due : null;
    const key = createHash('sha256').update(`${thread.threadKey}\n${c.who}\n${words(what)}`).digest('hex').slice(0, 32);
    const id = await upsertEntity(tx, workspaceId, 'commitment', key, what, { who: c.who, due, threadId: thread.id, threadKey: thread.threadKey, open: true }, new Date(source.occurred_at as string));
    await seenIn(tx, workspaceId, id, source.id as string, c.quote.trim().slice(0, 500));
    const other = c.who === 'them' ? String(source.sender ?? '') : (thread.counterpart ?? '');
    if (ADDRESS.test(other)) {
      const person = await upsertEntity(tx, workspaceId, 'person', other.toLowerCase(), '', {}, new Date(source.occurred_at as string));
      await shownBy(tx, workspaceId, await relate(tx, workspaceId, c.who === 'them' ? 'promised_by' : 'owed_to', id, person), source.id as string);
    }
    kept++;
  }
  return kept;
}

/* ───────────── Forgetting ───────────── */

/**
 * Removes what nothing supports any more: links with no evidence left, then entities with none.
 * Items are deleted when their account is disconnected or their retention ends; this follows them.
 */
export async function pruneOntology(workspaceId: string): Promise<{ relations: number; entities: number }> {
  return withWorkspace({ workspaceId }, async (tx) => {
    // A tracked thing's fields are what its remaining evidence says: a value only a deleted message gave goes with it.
    await settleThings(tx, workspaceId);
    const rel = await tx.query(`delete from relation r where r.workspace_id = $1 and not exists (select 1 from evidence e where e.relation_id = r.id)`, [workspaceId]);
    const ent = await tx.query(`delete from entity n where n.workspace_id = $1 and not exists (select 1 from evidence e where e.entity_id = n.id) and not exists (select 1 from relation r where r.from_id = n.id or r.to_id = n.id)`, [workspaceId]);
    return { relations: rel.rowCount ?? 0, entities: ent.rowCount ?? 0 };
  });
}

/**
 * Sets each tracked thing's fields (deals, properties… see `types.ts`) to what its evidence says: for every
 * field, the value from the newest message that gave one. Run after a thing is read from a message and after
 * messages are deleted, so a value never outlives the message it was read from.
 */
export async function settleThings(tx: Tx, workspaceId: string, entityId?: string): Promise<void> {
  await tx.query(
    `update entity n set attrs = coalesce((
       select jsonb_object_agg(s.key, s.value) from (
         select distinct on (f.key) f.key, f.value
         from evidence e join item i on i.id = e.item_id cross join lateral jsonb_each(e.fields) f
         where e.entity_id = n.id and e.relation_id is null and jsonb_typeof(e.fields) = 'object'
         order by f.key, i.occurred_at desc, e.id desc) s), '{}'::jsonb)
     where n.workspace_id = $1 and n.type = 'thing' and ($2::text is null or n.id = $2)`,
    [workspaceId, entityId ?? null],
  );
}

/* ───────────── Reading ───────────── */

export interface PersonCard {
  name: string;
  email: string;
  also?: string[];
  company?: string;
  mentions: number;
  lastSeen: string;
  recent: { subject: string; at: string; thread?: string }[];
  commitments: { who: 'them' | 'me'; what: string; due: string | null; quote: string | null; thread?: string }[];
}

/** People (and the people at a company) matching a name, an address or a company. Best matches first. */
export async function findPeople(workspaceId: string, query: string, limit = 5): Promise<PersonCard[]> {
  const terms = query
    .split(/\s+/)
    .map((w) => w.replace(/[%_\\]/g, ''))
    .filter((w) => w.length > 1)
    .slice(0, 5)
    .map((w) => `%${w}%`);
  if (!terms.length) return [];
  return withWorkspace({ workspaceId }, async (tx) => {
    const { rows } = await tx.query(
      `select p.id, p.name, p.key as email, p.mentions, p.last_seen, o.name as company,
              (select array_agg(t.term) from term t where t.entity_id = p.id) as also,
              (select count(*) from unnest($2::text[]) w where p.name ilike w or p.key ilike w or coalesce(o.name, '') ilike w or coalesce(o.key, '') ilike w) as hits
       from entity p
       left join relation r on r.from_id = p.id and r.kind = 'works_at'
       left join entity o on o.id = r.to_id
       where p.workspace_id = $1 and p.type = 'person'
         and (p.name ilike any($2::text[]) or p.key ilike any($2::text[]) or o.name ilike any($2::text[]) or o.key ilike any($2::text[])
              or exists (select 1 from term t where t.entity_id = p.id and t.term ilike any($2::text[])))
       order by hits desc, p.last_seen desc limit $3`,
      [workspaceId, terms, limit],
    );
    const out: PersonCard[] = [];
    for (const p of rows) {
      const recent = await tx.query(
        `select i.subject, i.occurred_at, i.thread_key from evidence e join item i on i.id = e.item_id
         where e.entity_id = $1 and e.relation_id is null and i.kind = 'message' order by i.occurred_at desc limit 3`,
        [p.id],
      );
      const owed = await tx.query(
        `select c.name, c.attrs, (select e.quote from evidence e where e.entity_id = c.id and e.relation_id is null limit 1) as quote
         from relation r join entity c on c.id = r.from_id
         where r.to_id = $1 and r.kind in ('promised_by', 'owed_to') and c.type = 'commitment' and coalesce((c.attrs->>'open')::boolean, true)
         order by c.last_seen desc limit 5`,
        [p.id],
      );
      out.push({
        name: (p.name as string) || (p.email as string),
        email: p.email as string,
        ...((p.also as string[] | null)?.length ? { also: p.also as string[] } : {}),
        ...(p.company ? { company: p.company as string } : {}),
        mentions: p.mentions as number,
        lastSeen: new Date(p.last_seen as string).toISOString(),
        recent: recent.rows.map((r) => ({ subject: r.subject as string, at: new Date(r.occurred_at as string).toISOString(), thread: (r.thread_key as string | null) ?? undefined })),
        commitments: owed.rows.map((c) => {
          const a = c.attrs as { who: 'them' | 'me'; due: string | null; threadKey?: string };
          return { who: a.who, what: c.name as string, due: a.due ?? null, quote: (c.quote as string | null) ?? null, thread: a.threadKey };
        }),
      });
    }
    return out;
  });
}

/** Open commitments, soonest first: what people owe the owner, and what the owner owes them. */
export async function openCommitments(workspaceId: string, limit = 20) {
  return withWorkspace({ workspaceId }, async (tx) => {
    const { rows } = await tx.query(
      `select c.name, c.attrs, c.last_seen, p.name as person, p.key as email,
              (select e.quote from evidence e where e.entity_id = c.id and e.relation_id is null limit 1) as quote
       from entity c
       left join relation r on r.from_id = c.id and r.kind in ('promised_by', 'owed_to')
       left join entity p on p.id = r.to_id
       where c.workspace_id = $1 and c.type = 'commitment' and coalesce((c.attrs->>'open')::boolean, true)
       order by (c.attrs->>'due') asc nulls last, c.last_seen desc limit $2`,
      [workspaceId, limit],
    );
    return rows.map((c) => {
      const a = c.attrs as { who: 'them' | 'me'; due: string | null; threadKey?: string };
      return { who: a.who, what: c.name as string, due: a.due ?? null, with: (c.person as string) || (c.email as string) || null, email: (c.email as string | null) ?? null, quote: (c.quote as string | null) ?? null, thread: a.threadKey };
    });
  });
}

/** The people worth showing on the People screen: those most recently in touch, with how often lately. */
export async function recentPeople(workspaceId: string, limit = 150) {
  return withWorkspace({ workspaceId }, async (tx) => {
    const { rows } = await tx.query(
      `select p.name, p.key as email, p.last_seen, o.name as company,
              (select count(*) from evidence e join item i on i.id = e.item_id where e.entity_id = p.id and e.relation_id is null and i.kind = 'message' and i.occurred_at > now() - interval '30 days')::int as emails
       from entity p
       left join relation r on r.from_id = p.id and r.kind = 'works_at'
       left join entity o on o.id = r.to_id
       where p.workspace_id = $1 and p.type = 'person'
       order by p.last_seen desc limit $2`,
      [workspaceId, limit],
    );
    return rows.map((r) => ({ name: (r.name as string) || '', email: r.email as string, company: (r.company as string | null) ?? undefined, last: new Date(r.last_seen as string), emails: r.emails as number }));
  });
}
