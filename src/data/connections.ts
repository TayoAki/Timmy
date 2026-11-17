/*
 * The apps Timmy connects to. In the product every button opens Composio's
 * connect page; in this preview, connecting is simulated and nothing leaves
 * the browser. Each app says what Timmy reads and what it may write (every
 * write still waits for approval).
 */

export type AppGroup = 'Mail and calendar' | 'CRM' | 'Lead sources' | 'Enrichment' | 'Messaging and calls' | 'Notes';

export interface AppDef {
  id: string;
  name: string;
  group: AppGroup;
  /** Two letters for the tile. */
  mark: string;
  color: string;
  reads: string;
  writes?: string;
  /** Something to know before connecting. */
  note?: string;
  /** What a real workspace is told, where that differs from the preview: only what Timmy does with the app today. */
  live?: { reads?: string; writes?: string; note?: string };
  account: string;
  /** Lead sources show up in Speed to lead as a source of new leads. */
  source?: 'zillow' | 'realtor' | 'fub' | 'facebook';
  /** Enrichment: credits per lead. */
  credits?: number;
  soon?: boolean;
  /** Reached with a token instead of a Composio connect page. */
  token?: boolean;
}

export interface AppConn {
  connected: boolean;
  account?: string;
  at?: Date;
  /** Microsoft: waiting for the tenant admin to approve access. */
  pendingAdmin?: boolean;
  /** Live mode: the account was connected without permission to read its calendar, so Timmy has stopped asking for it. */
  calendarRefused?: boolean;
}

export const APPS: AppDef[] = [
  { id: 'gmail', name: 'Gmail', group: 'Mail and calendar', mark: 'Gm', color: 'var(--c-red)', reads: 'Mail and labels', writes: 'Drafts, labels and sends you approve', account: 'taylor@northpeak.example' },
  { id: 'gcal', name: 'Google Calendar', group: 'Mail and calendar', mark: 'GC', color: 'var(--c-sky)', reads: 'Your calendars and free/busy', writes: 'Invites and changes you approve', account: 'taylor@northpeak.example' },
  {
    id: 'gdrive',
    name: 'Google Drive',
    group: 'Mail and calendar',
    mark: 'GD',
    color: 'var(--c-green)',
    reads: 'Files you open in Timmy or file from mail',
    writes: 'Files Timmy creates or files for you',
    account: 'taylor@northpeak.example',
    live: { reads: 'The names, types and owners of your files, so Ask can find them', writes: 'Nothing', note: 'Timmy keeps a list of your files and links to them. It does not open the files themselves yet, and it changes nothing in Drive.' },
  },
  {
    id: 'outlook',
    name: 'Outlook and Microsoft 365',
    group: 'Mail and calendar',
    mark: 'Ol',
    color: 'var(--c-indigo)',
    reads: 'Outlook mail, calendar and OneDrive',
    writes: 'Drafts, sends and invites you approve',
    note: 'Most Microsoft 365 companies require an admin to approve mail and calendar access. Timmy sends your admin a one-click consent link.',
    account: 'taylor@northpeak-group.example',
    live: {
      reads: 'Outlook mail and calendar',
      writes: 'Sends you approve, categories and archiving for the threads you file, and the events you add, change or delete in Timmy',
      note: 'If your company requires an admin to approve new apps, Microsoft’s sign-in page will say so: ask your admin to approve it there, then connect again. If you connected Outlook before Timmy read its calendar, disconnect it and connect again, so Microsoft can ask you for the calendar. OneDrive is not read yet. A workspace has one mailbox, so disconnect Gmail first if it is connected.',
    },
  },
  { id: 'hubspot', name: 'HubSpot', group: 'CRM', mark: 'Hs', color: 'var(--c-amber)', reads: 'Contacts, companies, deals and activity', writes: 'Deal and stage changes, call and email activity, after approval', account: 'Northpeak portal' },
  { id: 'salesforce', name: 'Salesforce', group: 'CRM', mark: 'Sf', color: 'var(--c-sky)', reads: 'Accounts, contacts, opportunities and tasks', writes: 'Opportunity changes and activity, after approval', account: 'northpeak.my.salesforce.example' },
  { id: 'pipedrive', name: 'Pipedrive', group: 'CRM', mark: 'Pd', color: 'var(--c-green)', reads: 'People, organizations and deals', writes: 'Deal changes and activity, after approval', account: 'Northpeak' },
  { id: 'fub', name: 'Follow Up Boss', group: 'Lead sources', mark: 'FB', color: 'var(--c-indigo)', reads: 'New leads and people', writes: 'Notes, calls and texts you log', source: 'fub', account: 'Brooks Team' },
  {
    id: 'zillow',
    name: 'Zillow Premier Agent',
    group: 'Lead sources',
    mark: 'Zi',
    color: 'var(--c-sky)',
    reads: 'New buyer and seller leads',
    source: 'zillow',
    note: 'Zillow sends leads to Timmy through Tech Connect: copy Timmy’s Partner ID into Zillow › Connect to my CRM.',
    account: 'Partner ID TMY-4821',
  },
  { id: 'realtor', name: 'Realtor.com', group: 'Lead sources', mark: 'Rc', color: 'var(--c-red)', reads: 'New leads from your listings', source: 'realtor', note: 'Realtor.com sends leads through its Lead Delivery API. It needs a Connections Plus subscription.', account: 'Lead Delivery API' },
  { id: 'fbleads', name: 'Facebook Lead Ads', group: 'Lead sources', mark: 'Fb', color: 'var(--c-indigo)', reads: 'Leads from your lead forms', source: 'facebook', account: 'Northpeak page' },
  {
    id: 'treg',
    name: 'Treg',
    group: 'Enrichment',
    mark: 'Tr',
    color: 'var(--c-teal)',
    reads: 'Work emails, phones, people and company data. Timmy picks the best of more than 100 data providers for each lookup',
    credits: 1,
    token: true,
    note: 'Treg is a pay-per-call marketplace of data and tools for AI agents, with Hunter, Lusha, Apollo, People Data Labs, Crunchbase and more behind one token. Timmy sees each call’s price before it makes it, and every call counts against your enrichment budget. Timmy uses Treg only to look things up. Connect one of the providers below to use your own account instead.',
    account: 'Timmy’s Treg account',
  },
  { id: 'apollo', name: 'Apollo', group: 'Enrichment', mark: 'Ap', color: 'var(--c-amber)', reads: 'Titles, phones, company size and industry for your leads', credits: 1, account: 'Northpeak (Apollo)' },
  { id: 'clay', name: 'Clay', group: 'Enrichment', mark: 'Cl', color: 'var(--c-violet)', reads: 'Waterfall enrichment across providers', credits: 2, account: 'Northpeak workspace' },
  { id: 'pdl', name: 'People Data Labs', group: 'Enrichment', mark: 'PD', color: 'var(--c-teal)', reads: 'Person and company records', credits: 1, account: 'API key' },
  { id: 'hunter', name: 'Hunter', group: 'Enrichment', mark: 'Hu', color: 'var(--c-red)', reads: 'Work emails, with a verification check', credits: 1, account: 'API key' },
  { id: 'enrich-api', name: 'Any enrichment API', group: 'Enrichment', mark: '{ }', color: 'var(--c-slate)', reads: 'A provider you already pay for, through its API', credits: 1, account: 'Custom API' },
  { id: 'slack', name: 'Slack', group: 'Messaging and calls', mark: 'Sl', color: 'var(--c-violet)', reads: 'Nothing; Timmy posts', writes: 'New-lead posts to the channel you pick', account: 'Northpeak · #new-leads' },
  { id: 'twilio', name: 'Twilio: texts and calls', group: 'Messaging and calls', mark: 'Tw', color: 'var(--c-red)', reads: 'Replies to your texts', writes: 'Texts to leads who opted in; calls from your browser', note: 'Business texting needs a registered brand and campaign (A2P 10DLC). Timmy walks you through it.', account: '+1 555 0100' },
  { id: 'whatsapp', name: 'WhatsApp Business', group: 'Messaging and calls', mark: 'Wa', color: 'var(--c-green)', reads: 'Messages from leads', writes: 'Replies you approve', account: '', soon: true },
  { id: 'notion', name: 'Notion', group: 'Notes', mark: 'No', color: 'var(--c-slate)', reads: 'Pages you share with Timmy', writes: 'Notes and your weekly review', account: 'Taylor’s workspace' },
];

export const APP = Object.fromEntries(APPS.map((a) => [a.id, a])) as Record<string, AppDef>;
export const GROUPS: AppGroup[] = ['Mail and calendar', 'CRM', 'Lead sources', 'Enrichment', 'Messaging and calls', 'Notes'];

const d = (day: number, h = 9, m = 0) => new Date(2026, 10, day, h, m);

export const APPS_SEED: Record<string, AppConn> = {
  treg: { connected: true, account: 'Timmy’s Treg account', at: d(2) },
  gmail: { connected: true, account: APP.gmail!.account, at: d(2) },
  gcal: { connected: true, account: APP.gcal!.account, at: d(2) },
  gdrive: { connected: true, account: APP.gdrive!.account, at: d(2) },
  slack: { connected: true, account: APP.slack!.account, at: d(3) },
  twilio: { connected: true, account: APP.twilio!.account, at: d(3) },
};
