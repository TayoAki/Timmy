/**
 * One interface over the mail providers. Gmail and Outlook each answer the same
 * few questions and take the same few writes, so sync, sending and filing are
 * written once and never ask which provider they are talking to.
 *
 * Every call goes through Composio on the workspace's own connection. A write
 * here is only ever reached from the Action gateway's executors.
 */
import type { Box } from '../../../src/data/types';
import type { EffectRow, Outcome } from '../gateway/gateway';
import { gmail } from './gmail';
import type { MailMessage } from './message';
import { outlook } from './outlook';
import type { ConnectionRow, Phase } from './tools';

export interface MailPayload {
  connectionId: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  threadKey?: string;
}

export interface FilePayload {
  connectionId: string;
  threadKey: string;
  box: Box;
}

export interface Mailbox {
  /** What people call it, for the words on screen. */
  name: 'Gmail' | 'Outlook';
  /** The address of the connected account, or null when the provider would not say. */
  address(workspaceId: string, connectionId: string): Promise<string | null>;
  /** One page of mail since a moment, newest first. Throws when the provider refuses, so the caller can try again later. */
  page(workspaceId: string, conn: ConnectionRow, q: { since: Date; pageToken?: string; pageSize: number; phase: Phase }): Promise<{ messages: MailMessage[]; next?: string }>;
  /** Every message of one thread, oldest first, or null when the provider could not be asked. */
  thread(workspaceId: string, conn: ConnectionRow, threadKey: string, phase: Phase): Promise<MailMessage[] | null>;
  /** The thread a new-mail event is about. */
  threadKeyOf(event: Record<string, unknown>): string;
  /** The message a new-mail event carries, when it carries a whole one. Used only if the thread itself can't be fetched. */
  seed(event: Record<string, unknown>): MailMessage | null;
  /** Sends an approved email exactly as approved. Throwing means the outcome is unknown. */
  send(e: EffectRow, conn: ConnectionRow, p: MailPayload): Promise<Outcome>;
  /** Looks in Sent for an email whose outcome is unknown. Null means it was not found, which proves nothing. */
  findSent(e: EffectRow, conn: ConnectionRow, p: MailPayload, since: Date): Promise<{ id: string; threadKey: string } | null>;
  /** Writes a thread's place to the mailbox. */
  file(e: EffectRow, conn: ConnectionRow, p: FilePayload): Promise<Outcome>;
  /** Whether the mailbox already shows the filing. Null when that could not be found out. */
  filed(e: EffectRow, conn: ConnectionRow, p: FilePayload): Promise<boolean | null>;
}

const MAILBOXES: Record<string, Mailbox> = { gmail, outlook };

/** The mailbox behind a connection's toolkit, or undefined for a toolkit that is not mail. */
export const mailboxFor = (toolkit: string): Mailbox | undefined => (Object.hasOwn(MAILBOXES, toolkit) ? MAILBOXES[toolkit] : undefined);
export const MAIL_TOOLKITS = Object.keys(MAILBOXES);
