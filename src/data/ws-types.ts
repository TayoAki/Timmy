/*
 * The workspace Timmy replaces: Drive, Docs, Sheets, Slides, Calendar, Tasks,
 * Keep-style quick notes, a personal CRM and an AI library. Everything lives in
 * the browser for now; Gmail is the only outside service the product connects to.
 */

import type { BidDetails, Breakdown, Opportunity, PastAward, PricingQuery, PricingStats, RecipientSummary } from './kontract-api';

export type ProjectId = string;

/* ───────────── Drive ───────────── */

export interface Folder {
  id: string;
  /** Two-digit sort number shown as [01]; 99 is always the archive. */
  num: string;
  name: string;
  parent: string | null;
  color: string;
}

export type FileKind = 'doc' | 'sheet' | 'slides' | 'pdf' | 'image';

export interface WFile {
  id: string;
  name: string;
  kind: FileKind;
  folder: string;
  updated: Date;
  owner: string;
  createdByTimmy?: boolean;
  starred?: boolean;
  /** Searchable keywords, for files whose title you can't change. */
  description?: string;
  /** A sub-page: the doc it lives inside. */
  parent?: string;
  /** In the trash since then; restorable until deleted for good. */
  trashed?: Date;
  /** Went to the trash with this page (a sub-page of it); comes back with it. */
  trashRoot?: string;
  /** Set on a shortcut: the file it points to. */
  shortcutOf?: string;
  /** Someone shared this with you and you haven't decided what to do with it. */
  sharedBy?: string;
  share?: 'pending' | 'one-off' | 'shortcut' | 'copy';
  /** An attachment waiting to be filed, with Timmy's suggestion. */
  filing?: { folder: string; name: string; fromThread?: string };
  project?: ProjectId;
  /** The office or PDF format of the file's own bytes (docx, xlsx, pptx, pdf…), opened in a Craft app. */
  format?: string;
  /** The bytes are kept in this browser: uploaded, or saved from a Craft app. */
  stored?: boolean;
  /** A sample file that ships with the demo, e.g. "/samples/acme-msa.pdf". */
  sample?: string;
}

/* ───────────── Docs ───────────── */

export type DocTemplate = 'blank' | 'private-notes' | 'team-meeting' | 'one-on-one' | 'project-recap' | 'running-notes';

/** Notion-style block colours: text colour, or a background with `-bg`. */
export type BlockColor =
  | 'gray' | 'brown' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'red'
  | 'gray-bg' | 'brown-bg' | 'orange-bg' | 'yellow-bg' | 'green-bg' | 'blue-bg' | 'purple-bg' | 'pink-bg' | 'red-bg';

/** Formatted inline content (bold, links, colours…), kept beside the plain `text` that Timmy reads. */
export type InlineNode =
  | { type: 'text'; text: string; marks?: { type: string; attrs?: Record<string, unknown> }[] }
  | { type: 'hardBreak' };

interface BlockBase {
  id: string;
  /** Nesting under the block above: list levels, and the contents of a toggle. */
  indent?: number;
  color?: BlockColor;
  /** Only set when the text has formatting; ignored if it no longer matches `text`. */
  rich?: InlineNode[];
}

export type Block = BlockBase &
  (
    | { type: 'h1' | 'h2' | 'h3' | 'p' | 'bullet' | 'numbered' | 'quote'; text: string }
    | { type: 'todo'; text: string; checked: boolean }
    /** Blocks indented under a toggle are its contents; they hide when it's closed. */
    | { type: 'toggle'; text: string; open?: boolean }
    | { type: 'callout'; text: string; icon?: string }
    | { type: 'code'; text: string; lang?: string }
    | { type: 'divider' }
    | { type: 'image'; src: string; width?: number; caption?: string }
    /** A table you type into, e.g. a 1:1's Date / Agenda / Notes / Action items. */
    | { type: 'table'; columns: string[]; rows: string[][] }
    /** Live figures from a sheet; refreshes when the sheet changes. */
    | { type: 'linked-table'; sheet: string; columns?: string[] }
    /** A link to another file, shown as a chip. */
    | { type: 'file'; file: string }
    /** A page inside this one (a sub-page). */
    | { type: 'page'; file: string }
  );

export interface DocCover {
  /** A built-in gradient id, or an image (an uploaded data URL or a web address). */
  kind: 'gradient' | 'image';
  value: string;
  /** Vertical focus of an image cover, 0–100. */
  y?: number;
}

export interface DocBody {
  id: string;
  template: DocTemplate;
  blocks: Block[];
  /** Calendar event this doc is the running record for. */
  event?: string;
  /** The page's emoji. */
  icon?: string;
  cover?: DocCover;
}

/* ───────────── Sheets ───────────── */

export interface SheetColumn {
  key: string;
  name: string;
  type: 'text' | 'number' | 'currency' | 'date';
  /** Named-column formula, e.g. "[Seats] * [Price] * 12". */
  formula?: string;
}

export interface Sheet {
  id: string;
  /** The table's name, used when a doc links to it. */
  table: string;
  columns: SheetColumn[];
  rows: Record<string, string | number>[];
}

/* ───────────── Slides ───────────── */

export interface Slide {
  id: string;
  title: string;
  layout: 'title' | 'bullets' | 'chart' | 'quote';
  bullets?: string[];
  notes?: string;
  /** Slides marked confidential shouldn't leave the private deck. */
  confidential?: boolean;
}

export interface Deck {
  id: string;
  slides: Slide[];
}

/* ───────────── Tasks, quick notes, calendar ───────────── */

export type TaskStatus = 'todo' | 'doing' | 'done';
export type Priority = 'high' | 'normal' | 'low';

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  project?: ProjectId;
  due?: Date;
  /** Timmy chose the date because the email named none; changing it makes it the person's own. */
  dueSuggested?: true;
  priority: Priority;
  created: Date;
  /** The email this task came from. */
  thread?: string;
  /** Timmy added it from what an email asked of the person. */
  by?: 'timmy';
  contact?: string;
  notes?: string;
  /** Calendar block reserved for it. */
  event?: string;
}

/** Something captured on the go, waiting for the review session. */
export interface QuickNote {
  id: string;
  text: string;
  /** "thought" = your own idea; "note" = from a meeting, video or article. */
  kind: 'thought' | 'note';
  source?: string;
  created: Date;
  processed?: 'task' | 'note' | 'calendar' | 'archived';
}

export type EventKind = 'meeting' | 'focus' | 'review' | 'personal';

export interface WEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  kind: EventKind;
  with: string[];
  note?: string;
  /** Files to open for the meeting. */
  docs?: string[];
  thread?: string;
  task?: string;
  /** Running notes doc linked from the invite. */
  notesDoc?: string;
  recurring?: 'weekly';
}

/* ───────────── People (CRM) ───────────── */

export type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly';

export interface Contact {
  id: string;
  name: string;
  email: string;
  title?: string;
  company?: string;
  phone?: string;
  location?: string;
  internal?: boolean;
  bot?: boolean;
  /** In the CRM you review; untracked contacts are just people you've emailed. */
  tracked?: boolean;
  priority?: boolean;
  cadence?: Cadence;
  last?: Date;
  next?: string;
  owner?: string;
  due?: Date;
  deal?: string;
  about?: string;
  /** Emails exchanged in the last 30 days; used to suggest who to track. */
  emails?: number;
  /** Timmy added this person from your mail. They leave again if that mail goes, unless you track them. */
  auto?: boolean;
}

export type InteractionKind = 'note' | 'email' | 'meeting' | 'call' | 'reminder' | 'file';

export interface Interaction {
  id: string;
  contact: string;
  kind: InteractionKind;
  text: string;
  at: Date;
  by: string;
  thread?: string;
  file?: string;
  done?: boolean;
}

/* ───────────── Projects ───────────── */

export interface Project {
  id: ProjectId;
  num: string;
  name: string;
  color: string;
  status: 'active' | 'archived';
  client?: string;
  goal?: string;
  folder: string;
  deal?: string;
  /** The running notes doc where decisions are recorded. */
  notesDoc?: string;
  /** Files Timmy should read when drafting for this project. */
  sources: string[];
}

/* ───────────── AI library ───────────── */

export interface Prompt {
  id: string;
  title: string;
  text: string;
  status: 'captured' | 'filed' | 'discarded';
  useCase?: string;
  output?: 'email' | 'doc' | 'slides' | 'analysis';
  project?: ProjectId;
  created: Date;
}

export interface Routine {
  id: string;
  name: string;
  when?: string;
  /** Places to open together, as app links. */
  links: { label: string; href: string }[];
}

/** One step on an automation's canvas. `kind` is a block from the automation catalog. */
export interface AutoNode {
  id: string;
  kind: string;
  x: number;
  y: number;
  /** The step's settings: field id → value. Text can hold {{fields}} from the trigger. */
  config: Record<string, string>;
}

export interface AutoEdge {
  id: string;
  from: string;
  to: string;
  /** A condition's branch. */
  branch?: 'yes' | 'no';
}

/** A workflow you draw: a trigger, then the steps Timmy takes. */
export interface Automation {
  id: string;
  name: string;
  description: string;
  on: boolean;
  nodes: AutoNode[];
  edges: AutoEdge[];
  updated: Date;
  /** Test runs so far (with sample data; nothing is sent). */
  tests?: number;
  /** On a real workspace: why Timmy switched it off (it ran too often, or kept failing). Cleared when it is switched back on. */
  note?: string;
  /**
   * On a real workspace: set while it is on but can't run, saying why (a New-email automation with no mailbox
   * connected). It carries on by itself once that is fixed. Only the server writes it.
   */
  paused?: string;
}

/** The chat on your website: how it looks, what it asks and what it knows. */
export interface ChatWidget {
  id: string;
  on: boolean;
  domain: string;
  name: string;
  /** An uploaded picture for the launcher and header; Timmy's mark when empty. */
  icon?: string;
  color: string;
  greeting: string;
  /** Asked one at a time once the visitor leaves an email. */
  questions: { id: string; text: string }[];
  faq: { id: string; q: string; a: string }[];
  /** When someone asks for a person. */
  handoff: 'notify' | 'book' | 'email';
  booking: boolean;
  /** On a real workspace: the key in the code snippet. The server makes it; nobody can set it. */
  siteKey?: string;
  /** A link to the business's own privacy policy, shown with the email question. */
  privacyUrl?: string;
  /** How long visitors' conversations are kept, in months (12 when not set). */
  retentionMonths?: number;
}

export interface ChatMsg {
  id: string;
  from: 'visitor' | 'timmy' | 'you';
  text: string;
  at: Date;
  image?: string;
  /** On a real workspace: the name of the teammate who wrote it. */
  by?: string;
  /** On a real workspace: the message could not be shown to the visitor. */
  undelivered?: boolean;
}

/** One visitor's chat from the website. */
export interface ChatConvo {
  id: string;
  name?: string;
  email?: string;
  company?: string;
  messages: ChatMsg[];
  /** You took over: Timmy stops answering. */
  live: boolean;
  unread: boolean;
  starred?: boolean;
  /** Asked for a person and is waiting. */
  urgent?: boolean;
  answers?: Record<string, string>;
  booked?: string;
  page?: string;
  /** On a real workspace: how many older messages are kept on the server but not listed here. */
  earlier?: number;
}

/** A rule Timmy proposes after noticing how you edit its drafts. */
export interface LearnedRule {
  id: string;
  text: string;
  evidence: string;
  group: 'triage' | 'writing' | 'files' | 'schedule';
  /** A sorting rule Timmy proposes from how the person filed mail themselves; accepting it saves this as is. */
  mail?: import('./types').MailRule;
  /** For a sorting rule: what declining it remembers, so it isn't proposed again ("learn:@medium.com:archived"). */
  dismissKey?: string;
}

export interface WS {
  folders: Record<string, Folder>;
  files: Record<string, WFile>;
  docs: Record<string, DocBody>;
  sheets: Record<string, Sheet>;
  decks: Record<string, Deck>;
  tasks: Record<string, Task>;
  notes: Record<string, QuickNote>;
  events: Record<string, WEvent>;
  contacts: Record<string, Contact>;
  interactions: Record<string, Interaction>;
  projects: Record<string, Project>;
  prompts: Record<string, Prompt>;
  routines: Record<string, Routine>;
  learned: Record<string, LearnedRule>;
  /** Pages in the trash: out of every list until restored or deleted for good. */
  trash: Record<string, WFile>;
  automations: Record<string, Automation>;
  chat: Record<string, ChatWidget>;
  chats: Record<string, ChatConvo>;
  /** Invoices and quotes (src/state/invoices.ts). */
  invoices: Record<string, Invoice>;
  /** The business details and numbering invoices and quotes use: one record, `settings`. */
  billing: Record<string, BillingSettings>;
  /** Contracts the workspace is bidding on (src/state/bids.ts); the public data comes from Kontract. */
  bids: Record<string, Bid>;
  /** The company as government buyers see it: one record, `profile`. */
  bidding: Record<string, BidProfile>;
}

/* ───────────── Invoices and quotes ───────────── */

export type InvoiceKind = 'invoice' | 'quote';
/** Overdue (an invoice past its due date) and expired (a quote past its date) are worked out, never stored. */
export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'accepted' | 'declined' | 'void';

/** One line of an invoice or quote. Money is in cents, so sums are exact. */
export interface LineItem {
  id: string;
  description: string;
  /** Hours, units, seats… Can have decimals (1.5 hours). */
  qty: number;
  /** Price of one, in cents. */
  unitPrice: number;
  /** Sales tax on this line, as a percentage (8.25 for 8.25%). */
  taxRate?: number;
  /** A quote's optional line: the client may take it or leave it. Counted only when `chosen`. */
  optional?: boolean;
  chosen?: boolean;
}

export interface Invoice {
  id: string;
  kind: InvoiceKind;
  /** INV-0001, Q-0001: given when it is made, never reused. */
  number: string;
  status: InvoiceStatus;
  client: { contact?: string; name: string; email?: string; company?: string; address?: string };
  issued: Date;
  /** An invoice's due date; a quote's "valid until". */
  due?: Date;
  /** ISO 4217, e.g. USD. */
  currency: string;
  items: LineItem[];
  discount?: { kind: 'percent' | 'amount'; value: number };
  /** Shown above the lines: what this is for. */
  intro?: string;
  /** Shown below the totals: thanks, scope notes. */
  notes?: string;
  /** Payment terms, or a quote's terms. */
  terms?: string;
  project?: ProjectId;
  /** The email it was made from, or the one it was sent in. */
  thread?: string;
  /** For an invoice made from a quote: that quote. */
  fromQuote?: string;
  created: Date;
  sentAt?: Date;
  paidAt?: Date;
  acceptedAt?: Date;
  declinedAt?: Date;
  voidedAt?: Date;
  /** Timmy drafted it from an email. */
  by?: 'timmy';
}

export interface BillingSettings {
  id: 'settings';
  /** The business name on every invoice. */
  business: string;
  address?: string;
  email?: string;
  phone?: string;
  /** Tax or registration number, when the business has one to show. */
  taxId?: string;
  /** How to pay: bank details, a payment link, "checks payable to…". */
  payment?: string;
  currency: string;
  /** Days from the issue date an invoice is due (Net 30 is 30). */
  termsDays: number;
  /** Days a quote stays valid. */
  quoteDays: number;
  invoicePrefix: string;
  quotePrefix: string;
  /** The next number each will get. */
  nextInvoice: number;
  nextQuote: number;
}

export type Col = keyof WS;
export type ItemOf<C extends Col> = WS[C][string];

/* ───────────── Bids (government and public contracts) ───────────── */

/** Found → sourcing subs → quoted → submitted → won or lost, as in Kontract. */
export type BidStage = 'found' | 'sourcing' | 'quoted' | 'submitted' | 'won' | 'lost';

/** One price line: what a sub charges per unit, what the buyer is charged, and how many units each period. Whole cents. */
export interface BidLine {
  id: string;
  description: string;
  /** "month", "visit", "each"… */
  unit: string;
  /** Units each period (each year, or for the whole job). */
  quantity: number;
  /** What the sub charges you per unit. */
  subCost: number;
  /** What you charge the buyer per unit. */
  price: number;
}

export type BidSubStatus = 'new' | 'asked' | 'quoted' | 'selected' | 'declined';

/** A subcontractor on a bid: found by a search, from permits near the job, from Contacts, or typed in. */
export interface BidSub {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  website?: string;
  address?: string;
  category?: string;
  rating?: number;
  reviewCount?: number;
  license?: string;
  source: 'search' | 'sample' | 'permits' | 'contact' | 'manual';
  /** The contact it is, once saved to Contacts. */
  contact?: string;
  status: BidSubStatus;
  /** Their price for each period, in cents, once they quote. */
  quote?: number;
  notes?: string;
  /** The email that asked them for a quote. */
  thread?: string;
}

/** What past awards like this one went for (USAspending, through Kontract), kept with the bid. */
export interface BidPastPricing {
  at: Date;
  query: PricingQuery;
  stats: PricingStats;
  awards: PastAward[];
  recipients: RecipientSummary[];
}

export interface Bid {
  id: string;
  /** Kontract's copy of the notice when it was tracked. Sent back when the notice has closed, so it stays readable. */
  notice: Opportunity;
  stage: BidStage;
  created: Date;
  updated?: Date;
  submittedAt?: Date;
  /** When it was won or lost. */
  decidedAt?: Date;
  notes?: string;
  project?: string;
  /** The to-do for its deadline. */
  task?: string;
  /** The page the proposal is written on. */
  proposal?: string;
  /** What the documents say, each fact with the words it came from (Kontract's free rules). */
  details?: BidDetails;
  breakdown?: Breakdown;
  pastPricing?: BidPastPricing;
  pricing: { periods: number; periodLabel: 'year' | 'contract'; markupPct: number; lines: BidLine[] };
  subs: BidSub[];
}

/** The company's details for bids and proposals: UEI and CAGE, who to contact, what it does. */
export interface BidProfile {
  id: 'profile';
  companyName: string;
  uei?: string;
  cage?: string;
  address?: string;
  contactName?: string;
  contactTitle?: string;
  email?: string;
  phone?: string;
  website?: string;
  capabilities?: string;
  /** Codes and states it bids in, used as the default search. */
  naics?: string[];
  states?: string[];
  defaultMarkupPct: number;
}
