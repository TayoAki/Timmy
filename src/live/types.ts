/**
 * A write Timmy proposed that hasn't happened yet. The server owns these: each
 * one mirrors an effect record behind the Action gateway.
 */
export interface PendingEffect {
  id: string;
  kind: 'email' | 'calendar' | 'crm' | 'campaign';
  /** What it will do, in a line: "Send “Re: Quote” to Dana Whitfield". */
  title: string;
  /** Why Timmy proposed it. */
  why: string;
  /** The email, invite or change exactly as it will go out. */
  preview: { to?: string[]; cc?: string[]; subject?: string; body?: string; lines?: string[] };
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
