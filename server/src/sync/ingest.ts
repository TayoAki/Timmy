/**
 * Mail sync. Messages come in through Composio (a backfill that pages
 * backwards, and a trigger for each new message), are stored as items, and the
 * threads that need attention are projected into the state the screens show.
 */
import type { State } from '../../../src/state/store';
import type { Thread } from '../../../src/data/types';
import { config } from '../config';
import { withWorkspace, type Tx } from '../db/pool';
import { newId } from '../lib/ids';
import { log } from '../lib/log';
import { mutate } from '../state/mutate';
import { callTool, connectionById, type ConnectionRow, type Phase } from './tools';

export interface MailMessage {
  id: string;
  threadKey: string;
  at: Date;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  labels: string[];
  attachments: string[];
}

/* ───────────── Normalizing what Composio returns ───────────── */

const ADDRESS = /[^\s<>,;"']+@[^\s<>,;"']+\.[a-z]{2,}/gi;
export const addresses = (v: unknown): string[] => (Array.isArray(v) ? v.join(', ') : String(v ?? '')).match(ADDRESS)?.map((a) => a.toLowerCase()) ?? [];
/** "Dana Whitfield <dana@acme.com>" → { name: "Dana Whitfield", email: "dana@acme.com" } */
export function parseSender(v: unknown): { name: string; email: string } {
  const s = String(v ?? '');
  // The address is what sits in the last <…>. The display name is free text the sender chose
  // and may itself look like an address ("ceo@corp.com" <mallory@evil.test>), so it is never used as one.
  const angle = [...s.matchAll(/<([^<>]*)>/g)].pop()?.[1];
  const email = (angle !== undefined ? addresses(angle)[0] : addresses(s)[0]) ?? '';
  const name = (angle !== undefined ? s.slice(0, s.lastIndexOf('<')) : '').replace(/["']/g, '').trim();
  return { name: name && name.toLowerCase() !== email ? name.slice(0, 120) : '', email };
}

/** Accepts the fetch tools' camelCase shape and the trigger's snake_case shape. */
export function normalize(raw: Record<string, unknown>): MailMessage | null {
  const id = String(raw.messageId ?? raw.message_id ?? raw.id ?? '');
  if (!id) return null;
  const ts = raw.messageTimestamp ?? raw.message_timestamp ?? raw.internalDate;
  const at = ts ? new Date(/^\d+$/.test(String(ts)) ? Number(ts) : String(ts)) : new Date();
  return {
    id,
    threadKey: String(raw.threadId ?? raw.thread_id ?? id),
    at: Number.isNaN(at.getTime()) ? new Date() : at,
    from: String(raw.sender ?? raw.from ?? ''),
    to: addresses(raw.to),
    cc: addresses(raw.cc),
    subject: String(raw.subject ?? '').trim() || '(no subject)',
    text: String(raw.messageText ?? raw.message_text ?? '').replace(/\u0000/g, ''),
    labels: ((raw.labelIds ?? raw.label_ids ?? []) as string[]).map(String),
    attachments: ((raw.attachmentList ?? raw.attachment_list ?? []) as { filename?: string }[]).map((a) => a?.filename ?? '').filter(Boolean),
  };
}

/** The message without the quoted history under it, as short paragraphs. */
export function paragraphs(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const cut = lines.findIndex((l) => /^On .{5,80} wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(l.trim()) || /^From: .+@.+/.test(l.trim()));
  const kept = (cut > 0 ? lines.slice(0, cut) : lines).filter((l) => !l.trim().startsWith('>'));
  const body = kept.join('\n').trim().slice(0, 20000);
  const parts = body.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts : [''];
}

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
  return { box: 'follow-up', confidence: 'low', effort: 'quick', reason: 'A person wrote to you. Timmy hasn’t read it closely yet.' };
}

/* ───────────── Threads the screens show ───────────── */

type LiveThread = Thread & { ext?: { threadKey?: string; connectionId?: string; people?: Record<string, { name: string; email: string }> } };

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
      id: `g-${threadKey}`,
      subject,
      box: 'inbox',
      participants,
      messages,
      unread,
      ask: snippet || subject,
      suggestion: suggest({ sender: (lastIn ?? last).sender as string, subject: (lastIn ?? last).subject as string, text: ((lastIn ?? last).text as string | null) ?? '', labels: (lastIn ?? last).labels as string[] }),
      ext: { threadKey, connectionId: conn.id, people },
    };
    return { ...state, threads: [thread, ...state.threads] };
  }

  const known = new Set(existing.messages.map((m) => m.id));
  const arrived = messages.filter((m) => !known.has(m.id));
  if (!arrived.length && existing.messages.length === messages.length) return state;
  // Messages Timmy sent that sync hasn't returned yet stay until their real copy arrives.
  const stored = new Set(messages.map((m) => m.id));
  const local = existing.messages.filter((m) => !stored.has(m.id) && m.from === 'me' && Date.now() - new Date(m.at).getTime() < 10 * 60_000);
  const reply = arrived.some((m) => m.from !== 'me');
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
          history: [...(existing.history ?? []), { at: new Date(), text: 'A reply arrived' }],
        }
      : {}),
  };
  return { ...state, threads: state.threads.map((t) => (t.id === existing.id ? next : t)) };
}

/* ───────────── New mail ───────────── */

/** One new message from a trigger. Fetches the whole thread so the stored copy is complete. */
export async function ingestThread(workspaceId: string, connectionId: string, threadKey: string, phase: Phase = 'sync', seed?: Record<string, unknown>): Promise<number> {
  const conn = await connectionById(workspaceId, connectionId);
  if (!conn || conn.status !== 'active') return 0;
  const res = await callTool(workspaceId, connectionId, 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID', { thread_id: threadKey }, phase);
  const raw = res.successful ? ((res.data.messages ?? []) as Record<string, unknown>[]) : seed ? [seed] : [];
  const list = raw.map(normalize).filter((m): m is MailMessage => !!m);
  if (!list.length) return 0;
  return mutate(workspaceId, 'sync', async (tx, loaded) => {
    let fresh = 0;
    for (const m of list) if ((await upsertMessage(tx, workspaceId, conn, m)).inserted) fresh++;
    return { state: await projectThread(tx, loaded.state, workspaceId, conn, threadKey), result: fresh };
  });
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
  if (!conn || conn.status !== 'active') return { pages: 0, messages: 0, threads: 0, done: true };
  const days = opts.days ?? config.backfillFastDays;
  const pageSize = opts.pageSize ?? 50;
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
    const res = await callTool(workspaceId, connectionId, 'GMAIL_FETCH_EMAILS', { query: `after:${after}`, max_results: pageSize, include_payload: false, ...(pageToken ? { page_token: pageToken } : {}) }, 'backfill');
    if (!res.successful) {
      log.warn('backfill page failed', { workspaceId, connectionId, error: res.error });
      throw new Error(res.error ?? 'backfill page failed');
    }
    const list = ((res.data.messages ?? []) as Record<string, unknown>[]).map(normalize).filter((m): m is MailMessage => !!m);
    const next = (res.data.nextPageToken as string | null | undefined) || undefined;
    progress.pages++;
    progress.messages += list.length;
    await mutate(workspaceId, 'backfill', async (tx, loaded) => {
      for (const m of list) await upsertMessage(tx, workspaceId, conn, m);
      let state = loaded.state;
      const keys = [...new Set(list.map((m) => m.threadKey))];
      for (const key of keys) state = await projectThread(tx, state, workspaceId, conn, key);
      progress.threads += keys.length;
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
    // Stay well under Gmail's per-user quota.
    if (opts.pauseMs ?? 1500) await new Promise((r) => setTimeout(r, opts.pauseMs ?? 1500));
  }
  return progress;
}
