/**
 * Gmail, through Composio's `gmail` toolkit. A thread's place is a label
 * (see labels.ts); a reply goes into the thread by its id.
 */
import { stageFiles } from '../files/attachments';
import { LabelsUnavailable, labelPlan, timmyLabels, timmyLabelsIfAny, type Labelled } from './labels';
import type { Mailbox, MessageState } from './mailbox';
import { normalize, parseSender, type MailMessage } from './message';
import { callTool, type ConnectionRow, type Phase } from './tools';

const list = (raw: unknown): MailMessage[] => ((raw ?? []) as Record<string, unknown>[]).map(normalize).filter((m): m is MailMessage => !!m);

/** Gmail's own labels. Anything else on a message is a label a person or an app made, and only those can be Timmy's. */
const GMAIL_OWN = /^(INBOX|SENT|DRAFT|UNREAD|TRASH|SPAM|STARRED|IMPORTANT|CHAT|CATEGORY_[A-Z_]+)$/;

/** Where each message sits, and which of Timmy's labels it carries. Looks the labels' ids up only when a message carries a label that could be one of them. */
async function states(workspaceId: string, conn: ConnectionRow, messages: MailMessage[], phase: Phase): Promise<MessageState[]> {
  const ids = messages.some((m) => m.labels.some((l) => !GMAIL_OWN.test(l))) ? await timmyLabelsIfAny(workspaceId, conn, phase) : {};
  const places = new Map((Object.entries(ids) as [Labelled, string][]).map(([place, id]) => [id, place]));
  const own = (conn.account_label ?? '').toLowerCase();
  return messages.map((m) => ({
    id: m.id,
    threadKey: m.threadKey,
    at: m.at,
    labels: m.labels,
    filedAs: m.labels.map((l) => places.get(l)).filter((p): p is Labelled => !!p),
    mine: m.labels.includes('SENT') || (!!own && parseSender(m.from).email === own),
  }));
}

export const gmail: Mailbox = {
  name: 'Gmail',

  async address(workspaceId, connectionId) {
    const profile = await callTool(workspaceId, connectionId, 'GMAIL_GET_PROFILE', {}, 'connect').catch(() => null);
    const data = (profile?.data.response_data ?? profile?.data ?? {}) as { emailAddress?: string };
    return data.emailAddress ?? null;
  },

  async page(workspaceId, conn, q) {
    const res = await callTool(workspaceId, conn.id, 'GMAIL_FETCH_EMAILS', { query: `after:${Math.floor(q.since.getTime() / 1000)}`, max_results: q.pageSize, include_payload: false, ...(q.pageToken ? { page_token: q.pageToken } : {}) }, q.phase);
    if (!res.successful) throw new Error(res.error ?? 'the mailbox could not be listed');
    return { messages: list(res.data.messages), next: (res.data.nextPageToken as string | null | undefined) || undefined };
  },

  async thread(workspaceId, conn, threadKey, phase) {
    const res = await callTool(workspaceId, conn.id, 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID', { thread_id: threadKey }, phase);
    return res.successful ? list(res.data.messages) : null;
  },

  threadKeyOf: (event) => String(event.thread_id ?? event.threadId ?? ''),
  seed: (event) => normalize(event),

  async send(e, conn, p, files = []) {
    const reply = e.kind === 'email.reply' && !!p.threadKey;
    const [first, ...rest] = p.to;
    // An email approved with files never goes out without them.
    if (files.length !== (p.attachments?.length ?? 0)) return { status: 'failed', error: 'The email’s attachments were not ready, so it was not sent.' };
    // Attached files are handed to Composio first, for the tool that will send them. If that fails, nothing has gone out.
    const handed = await stageFiles(e.workspace_id, conn, reply ? 'GMAIL_REPLY_TO_THREAD' : 'GMAIL_SEND_EMAIL', files);
    if (!handed.ok) return { status: 'failed', error: handed.error };
    const attachment = handed.staged.length ? { attachment: handed.staged } : {};
    // What was approved is what goes out: Gmail is told not to add the account's signature to it.
    const res = reply
      ? await callTool(e.workspace_id, conn.id, 'GMAIL_REPLY_TO_THREAD', { thread_id: p.threadKey, message_body: p.body, recipient_email: first, extra_recipients: rest, cc: p.cc ?? [], is_html: false, include_signature: false, ...attachment }, 'send')
      : await callTool(e.workspace_id, conn.id, 'GMAIL_SEND_EMAIL', { recipient_email: first, extra_recipients: rest, cc: p.cc ?? [], subject: p.subject, body: p.body, is_html: false, include_signature: false, ...attachment }, 'send');
    if (!res.successful) return { status: 'failed', error: res.error ?? 'Gmail refused the message.' };
    const sent = ((res.data.response_data ?? res.data) as { id?: string; threadId?: string }) ?? {};
    return { status: 'completed', result: { via: 'gmail', id: sent.id, threadId: sent.threadId ?? p.threadKey }, externalId: sent.id };
  },

  async findSent(e, conn, p, since) {
    const after = Math.floor(since.getTime() / 1000) - 120;
    const subject = e.kind === 'email.reply' ? '' : ` subject:"${p.subject.replace(/"/g, '')}"`;
    const res = await callTool(e.workspace_id, conn.id, 'GMAIL_FETCH_EMAILS', { query: `in:sent to:${p.to[0]}${subject} after:${after}`, max_results: 10, include_payload: false }, 'send');
    if (!res.successful) throw new Error(res.error ?? 'could not check the Sent folder');
    // Compare on the words only: line endings and spacing differ between what was sent and what the provider returns.
    const words = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 200);
    const found = ((res.data.messages ?? []) as { messageId: string; threadId: string; to?: string; messageText?: string }[]).find(
      (m) => (m.to ?? '').toLowerCase().includes(p.to[0]!.toLowerCase()) && (!p.threadKey || m.threadId === p.threadKey) && (!m.messageText || words(m.messageText).startsWith(words(p.body).slice(0, 80))),
    );
    return found ? { id: found.messageId, threadKey: found.threadId } : null;
  },

  async file(e, conn, p) {
    const change = async (refresh: boolean) => {
      const plan = labelPlan(p.box, await timmyLabels(e.workspace_id, conn, refresh));
      return { plan, res: await callTool(e.workspace_id, conn.id, 'GMAIL_MODIFY_THREAD_LABELS', { thread_id: p.threadKey, add_label_ids: plan.add, remove_label_ids: plan.remove }, 'send') };
    };
    try {
      let { plan, res } = await change(false);
      // The label ids are remembered. If the person deleted a label in Gmail the remembered id is refused, so a
      // refusal is tried once more with the labels looked up afresh. A refused change changed nothing.
      if (!res.successful && conn.meta.labels) ({ plan, res } = await change(true));
      if (!res.successful) return { status: 'failed', error: res.error ?? 'Gmail refused the change.' };
      return { status: 'completed', result: { via: 'gmail', added: plan.add, removed: plan.remove } };
    } catch (err) {
      // Getting the labels ready failed before anything was asked of the thread: a clean failure, not an unknown.
      if (err instanceof LabelsUnavailable) return { status: 'failed', error: err.message };
      throw err;
    }
  },

  async filed(e, conn, p) {
    const ids = await timmyLabels(e.workspace_id, conn).catch(() => null);
    if (!ids) return null;
    const plan = labelPlan(p.box, ids);
    const res = await callTool(e.workspace_id, conn.id, 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID', { thread_id: p.threadKey }, 'send');
    const messages = res.successful ? ((res.data.messages ?? []) as { labelIds?: string[] }[]) : [];
    if (!messages.length) return null;
    // Sent copies never carry INBOX, so the inbox label is judged on any message; Timmy's labels on every message.
    const has = (id: string) => (id === 'INBOX' ? messages.some((m) => m.labelIds?.includes(id)) : messages.every((m) => m.labelIds?.includes(id)));
    const lacks = (id: string) => messages.every((m) => !m.labelIds?.includes(id));
    return plan.add.every(has) && plan.remove.every(lacks);
  },

  async recentStates(workspaceId, conn, q) {
    // Labels and ids only: no message is opened. The trash and spam are included, because being there is the news.
    const res = await callTool(
      workspaceId,
      conn.id,
      'GMAIL_FETCH_EMAILS',
      { query: `after:${Math.floor(q.since.getTime() / 1000)}`, max_results: q.pageSize, include_payload: false, verbose: false, include_spam_trash: true, ...(q.pageToken ? { page_token: q.pageToken } : {}) },
      q.phase,
    );
    if (!res.successful) throw new Error(res.error ?? 'the mailbox could not be listed');
    const messages = list(res.data.messages);
    // A message with no label at all reads as archived. A whole page of them is far more likely a listing that
    // came back without its labels than a mailbox where everything was archived, so it is not believed.
    if (messages.length >= 5 && messages.every((m) => !m.labels.length)) throw new Error('the mailbox listing came without labels');
    return { messages: await states(workspaceId, conn, messages, q.phase), next: (res.data.nextPageToken as string | null | undefined) || undefined };
  },

  statesOf: states,
};
