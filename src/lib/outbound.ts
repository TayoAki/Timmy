/*
 * The outbound engine, with no React and no store: fill in a template for a
 * lead, score a lead against your offer, qualify an account, and run a
 * sequence day by day inside the sending window and the daily limits. The
 * same run gives the seed history, today's queue and a launch projection.
 */
import { NOW } from '../data/mock';
import type { Campaign, Lead, Limits, Mailbox, Offer, OutMessage, ReplyLabel, SeqStep } from '../data/outbound-types';

export const DAY = 86_400_000;
export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
export const atClock = (d: Date, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h!, m!);
};
export const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** A small, stable hash so seeded choices (A/B variant, opens) never shuffle. */
export const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/* ───────────── Live time ───────────── */

const BOOT = Date.now();
/** The app's clock, moving forward in real time: for speed-to-lead timers. */
export const liveNow = () => new Date(NOW.getTime() + (Date.now() - BOOT));

/* ───────────── Variables ───────────── */

export interface Sender {
  first: string;
  name: string;
  company: string;
}

export const VARIABLES: { key: string; label: string }[] = [
  { key: 'firstName', label: 'First name' },
  { key: 'lastName', label: 'Last name' },
  { key: 'companyName', label: 'Company' },
  { key: 'title', label: 'Job title' },
  { key: 'industry', label: 'Industry' },
  { key: 'city', label: 'City' },
  { key: 'senderFirstName', label: 'Your first name' },
  { key: 'senderCompany', label: 'Your company' },
  { key: 'offerProduct', label: 'Offer: product' },
  { key: 'offerPain', label: 'Offer: pain' },
  { key: 'offerHook', label: 'Offer: hook (2–3 words)' },
  { key: 'offerOutcome', label: 'Offer: outcome' },
  { key: 'offerProof', label: 'Offer: proof' },
  { key: 'offerCta', label: 'Offer: call to action' },
  { key: 'offerName', label: 'Offer: name' },
  { key: 'offerPrice', label: 'Offer: price' },
  { key: 'productName', label: 'Offer: product name' },
  { key: 'slot1', label: 'Next free time' },
  { key: 'slot2', label: 'Second free time' },
];

export function values(lead: Partial<Lead>, offer: Offer, sender: Sender, slots: string[] = []): Record<string, string | undefined> {
  return {
    firstName: lead.first,
    lastName: lead.last,
    companyName: lead.company,
    title: lead.title,
    industry: lead.industry?.toLowerCase(),
    city: lead.city?.split(',')[0],
    senderFirstName: sender.first,
    senderName: sender.name,
    senderCompany: sender.company,
    offerProduct: offer.product,
    offerPain: offer.pain,
    offerHook: offer.hook || offer.pain.split(/\s+/).slice(0, 3).join(' '),
    offerOutcome: offer.outcome,
    offerProof: offer.proof,
    offerCta: offer.cta,
    offerName: offer.name,
    offerPrice: offer.price,
    productName: offer.product.split(/,|\(|:| [–—-] /)[0]!.trim(),
    slot1: slots[0],
    slot2: slots[1],
  };
}

/** Fills {{variables}}; anything missing is listed so you can fix it before sending. */
export function render(text: string, vals: Record<string, string | undefined>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const out = text.replace(/\{\{\s*(\w+)\s*\}\}/g, (all, key: string) => {
    const v = vals[key];
    if (v === undefined || v === '') {
      missing.push(key);
      return all;
    }
    return v;
  });
  return { text: out, missing };
}

/* ───────────── Fit and qualification ───────────── */

export interface Fit {
  score: number;
  label: 'Excellent' | 'Good' | 'Fair' | 'Poor';
  why: string[];
}

/** How well a lead fits your offer's ideal customer, with the reasons. */
export function fitOf(lead: Lead, offer: Offer): Fit {
  const why: string[] = [];
  let score = 30;
  const title = (lead.title ?? '').toLowerCase();
  if (offer.icp.titles.some((t) => title.includes(t.toLowerCase()))) {
    score += 30;
    why.push(lead.title!);
  } else if (/director|head|vp|chief|founder|owner|manager/.test(title)) {
    score += 12;
    why.push(`${lead.title} (adjacent role)`);
  }
  const ind = (lead.industry ?? '').toLowerCase();
  if (offer.icp.industries.some((i) => ind.includes(i.toLowerCase()))) {
    score += 22;
    why.push(lead.industry!);
  }
  const n = lead.employees;
  if (n !== undefined) {
    if (n >= offer.icp.minEmployees && n <= offer.icp.maxEmployees) {
      score += 16;
      why.push(`${n} employees`);
    } else why.push(`${n} employees (outside ${offer.icp.minEmployees}–${offer.icp.maxEmployees})`);
  }
  if (!lead.email) score -= 25;
  score = Math.max(5, Math.min(99, score + (hash(lead.id) % 5)));
  const label = score >= 85 ? 'Excellent' : score >= 70 ? 'Good' : score >= 50 ? 'Fair' : 'Poor';
  return { score, label, why };
}

const PAIN_WORDS = ['intake', 'scheduling', 'spreadsheet', 'dispatch', 'timesheets', 'invoicing', 'onboarding', 'billing', 'referrals', 'field ops', 'compliance'];

/**
 * Timmy's call on an account. This preview reads the lead's own data (title,
 * size, industry, keywords); with a connector it would read the website too.
 */
export function qualify(lead: Lead, offer: Offer): { verdict: 'yes' | 'maybe' | 'no'; why: string } {
  const fit = fitOf(lead, offer);
  const pains = (lead.keywords ?? []).filter((k) => PAIN_WORDS.some((p) => k.toLowerCase().includes(p)));
  if (!lead.email) return { verdict: 'no', why: 'No email address to reach them.' };
  if (fit.score >= 80 && pains.length) return { verdict: 'yes', why: `${fit.why.slice(0, 2).join(', ')}; works on ${pains.slice(0, 2).join(' and ')}.` };
  if (fit.score >= 65) return { verdict: 'maybe', why: `${fit.why[0] ?? 'Partial fit'}${pains.length ? `; mentions ${pains[0]}` : '; no sign of the pain your offer solves'}.` };
  return { verdict: 'no', why: fit.why.find((w) => /outside|adjacent/.test(w)) ?? 'Outside your ideal customer.' };
}

/* ───────────── Limits ───────────── */

/** What a mailbox may send on a day: its limit, held lower while a new mailbox warms up. */
export function mailboxCap(m: Mailbox, limits: Limits, day: Date = NOW): number {
  const age = Math.max(0, Math.floor((startOfDay(day).getTime() - startOfDay(m.added).getTime()) / DAY));
  const ramp = m.warmup ? limits.rampStart + limits.rampStep * age : Infinity;
  return Math.max(0, Math.min(m.dailyLimit, limits.maxPerMailbox, ramp));
}

/** New cold emails a campaign may send on a day. */
export function campaignCap(c: Campaign, mailboxes: Record<string, Mailbox>, limits: Limits, day: Date = NOW): number {
  const boxes = c.options.mailboxes.map((id) => mailboxes[id]).filter(Boolean) as Mailbox[];
  const room = boxes.reduce((n, m) => n + mailboxCap(m, limits, day), 0);
  return Math.min(c.options.dailyLimit, room);
}

/* ───────────── Running a sequence ───────────── */

export interface ScriptedReply {
  afterStep: number;
  label: ReplyLabel;
  hours: number;
  body: string;
  unread?: boolean;
  channel?: 'email' | 'sms';
}

export interface DayCount {
  day: Date;
  email: number;
  calls: number;
  other: number;
}

export interface RunResult {
  messages: OutMessage[];
  leads: Record<string, Lead>;
  days: DayCount[];
  /** The last day anything goes out. */
  finish?: Date;
}

const CALL_OUTCOMES = ['No answer, left a voicemail', 'No answer', 'Gatekeeper: asked to email instead', 'Spoke briefly: send details'];

/**
 * Runs a campaign day by day from `from` until `until`. Follow-ups go before
 * new leads, emails stay inside the window and the daily cap, and a reply
 * stops the sequence for that lead. With `history`, it records what happened
 * (opens, bounces, scripted replies); without, it plans what will happen.
 */
export function run(
  c: Campaign,
  leadsIn: Record<string, Lead>,
  ctx: { offer: Offer; sender: Sender; mailboxes: Record<string, Mailbox>; limits: Limits },
  from: Date,
  until: Date,
  opts: { history?: boolean; script?: Record<string, ScriptedReply>; bounces?: Set<string> } = {},
): RunResult {
  const leads: Record<string, Lead> = {};
  const order = new Map(c.leads.map((id, i) => [id, i]));
  for (const id of c.leads) {
    const l = leadsIn[id];
    if (l) leads[id] = { ...l, step: l.step ?? 0, nextAt: l.nextAt ?? from };
  }
  const messages: OutMessage[] = [];
  const days: DayCount[] = [];
  const mb = c.options.mailboxes;
  const stopped = (l: Lead) => ['bounced', 'unsubscribed', 'not-interested', 'meeting', 'interested', 'replied'].includes(l.status) || (l.label && l.label !== 'ooo');
  let finish: Date | undefined;
  let k = 0;

  for (let day = startOfDay(from); day < until; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    if (!c.schedule.days.includes(day.getDay())) continue;
    const open = atClock(day, c.schedule.start);
    const close = atClock(day, c.schedule.end);
    let cursor = sameDay(day, from) && from > open ? new Date(Math.ceil(from.getTime() / 300000) * 300000) : open;
    if (cursor >= close) continue;
    let cap = campaignCap(c, ctx.mailboxes, ctx.limits, day);
    const spacing = Math.max(ctx.limits.gapMinutes[0], Math.floor((close.getTime() - cursor.getTime()) / 60000 / Math.max(cap, 1)));
    const count: DayCount = { day, email: 0, calls: 0, other: 0 };
    const due = Object.values(leads)
      .filter((l) => !stopped(l) && (l.step ?? 0) < c.steps.length && l.nextAt && l.nextAt <= close)
      .sort((a, b) => (b.step ?? 0) - (a.step ?? 0) || order.get(a.id)! - order.get(b.id)!);
    for (const l of due) {
      const idx = l.step ?? 0;
      const step: SeqStep = c.steps[idx]!;
      if (step.channel === 'email') {
        if (cap <= 0) continue;
        cap--;
      }
      const at = cursor;
      cursor = new Date(cursor.getTime() + spacing * 60000);
      if (cursor > close) cursor = close;
      const v = step.variants[hash(l.id + c.id) % step.variants.length]!;
      const vals = values(l, ctx.offer, ctx.sender);
      const bounced = !!opts.history && idx === 0 && step.channel === 'email' && !!opts.bounces?.has(l.id);
      const opened = !!opts.history && step.channel === 'email' && !bounced && hash(l.id + idx) % 100 < 62;
      messages.push({
        id: `${c.id}-${l.id}-${idx}`,
        lead: l.id,
        channel: step.channel,
        dir: 'out',
        at,
        subject: step.channel === 'email' ? render(v.subject, vals).text : undefined,
        body: render(v.body, vals).text,
        campaign: c.id,
        step: idx,
        mailbox: step.channel === 'email' ? mb[k++ % Math.max(mb.length, 1)] : undefined,
        status: opts.history ? (bounced ? 'bounced' : opened ? 'opened' : 'sent') : 'scheduled',
        outcome: step.channel === 'call' && opts.history ? CALL_OUTCOMES[hash(l.id) % CALL_OUTCOMES.length] : undefined,
      });
      if (step.channel === 'email') count.email++;
      else if (step.channel === 'call') count.calls++;
      else count.other++;
      finish = day;
      if (bounced) {
        leads[l.id] = { ...l, status: 'bounced', nextAt: undefined };
        continue;
      }
      const nextStep = c.steps[idx + 1];
      let next: Lead = { ...l, status: l.status === 'new' || l.status === 'queued' ? 'contacted' : l.status, step: idx + 1, nextAt: nextStep ? atClock(addDays(day, nextStep.wait), c.schedule.start) : undefined };
      const reply = opts.history ? opts.script?.[l.id] : undefined;
      if (reply && reply.afterStep === idx) {
        const back = new Date(at.getTime() + reply.hours * 3_600_000);
        messages.push({ id: `${c.id}-${l.id}-r`, lead: l.id, channel: reply.channel ?? 'email', dir: 'in', at: back, subject: step.channel === 'email' ? `Re: ${render(v.subject, vals).text}` : undefined, body: reply.body, campaign: c.id });
        const status = reply.label === 'meeting' ? 'meeting' : reply.label === 'interested' || reply.label === 'question' ? 'interested' : reply.label === 'not-interested' || reply.label === 'wrong-person' ? 'not-interested' : reply.label === 'unsubscribe' ? 'unsubscribed' : next.status;
        next = { ...next, label: reply.label, unread: reply.unread, status: reply.label === 'ooo' ? next.status : status, nextAt: reply.label === 'ooo' || !c.options.stopOnReply ? next.nextAt : undefined };
      }
      leads[l.id] = next;
    }
    days.push(count);
  }
  return { messages, leads, days, finish };
}

/** Plans a campaign from now: per-day volume and the day it finishes. */
export function project(c: Campaign, leadsIn: Record<string, Lead>, ctx: Parameters<typeof run>[2], from: Date = NOW) {
  return run(c, leadsIn, ctx, from, new Date(from.getTime() + 75 * DAY));
}

/* ───────────── Stats ───────────── */

export interface CampaignStats {
  leads: number;
  contacted: number;
  sent: number;
  opened: number;
  replied: number;
  interested: number;
  meetings: number;
  bounced: number;
  unsubscribed: number;
  calls: number;
  byStep: { sent: number; opened: number; replied: number }[];
  byDay: { day: Date; sent: number }[];
}

export function statsOf(c: Campaign, leads: Record<string, Lead>, messages: OutMessage[]): CampaignStats {
  const mine = messages.filter((m) => m.campaign === c.id);
  const out = mine.filter((m) => m.dir === 'out' && m.status !== 'scheduled');
  const emails = out.filter((m) => m.channel === 'email');
  const ls = c.leads.map((id) => leads[id]).filter(Boolean) as Lead[];
  // Each reply counts for the step that came just before it.
  const byStep = c.steps.map(() => ({ sent: 0, opened: 0, replied: 0 }));
  for (const m of out) {
    const b = byStep[m.step ?? 0];
    if (!b) continue;
    b.sent++;
    if (m.status === 'opened') b.opened++;
  }
  for (const r of mine.filter((m) => m.dir === 'in' && leads[m.lead]?.label !== 'ooo')) {
    const prev = out.filter((o) => o.lead === r.lead && o.at < r.at).sort((a, b) => b.at.getTime() - a.at.getTime())[0];
    if (prev && byStep[prev.step ?? 0]) byStep[prev.step ?? 0]!.replied++;
  }
  const byDayMap = new Map<string, { day: Date; sent: number }>();
  for (const m of emails) {
    const key = startOfDay(m.at).toDateString();
    const e = byDayMap.get(key) ?? { day: startOfDay(m.at), sent: 0 };
    e.sent++;
    byDayMap.set(key, e);
  }
  return {
    leads: ls.length,
    contacted: ls.filter((l) => (l.step ?? 0) > 0 || l.status !== 'new').length,
    sent: emails.length,
    opened: emails.filter((m) => m.status === 'opened').length,
    replied: ls.filter((l) => l.label && l.label !== 'ooo').length,
    interested: ls.filter((l) => l.status === 'interested' || l.status === 'meeting').length,
    meetings: ls.filter((l) => l.status === 'meeting').length,
    bounced: emails.filter((m) => m.status === 'bounced').length,
    unsubscribed: ls.filter((l) => l.status === 'unsubscribed').length,
    calls: out.filter((m) => m.channel === 'call').length,
    byStep,
    byDay: [...byDayMap.values()].sort((a, b) => a.day.getTime() - b.day.getTime()),
  };
}

export const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '—');

/* ───────────── Writing a sequence from the offer ───────────── */

/**
 * The sequence Timmy writes from your offer: an A/B intro, a bump, a call (if
 * the dialer is connected), a case study and a break-up. Variables stay in
 * {{braces}} so each lead gets their own name, company and free times.
 */
export function writeSequence(offer: Offer, opts: { call: boolean; steps?: number }): SeqStep[] {
  const steps: SeqStep[] = [
    {
      id: 'st1',
      channel: 'email',
      wait: 0,
      variants: [
        { id: 'a', subject: '{{companyName}} + {{offerHook}}', body: `Hi {{firstName}},\n\nQuick one: does {{companyName}} still find that ${offer.pain}? Most teams your size tell me it eats hours every week.\n\n{{offerProof}}\n\n${offer.name[0]!.toUpperCase() + offer.name.slice(1)}: ${offer.outcome}. {{offerCta}}\n\nBest,\n{{senderFirstName}}` },
        { id: 'b', subject: 'question about {{companyName}}', body: `Hi {{firstName}},\n\nWho at {{companyName}} owns the problem that ${offer.pain}? If it’s you, our ${offer.name} aims for ${offer.outcome}.\n\n{{offerCta}}\n\n{{senderFirstName}}` },
      ],
    },
    { id: 'st2', channel: 'email', wait: 3, variants: [{ id: 'a', subject: 'Re: {{companyName}}', body: 'Hi {{firstName}},\n\nFloating this back up in case it got buried. Worth 20 minutes to see if it fits {{companyName}}?\n\n{{senderFirstName}}' }] },
    ...(opts.call
      ? [{ id: 'st3', channel: 'call' as const, wait: 2, variants: [{ id: 'a', subject: '', body: 'Hi {{firstName}}, it’s {{senderFirstName}} from {{senderCompany}}. I emailed about {{offerHook}}. Do you have 30 seconds?\n\n• Ask: where does the team lose the most time?\n• Proof: {{offerProof}}\n• Close: {{offerCta}}' }] }]
      : []),
    { id: 'st4', channel: 'email', wait: 3, variants: [{ id: 'a', subject: 'what {{offerOutcome}} looks like', body: 'Hi {{firstName}},\n\n{{offerProof}} They started small and had it live in three weeks.\n\nIf {{companyName}} has a workflow like that, I can show you what it would look like. {{offerCta}}\n\n{{senderFirstName}}' }] },
    { id: 'st5', channel: 'email', wait: 4, variants: [{ id: 'a', subject: 'close the loop?', body: 'Hi {{firstName}},\n\nI haven’t heard back, so I’ll assume the timing isn’t right and stop here. If it becomes a priority, just reply and I’ll pick it up.\n\nBest,\n{{senderFirstName}}' }] },
  ];
  return steps.slice(0, opts.steps ?? steps.length);
}

/** A first email written for one step from the offer, in a different angle each time. */
export function rewrite(offer: Offer, step: SeqStep, n: number): { subject: string; body: string } {
  const angles = [
    { subject: '{{offerHook}} at {{companyName}}', body: `Hi {{firstName}},\n\nI work with ${offer.audience.toLowerCase()}. The common thread: ${offer.pain}.\n\n{{offerProof}}\n\n{{offerCta}}\n\n{{senderFirstName}}` },
    { subject: 'idea for {{companyName}}', body: `Hi {{firstName}},\n\nOne idea for {{companyName}}: ${offer.outcome}. That’s what our ${offer.name} is built around.\n\nWorth a look? {{offerCta}}\n\n{{senderFirstName}}` },
    { subject: '{{firstName}}, quick question', body: `Hi {{firstName}},\n\nIs it still true at {{companyName}} that ${offer.pain}? If so, {{offerProof}}\n\n{{offerCta}}\n\n{{senderFirstName}}` },
  ];
  if (step.channel === 'call') return { subject: '', body: `Hi {{firstName}}, it’s {{senderFirstName}} from {{senderCompany}}.\n\n• Ask: is ${offer.pain} still true for you?\n• Proof: {{offerProof}}\n• Close: {{offerCta}}` };
  if (step.channel === 'sms') return { subject: '', body: 'Hi {{firstName}}, it’s {{senderFirstName}} from {{senderCompany}}. Following up on my email: {{offerCta}} Reply STOP to opt out.' };
  return angles[n % angles.length]!;
}

const SPAMMY = ['free', 'guarantee', 'act now', 'limited time', '100%', '$$$', 'risk-free', 'click here', 'winner', 'urgent'];

/** Things that hurt deliverability or replies in a cold email. */
export function lint(subject: string, body: string, first: boolean): string[] {
  const out: string[] = [];
  const text = `${subject} ${body}`.toLowerCase();
  const spam = SPAMMY.filter((w) => text.includes(w));
  if (spam.length) out.push(`Spam-filter words: ${spam.map((w) => `“${w}”`).join(', ')}`);
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words > 140) out.push(`${words} words: cold emails under 125 words get more replies`);
  const links = (body.match(/https?:\/\//g) ?? []).length;
  if (first && links) out.push('A link in the first email hurts deliverability; save it for a reply');
  if (subject.length > 60) out.push('Subject is long; under 40 characters reads best on a phone');
  if (/!{2,}|[A-Z]{6,}/.test(subject + body)) out.push('Shouting (ALL CAPS or !!) looks like spam');
  return out;
}
