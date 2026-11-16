/*
 * Small pieces every outbound screen uses: a lead's avatar and name, the fit
 * badge, status and reply labels, channel icons and the daily-limit meter.
 */
import { Hash, Briefcase, Mail, MessageCircle, MessageSquare, Phone, type LucideIcon } from 'lucide-react';
import type { Channel, Lead, LeadStatus, ReplyLabel } from '../../data/outbound-types';
import { fitOf, type Fit } from '../../lib/outbound';
import { useStore } from '../../state/store';
import { tint } from '../../components/common';

export const CHANNEL: Record<Channel, { label: string; icon: LucideIcon; verb: string }> = {
  email: { label: 'Email', icon: Mail, verb: 'Email' },
  sms: { label: 'Text', icon: MessageSquare, verb: 'Text' },
  call: { label: 'Call', icon: Phone, verb: 'Call' },
  linkedin: { label: 'LinkedIn', icon: Briefcase, verb: 'Message' },
  slack: { label: 'Slack', icon: Hash, verb: 'Post' },
  whatsapp: { label: 'WhatsApp', icon: MessageCircle, verb: 'Message' },
};

export function ChannelIcon({ channel, size = 14 }: { channel: Channel; size?: number }) {
  const C = CHANNEL[channel];
  return <C.icon size={size} aria-label={C.label} className={`ch-icon ch-${channel}`} />;
}

const HUES = ['var(--c-sky)', 'var(--c-green)', 'var(--c-violet)', 'var(--c-amber)', 'var(--c-teal)', 'var(--c-pink)', 'var(--c-indigo)', 'var(--c-brown)'];
const hueOf = (s: string) => HUES[[...s].reduce((n, c) => n + c.charCodeAt(0), 0) % HUES.length]!;

/** Initials on a tinted square: companies are square, people are round. */
export function LeadMark({ lead, size = 28, company }: { lead: Pick<Lead, 'first' | 'last' | 'company'>; size?: number; company?: boolean }) {
  const text = company ? lead.company.split(/\s+/).slice(0, 2).map((w) => w[0]).join('') : `${lead.first[0] ?? ''}${lead.last[0] ?? ''}`;
  return (
    <span className={`lead-mark${company ? ' co' : ''}`} style={{ ...tint(hueOf(company ? lead.company : lead.first + lead.last)), width: size, height: size, fontSize: size * 0.38 }} aria-hidden>
      {text.toUpperCase()}
    </span>
  );
}

export function FitBadge({ fit }: { fit: Fit }) {
  return (
    <span className={`fit fit-${fit.label.toLowerCase()}`} title={`Fit ${fit.score}: ${fit.why.join(' · ') || 'not enough data'}`}>
      {fit.label}
      <span className="fit-n">{fit.score}</span>
    </span>
  );
}

export const useFit = () => {
  const { state } = useStore();
  return (l: Lead) => fitOf(l, state.out.offer);
};

export const STATUS: Record<LeadStatus, { label: string; tone: string }> = {
  new: { label: 'New', tone: 'slate' },
  queued: { label: 'Queued', tone: 'blue' },
  contacted: { label: 'Contacted', tone: 'blue' },
  replied: { label: 'Replied', tone: 'violet' },
  interested: { label: 'Interested', tone: 'green' },
  meeting: { label: 'Meeting booked', tone: 'green' },
  'not-interested': { label: 'Not interested', tone: 'slate' },
  bounced: { label: 'Bounced', tone: 'rose' },
  unsubscribed: { label: 'Unsubscribed', tone: 'rose' },
};

export function StatusChip({ status }: { status: LeadStatus }) {
  const s = STATUS[status];
  return <span className={`ostat ost-${s.tone}`}>{s.label}</span>;
}

export const LABEL: Record<ReplyLabel, { label: string; tone: string }> = {
  interested: { label: 'Interested', tone: 'green' },
  meeting: { label: 'Meeting booked', tone: 'green' },
  question: { label: 'Question', tone: 'amber' },
  ooo: { label: 'Out of office', tone: 'slate' },
  'not-interested': { label: 'Not interested', tone: 'slate' },
  'wrong-person': { label: 'Wrong person', tone: 'slate' },
  unsubscribe: { label: 'Unsubscribe', tone: 'rose' },
};

export function LabelChip({ label }: { label: ReplyLabel }) {
  const l = LABEL[label];
  return <span className={`ostat ost-${l.tone}`}>{l.label}</span>;
}

/** "18 of 30 today", with a bar that warns as it fills. */
/** `calm`: filling up is the plan (a day's planned sends), so no warning colors. */
export function Meter({ used, cap, label, unit = 'sent', calm }: { used: number; cap: number; label?: string; unit?: string; calm?: boolean }) {
  const ratio = cap ? Math.min(1, used / cap) : 0;
  return (
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={used} aria-label={label ?? `${used} of ${cap} ${unit}`}>
      <div className="meter-row">
        {label && <span className="meter-label">{label}</span>}
        <span className="meter-n">
          <strong>{used}</strong> of {cap} {unit}
        </span>
      </div>
      <div className="meter-track">
        <div className={`meter-fill${calm ? ' calm' : ratio >= 1 ? ' full' : ratio >= 0.8 ? ' high' : ''}`} style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

export const name = (l: Pick<Lead, 'first' | 'last'>) => `${l.first} ${l.last}`.trim();
