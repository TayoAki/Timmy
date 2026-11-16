/*
 * What a lead's last message means, so the rest of Timmy can act on it:
 * a time they agreed to ("Monday morning works! 9:15 is great."), questions
 * they asked, someone they pointed you to. And the leads that need you today:
 * form leads still waiting for a first reply, and meetings a lead confirmed
 * that aren't on your calendar yet.
 */
import { NOW } from '../data/mock';
import type { Lead, OutMessage } from '../data/outbound-types';
import { fmtTime } from '../lib/format';
import type { State } from './store';

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const plusDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Agreement words, and the ones that turn a time down. */
const YES = /\b(works|work for me|is great|sounds (good|great)|perfect|see you|confirmed|let'?s do|i'?ll be there|is fine|that'?s fine|good for me|book (it|me))\b/;
const NO = /\b(doesn'?t|does not|don'?t|can'?t|cannot|won'?t|isn'?t|not good|no good)\b/;

/**
 * The time a reply agrees to, or null. Reads "9:15", "4:30 pm", "10am" with
 * "today", "tomorrow" or a weekday; without am/pm, 7–11 is the morning and
 * 12–6 the afternoon, as people mean it in a work email.
 */
export function acceptedTime(text: string, sent: Date): Date | null {
  const t = text.toLowerCase().replace(/’/g, "'");
  if (!YES.test(t) || NO.test(t)) return null;
  const m = t.match(/\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?/) ?? t.match(/\b(\d{1,2})()\s*(a\.?m\.?|p\.?m\.?)/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.replace(/\./g, '');
  if (h > 23 || min > 59) return null;
  if (ap === 'pm' && h < 12) h += 12;
  else if (ap === 'am' && h === 12) h = 0;
  else if (!ap && h >= 1 && h <= 6) h += 12;
  let day: Date | null = null;
  if (/\btoday\b|\bthis (morning|afternoon)\b/.test(t)) day = startOfDay(sent);
  else if (/\btomorrow\b/.test(t)) day = plusDays(sent, 1);
  else {
    const named = DAYS.findIndex((d) => new RegExp(`\\b${d}\\b`).test(t));
    if (named >= 0) {
      const ahead = (named - sent.getDay() + 7) % 7;
      day = plusDays(sent, ahead);
      // "Monday 9:15" sent on a Monday after 9:15 means next week.
      if (ahead === 0 && (h < sent.getHours() || (h === sent.getHours() && min <= sent.getMinutes()))) day = plusDays(sent, 7);
    }
  }
  if (!day) {
    // No day named: today if that time is still ahead, else the next day.
    day = h > sent.getHours() || (h === sent.getHours() && min > sent.getMinutes()) ? startOfDay(sent) : plusDays(sent, 1);
  }
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, min);
}

const lastIn = (s: State, lead: Lead): OutMessage | undefined =>
  s.out.messages.filter((m) => m.lead === lead.id && m.dir === 'in').sort((a, b) => b.at.getTime() - a.at.getTime())[0];

/** A meeting on your calendar with this lead, from the reply on. */
const bookedAfter = (s: State, lead: Lead, from: Date) => Object.values(s.ws.events).some((e) => e.with.includes(lead.id) && e.start.getTime() >= startOfDay(from).getTime());

/** A time the lead said yes to that isn't booked yet, today or later. */
export function pendingAcceptance(s: State, lead: Lead): { at: Date; quote: string; msg: OutMessage } | null {
  const msg = lastIn(s, lead);
  if (!msg) return null;
  const at = acceptedTime(msg.body, msg.at);
  if (!at || at < startOfDay(NOW) || bookedAfter(s, lead, msg.at)) return null;
  const quote = msg.body.split(/\n/)[0]!.trim();
  return { at, quote, msg };
}

/** "today at 9:15 AM", "tomorrow at 4:30 PM", "Thursday at 10:00 AM". */
export function whenWords(at: Date): string {
  const diff = Math.round((startOfDay(at).getTime() - startOfDay(NOW).getTime()) / 86_400_000);
  const day = diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : at.toLocaleDateString('en-US', { weekday: 'long' });
  return `${day} at ${fmtTime(at)}`;
}

/* ───────────── What a reply asks ───────────── */

const PRICE = /\b(cost|price|pricing|how much|budget|fee|quote)\b/i;
const TIMES = /\b(time|times|when|call|meet|meeting|slot|available|availability)\b/i;

/** Questions in the lead's last message, split into price, times and everything else. */
export function questionsIn(text: string): { price: boolean; times: boolean; other: string[] } {
  const parts = text
    .replace(/\n+/g, ' ')
    .split(/(?<=[?.!])\s+/)
    .flatMap((q) => (q.includes('?') ? q.split(/,\s*and\s+|\s+and\s+(?=(?:do|does|can|could|is|are|will|would|what|how|when|who)\b)/i) : []))
    .map((q) => q.trim())
    .filter(Boolean);
  const price = parts.some((q) => PRICE.test(q));
  const times = parts.some((q) => TIMES.test(q) && !PRICE.test(q));
  const other = parts.filter((q) => !PRICE.test(q) && !TIMES.test(q)).map((q) => (q.endsWith('?') ? q : `${q.replace(/[.,;]$/, '')}?`));
  return { price, times, other };
}

/** Someone the lead pointed you to: "Try Dana Ruiz, our COO." or an email address. */
export function referral(text: string): { name?: string; email?: string } | null {
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0];
  const name = text.match(/\b(?:[Tt]ry|[Cc]ontact|[Rr]each out to|[Tt]alk to|[Ss]peak (?:to|with)|[Ee]mail|[Aa]sk|[Ll]oop in)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/)?.[1];
  if (!email && !name) return null;
  return { name, email };
}

/** One line per open question you can't answer from the offer, said honestly. */
export const otherQuestionsLine = (other: string[]) =>
  other.length
    ? `\n\nYou also asked ${other.length === 1 ? `“${lowerFirst(other[0]!)}”` : other.map((q) => `“${lowerFirst(q)}”`).join(' and ')} I’ll check and come back to you on ${other.length === 1 ? 'that' : 'those'} today.`
    : '';

const lowerFirst = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);

/* ───────────── Leads that need you today ───────────── */

export interface LeadAlert {
  lead: Lead;
  kind: 'waiting' | 'confirmed';
  /** Waiting: when the form came in. Confirmed: the time they agreed to. */
  at: Date;
  /** Waiting: the form's answer-within target, in minutes. */
  sla?: number;
  quote?: string;
}

const CLOSED: Lead['status'][] = ['not-interested', 'unsubscribed', 'bounced', 'meeting'];

/** Form leads still waiting for a first reply, and confirmed times that aren't booked. Most pressing first. */
export function leadAlerts(s: State): LeadAlert[] {
  const out: LeadAlert[] = [];
  for (const lead of Object.values(s.out.leads)) {
    const yes = pendingAcceptance(s, lead);
    if (yes) {
      out.push({ lead, kind: 'confirmed', at: yes.at, quote: yes.quote });
      continue;
    }
    if (lead.source === 'form' && lead.receivedAt && !lead.firstReplyAt && !CLOSED.includes(lead.status)) {
      out.push({ lead, kind: 'waiting', at: lead.receivedAt, sla: s.out.forms[lead.form ?? '']?.sla });
    }
  }
  // Confirmed meetings soonest first, then the longest-waiting leads.
  return out.sort((a, b) => (a.kind === b.kind ? (a.kind === 'confirmed' ? a.at.getTime() - b.at.getTime() : a.at.getTime() - b.at.getTime()) : a.kind === 'confirmed' ? -1 : 1));
}

/* ───────────── Today's calls ───────────── */

export interface CallItem {
  lead: Lead;
  kind: 'form' | 'callback' | 'step';
  why: string;
  due: Date;
  /** The campaign step's own script, when the call is a sequence step. */
  script?: string;
  campaign?: string;
}

const endOfToday = () => new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 23, 59);
const NO_CALL: Lead['status'][] = ['not-interested', 'unsubscribed', 'bounced'];

/** Who to call today: form leads still waiting, callbacks you set, and call steps due in running campaigns. */
export function callQueue(s: State): CallItem[] {
  const out: CallItem[] = [];
  const end = endOfToday();
  for (const lead of Object.values(s.out.leads)) {
    if (!lead.phone || NO_CALL.includes(lead.status)) continue;
    if (lead.callbackAt && lead.callbackAt <= end) {
      out.push({ lead, kind: 'callback', due: lead.callbackAt, why: `Callback you set${lead.callbackNote ? `: ${lead.callbackNote}` : ''}` });
      continue;
    }
    if (lead.source === 'form' && lead.receivedAt && !lead.firstReplyAt && lead.status !== 'meeting') {
      out.push({ lead, kind: 'form', due: lead.receivedAt, why: 'Form lead waiting for a first reply' });
      continue;
    }
    const c = lead.campaign ? s.out.campaigns[lead.campaign] : undefined;
    const step = c && lead.step !== undefined ? c.steps[lead.step] : undefined;
    if (c && c.status === 'active' && step?.channel === 'call' && lead.nextAt && lead.nextAt <= end && !['replied', 'interested', 'meeting'].includes(lead.status)) {
      out.push({ lead, kind: 'step', due: lead.nextAt, why: `${c.name}: step ${lead.step! + 1}, a call`, script: step.variants[0]?.body, campaign: c.id });
    }
  }
  const order = { form: 0, callback: 1, step: 2 } as const;
  return out.sort((a, b) => order[a.kind] - order[b.kind] || a.due.getTime() - b.due.getTime());
}

/** A lead named in a request: full name first, then company, then a first name only one lead has. */
export function leadIn(s: State, l: string): Lead | undefined {
  const leads = Object.values(s.out.leads);
  const has = (w: string) => w.length > 1 && new RegExp(`\\b${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(l);
  const full = leads.find((x) => has(`${x.first} ${x.last}`));
  if (full) return full;
  const co = leads.find((x) => x.company.length > 3 && has(x.company));
  if (co) return co;
  const firsts = leads.filter((x) => has(x.first));
  return firsts.length === 1 ? firsts[0] : undefined;
}
