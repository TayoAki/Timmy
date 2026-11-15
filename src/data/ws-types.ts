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
  /** Set on a shortcut: the file it points to. */
  shortcutOf?: string;
  /** Someone shared this with you and you haven't decided what to do with it. */
  sharedBy?: string;
  share?: 'pending' | 'one-off' | 'shortcut' | 'copy';
  /** An attachment waiting to be filed, with Timmy's suggestion. */
  filing?: { folder: string; name: string; fromThread?: string };
  project?: ProjectId;
}

/* ───────────── Docs ───────────── */

export type DocTemplate = 'blank' | 'private-notes' | 'team-meeting' | 'one-on-one' | 'project-recap' | 'running-notes';

export type Block =
  | { id: string; type: 'h2' | 'h3' | 'p' | 'bullet'; text: string }
  | { id: string; type: 'todo'; text: string; checked: boolean }
  /** A table you type into, e.g. a 1:1's Date / Agenda / Notes / Action items. */
  | { id: string; type: 'table'; columns: string[]; rows: string[][] }
  /** Live figures from a sheet; refreshes when the sheet changes. */
  | { id: string; type: 'linked-table'; sheet: string; columns?: string[] }
  /** A link to another file, shown as a chip. */
  | { id: string; type: 'file'; file: string };

export interface DocBody {
  id: string;
  template: DocTemplate;
  blocks: Block[];
  /** Calendar event this doc is the running record for. */
  event?: string;
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
}

export type Col = keyof WS;
export type ItemOf<C extends Col> = WS[C][string];
