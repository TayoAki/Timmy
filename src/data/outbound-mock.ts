/*
 * Sample outbound workspace: a 48-lead list you imported, your offer (a
 * 90-day operations pilot), built-in templates, one campaign two weeks in,
 * three sending mailboxes held to 30 cold emails a day, connected channels,
 * website and Typeform leads for speed to lead, and two social drafts.
 *
 * Leads use .example domains and 555-01xx numbers: none of them are real.
 */
import { run, type ScriptedReply, type Sender } from '../lib/outbound';
import { NOW } from './mock';
import type { Campaign, ChannelConn, FormSource, Lead, LeadList, Limits, Mailbox, Offer, Outbound, OutMessage, SocialPost, Template } from './outbound-types';

const d = (day: number, h = 9, m = 0, month = 10) => new Date(2026, month, day, h, m);

export const SENDER: Sender = { first: 'Taylor', name: 'Taylor Morgan', company: 'Northpeak' };

export const OFFER: Offer = {
  name: '90-day operations pilot',
  product: 'Northpeak, an operations platform that replaces the spreadsheets behind intake, scheduling and reporting',
  audience: 'Heads of operations at 20–250 person healthcare and services companies',
  pain: 'core workflows still run on spreadsheets and email',
  hook: 'spreadsheets',
  outcome: 'two workflows moved off spreadsheets in 90 days',
  proof: 'Brightwave cut weekly reporting from 6 hours to 40 minutes in the first month.',
  cta: 'Open to a 20-minute call next week?',
  price: '$18,000 for the 90-day pilot',
  icp: { titles: ['Operations', 'COO', 'Chief Operating', 'Practice Manager', 'Chief of Staff'], industries: ['Health', 'Medical', 'Dental', 'Staffing', 'Logistics', 'Facilities', 'Veterinary'], minEmployees: 20, maxEmployees: 250 },
};

/* ───────────── The imported list ───────────── */

const FIRST = ['Avery', 'Jordan', 'Morgan', 'Riley', 'Casey', 'Quinn', 'Harper', 'Rowan', 'Emerson', 'Sasha', 'Devon', 'Parker', 'Reese', 'Logan', 'Hayden', 'Skyler', 'Dakota', 'Finley', 'Blair', 'Elliot', 'Marisol', 'Tomasz', 'Ifeoma', 'Kenta', 'Lucia', 'Rahul', 'Gwen', 'Mateo', 'Nadia', 'Owen', 'Priyanka', 'Samir', 'Talia', 'Viktor', 'Wen', 'Yara', 'Zane', 'Bianca', 'Cyrus', 'Delia', 'Esme', 'Felix', 'Gianna', 'Hugo', 'Ines', 'Jonah', 'Kiara', 'Leon'];
const LAST = ['Chen', 'Okafor', 'Reyes', 'Novak', 'Haddad', 'Lindqvist', 'Mensah', 'Duarte', 'Fischer', 'Kowalski', 'Ibarra', 'Nakamura', 'Osei', 'Petrov', 'Quintero', 'Rossi', 'Sato', 'Tran', 'Ueda', 'Vargas', 'Walsh', 'Xu', 'Yilmaz', 'Zhou', 'Abbott', 'Baptiste', 'Castillo', 'Delgado', 'Eriksen', 'Ferraro', 'Gallo', 'Hughes', 'Iyer', 'Jensen', 'Kaur', 'Larsen', 'Moreau', 'Nolan', 'Ortiz', 'Park', 'Qureshi', 'Ramos', 'Shah', 'Tanaka', 'Usman', 'Volkov', 'Weber', 'Young'];
const PREFIX = ['Harborview', 'Pinecrest', 'Meridian', 'Bluefield', 'Summit', 'Clearwater', 'Oakline', 'Northgate', 'Silverline', 'Brookside', 'Redwood', 'Lakeshore', 'Cedar Point', 'Westbrook', 'Ironwood', 'Maple Ridge', 'Riverbend', 'Stonegate', 'Highland', 'Fairhaven', 'Granite', 'Willow Creek', 'Bayside', 'Crescent'];
const HEALTH: [string, string, string[]][] = [
  ['Clinics', 'Hospitals & Health Care', ['patient intake', 'scheduling', 'referrals']],
  ['Dental Group', 'Dental Practices', ['scheduling', 'billing', 'recall reminders']],
  ['Home Health', 'Home Health Care', ['scheduling', 'field ops', 'compliance']],
  ['Physical Therapy', 'Medical Practices', ['patient intake', 'billing', 'telehealth']],
  ['Family Medicine', 'Medical Practices', ['referrals', 'ehr', 'patient intake']],
  ['Imaging', 'Hospitals & Health Care', ['scheduling', 'reporting', 'billing']],
  ['Veterinary', 'Veterinary Services', ['scheduling', 'inventory', 'client reminders']],
  ['Urgent Care', 'Hospitals & Health Care', ['patient intake', 'staffing', 'billing']],
];
const SERVICES: [string, string, string[]][] = [
  ['Staffing', 'Staffing & Recruiting', ['timesheets', 'onboarding', 'compliance']],
  ['Logistics', 'Logistics & Supply Chain', ['dispatch', 'invoicing', 'tracking']],
  ['Facilities', 'Facilities Services', ['field ops', 'dispatch', 'invoicing']],
  ['Property Management', 'Real Estate', ['maintenance requests', 'leasing', 'invoicing']],
  ['Accounting', 'Accounting', ['client onboarding', 'deadlines', 'document collection']],
  ['Legal', 'Law Practice', ['intake', 'billing', 'document review']],
  ['Insurance Partners', 'Insurance', ['claims', 'renewals', 'onboarding']],
  ['Engineering', 'Civil Engineering', ['project tracking', 'timesheets', 'bids']],
];
const TITLES = ['Head of Operations', 'VP of Operations', 'Director of Operations', 'COO', 'Operations Manager', 'Practice Manager', 'Chief of Staff', 'Office Manager', 'Director of Patient Access', 'VP Finance', 'Founder & CEO', 'Head of Revenue Operations'];
const CITIES = ['Boston, MA', 'Austin, TX', 'Denver, CO', 'Chicago, IL', 'Nashville, TN', 'Raleigh, NC', 'Portland, OR', 'Columbus, OH', 'Phoenix, AZ', 'Atlanta, GA', 'Minneapolis, MN', 'Tampa, FL'];
const SIZES = [64, 38, 120, 46, 210, 28, 85, 52, 160, 33, 74, 18, 240, 41, 95, 57, 12, 135, 66, 22, 310, 49, 180, 70];

const slug = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const LIST: LeadList = { id: 'list-ops', name: 'Ops leaders: healthcare & services', source: 'csv', created: d(2, 15, 40) };

function makeLeads(): Lead[] {
  return FIRST.map((first, i) => {
    const [suffix, industry, keywords] = (i < 24 ? HEALTH : SERVICES)[i % 8]!;
    const company = `${PREFIX[(i * 7) % 24]} ${suffix}`;
    const domain = `${slug(company)}.example`;
    const last = LAST[i]!;
    return {
      id: `lead-${i + 1}`,
      first,
      last,
      email: i === 44 ? '' : `${first.toLowerCase()}.${last.toLowerCase()}@${domain}`,
      phone: `+1 555 01${String(10 + i).padStart(2, '0')}`,
      title: TITLES[(i * 5) % TITLES.length],
      company,
      website: `https://${domain}`,
      linkedin: `https://www.linkedin.com/in/${slug(first + ' ' + last)}-example`,
      employees: SIZES[i % SIZES.length],
      industry,
      keywords,
      city: CITIES[(i * 3) % CITIES.length],
      source: 'import',
      list: LIST.id,
      added: d(2, 15, 40),
      status: 'new',
    } satisfies Lead;
  });
}

/* ───────────── Templates ───────────── */

export const TEMPLATES: Template[] = [
  {
    id: 'tpl-intro',
    name: 'Cold intro: problem, proof, ask',
    channel: 'email',
    kind: 'intro',
    subject: '{{companyName}} + spreadsheets',
    body: 'Hi {{firstName}},\n\nQuick one: are {{companyName}}’s intake and scheduling still running on spreadsheets? Most {{industry}} teams your size tell me {{offerPain}}, and it eats hours every week.\n\n{{offerProof}}\n\nWe run a 90-day pilot aimed at {{offerOutcome}}. {{offerCta}}\n\nBest,\n{{senderFirstName}}',
    builtIn: true,
  },
  {
    id: 'tpl-intro-b',
    name: 'Cold intro: short question',
    channel: 'email',
    kind: 'intro',
    subject: 'question about {{companyName}} ops',
    body: 'Hi {{firstName}},\n\nWho owns the spreadsheets behind scheduling at {{companyName}}? If it’s you, I have a 90-day pilot that aims for {{offerOutcome}}.\n\n{{offerCta}}\n\n{{senderFirstName}}',
    builtIn: true,
  },
  {
    id: 'tpl-bump',
    name: 'Follow-up: bump',
    channel: 'email',
    kind: 'follow-up',
    subject: 'Re: {{companyName}} + spreadsheets',
    body: 'Hi {{firstName}},\n\nFloating this back up in case it got buried. Worth 20 minutes to see if the pilot fits {{companyName}}?\n\n{{senderFirstName}}',
    builtIn: true,
  },
  {
    id: 'tpl-case',
    name: 'Follow-up: case study',
    channel: 'email',
    kind: 'case-study',
    subject: 'how Brightwave got 5 hours a week back',
    body: 'Hi {{firstName}},\n\n{{offerProof}} They started with one workflow and had it live in three weeks.\n\nIf {{companyName}} has a workflow like that, I can show you what the pilot would look like. {{offerCta}}\n\n{{senderFirstName}}',
    builtIn: true,
  },
  {
    id: 'tpl-breakup',
    name: 'Break-up: close the loop',
    channel: 'email',
    kind: 'break-up',
    subject: 'close the loop?',
    body: 'Hi {{firstName}},\n\nI haven’t heard back, so I’ll assume the timing isn’t right and stop here. If spreadsheets start slowing {{companyName}} down, just reply and I’ll pick it up.\n\nBest,\n{{senderFirstName}}',
    builtIn: true,
  },
  {
    id: 'tpl-call',
    name: 'Call: first call',
    channel: 'call',
    kind: 'call',
    body: 'Hi {{firstName}}, it’s {{senderFirstName}} from {{senderCompany}}. I emailed about the spreadsheets behind scheduling. Do you have 30 seconds?\n\n• Ask: which workflow takes the most manual time?\n• Proof: {{offerProof}}\n• Close: {{offerCta}}',
    builtIn: true,
  },
  {
    id: 'tpl-speed',
    name: 'Speed to lead: first reply',
    channel: 'email',
    kind: 'speed',
    subject: 'Your Northpeak demo',
    body: 'Hi {{firstName}},\n\nThanks for reaching out. I can walk you through Northpeak {{slot1}} or {{slot2}}. Which works better? If neither, reply with a time and I’ll make it work.\n\nBest,\n{{senderFirstName}}',
    builtIn: true,
  },
  {
    id: 'tpl-speed-sms',
    name: 'Speed to lead: text (with consent)',
    channel: 'sms',
    kind: 'sms',
    body: 'Hi {{firstName}}, it’s {{senderFirstName}} from {{senderCompany}}. Got your request. Is {{slot1}} good for a quick call? Reply STOP to opt out.',
    builtIn: true,
  },
  {
    id: 'tpl-reply-times',
    name: 'Reply: offer times',
    channel: 'email',
    kind: 'reply',
    subject: 'Re: times',
    body: 'Hi {{firstName}},\n\nGreat to hear. Does {{slot1}} or {{slot2}} work? I’ll send an invite as soon as you pick one.\n\nBest,\n{{senderFirstName}}',
    builtIn: true,
  },
  {
    id: 'tpl-reply-price',
    name: 'Reply: price question',
    channel: 'email',
    kind: 'reply',
    subject: 'Re: pilot pricing',
    body: 'Hi {{firstName}},\n\nThe pilot is a flat $18,000 for 90 days, including setup and training. Most teams pick one or two workflows to start.\n\nHappy to walk through what that would look like for {{companyName}}: {{slot1}} or {{slot2}}?\n\nBest,\n{{senderFirstName}}',
    builtIn: true,
  },
];

const tpl = (id: string) => TEMPLATES.find((t) => t.id === id)!;
const v = (id: string, t: Template) => ({ id, subject: t.subject ?? '', body: t.body });

/* ───────────── The campaign two weeks in ───────────── */

export const OPS_CAMPAIGN: Campaign = {
  id: 'camp-ops',
  name: 'Ops pilot: healthcare & services',
  status: 'active',
  created: d(2, 16),
  launched: d(3, 9),
  leads: Array.from({ length: 36 }, (_, i) => `lead-${i + 1}`),
  steps: [
    { id: 'st1', channel: 'email', wait: 0, variants: [v('a', tpl('tpl-intro')), v('b', tpl('tpl-intro-b'))] },
    { id: 'st2', channel: 'email', wait: 3, variants: [v('a', tpl('tpl-bump'))] },
    { id: 'st3', channel: 'call', wait: 2, variants: [{ id: 'a', subject: '', body: tpl('tpl-call').body }] },
    { id: 'st4', channel: 'email', wait: 3, variants: [v('a', tpl('tpl-case'))] },
    { id: 'st5', channel: 'email', wait: 4, variants: [v('a', tpl('tpl-breakup'))] },
  ],
  schedule: { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', tz: 'America/New_York' },
  options: { dailyLimit: 30, mailboxes: ['mb-1', 'mb-2'], stopOnReply: true, trackOpens: true, unsubscribe: true, plainText: true },
};

const DRAFT_CAMPAIGN: Campaign = {
  id: 'camp-dental',
  name: 'Dental groups: follow-up list',
  status: 'draft',
  created: d(13, 14),
  leads: [],
  steps: [
    { id: 'st1', channel: 'email', wait: 0, variants: [{ id: 'a', subject: '', body: '' }] },
  ],
  schedule: { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', tz: 'America/New_York' },
  options: { dailyLimit: 20, mailboxes: ['mb-3'], stopOnReply: true, trackOpens: false, unsubscribe: true, plainText: true },
};

export const MAILBOXES: Mailbox[] = [
  { id: 'mb-1', address: 'taylor@trynorthpeak.io', name: 'Taylor Morgan', dailyLimit: 30, warmup: true, health: 96, sentToday: 0, added: new Date(2026, 8, 20) },
  { id: 'mb-2', address: 't.morgan@trynorthpeak.io', name: 'Taylor Morgan', dailyLimit: 30, warmup: true, health: 93, sentToday: 0, added: new Date(2026, 8, 20) },
  { id: 'mb-3', address: 'taylor@getnorthpeak.io', name: 'Taylor Morgan', dailyLimit: 30, warmup: true, health: 88, sentToday: 0, added: d(12, 10) },
];

export const LIMITS: Limits = {
  perMailbox: 30,
  maxPerMailbox: 50,
  rampStart: 10,
  rampStep: 3,
  gapMinutes: [4, 9],
  bouncePause: 0.03,
  sms: { perDay: 100, quietStart: '08:00', quietEnd: '20:00' },
  calls: { perDay: 60 },
};

export const CHANNELS: ChannelConn[] = [
  { id: 'email', name: 'Email', connected: true, account: '3 sending mailboxes', use: 'Cold email from secondary domains; replies land in the unibox.' },
  { id: 'sms', name: 'Text messages', connected: true, account: '+1 (555) 010-2048', use: 'Texts to leads who opted in, like form leads who ticked “text me”.', dailyLimit: 100, sentToday: 2 },
  { id: 'call', name: 'Phone', connected: true, account: 'Browser dialer · +1 (555) 010-2048', use: 'Call steps become a call list with the script; outcomes are logged.', dailyLimit: 60, sentToday: 0 },
  { id: 'slack', name: 'Slack', connected: true, account: 'Northpeak · #new-leads', use: 'New form leads and hot replies are posted to the channel.' },
  { id: 'linkedin', name: 'LinkedIn', connected: false, use: 'Connection requests and messages as sequence steps.' },
  { id: 'whatsapp', name: 'WhatsApp', connected: false, use: 'Replies to leads who message you first.' },
  { id: 'calendar', name: 'Google Calendar', connected: true, account: 'taylor@northpeak.io', use: 'Finds free times for replies and books meetings.' },
];

/* ───────────── What has happened so far ───────────── */

const SCRIPT: Record<string, ScriptedReply> = {
  'lead-2': { afterStep: 0, label: 'interested', hours: 3, unread: true, body: 'Hi Taylor,\n\nTiming is actually good. We’re drowning in intake spreadsheets since we opened the second location. Can you send a couple of times next week?\n\nJordan' },
  'lead-5': { afterStep: 1, label: 'question', hours: 20, unread: true, body: 'What does the pilot cost, and do you integrate with Athena? If yes, I’d take a call.\n\nCasey' },
  'lead-9': { afterStep: 0, label: 'ooo', hours: 1, body: 'I’m out of the office until Wednesday, Nov 18 with limited access to email. For urgent matters, contact the front desk.' },
  'lead-12': { afterStep: 1, label: 'not-interested', hours: 5, body: 'Not a fit for us right now, thanks.' },
  'lead-14': { afterStep: 0, label: 'meeting', hours: 2, body: 'Sure. Thursday at 4:30 works. Send me an invite.\n\nLogan' },
  'lead-20': { afterStep: 2, label: 'interested', hours: 6, unread: true, body: 'Taylor, sorry I missed your call. Send me the details by email and I’ll loop in our COO.\n\nElliot' },
  'lead-23': { afterStep: 0, label: 'wrong-person', hours: 4, body: 'I’m not the right person for this. Try Dana Ruiz, our COO.' },
  'lead-27': { afterStep: 1, label: 'unsubscribe', hours: 2, body: 'Please remove me from your list.' },
};
const BOUNCES = new Set(['lead-31']);

function history() {
  const leads = Object.fromEntries(makeLeads().map((l) => [l.id, l]));
  const r = run(OPS_CAMPAIGN, leads, { offer: OFFER, sender: SENDER, mailboxes: Object.fromEntries(MAILBOXES.map((m) => [m.id, m])), limits: LIMITS }, d(3, 9), d(14, 0), { history: true, script: SCRIPT, bounces: BOUNCES });
  for (const [id, l] of Object.entries(r.leads)) leads[id] = { ...l, campaign: OPS_CAMPAIGN.id };
  // You already answered Logan and booked the call.
  const logan = leads['lead-14']!;
  const asked = r.messages.find((m) => m.lead === 'lead-14' && m.dir === 'in');
  const booked: OutMessage = { id: 'camp-ops-lead-14-you', lead: 'lead-14', channel: 'email', dir: 'out', at: new Date(asked!.at.getTime() + 40 * 60000), subject: asked!.subject, body: 'Hi Logan,\n\nInvite sent for Thursday, Nov 19 at 4:30 PM. Talk then.\n\nBest,\nTaylor', mailbox: 'mb-1', status: 'opened' };
  leads['lead-14'] = { ...logan, status: 'meeting', label: 'meeting' };
  return { leads, messages: [...r.messages, booked] };
}

/* ───────────── Speed to lead ───────────── */

export const FORMS: FormSource[] = [
  { id: 'form-demo', name: 'Website: Book a demo', kind: 'website', connected: true, sla: 5, autoReply: true, textToo: true, slack: true, template: 'tpl-speed' },
  { id: 'form-pilot', name: 'Typeform: Pilot application', kind: 'typeform', connected: true, sla: 15, autoReply: false, textToo: false, slack: true, template: 'tpl-speed' },
  { id: 'form-fb', name: 'Facebook Lead Ads', kind: 'facebook', connected: false, sla: 5, autoReply: true, textToo: false, slack: false, template: 'tpl-speed' },
  { id: 'form-hook', name: 'Any form: webhook', kind: 'webhook', connected: false, sla: 10, autoReply: false, textToo: false, slack: false, template: 'tpl-speed' },
];

const formLead = (l: Partial<Lead> & Pick<Lead, 'id' | 'first' | 'last' | 'email' | 'company' | 'form' | 'receivedAt'>): Lead => ({
  source: 'form',
  list: 'list-forms',
  added: l.receivedAt!,
  status: 'new',
  ...l,
});

function formLeads(): { leads: Lead[]; messages: OutMessage[] } {
  const leads = [
    formLead({ id: 'form-1', first: 'Jamie', last: 'Ortega', email: 'jamie@riverstone-physio.example', phone: '+1 555 0181', company: 'Riverstone Physio', title: 'Clinic Director', employees: 34, industry: 'Medical Practices', form: 'form-demo', receivedAt: d(15, 18, 40), firstReplyAt: new Date(d(15, 18, 40).getTime() + 45000), message: 'We run 3 clinics on spreadsheets. Looking for something before January.', status: 'interested', label: 'interested', unread: true, extra: { 'Text me': 'Yes' } }),
    formLead({ id: 'form-2', first: 'Morgan', last: 'Lee', email: 'morgan.lee@clearpath-staffing.example', company: 'Clearpath Staffing', title: 'Director of Operations', employees: 88, industry: 'Staffing & Recruiting', form: 'form-pilot', receivedAt: d(13, 11, 2), firstReplyAt: d(13, 11, 16), message: 'Timesheets and onboarding are our biggest pain. 88 people, 6 recruiters.', status: 'contacted' }),
    formLead({ id: 'form-3', first: 'Alex', last: 'Kim', email: 'alex.kim@brightline-imaging.example', phone: '+1 555 0184', company: 'Brightline Imaging', title: 'Practice Manager', employees: 52, industry: 'Hospitals & Health Care', form: 'form-pilot', receivedAt: d(16, 8, 6), message: 'Can you handle scheduling across two locations? Need to decide this month.', extra: { 'Text me': 'No' } }),
    formLead({ id: 'form-4', first: 'Sam', last: 'Patel', email: 'sam@northshore-vet.example', phone: '+1 555 0187', company: 'Northshore Veterinary', title: 'Owner', employees: 21, industry: 'Veterinary Services', form: 'form-demo', receivedAt: d(16, 7, 58), firstReplyAt: new Date(d(16, 7, 58).getTime() + 40000), message: 'Interested in a demo for our front desk team.', status: 'contacted', extra: { 'Text me': 'Yes' } }),
    formLead({ id: 'form-5', first: 'Robin', last: 'Hale', email: 'robin.hale@summit-logistics.example', company: 'Summit Freight', title: 'COO', employees: 140, industry: 'Logistics & Supply Chain', form: 'form-demo', receivedAt: d(12, 14, 20), firstReplyAt: new Date(d(12, 14, 20).getTime() + 52000), message: 'Dispatch is a mess. Demo please.', status: 'meeting', label: 'meeting' }),
    formLead({ id: 'form-6', first: 'Chris', last: 'Doyle', email: 'chris@doyle-legal.example', company: 'Doyle Legal', title: 'Office Manager', employees: 14, industry: 'Law Practice', form: 'form-pilot', receivedAt: d(10, 9, 30), firstReplyAt: d(10, 10, 41), message: 'Looking at options for client intake.', status: 'not-interested', label: 'not-interested' }),
  ];
  const auto = (l: Lead, sms: boolean): OutMessage[] => [
    { id: `${l.id}-auto`, lead: l.id, channel: 'email', dir: 'out', at: l.firstReplyAt!, subject: 'Your Northpeak demo', body: `Hi ${l.first},\n\nThanks for reaching out. I can walk you through Northpeak tomorrow at 9:15 AM or Wednesday at 10:30 AM. Which works better?\n\nBest,\nTaylor`, mailbox: 'mb-1', status: 'opened' },
    ...(sms ? [{ id: `${l.id}-sms`, lead: l.id, channel: 'sms' as const, dir: 'out' as const, at: new Date(l.firstReplyAt!.getTime() + 5000), body: `Hi ${l.first}, it’s Taylor from Northpeak. Got your request. Is tomorrow at 9:15 AM good for a quick call? Reply STOP to opt out.`, status: 'sent' as const }] : []),
  ];
  const messages: OutMessage[] = [
    { id: 'form-1-in', lead: 'form-1', channel: 'sms', dir: 'in', at: d(15, 19, 3), body: 'Monday morning works! 9:15 is great.' },
    ...auto(leads[0]!, true),
    { id: 'form-2-you', lead: 'form-2', channel: 'email', dir: 'out', at: d(13, 11, 16), subject: 'Re: Pilot application', body: 'Hi Morgan,\n\nThanks for applying. Timesheets and onboarding are exactly where pilots start. Could we talk Tuesday or Wednesday?\n\nBest,\nTaylor', mailbox: 'mb-1', status: 'opened' },
    ...auto(leads[3]!, true),
    ...auto(leads[4]!, false),
    { id: 'form-5-in', lead: 'form-5', channel: 'email', dir: 'in', at: d(12, 15, 5), subject: 'Re: Your Northpeak demo', body: 'Tomorrow at 9:15 works.' },
    { id: 'form-6-you', lead: 'form-6', channel: 'email', dir: 'out', at: d(10, 10, 41), subject: 'Re: Pilot application', body: 'Hi Chris,\n\nThanks for applying. Do you have 20 minutes this week?\n\nBest,\nTaylor', mailbox: 'mb-1', status: 'opened' },
    { id: 'form-6-in', lead: 'form-6', channel: 'email', dir: 'in', at: d(10, 16, 0), subject: 'Re: Pilot application', body: 'We went with another tool, thanks anyway.' },
  ];
  return { leads, messages };
}

/* ───────────── Social (coming soon) ───────────── */

const POSTS: SocialPost[] = [
  { id: 'post-1', networks: ['linkedin'], text: '3 signs your ops team has outgrown spreadsheets:\n\n1. Two people keep two versions of the schedule.\n2. Reporting takes a day every week.\n3. New hires learn the workarounds before the work.\n\nWhich one is you?', at: d(18, 9), status: 'scheduled', created: d(13, 16) },
  { id: 'post-2', networks: ['linkedin', 'x'], text: 'Brightwave cut weekly reporting from 6 hours to 40 minutes. Here’s the one workflow they moved first.', status: 'draft', created: d(14, 10) },
];

/* ───────────── Everything together ───────────── */

export function outboundSeed(): Outbound {
  const h = history();
  const f = formLeads();
  const leads: Record<string, Lead> = { ...h.leads };
  for (const l of f.leads) leads[l.id] = l;
  return {
    leads,
    lists: { [LIST.id]: LIST, 'list-forms': { id: 'list-forms', name: 'Form leads', source: 'form', created: d(1, 9) } },
    offer: OFFER,
    templates: Object.fromEntries(TEMPLATES.map((t) => [t.id, t])),
    campaigns: { [OPS_CAMPAIGN.id]: OPS_CAMPAIGN, [DRAFT_CAMPAIGN.id]: DRAFT_CAMPAIGN },
    mailboxes: Object.fromEntries(MAILBOXES.map((m) => [m.id, m])),
    channels: Object.fromEntries(CHANNELS.map((c) => [c.id, c])),
    limits: LIMITS,
    messages: [...h.messages, ...f.messages].sort((a, b) => a.at.getTime() - b.at.getTime()),
    forms: Object.fromEntries(FORMS.map((x) => [x.id, x])),
    posts: Object.fromEntries(POSTS.map((p) => [p.id, p])),
  };
}

export { NOW };
