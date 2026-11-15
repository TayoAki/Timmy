/*
 * The Approvals queue: everything Timmy has prepared that needs your OK before
 * it happens. Email drafts and CRM updates are read from the mail and deals as
 * they are; decisions come from `state.decisions`. Resolve any of them with
 *
 *   dispatch({ type: 'resolve', key: a.key, option: 'send' })
 */
import { BadgeDollarSign, CalendarCheck, Scale, Send, type LucideIcon } from 'lucide-react';
import type { Draft } from '../data/types';
import { money } from '../lib/format';
import type { State } from './store';
import { URGENCY, urgencyOf, urgencyRank, type Urgency, type UrgencyContext, type UrgencyInfo } from './urgency';

export type ApprovalKind = 'email' | 'decision' | 'crm' | 'calendar';

export const APPROVAL_KINDS: Record<ApprovalKind, { label: string; plural: string; icon: LucideIcon; color: string }> = {
  email: { label: 'Email', plural: 'Emails to send', icon: Send, color: 'var(--accent)' },
  decision: { label: 'Decision', plural: 'Decisions', icon: Scale, color: 'var(--c-violet)' },
  crm: { label: 'CRM update', plural: 'CRM updates', icon: BadgeDollarSign, color: 'var(--c-teal)' },
  calendar: { label: 'Invite', plural: 'Calendar invites', icon: CalendarCheck, color: 'var(--c-green)' },
};

export interface ApprovalOption {
  id: string;
  label: string;
  primary?: boolean;
  danger?: boolean;
}

export interface Approval {
  key: string;
  kind: ApprovalKind;
  title: string;
  why: string;
  facts?: [string, string][];
  who?: string;
  thread?: string;
  project?: string;
  due?: Date;
  urgency: UrgencyInfo;
  /** For emails: the draft that will be sent. */
  email?: Draft;
  /** For CRM updates: the change that will be made. */
  change?: { deal: string; stage: string; value: number };
  options: ApprovalOption[];
}

export interface ApprovalRecord {
  id: string;
  at: Date;
  key: string;
  kind: ApprovalKind;
  title: string;
  /** What you chose, e.g. "Sent", "Approve $58", "Discarded". */
  choice: string;
  /** False when you said no (discarded, skipped, waited). */
  approved: boolean;
  thread?: string;
}

const fixed = (level: Urgency, reason: string): UrgencyInfo => ({ level, score: URGENCY[level].rank * 30, reasons: [reason] });

export function openApprovals(s: State): Approval[] {
  const ctx: UrgencyContext = { ws: s.ws, deals: s.deals, rules: s.rules };
  const list: Approval[] = [];

  for (const t of s.threads) {
    if (!t.draft || t.box === 'archived') continue;
    const d = t.draft;
    list.push({
      key: `draft:${t.id}`,
      kind: 'email',
      title: d.subject,
      why: t.ask,
      who: d.to[0],
      thread: t.id,
      project: t.project,
      due: t.box === 'waiting' ? t.waiting?.due : t.due,
      urgency: urgencyOf(t, ctx),
      email: d,
      options: [
        { id: 'send', label: d.trackAs ? 'Send & track' : 'Send', primary: true },
        { id: 'discard', label: 'Discard', danger: true },
      ],
    });
  }

  for (const dec of s.decisions) {
    if (dec.chosen) continue;
    if (dec.whileDraft && !s.threads.find((t) => t.id === dec.thread)?.draft) continue;
    list.push({
      key: `dec:${dec.id}`,
      kind: dec.kind,
      title: dec.title,
      why: dec.why,
      facts: dec.facts,
      who: dec.who,
      thread: dec.thread,
      project: dec.project,
      due: dec.due,
      urgency: fixed(dec.urgency, dec.reason),
      options: dec.options.map((o) => ({ id: o.id, label: o.label, primary: o.primary })),
    });
  }

  // CRM updates Timmy wants to make.
  const bw = s.deals.brightwave;
  if (bw && bw.stage !== 'Closed won' && !s.dismissed.includes('crm:brightwave')) {
    list.push({
      key: 'crm:brightwave',
      kind: 'crm',
      title: `Move Brightwave to Closed won (${money(bw.value)})?`,
      why: 'Elena sent the countersigned order form last night. Timmy will link the signed form to the deal.',
      facts: [
        ['Stage', `${bw.stage} → Closed won`],
        ['Value', money(bw.value)],
      ],
      who: 'elena',
      thread: 'brightwave-signed',
      urgency: fixed('soon', 'Your pipeline numbers are out of date until this is updated'),
      change: { deal: 'brightwave', stage: 'Closed won', value: bw.value },
      options: [
        { id: 'apply', label: 'Update deal', primary: true },
        { id: 'skip', label: 'Not now' },
      ],
    });
  }
  const acme = s.deals.acme;
  const quote = s.threads.find((t) => t.id === 'acme-quote');
  if (acme && quote && quote.box === 'waiting' && acme.stage === 'Negotiation' && !s.dismissed.includes('crm:acme')) {
    const kept = s.decisions.find((x) => x.id === 'acme-price')?.chosen?.option === 'hold';
    const value = kept ? 89280 : 83520;
    list.push({
      key: 'crm:acme',
      kind: 'crm',
      title: `Update Acme to ${money(value)} and Proposal sent?`,
      why: 'You sent Dana the revised quote for 120 seats. The deal still shows the 100-seat value.',
      facts: [
        ['Stage', 'Negotiation → Proposal sent'],
        ['Value', `${money(acme.value)} → ${money(value)}`],
      ],
      who: 'dana',
      thread: 'acme-quote',
      project: 'acme',
      urgency: fixed('soon', 'Keeps the forecast right before the QBR'),
      change: { deal: 'acme', stage: 'Proposal sent', value },
      options: [
        { id: 'apply', label: 'Update deal', primary: true },
        { id: 'skip', label: 'Not now' },
      ],
    });
  }

  // Within a level, decisions come before emails: an email often waits on the decision.
  const order: Record<ApprovalKind, number> = { decision: 0, calendar: 1, crm: 2, email: 3 };
  const due = (a: Approval) => a.due?.getTime() ?? Infinity;
  return list.sort(
    (a, b) =>
      URGENCY[b.urgency.level].rank - URGENCY[a.urgency.level].rank ||
      order[a.kind] - order[b.kind] ||
      urgencyRank(b.urgency) - urgencyRank(a.urgency) ||
      due(a) - due(b),
  );
}
