/**
 * Mail sync. Messages come in through Composio (a backfill that pages
 * backwards, and a trigger for each new message), are stored as items, and the
 * threads that need attention are projected into the state the screens show.
 */
import { createHash } from 'node:crypto';
import type { State } from '../../../src/state/store';
import type { Thread } from '../../../src/data/types';
import { draftHash } from '../../../src/live/hash';
import { config } from '../config';
import { withWorkspace, type Tx } from '../db/pool';
import { newId } from '../lib/ids';
import { log } from '../lib/log';
import { mutate } from '../state/mutate';
import { onMailStored } from '../automations/triggers';
import { mailboxFor } from './mailbox';
import { followMailbox, lookedAtFrom } from './mailbox-changes';
import { paragraphs, parseSender, type MailMessage } from './message';
import { connectionById, type ConnectionRow, type Phase } from './tools';

export { addresses, normalize, paragraphs, parseSender, type MailMessage } from './message';

/* ───────────── The item store ───────────── */

export async function upsertMessage(tx: Tx, workspaceId: string, conn: ConnectionRow, m: MailMessage): Promise<{ id: string; inserted: boolean }> {
  const sender = parseSender(m.from);
  // Sent by the mailbox owner means the provider filed it under Sent. The From header alone can be forged.
  const mine = m.labels.includes('SENT');
  const { rows } = await tx.query(
    `insert into item (id, workspace_id, connection_id, kind, external_id, thread_key, occurred_at, sender, recipients, subject, snippet, labels, direction, meta)
     values ($1, $2, $3, 'message', $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13::jsonb)
     on conflict (workspace_id, connection_id, kind, external_id)
     do update set labels = excluded.labels, updated_at = now()
     returning id, (xmax = 0) as inserted`,
    [
      newId('itm'),
      workspaceId,
      conn.id,
      m.id,
      m.threadKey,
      m.at,
      sender.email,
      JSON.stringify({ to: m.to, cc: m.cc }),
      m.subject.slice(0, 500),
      m.text.replace(/\s+/g, ' ').slice(0, 300),
      m.labels,
      mine ? 'out' : 'in',
      JSON.stringify({ senderName: sender.name, fromHeader: m.from.slice(0, 300), attachments: m.attachments }),
    ],
  );
  const row = rows[0] as { id: string; inserted: boolean };
  if (row.inserted) await tx.query('insert into item_body (item_id, workspace_id, text) values ($1, $2, $3) on conflict (item_id) do nothing', [row.id, workspaceId, m.text.slice(0, 400000)]);
  return row;
}

/* ───────────── A first sort, by plain code ───────────── */

const AUTOMATED = /^(no-?reply|do-?not-?reply|notifications?|notify|mailer|news(letter)?|updates?|digest|marketing|billing|receipts?|invoices?|orders?|accounts?|alerts?|bounce|postmaster|hello|team|info)[+.@_-]?/i;
const RECEIPT = /\b(receipt|invoice|payment (received|confirmation)|order (confirmation|#|number)|your order|statement is ready|has shipped)\b/i;
const CALENDAR_REPLY = /^(accepted|declined|tentative(ly accepted)?|updated invitation|invitation):/i;

/**
 * Where a new thread probably belongs, decided without a model: mail that is
 * plainly automated gets a confident suggestion, and anything a person wrote is
 * left for the person to place. The model only looks at what this can't settle.
 */
export function suggest(last: { sender: string; subject: string; text: string; labels: string[] }): NonNullable<Thread['suggestion']> {
  const local = last.sender.split('@')[0] ?? '';
  const bulk = last.labels.some((l) => /^CATEGORY_(PROMOTIONS|SOCIAL|FORUMS)$/.test(l)) || /\bunsubscribe\b|list-unsubscribe|view (this email )?in (your )?browser/i.test(last.text);
  if (CALENDAR_REPLY.test(last.subject)) return { box: 'archived', confidence: 'high', reason: 'A calendar reply. Your calendar already has it.' };
  if (RECEIPT.test(last.subject)) return { box: 'archived', confidence: 'high', reason: 'A receipt or order notice. Nothing to answer.' };
  if (bulk && !RECEIPT.test(last.subject)) return { box: 'read-through', confidence: 'high', reason: 'A newsletter or bulk mailing. Read it when you have time.' };
  if (AUTOMATED.test(local) || last.labels.includes('CATEGORY_UPDATES')) return { box: 'archived', confidence: 'medium', reason: 'An automated notice from a system, not a person.' };
  return { box: 'follow-up', confidence: 'low', effort: 'quick', reason: 'A person wrote to you. Timmy hasn’t read it closely yet.', provisional: true };
}

/* ───────────── Threads the screens show ───────────── */

type LiveThread = Thread;

/**
 * The id a synced thread has on Timmy's side. Gmail's thread ids are short and plain, so they are used as they are.
 * An Outlook conversation id is long and full of punctuation, so a short fingerprint of it stands in.
 */
export const threadIdFor = (conn: ConnectionRow, threadKey: string) => (conn.toolkit === 'outlook' ? `o-${createHash('sha256').update(`${conn.id}:${threadKey}`).digest('hex').slice(0, 20)}` : `g-${threadKey}`);

const personId = (email: string, mine: string) => (email === mine ? 'me' : `mail:${email}`);

/** Builds (or refreshes) the thread a set of stored messages belongs to. Returns the state with it in place. */
export async function projectThread(tx: Tx, state: State, workspaceId: string, conn: ConnectionRow, threadKey: string): Promise<State> {
  const { rows } = await tx.query(
    `select i.external_id, i.occurred_at, i.sender, i.recipients, i.subject, i.labels, i.meta, i.direction, b.text
     from item i left join item_body b on b.item_id = i.id
     where i.workspace_id = $1 and i.connection_id = $2 and i.kind = 'message' and i.thread_key = $3
     order by i.occurred_at`,
    [workspaceId, conn.id, threadKey],
  );
  if (!rows.length) return state;
  const mine = (conn.account_label ?? '').toLowerCase();
  const people: Record<string, { name: string; email: string }> = {};
  const messages = rows.map((r) => {
    const from = r.direction === 'out' ? 'me' : `mail:${r.sender as string}`;
    const name = (r.meta as { senderName?: string }).senderName;
    if (from !== 'me' && name) people[from] = { name, email: r.sender as string };
    const rec = r.recipients as { to: string[]; cc: string[] };
    return {
      id: r.external_id as string,
      from,
      to: rec.to.map((e) => personId(e, mine)),
      ...(rec.cc.length ? { cc: rec.cc.map((e) => personId(e, mine)) } : {}),
      at: new Date(r.occurred_at as string),
      body: paragraphs((r.text as string | null) ?? ''),
      ...((r.meta as { attachments?: string[] }).attachments?.length ? { attachments: (r.meta as { attachments: string[] }).attachments } : {}),
    };
  });
  const last = rows[rows.length - 1]!;
  const lastIn = [...rows].reverse().find((r) => r.direction !== 'out');
  const inInbox = rows.some((r) => (r.labels as string[]).includes('INBOX'));
  const unread = rows.some((r) => (r.labels as string[]).includes('UNREAD'));
  const participants = [...new Set(['me', ...messages.flatMap((m) => [m.from, ...m.to, ...(m.cc ?? [])])])];
  const subject = (rows[0]!.subject as string).replace(/^(re|fwd?):\s*/i, '') || '(no subject)';
  const snippet = paragraphs(((lastIn ?? last).text as string | null) ?? '')[0]!.replace(/\s+/g, ' ').slice(0, 160);

  const existing = state.threads.find((t) => (t as LiveThread).ext?.threadKey === threadKey && (t as LiveThread).ext?.connectionId === conn.id) as LiveThread | undefined;
  if (!existing) {
    // Only mail that is in the inbox becomes something to work on. The rest stays searchable in the item store.
    if (!inInbox) return state;
    const thread: LiveThread = {
      id: threadIdFor(conn, threadKey),
      subject,
      box: 'inbox',
      participants,
      messages,
      unread,
      ask: snippet || subject,
      suggestion: suggest({ sender: (lastIn ?? last).sender as string, subject: (lastIn ?? last).subject as string, text: ((lastIn ?? last).text as string | null) ?? '', labels: (lastIn ?? last).labels as string[] }),
      ext: { threadKey, connectionId: conn.id, people, ...(conn.toolkit === 'outlook' ? { app: 'outlook' as const } : {}) },
    };
    return { ...state, threads: [thread, ...state.threads] };
  }

  const known = new Set(existing.messages.map((m) => m.id));
  const arrived = messages.filter((m) => !known.has(m.id));
  if (!arrived.length && existing.messages.length === messages.length) return state;
  // Messages Timmy sent that sync hasn't returned yet stay until their real copy arrives.
  const stored = new Set(messages.map((m) => m.id));
  const local = existing.messages.filter((m) => !stored.has(m.id) && m.from === 'me' && Date.now() - new Date(m.at).getTime() < 10 * 60_000);
  // A message from the mailbox's own address is the person's (a copy to self, a draft the provider returned), not a reply.
  const reply = arrived.some((m) => m.from !== 'me' && m.from !== `mail:${mine}`);
  // The wait ends when the person it was on answers. Someone else writing on the thread (an out-of-office, a
  // colleague copied in) brings it back to the inbox but the wait, and any nudge, stay.
  const answered = !!existing.waiting && arrived.some((m) => m.from === existing.waiting!.on);
  // A nudge is dropped only while it is still exactly what Timmy wrote; one the person edited or dictated is theirs.
  const dropNudge = answered && existing.draft?.kind === 'nudge' && !!existing.ext?.nudge?.hash && existing.ext.nudge.hash === draftHash(existing.draft);
  const next: LiveThread = {
    ...existing,
    participants: [...new Set([...existing.participants, ...participants])],
    messages: [...messages, ...local].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()),
    ext: { ...existing.ext, threadKey, connectionId: conn.id, people: { ...existing.ext?.people, ...people } },
    // A reply brings a thread back to the inbox, whatever it was waiting on.
    ...(reply
      ? {
          box: 'inbox' as const,
          unread: true,
          ask: snippet || existing.ask,
          suggestion: suggest({ sender: (lastIn ?? last).sender as string, subject: (lastIn ?? last).subject as string, text: ((lastIn ?? last).text as string | null) ?? '', labels: (lastIn ?? last).labels as string[] }),
          ...(answered ? { waiting: undefined } : {}),
          ...(dropNudge ? { draft: undefined } : {}),
          history: [...(existing.history ?? []), { at: new Date(), text: dropNudge ? 'A reply arrived, so the nudge Timmy drafted was dropped' : 'A reply arrived' }],
        }
      : {}),
  };
  return { ...state, threads: state.threads.map((t) => (t.id === existing.id ? next : t)) };
}

/* ───────────── New mail ───────────── */

/** One new message from a trigger. Fetches the whole thread so the stored copy is complete. */
export async function ingestThread(workspaceId: string, connectionId: string, threadKey: string, phase: Phase = 'sync', seed?: Record<string, unknown>): Promise<number> {
  const conn = await connectionById(workspaceId, connectionId);
  const box = conn && mailboxFor(conn.toolkit);
  if (!conn || !box || conn.status !== 'active') return 0;
  const fetched = await box.thread(workspaceId, conn, threadKey, phase);
  // If the thread can't be fetched, the message the event itself carried is better than nothing, when it carried one.
  const carried = fetched ? null : seed ? box.seed(seed) : null;
  // With neither, the job fails and the queue tries again; the nightly check is the net under that.
  if (!fetched && !carried) throw new Error('the thread could not be fetched');
  const list = fetched ?? [carried!];
  if (!list.length) return 0;
  // The whole thread was just fetched, so its labels are fresh: what the person did to it in the mailbox itself
  // (archived it, labelled it, read it) is picked up here as well.
  const states = fetched ? await box.statesOf(workspaceId, conn, fetched, phase).catch(() => null) : null;
  return mutate(workspaceId, 'sync', async (tx, loaded) => {
    const stored = await storeMessages(tx, loaded.state, workspaceId, conn, list);
    if (!states) return { state: stored.state, result: stored.fresh };
    // Taking the mail in comes first. If picking up the change fails, the mail is still stored and the next look tries again.
    await tx.query('savepoint mailbox_changes');
    try {
      const followed = await followMailbox(tx, stored.state, workspaceId, conn, states, lookedAtFrom());
      return { state: followed.state, result: stored.fresh };
    } catch (err) {
      await tx.query('rollback to savepoint mailbox_changes');
      log.warn('could not pick up what changed in the mailbox', { workspaceId, connectionId, error: (err as Error).message });
      return { state: stored.state, result: stored.fresh };
    }
  });
}

/**
 * Stores a batch of messages and brings the screens up to date with them: each thread they belong
 * to is rebuilt, and mail to or from a lead is noted on the lead. Every way mail arrives (a trigger,
 * the first backfill, the nightly check) ends here, so they can't disagree about what a message means.
 */
async function storeMessages(tx: Tx, state: State, workspaceId: string, conn: ConnectionRow, list: MailMessage[]): Promise<{ state: State; fresh: number; threads: number }> {
  const fresh: MailMessage[] = [];
  // A draft sitting in the mailbox is not mail that was sent or received; it is left out.
  list = list.filter((m) => !m.labels.includes('DRAFT'));
  for (const m of list) if ((await upsertMessage(tx, workspaceId, conn, m)).inserted) fresh.push(m);
  const keys = [...new Set(list.map((m) => m.threadKey))];
  let next = state;
  for (const key of keys) next = await projectThread(tx, next, workspaceId, conn, key);
  // [automations] New mail may start automations. Their runs are recorded here, in the transaction that stores the mail.
  next = await onMailStored(tx, noteLeadMail(next, fresh), workspaceId, conn, fresh);
  return { state: next, fresh: fresh.length, threads: keys.length };
}

/* ───────────── Mail to and from leads ───────────── */

/**
 * Cold email is sent by hand from the person's mail app, so this is how Timmy
 * finds out: a message in Sent addressed to a lead means the lead was
 * contacted, and a message from a lead's address is a reply. Who a message is
 * from is the parsed address, never the display name.
 */
export function noteLeadMail(state: State, fresh: MailMessage[]): State {
  if (!fresh.length) return state;
  // A lead with no address in a usable form is skipped here: one bad record must never stop mail being stored.
  const byEmail = new Map(Object.values(state.out.leads).filter((l) => typeof l.email === 'string').map((l) => [l.email.toLowerCase(), l]));
  if (!byEmail.size) return state;
  const have = new Set(state.out.messages.map((m) => m.id));
  let leads = state.out.leads;
  const added: State['out']['messages'] = [];
  for (const m of fresh) {
    const sentByUser = m.labels.includes('SENT');
    const who = sentByUser ? [...m.to, ...m.cc] : [parseSender(m.from).email];
    for (const email of who) {
      const lead = byEmail.get(email);
      const id = `gm-${m.id}-${lead?.id}`;
      if (!lead || have.has(id)) continue;
      have.add(id);
      added.push({ id, lead: lead.id, channel: 'email', dir: sentByUser ? 'out' : 'in', at: m.at, subject: m.subject, body: paragraphs(m.text).join('\n\n'), ...(sentByUser ? { status: 'sent' as const } : {}) });
      const cur = leads[lead.id]!;
      const status = sentByUser ? (cur.status === 'new' || cur.status === 'queued' ? 'contacted' : cur.status) : ['new', 'queued', 'contacted'].includes(cur.status) ? 'replied' : cur.status;
      leads = { ...leads, [lead.id]: { ...cur, status, ...(sentByUser ? {} : { unread: true }) } as typeof cur };
    }
  }
  if (!added.length) return state;
  // An email the person sent to a lead by hand is the draft Timmy wrote for them, now gone out: the draft leaves the list.
  const sentTo = new Set(added.filter((m) => m.dir === 'out').map((m) => m.lead));
  const kept = state.out.messages.filter((m) => !(m.status === 'draft' && sentTo.has(m.lead)));
  return { ...state, out: { ...state.out, leads, messages: [...kept, ...added] } };
}

/* ───────────── Backfill ───────────── */

export interface BackfillProgress {
  pages: number;
  messages: number;
  threads: number;
  done: boolean;
}

/**
 * Pages back through the mailbox, newest first, storing every message.
 * `days` is how far back to go. Returns after `maxPages` so a job can checkpoint and continue.
 */
export async function backfillMail(workspaceId: string, connectionId: string, opts: { days?: number; maxPages?: number; pageSize?: number; pauseMs?: number } = {}): Promise<BackfillProgress> {
  const conn = await connectionById(workspaceId, connectionId);
  const box = conn && mailboxFor(conn.toolkit);
  if (!conn || !box || conn.status !== 'active') return { pages: 0, messages: 0, threads: 0, done: true };
  const days = opts.days ?? config.backfillFastDays;
  // Outlook returns whole HTML bodies, so its pages are kept smaller.
  const pageSize = opts.pageSize ?? (conn.toolkit === 'outlook' ? 25 : 50);
  const kind = `backfill-${days}`;
  const cur = await withWorkspace({ workspaceId }, async (tx) => {
    await tx.query(`insert into sync_cursor (connection_id, workspace_id, kind, state, started_at) values ($1, $2, $3, 'running', now()) on conflict (connection_id, kind) do nothing`, [connectionId, workspaceId, kind]);
    return (await tx.query('select cursor, state, items_done from sync_cursor where connection_id = $1 and kind = $2', [connectionId, kind])).rows[0] as { cursor: { pageToken?: string; after?: number }; state: string; items_done: number };
  });
  if (cur.state === 'done') return { pages: 0, messages: cur.items_done, threads: 0, done: true };
  const after = cur.cursor.after ?? Math.floor((Date.now() - days * 86400_000) / 1000);
  let pageToken = cur.cursor.pageToken;
  const progress: BackfillProgress = { pages: 0, messages: 0, threads: 0, done: false };

  while (progress.pages < (opts.maxPages ?? 40)) {
    let page;
    try {
      page = await box.page(workspaceId, conn, { since: new Date(after * 1000), pageToken, pageSize, phase: 'backfill' });
    } catch (err) {
      log.warn('backfill page failed', { workspaceId, connectionId, error: (err as Error).message });
      throw err;
    }
    const list = page.messages;
    const next = page.next;
    progress.pages++;
    progress.messages += list.length;
    await mutate(workspaceId, 'backfill', async (tx, loaded) => {
      const { state, threads } = await storeMessages(tx, loaded.state, workspaceId, conn, list);
      progress.threads += threads;
      await tx.query(`update sync_cursor set cursor = $3::jsonb, items_done = items_done + $4, state = $5, finished_at = case when $5 = 'done' then now() else null end, updated_at = now() where connection_id = $1 and kind = $2`, [
        connectionId,
        kind,
        JSON.stringify({ pageToken: next, after }),
        list.length,
        next ? 'running' : 'done',
      ]);
      return { state, result: null };
    });
    pageToken = next;
    if (!pageToken) {
      progress.done = true;
      break;
    }
    // Stay well under the provider's per-user quota.
    if (opts.pauseMs ?? 1500) await new Promise((r) => setTimeout(r, opts.pauseMs ?? 1500));
  }
  return progress;
}

/* ───────────── The nightly check ───────────── */

/**
 * Triggers can be missed: a webhook lost, a trigger that could not be created. Once a night the last
 * days of the mailbox are fetched again and anything not yet stored is taken in. Storing is by the
 * provider's message id, so mail that did arrive the first time is left as it is.
 */
export async function reconcileMail(workspaceId: string, connectionId: string, opts: { days?: number; maxPages?: number; pageSize?: number } = {}): Promise<{ pages: number; messages: number; fresh: number }> {
  const conn = await connectionById(workspaceId, connectionId);
  const out = { pages: 0, messages: 0, fresh: 0 };
  const box = conn && mailboxFor(conn.toolkit);
  if (!conn || !box || conn.status !== 'active') return out;
  const since = new Date(Date.now() - (opts.days ?? 2) * 86400_000);
  let pageToken: string | undefined;
  do {
    const page = await box.page(workspaceId, conn, { since, pageToken, pageSize: opts.pageSize ?? (conn.toolkit === 'outlook' ? 25 : 50), phase: 'reconcile' });
    const list = page.messages;
    out.pages++;
    out.messages += list.length;
    if (list.length) {
      out.fresh += await mutate(workspaceId, 'sync', async (tx, loaded) => {
        const stored = await storeMessages(tx, loaded.state, workspaceId, conn, list);
        return { state: stored.state, result: stored.fresh };
      });
    }
    pageToken = page.next;
  } while (pageToken && out.pages < (opts.maxPages ?? 10));
  return out;
}
