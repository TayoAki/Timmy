/*
 * The workspace Timmy replaces: Drive, Docs, Sheets, Slides, Calendar, Tasks,
 * Keep-style quick notes, a personal CRM and an AI library. Everything lives in
 * the browser for now; Gmail is the only outside service the product connects to.
 */

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
  priority: Priority;
  created: Date;
  /** The email this task came from. */
  thread?: string;
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
}

export interface ChatMsg {
  id: string;
  from: 'visitor' | 'timmy' | 'you';
  text: string;
  at: Date;
  image?: string;
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
}

/** A rule Timmy proposes after noticing how you edit its drafts. */
export interface LearnedRule {
  id: string;
  text: string;
  evidence: string;
  group: 'triage' | 'writing' | 'files' | 'schedule';
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
}

export type Col = keyof WS;
export type ItemOf<C extends Col> = WS[C][string];
