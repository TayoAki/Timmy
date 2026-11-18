/**
 * Sorting mail: the first sort by plain code, and sorting without asking once an owner or admin has said Timmy may.
 *
 * Plain code looks at every new thread. Mail that is plainly automated (a promotion, a receipt, a calendar reply, a
 * system notice, a newsletter) gets a suggestion it is sure of; mail a person wrote is left for the model to read and
 * the person to place.
 *
 * "Sort mail automatically" is a rule: a policy row (kind mail.modify, scope {sort: "automatic"}) that names the
 * owner or admin who switched it on and when. While it is on:
 *   - Inside Timmy, every thread plain code is sure of is filed where it suggested, as it arrives, and the ones
 *     already waiting in Triage are filed when the rule is switched on.
 *   - In the mailbox, only mail that arrived after the rule was switched on is filed, each filing an effect the rule
 *     approves. Switching it on never rewrites months of existing mail in Gmail or Outlook in one go.
 *   - Nothing a person wrote is filed by the rule, and nothing the model suggested: those wait in Triage.
 */
import type { Box, Thread } from '../../../src/data/types';
import type { State } from '../../../src/state/store';
import type { Tx } from '../db/pool';
import { newId } from '../lib/ids';
import { audit, propose } from '../gateway/gateway';
import type { Loaded } from '../state/docs';
import { mutate } from '../state/mutate';
import { BOX_WORDS, filingProposal } from './labels';

/* ───────────── The first sort, by plain code ───────────── */

/** Senders that are a system, whatever they send. */
const SYSTEM_SENDER = /^(no-?reply|do-?not-?reply|notifications?|notify|mailer(-daemon)?|bounces?|postmaster|alerts?|digest|marketing|billing|receipts?|invoices?|orders?|newsletters?)([+.@_-]|$)/i;
/** Senders that are often a system but sometimes a small business's own person: a guess, never filed by the rule. */
const MAYBE_SYSTEM = /^(news|updates?|accounts?|hello|team|info|support)([+.@_-]|$)/i;
const RECEIPT = /\b(receipt|invoice|payment (received|confirmation)|order (confirmation|#|number)|your order|statement is ready|has shipped)\b/i;
const CALENDAR_REPLY = /^(accepted|declined|tentative(ly accepted)?|updated invitation|invitation):/i;

export const REASONS = {
  calendar: 'A calendar reply. Your calendar already has it.',
  receipt: 'A receipt or order notice. Nothing to answer.',
  promotion: 'A promotion or a social network notice. Nothing to answer.',
  newsletter: 'A newsletter or bulk mailing. Read it when you have time.',
  system: 'An automated notice from a system, not a person.',
  person: 'A person wrote to you. Timmy hasn’t read it closely yet.',
} as const;
const PLAIN = new Set<string>(Object.values(REASONS));

/**
 * Where a new thread probably belongs, decided without a model: mail that is plainly automated gets a confident
 * suggestion, and anything a person wrote is left for the model and the person. The model only looks at what this
 * can't settle.
 */
export function suggest(last: { sender: string; subject: string; text: string; labels: string[] }): NonNullable<Thread['suggestion']> {
  const local = last.sender.split('@')[0] ?? '';
  const category = (name: string) => last.labels.includes(`CATEGORY_${name}`);
  const bulk = category('FORUMS') || /\bunsubscribe\b|list-unsubscribe|view (this email )?in (your )?browser/i.test(last.text);
  if (CALENDAR_REPLY.test(last.subject)) return { box: 'archived', confidence: 'high', reason: REASONS.calendar };
  if (RECEIPT.test(last.subject)) return { box: 'archived', confidence: 'high', reason: REASONS.receipt };
  // Gmail's own tabs: what it puts under Promotions or Social is junk to most people at work.
  if (category('PROMOTIONS') || category('SOCIAL')) return { box: 'archived', confidence: 'high', reason: REASONS.promotion };
  if (bulk) return { box: 'read-through', confidence: 'high', reason: REASONS.newsletter };
  if (SYSTEM_SENDER.test(local)) return { box: 'archived', confidence: 'high', reason: REASONS.system };
  if (MAYBE_SYSTEM.test(local) || category('UPDATES')) return { box: 'archived', confidence: 'medium', reason: REASONS.system };
  return { box: 'follow-up', confidence: 'low', effort: 'quick', reason: REASONS.person, provisional: true };
}

/** A suggestion plain code made (not the model, which reads what a person wrote). */
export const byPlainCode = (s: Thread['suggestion']) => !!s && (s.provisional === true || PLAIN.has(s.reason));

/** A thread still in Triage that the rule files: plain code is sure of it, and it is junk or a newsletter. */
export const sortsItself = (t: Thread): boolean => {
  const s = t.suggestion;
  return t.box === 'inbox' && !!s && !s.provisional && s.confidence === 'high' && PLAIN.has(s.reason) && (s.box === 'archived' || s.box === 'read-through');
};

/* ───────────── The rule ───────────── */

export const AUTO_SORT_SCOPE = { sort: 'automatic' } as const;

export interface AutoSortRule {
  id: string;
  /** When it was switched on. Mail that arrived before this is filed inside Timmy only. */
  since: Date;
  by: string;
}

export async function autoSortRule(tx: Tx, workspaceId: string): Promise<AutoSortRule | null> {
  const { rows } = await tx.query(
    `select id, created_at, created_by from policy where workspace_id = $1 and kind = 'mail.modify' and enabled and scope = $2::jsonb order by created_at desc limit 1`,
    [workspaceId, JSON.stringify(AUTO_SORT_SCOPE)],
  );
  const r = rows[0];
  return r ? { id: r.id as string, since: new Date(r.created_at as string), by: r.created_by as string } : null;
}

/** Switches the rule on or off for a workspace. Only an owner or admin may (the caller checks); it names them. */
export async function setAutoSort(tx: Tx, workspaceId: string, userId: string, on: boolean): Promise<boolean> {
  const current = await autoSortRule(tx, workspaceId);
  if (on === !!current) return false;
  await tx.query(`update policy set enabled = false, updated_at = now() where workspace_id = $1 and kind = 'mail.modify' and enabled and scope = $2::jsonb`, [workspaceId, JSON.stringify(AUTO_SORT_SCOPE)]);
  if (on) {
    const id = newId('pol');
    await tx.query('insert into policy (id, workspace_id, kind, scope, enabled, label, created_by) values ($1, $2, $3, $4::jsonb, true, $5, $6)', [
      id,
      workspaceId,
      'mail.modify',
      JSON.stringify(AUTO_SORT_SCOPE),
      'Sort mail automatically: Timmy files promotions, receipts, notices and newsletters it is sure of. Mail that arrives from now on is filed in the mailbox too.',
      userId,
    ]);
    await audit(tx, workspaceId, { actor: userId, action: 'autosort.switched_on', detail: { rule: id } });
  } else await audit(tx, workspaceId, { actor: userId, action: 'autosort.switched_off', detail: {} });
  return true;
}

/* ───────────── Filing ───────────── */

const lastReceived = (t: Thread) => [...t.messages].reverse().find((m) => m.from !== 'me');

export interface Sorted {
  state: State;
  /** Filed inside Timmy, by where. */
  moved: Partial<Record<Box, number>>;
  /** Of those, how many were also sent to the mailbox to file. */
  filed: number;
}

/**
 * Files the threads the rule covers. `ids` limits it to the threads a batch of mail just touched; without it, every
 * thread in Triage is looked at. A thread goes to the mailbox only when its newest received message arrived after the
 * rule was switched on, and only when `mailbox` is true (new mail arriving, not a sweep of what was already there).
 */
export async function autoSort(tx: Tx, loaded: Loaded, state: State, opts: { ids?: Set<string>; mailbox: boolean }): Promise<Sorted> {
  const out: Sorted = { state, moved: {}, filed: 0 };
  const due = state.threads.filter((t) => (!opts.ids || opts.ids.has(t.id)) && sortsItself(t));
  if (!due.length) return out;
  const rule = await autoSortRule(tx, loaded.workspace.id);
  if (!rule) return out;
  const now = new Date();
  const moved = new Map<string, Thread>();
  for (const t of due) {
    const s = t.suggestion!;
    moved.set(t.id, {
      ...t,
      box: s.box,
      unread: false,
      suggestion: undefined,
      history: [...(t.history ?? []), { at: now, text: `Timmy filed this ${BOX_WORDS[s.box]} on its own, as the rule to sort mail automatically says. ${s.reason}` }],
    });
    out.moved[s.box] = (out.moved[s.box] ?? 0) + 1;
  }
  let next: State = { ...state, threads: state.threads.map((t) => moved.get(t.id) ?? t) };
  if (opts.mailbox) {
    for (const t of moved.values()) {
      const last = lastReceived(t);
      if (!last || new Date(last.at).getTime() < rule.since.getTime()) continue;
      const filing = filingProposal(t, t.box);
      if (!filing) continue;
      const p = await propose(tx, loaded, next, null, {
        ...filing,
        why: 'The rule to sort mail automatically covers it.',
        idempotencyKey: `sort:${t.id}:${last.id}`,
        source: 'rule',
        meta: { ...AUTO_SORT_SCOPE },
      });
      if (p.outcome !== 'blocked') {
        next = p.state;
        out.filed++;
      }
    }
  }
  out.state = next;
  return out;
}

/** What a sweep did, in words: "312 archived and 40 to Read Through". */
export function sortedWords(moved: Sorted['moved']): string {
  const parts = [moved.archived ? `${moved.archived} archived` : '', moved['read-through'] ? `${moved['read-through']} to Read Through` : ''].filter(Boolean);
  return parts.join(' and ');
}

/**
 * When the rule is switched on: the threads already in Triage are sorted again by plain code (from the newest message
 * each received, so what plain code knows now applies to them too) and the ones it is sure of are filed, inside Timmy
 * only. Threads the model read, and threads a person put back in the inbox, keep what they have.
 */
export async function sortWhatIsWaiting(workspaceId: string): Promise<Sorted['moved']> {
  return mutate(workspaceId, 'sort', async (tx, loaded) => {
    const waiting = loaded.state.threads.filter((t) => t.box === 'inbox' && byPlainCode(t.suggestion) && t.ext?.threadKey && t.ext.connectionId);
    if (!waiting.length) return { result: {} };
    const { rows } = await tx.query(
      `select distinct on (i.connection_id, i.thread_key) i.connection_id, i.thread_key, i.sender, i.subject, i.labels, b.text
       from item i left join item_body b on b.item_id = i.id
       where i.workspace_id = $1 and i.kind = 'message' and coalesce(i.direction, 'in') <> 'out' and i.thread_key = any($2::text[])
       order by i.connection_id, i.thread_key, i.occurred_at desc`,
      [workspaceId, [...new Set(waiting.map((t) => t.ext!.threadKey!))]],
    );
    const newest = new Map(rows.map((r) => [`${r.connection_id as string}:${r.thread_key as string}`, r]));
    const again = new Map<string, Thread>();
    for (const t of waiting) {
      const r = newest.get(`${t.ext!.connectionId}:${t.ext!.threadKey}`);
      if (!r) continue;
      const s = suggest({ sender: r.sender as string, subject: (r.subject as string) ?? '', text: (r.text as string | null) ?? '', labels: (r.labels as string[]) ?? [] });
      // A thread waiting for the model keeps waiting for it; only a sure answer replaces its guess.
      if (t.suggestion?.provisional && s.provisional) continue;
      again.set(t.id, { ...t, suggestion: s });
    }
    const resorted: State = { ...loaded.state, threads: loaded.state.threads.map((t) => again.get(t.id) ?? t) };
    const sorted = await autoSort(tx, loaded, resorted, { mailbox: false });
    const n = Object.values(sorted.moved).reduce((a, b) => a + (b ?? 0), 0);
    if (!n) return { state: again.size ? resorted : undefined, result: {} };
    const text = `Timmy sorted ${n} email${n === 1 ? '' : 's'} on its own: ${sortedWords(sorted.moved)}. They stay as they were in the mailbox; mail that arrives from now on is filed there too.`;
    return { state: { ...sorted.state, activity: [{ id: newId('act'), at: new Date(), kind: 'triage' as const, text }, ...sorted.state.activity] }, result: sorted.moved };
  });
}
