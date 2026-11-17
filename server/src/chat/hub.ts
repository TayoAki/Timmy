/**
 * Sends a conversation's new messages to the visitor's open chat window.
 *
 * A message is "shown to the visitor" once it has a place in the conversation's order (`seq`). Each open stream
 * remembers the last place it sent and is given everything after it, so a message is sent once per stream and
 * a stream that reconnects picks up where it stopped. When a message becomes visible the conversation is
 * announced: directly to the streams open on this server, and on a Postgres channel for the other instances.
 */
import { withWorkspace, type Tx } from '../db/pool';
import { log } from '../lib/log';
import { alsoListen } from '../state/hub';

/** A message as the visitor's chat window receives it. Nothing here names a workspace or a teammate. */
export interface VisitorMessage {
  id: string;
  seq: number;
  /** The visitor themself, Timmy, or a person at the business (never which person). */
  from: 'visitor' | 'timmy' | 'person';
  text: string;
  at: string;
  /** For the visitor's own message: the id their chat window gave it. */
  client?: string;
  notice?: 'privacy';
}

export interface VisitorStream {
  workspaceId: string;
  conversationId: string;
  /** The place of the last message this stream was sent. */
  after: number;
  send: (message: VisitorMessage) => void;
  /** Called once, when everything the visitor had missed has been sent. */
  ready?: () => void;
  busy?: boolean;
  again?: boolean;
}

/** What the visitor may see of one conversation after place `after`, oldest first. Scoped to the workspace by the transaction. */
export async function visibleSince(tx: Tx, workspaceId: string, conversationId: string, after: number, limit = 200): Promise<VisitorMessage[]> {
  const { rows } = await tx.query(
    `select id, seq, sender, body, client_id, notice, coalesce(sent_at, created_at) as at from chat_message
     where workspace_id = $1 and conversation_id = $2 and seq is not null and seq > $3 order by seq limit $4`,
    [workspaceId, conversationId, after, limit],
  );
  return rows.map((r) => ({
    id: r.id as string,
    seq: r.seq as number,
    from: r.sender === 'visitor' ? ('visitor' as const) : r.sender === 'timmy' ? ('timmy' as const) : ('person' as const),
    text: r.body as string,
    at: new Date(r.at as Date).toISOString(),
    ...(r.sender === 'visitor' && r.client_id ? { client: r.client_id as string } : {}),
    ...(r.notice === 'privacy' ? { notice: 'privacy' as const } : {}),
  }));
}

const streams = new Map<string, Set<VisitorStream>>();

/** Opens a stream on one conversation and sends what it has missed. Returns the function that closes it. */
export function watch(stream: VisitorStream): () => void {
  if (!streams.has(stream.conversationId)) streams.set(stream.conversationId, new Set());
  streams.get(stream.conversationId)!.add(stream);
  void catchUp(stream).then(() => stream.ready?.());
  return () => {
    const set = streams.get(stream.conversationId);
    set?.delete(stream);
    if (set && !set.size) streams.delete(stream.conversationId);
  };
}

/** Tells the streams open on this server that a conversation has something new. */
export function announce(conversationId: string) {
  for (const s of streams.get(conversationId) ?? []) void catchUp(s);
}

/** The same announcement for other instances. Call inside the transaction that made the message visible. */
export const announceEverywhere = (tx: Tx, conversationId: string) => tx.query('select pg_notify($1, $2)', ['timmy_chat', conversationId]);

async function catchUp(s: VisitorStream) {
  if (s.busy) {
    s.again = true;
    return;
  }
  s.busy = true;
  try {
    do {
      s.again = false;
      const fresh = await withWorkspace({ workspaceId: s.workspaceId }, (tx) => visibleSince(tx, s.workspaceId, s.conversationId, s.after));
      for (const m of fresh) {
        s.send(m);
        s.after = m.seq;
      }
      if (fresh.length) s.again = true;
    } while (s.again);
  } catch (e) {
    log.warn('a visitor’s stream could not catch up', { error: (e as Error).message });
  } finally {
    s.busy = false;
  }
}

// Announcements from other instances arrive on the database connection the app's own stream already listens on.
alsoListen('timmy_chat', announce);
