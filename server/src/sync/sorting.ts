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
import { mutate, readState } from '../state/mutate';
import { BOX_WORDS, filingProposal } from './labels';

/* ───────────── The first sort, by plain code ───────────── */

/** Senders that are a system, whatever they send: by how the address starts, or by a no-reply anywhere in it. */
const SYSTEM_SENDER = /^(no-?reply|do-?not-?reply|notifications?|notify|mailer(-daemon)?|bounces?|postmaster|alerts?|digest|marketing|billing|receipts?|invoices?|orders?|newsletters?)([+.@_-]|$)|(no-?reply|do-?not-?reply|notifications?|mailer-daemon)/i;
/** Senders that are often a system but sometimes a small business's own person: a guess, never filed by the rule. */
const MAYBE_SYSTEM = /^(news|updates?|accounts?|hello|team|info|support)([+.@_-]|$)/i;
/** Addresses for a role, not a person, even when they don't look like a system. */
const ROLE = /^(sales|support|team|info|contact|admin|office|careers|jobs|press|founders|partners|ops|accounts|billing|marketing|hello|hi|events|community|editors?|crew|members?|customers?|service|care|success|growth|news|updates?)$/i;
const RECEIPT = /\b(receipt|invoice|payment (received|confirmation)|order (confirmation|#|number)|your order|statement is ready|has shipped)\b/i;
/** A reply to an invitation. A new invitation is not one: it asks the person to answer. */
const CALENDAR_REPLY = /^(accepted|declined|tentative(ly accepted)?):/i;
const INVITATION = /^(invitation|updated invitation)( from [^:]+)?:/i;
/** A tool asking the person to do something: sign, review, answer a mention or an assignment, approve. */
const TOOL_ASKS = /\b(sent you (a|the) documents? to|review and sign|please (docu)?sign|awaiting your (signature|approval|review)|needs your (approval|review|signature|input)|requested your review|review requested|mentioned you|assigned (you|to you)|invited you to|has invited you|action required|approval (needed|required)|waiting (for|on) your (approval|response|reply))\b/i;
/** A person asking the person something. */
const PERSON_ASKS = /\b(could|can|would) you\b|\bplease (reply|respond|send|confirm|let me know|review|approve|advise|share|sign)\b|\blet me know\b|\bare you (free|available)\b/i;
/** Selling: a sale, a discount, an event to sign up for. */
const MARKETING = /\b(\d{1,2}% off|sale|deals?|discounts?|save up to|offer ends|shop now|free shipping|limited time|webinar|save your seat|register now|black friday|cyber monday|promo code|coupons?|flash sale|savings)\b/i;
/** A newsletter: by its sender (a publishing service, or an address that says so), or by the reading links one carries. */
const NEWSLETTER_SENDER = /(^|[.@])(substack\.com|beehiiv\.com|ghost\.io|convertkit\.com|buttondown\.email)$|^newsletters?[+.@_-]/i;
const NEWSLETTER_TEXT = /\b(view (this email )?in (your )?browser|read (it )?(in (the )?app|online)|this week in|issue #?\d+)\b/i;

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
 * Where a new thread probably belongs, decided without a model. Plain code is only sure of what is plainly junk or a
 * newsletter: a promotion, a receipt, a calendar reply, a notice from a system, a publication. Anything that might need
 * the person (a person asking something, a tool asking them to sign, review or answer a mention, an invitation, a
 * person writing through a sending tool) is left for the model to read, and the person to place.
 */
export function suggest(last: { sender: string; subject: string; text: string; labels: string[] }): NonNullable<Thread['suggestion']> {
  const sender = last.sender.toLowerCase();
  const local = sender.split('@')[0] ?? '';
  const head = last.text.slice(0, 1500);
  const category = (name: string) => last.labels.includes(`CATEGORY_${name}`);
  const bulk = category('FORUMS') || /\bunsubscribe\b|list-unsubscribe/i.test(last.text);
  const system = SYSTEM_SENDER.test(local);
  const maybeSystem = MAYBE_SYSTEM.test(local);
  // An address shaped like a person's own: "dana", "kim.ortega", "ryan.b". Not a role, not a system.
  const personal = !system && !maybeSystem && !ROLE.test(local) && /^[a-z]+([._-]?[a-z]+){0,2}\d{0,2}$/.test(local) && local.length <= 30;
  const selling = MARKETING.test(last.subject) || MARKETING.test(head);
  const newsletter = !selling && (NEWSLETTER_SENDER.test(sender) || (bulk && !system && (NEWSLETTER_TEXT.test(last.subject) || NEWSLETTER_TEXT.test(last.text))));
  const leaveIt = (): NonNullable<Thread['suggestion']> => ({ box: 'follow-up', confidence: 'low', effort: 'quick', reason: REASONS.person, provisional: true });

  if (CALENDAR_REPLY.test(last.subject)) return { box: 'archived', confidence: 'high', reason: REASONS.calendar };
  // Something may be asked of the person: an invitation, a tool asking them to act, or a person asking (not a sales pitch
  // from a mailing list). The model reads it.
  if (INVITATION.test(last.subject) && !system) return leaveIt();
  if (TOOL_ASKS.test(last.subject) || TOOL_ASKS.test(head)) return leaveIt();
  if (PERSON_ASKS.test(head) && !selling && (!bulk || personal)) return leaveIt();
  // Gmail's own tabs: what it puts under Promotions or Social is junk to most people at work, unless it is a newsletter.
  if (category('PROMOTIONS') || category('SOCIAL')) return newsletter && !category('SOCIAL') ? { box: 'read-through', confidence: 'high', reason: REASONS.newsletter } : { box: 'archived', confidence: 'high', reason: REASONS.promotion };
  if (RECEIPT.test(last.subject)) return { box: 'archived', confidence: 'high', reason: REASONS.receipt };
  if (bulk) {
    if (selling) return { box: 'archived', confidence: 'high', reason: REASONS.promotion };
    if (newsletter) return { box: 'read-through', confidence: 'high', reason: REASONS.newsletter };
    // A tool's digest or notice: Slack, Notion, a build that passed.
    if (system) return { box: 'archived', confidence: 'high', reason: REASONS.system };
    // A person writing through a sending tool: a client in HubSpot, or a cold pitch. Only reading it tells which.
    if (personal) return leaveIt();
    return { box: 'read-through', confidence: 'medium', reason: REASONS.newsletter };
  }
  if (system) return { box: 'archived', confidence: 'high', reason: REASONS.system };
  if (maybeSystem) return { box: 'archived', confidence: 'medium', reason: REASONS.system };
  // Gmail's Updates tab from an address that isn't a system (an investor update, a team's report): the model reads it.
  return leaveIt();
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
/** How many threads one write looks at: a sweep of a large inbox is several writes, each a modest change on screen. */
const SWEEP_CHUNK = 150;

const waitingForPlainCode = (t: Thread) => t.box === 'inbox' && byPlainCode(t.suggestion) && !!t.ext?.threadKey && !!t.ext.connectionId;
const sameSuggestion = (a: Thread['suggestion'], b: Thread['suggestion']) => a?.box === b?.box && a?.confidence === b?.confidence && a?.reason === b?.reason;

export async function sortWhatIsWaiting(workspaceId: string, chunk = SWEEP_CHUNK): Promise<Sorted['moved']> {
  const ids = (await readState(workspaceId)).state.threads.filter(waitingForPlainCode).map((t) => t.id);
  const total: Sorted['moved'] = {};
  for (let i = 0; i < ids.length; i += chunk) {
    const part = new Set(ids.slice(i, i + chunk));
    const moved = await mutate(workspaceId, 'sort', async (tx, loaded) => {
      const waiting = loaded.state.threads.filter((t) => part.has(t.id) && waitingForPlainCode(t));
      if (!waiting.length) return { result: {} as Sorted['moved'] };
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
        // A thread waiting for the model keeps waiting for it; only a sure answer replaces its guess. One whose
        // suggestion is unchanged is left as it is, so nothing is rewritten for nothing.
        if ((t.suggestion?.provisional && s.provisional) || sameSuggestion(t.suggestion, s)) continue;
        again.set(t.id, { ...t, suggestion: s });
      }
      const resorted: State = again.size ? { ...loaded.state, threads: loaded.state.threads.map((t) => again.get(t.id) ?? t) } : loaded.state;
      const sorted = await autoSort(tx, loaded, resorted, { ids: part, mailbox: false });
      return { state: sorted.state === loaded.state ? undefined : sorted.state, result: sorted.moved };
    });
    for (const [box, n] of Object.entries(moved) as [Box, number][]) total[box] = (total[box] ?? 0) + n;
  }
  const n = Object.values(total).reduce((a, b) => a + (b ?? 0), 0);
  if (n) {
    const text = `Timmy sorted ${n} email${n === 1 ? '' : 's'} on its own: ${sortedWords(total)}. They stay as they were in the mailbox; mail that arrives from now on is filed there too.`;
    await mutate(workspaceId, 'sort', async (_tx, loaded) => ({ state: { ...loaded.state, activity: [{ id: newId('act'), at: new Date(), kind: 'triage' as const, text }, ...loaded.state.activity] }, result: null }));
  }
  return total;
}

/* ───────────── Sorting again after the rules improved ───────────── */

/** Which version of plain code's rules a workspace's mail was last sorted by. Raised when the rules change materially. */
export const SORTING_VERSION = 2;
const FILED_BY_RULE = 'on its own, as the rule to sort mail automatically says.';
/** The most threads one correction sends to the model, newest first, and how far back it looks for them. */
const RESORT_READS = 60;
const RESORT_READ_DAYS = 14;

export interface Resorted {
  /** Suggestions in Triage redone by the new rules. */
  resuggested: number;
  /** Threads the old rule had filed by itself that came back to Triage, because they may need the person. */
  backToTriage: number;
  /** Threads the old rule had sent to Read Through that the new rules archive (digests, notices). */
  archived: number;
  /** Threads to give the model's first read, newest first. */
  toRead: string[];
}

/**
 * Sorts a workspace's mail again by the current plain-code rules, once after they change (SORTING_VERSION):
 *   - a suggestion in Triage that plain code made is made again;
 *   - a thread the rule to sort automatically filed by itself, and nobody has moved since, is checked again: if the
 *     new rules would leave it for the model, it comes back to Triage; if they archive what was sent to Read Through,
 *     it is archived.
 * Threads the model read, and anything a person placed, keep what they have. Inside Timmy only: the mailbox is not
 * written to. The caller queues the model's read for `toRead`.
 */
export async function resortForNewRules(workspaceId: string): Promise<Resorted> {
  return mutate<Resorted>(workspaceId, 'sort', async (tx, loaded) => {
    const out: Resorted = { resuggested: 0, backToTriage: 0, archived: 0, toRead: [] };
    const filedByRule = (t: Thread) => (t.box === 'read-through' || t.box === 'archived') && t.history?.at(-1)?.text.includes(FILED_BY_RULE);
    const candidates = loaded.state.threads.filter((t) => !!t.ext?.threadKey && !!t.ext.connectionId && ((t.box === 'inbox' && byPlainCode(t.suggestion) && !t.suggestion?.provisional) || filedByRule(t)));
    if (!candidates.length) return { result: out };
    const { rows } = await tx.query(
      `select distinct on (i.connection_id, i.thread_key) i.connection_id, i.thread_key, i.sender, i.subject, i.labels, b.text
       from item i left join item_body b on b.item_id = i.id
       where i.workspace_id = $1 and i.kind = 'message' and coalesce(i.direction, 'in') <> 'out' and i.thread_key = any($2::text[])
       order by i.connection_id, i.thread_key, i.occurred_at desc`,
      [workspaceId, [...new Set(candidates.map((t) => t.ext!.threadKey!))]],
    );
    const newest = new Map(rows.map((r) => [`${r.connection_id as string}:${r.thread_key as string}`, r]));
    const now = new Date();
    const changed = new Map<string, Thread>();
    for (const t of candidates) {
      const r = newest.get(`${t.ext!.connectionId}:${t.ext!.threadKey}`);
      if (!r) continue;
      const s = suggest({ sender: r.sender as string, subject: (r.subject as string) ?? '', text: (r.text as string | null) ?? '', labels: (r.labels as string[]) ?? [] });
      if (t.box === 'inbox') {
        if (sameSuggestion(t.suggestion, s)) continue;
        changed.set(t.id, { ...t, suggestion: s });
        out.resuggested++;
        continue;
      }
      // Filed by the old rule. Still where the new rules would file it with certainty: leave it.
      if (s.box === t.box && s.confidence === 'high' && !s.provisional) continue;
      if (t.box === 'read-through' && s.box === 'archived' && s.confidence === 'high') {
        changed.set(t.id, { ...t, box: 'archived', history: [...(t.history ?? []), { at: now, text: `Timmy moved this to the archive: its sorting rules improved. ${s.reason}` }] });
        out.archived++;
        continue;
      }
      changed.set(t.id, { ...t, box: 'inbox', suggestion: s, history: [...(t.history ?? []), { at: now, text: 'Timmy put this back in Triage: its sorting rules improved, and it may need you.' }] });
      out.backToTriage++;
    }
    const at = (t: Thread) => new Date(t.messages.at(-1)?.at ?? 0).getTime();
    const since = Date.now() - RESORT_READ_DAYS * 86400_000;
    out.toRead = [...changed.values()]
      .filter((t) => t.box === 'inbox' && t.suggestion?.provisional && at(t) >= since)
      .sort((a, b) => at(b) - at(a))
      .slice(0, RESORT_READS)
      .map((t) => t.id);
    await audit(tx, workspaceId, { actor: 'timmy', action: 'sorting.resorted', detail: { version: SORTING_VERSION, resuggested: out.resuggested, backToTriage: out.backToTriage, archived: out.archived, toRead: out.toRead.length } });
    if (!changed.size) return { result: out };
    const words = [out.backToTriage ? `${out.backToTriage} back to Triage because they may need you` : '', out.archived ? `${out.archived} digests and notices archived` : '', out.resuggested ? `${out.resuggested} suggestions in Triage redone` : ''].filter(Boolean).join(', ');
    const state: State = {
      ...loaded.state,
      threads: loaded.state.threads.map((t) => changed.get(t.id) ?? t),
      activity: [{ id: newId('act'), at: now, kind: 'triage' as const, text: `Timmy sorted your mail again with better rules: ${words}. Nothing changed in your mailbox.` }, ...loaded.state.activity],
    };
    return { state, result: out };
  });
}

/** Whether a workspace's mail was already sorted again by the current rules. */
export async function resortedAlready(tx: Tx, workspaceId: string): Promise<boolean> {
  const { rows } = await tx.query(`select 1 from audit_log where workspace_id = $1 and action = 'sorting.resorted' and (detail->>'version')::int >= $2 limit 1`, [workspaceId, SORTING_VERSION]);
  return rows.length > 0;
}
