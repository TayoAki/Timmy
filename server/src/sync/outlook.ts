/**
 * Outlook (Microsoft 365 and Outlook.com), through Composio's `outlook` toolkit.
 *
 * How Outlook differs from Gmail, and what is done about it here:
 *   - A thread is a "conversation", and its messages are listed with a filter rather than fetched by id.
 *   - Where a message sits is a folder, not a label. The folders are looked up once and translated into the
 *     same words the rest of the code uses (INBOX, SENT, DRAFT, TRASH, SPAM).
 *   - A thread's place in Timmy is written as a category on its messages ("Timmy Follow Up" and so on), which
 *     is Outlook's closest thing to a label. Archiving moves the messages to the Archive folder; a mailbox
 *     that has none gets one, once, the first time a thread is archived.
 *   - Bodies arrive as HTML and are stored as text. A listing says only whether a message has files; their
 *     names are asked for apart, once, for mail not stored yet (attachment-names.ts).
 *   - A reply is made as a draft, addressed to exactly the approved people, and then sent. Outlook's own
 *     "reply" would choose the recipients itself, and what was approved is what must go out.
 *   - Files are added to the draft one at a time, and the draft is checked for exactly the approved files
 *     before it is sent. The tool that adds a file takes small ones (under 3 MB).
 *   - A send that stops before the draft is sent (recipients refused, a file not taken) removes the draft it
 *     made, and only that one.
 */
import { withWorkspace } from '../db/pool';
import { stageFiles, type FileToSend } from '../files/attachments';
import type { Outcome } from '../gateway/gateway';
import { log } from '../lib/log';
import { LABEL_NAMES, type Labelled } from './labels';
import type { Mailbox, MessageState } from './mailbox';
import { htmlToText, parseSender, type MailMessage } from './message';
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
  /** Whether it carries files. Pictures placed inside the body do not count. */
  hasAttachments?: boolean;
}

/** The folders whose meaning matters, by Outlook's own fixed names. A mailbox may lack one (not every account has Archive). */
const WELL_KNOWN = ['inbox', 'sentitems', 'drafts', 'archive', 'deleteditems', 'junkemail'] as const;
/** `madeArchive`: the mailbox had no Archive folder, so Timmy made one; `archive` is then that folder's id, and moves go to it by id. */
type Folders = Partial<Record<(typeof WELL_KNOWN)[number], string>> & { madeArchive?: true };
const FOLDER_LABEL: Record<(typeof WELL_KNOWN)[number], string> = { inbox: 'INBOX', sentitems: 'SENT', drafts: 'DRAFT', archive: 'ARCHIVE', deleteditems: 'TRASH', junkemail: 'SPAM' };

/** A category on a message is kept among its labels under this prefix, so it can never be mistaken for a folder. */
const CATEGORY = 'category:';
const TIMMY_CATEGORIES: readonly string[] = Object.values(LABEL_NAMES);

const SELECT = ['id', 'conversationId', 'subject', 'from', 'toRecipients', 'ccRecipients', 'receivedDateTime', 'sentDateTime', 'isRead', 'isDraft', 'parentFolderId', 'categories', 'body', 'bodyPreview', 'hasAttachments'];
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
    // Outlook's listing does not name the files; they are asked for apart, for mail not yet stored (attachment-names.ts).
    attachments: [],
    ...(m.hasAttachments ? { hasAttachments: true } : {}),
  };
}

/**
 * The folder archived mail goes to, by what a move takes: Outlook's own Archive folder by its fixed name, or one
 * Timmy made by its id. A mailbox with no Archive folder gets one, once, the first time a thread is archived: it is
 * part of carrying out that approved filing, and it is remembered on the connection so it is never made again.
 * The tool hands back a folder of that name that is already there, so two filings at once make one folder.
 * Returns null, with Outlook's reason, when Outlook would not make it.
 */
async function archiveFolder(workspaceId: string, conn: ConnectionRow, f: Folders): Promise<{ destination: string; made: boolean } | { refused: string }> {
  if (f.archive) return { destination: f.madeArchive ? f.archive : 'archive', made: false };
  const res = await callTool(workspaceId, conn.id, 'OUTLOOK_CREATE_MAIL_FOLDER', { display_name: 'Archive', return_existing_if_exists: true }, 'send');
  const id = res.successful ? (payload(res.data).id as string | undefined) : undefined;
  if (!id) return { refused: res.error ?? 'Outlook did not say which folder it made' };
  await withWorkspace({ workspaceId }, (tx) =>
    tx.query(`update connection set meta = jsonb_set(meta, '{folders}', coalesce(meta->'folders', '{}'::jsonb) || $2::jsonb), updated_at = now() where id = $1 and workspace_id = $3`, [conn.id, JSON.stringify({ archive: id, madeArchive: true }), workspaceId]),
  );
  return { destination: id, made: true };
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

/**
 * Whether the draft Outlook holds carries exactly the approved files, by name: none missing, none extra.
 * Pictures placed inside the body (a quoted message's own) are not attachments and are left out of the count.
 * Sizes are not compared: Outlook reports an attachment as a little larger than the file. If Outlook can't be
 * asked, the answer is no, and the email is not sent.
 */
async function carriesAsApproved(workspaceId: string, connectionId: string, draftId: string, files: { name: string }[]): Promise<boolean> {
  const res = await callTool(workspaceId, connectionId, 'OUTLOOK_LIST_OUTLOOK_ATTACHMENTS', { message_id: draftId, response_detail: 'minimal' }, 'send');
  if (!res.successful) return false;
  const listed = ((payload(res.data).value ?? []) as { name?: string; isInline?: boolean }[]).filter((a) => !a.isInline).map((a) => String(a.name ?? ''));
  const sorted = (names: string[]) => [...names].sort().join('\u0000');
  return listed.length === files.length && sorted(listed) === sorted(files.map((f) => f.name));
}

/**
 * Puts the approved files on a draft, one call per file, and then checks that the draft carries exactly those.
 * The same steps serve a new email and a reply (a reply draft can't be made with files on it), so there is one
 * way files reach Outlook. Each file is handed to Composio for this tool first. Returns why the draft is not
 * ready, in words for the person, or null when it is. The draft has not been sent at any point in here, so
 * every failure, including a call that never came back, is a clean one: nothing went out.
 */
async function attachToDraft(workspaceId: string, conn: ConnectionRow, draftId: string, files: FileToSend[]): Promise<string | null> {
  try {
    for (const file of files) {
      const handed = await stageFiles(workspaceId, conn, 'OUTLOOK_ADD_MAIL_ATTACHMENT', [file]);
      if (!handed.ok) return handed.error;
      const added = await callTool(workspaceId, conn.id, 'OUTLOOK_ADD_MAIL_ATTACHMENT', { message_id: draftId, attachment: handed.staged[0] }, 'send');
      if (!added.successful) {
        log.warn('Outlook refused an attachment', { error: added.error });
        return `Outlook refused the attached file “${file.name}”, so the email was not sent.`;
      }
    }
    return (await carriesAsApproved(workspaceId, conn.id, draftId, files)) ? null : 'Outlook did not take the attachments as approved, so the email was not sent.';
  } catch (e) {
    log.warn('Outlook could not be reached while files were being added to a draft', { error: (e as Error).message });
    return 'Outlook could not be reached while the files were being added, so the email was not sent.';
  }
}

/**
 * Takes the draft this send made back out of Drafts, when the send stopped before the draft was sent: Outlook
 * refused the reply's recipients, or the files could not be put on it. Only that draft is touched, by the id
 * Outlook gave it a moment ago in this same send, and only before the send was asked for; nothing else in the
 * mailbox is ever deleted. The send's result records whether it was removed. If it could not be, it stays in
 * Drafts, unsent, as before.
 */
async function discardDraft(workspaceId: string, conn: ConnectionRow, draftId: string, error: string): Promise<Outcome> {
  let removed = false;
  try {
    const res = await callTool(workspaceId, conn.id, 'OUTLOOK_DELETE_MESSAGE', { message_id: draftId }, 'send');
    removed = res.successful;
    if (!removed) log.warn('could not remove a draft a stopped send had made', { error: res.error });
  } catch (e) {
    log.warn('could not remove a draft a stopped send had made', { error: (e as Error).message });
  }
  return { status: 'failed', error, result: { draft: draftId, draftRemoved: removed } };
}

/** What is asked of Outlook when only where each message sits matters: no body and no subject. Who wrote it is asked only to tell the person's own messages apart. */
const STATE_SELECT = ['id', 'conversationId', 'from', 'receivedDateTime', 'sentDateTime', 'isRead', 'isDraft', 'parentFolderId', 'categories'];
const toState = (conn: ConnectionRow) => {
  const own = (conn.account_label ?? '').toLowerCase();
  return (m: MailMessage): MessageState => ({
    id: m.id,
    threadKey: m.threadKey,
    at: m.at,
    labels: m.labels,
    filedAs: (Object.keys(LABEL_NAMES) as Labelled[]).filter((place) => m.labels.includes(`${CATEGORY}${LABEL_NAMES[place]}`)),
    mine: m.labels.includes('SENT') || (!!own && parseSender(m.from).email === own),
  });
};

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

  async send(e, conn, p, files = []) {
    const ws = e.workspace_id;
    const reply = e.kind === 'email.reply' && !!p.threadKey;
    // An email approved with files never goes out without them.
    if (files.length !== (p.attachments?.length ?? 0)) return { status: 'failed', error: 'The email’s attachments were not ready, so it was not sent.' };
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
      // Nothing has been sent at this point. The draft this reply made is taken out of Drafts again.
      if (!set.successful) return discardDraft(ws, conn, draft.id, set.error ?? 'Outlook refused the reply.');
      if (!addressedAsApproved(payload(set.data) as GraphMessage, p)) return discardDraft(ws, conn, draft.id, 'Outlook did not take the recipients as approved, so the reply was not sent.');
    } else {
      const made = await callTool(ws, conn.id, 'OUTLOOK_CREATE_DRAFT', { subject: p.subject, body: p.body, is_html: false, to_recipients: p.to, cc_recipients: p.cc ?? [] }, 'send');
      draft = payload(made.data) as GraphMessage;
      if (!made.successful || !draft.id) return { status: 'failed', error: made.error ?? 'Outlook refused the message.' };
      if (!addressedAsApproved(draft, p)) return discardDraft(ws, conn, draft.id, 'Outlook did not take the recipients as approved, so the email was not sent.');
    }
    // The approved files go onto the draft, and the draft is checked for them, before anything is sent.
    const notAttached = files.length ? await attachToDraft(ws, conn, draft.id, files) : null;
    if (notAttached) return discardDraft(ws, conn, draft.id, notAttached);
    const sent = await callTool(ws, conn.id, 'OUTLOOK_SEND_DRAFT', { message_id: draft.id }, 'send');
    // Refused at the very send, the draft is left where it is: whether the send started can't be told from here,
    // and a message that did go out must not be deleted. The record says the draft may still be there.
    if (!sent.successful) return { status: 'failed', error: sent.error ?? 'Outlook refused the message.', result: { draft: draft.id, draftRemoved: false } };
    return { status: 'completed', result: { via: 'outlook', id: draft.id, threadId: draft.conversationId ?? p.threadKey }, externalId: draft.id };
  },

  async attachmentNames(workspaceId, conn, messageId, phase) {
    const res = await callTool(workspaceId, conn.id, 'OUTLOOK_LIST_OUTLOOK_ATTACHMENTS', { message_id: messageId, response_detail: 'minimal' }, phase);
    if (!res.successful) return null;
    // A picture placed inside the body (a signature's logo) is not a file the sender attached.
    const listed = ((payload(res.data).value ?? []) as { name?: string; isInline?: boolean }[]).filter((a) => !a.isInline);
    // The name is the sender's text: control characters go, and it is kept short.
    return listed.map((a) => String(a.name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200)).filter(Boolean);
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
    // Set when this filing had to make the mailbox's Archive folder; kept in the result.
    let made: string | undefined;
    // The changes are worked out from what the mailbox shows now, so doing them again is harmless. If part of a
    // batch is refused, the conversation is read again and what is still missing is tried once more.
    for (let attempt = 0; attempt < 2; attempt++) {
      const messages = await outlook.thread(ws, conn, p.threadKey, 'send');
      if (!messages) {
        if (!changed) return { status: 'failed', error: 'Outlook could not be asked about the thread.' };
        break;
      }
      const plan = outlookPlan(p.box, messages);
      const done = { via: 'outlook', changed, ...(made ? { madeFolder: made } : {}) };
      if (!plan.updates.length && !plan.toInbox.length && !plan.toArchive.length) return { status: 'completed', result: done };
      // Where archived mail goes is settled before anything is changed, so a mailbox that can't have one fails cleanly.
      let archive = 'archive';
      if (plan.toArchive.length) {
        // A folder made twice is the same folder (the tool hands back the one already there), so no answer here is a clean failure while nothing has moved.
        const folder = await archiveFolder(ws, conn, await folders(ws, conn, 'send')).catch((err: Error) => {
          if (changed) throw err;
          return { refused: err.message };
        });
        if ('refused' in folder) {
          if (!changed) return { status: 'failed', error: `This Outlook mailbox has no Archive folder, and Outlook would not make one: ${folder.refused}` };
          break;
        }
        archive = folder.destination;
        if (folder.made) made = 'Archive';
      }
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
      for (const part of chunks(plan.toArchive, 20)) await run('OUTLOOK_BATCH_MOVE_MESSAGES', { message_ids: part, destination_id: archive }, part.length);
      for (const part of chunks(plan.toInbox, 20)) await run('OUTLOOK_BATCH_MOVE_MESSAGES', { message_ids: part, destination_id: 'inbox' }, part.length);
      if (!tally.refused) return { status: 'completed', result: { via: 'outlook', changed, ...(made ? { madeFolder: made } : {}) } };
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

  async recentStates(workspaceId, conn, q) {
    const f = await folders(workspaceId, conn, q.phase);
    // Every folder is listed, Deleted Items and Junk included, because having been moved there is the news.
    const res = await callTool(workspaceId, conn.id, 'OUTLOOK_LIST_MESSAGES', { folder: 'allfolders', select: STATE_SELECT, orderby: ['receivedDateTime desc'], received_date_time_ge: stamp(q.since), top: q.pageSize, ...(q.pageToken ? { page_token: q.pageToken } : {}) }, q.phase);
    if (!res.successful) throw new Error(res.error ?? 'the mailbox could not be listed');
    const data = payload(res.data);
    const messages = ((data.value ?? []) as GraphMessage[]).map((m) => fromOutlook(m, f)).filter((m): m is MailMessage => !!m);
    return { messages: messages.map(toState(conn)), next: (data.next_page_token as string | null | undefined) || undefined };
  },

  statesOf: async (_workspaceId, conn, messages) => messages.map(toState(conn)),
};
