/**
 * Picking up what the person changed in Gmail or Outlook itself: a thread archived there, put back in the
 * inbox, given one of Timmy's labels, read, or deleted.
 *
 * Timmy remembers, for each thread a mailbox has shown it, what the mailbox showed last: in the inbox or not,
 * which of Timmy's three labels (categories, in Outlook) it carried, unread or not, deleted or not. Each new
 * look is compared with that. Only a difference counts as something done in the mailbox, and only a difference
 * is applied. So a thread whose place in Timmy differs from the mailbox for another reason (sending was
 * switched off when it was moved, or the mailbox refused the filing) stays where the person put it.
 *
 * What is picked up is applied to Timmy's state directly. Nothing here proposes an effect or calls the
 * mailbox, so a change that came from the mailbox is never written back to it.
 *
 * A message can arrive already marked with one of Timmy's labels the person never put there: Outlook keeps
 * categories on mail sent within one company, so a colleague who also files with Timmy sends "Timmy Follow Up"
 * mail; a Gmail filter can label mail as it comes in. So what each message carries the first time Timmy sees it is
 * recorded (`mailbox_message_seen`), and that mark is left out of what the thread is read as carrying: it is never
 * acted on. Only a change on a message Timmy has already seen can move a thread. Once Timmy itself files the
 * thread, the marks on its messages are Timmy's doing, and the record of them is cleared.
 */
import type { Box, Thread } from '../../../src/data/types';
import type { State } from '../../../src/state/store';
import { config } from '../config';
import type { Tx } from '../db/pool';
import { newId } from '../lib/ids';
import { LABEL_NAMES, isBox, type Labelled } from './labels';
import { mailboxFor, type MessageState } from './mailbox';
import type { ConnectionRow } from './tools';

/** Timmy's three labelled places, in the order one is chosen when a thread carries several. */
const PLACES = Object.keys(LABEL_NAMES) as Labelled[];
const PLACE_WORDS: Record<Labelled, string> = { 'follow-up': 'Follow Up', waiting: 'Waiting', 'read-through': 'Read Through' };

/**
 * The first moment mail is looked at from: a few days back from now. The periodic look and the look taken when a
 * thread is ingested both use it, so both read a thread from the same messages.
 */
export const lookedAtFrom = (days = config.mailboxCheck.days) => new Date(Date.now() - days * 86400_000);

/* ───────────── What the mailbox shows ───────────── */

/** What a mailbox shows for one thread at one moment. */
export interface Seen {
  /** At least one message of the thread is in the inbox. */
  inInbox: boolean;
  /** Which of Timmy's places the newest received message is marked with. A reply that arrives later carries none. */
  labels: Labelled[];
  unread: boolean;
  /** Every received message is in the trash or in spam. */
  gone: boolean;
  /** For the words only: it went to spam, not the trash. */
  spam?: boolean;
  /** For the words only: the messages looked at were deleted, but older ones Timmy has stored may still be there. */
  inPart?: boolean;
}

const thrownAway = (m: MessageState) => m.labels.includes('TRASH') || m.labels.includes('SPAM');
/**
 * A message that says where its thread sits. The person's own copies in Sent do not: a reply sent today to mail
 * from last week would otherwise read as "nothing of this thread is in the inbox". Two of their own messages do
 * count: one that sits in the inbox (sent to themselves, or put there when Timmy filed the thread in Gmail), and
 * one that carries one of Timmy's labels (a thread they started, filed under Waiting, then archived in Gmail).
 */
const received = (m: MessageState) => !m.mine || m.labels.includes('INBOX') || m.filedAs.length > 0;

/**
 * What the labels on a thread's messages say about the thread. Null when they say nothing: only drafts, or only
 * the person's own messages, were looked at.
 */
export function seenIn(messages: MessageState[]): Seen | null {
  const real = messages.filter((m) => !m.labels.includes('DRAFT'));
  const live = real.filter((m) => !thrownAway(m));
  const liveReceived = live.filter(received).sort((a, b) => a.at.getTime() - b.at.getTime());
  if (!liveReceived.length) {
    const lost = real.filter((m) => thrownAway(m) && received(m));
    if (!lost.length) return null;
    return { inInbox: false, labels: [], unread: false, gone: true, spam: lost.every((m) => m.labels.includes('SPAM')) };
  }
  const newest = liveReceived[liveReceived.length - 1]!;
  return {
    inInbox: live.some((m) => m.labels.includes('INBOX')),
    labels: PLACES.filter((p) => newest.filedAs.includes(p)),
    unread: liveReceived.some((m) => m.labels.includes('UNREAD')),
    gone: false,
  };
}

interface Looked {
  seen: Seen;
  /** Every message of the thread the mailbox listed, to tell whether one Timmy has stored was left out. */
  ids: Set<string>;
}

/** Groups a listing by thread and reads each thread. Only messages received after `since` count, in every path, so two looks at the same mailbox agree. */
export function threadsSeen(messages: MessageState[], since: Date): Map<string, Looked> {
  const byThread = new Map<string, MessageState[]>();
  const listed = new Map<string, Set<string>>();
  for (const m of messages) {
    if (!listed.has(m.threadKey)) listed.set(m.threadKey, new Set());
    listed.get(m.threadKey)!.add(m.id);
    if (m.at.getTime() <= since.getTime()) continue;
    if (!byThread.has(m.threadKey)) byThread.set(m.threadKey, []);
    byThread.get(m.threadKey)!.push(m);
  }
  const out = new Map<string, Looked>();
  for (const [key, list] of byThread) {
    const seen = seenIn(list);
    if (seen) out.set(key, { seen, ids: listed.get(key)! });
  }
  return out;
}

/* ───────────── What it showed last, and Timmy's own filings since ───────────── */

/** What the mailbox showed for a thread the last time Timmy took it into account (a row of `mailbox_seen`). */
interface Last {
  in_inbox: boolean;
  labels: Labelled[];
  /** The one place the thread counted as filed under. */
  label: Labelled | null;
  unread: boolean;
  gone: boolean;
  seen_at: Date;
}

const same = (last: Last, seen: Seen) => last.gone === seen.gone && (seen.gone || (last.in_inbox === seen.inInbox && last.unread === seen.unread && last.labels.join() === seen.labels.join()));

interface Filing {
  target: string;
  status: 'approved' | 'executing' | 'uncertain' | 'completed';
  box: string | null;
  /** Still on its way, or arrived so recently that the mailbox may not show it yet. */
  pending: boolean;
  at: Date | null;
}

interface Compared {
  threads: Map<string, Looked>;
  last: Map<string, Last>;
  filings: Map<string, Filing[]>;
  /** Whether a thread needs a closer look: the mailbox shows something else than last time, or Timmy filed it since. */
  open: (key: string) => boolean;
  /** What to write to `mailbox_message_seen`: messages seen for the first time, and records Timmy's own filing has cleared. */
  firstSight: { message_id: string; labels: Labelled[] }[];
}

/**
 * A message with no record of its first sight, in a thread whose last look came this long after the message arrived,
 * was seen then, before such records were kept: its marks were taken into account at that look, so none count as
 * found on arrival. The margin allows for a listing that lags a little behind the mail that has just arrived.
 */
const RECORDS_LAG_MS = 5 * 60_000;

/**
 * Takes the marks a message carried when Timmy first saw it out of what it is read as carrying, so a mark someone
 * else put there before Timmy saw the message never moves a thread. Returns the listing as it is to be read, and
 * what is to be recorded: each message seen for the first time with the marks it came with, and each record that
 * Timmy's own filing of the thread, completed since, has cleared (from then on the marks are Timmy's doing).
 */
async function withoutFirstMarks(tx: Tx, conn: ConnectionRow, messages: MessageState[], since: Date, last: Map<string, Last>, filings: Map<string, Filing[]>): Promise<{ messages: MessageState[]; firstSight: Compared['firstSight'] }> {
  const counted = messages.filter((m) => m.at.getTime() > since.getTime() && !m.labels.includes('DRAFT'));
  if (!counted.length) return { messages, firstSight: [] };
  const { rows } = await tx.query('select message_id, labels, seen_at from mailbox_message_seen where connection_id = $1 and message_id = any($2::text[])', [conn.id, counted.map((m) => m.id)]);
  const recorded = new Map(rows.map((r) => [r.message_id as string, r as { labels: Labelled[]; seen_at: Date }]));
  const firstSight: Compared['firstSight'] = [];
  const out = messages.map((m) => {
    if (m.at.getTime() <= since.getTime() || m.labels.includes('DRAFT')) return m;
    const row = recorded.get(m.id);
    let marks: Labelled[];
    if (row) {
      // Timmy filed the thread after this message was first seen: whatever it carries now is that filing's doing, or the person's since.
      const refiled = (filings.get(m.threadKey) ?? []).some((f) => f.status === 'completed' && !!f.at && f.at.getTime() > new Date(row.seen_at).getTime());
      // A mark it came with that has since been taken off is forgotten, so putting it back on is a change like any other.
      marks = refiled ? [] : row.labels.filter((p) => m.filedAs.includes(p));
      if (marks.length !== row.labels.length) firstSight.push({ message_id: m.id, labels: marks });
    } else {
      const was = last.get(m.threadKey);
      marks = was && m.at.getTime() < new Date(was.seen_at).getTime() - RECORDS_LAG_MS ? [] : m.filedAs;
      firstSight.push({ message_id: m.id, labels: marks });
    }
    return marks.length ? { ...m, filedAs: m.filedAs.filter((p) => !marks.includes(p)) } : m;
  });
  return { messages: out, firstSight };
}

/**
 * Reads a listing and sets it beside what the mailbox showed last and beside Timmy's own filings of the same
 * threads. A filing counts as on its way while it is approved or running, while its outcome is still being
 * checked (the gateway checks for half an hour), and until the settle time after it completed has passed.
 */
async function compare(tx: Tx, workspaceId: string, conn: ConnectionRow, listed: MessageState[], since: Date): Promise<Compared | null> {
  const keys = [...new Set(listed.filter((m) => m.at.getTime() > since.getTime()).map((m) => m.threadKey))];
  if (!keys.length) return null;
  const seenRows = await tx.query('select thread_key, in_inbox, labels, label, unread, gone, seen_at from mailbox_seen where connection_id = $1 and thread_key = any($2::text[])', [conn.id, keys]);
  const last = new Map(seenRows.rows.map((r) => [r.thread_key as string, r as Last]));
  const filed = await tx.query(
    `select target, status, payload->>'box' as box, coalesce(completed_at, executing_at) as at,
            (status in ('approved', 'executing')
              or (status = 'uncertain' and executing_at > now() - interval '30 minutes')
              or (status = 'completed' and completed_at > now() - make_interval(secs => $4))) as pending
     from effect
     where workspace_id = $1 and kind = 'mail.modify' and payload->>'connectionId' = $2 and target = any($3::text[])
       and status in ('approved', 'executing', 'uncertain', 'completed') and created_at > now() - make_interval(days => $5)`,
    // A filing can wait a day for its turn, so they are looked for from a little before the days of mail looked at.
    [workspaceId, conn.id, keys, config.mailboxCheck.settleSeconds, Math.ceil(config.mailboxCheck.days) + 2],
  );
  const filings = new Map<string, Filing[]>();
  for (const r of filed.rows as Filing[]) {
    if (!filings.has(r.target)) filings.set(r.target, []);
    filings.get(r.target)!.push(r);
  }
  const { messages, firstSight } = await withoutFirstMarks(tx, conn, listed, since, last, filings);
  const threads = threadsSeen(messages, since);
  const open = (key: string) => {
    const was = last.get(key);
    if (!was || !same(was, threads.get(key)!.seen)) return true;
    // The mailbox shows what it showed before, but Timmy filed the thread in between: the person may have undone that there.
    return (filings.get(key) ?? []).some((f) => f.pending || (!!f.at && f.at.getTime() > was.seen_at.getTime()));
  };
  return { threads, last, filings, open, firstSight };
}

/** Writes what `withoutFirstMarks` found to record: each message's first sight once, and records Timmy's filing cleared. */
async function recordFirstSight(tx: Tx, workspaceId: string, conn: ConnectionRow, firstSight: Compared['firstSight']) {
  if (!firstSight.length) return;
  await tx.query(
    `insert into mailbox_message_seen (connection_id, workspace_id, message_id, labels, seen_at)
     select $1, $2, r.message_id, array(select jsonb_array_elements_text(r.labels)), now()
     from jsonb_to_recordset($3::jsonb) as r(message_id text, labels jsonb)
     on conflict (connection_id, message_id) do update set labels = excluded.labels`,
    [conn.id, workspaceId, JSON.stringify(firstSight)],
  );
}

/**
 * Whether a listing gives anything to do. The periodic check asks this before it locks the workspace, so a look
 * that finds nothing new costs two reads and changes nothing. A message seen for the first time counts: what it
 * came with has to be recorded before a later look can tell what was done to it.
 */
export async function anythingNew(tx: Tx, workspaceId: string, conn: ConnectionRow, messages: MessageState[], since: Date): Promise<boolean> {
  const c = await compare(tx, workspaceId, conn, messages, since);
  return !!c && (c.firstSight.length > 0 || [...c.threads.keys()].some(c.open));
}

/**
 * What the mailbox last showed, allowing for a filing Timmy wrote there since. The write is the newest knowledge
 * of where the thread sits: a difference from it is the person's doing, and the write itself is not.
 * 'unknown' when the newest write was never confirmed, so there is nothing sound to compare with.
 */
function afterOwnFiling(last: Last, filings: Filing[]): Last | 'unknown' {
  const newest = filings.filter((f) => f.at && f.at.getTime() > last.seen_at.getTime()).sort((a, b) => b.at!.getTime() - a.at!.getTime())[0];
  if (!newest) return last;
  if (newest.status !== 'completed' || !isBox(newest.box)) return 'unknown';
  const label = PLACES.find((p) => p === newest.box) ?? null;
  return { ...last, in_inbox: newest.box !== 'archived', labels: label ? [label] : [], label };
}

/* ───────────── Applying a change ───────────── */

/**
 * A thread in its new place. The rules are those of a move made in Timmy (the reducer's `moveThread`): a thread
 * put under Waiting gets a wait if it has none; one taken out of Waiting loses it, unless it was archived, where
 * the wait is kept so it is there again if the thread comes back. Two things differ. The unread mark is not
 * touched: it follows the mailbox, not the move. And Timmy's suggestion is kept, not cleared, so a thread the
 * person puts back in the mailbox's inbox comes back with it. Every thread in Timmy's inbox shows a suggestion,
 * so one that comes back without (it had been sorted in Timmy) gets a plain guess that says what happened.
 * A draft, a decision card and everything else stay as they are.
 */
function placed(t: Thread, box: Box, now: Date, why: string): Thread {
  const next: Thread = { ...t, box };
  if (box === 'follow-up' && t.suggestion?.effort) next.effort = t.suggestion.effort;
  if (box === 'waiting' && !t.waiting) next.waiting = { on: t.participants.find((p) => p !== 'me') ?? 'me', item: 'A reply', since: now };
  if (t.box === 'waiting' && box !== 'waiting' && box !== 'archived') next.waiting = undefined;
  if (box === 'inbox' && !t.suggestion) next.suggestion = { box: 'follow-up', confidence: 'low', reason: `${why}. Timmy is guessing where it belongs.` };
  return next;
}

export interface Followed {
  /** Threads that changed place in Timmy. */
  moved: number;
  /** Threads whose unread mark changed. */
  marked: number;
  /** Threads that left Timmy's screens because they were deleted or marked as spam. */
  removed: number;
  /** Threads left alone because one of Timmy's own filings is on its way or only just arrived. */
  leftAlone: number;
  /** Threads whose listing lacked a message Timmy has stored, so nothing was concluded about them. */
  unclear: number;
  /** Threads that are back in the inbox after having left the screens. The caller shows them again. */
  back: string[];
}

/**
 * Compares a fresh look at some of a mailbox's threads with what it showed last, and applies what the person
 * changed there to Timmy's state. `messages` must hold every message of each thread it mentions that was
 * received after `since`; a thread for which Timmy has stored a message the listing lacks is left for the next
 * look. Runs inside the caller's workspace transaction, with the workspace locked; the caller commits the state.
 */
export async function followMailbox(tx: Tx, state: State, workspaceId: string, conn: ConnectionRow, messages: MessageState[], since: Date): Promise<{ state: State; result: Followed }> {
  const result: Followed = { moved: 0, marked: 0, removed: 0, leftAlone: 0, unclear: 0, back: [] };
  const c = await compare(tx, workspaceId, conn, messages, since);
  if (!c) return { state, result };
  // Recorded before anything else, whatever this look goes on to conclude: from here on, these marks are the ones the messages came with.
  await recordFirstSight(tx, workspaceId, conn, c.firstSight);
  const { threads, last, filings } = c;
  let todo = [...threads.keys()].filter(c.open);
  if (!todo.length) return { state, result };

  // A listing can leave a message out (the provider skips one it could not fetch; a new one arrived after the
  // listing was made). Half a thread can look archived when it is not, so such a thread waits for the next look.
  const stored = await tx.query(`select thread_key, external_id from item where workspace_id = $1 and connection_id = $2 and kind = 'message' and occurred_at > $3 and thread_key = any($4::text[])`, [workspaceId, conn.id, since, todo]);
  const unclear = new Set<string>();
  for (const r of stored.rows) if (!threads.get(r.thread_key as string)!.ids.has(r.external_id as string)) unclear.add(r.thread_key as string);
  result.unclear = unclear.size;
  todo = todo.filter((key) => !unclear.has(key));

  // Taking a thread off the screens is the one thing here a later look can't simply put right, so it needs more
  // than the last days' messages: every received message Timmy has stored for the thread must be in the trash
  // or in spam. If an older one is not known to be, the thread is only archived.
  const deleted = todo.filter((key) => threads.get(key)!.seen.gone);
  if (deleted.length) {
    const alive = await tx.query(`select distinct thread_key from item where workspace_id = $1 and connection_id = $2 and kind = 'message' and direction = 'in' and thread_key = any($3::text[]) and not (labels && array['TRASH', 'SPAM'])`, [workspaceId, conn.id, deleted]);
    // A message in spam says what the provider thought of that message, not what the person did with the thread:
    // a stranger's reply can land in spam on its own. So when the only recent messages of a thread with older mail
    // are in spam, nothing is concluded about it. Messages the person put in the trash still count.
    const unsure = new Set<string>();
    for (const r of alive.rows) {
      const key = r.thread_key as string;
      if (threads.get(key)!.seen.spam) unsure.add(key);
      else threads.get(key)!.seen = { inInbox: false, labels: [], unread: false, gone: false, inPart: true };
    }
    todo = todo.filter((key) => !unsure.has(key)).filter(c.open);
  }
  if (!todo.length) return { state, result };

  const app = mailboxFor(conn.toolkit)?.name ?? 'the mailbox';
  const mark = conn.toolkit === 'outlook' ? 'category' : 'label';
  const now = new Date();
  const shown = new Map(state.threads.filter((t) => t.ext?.threadKey && t.ext.connectionId === conn.id).map((t) => [t.ext!.threadKey!, t]));
  /** A thread's new version, or null when it leaves the screens. */
  const edits = new Map<string, Thread | null>();
  const log: State['activity'] = [];
  const note = (text: string, threadId?: string) => log.unshift({ id: newId('act'), at: now, kind: 'move', text, ...(threadId ? { threadId } : {}) });
  const remember: { thread_key: string; in_inbox: boolean; labels: Labelled[]; label: Labelled | null; unread: boolean; gone: boolean }[] = [];

  for (const key of todo) {
    const seen = threads.get(key)!.seen;
    const mine = filings.get(key) ?? [];
    // Timmy's own filing wins for a moment. Nothing is remembered either, so what the person did is still there to pick up once the filing settled.
    if (mine.some((f) => f.pending)) {
      result.leftAlone++;
      continue;
    }
    const t = shown.get(key);
    const first = last.get(key);

    if (seen.gone) {
      // Timmy never deletes mail, so a thread whose messages are all in the trash or in spam was put there by the person.
      if (t) {
        edits.set(t.id, null);
        note(`“${t.subject}” was ${seen.spam ? 'marked as spam' : 'deleted'} in ${app}, so it is no longer shown in Timmy`);
        result.removed++;
      }
      remember.push({ thread_key: key, in_inbox: false, labels: [], label: null, unread: false, gone: true });
      continue;
    }
    // The first look at a thread is what later looks are compared with. So is the first look after it came back from the trash.
    if (!first || first.gone) {
      if (first?.gone && !t && seen.inInbox) result.back.push(key);
      remember.push({ thread_key: key, in_inbox: seen.inInbox, labels: seen.labels, label: seen.labels[0] ?? null, unread: seen.unread, gone: false });
      continue;
    }

    const was = afterOwnFiling(first, mine);
    let label: Labelled | null;
    let target: Box | null = null;
    let line = '';
    let entry = '';
    if (was === 'unknown') {
      // One of Timmy's filings here was never confirmed, so the difference may be its doing. The place is left alone.
      label = seen.labels[0] ?? null;
    } else {
      // A label that was just put on wins over one that was already there; otherwise the place it counted as stays.
      const put = seen.labels.filter((l) => !was.labels.includes(l));
      label = put[0] ?? (was.label && seen.labels.includes(was.label) ? was.label : (seen.labels[0] ?? null));
      const subject = t?.subject ?? '';
      if (was.in_inbox && !seen.inInbox) {
        target = 'archived';
        line = seen.inPart ? `Its latest messages were deleted in ${app}, so it was archived here` : `Archived in ${app}`;
        entry = seen.inPart ? `The latest messages of “${subject}” were deleted in ${app}, so it was archived` : `“${subject}” was archived in ${app}`;
      } else if (label !== was.label) {
        target = label ?? (seen.inInbox ? 'inbox' : 'archived');
        line = label ? `Filed under ${PLACE_WORDS[label]} in ${app}` : seen.inInbox ? `Timmy’s ${mark} was removed in ${app}, so this is back in the inbox` : `Archived in ${app}`;
        entry = label ? `“${subject}” was filed under ${PLACE_WORDS[label]} in ${app}` : seen.inInbox ? `Timmy’s ${mark} was removed from “${subject}” in ${app}, so it is back in the inbox` : `“${subject}” was archived in ${app}`;
      } else if (!was.in_inbox && seen.inInbox && t?.box === 'archived') {
        target = label ?? 'inbox';
        line = label ? `Filed under ${PLACE_WORDS[label]} in ${app}` : `Moved back to the inbox in ${app}`;
        entry = label ? `“${subject}” was filed under ${PLACE_WORDS[label]} in ${app}` : `“${subject}” was moved back to the inbox in ${app}`;
      }
    }
    if (t) {
      let next = t;
      if (target && target !== t.box) {
        next = { ...placed(t, target, now, line), history: [...(t.history ?? []), { at: now, text: line }] };
        note(entry, t.id);
        result.moved++;
      }
      if (seen.unread !== first.unread && !!t.unread !== seen.unread) {
        next = { ...next, unread: seen.unread };
        result.marked++;
      }
      if (next !== t) edits.set(t.id, next);
    }
    remember.push({ thread_key: key, in_inbox: seen.inInbox, labels: seen.labels, label, unread: seen.unread, gone: false });
  }

  if (remember.length) {
    await tx.query(
      `insert into mailbox_seen (connection_id, workspace_id, thread_key, in_inbox, labels, label, unread, gone, seen_at)
       select $1, $2, r.thread_key, r.in_inbox, array(select jsonb_array_elements_text(r.labels)), r.label, r.unread, r.gone, now()
       from jsonb_to_recordset($3::jsonb) as r(thread_key text, in_inbox boolean, labels jsonb, label text, unread boolean, gone boolean)
       on conflict (connection_id, thread_key) do update
         set in_inbox = excluded.in_inbox, labels = excluded.labels, label = excluded.label, unread = excluded.unread, gone = excluded.gone, seen_at = excluded.seen_at`,
      [conn.id, workspaceId, JSON.stringify(remember)],
    );
  }
  if (!edits.size) return { state, result };
  const kept = state.threads.flatMap((t) => (edits.has(t.id) ? (edits.get(t.id) ? [edits.get(t.id)!] : []) : [t]));
  return { state: { ...state, threads: kept, activity: [...log, ...state.activity] }, result };
}
