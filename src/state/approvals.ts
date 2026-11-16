/*
 * The Approvals queue: everything Timmy has prepared that needs your OK before
 * it happens. Email drafts and CRM updates are read from the mail and deals as
 * they are; decisions come from `state.decisions`. Resolve any of them with
 *
 *   dispatch({ type: 'resolve', key: a.key, option: 'send' })
 */
import { BadgeDollarSign, CalendarCheck, Rocket, Scale, Send, type LucideIcon } from 'lucide-react';
import type { Draft, Thread } from '../data/types';
import { money } from '../lib/format';
import type { Route, State } from './store';
import { project } from '../lib/outbound';
import { ctxOf } from './outbound';
import { fmtDay } from '../lib/format';
import { firstName, midSentence } from './ws';
import { URGENCY, urgencyOf, urgencyRank, type Urgency, type UrgencyContext, type UrgencyInfo } from './urgency';

export type ApprovalKind = 'email' | 'decision' | 'crm' | 'calendar' | 'campaign';

export const APPROVAL_KINDS: Record<ApprovalKind, { label: string; plural: string; icon: LucideIcon; color: string }> = {
  email: { label: 'Email', plural: 'Emails to send', icon: Send, color: 'var(--accent)' },
  decision: { label: 'Decision', plural: 'Decisions', icon: Scale, color: 'var(--c-violet)' },
  crm: { label: 'CRM update', plural: 'CRM updates', icon: BadgeDollarSign, color: 'var(--c-teal)' },
  calendar: { label: 'Invite', plural: 'Calendar invites', icon: CalendarCheck, color: 'var(--c-green)' },
  campaign: { label: 'Campaign', plural: 'Campaigns to launch', icon: Rocket, color: 'var(--c-amber)' },
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
  /** Where "Review" goes when the item isn't an email thread. */
  route?: Route;
  openLabel?: string;
  /** What else approving this does, or a reason to look twice. */
  notes?: ApprovalNote[];
}

export interface ApprovalNote {
  tone: 'info' | 'warn';
  text: string;
}

const escapeRe = (x: string) => x.replace(/[$.*+?^{}()|[\]\\]/g, '\\$&');

/** The sheet a draft quotes from has changed under it: "The quote tracker now has…". */
export function staleBasis(s: State, t: Thread): string | null {
  const b = t.draft?.basis;
  if (!b) return null;
  const sheet = s.ws.sheets[b.sheet];
  const v = sheet?.rows[b.row]?.[b.col];
  if (v === undefined || v === '') return null;
  const col = sheet!.columns.find((c) => c.key === b.col);
  const shown = col?.type === 'currency' ? `$${v}` : String(v);
  if (new RegExp(`${escapeRe(shown)}(?![\\d,.])`).test(t.draft!.body)) return null;
  const name = s.ws.files[b.sheet]?.name.split('—').pop()?.trim() ?? 'sheet';
  return `The ${midSentence(name)} now has a ${b.label} of ${shown}, but this email doesn’t. Check the numbers before you send.`;
}

/** What else sending a thread's draft does, and anything to check first. */
export function draftNotes(s: State, t: Thread): ApprovalNote[] {
  const d = t.draft;
  if (!d) return [];
  const out: ApprovalNote[] = [];
  const stale = staleBasis(s, t);
  if (stale) out.push({ tone: 'warn', text: stale });
  const gap = d.body.match(/\[[A-Z][^\]\n]{2,160}\]/)?.[0];
  if (gap) out.push({ tone: 'warn', text: `Fill in ${gap.length > 40 ? `${gap.slice(0, 38)}…]` : gap} before you send. Timmy left it for you rather than guess.` });
  if (/\b(attached|i'?ve attached|please find attached|attaching)\b/i.test(d.body.replace(/’/g, "'")) && !d.attachments?.length)
    out.push({ tone: 'warn', text: 'This says something is attached, but nothing is. Attach it, or change the sentence.' });
  for (const dec of s.decisions) {
    if (!dec.whileDraft || dec.thread !== t.id || dec.chosen) continue;
    const o = dec.options.find((x) => x.primary);
    if (o) out.push({ tone: 'info', text: `Sending this also settles “${dec.title}” as ${o.label}. To choose differently, decide first.` });
  }
  const sib = d.alsoAsks ? s.threads.find((x) => x.id === d.alsoAsks!.thread) : undefined;
  if (sib?.waiting && sib.draft?.kind === 'nudge') {
    out.push({ tone: 'info', text: `This also asks ${firstName(sib.waiting.on)} for the ${midSentence(sib.waiting.item)}, so sending it drops the separate nudge.` });
  }
  const twin = s.threads.find((x) => x.id !== t.id && x.draft?.alsoAsks?.thread === t.id);
  if (twin && t.waiting) {
    const who = firstName(t.waiting.on);
    out.push({ tone: 'warn', text: `Your reply “${twin.draft!.subject}” asks ${who} for the same thing. Send either one and Timmy drops or trims the other, so ${who} isn’t asked twice.` });
  }
  return out;
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

/** A decision whose numbers came from a sheet that has since changed. */
function decisionNotes(s: State, thread?: string): ApprovalNote[] | undefined {
  const t = thread ? s.threads.find((x) => x.id === thread) : undefined;
  const stale = t ? staleBasis(s, t) : null;
  if (!stale) return undefined;
  return [{ tone: 'warn', text: `${stale.replace(/ Check the numbers before you send\.$/, '')} The numbers below were worked out before the change.` }];
}

export function openApprovals(s: State): Approval[] {
  const held = new Set(s.conn.held.map((h) => h.key));
  return buildApprovals(s).filter((a) => !held.has(a.key));
}

function buildApprovals(s: State): Approval[] {
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
      notes: draftNotes(s, t),
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
      notes: decisionNotes(s, dec.thread),
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

  // Campaigns Timmy prepared wait here until you launch them.
  for (const c of Object.values(s.out.campaigns)) {
    if (c.status !== 'review') continue;
    const plan = project(c, s.out.leads, ctxOf(s));
    const channels = [...new Set(c.steps.map((st) => (st.channel === 'email' ? 'emails' : st.channel === 'call' ? 'calls' : st.channel === 'sms' ? 'texts' : st.channel)))];
    list.push({
      key: `camp:${c.id}`,
      kind: 'campaign',
      title: `Launch “${c.name}”?`,
      why: `Timmy wrote a ${c.steps.length}-step sequence from your offer for ${c.leads.length} leads. Nothing goes out until you launch it.`,
      facts: [
        ['Leads', String(c.leads.length)],
        ['Steps', `${c.steps.length} (${channels.join(', ')})`],
        ['Daily limit', `${c.options.dailyLimit} new emails`],
        ['Last step', plan.finish ? fmtDay(plan.finish) : 'Not scheduled'],
      ],
      urgency: fixed('soon', 'Leads cool off the longer they wait'),
      route: { view: 'campaign', id: c.id, tab: 'sequence' },
      openLabel: 'Review sequence',
      options: [
        { id: 'launch', label: 'Launch', primary: true },
        { id: 'later', label: 'Not yet' },
      ],
    });
  }

  // Within a level, decisions come before emails: an email often waits on the decision.
  const order: Record<ApprovalKind, number> = { decision: 0, calendar: 1, campaign: 2, crm: 3, email: 4 };
  const due = (a: Approval) => a.due?.getTime() ?? Infinity;
  return list.sort(
    (a, b) =>
      URGENCY[b.urgency.level].rank - URGENCY[a.urgency.level].rank ||
      order[a.kind] - order[b.kind] ||
      urgencyRank(b.urgency) - urgencyRank(a.urgency) ||
      due(a) - due(b),
  );
}
