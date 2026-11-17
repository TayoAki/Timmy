/**
 * The periodic look at a mailbox for what the person changed there (the rules are in mailbox-changes.ts).
 *
 * One look lists the messages received in the last few days with the labels they carry now, and compares each
 * thread with what the mailbox showed last. It costs one provider call for a page of messages, two for a busy
 * mailbox, and never more, however many threads there are: nothing is asked per thread. Mail older than the
 * days looked at, or beyond the two pages, is left as it is.
 *
 * When it runs: with the nightly check, in the morning run, and while Timmy is in use: when someone opens the app
 * (at most every five minutes per mailbox, however often the page is reloaded), and then every ten minutes for as
 * long as a tab is open and someone has done something in Timmy in the last half hour. A workspace nobody is using is not looked at in between: nobody would see the difference before the next
 * of those, and a tab left open overnight must not go on costing provider calls.
 */
import { config } from '../config';
import { withWorkspace, type Tx } from '../db/pool';
import { enqueueSoon } from '../jobs/jobs';
import { log } from '../lib/log';
import { mutate } from '../state/mutate';
import { projectThread } from './ingest';
import { MAIL_TOOLKITS, mailboxFor, type MessageState } from './mailbox';
import { anythingNew, followMailbox, lookedAtFrom, type Followed } from './mailbox-changes';
import { connectionById, type ConnectionRow } from './tools';

export interface Checked extends Followed {
  /** False when the mailbox is not connected, or was looked at too recently. */
  ran: boolean;
  /** Provider calls made listing the mailbox. */
  calls: number;
  messages: number;
}

const nothing = (): Checked => ({ ran: false, calls: 0, messages: 0, moved: 0, marked: 0, removed: 0, leftAlone: 0, unclear: 0, back: [] });

/** The labels a listing showed are the newest knowledge of where each stored message sits, so the stored copy is brought up to date. */
async function rememberLabels(tx: Tx, workspaceId: string, conn: ConnectionRow, listed: MessageState[]) {
  const fresh = listed.filter((m) => !m.labels.includes('DRAFT')).map((m) => ({ id: m.id, labels: m.labels }));
  if (!fresh.length) return;
  await tx.query(
    `update item i set labels = v.labels, updated_at = now()
     from (select e->>'id' as id, array(select jsonb_array_elements_text(e->'labels')) as labels from jsonb_array_elements($3::jsonb) e) v
     where i.workspace_id = $1 and i.connection_id = $2 and i.kind = 'message' and i.external_id = v.id and i.labels is distinct from v.labels`,
    [workspaceId, conn.id, JSON.stringify(fresh)],
  );
}

/**
 * Looks at one mailbox once. `minGapSeconds` skips the look when the mailbox was looked at more recently than
 * that, so several open tabs, or several servers, cannot multiply the calls.
 */
export async function checkMailbox(workspaceId: string, connectionId: string, opts: { minGapSeconds?: number; days?: number; pageSize?: number; maxPages?: number } = {}): Promise<Checked> {
  const conn = await connectionById(workspaceId, connectionId);
  const box = conn && mailboxFor(conn.toolkit);
  if (!conn || !box || conn.status !== 'active') return nothing();
  // The claim and the test of the gap are one statement, so two looks asked for together cannot both go ahead.
  const claimed = await withWorkspace({ workspaceId }, async (tx) => {
    const res = await tx.query(
      `insert into sync_cursor (connection_id, workspace_id, kind, state, started_at) values ($1, $2, 'changes', 'idle', now())
       on conflict (connection_id, kind) do update set started_at = now(), updated_at = now()
       where sync_cursor.started_at is null or sync_cursor.started_at <= now() - make_interval(secs => $3)`,
      [conn.id, workspaceId, opts.minGapSeconds ?? 0],
    );
    return (res.rowCount ?? 0) > 0;
  });
  if (!claimed) return nothing();

  const since = lookedAtFrom(opts.days);
  // A page of labels without bodies is small, so pages are large (see the setting for why Gmail's is the smaller).
  const pageSize = opts.pageSize ?? config.mailboxCheck.pageSize[conn.toolkit] ?? 250;
  const maxPages = opts.maxPages ?? config.mailboxCheck.maxPages;
  const listed: MessageState[] = [];
  let calls = 0;
  let pageToken: string | undefined;
  do {
    const page = await box.recentStates(workspaceId, conn, { since, pageToken, pageSize, phase: 'changes' });
    calls++;
    listed.push(...page.messages);
    pageToken = page.next;
  } while (pageToken && calls < maxPages);
  // When there was more mail than the pages hold, what was listed ends at its oldest message, and a thread is
  // read from there on: older messages were not looked at, so nothing is concluded from their absence.
  const from = pageToken && listed.length ? new Date(Math.max(since.getTime(), Math.min(...listed.map((m) => m.at.getTime())))) : since;
  const base = { ran: true, calls, messages: listed.length };

  if (!(await withWorkspace({ workspaceId }, (tx) => anythingNew(tx, workspaceId, conn, listed, from)))) return { ...nothing(), ...base };
  const followed = await mutate(workspaceId, 'mailbox', async (tx, loaded) => {
    await rememberLabels(tx, workspaceId, conn, listed);
    const out = await followMailbox(tx, loaded.state, workspaceId, conn, listed, from);
    let state = out.state;
    // A thread that was deleted and is in the inbox again is shown again, built from its stored messages like any inbox thread.
    for (const key of out.result.back) state = await projectThread(tx, state, workspaceId, conn, key);
    // What the mailbox showed for threads that have long left the days looked at is of no more use.
    await tx.query(`delete from mailbox_seen where connection_id = $1 and seen_at < now() - interval '30 days' and thread_key <> all($2::text[])`, [conn.id, [...new Set(listed.map((m) => m.threadKey))]]);
    // The same for what each message carried when first seen: a look only ever reads the last few days of mail.
    await tx.query(`delete from mailbox_message_seen where connection_id = $1 and seen_at < now() - interval '30 days' and message_id <> all($2::text[])`, [conn.id, listed.map((m) => m.id)]);
    return { state, result: out.result };
  });
  // Counts only: nothing of a thread is written to the log.
  if (followed.moved || followed.marked || followed.removed || followed.back.length) log.info('picked up what changed in the mailbox', { workspaceId, connectionId, moved: followed.moved, marked: followed.marked, removed: followed.removed, shownAgain: followed.back.length });
  return { ...followed, ...base };
}

/**
 * Looks at every connected mailbox of a workspace. With `idleSeconds`, only when the workspace was used within
 * that time (someone did something in the app, or asked Timmy something in the chat): a tab that is merely left
 * open does not go on costing provider calls.
 */
export async function checkWorkspaceMailboxes(workspaceId: string, opts: { minGapSeconds?: number; idleSeconds?: number } = {}): Promise<Checked[]> {
  const boxes = await withWorkspace({ workspaceId }, async (tx) => {
    if (opts.idleSeconds) {
      const used = await tx.query(
        `select 1 where exists (select 1 from command where workspace_id = $1 and at > now() - make_interval(secs => $2))
                    or exists (select 1 from run where workspace_id = $1 and attended and created_at > now() - make_interval(secs => $2))`,
        [workspaceId, opts.idleSeconds],
      );
      if (!used.rows.length) return [];
    }
    return (await tx.query(`select id from connection where workspace_id = $1 and status = 'active' and toolkit = any($2::text[])`, [workspaceId, MAIL_TOOLKITS])).rows as { id: string }[];
  });
  const out: Checked[] = [];
  for (const b of boxes) out.push(await checkMailbox(workspaceId, b.id, { minGapSeconds: opts.minGapSeconds }));
  return out;
}

/** Per workspace, on this server: when the app loaded its state and no look has been asked for since, and when a look was last asked for. */
const loadedAt = new Map<string, number>();
const askedAt = new Map<string, number>();
const forget = (map: Map<string, number>, now: number) => {
  if (map.size > 5000) for (const [id, at] of map) if (now - at > config.mailboxCheck.everySeconds * 1000) map.delete(id);
};

/**
 * The app loads its whole state when a page opens, and only then: a stream that drops and reconnects does not.
 * So this marks someone really opening Timmy, which is the moment a fresh look at the mailbox is worth most.
 */
export function appLoaded(workspaceId: string) {
  const now = Date.now();
  forget(loadedAt, now);
  loadedAt.set(workspaceId, now);
}

/**
 * The look asked for when the app is opened is made only if the mailbox was not looked at in this long. Each
 * reload opens the app again, so a shorter gap let someone who reloads cause a look a minute.
 */
export const OPENED_GAP_SECONDS = 300;

/**
 * Called while a tab is open on a workspace, as often as the caller likes (when its stream opens, and on every
 * ping). It queues a look in two cases. The app was opened since the last look was asked for: the look is made
 * unless the mailbox was looked at in the last five minutes. Otherwise, at most every few minutes: that look is made
 * only while the workspace is in use (someone did something in Timmy within `idleSeconds`) and the mailbox was
 * not looked at within `everySeconds`, so a tab that is merely left open, several tabs, or several servers do
 * not multiply provider calls. Both conditions are checked in the database when the look runs.
 */
export function checkWhileOpen(workspaceId: string) {
  const { everySeconds, idleSeconds } = config.mailboxCheck;
  const now = Date.now();
  // The mark is used up by the first call after the app loaded, so one opening asks for one look.
  const opened = loadedAt.delete(workspaceId);
  if (!opened && now - (askedAt.get(workspaceId) ?? 0) < (everySeconds / 2) * 1000) return;
  forget(askedAt, now);
  askedAt.set(workspaceId, now);
  // A look asked for every five minutes and allowed every ten runs every ten; the minute less absorbs the queue's own delay.
  const data = opened ? { workspaceId, gap: OPENED_GAP_SECONDS } : { workspaceId, gap: Math.max(0, everySeconds - 60), idle: idleSeconds };
  enqueueSoon('mail.changes', data, { singletonKey: `changes:${workspaceId}` });
}
