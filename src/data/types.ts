export type Box = 'inbox' | 'follow-up' | 'waiting' | 'read-through' | 'archived';
export type ProjectId = string;
export type Effort = 'quick' | 'focus';
export type Confidence = 'high' | 'medium' | 'low';

export interface Person {
  id: string;
  name: string;
  email: string;
  title?: string;
  company?: string;
  internal?: boolean;
  /** Automated senders (newsletters, receipts) render with a square avatar. */
  bot?: boolean;
}

export interface Message {
  id: string;
  from: string;
  to: string[];
  cc?: string[];
  at: Date;
  body: string[];
  attachments?: string[];
}

export interface Draft {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  /** Docs Timmy read to write the draft. */
  sources: string[];
  attachments?: string[];
  /** When sent, the thread moves to Waiting for this item. */
  trackAs?: { on: string; item: string; due: Date };
  kind?: 'reply' | 'nudge';
  /** Tasks that sending this email finishes. */
  completes?: string[];
  /**
   * This email also asks for what another thread is waiting on. Sending it makes
   * that thread's separate nudge unnecessary; if the nudge goes first, `without`
   * takes the repeat ask out of this draft.
   */
  alsoAsks?: { thread: string; due?: Date; without: [string, string][] };
  /** A number the email quotes from a sheet, so a later change to the sheet is flagged. */
  basis?: { sheet: string; row: number; col: string; label: string };
}

/** What clicking a next action does. */
export type StepRun =
  /** Send the thread's draft (tracked in Waiting when the draft has a tracking line). */
  | { do: 'send' }
  /** Apply the CRM update the thread's deal is waiting for. */
  | { do: 'deal' }
  /** Make a decision from Approvals with this option. */
  | { do: 'decide'; decision: string; option: string; verb: string }
  /** Block focus time: day yyyy-mm-dd, start HH:MM. */
  | { do: 'block'; title: string; day: string; start: string; minutes: number };

export interface Step {
  id: string;
  text: string;
  done: boolean;
  byTimmy?: boolean;
  /** Where to do it, as an app link such as "file:acme-quote". Clicking the step opens it. */
  href?: string;
  /** Clicking the step does this, then ticks it. */
  run?: StepRun;
}

export interface Waiting {
  on: string;
  item: string;
  due?: Date;
  since: Date;
}

export interface Suggestion {
  box: Box;
  reason: string;
  confidence: Confidence;
  effort?: Effort;
  /** A follow-on action Timmy will take, e.g. a CRM update. */
  extra?: string;
  /** On a real workspace: only plain code has looked at the thread so far, and Timmy's own read is still to come. */
  provisional?: boolean;
}

export interface Thread {
  id: string;
  subject: string;
  box: Box;
  project?: ProjectId;
  participants: string[];
  messages: Message[];
  unread?: boolean;
  starred?: boolean;
  /** Timmy's one-line version of what the thread needs. */
  ask: string;
  context?: string;
  due?: Date;
  effort?: Effort;
  waiting?: Waiting;
  draft?: Draft;
  steps?: Step[];
  docs?: string[];
  deal?: string;
  kind?: 'report' | 'howto' | 'reference';
  suggestion?: Suggestion;
  history?: { at: Date; text: string }[];
  /** Urgency you set yourself; otherwise Timmy ranks the thread. */
  urgency?: 'urgent' | 'later';
  /** Live mode: where this thread lives in the connected mailbox, and the names of the people in it. */
  ext?: {
    threadKey?: string;
    connectionId?: string;
    /** Which kind of mailbox it lives in. Left out for Gmail, the first one Timmy read. */
    app?: 'outlook';
    people?: Record<string, { name: string; email: string }>;
    /** The nudge Timmy last drafted here: for which date, and a hash of its text while nobody has edited it. */
    nudge?: { due: Date; hash?: string };
  };
}

export interface Doc {
  id: string;
  name: string;
  kind: 'doc' | 'sheet' | 'slides' | 'pdf';
  path: string[];
  updated: Date;
  owner: string;
  createdByTimmy?: boolean;
}

export interface Deal {
  id: string;
  company: string;
  name: string;
  stage: string;
  value: number;
  contact: string;
  lastTouch: string;
  next: string;
  owner: string;
  due?: Date;
  suggestion?: string;
}

export interface Relationship {
  person: string;
  priority?: boolean;
  cadence: string;
  last: string;
  next: string;
  owner: string;
  due?: Date;
  deal?: string;
  threadId?: string;
}

export interface CalEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  with: string[];
  focus?: boolean;
  note?: string;
  docs?: string[];
  threadId?: string;
}

export type ActivityKind = 'triage' | 'file' | 'task' | 'draft' | 'calendar' | 'crm' | 'move' | 'send' | 'approval' | 'automation';

export interface Activity {
  id: string;
  at: Date;
  kind: ActivityKind;
  text: string;
  threadId?: string;
}

export type RuleGroup = 'triage' | 'urgency' | 'approvals' | 'writing' | 'files' | 'schedule';

export interface Rule {
  id: string;
  group: RuleGroup;
  text: string;
  enabled: boolean;
  hits: number;
  /** Always on; shown with a lock. */
  locked?: boolean;
}

export interface Label {
  id: Box | ProjectId;
  num: string;
  name: string;
  hint: string;
  color: string;
}
