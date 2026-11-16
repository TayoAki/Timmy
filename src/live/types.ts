import type { Patch } from './patches';

/**
 * A write Timmy proposed that hasn't happened yet. The server owns these: each
 * one mirrors an effect record behind the Action gateway.
 */
export interface PendingEffect {
  id: string;
  kind: 'email' | 'calendar' | 'crm' | 'campaign' | 'filing';
  /** What it will do, in a line: "Send “Re: Quote” to Dana Whitfield". */
  title: string;
  /** Why Timmy proposed it. */
  why: string;
  /** The email, invite or change exactly as it will go out. `attachments` are the files an email carries. */
  preview: { from?: string; to?: string[]; cc?: string[]; subject?: string; body?: string; lines?: string[]; attachments?: { name: string; type: string; size: number }[] };
  /** Whose OK it needs. */
  waitingOn: 'you' | 'exec' | 'revops';
  who?: string;
  /** `waiting`: needs an approval. `holding`: approved, and can still be undone until `sendsAt`. */
  status: 'waiting' | 'holding';
  sendsAt?: Date;
  thread?: string;
  /** The chat conversation that proposed it, if any. */
  conversation?: string;
  at: Date;
}

/** Who is signed in, and where. Null in the demo. */
export interface LiveProfile {
  user: { id: string; name: string; email: string };
  workspace: { id: string; name: string; trade: string; role: string };
  can: { read: boolean; work: boolean; approveSends: boolean; approveCrm: boolean; policy: boolean; connect: boolean };
  /** The models this workspace may choose, and the one it runs on. */
  models: { id: string; label: string; note: string }[];
  model: string;
  approvalMode: 'ask' | 'auto';
}

/** A scheduled morning run on a real workspace: when it happened and what it prepared. */
export interface MorningRun {
  at: Date;
  /** Threads with new mail from someone else since the run before. */
  sorted: number;
  /** Replies drafted and waiting in Approvals. */
  drafted: number;
  /** Nudges drafted for things the person is still waiting for. */
  nudged?: number;
  /** Set when the run stopped short, in words for the person. */
  note?: string;
}

/** What the server answers to one command. The browser and the server share this definition. */
export interface CommandResult {
  ok: boolean;
  rev: number;
  patches: Patch[];
  /** A notice to show in place of the browser's own. */
  toast?: { text: string; tone?: 'warn' };
  error?: string;
  /** Where to send the browser next (an app's connect page). */
  redirect?: string;
  /** Sends that are waiting out the undo window, and for how long. */
  holding?: { effects: string[]; seconds: number };
}
