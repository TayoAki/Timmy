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
}

export interface Step {
  id: string;
  text: string;
  done: boolean;
  byTimmy?: boolean;
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

export type ActivityKind = 'triage' | 'file' | 'task' | 'draft' | 'calendar' | 'crm' | 'move' | 'send';

export interface Activity {
  id: string;
  at: Date;
  kind: ActivityKind;
  text: string;
  threadId?: string;
}

export type RuleGroup = 'triage' | 'writing' | 'files' | 'schedule';

export interface Rule {
  id: string;
  group: RuleGroup;
  text: string;
  enabled: boolean;
  hits: number;
}

export interface Label {
  id: Box | ProjectId;
  num: string;
  name: string;
  hint: string;
  color: string;
}
