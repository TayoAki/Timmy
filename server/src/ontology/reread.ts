/**
 * Reading recent mail for a kind that was just accepted.
 *
 * Before a kind is accepted nothing is read out of the mail for it, so the threads of the last weeks say nothing
 * about it yet. When someone accepts a kind, Timmy goes back over recent threads once, for that kind only:
 *   - bounded: threads with mail from someone else in the 30 days before the kind was accepted, newest first, at
 *     most 25 of them (both are settings); mail that arrives after the accept gets the ordinary read, with the kind in it;
 *   - only threads a person wrote, by the same plain-code test new mail gets (newsletters, receipts, calendar
 *     replies and automated notices are skipped), and not a thread that already shows a thing of this kind;
 *   - budgeted: each thread is one model call counted as work nobody asked for, so it draws on the share of the
 *     monthly limit set aside for reading mail on its own, and the pass stops as soon as that share is used up;
 *   - the same read: the read every new thread gets (its system prompt, its output limit, its effort), told about
 *     this one kind only. Of its answer only the things of this kind are used; the sorting, promises and decisions
 *     it also gives are left alone, because the thread was sorted long ago.
 *
 * What the model returns is held to the thread's own words exactly as on a first read (`noteThings`): a thing is
 * kept only with a sentence that is in a stored message, and a value only when the thread states it.
 *
 * How the pass went is kept on the kind (`tracked_type.reread`), so the review screen can say what was looked at.
 */
import { READ_MAX_TOKENS, READ_SYSTEM } from '../agent/read';
import { untrusted } from '../agent/prompts';
import { config, modelFor } from '../config';
import { withWorkspace } from '../db/pool';
import { jsonObject } from '../lib/json';
import { log } from '../lib/log';
import { BudgetError, complete } from '../providers/model';
import { paragraphs } from '../sync/message';
import { suggest } from '../sync/ingest';
import { kindKey } from './type-text';
import { noteThings, typesForPrompt } from './types';
import type { TrackedField } from '../../../src/live/tracked';

/** What the review screen is told about the pass. */
export interface Reread {
  status: 'reading' | 'done' | 'stopped';
  /** Threads read so far. */
  threads: number;
  /** Things of the kind found in them (new, or new evidence for one already known). */
  found: number;
  days: number;
  /** Why it stopped early, in words for the person. */
  note?: string;
}

/** The route the pass's model calls are reported under, apart from the first read's. */
export const REREAD_ROUTE = 'reread';
/** After this many failed calls in a row the pass gives up; something is wrong beyond one thread. */
const FAILURES_IN_A_ROW = 3;

interface Kind {
  id: string;
  name: string;
  fields: TrackedField[];
  status: string;
  decided_at: Date;
}

async function save(workspaceId: string, typeId: string, r: Reread) {
  await withWorkspace({ workspaceId }, (tx) => tx.query('update tracked_type set reread = $3::jsonb where id = $1 and workspace_id = $2', [typeId, workspaceId, JSON.stringify(r)]));
}

/** Marks the kind as being read for, inside the transaction that accepts it, so the screen says so at once. */
export const reading = (days = config.kindReread.days): Reread => ({ status: 'reading', threads: 0, found: 0, days });

/** The threads to read: newest first, from connected mailboxes, with mail from someone else inside the window. */
async function candidates(workspaceId: string, kind: Kind, days: number, limit: number) {
  return withWorkspace({ workspaceId }, async (tx) => {
    const { rows } = await tx.query(
      `select i.connection_id, i.thread_key, max(i.occurred_at) as last
         from item i join connection c on c.id = i.connection_id
        where i.workspace_id = $1 and i.kind = 'message' and c.status = 'active' and i.direction <> 'out'
          and i.occurred_at >= $2::timestamptz - make_interval(days => $3::int) and i.occurred_at < $2::timestamptz
          and not exists (select 1 from evidence e join entity n on n.id = e.entity_id join item x on x.id = e.item_id
                           where n.type_id = $4 and x.connection_id = i.connection_id and x.thread_key = i.thread_key)
        group by i.connection_id, i.thread_key
        order by last desc
        limit $5`,
      [workspaceId, kind.decided_at, days, kind.id, limit],
    );
    return rows as { connection_id: string; thread_key: string }[];
  });
}

/** One thread as the read sees it: its subject and its last messages, or null when plain code says no person wrote it. */
async function threadFor(workspaceId: string, connectionId: string, threadKey: string) {
  return withWorkspace({ workspaceId }, async (tx) => {
    const { rows } = await tx.query(
      `select i.occurred_at, i.sender, i.subject, i.labels, i.meta, i.direction, b.text
         from item i left join item_body b on b.item_id = i.id
        where i.workspace_id = $1 and i.connection_id = $2 and i.kind = 'message' and i.thread_key = $3
        order by i.occurred_at`,
      [workspaceId, connectionId, threadKey],
    );
    const lastIn = [...rows].reverse().find((r) => r.direction !== 'out');
    if (!lastIn || !suggest({ sender: String(lastIn.sender ?? ''), subject: String(lastIn.subject ?? ''), text: String(lastIn.text ?? ''), labels: (lastIn.labels as string[]) ?? [] }).provisional) return null;
    // As the first read gives it: the last six messages, each body cut at the same length.
    const messages = rows.slice(-6).map((r) => ({
      from: r.direction === 'out' ? 'the user' : ((r.meta as { senderName?: string } | null)?.senderName ?? String(r.sender ?? '')),
      at: new Date(r.occurred_at as string).toISOString(),
      body: paragraphs((r.text as string | null) ?? '').join('\n\n').slice(0, 4000),
    }));
    return { subject: String(rows[0]?.subject ?? '').replace(/^(re|fwd?):\s*/i, '') || '(no subject)', messages };
  });
}

/** Reads recent mail for one accepted kind. Run as a job; running it again only reads threads that still show nothing of the kind. */
export async function rereadForKind(workspaceId: string, typeId: string, opts: { threads?: number; days?: number } = {}): Promise<Reread> {
  const limit = opts.threads ?? config.kindReread.threads;
  const days = opts.days ?? config.kindReread.days;
  const result: Reread = { status: 'reading', threads: 0, found: 0, days };
  const load = () => withWorkspace({ workspaceId }, async (tx) => (await tx.query(`select id, name, fields, status, decided_at from tracked_type where id = $1 and workspace_id = $2`, [typeId, workspaceId])).rows[0] as Kind | undefined);
  let kind = await load();
  if (!kind || kind.status !== 'certified' || !kind.decided_at) return { ...result, status: 'stopped', note: 'This kind is no longer tracked.' };
  const { owner, model } = await withWorkspace({ workspaceId }, async (tx) => {
    const ws = (await tx.query('select owner_name, model_id from workspace where id = $1', [workspaceId])).rows[0];
    return { owner: (ws?.owner_name as string | null) ?? null, model: modelFor(ws?.model_id as string | null) };
  });

  // Up to four times as many threads are looked at as are read, because some turn out to be automated mail.
  const threads = limit > 0 ? await candidates(workspaceId, kind, days, limit * 4) : [];
  let failures = 0;
  for (const t of threads) {
    if (result.threads >= limit) break;
    // Stopped or renamed while the pass ran: it reads for the kind as it is now, or not at all.
    kind = await load();
    if (!kind || kind.status !== 'certified') return finish({ ...result, status: 'stopped', note: 'Tracking was stopped while Timmy was reading.' });
    const thread = await threadFor(workspaceId, t.connection_id, t.thread_key);
    if (!thread) continue;
    let content: string;
    try {
      const res = await complete({
        workspaceId,
        route: REREAD_ROUTE,
        // Nobody asked for this read at this moment: it draws on the share of the limit kept for reading on Timmy's own.
        unattended: true,
        model,
        effort: 'low',
        maxTokens: READ_MAX_TOKENS,
        messages: [
          { role: 'system', content: READ_SYSTEM },
          // The same user turn the first read sends, with this one kind as the only one tracked.
          { role: 'user', content: `The user is ${owner ?? 'the mailbox owner'}. Today is ${new Date().toISOString().slice(0, 10)}.\n\nKinds of thing the user keeps track of, each with its fields:\n${untrusted('types', typesForPrompt([kind]))}\n\n${untrusted('mail', thread)}` },
        ],
      });
      content = res.content;
      failures = 0;
    } catch (e) {
      if (e instanceof BudgetError) return finish({ ...result, status: 'stopped', note: 'Timmy stopped early: the part of this month’s limit kept for reading mail on its own is used up.' });
      log.warn('a thread could not be read again for a kind', { workspaceId, error: (e as Error).message });
      if (++failures >= FAILURES_IN_A_ROW) return finish({ ...result, status: 'stopped', note: 'Timmy stopped early: the model could not be reached.' });
      continue;
    }
    result.threads++;
    const out = jsonObject<{ things?: unknown }>(content);
    // Only things of this kind are used; anything else in the answer is left alone.
    const wanted = kindKey(kind.name);
    const things = (Array.isArray(out.things) ? out.things : []).filter((x) => typeof x === 'object' && x !== null && typeof (x as { kind?: unknown }).kind === 'string' && kindKey((x as { kind: string }).kind) === wanted);
    if (!things.length) continue;
    const kept = await withWorkspace({ workspaceId }, (tx) => noteThings(tx, workspaceId, { threadKey: t.thread_key, connectionId: t.connection_id }, things, []));
    result.found += kept.things;
  }
  return finish({ ...result, status: 'done' });

  async function finish(r: Reread): Promise<Reread> {
    await save(workspaceId, typeId, r);
    if (r.threads) log.info('read recent mail for an accepted kind', { workspaceId, threads: r.threads, found: r.found, status: r.status });
    return r;
  }
}
