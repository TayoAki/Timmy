/*
 * Outbound actions: dispatch({ type: 'out', op: { op: 'launch', id } }).
 *
 * The store hands each op to `outbound()` with its toast and log helpers, so
 * every change gets the same notice, activity line and Undo as the rest of
 * Timmy. Sending checks the limits first: cold email stays under each
 * mailbox's daily cap, texts need consent and respect quiet hours.
 */
import { NOW, PEOPLE } from '../data/mock';
import type { Activity } from '../data/types';
import type { Campaign, Channel, ChannelConn, FormSource, Lead, LeadList, Limits, Mailbox, Offer, OutMessage, ReplyLabel, SocialPost, Template } from '../data/outbound-types';
import type { WS } from '../data/ws-types';
import { fmtDay, fmtTime, plural } from '../lib/format';
import { addDays, atClock, hash, liveNow, mailboxCap, project, qualify, render, values, type Sender } from '../lib/outbound';
import { isLive } from '../live/clock';
import { SENDER } from '../data/outbound-mock';
import { applyOps, eventsOn, put, registerPerson } from './ws';
import type { State, Toast } from './store';

export type OutOp =
  | { op: 'import'; list: LeadList; leads: Lead[] }
  | { op: 'addLead'; lead: Lead }
  | { op: 'patchLead'; id: string; patch: Partial<Lead> }
  | { op: 'removeLeads'; ids: string[] }
  | { op: 'qualify'; ids: string[] }
  | { op: 'save'; ids: string[]; saved: boolean }
  | { op: 'offer'; offer: Offer }
  | { op: 'template'; template: Template }
  | { op: 'removeTemplate'; id: string }
  | { op: 'campaign'; campaign: Campaign; quiet?: boolean }
  | { op: 'patchCampaign'; id: string; patch: Partial<Campaign> }
  | { op: 'addToCampaign'; id: string; leads: string[] }
  | { op: 'removeFromCampaign'; id: string; leads: string[] }
  | { op: 'launch'; id: string }
  | { op: 'pause'; id: string }
  | { op: 'removeCampaign'; id: string }
  | { op: 'send'; lead: string; channel: Channel; subject?: string; body: string }
  | { op: 'logCall'; lead: string; outcome: string; notes?: string; callbackAt?: Date; callbackNote?: string }
  | { op: 'label'; lead: string; label: ReplyLabel | null }
  | { op: 'read'; lead: string }
  | { op: 'mailbox'; mailbox: Mailbox }
  | { op: 'removeMailbox'; id: string }
  | { op: 'channel'; id: string; patch: Partial<ChannelConn> }
  | { op: 'limits'; patch: Partial<Limits> }
  | { op: 'form'; id: string; patch: Partial<FormSource> }
  | { op: 'submit'; form: string; lead: Lead }
  | { op: 'post'; post: SocialPost }
  | { op: 'removePost'; id: string }
  | { op: 'book'; lead: string; start: Date; end: Date; showing?: string }
  | { op: 'toCrm'; lead: string }
  | { op: 'draftCampaign'; id: string }
  | { op: 'sendDrafts'; ids: string[] }
  | { op: 'editDraft'; id: string; subject: string; body: string }
  | { op: 'removeDrafts'; ids: string[] };

export interface OutHelpers {
  toast: (s: State, text: string, opts?: { undo?: boolean; tone?: Toast['tone'] }) => Toast[];
  log: (s: State, text: string, kind: Activity['kind']) => Activity[];
}

let seq = 1;
const mid = (p: string) => `${p}-${Date.now().toString(36)}-${seq++}`;
export const fullName = (l: Pick<Lead, 'first' | 'last'>) => `${l.first} ${l.last}`.trim();

/* ───────────── Free times for {{slot1}} / {{slot2}} ───────────── */

/** The next free stretches on your calendar on working days, from tomorrow. */
export function freeTimes(ws: WS, count = 2, mins = 30, perDay = 1, today = false): { start: Date; end: Date; label: string }[] {
  const out: { start: Date; end: Date; label: string }[] = [];
  for (let i = today ? 0 : 1; out.length < count && i < 14; i++) {
    const day = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + i);
    if (day.getDay() === 0 || day.getDay() === 6) continue;
    let cursor = atClock(day, '09:15');
    if (i === 0) {
      // Today: from the next quarter hour that's at least 30 minutes away.
      const soon = new Date(liveNow().getTime() + 30 * 60000);
      soon.setMinutes(Math.ceil(soon.getMinutes() / 15) * 15, 0, 0);
      if (soon > cursor) cursor = soon;
    }
    const close = atClock(day, '17:00');
    let found = 0;
    const busy = eventsOn(ws, day).sort((a, b) => a.start.getTime() - b.start.getTime());
    while (found < perDay && out.length < count && cursor.getTime() + mins * 60000 <= close.getTime()) {
      const clash = busy.find((e) => e.start < new Date(cursor.getTime() + mins * 60000) && e.end > cursor);
      if (clash) {
        cursor = clash.end;
        continue;
      }
      const word = i === 0 ? 'today' : i === 1 ? 'tomorrow' : day.toLocaleDateString('en-US', { weekday: 'long' });
      out.push({ start: cursor, end: new Date(cursor.getTime() + mins * 60000), label: `${word} at ${fmtTime(cursor)}` });
      found++;
      cursor = new Date(cursor.getTime() + 2 * 3_600_000);
    }
  }
  return out;
}

/** The next free half hours in words, for {{slot1}} and {{slot2}}: "tomorrow at 9:15 AM". */
export const nextSlots = (ws: WS, count = 2) => freeTimes(ws, count).map((x) => x.label);

const PAIRS = [[0, 2], [1, 3], [2, 4]] as const;
/** Two free times for this lead; different leads get different pairs so drafts don't collide. */
export const slotsFor = (ws: WS, leadId?: string) => {
  const all = freeTimes(ws, 6, 30, 2).map((x) => x.label);
  const [a, b] = PAIRS[leadId ? hash(leadId) % PAIRS.length : 0]!;
  return [all[a] ?? all[0]!, all[b] ?? all[1]!].filter(Boolean);
};

/** Who the templates sign as: the sample persona in the demo, and on a real workspace the person using it. */
export function sender(): Sender {
  if (!isLive()) return SENDER;
  const me = PEOPLE.me;
  const name = me?.name ?? '';
  return { first: name.split(/\s+/)[0] ?? '', name, company: me?.company ?? '' };
}

export const fill = (s: State, text: string, lead: Partial<Lead>) => render(text, values(lead, s.out.offer, sender(), slotsFor(s.ws, lead.id)));

/* ───────────── Limits ───────────── */

/** Cold emails sent today, and the room left, across your mailboxes. */
export function coldToday(s: State) {
  const boxes = Object.values(s.out.mailboxes);
  const cap = boxes.reduce((n, m) => n + mailboxCap(m, s.out.limits), 0);
  const sent = boxes.reduce((n, m) => n + m.sentToday, 0);
  return { sent, cap, left: Math.max(0, cap - sent) };
}

/** Whether a lead agreed to texts: they ticked it on a form, or they texted you first. */
export const canText = (s: State, lead: Lead) =>
  !!lead.phone && (/^y/i.test(lead.extra?.['Text me'] ?? '') || s.out.messages.some((m) => m.lead === lead.id && m.channel === 'sms' && m.dir === 'in'));

const quietHours = (s: State) => {
  const h = liveNow();
  return h < atClock(h, s.out.limits.sms.quietStart) || h >= atClock(h, s.out.limits.sms.quietEnd);
};

/** A first email to someone who never asked to hear from you. */
const isCold = (s: State, lead: Lead) => lead.source !== 'form' && !s.out.messages.some((m) => m.lead === lead.id && m.status !== 'draft' && (m.dir === 'in' || m.channel === 'email'));

/* ───────────── The reducer ───────────── */

const withLeads = (s: State, leads: Record<string, Lead>): State => ({ ...s, out: { ...s.out, leads } });
const patchLeads = (s: State, ids: string[], fn: (l: Lead) => Lead): Record<string, Lead> => {
  const leads = { ...s.out.leads };
  for (const id of ids) if (leads[id]) leads[id] = fn(leads[id]!);
  return leads;
};

/** Cold emails Timmy saved as drafts in your sending accounts, oldest first. */
export const draftsOf = (s: Pick<State, 'out'>) => s.out.messages.filter((m) => m.status === 'draft').sort((a, b) => a.at.getTime() - b.at.getTime());

export function outbound(s: State, a: OutOp, h: OutHelpers): State {
  const out = s.out;
  switch (a.op) {
    // Timmy writes the first email to each lead and saves it as a draft in the sending account.
    case 'draftCampaign': {
      const c = out.campaigns[a.id];
      const step = c?.steps[0];
      if (!c || !step || step.channel !== 'email') return s;
      const ctx = ctxOf(s);
      const boxes = c.options.mailboxes.filter((id) => out.mailboxes[id]);
      const have = new Set(out.messages.filter((m) => m.status === 'draft' && m.campaign === c.id).map((m) => m.lead));
      const made: OutMessage[] = [];
      for (const id of c.leads) {
        const l = out.leads[id];
        if (!l || !l.email || have.has(id) || !['new', 'queued'].includes(l.status)) continue;
        const v = step.variants[hash(l.id + c.id) % step.variants.length]!;
        const vals = values(l, ctx.offer, ctx.sender);
        made.push({ id: mid('draft'), lead: id, channel: 'email', dir: 'out', at: NOW, subject: render(v.subject, vals).text, body: render(v.body, vals).text, campaign: c.id, step: 0, mailbox: boxes[made.length % Math.max(boxes.length, 1)], status: 'draft' });
      }
      if (!made.length) return s;
      return {
        ...s,
        out: { ...out, messages: [...out.messages, ...made] },
        activity: h.log(s, isLive() ? `Wrote ${plural(made.length, 'draft')} for “${c.name}”. Each one is sent by you, from your mail app` : `Saved ${plural(made.length, 'draft')} for “${c.name}” in your sending account${boxes.length === 1 ? '' : 's'}`, 'send'),
      };
    }

    case 'editDraft': {
      const messages = out.messages.map((m) => (m.id === a.id && m.status === 'draft' ? { ...m, subject: a.subject, body: a.body } : m));
      return { ...s, out: { ...out, messages }, toasts: h.toast(s, isLive() ? 'Draft saved.' : 'Draft saved. Gmail or Outlook shows the same change.') };
    }

    case 'removeDrafts': {
      const gone = new Set(a.ids);
      const n = out.messages.filter((m) => gone.has(m.id) && m.status === 'draft').length;
      return { ...s, out: { ...out, messages: out.messages.filter((m) => !(gone.has(m.id) && m.status === 'draft')) }, toasts: h.toast(s, `Deleted ${plural(n, 'draft')}`, { undo: true }) };
    }

    // Sending a draft goes through the same limits as any cold email; past today's room it waits for tomorrow.
    case 'sendDrafts': {
      const quiet: OutHelpers = { toast: (st) => st.toasts, log: (st) => st.activity };
      let next = s;
      let sent = 0;
      let later = 0;
      for (const id of a.ids) {
        const d = next.out.messages.find((m) => m.id === id && m.status === 'draft');
        if (!d) continue;
        const c = d.campaign ? next.out.campaigns[d.campaign] : undefined;
        const before = next.out.messages.length - 1;
        next = { ...next, out: { ...next.out, messages: next.out.messages.filter((m) => m.id !== id) } };
        next = outbound(next, { op: 'send', lead: d.lead, channel: 'email', subject: d.subject, body: d.body }, quiet);
        const made = next.out.messages[next.out.messages.length - 1];
        if (next.out.messages.length === before + 1 && made) {
          const msgs = [...next.out.messages];
          msgs[msgs.length - 1] = { ...made, campaign: d.campaign, step: d.step, mailbox: made.mailbox ?? d.mailbox };
          if (made.status === 'scheduled') later++;
          else sent++;
          const l = next.out.leads[d.lead];
          const wait = c?.steps[(d.step ?? 0) + 1]?.wait;
          const leads = l && c ? { ...next.out.leads, [l.id]: { ...l, campaign: c.id, step: (d.step ?? 0) + 1, nextAt: wait !== undefined ? addDays(made.at, wait) : undefined } } : next.out.leads;
          const campaigns = c && (c.status === 'review' || c.status === 'draft') ? { ...next.out.campaigns, [c.id]: { ...c, status: 'active' as const, launched: c.launched ?? NOW } } : next.out.campaigns;
          next = { ...next, out: { ...next.out, messages: msgs, leads, campaigns } };
        }
      }
      if (!sent && !later) return s;
      const t = coldToday(next);
      return {
        ...next,
        activity: h.log(s, `Sent ${plural(sent, 'cold email')} from drafts${later ? `; ${later} wait for tomorrow` : ''}`, 'send'),
        toasts: h.toast(s, `Sent ${plural(sent, 'draft')}${later ? `. ${later} more go out tomorrow, after today’s limit` : ''} · ${t.sent} of ${t.cap} cold emails today. Timmy drafts each follow-up when it’s due, unless they reply.`, { undo: true }),
      };
    }

    case 'import': {
      const leads = { ...out.leads };
      for (const l of a.leads) leads[l.id] = l;
      return {
        ...s,
        out: { ...out, leads, lists: { ...out.lists, [a.list.id]: a.list } },
        activity: h.log(s, `Imported ${plural(a.leads.length, 'lead')} into “${a.list.name}”`, 'file'),
        toasts: h.toast(s, `Imported ${plural(a.leads.length, 'lead')} into “${a.list.name}”`, { undo: true }),
      };
    }

    case 'addLead':
      return { ...withLeads(s, { ...out.leads, [a.lead.id]: a.lead }), toasts: h.toast(s, `Added ${fullName(a.lead)}`, { undo: true }) };

    case 'patchLead':
      return withLeads(s, patchLeads(s, [a.id], (l) => ({ ...l, ...a.patch })));

    case 'removeLeads': {
      const leads = { ...out.leads };
      for (const id of a.ids) delete leads[id];
      const campaigns = Object.fromEntries(Object.entries(out.campaigns).map(([id, c]) => [id, { ...c, leads: c.leads.filter((x) => !a.ids.includes(x)) }]));
      return { ...s, out: { ...out, leads, campaigns }, toasts: h.toast(s, `Deleted ${plural(a.ids.length, 'lead')}`, { undo: true }) };
    }

    case 'qualify': {
      const leads = patchLeads(s, a.ids, (l) => ({ ...l, qualified: qualify(l, out.offer) }));
      const yes = a.ids.filter((id) => leads[id]?.qualified?.verdict === 'yes').length;
      return {
        ...withLeads(s, leads),
        activity: h.log(s, `Qualified ${plural(a.ids.length, 'account')} against “${out.offer.name}”: ${yes} fit`, 'triage'),
        toasts: a.ids.length > 1 ? h.toast(s, `Qualified ${plural(a.ids.length, 'account')}: ${yes} fit, ${a.ids.length - yes} to check or skip`) : s.toasts,
      };
    }

    case 'save':
      return { ...withLeads(s, patchLeads(s, a.ids, (l) => ({ ...l, saved: a.saved }))), toasts: h.toast(s, a.saved ? `Saved ${plural(a.ids.length, 'lead')}` : 'Removed from saved') };

    case 'offer':
      return { ...s, out: { ...out, offer: a.offer }, toasts: h.toast(s, 'Offer saved. New drafts and fit scores use it.', { undo: true }) };

    case 'template':
      return { ...s, out: { ...out, templates: { ...out.templates, [a.template.id]: a.template } }, toasts: h.toast(s, `Template “${a.template.name}” saved`) };

    case 'removeTemplate': {
      const templates = { ...out.templates };
      delete templates[a.id];
      return { ...s, out: { ...out, templates }, toasts: h.toast(s, 'Template deleted', { undo: true }) };
    }

    case 'campaign':
      return {
        ...s,
        out: { ...out, campaigns: { ...out.campaigns, [a.campaign.id]: a.campaign } },
        toasts: a.quiet ? s.toasts : h.toast(s, a.campaign.status === 'review' ? `“${a.campaign.name}” is ready. It waits in Approvals until you launch it.` : `Campaign “${a.campaign.name}” created`),
      };

    case 'patchCampaign': {
      const c = out.campaigns[a.id];
      if (!c) return s;
      return { ...s, out: { ...out, campaigns: { ...out.campaigns, [a.id]: { ...c, ...a.patch } } } };
    }

    case 'addToCampaign': {
      const c = out.campaigns[a.id];
      if (!c) return s;
      const fresh = a.leads.filter((id) => !c.leads.includes(id) && out.leads[id] && !['unsubscribed', 'bounced'].includes(out.leads[id]!.status));
      const busy = fresh.filter((id) => out.leads[id]!.campaign && out.leads[id]!.campaign !== c.id && out.campaigns[out.leads[id]!.campaign!]?.status === 'active');
      const adding = fresh.filter((id) => !busy.includes(id));
      const start = nextWindow(c);
      const leads = patchLeads(s, adding, (l) => ({ ...l, campaign: c.id, step: 0, nextAt: start, status: c.status === 'active' ? 'queued' : l.status }));
      const skipped = a.leads.length - adding.length;
      return {
        ...s,
        out: { ...out, leads, campaigns: { ...out.campaigns, [c.id]: { ...c, leads: [...c.leads, ...adding] } } },
        toasts: h.toast(s, `Added ${plural(adding.length, 'lead')} to “${c.name}”${skipped ? `. Skipped ${skipped}: already in an active campaign, unsubscribed or bounced` : ''}`, { undo: true }),
      };
    }

    case 'removeFromCampaign': {
      const c = out.campaigns[a.id];
      if (!c) return s;
      const leads = patchLeads(s, a.leads, (l) => ({ ...l, campaign: undefined, step: undefined, nextAt: undefined, status: l.status === 'queued' ? 'new' : l.status }));
      return { ...s, out: { ...out, leads, campaigns: { ...out.campaigns, [c.id]: { ...c, leads: c.leads.filter((x) => !a.leads.includes(x)) } } }, toasts: h.toast(s, `Removed ${plural(a.leads.length, 'lead')} from “${c.name}”`, { undo: true }) };
    }

    case 'launch': {
      const c = out.campaigns[a.id];
      if (!c) return s;
      const problem = launchProblem(s, c);
      if (problem) return { ...s, toasts: h.toast(s, problem, { tone: 'warn' }) };
      const start = nextWindow(c);
      const leads = patchLeads(s, c.leads, (l) => (l.status === 'new' || l.status === 'queued' ? { ...l, campaign: c.id, status: 'queued', step: 0, nextAt: start } : l));
      const launched: Campaign = { ...c, status: 'active', launched: c.launched ?? NOW };
      const next = { ...s, out: { ...out, leads, campaigns: { ...out.campaigns, [c.id]: launched } } };
      const plan = project(launched, leads, ctxOf(next), NOW);
      const first = plan.days.find((d) => d.email + d.calls + d.other > 0);
      return {
        ...next,
        activity: h.log(s, `Launched “${c.name}” to ${plural(c.leads.length, 'lead')}, up to ${launched.options.dailyLimit} new emails a day`, 'send'),
        approvalLog: [{ id: `ap-camp-${Date.now().toString(36)}`, at: NOW, key: `camp:${c.id}`, kind: 'campaign', title: `Launch “${c.name}”`, choice: 'Launched', approved: true }, ...s.approvalLog],
        toasts: h.toast(s, `Launched “${c.name}”. ${first ? `${first.email} emails go out ${fmtDay(first.day) === fmtDay(NOW) ? 'today' : fmtDay(first.day)} from ${c.schedule.start.replace(/^0/, '')}` : 'Nothing to send yet'}${plan.finish ? `; the last step goes out ${fmtDay(plan.finish)}` : ''}.`, { undo: true }),
      };
    }

    case 'pause': {
      const c = out.campaigns[a.id];
      if (!c) return s;
      return {
        ...s,
        out: { ...out, campaigns: { ...out.campaigns, [c.id]: { ...c, status: 'paused' } } },
        activity: h.log(s, `Paused “${c.name}”`, 'send'),
        toasts: h.toast(s, `Paused “${c.name}”. Nothing more goes out until you resume.`, { undo: true }),
      };
    }

    case 'removeCampaign': {
      const c = out.campaigns[a.id];
      if (!c) return s;
      const campaigns = { ...out.campaigns };
      delete campaigns[a.id];
      const leads = patchLeads(s, c.leads, (l) => (l.campaign === c.id ? { ...l, campaign: undefined, step: undefined, nextAt: undefined, status: l.status === 'queued' ? 'new' : l.status } : l));
      return { ...s, out: { ...out, leads, campaigns }, toasts: h.toast(s, `Deleted “${c.name}”`, { undo: true }) };
    }

    case 'send': {
      const lead = out.leads[a.lead];
      if (!lead) return s;
      const at = liveNow();
      const msg: OutMessage = { id: mid('msg'), lead: lead.id, channel: a.channel, dir: 'out', at, subject: a.subject, body: a.body, status: 'sent' };
      let mailboxes = out.mailboxes;
      let channels = out.channels;
      let note = '';
      if (a.channel === 'sms') {
        const sms = out.channels.sms;
        if (!sms?.connected) return { ...s, toasts: h.toast(s, 'Texting isn’t connected. Connect it in Channels & limits.', { tone: 'warn' }) };
        if (!canText(s, lead)) return { ...s, toasts: h.toast(s, `Can’t text ${lead.first}: they haven’t agreed to texts. Email instead, or ask them on the call.`, { tone: 'warn' }) };
        if (quietHours(s)) return { ...s, toasts: h.toast(s, `It’s outside texting hours (${out.limits.sms.quietStart}–${out.limits.sms.quietEnd}). Timmy won’t text ${lead.first} now.`, { tone: 'warn' }) };
        if ((sms.sentToday ?? 0) >= (sms.dailyLimit ?? Infinity)) return { ...s, toasts: h.toast(s, `Today’s limit of ${sms.dailyLimit} texts is used up.`, { tone: 'warn' }) };
        channels = { ...channels, sms: { ...sms, sentToday: (sms.sentToday ?? 0) + 1 } };
      } else if (a.channel === 'email') {
        const box = Object.values(mailboxes)
          .filter((m) => m.sentToday < mailboxCap(m, out.limits))
          .sort((x, y) => x.sentToday - y.sentToday)[0];
        if (isCold(s, lead)) {
          // Cold email counts toward the daily limit; past it, it waits for tomorrow's window.
          if (!box) {
            const tomorrow = atClock(addDays(NOW, NOW.getDay() === 5 ? 3 : NOW.getDay() === 6 ? 2 : 1), '09:00');
            const queued: OutMessage = { ...msg, at: tomorrow, status: 'scheduled' };
            const { cap } = coldToday(s);
            return {
              ...s,
              out: { ...out, messages: [...out.messages, queued], leads: { ...out.leads, [lead.id]: { ...lead, status: 'queued' } } },
              toasts: h.toast(s, `Today’s limit of ${cap} cold emails is used up, so this one goes out ${fmtDay(tomorrow)} at 9:00 AM.`, { undo: true, tone: 'warn' }),
            };
          }
          mailboxes = { ...mailboxes, [box.id]: { ...box, sentToday: box.sentToday + 1 } };
          const after = coldToday({ ...s, out: { ...out, mailboxes } });
          note = ` · ${after.sent} of ${after.cap} cold emails today`;
        }
        msg.mailbox = box?.id ?? Object.keys(mailboxes)[0];
      } else if (a.channel === 'call') {
        const calls = out.channels.call;
        if (!calls?.connected) return { ...s, toasts: h.toast(s, 'The dialer isn’t connected. Connect it in Channels & limits.', { tone: 'warn' }) };
        channels = { ...channels, call: { ...calls, sentToday: (calls.sentToday ?? 0) + 1 } };
      } else if (!out.channels[a.channel]?.connected) {
        return { ...s, toasts: h.toast(s, `${out.channels[a.channel]?.name ?? a.channel} isn’t connected yet.`, { tone: 'warn' }) };
      }
      const nextLead: Lead = {
        ...lead,
        unread: false,
        status: lead.status === 'new' || lead.status === 'queued' ? 'contacted' : lead.status,
        firstReplyAt: lead.receivedAt && !lead.firstReplyAt ? at : lead.firstReplyAt,
      };
      const what = a.channel === 'sms' ? 'Texted' : a.channel === 'call' ? 'Called' : 'Emailed';
      return {
        ...s,
        out: { ...out, mailboxes, channels, leads: { ...out.leads, [lead.id]: nextLead }, messages: [...out.messages, msg] },
        activity: h.log(s, `${what} ${fullName(lead)} (${lead.company})`, 'send'),
        toasts: h.toast(s, `${a.channel === 'sms' ? 'Text sent' : a.channel === 'call' ? 'Call logged' : 'Sent'} to ${lead.first}${note}`, { undo: true }),
      };
    }

    case 'logCall': {
      const lead = out.leads[a.lead];
      if (!lead) return s;
      const at = liveNow();
      const msg: OutMessage = { id: mid('call'), lead: lead.id, channel: 'call', dir: 'out', at, body: a.notes ? `${a.outcome}. ${a.notes}` : a.outcome, outcome: a.outcome, status: 'sent' };
      const calls = out.channels.call;
      // A logged call ticks the campaign's call step, so the sequence moves on to the next one.
      const c = lead.campaign ? out.campaigns[lead.campaign] : undefined;
      const onCallStep = c && lead.step !== undefined && c.steps[lead.step]?.channel === 'call';
      const nextStep = onCallStep ? c!.steps[lead.step! + 1] : undefined;
      const stepped: Partial<Lead> = onCallStep ? { step: lead.step! + 1, nextAt: nextStep ? atClock(addDays(at, Math.max(1, nextStep.wait)), c!.schedule.start) : undefined } : {};
      const next: Lead = {
        ...lead,
        ...stepped,
        status: lead.status === 'new' || lead.status === 'queued' ? 'contacted' : lead.status,
        firstReplyAt: lead.receivedAt && !lead.firstReplyAt ? at : lead.firstReplyAt,
        notes: a.notes ? `${lead.notes ? `${lead.notes}\n` : ''}${fmtDay(at)} call: ${a.notes}` : lead.notes,
        callbackAt: a.callbackAt ?? (lead.callbackAt && lead.callbackAt <= at ? undefined : lead.callbackAt),
        callbackNote: a.callbackAt ? a.callbackNote : lead.callbackAt && lead.callbackAt <= at ? undefined : lead.callbackNote,
      };
      return {
        ...s,
        out: {
          ...out,
          messages: [...out.messages, msg],
          channels: calls ? { ...out.channels, call: { ...calls, sentToday: (calls.sentToday ?? 0) + 1 } } : out.channels,
          leads: { ...out.leads, [lead.id]: next },
        },
        activity: h.log(s, `Called ${fullName(lead)}: ${a.outcome}${a.notes ? ` (${a.notes})` : ''}`, 'send'),
        toasts: h.toast(s, `Call logged: ${a.outcome}${onCallStep ? ` · ${c!.name} moves to ${nextStep ? `step ${lead.step! + 2}` : 'done'}` : ''}${a.callbackAt ? ` · callback ${fmtDay(a.callbackAt)} ${fmtTime(a.callbackAt)}` : ''}`, { undo: true }),
      };
    }

    case 'label': {
      const lead = out.leads[a.lead];
      if (!lead) return s;
      const status: Lead['status'] =
        a.label === 'meeting' ? 'meeting' : a.label === 'interested' || a.label === 'question' ? 'interested' : a.label === 'not-interested' || a.label === 'wrong-person' ? 'not-interested' : a.label === 'unsubscribe' ? 'unsubscribed' : lead.status;
      return withLeads(s, { ...out.leads, [lead.id]: { ...lead, label: a.label ?? undefined, status, nextAt: a.label && a.label !== 'ooo' ? undefined : lead.nextAt } });
    }

    case 'read':
      return withLeads(s, patchLeads(s, [a.lead], (l) => ({ ...l, unread: false })));

    case 'mailbox':
      return { ...s, out: { ...out, mailboxes: { ...out.mailboxes, [a.mailbox.id]: a.mailbox } } };

    case 'removeMailbox': {
      const mailboxes = { ...out.mailboxes };
      delete mailboxes[a.id];
      const campaigns = Object.fromEntries(Object.entries(out.campaigns).map(([id, c]) => [id, { ...c, options: { ...c.options, mailboxes: c.options.mailboxes.filter((m) => m !== a.id) } }]));
      return { ...s, out: { ...out, mailboxes, campaigns }, toasts: h.toast(s, 'Mailbox removed', { undo: true }) };
    }

    case 'channel': {
      const c = out.channels[a.id];
      if (!c) return s;
      const next = { ...c, ...a.patch };
      return {
        ...s,
        out: { ...out, channels: { ...out.channels, [a.id]: next } },
        toasts: a.patch.connected !== undefined && a.patch.connected !== c.connected ? h.toast(s, `${c.name} ${next.connected ? 'connected' : 'disconnected'}`, { undo: true }) : s.toasts,
      };
    }

    case 'limits':
      return { ...s, out: { ...out, limits: { ...out.limits, ...a.patch } } };

    case 'form': {
      const f = out.forms[a.id];
      if (!f) return s;
      const next = { ...f, ...a.patch };
      return {
        ...s,
        out: { ...out, forms: { ...out.forms, [a.id]: next } },
        toasts: a.patch.connected !== undefined && a.patch.connected !== f.connected ? h.toast(s, `${f.name} ${next.connected ? 'connected. New submissions arrive here.' : 'disconnected'}`) : s.toasts,
      };
    }

    case 'submit': {
      const f = out.forms[a.form];
      if (!f) return s;
      const at = liveNow();
      let lead: Lead = { ...a.lead, source: 'form', form: f.id, list: 'list-forms', added: at, receivedAt: at, status: 'new', unread: true };
      const messages: OutMessage[] = [];
      const said: string[] = [];
      if (f.autoReply) {
        const t = out.templates[f.template];
        const reply = new Date(at.getTime() + 40000);
        if (t) {
          messages.push({ id: mid('auto'), lead: lead.id, channel: 'email', dir: 'out', at: reply, subject: t.subject ? fill(s, t.subject, lead).text : undefined, body: fill(s, t.body, lead).text, mailbox: Object.keys(out.mailboxes)[0], status: 'sent' });
          said.push('Timmy emailed back in 40 seconds');
        }
        if (f.textToo && /^y/i.test(lead.extra?.['Text me'] ?? '') && out.channels.sms?.connected && lead.phone) {
          const sms = out.templates['tpl-speed-sms'];
          if (sms) messages.push({ id: mid('sms'), lead: lead.id, channel: 'sms', dir: 'out', at: new Date(reply.getTime() + 5000), body: fill(s, sms.body, lead).text, status: 'sent' });
          said.push('and texted');
        }
        lead = { ...lead, firstReplyAt: reply, status: 'contacted' };
      }
      if (f.slack && out.channels.slack?.connected) said.push(`posted to ${out.channels.slack.account?.split('·')[1]?.trim() ?? 'Slack'}`);
      return {
        ...s,
        out: { ...out, leads: { ...out.leads, [lead.id]: lead }, messages: [...out.messages, ...messages] },
        activity: h.log(s, `New lead from ${f.name}: ${fullName(lead)}, ${lead.company}`, 'triage'),
        toasts: h.toast(s, `New lead from ${f.name}: ${fullName(lead)}. ${said.length ? `${said.join(', ')}. ` : ''}${f.autoReply ? '' : `Answer within ${f.sla} minutes.`}`.trim()),
      };
    }

    case 'post':
      return { ...s, out: { ...out, posts: { ...out.posts, [a.post.id]: a.post } }, toasts: h.toast(s, a.post.status === 'scheduled' ? `Post scheduled for ${fmtDay(a.post.at!)} at ${fmtTime(a.post.at!)}. It publishes once social accounts can connect.` : 'Draft saved') };

    case 'removePost': {
      const posts = { ...out.posts };
      delete posts[a.id];
      return { ...s, out: { ...out, posts }, toasts: h.toast(s, 'Post deleted', { undo: true }) };
    }

    case 'book': {
      const lead = out.leads[a.lead];
      if (!lead) return s;
      registerPerson({ id: lead.id, name: fullName(lead), email: lead.email, title: lead.title, company: lead.company });
      const title = a.showing ? `Showing: ${fullName(lead)} at ${a.showing}` : `Intro call: ${fullName(lead)}, ${lead.company}`;
      return {
        ...s,
        ws: applyOps(s.ws, [put('events', { id: `ev-${lead.id}-${a.start.getTime()}`, title, start: a.start, end: a.end, kind: 'meeting', with: [lead.id], note: a.showing ? `Showing at ${a.showing}. Booked from ${lead.form ? out.forms[lead.form]?.name ?? 'a lead source' : 'outbound'}.` : `Booked from outbound${lead.campaign ? `: ${out.campaigns[lead.campaign]?.name ?? ''}` : ''}.` })]),
        out: { ...out, leads: { ...out.leads, [lead.id]: { ...lead, status: 'meeting', label: 'meeting', unread: false, nextAt: undefined } } },
        activity: h.log(s, `Booked “${title}” for ${fmtDay(a.start)}, ${fmtTime(a.start)}`, 'calendar'),
        toasts: h.toast(s, `Invite sent to ${lead.first} for ${fmtDay(a.start)}, ${fmtTime(a.start)}`, { undo: true }),
      };
    }

    case 'toCrm': {
      const lead = out.leads[a.lead];
      if (!lead) return s;
      registerPerson({ id: lead.id, name: fullName(lead), email: lead.email, title: lead.title, company: lead.company });
      if (s.ws.contacts[lead.id]) return { ...s, toasts: h.toast(s, `${lead.first} is already in People`) };
      return {
        ...s,
        ws: applyOps(s.ws, [
          put('contacts', {
            id: lead.id,
            name: fullName(lead),
            email: lead.email,
            title: lead.title,
            company: lead.company,
            phone: lead.phone,
            location: lead.city,
            tracked: true,
            cadence: 'weekly',
            last: NOW,
            next: lead.status === 'meeting' ? 'Intro call' : 'Follow up on their reply',
            owner: 'me',
            about: `From outbound${lead.campaign ? ` (${out.campaigns[lead.campaign]?.name})` : lead.form ? ` (${out.forms[lead.form]?.name})` : ''}.`,
          }),
        ]),
        toasts: h.toast(s, `Added ${fullName(lead)} to People`, { undo: true }),
      };
    }
  }
}

/* ───────────── Launch checks ───────────── */

export const ctxOf = (s: State) => ({ offer: s.out.offer, sender: sender(), mailboxes: s.out.mailboxes, limits: s.out.limits });

/** When the campaign's next sending window opens. */
export function nextWindow(c: Campaign): Date {
  for (let i = 0; i < 8; i++) {
    const day = addDays(NOW, i);
    if (!c.schedule.days.includes(day.getDay())) continue;
    const open = atClock(day, c.schedule.start);
    const close = atClock(day, c.schedule.end);
    if (NOW < close) return NOW > open ? NOW : open;
  }
  return atClock(addDays(NOW, 1), c.schedule.start);
}

/** Why a campaign can't launch yet, in plain words, or null. */
export function launchProblem(s: State, c: Campaign): string | null {
  if (!c.leads.length) return 'Add leads before you launch.';
  if (!c.options.mailboxes.length) return 'Pick at least one mailbox to send from.';
  if (!c.schedule.days.length) return 'Pick at least one sending day.';
  const empty = c.steps.findIndex((st) => st.variants.some((v) => !v.body.trim() || (st.channel === 'email' && !v.subject.trim())));
  if (empty >= 0) return `Step ${empty + 1} is missing ${c.steps[empty]!.channel === 'email' ? 'a subject or body' : 'its text'}.`;
  const unknown = c.steps.flatMap((st) => st.variants.flatMap((v) => [...`${v.subject} ${v.body}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!))).find((k) => !(k in values({}, s.out.offer, SENDER)));
  if (unknown) return `{{${unknown}}} isn’t a variable Timmy knows. Pick one from Insert variable.`;
  const off = c.steps.find((st) => st.channel !== 'email' && !s.out.channels[st.channel]?.connected);
  if (off) return `${s.out.channels[off.channel]?.name ?? off.channel} isn’t connected. Connect it or remove that step.`;
  if (c.steps.some((st) => st.channel === 'sms')) {
    const noConsent = c.leads.map((id) => s.out.leads[id]).filter((l) => l && !canText(s, l)).length;
    if (noConsent) return `${plural(noConsent, 'lead')} haven’t agreed to texts. Cold texting needs consent: remove the text step or those leads.`;
  }
  return null;
}
