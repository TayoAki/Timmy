/*
 * What Ask Timmy can do with Outbound: text a lead who opted in, open a lead
 * by name, list today's calls, and log a call with notes. Where something
 * isn't possible (texting someone who never agreed, writing to an outside
 * CRM), it says exactly why and what would make it possible.
 */
import { NOW } from '../data/mock';
import { fmtDay, fmtTime, plural } from '../lib/format';
import type { ChatChoice, ChatLink } from '../state/assistant';
import { callQueue, leadIn, whenWords, pendingAcceptance } from '../state/leads';
import { canText, fill } from '../state/outbound';
import { enrichApp } from '../state/connect';
import { readFind } from '../lib/enrich';
import type { State } from '../state/store';
import { personName } from '../state/ws';
import { personIn } from './intents';
import type { Plan, WidgetCall } from './plan';

const answer = (args: { bullets?: string[]; links?: ChatLink[]; choices?: ChatChoice[]; preview?: string }): WidgetCall => ({
  name: 'show_answer',
  args: { bullets: args.bullets ?? [], links: args.links ?? [], choices: args.choices ?? [], preview: args.preview },
});
const no = (after: string): ChatChoice => ({ id: 'no', label: 'Not now', cancel: true, actions: [], after });
const full = (x: { first: string; last: string }) => `${x.first} ${x.last}`.trim();
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

/** What to say, from "text Jamie that I'm running late" or "…: see you at 9:15". */
const saidIn = (text: string) => text.match(/(?:\bsaying\b|\bthat\b|\bto say\b|:)\s*(.+)$/i)?.[1]?.trim().replace(/[.!]*$/, '');
/** "I'm running late" → "I'm running late." in a text from you. */
const asText = (said: string) => `${cap(said.replace(/\b(he|she|they)('re| are) /i, "you're ").replace(/\b(his|her|their)\b/gi, 'your'))}.`;

/** "Text Jamie that I'm running 5 minutes late", "send a text to Alex". */
export function textLead(s: State, l: string, text: string): Plan | null {
  if (!/^(?:please\s+)?(?:can you\s+|could you\s+)?(?:text|sms|send (?:a |an )?(?:text|sms)(?: message)?(?: to)?)\b/.test(l)) return null;
  const lead = leadIn(s, l);
  const sms = s.out.channels.sms;
  if (!lead) {
    const who = personIn(l);
    const optedIn = Object.values(s.out.leads).filter((x) => canText(s, x)).map((x) => x.first);
    return {
      steps: ['Looked for that person among your leads', 'Checked who agreed to texts'],
      text: who
        ? `I can only text leads who agreed to texts, from Outbound. ${personName(who)} is in People, and Timmy can’t text contacts there yet. I can draft an email instead.`
        : `I couldn’t find that lead. Leads who agreed to texts: ${optedIn.length ? optedIn.join(', ') : 'none yet'}.`,
      calls: [],
    };
  }
  if (!sms?.connected) return { steps: ['Checked your channels'], text: 'Texting isn’t connected. Connect it in Outbound › Channels & limits, then ask again.', calls: [answer({ links: [{ label: 'Channels & limits', href: 'outbound:channels' }] })] };
  if (!canText(s, lead)) {
    return {
      steps: [`Found ${full(lead)}`, 'Checked their texting consent'],
      text: `${lead.first} hasn’t agreed to texts${lead.phone ? '' : ', and there’s no phone number on file'}, so Timmy won’t text them. Email them instead, or ask on a call and record their yes.`,
      calls: [answer({ links: [{ label: `${full(lead)}, ${lead.company}`, href: `unibox:${lead.id}`, sub: 'Open the conversation' }] })],
    };
  }
  const said = saidIn(text);
  const body = said ? `Hi ${lead.first}, it’s Taylor. ${asText(said)}` : fill(s, s.out.templates['tpl-speed-sms']?.body ?? 'Hi {{firstName}}, it’s {{senderFirstName}}.', lead).text;
  const left = (sms.dailyLimit ?? 0) - (sms.sentToday ?? 0);
  return {
    steps: [`Found ${full(lead)}`, 'Checked their texting consent and today’s limit', 'Wrote the text'],
    text: `Here’s the text to ${lead.first} (${lead.phone}). ${left > 0 ? `${left} texts left today.` : 'Today’s text limit is used up, so it can’t go yet.'} Nothing is sent until you press Send.`,
    calls: [
      answer({
        preview: body,
        choices: left > 0 ? [{ id: 'yes', label: 'Send the text', primary: true, actions: [{ type: 'out', op: { op: 'send', lead: lead.id, channel: 'sms', body } }], after: `Texted ${lead.first}.`, open: `unibox:${lead.id}` }, no('Not sent.')] : [],
      }),
    ],
  };
}

/** "Who should I call today?", "my call list". */
export function callList(s: State, l: string): Plan | null {
  if (!/(who (should|do) i call|call list|calls? (for )?today|today'?s calls|call queue|who to call|calls? to make)/.test(l)) return null;
  const q = callQueue(s);
  const calls = s.out.channels.call;
  if (!q.length) return { steps: ['Checked forms, callbacks and campaign call steps'], text: 'No calls due today.', calls: [answer({ links: [{ label: 'Open the call list', href: 'outbound:calls' }] })] };
  return {
    steps: ['Checked forms, callbacks and campaign call steps', 'Put them in order'],
    text: `${plural(q.length, 'call')} today, most urgent first.${calls ? ` ${calls.sentToday ?? 0} of ${calls.dailyLimit ?? 0} calls logged so far.` : ''} Calls go through your phone; Timmy shows the script and logs how it went.`,
    calls: [
      answer({
        links: [
          ...q.slice(0, 8).map((x) => ({ label: `${full(x.lead)}, ${x.lead.company}`, href: `unibox:${x.lead.id}`, sub: `${x.why} · ${x.lead.phone}` })),
          { label: 'Open the call list', href: 'outbound:calls' },
        ],
      }),
    ],
  };
}

/** "Call Alex Kim": Timmy can't dial for you, but puts the number and script in front of you. */
export function callLead(s: State, l: string): Plan | null {
  const m = l.match(/^(?:please\s+)?(?:can you\s+)?(call|ring|phone|dial)\s+(.+)/);
  if (!m || /\b(list|queue|today)\b/.test(m[2]!)) return null;
  const lead = leadIn(s, l);
  if (!lead) return null;
  if (!lead.phone) return { steps: [`Found ${full(lead)}`], text: `There’s no phone number for ${lead.first}. Email them instead.`, calls: [answer({ links: [{ label: `${full(lead)}, ${lead.company}`, href: `unibox:${lead.id}` }] })] };
  return {
    steps: [`Found ${full(lead)}`, 'Pulled up the number and script'],
    text: `Timmy can’t place calls itself. ${lead.first}’s number is ${lead.phone}: open the conversation and press Call to dial on your phone, follow the script and log how it went.`,
    calls: [answer({ links: [{ label: `${full(lead)}, ${lead.company}`, href: `unibox:${lead.id}`, sub: `Call ${lead.phone}` }] })],
  };
}

/** "Find Alex Kim", "show me the Riverstone lead", "where's Jamie?". */
export function findLead(s: State, l: string): Plan | null {
  if (!/\b(find|show|open|pull up|look up|where('?s| is)|lead|status of)\b/.test(l)) return null;
  const lead = leadIn(s, l);
  if (!lead) return null;
  const c = lead.campaign ? s.out.campaigns[lead.campaign] : undefined;
  const yes = pendingAcceptance(s, lead);
  const facts = [
    `${lead.title ? `${lead.title}, ` : ''}${lead.company}${lead.city ? `, ${lead.city}` : ''}`,
    `Status: ${lead.status.replace('-', ' ')}${lead.label ? ` · ${lead.label.replace('-', ' ')}` : ''}`,
    lead.source === 'form' ? `From ${s.out.forms[lead.form ?? '']?.name ?? 'a form'}${lead.receivedAt ? `, ${fmtDay(lead.receivedAt)} ${fmtTime(lead.receivedAt)}` : ''}` : c ? `In “${c.name}”${lead.step !== undefined ? `, step ${Math.min(lead.step + 1, c.steps.length)} of ${c.steps.length}` : ''}` : 'Not in a campaign',
    yes ? `Agreed to ${whenWords(yes.at)}: not booked yet` : '',
    lead.callbackAt ? `Callback ${fmtDay(lead.callbackAt)} ${fmtTime(lead.callbackAt)}` : '',
  ].filter(Boolean);
  return {
    steps: ['Looked through your leads'],
    text: `${full(lead)} at ${lead.company}.`,
    calls: [answer({ bullets: facts, links: [{ label: 'Open the conversation', href: `unibox:${lead.id}` }] })],
  };
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
/** "call back Thursday" → Thursday 10:00 AM; "tomorrow" → tomorrow; otherwise the next working day. */
function callbackDay(t: string): Date {
  const x = t.toLowerCase();
  const base = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 10, 0);
  const named = DAYS.findIndex((d) => x.includes(d));
  const ahead = /\btoday\b|this afternoon/.test(x) ? 0 : /\btomorrow\b/.test(x) ? 1 : named >= 0 ? (named - NOW.getDay() + 7) % 7 || 7 : NOW.getDay() === 5 ? 3 : 1;
  const at = new Date(base.getFullYear(), base.getMonth(), base.getDate() + ahead, ahead === 0 ? 15 : 10, 0);
  return at;
}

/** "Log my call with Alex: wants pricing for 2 sites, call back Thursday". */
export function logCallNotes(s: State, l: string, text: string): Plan | null {
  if (!/\blog\b/.test(l) || !/\b(call|notes?|meeting)\b/.test(l)) return null;
  const lead = leadIn(s, l);
  const crm = /\b(crm|hubspot|salesforce)\b/.test(l);
  if (!lead) {
    return {
      steps: ['Looked for the lead', 'Checked the CRM connection'],
      text: crm
        ? 'I can log calls with notes on an outbound lead, like “log my call with Alex Kim: wants a demo Thursday”. Writing call activity to HubSpot or Salesforce needs a CRM connection, and every write waits for your approval (or RevOps’) once it’s connected.'
        : 'Which lead? Say “log my call with <name>: <what happened>”.',
      calls: crm ? [answer({ links: [{ label: 'Connections', href: 'connections' }] })] : [],
    };
  }
  const notes = saidIn(text) ?? '';
  const callback = /call (?:them |him |her )?back|callback|follow up/i.test(notes) ? callbackDay(notes) : undefined;
  const outcome = /voicemail/i.test(notes) ? 'No answer, left a voicemail' : /no answer/i.test(notes) ? 'No answer' : /not (now|interested)/i.test(notes) ? 'Connected: not now' : 'Connected: interested';
  return {
    steps: [`Found ${full(lead)}`, 'Read your notes'],
    text: `Log a call with ${lead.first} as “${outcome}”${notes ? ' with your notes' : ''}?${callback ? ` I’ll also set a callback for ${whenWords(callback)}; it shows on the call list that day.` : ''}${crm ? ' It goes on the lead in Timmy; HubSpot or Salesforce get it once a CRM is connected.' : ''}`,
    calls: [
      answer({
        preview: notes || undefined,
        choices: [
          { id: 'yes', label: 'Log the call', primary: true, actions: [{ type: 'out', op: { op: 'logCall', lead: lead.id, outcome, notes: notes || undefined, callbackAt: callback, callbackNote: callback ? notes : undefined } }], after: `Logged the call with ${lead.first}.`, open: `unibox:${lead.id}` },
          no('Not logged.'),
        ],
      }),
    ],
  };
}

/** "Find 10 dental practices in Austin": Timmy finds, adds and enriches leads itself, within your limits. */
export function findNewLeads(s: State, l: string, text: string): Plan | null {
  if (!/\b(find|get|source|prospect|look for|search for|pull)\b/.test(l) || !/\b(new )?(leads?|prospects?|clinics?|practices|companies|accounts|firms|offices|people like)\b/.test(l)) return null;
  if (leadIn(s, l) && !/\d/.test(l)) return null;
  const e = s.conn.enrich;
  const want = readFind(text);
  const room = Math.max(0, e.perDay - e.foundToday);
  const n = Math.min(want.count, room);
  const app = enrichApp(s);
  const where = [want.industry ? `${want.industry} ` : '', want.city ? `in ${want.city}` : ''].join('').trim();
  if (!n) return { steps: ['Checked today’s limit'], text: `Timmy already added ${e.perDay} leads today, the daily limit in Connections › Enrichment.`, calls: [answer({ links: [{ label: 'Connections', href: 'connections' }] })] };
  const find = { type: 'conn' as const, op: { op: 'find' as const, query: text, quiet: true } };
  const what = `${plural(n, 'lead')} that fit “${s.out.offer.name}”${where ? ` (${where})` : ''}`;
  const links = [{ label: 'Found by Timmy', href: 'outbound:leads', sub: 'Your new leads' }];
  if (e.autoFind) {
    return {
      steps: [`Searched ${app ? app.name : 'for leads'} for ${what}`, app ? `Enriched them with ${app.name}` : 'Skipped enrichment: no provider connected', 'Added them to “Found by Timmy”'],
      text: `I added ${what} to “Found by Timmy”${app ? `, enriched with ${app.name} (about ${n * (app.credits ?? 1)} credits)` : ''}. Nothing was sent. Ask me to write a campaign for them when you’re ready.`,
      effects: [find],
      calls: [answer({ links })],
    };
  }
  return {
    steps: [`Searched for ${what}`],
    text: `I can add ${what}${app ? ` and enrich them with ${app.name}` : ''}. You’ve set Timmy to ask first.`,
    calls: [answer({ choices: [{ id: 'yes', label: `Add ${plural(n, 'lead')}`, primary: true, actions: [find], after: `Added ${plural(n, 'lead')} to “Found by Timmy”.`, open: 'outbound:leads' }, no('Nothing added.')], links })],
  };
}
