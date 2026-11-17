/**
 * One interface over the mail providers. Gmail and Outlook each answer the same
 * few questions and take the same few writes, so sync, sending and filing are
 * written once and never ask which provider they are talking to.
 *
 * Every call goes through Composio on the workspace's own connection. A write
 * here is only ever reached from the Action gateway's executors.
 */
import type { Box } from '../../../src/data/types';
import type { ApprovedFile, FileToSend } from '../files/attachments';
import type { EffectRow, Outcome } from '../gateway/gateway';
import { gmail } from './gmail';
import type { Labelled } from './labels';
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
  /** The files the email carries, as approved: which asset, under what name, and the hash its bytes must have. */
  attachments?: ApprovedFile[];
}

export interface FilePayload {
  connectionId: string;
  threadKey: string;
  box: Box;
}

/**
 * Where one message sits in the mailbox right now, and nothing of what it says. `labels` uses the same words
 * as `MailMessage.labels`. `filedAs` names which of Timmy's three places the message is marked with there: a
 * Gmail label, an Outlook category. `mine` is true for the mailbox owner's own message: it sits in Sent, or it
 * was written from the mailbox's own address (a reply still in the outbox, or scheduled for later).
 */
export interface MessageState {
  id: string;
  threadKey: string;
  at: Date;
  labels: string[];
  filedAs: Labelled[];
  mine: boolean;
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
  /**
   * Sends an approved email exactly as approved. Throwing means the outcome is unknown.
   * `files` are the approved attachments, already read back and checked against their hashes.
   */
  send(e: EffectRow, conn: ConnectionRow, p: MailPayload, files?: FileToSend[]): Promise<Outcome>;
  /** Looks in Sent for an email whose outcome is unknown. Null means it was not found, which proves nothing. */
  findSent(e: EffectRow, conn: ConnectionRow, p: MailPayload, since: Date): Promise<{ id: string; threadKey: string } | null>;
  /** Writes a thread's place to the mailbox. */
  file(e: EffectRow, conn: ConnectionRow, p: FilePayload): Promise<Outcome>;
  /** Whether the mailbox already shows the filing. Null when that could not be found out. */
  filed(e: EffectRow, conn: ConnectionRow, p: FilePayload): Promise<boolean | null>;
  /**
   * Where recent mail sits now: one page of the messages received since a moment, newest first, each with the
   * labels it carries at this moment and none of its words. Mail in the trash and in spam is included, because
   * having been put there is one of the things this is asked for. It only reads. One call per page, however
   * many threads the page touches. Throws when the provider refuses, so the caller can look again later.
   */
  recentStates(workspaceId: string, conn: ConnectionRow, q: { since: Date; pageToken?: string; pageSize: number; phase: Phase }): Promise<{ messages: MessageState[]; next?: string }>;
  /** The same reading of messages that were already fetched (a whole thread, when new mail arrives). It only reads. */
  statesOf(workspaceId: string, conn: ConnectionRow, messages: MailMessage[], phase: Phase): Promise<MessageState[]>;
  /**
   * The names of the files one message carries, for a mailbox whose listing only says that there are some
   * (`hasAttachments`). Pictures placed inside the body are not counted. Null when the provider would not say.
   * One call. It only reads. Gmail's listing names the files itself and has no need of this.
   */
  attachmentNames?(workspaceId: string, conn: ConnectionRow, messageId: string, phase: Phase): Promise<string[] | null>;
}

const MAILBOXES: Record<string, Mailbox> = { gmail, outlook };

/** The mailbox behind a connection's toolkit, or undefined for a toolkit that is not mail. */
export const mailboxFor = (toolkit: string): Mailbox | undefined => (Object.hasOwn(MAILBOXES, toolkit) ? MAILBOXES[toolkit] : undefined);
export const MAIL_TOOLKITS = Object.keys(MAILBOXES);
