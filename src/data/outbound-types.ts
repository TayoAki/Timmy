/*
 * Outbound: lead lists, the offer, templates, multi-channel campaigns, the
 * unibox, sending limits, speed to lead from connected forms, and social (a
 * coming-soon preview). Everything lives in `state.out` and is saved in this
 * browser; nothing in this preview leaves it.
 */

export type Channel = 'email' | 'sms' | 'call' | 'linkedin' | 'slack' | 'whatsapp';

export type LeadStatus =
  | 'new'
  | 'queued'
  | 'contacted'
  | 'replied'
  | 'interested'
  | 'meeting'
  | 'not-interested'
  | 'bounced'
  | 'unsubscribed';

/** How Timmy sorted a reply in the unibox. */
export type ReplyLabel = 'interested' | 'meeting' | 'question' | 'ooo' | 'not-interested' | 'wrong-person' | 'unsubscribe';

export interface Lead {
  id: string;
  first: string;
  last: string;
  email: string;
  phone?: string;
  title?: string;
  company: string;
  website?: string;
  linkedin?: string;
  employees?: number;
  industry?: string;
  keywords?: string[];
  city?: string;
  /** Where the lead came from: a list you imported, a connected form, or added by hand. */
  source: 'import' | 'form' | 'manual' | 'found';
  list?: string;
  form?: string;
  /** What they wrote in the form. */
  message?: string;
  added: Date;
  saved?: boolean;
  /** Timmy's read on whether the account fits your offer, once you run it. */
  qualified?: { verdict: 'yes' | 'maybe' | 'no'; why: string };
  status: LeadStatus;
  label?: ReplyLabel;
  campaign?: string;
  /** Index of the next sequence step, and when it goes. */
  step?: number;
  nextAt?: Date;
  /** Unread replies in the unibox. */
  unread?: boolean;
  /** Speed to lead: when a form lead arrived, and when you first answered. */
  receivedAt?: Date;
  firstReplyAt?: Date;
  /** Columns from the CSV that don't map to a field, kept as-is. */
  extra?: Record<string, string>;
  /** A callback you set on a call, and what it's about. */
  callbackAt?: Date;
  callbackNote?: string;
  /** Your running notes from calls and meetings. */
  notes?: string;
  /** Filled in by an enrichment provider: which, when, and which fields. */
  enriched?: { by: string; at: Date; fields: string[] };
}

export interface LeadList {
  id: string;
  name: string;
  source: 'csv' | 'form' | 'manual' | 'found';
  created: Date;
}

/** What you're selling, in the words Timmy writes from. */
export interface Offer {
  name: string;
  product: string;
  audience: string;
  pain: string;
  /** The pain in two or three words, for subject lines: “spreadsheets”. */
  hook?: string;
  outcome: string;
  proof: string;
  cta: string;
  price?: string;
  /** The ideal customer, for fit scores. */
  icp: { titles: string[]; industries: string[]; minEmployees: number; maxEmployees: number };
}

export interface Template {
  id: string;
  name: string;
  channel: Channel;
  /** cold intro, follow-up, break-up, speed to lead… */
  kind: 'intro' | 'follow-up' | 'case-study' | 'break-up' | 'speed' | 'reply' | 'call' | 'sms';
  subject?: string;
  body: string;
  builtIn?: boolean;
  /** Version of a built-in template; a newer seed replaces older saved copies. */
  v?: number;
}

export interface Variant {
  id: string;
  subject: string;
  body: string;
}

export interface SeqStep {
  id: string;
  channel: Channel;
  /** Days to wait after the previous step (0 for the first). */
  wait: number;
  variants: Variant[];
}

export type CampaignStatus = 'draft' | 'review' | 'active' | 'paused' | 'completed';

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  created: Date;
  launched?: Date;
  leads: string[];
  steps: SeqStep[];
  schedule: { days: number[]; start: string; end: string; tz: string };
  options: {
    /** New cold emails a day across this campaign's mailboxes. */
    dailyLimit: number;
    mailboxes: string[];
    stopOnReply: boolean;
    trackOpens: boolean;
    unsubscribe: boolean;
    /** Plain text only, no links in the first email: better deliverability. */
    plainText: boolean;
  };
  /** Prepared by Timmy, with each first email saved as a draft for you to send. */
  byTimmy?: boolean;
}

export interface Mailbox {
  id: string;
  address: string;
  name: string;
  /** Cold emails a day from this address. */
  dailyLimit: number;
  warmup: boolean;
  /** Deliverability health, 0–100. */
  health: number;
  /** Sent today so far. */
  sentToday: number;
  added: Date;
}

export interface ChannelConn {
  id: Channel | 'calendar' | 'crm';
  name: string;
  connected: boolean;
  account?: string;
  /** What Timmy does with it. */
  use: string;
  dailyLimit?: number;
  sentToday?: number;
}

export interface Limits {
  /** Recommended ceiling for one mailbox; above it, Timmy warns. */
  perMailbox: number;
  /** The hard ceiling for one mailbox. */
  maxPerMailbox: number;
  /** New mailboxes start low and add a few a day. */
  rampStart: number;
  rampStep: number;
  /** Minutes between sends from one mailbox. */
  gapMinutes: [number, number];
  /** Pause a campaign when bounces pass this share of sends. */
  bouncePause: number;
  sms: { perDay: number; quietStart: string; quietEnd: string };
  calls: { perDay: number };
}

export interface OutMessage {
  id: string;
  lead: string;
  channel: Channel;
  dir: 'out' | 'in';
  at: Date;
  subject?: string;
  body: string;
  campaign?: string;
  step?: number;
  mailbox?: string;
  /** draft: saved in the sending account's Drafts folder; nothing went out. */
  status?: 'draft' | 'scheduled' | 'sent' | 'opened' | 'bounced';
  /** For calls: how it went. */
  outcome?: string;
}

export interface FormSource {
  id: string;
  name: string;
  kind: 'website' | 'typeform' | 'webflow' | 'hubspot' | 'facebook' | 'webhook' | 'zillow' | 'realtor' | 'fub';
  connected: boolean;
  /** Answer within this many minutes. */
  sla: number;
  /** Timmy sends the first reply itself, from the template. */
  autoReply: boolean;
  /** Text the lead too when they leave a phone number. */
  textToo: boolean;
  /** Post new leads to Slack. */
  slack: boolean;
  template: string;
}

export interface SocialPost {
  id: string;
  networks: string[];
  text: string;
  at?: Date;
  status: 'draft' | 'scheduled';
  created: Date;
}

export interface Outbound {
  leads: Record<string, Lead>;
  lists: Record<string, LeadList>;
  offer: Offer;
  templates: Record<string, Template>;
  campaigns: Record<string, Campaign>;
  mailboxes: Record<string, Mailbox>;
  channels: Record<string, ChannelConn>;
  limits: Limits;
  messages: OutMessage[];
  forms: Record<string, FormSource>;
  posts: Record<string, SocialPost>;
}
