/**
 * Outlook (Microsoft 365 and Outlook.com), through Composio's `outlook` toolkit.
 *
 * How Outlook differs from Gmail, and what is done about it here:
 *   - A thread is a "conversation", and its messages are listed with a filter rather than fetched by id.
 *   - Where a message sits is a folder, not a label. The folders are looked up once and translated into the
 *     same words the rest of the code uses (INBOX, SENT, DRAFT, TRASH, SPAM).
 *   - A thread's place in Timmy is written as a category on its messages ("Timmy Follow Up" and so on), which
 *     is Outlook's closest thing to a label. Archiving moves the messages to the Archive folder.
 *   - Bodies arrive as HTML and are stored as text.
 *   - A reply is made as a draft, addressed to exactly the approved people, and then sent. Outlook's own
 *     "reply" would choose the recipients itself, and what was approved is what must go out.
 */
import { withWorkspace } from '../db/pool';
import { LABEL_NAMES } from './labels';
import type { Mailbox } from './mailbox';
import { htmlToText, type MailMessage } from './message';
import { callTool, connectionById, type ConnectionRow, type Phase } from './tools';

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}
interface GraphMessage {
  id?: string;
  conversationId?: string;
  subject?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  isDraft?: boolean;
  parentFolderId?: string;
  categories?: string[];
  body?: { contentType?: string; content?: string };
  bodyPreview?: string;
}

/** The folders whose meaning matters, by Outlook's own fixed names. A mailbox may lack one (not every account has Archive). */
const WELL_KNOWN = ['inbox', 'sentitems', 'drafts', 'archive', 'deleteditems', 'junkemail'] as const;
type Folders = Partial<Record<(typeof WELL_KNOWN)[number], string>>;
const FOLDER_LABEL: Record<(typeof WELL_KNOWN)[number], string> = { inbox: 'INBOX', sentitems: 'SENT', drafts: 'DRAFT', archive: 'ARCHIVE', deleteditems: 'TRASH', junkemail: 'SPAM' };

/** A category on a message is kept among its labels under this prefix, so it can never be mistaken for a folder. */
const CATEGORY = 'category:';
const TIMMY_CATEGORIES: readonly string[] = Object.values(LABEL_NAMES);

const SELECT = ['id', 'conversationId', 'subject', 'from', 'toRecipients', 'ccRecipients', 'receivedDateTime', 'sentDateTime', 'isRead', 'isDraft', 'parentFolderId', 'categories', 'body', 'bodyPreview'];
const stamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const payload = (data: Record<string, unknown>) => (data.response_data ?? data) as Record<string, unknown>;
const addressOf = (r?: GraphRecipient) => (r?.emailAddress?.address ?? '').trim().toLowerCase();

/** The ids of the well-known folders in this mailbox, looked up once and remembered on the connection. */
async function folders(workspaceId: string, conn: ConnectionRow, phase: Phase): Promise<Folders> {
  const fresh = (await connectionById(workspaceId, conn.id)) ?? conn;
  const known = fresh.meta.folders as Folders | undefined;
  if (known?.inbox && known.sentitems) return known;
  const found: Folders = {};
  for (const name of WELL_KNOWN) {
    const res = await callTool(workspaceId, conn.id, 'OUTLOOK_GET_MAIL_FOLDER', { mail_folder_id: name, select: ['id', 'displayName'] }, phase);
    const id = res.successful ? (payload(res.data).id as string | undefined) : undefined;
    if (id) found[name] = id;
  }
  // Without the inbox and Sent nothing can be told apart: better to stop than to file everything as "somewhere else".
  if (!found.inbox || !found.sentitems) throw new Error('Outlook did not say which folders are the inbox and Sent');
  await withWorkspace({ workspaceId }, (tx) => tx.query(`update connection set meta = meta || jsonb_build_object('folders', $2::jsonb), updated_at = now() where id = $1`, [conn.id, JSON.stringify(found)]));
  return found;
}

/** Outlook's message as the one shape Timmy stores. */
export function fromOutlook(m: GraphMessage, f: Folders): MailMessage | null {
  if (!m.id) return null;
  const labels: string[] = [];
  const folder = WELL_KNOWN.find((name) => f[name] && f[name] === m.parentFolderId);
  if (m.isDraft) labels.push('DRAFT');
  else if (folder) labels.push(FOLDER_LABEL[folder]);
  if (m.isRead === false && !labels.includes('SENT') && !labels.includes('DRAFT')) labels.push('UNREAD');
  for (const c of m.categories ?? []) labels.push(`${CATEGORY}${c}`);
  const at = new Date(m.receivedDateTime ?? m.sentDateTime ?? '');
  // The display name is whatever the sender chose. The characters that could make it read as an address or a comment are removed.
  const name = (m.from?.emailAddress?.name ?? '').replace(/[<>()"]/g, ' ').trim();
  const address = addressOf(m.from);
  const html = (m.body?.contentType ?? '').toLowerCase() === 'html';
  return {
    id: m.id,
    threadKey: m.conversationId || m.id,
    at: Number.isNaN(at.getTime()) ? new Date() : at,
    from: name ? `${name} <${address}>` : address,
    to: (m.toRecipients ?? []).map(addressOf).filter(Boolean),
    cc: (m.ccRecipients ?? []).map(addressOf).filter(Boolean),
    subject: String(m.subject ?? '').trim() || '(no subject)',
    text: (m.body?.content ? (html ? htmlToText(m.body.content) : m.body.content) : (m.bodyPreview ?? '')).replace(/\u0000/g, ''),
    labels,
    attachments: [],
  };
}

/** Mail that was thrown away, marked as junk or never sent is not something to work on or to search. */
const kept = (m: MailMessage | null): m is MailMessage => !!m && !m.labels.some((l) => l === 'TRASH' || l === 'SPAM' || l === 'DRAFT');

async function listMessages(workspaceId: string, conn: ConnectionRow, args: Record<string, unknown>, phase: Phase): Promise<{ messages: MailMessage[]; next?: string } | null> {
  const f = await folders(workspaceId, conn, phase);
  const res = await callTool(workspaceId, conn.id, 'OUTLOOK_LIST_MESSAGES', { folder: 'allfolders', select: SELECT, orderby: ['receivedDateTime desc'], ...args }, phase);
  if (!res.successful) return null;
  const data = payload(res.data);
  return { messages: ((data.value ?? []) as GraphMessage[]).map((m) => fromOutlook(m, f)).filter(kept), next: (data.next_page_token as string | null | undefined) || undefined };
}

const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The approved text as HTML, every character escaped, placed above whatever Outlook quoted in the reply draft. */
export function replyHtml(text: string, quoted: string): string {
  const mine = `<div>${escapeHtml(text).replace(/\r?\n/g, '<br>')}</div><br>`;
  const body = /<body\b[^>]*>/i.exec(quoted);
  return body ? quoted.slice(0, body.index + body[0].length) + mine + quoted.slice(body.index + body[0].length) : mine + quoted;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** The changes that put a conversation's received messages in `box`. Empty when the mailbox already shows it. */
export function outlookPlan(box: string, messages: MailMessage[]): { updates: { message_id: string; patch: { categories: string[] } }[]; toInbox: string[]; toArchive: string[] } {
  const want = Object.hasOwn(LABEL_NAMES, box) ? LABEL_NAMES[box as keyof typeof LABEL_NAMES] : null;
  const plan = { updates: [] as { message_id: string; patch: { categories: string[] } }[], toInbox: [] as string[], toArchive: [] as string[] };
  // Copies in Sent are the person's own messages; a place in Timmy is about what they received.
  for (const m of messages.filter((x) => !x.labels.includes('SENT'))) {
    const has = m.labels.filter((l) => l.startsWith(CATEGORY)).map((l) => l.slice(CATEGORY.length));
    // The person's own categories are kept; only Timmy's three are ever added or taken away.
    const next = [...has.filter((c) => !TIMMY_CATEGORIES.includes(c)), ...(want ? [want] : [])];
    if (!sameSet(has, next)) plan.updates.push({ message_id: m.id, patch: { categories: next } });
    if (box === 'archived' && m.labels.includes('INBOX')) plan.toArchive.push(m.id);
    if (box !== 'archived' && m.labels.includes('ARCHIVE')) plan.toInbox.push(m.id);
  }
  return plan;
}

/**
 * Whether the draft Outlook holds is addressed to exactly the approved people, in To and in Cc. It is checked on
 * what Outlook itself reports, right before sending. A report without the lists says nothing either way and passes.
 */
function addressedAsApproved(draft: GraphMessage, p: { to: string[]; cc?: string[] }): boolean {
  const lower = (list: string[]) => list.map((a) => a.toLowerCase());
  const to = draft.toRecipients?.map(addressOf);
  const cc = draft.ccRecipients?.map(addressOf);
  return (!to || sameSet(to, lower(p.to))) && (!cc || sameSet(cc, lower(p.cc ?? [])));
}

const chunks = <T>(list: T[], n: number): T[][] => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

export const outlook: Mailbox = {
  name: 'Outlook',

  async address(workspaceId, connectionId) {
    const res = await callTool(workspaceId, connectionId, 'OUTLOOK_GET_PROFILE', {}, 'connect').catch(() => null);
    const data = res?.successful ? (payload(res.data) as { mail?: string | null; userPrincipalName?: string | null }) : {};
    return (data.mail || data.userPrincipalName || '').toLowerCase() || null;
  },

  async page(workspaceId, conn, q) {
    const out = await listMessages(workspaceId, conn, { received_date_time_ge: stamp(q.since), top: q.pageSize, ...(q.pageToken ? { page_token: q.pageToken } : {}) }, q.phase);
    if (!out) throw new Error('the mailbox could not be listed');
    return out;
  },

  async thread(workspaceId, conn, threadKey, phase) {
    // Outlook only sorts a filtered list when the filter starts with the property it sorts by, hence the date that excludes nothing.
    const out = await listMessages(workspaceId, conn, { filter: `receivedDateTime ge 2000-01-01T00:00:00Z and conversationId eq '${threadKey.replace(/'/g, "''")}'`, top: 100 }, phase);
    return out ? out.messages.sort((a, b) => a.at.getTime() - b.at.getTime()) : null;
  },

  threadKeyOf(event) {
    const m = (event.message ?? {}) as { conversation_id?: string };
    const o = (event.outlook_message ?? {}) as { conversationId?: string };
    return String(m.conversation_id ?? o.conversationId ?? '');
  },
  // An Outlook event carries a preview only, under an id that changes when the message is moved. The thread is always fetched.
  seed: () => null,

  async send(e, conn, p) {
    const ws = e.workspace_id;
    const reply = e.kind === 'email.reply' && !!p.threadKey;
    let draft: GraphMessage;
    if (reply) {
      const thread = await outlook.thread(ws, conn, p.threadKey!, 'send');
      const last = thread?.at(-1);
      if (!last) return { status: 'failed', error: 'The thread could not be found in Outlook.' };
      const made = await callTool(ws, conn.id, 'OUTLOOK_CREATE_DRAFT_REPLY', { message_id: last.id }, 'send');
      draft = payload(made.data) as GraphMessage;
      if (!made.successful || !draft.id) return { status: 'failed', error: made.error ?? 'Outlook refused the reply.' };
      const set = await callTool(
        ws,
        conn.id,
        'OUTLOOK_UPDATE_EMAIL',
        { message_id: draft.id, to_recipients: p.to.map((address) => ({ address })), cc_recipients: (p.cc ?? []).map((address) => ({ address })), body: { contentType: 'HTML', content: replyHtml(p.body, draft.body?.content ?? '') } },
        'send',
      );
      // Nothing has been sent at this point: the draft stays in Drafts, unsent.
      if (!set.successful) return { status: 'failed', error: set.error ?? 'Outlook refused the reply.' };
      if (!addressedAsApproved(payload(set.data) as GraphMessage, p)) return { status: 'failed', error: 'Outlook did not take the recipients as approved, so the reply was not sent.' };
    } else {
      const made = await callTool(ws, conn.id, 'OUTLOOK_CREATE_DRAFT', { subject: p.subject, body: p.body, is_html: false, to_recipients: p.to, cc_recipients: p.cc ?? [] }, 'send');
      draft = payload(made.data) as GraphMessage;
      if (!made.successful || !draft.id) return { status: 'failed', error: made.error ?? 'Outlook refused the message.' };
      if (!addressedAsApproved(draft, p)) return { status: 'failed', error: 'Outlook did not take the recipients as approved, so the email was not sent.' };
    }
    const sent = await callTool(ws, conn.id, 'OUTLOOK_SEND_DRAFT', { message_id: draft.id }, 'send');
    if (!sent.successful) return { status: 'failed', error: sent.error ?? 'Outlook refused the message.' };
    return { status: 'completed', result: { via: 'outlook', id: draft.id, threadId: draft.conversationId ?? p.threadKey }, externalId: draft.id };
  },

  async findSent(e, conn, p, since) {
    const out = await listMessages(e.workspace_id, conn, { folder: 'sentitems', received_date_time_ge: stamp(new Date(since.getTime() - 120_000)), top: 25 }, 'send');
    if (!out) throw new Error('could not check the Sent folder');
    const words = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 200);
    const found = out.messages.find(
      (m) => m.to.includes(p.to[0]!.toLowerCase()) && (!p.threadKey || m.threadKey === p.threadKey) && (e.kind === 'email.reply' || m.subject === p.subject) && (!m.text || words(m.text).startsWith(words(p.body).slice(0, 80))),
    );
    return found ? { id: found.id, threadKey: found.threadKey } : null;
  },

  async file(e, conn, p) {
    const ws = e.workspace_id;
    let changed = 0;
    // The changes are worked out from what the mailbox shows now, so doing them again is harmless. If part of a
    // batch is refused, the conversation is read again and what is still missing is tried once more.
    for (let attempt = 0; attempt < 2; attempt++) {
      const messages = await outlook.thread(ws, conn, p.threadKey, 'send');
      if (!messages) {
        if (!changed) return { status: 'failed', error: 'Outlook could not be asked about the thread.' };
        break;
      }
      const plan = outlookPlan(p.box, messages);
      if (!plan.updates.length && !plan.toInbox.length && !plan.toArchive.length) return { status: 'completed', result: { via: 'outlook', changed } };
      const tally = { refused: null as string | null };
      const run = async (slug: string, args: Record<string, unknown>, size: number) => {
        const res = await callTool(ws, conn.id, slug, args, 'send');
        const data = payload(res.data) as { total_failed?: number; total_succeeded?: number };
        const failed = res.successful ? Number(data.total_failed ?? 0) : size;
        changed += res.successful ? Number(data.total_succeeded ?? size - failed) : 0;
        if (failed) tally.refused = res.error ?? 'Outlook refused part of the change.';
      };
      // Outlook takes at most 20 messages in one batch.
      for (const part of chunks(plan.updates, 20)) await run('OUTLOOK_BATCH_UPDATE_MESSAGES', { updates: part }, part.length);
      for (const part of chunks(plan.toArchive, 20)) await run('OUTLOOK_BATCH_MOVE_MESSAGES', { message_ids: part, destination_id: 'archive' }, part.length);
      for (const part of chunks(plan.toInbox, 20)) await run('OUTLOOK_BATCH_MOVE_MESSAGES', { message_ids: part, destination_id: 'inbox' }, part.length);
      if (!tally.refused) return { status: 'completed', result: { via: 'outlook', changed } };
      // Refused outright, with nothing changed: a clean failure.
      if (!changed) return { status: 'failed', error: tally.refused };
    }
    // Part of it went through and part did not. That is an unknown, and the check that follows looks at the mailbox.
    throw new Error('Outlook applied only part of the filing');
  },

  async filed(e, conn, p) {
    const messages = await outlook.thread(e.workspace_id, conn, p.threadKey, 'send');
    if (!messages) return null;
    const plan = outlookPlan(p.box, messages);
    return !plan.updates.length && !plan.toInbox.length && !plan.toArchive.length;
  },
};
