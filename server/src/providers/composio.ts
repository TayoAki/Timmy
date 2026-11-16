import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Composio } from '@composio/core';
import { config } from '../config';
import { newId } from '../lib/ids';
import { htmlToText } from '../sync/message';

/**
 * The one door to Composio. The API key lives in this module and is handed to
 * the SDK only: callers pass a user and a connected account, never a credential.
 */
export interface ToolResult {
  successful: boolean;
  data: Record<string, unknown>;
  error: string | null;
}

export interface ProviderEvent {
  /** Unique per delivery: used to drop repeats. */
  id: string;
  triggerSlug: string;
  connectedAccountId: string;
  userId: string;
  data: Record<string, unknown>;
}

export interface ComposioProvider {
  /** Starts a connect flow and returns where to send the person. */
  link(input: { userId: string; toolkit: string; callbackUrl: string }): Promise<{ redirectUrl: string; connectedAccountId: string; authConfigId: string }>;
  account(connectedAccountId: string): Promise<{ status: string; label?: string }>;
  disconnect(connectedAccountId: string): Promise<void>;
  execute(slug: string, args: Record<string, unknown>, who: { userId: string; connectedAccountId: string }): Promise<ToolResult>;
  createTrigger(slug: string, input: { userId: string; connectedAccountId: string; config?: Record<string, unknown> }): Promise<{ triggerId: string }>;
  deleteTrigger(triggerId: string): Promise<void>;
  /** Points Composio's event deliveries at our webhook. Returns the signing secret when Composio issues a new one. */
  ensureWebhook(url: string): Promise<{ secret?: string }>;
  /** Checks the signature and returns the event. Throws when the signature is wrong or stale. */
  parseWebhook(headers: Headers, rawBody: string, secret: string): ProviderEvent;
}

/* ───────────── Webhook signatures (shared by the real and the fake provider) ───────────── */

export function signWebhook(id: string, timestamp: string, rawBody: string, secret: string): string {
  return `v1,${createHmac('sha256', secret).update(`${id}.${timestamp}.${rawBody}`).digest('base64')}`;
}

export function verifyWebhookSignature(headers: Headers, rawBody: string, secret: string, toleranceSeconds = 300): string {
  const id = headers.get('webhook-id') ?? '';
  const timestamp = headers.get('webhook-timestamp') ?? '';
  const given = headers.get('webhook-signature') ?? '';
  if (!secret) throw new Error('webhook secret is not configured');
  if (!id || !timestamp || !given) throw new Error('webhook signature headers are missing');
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) throw new Error('webhook timestamp is outside the allowed window');
  const want = Buffer.from(signWebhook(id, timestamp, rawBody, secret));
  // The header may carry several space-separated signatures (during a secret rotation).
  const ok = given.split(' ').some((sig) => {
    const got = Buffer.from(sig);
    return got.length === want.length && timingSafeEqual(got, want);
  });
  if (!ok) throw new Error('webhook signature does not match');
  return id;
}

function eventFrom(id: string, rawBody: string): ProviderEvent {
  const body = JSON.parse(rawBody) as Record<string, unknown>;
  const meta = (body.metadata ?? {}) as Record<string, unknown>;
  return {
    id: String(body.id ?? id),
    triggerSlug: String(meta.trigger_slug ?? body.type ?? ''),
    connectedAccountId: String(meta.connected_account_id ?? ''),
    userId: String(meta.user_id ?? ''),
    data: (body.data ?? {}) as Record<string, unknown>,
  };
}

/* ───────────── The real provider ───────────── */

const SCOPED_NAME = /^timmy-.+-[0-9a-f]{8}$/;

/**
 * The name and permissions of the Composio-managed auth config for a toolkit. With a narrowed set of permissions the
 * name ends in a fingerprint of that set, so changing the set makes a new config instead of quietly reusing the old one.
 */
export function managedAuthConfig(toolkit: string): { name: string; scopes?: string[] } {
  const scopes = config.composio.scopes[toolkit];
  if (!scopes?.length) return { name: `timmy-${toolkit}` };
  return { name: `timmy-${toolkit}-${createHash('sha256').update([...scopes].sort().join(',')).digest('hex').slice(0, 8)}`, scopes };
}

class RealComposio implements ComposioProvider {
  // Every toolkit runs at the version pinned in config. A tool from a toolkit with no pinned version is refused
  // by the client, so nothing ever runs at "whatever is newest".
  private client = new Composio({ apiKey: config.composio.apiKey, toolkitVersions: config.composio.toolkitVersions });
  private authConfigs = new Map<string, string>();

  /** The auth config for a toolkit: the id from config when set, else Composio's managed OAuth app. */
  private async authConfigFor(toolkit: string): Promise<string> {
    const configured = config.composio.authConfigs[toolkit];
    if (configured) return configured;
    const cached = this.authConfigs.get(toolkit);
    if (cached) return cached;
    const { name, scopes } = managedAuthConfig(toolkit);
    const existing = await this.client.authConfigs.list({ toolkit, isComposioManaged: true });
    const listed = (existing.items ?? []) as { id: string; name?: string }[];
    // A config made for a different set of permissions is never reused: the name carries a fingerprint of the set.
    let id = listed.find((c) => c.name === name)?.id ?? (scopes ? undefined : listed.find((c) => !SCOPED_NAME.test(c.name ?? ''))?.id);
    if (!id) {
      const created = await this.client.authConfigs.create(toolkit, { type: 'use_composio_managed_auth', name, ...(scopes ? { credentials: { scopes } } : {}) });
      id = created.id;
    }
    this.authConfigs.set(toolkit, id);
    return id;
  }

  async link({ userId, toolkit, callbackUrl }: { userId: string; toolkit: string; callbackUrl: string }) {
    const authConfigId = await this.authConfigFor(toolkit);
    const req = await this.client.connectedAccounts.link(userId, authConfigId, { callbackUrl, allowMultiple: true });
    if (!req.redirectUrl) throw new Error('Composio returned no connect link');
    return { redirectUrl: req.redirectUrl, connectedAccountId: req.id, authConfigId };
  }

  async account(connectedAccountId: string) {
    const a = (await this.client.connectedAccounts.get(connectedAccountId)) as unknown as { status: string };
    return { status: a.status };
  }

  async disconnect(connectedAccountId: string) {
    await this.client.connectedAccounts.delete(connectedAccountId);
  }

  async execute(slug: string, args: Record<string, unknown>, who: { userId: string; connectedAccountId: string }): Promise<ToolResult> {
    const res = await this.client.tools.execute(slug, { userId: who.userId, connectedAccountId: who.connectedAccountId, arguments: args });
    return { successful: !!res.successful, data: (res.data ?? {}) as Record<string, unknown>, error: res.error ?? null };
  }

  async createTrigger(slug: string, input: { userId: string; connectedAccountId: string; config?: Record<string, unknown> }) {
    const t = await this.client.triggers.create(input.userId, slug, { connectedAccountId: input.connectedAccountId, triggerConfig: input.config ?? {} });
    return { triggerId: t.triggerId };
  }

  async deleteTrigger(triggerId: string) {
    await this.client.triggers.delete(triggerId);
  }

  async ensureWebhook(url: string) {
    const sub = (await this.client.triggers.setWebhookSubscription({ webhookUrl: url })) as unknown as { secret?: string };
    return { secret: sub.secret };
  }

  parseWebhook(headers: Headers, rawBody: string, secret: string): ProviderEvent {
    const id = verifyWebhookSignature(headers, rawBody, secret);
    return eventFrom(id, rawBody);
  }
}

/* ───────────── The fake provider ───────────── */

export interface FakeMessage {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  at: Date;
  /** Where the message sits, in Gmail's words. The stand-in Outlook reads the same list as folders (ARCHIVE is its Archive folder). */
  labels: string[];
  /** Outlook only: the categories on the message. */
  categories?: string[];
  /** Outlook only: the HTML body, when it differs from a plain rendering of `body`. */
  html?: string;
}

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  owner: string;
  trashed?: boolean;
  /** The link Drive gives for opening the file. Set only to test what is done with an odd one. */
  link?: string;
  /** What the file says: a doc's text (blank lines split paragraphs), a sheet's rows, or a deck's slides. */
  text?: string;
  rows?: (string | number)[][];
}

export interface FakeMailbox {
  address: string;
  status: 'INITIATED' | 'ACTIVE';
  toolkit: string;
  userId: string;
  messages: FakeMessage[];
  /** `invited` is set on events Timmy created with invitations sent. */
  events: { id: string; summary: string; start: string; end: string; attendees: string[]; invited?: boolean }[];
  /** Labels the person or Timmy made: name → id. */
  labels: Map<string, string>;
  /** Drive only: the files in the account. */
  files: FakeFile[];
}

/**
 * A stand-in for Composio that keeps mailboxes in memory. It answers the same
 * tool slugs with the same shapes the real toolkits return, so the sync and
 * send code paths run unchanged in tests.
 */
export class FakeComposio implements ComposioProvider {
  /** Random per process, so a deployed server running the fake cannot be fed events by someone who read the code. */
  readonly secret = `fake-${randomBytes(16).toString('hex')}`;
  accounts = new Map<string, FakeMailbox>();
  triggers = new Map<string, { slug: string; connectedAccountId: string; userId: string }>();
  /** Every tool call, for assertions and for counting calls. */
  calls: { slug: string; args: Record<string, unknown>; connectedAccountId: string }[] = [];
  /** Make the next execution of a slug fail: 'error' is a clean refusal, 'timeout' leaves the outcome unknown. */
  failNext = new Map<string, 'error' | 'timeout' | 'sent-then-timeout' | 'partial'>();
  /** The address the next connect flow will sign in as. */
  nextAddress = '';

  reset() {
    this.accounts.clear();
    this.triggers.clear();
    this.calls = [];
    this.failNext.clear();
    this.nextAddress = '';
  }

  async link({ userId, toolkit, callbackUrl }: { userId: string; toolkit: string; callbackUrl: string }) {
    const connectedAccountId = newId('ca_fake');
    this.accounts.set(connectedAccountId, { address: this.nextAddress || `${userId.slice(0, 8)}@example.test`, status: 'INITIATED', toolkit, userId, messages: [], events: [], labels: new Map(), files: [] });
    const redirectUrl = `${config.publicUrl}/api/test/fake-connect?account=${connectedAccountId}&to=${encodeURIComponent(callbackUrl)}`;
    return { redirectUrl, connectedAccountId, authConfigId: `ac_fake_${toolkit}` };
  }

  /** What Google's consent screen does in real life. */
  completeConnect(connectedAccountId: string) {
    const a = this.accounts.get(connectedAccountId);
    if (a) a.status = 'ACTIVE';
  }

  async account(connectedAccountId: string) {
    const a = this.accounts.get(connectedAccountId);
    return { status: a?.status ?? 'FAILED', label: a?.address };
  }

  async disconnect(connectedAccountId: string) {
    this.accounts.delete(connectedAccountId);
  }

  async createTrigger(slug: string, input: { userId: string; connectedAccountId: string }) {
    const triggerId = newId('ti_fake');
    this.triggers.set(triggerId, { slug, connectedAccountId: input.connectedAccountId, userId: input.userId });
    return { triggerId };
  }

  async deleteTrigger(triggerId: string) {
    this.triggers.delete(triggerId);
  }

  async ensureWebhook() {
    return { secret: this.secret };
  }

  parseWebhook(headers: Headers, rawBody: string, secret: string): ProviderEvent {
    const id = verifyWebhookSignature(headers, rawBody, secret);
    return eventFrom(id, rawBody);
  }

  /** Puts a message in a fake mailbox and returns the signed webhook Composio would send for it. */
  deliver(connectedAccountId: string, m: Partial<FakeMessage> & { from: string; subject: string; body: string }) {
    const box = this.accounts.get(connectedAccountId);
    if (!box) throw new Error('no such fake account');
    const msg: FakeMessage = { id: m.id ?? newId('m'), threadId: m.threadId ?? newId('t'), from: m.from, to: m.to ?? [box.address], cc: m.cc, subject: m.subject, body: m.body, at: m.at ?? new Date(), labels: m.labels ?? ['INBOX', 'UNREAD'] };
    box.messages.push(msg);
    const outlook = box.toolkit === 'outlook';
    const slug = outlook ? 'OUTLOOK_MESSAGE_TRIGGER' : 'GMAIL_NEW_GMAIL_MESSAGE';
    // Outlook's event carries a preview under an id that is not the one the listing tools use, as the real one does.
    const data = outlook
      ? { event_type: 'created', id: `mutable-${msg.id}`, message: { id: `mutable-${msg.id}`, conversation_id: msg.threadId, subject: msg.subject, body_preview: msg.body.slice(0, 255), is_read: false } }
      : { id: msg.id, message_id: msg.id, thread_id: msg.threadId, label_ids: msg.labels, sender: msg.from, to: msg.to.join(', '), subject: msg.subject, message_text: msg.body, message_timestamp: msg.at.toISOString() };
    const signed = this.event(connectedAccountId, slug, data);
    return { message: msg, webhook: signed.webhook, hasTrigger: signed.hasTrigger };
  }

  /** The signed webhook Composio would send for one trigger event on an account. */
  event(connectedAccountId: string, slug: string, data: Record<string, unknown>) {
    const box = this.accounts.get(connectedAccountId);
    if (!box) throw new Error('no such fake account');
    const trigger = [...this.triggers.entries()].find(([, t]) => t.connectedAccountId === connectedAccountId && t.slug === slug);
    const body = JSON.stringify({ id: newId('evt'), type: 'composio.trigger.message', timestamp: new Date().toISOString(), metadata: { trigger_slug: slug, trigger_id: trigger?.[0] ?? '', connected_account_id: connectedAccountId, user_id: box.userId }, data });
    const id = newId('wh');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signWebhook(id, timestamp, body, this.secret) };
    return { webhook: { headers, body }, hasTrigger: !!trigger };
  }

  /** Puts a file in a stand-in Drive. */
  addFile(connectedAccountId: string, f: Partial<FakeFile> & { name: string }): FakeFile {
    const box = this.accounts.get(connectedAccountId);
    if (!box) throw new Error('no such fake account');
    const file: FakeFile = { id: f.id ?? newId('file'), name: f.name, mimeType: f.mimeType ?? 'application/vnd.google-apps.document', modifiedTime: f.modifiedTime ?? new Date().toISOString(), owner: f.owner ?? box.address, trashed: f.trashed, link: f.link, text: f.text, rows: f.rows };
    box.files = [...box.files.filter((x) => x.id !== file.id), file];
    return file;
  }

  private wire(m: FakeMessage) {
    return {
      messageId: m.id,
      threadId: m.threadId,
      messageTimestamp: m.at.toISOString(),
      labelIds: m.labels,
      sender: m.from,
      to: m.to.join(', '),
      cc: (m.cc ?? []).join(', '),
      subject: m.subject,
      messageText: m.body,
      preview: { body: m.body.slice(0, 160), subject: m.subject },
      attachmentList: [],
    };
  }

  /** A message as Microsoft Graph returns it. */
  private graph(m: FakeMessage) {
    const sender = /^(.*)<([^<>]+)>\s*$/.exec(m.from);
    const folder = m.labels.includes('DRAFT') ? 'drafts' : m.labels.includes('SENT') ? 'sentitems' : m.labels.includes('INBOX') ? 'inbox' : m.labels.includes('ARCHIVE') ? 'archive' : m.labels.includes('TRASH') ? 'deleteditems' : 'other';
    const escape = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return {
      id: m.id,
      conversationId: m.threadId,
      subject: m.subject,
      from: { emailAddress: { name: sender ? sender[1]!.trim().replace(/^"|"$/g, '') : '', address: sender ? sender[2]!.trim() : m.from } },
      toRecipients: m.to.map((address) => ({ emailAddress: { address } })),
      ccRecipients: (m.cc ?? []).map((address) => ({ emailAddress: { address } })),
      receivedDateTime: m.at.toISOString(),
      sentDateTime: m.at.toISOString(),
      isRead: !m.labels.includes('UNREAD'),
      isDraft: m.labels.includes('DRAFT'),
      parentFolderId: `fld-${folder}`,
      categories: m.categories ?? [],
      // Outlook hands bodies over as HTML, with a head and styles around the words.
      body: { contentType: 'html', content: m.html ?? `<html><head><style>p { margin: 0 }</style></head><body>${m.body.split(/\n\n+/).map((p) => `<p>${escape(p).replace(/\n/g, '<br>')}</p>`).join('')}</body></html>` },
      bodyPreview: m.body.slice(0, 255),
    };
  }

  async execute(slug: string, args: Record<string, unknown>, who: { userId: string; connectedAccountId: string }): Promise<ToolResult> {
    this.calls.push({ slug, args, connectedAccountId: who.connectedAccountId });
    const box = this.accounts.get(who.connectedAccountId);
    if (!box || box.status !== 'ACTIVE') return { successful: false, data: {}, error: 'No active connection for this account' };
    if (box.userId !== who.userId) return { successful: false, data: {}, error: 'Connected account does not belong to this user' };
    const fail = this.failNext.get(slug);
    if (fail === 'error') {
      this.failNext.delete(slug);
      return { successful: false, data: {}, error: 'The provider refused the request (fake)' };
    }
    if (fail === 'timeout') {
      this.failNext.delete(slug);
      throw new Error('ETIMEDOUT (fake)');
    }
    const ok = (data: Record<string, unknown>): ToolResult => ({ successful: true, data, error: null });
    switch (slug) {
      case 'GMAIL_GET_PROFILE':
        return ok({ response_data: { emailAddress: box.address, messagesTotal: box.messages.length, threadsTotal: new Set(box.messages.map((m) => m.threadId)).size, historyId: '1' } });
      case 'GMAIL_FETCH_EMAILS': {
        const max = Number(args.max_results ?? 25);
        const start = Number(args.page_token ?? 0);
        const q = String(args.query ?? '');
        const after = /after:(\d+)/.exec(q)?.[1];
        const inSent = /in:sent/.test(q);
        let list = [...box.messages].sort((a, b) => b.at.getTime() - a.at.getTime());
        if (after) list = list.filter((m) => m.at.getTime() / 1000 >= Number(after));
        if (inSent) list = list.filter((m) => m.labels.includes('SENT'));
        const subject = /subject:"([^"]+)"/.exec(q)?.[1];
        if (subject) list = list.filter((m) => m.subject === subject);
        const page = list.slice(start, start + max);
        return ok({ messages: page.map((m) => this.wire(m)), nextPageToken: start + max < list.length ? String(start + max) : null, resultSizeEstimate: list.length });
      }
      case 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID': {
        const list = box.messages.filter((m) => m.threadId === args.thread_id).sort((a, b) => a.at.getTime() - b.at.getTime());
        return ok({ messages: list.map((m) => this.wire(m)), id: args.thread_id });
      }
      case 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID': {
        const m = box.messages.find((x) => x.id === args.message_id);
        return m ? ok(this.wire(m)) : { successful: false, data: {}, error: 'Message not found' };
      }
      case 'GMAIL_SEND_EMAIL':
      case 'GMAIL_REPLY_TO_THREAD': {
        const reply = slug === 'GMAIL_REPLY_TO_THREAD';
        const first = reply ? box.messages.find((m) => m.threadId === args.thread_id) : undefined;
        const msg: FakeMessage = {
          id: newId('m'),
          threadId: reply ? String(args.thread_id) : newId('t'),
          from: box.address,
          to: [String(args.recipient_email ?? ''), ...((args.extra_recipients as string[] | undefined) ?? [])].filter(Boolean),
          cc: (args.cc as string[] | undefined) ?? [],
          subject: reply ? `Re: ${(first?.subject ?? '').replace(/^Re:\s*/i, '')}` : String(args.subject ?? ''),
          body: String(reply ? args.message_body ?? '' : args.body ?? ''),
          at: new Date(),
          labels: ['SENT'],
        };
        box.messages.push(msg);
        if (fail === 'sent-then-timeout') {
          this.failNext.delete(slug);
          throw new Error('ETIMEDOUT after send (fake)');
        }
        return ok({ response_data: { id: msg.id, threadId: msg.threadId, labelIds: msg.labels } });
      }
      case 'GMAIL_LIST_LABELS':
        return ok({ labels: [...['INBOX', 'SENT', 'UNREAD'].map((id) => ({ id, name: id, type: 'system' })), ...[...box.labels].map(([name, id]) => ({ id, name, type: 'user' }))] });
      case 'GMAIL_CREATE_LABEL': {
        const name = String(args.label_name ?? '');
        if (!name || /[,/]/.test(name) || box.labels.has(name)) return { successful: false, data: {}, error: 'Invalid or duplicate label name' };
        const id = `Label_${box.labels.size + 1}`;
        box.labels.set(name, id);
        return ok({ response_data: { id, name } });
      }
      case 'GMAIL_MODIFY_THREAD_LABELS': {
        const list = box.messages.filter((m) => m.threadId === args.thread_id);
        if (!list.length) return { successful: false, data: {}, error: 'Thread not found' };
        const add = (args.add_label_ids as string[] | undefined) ?? [];
        const remove = (args.remove_label_ids as string[] | undefined) ?? [];
        const real = new Set(['INBOX', 'SENT', 'UNREAD', ...box.labels.values()]);
        // Gmail refuses a label id it doesn't know, for adding and for removing.
        if ([...add, ...remove].some((id) => !real.has(id))) return { successful: false, data: {}, error: 'Invalid label id' };
        for (const m of list) m.labels = [...new Set([...m.labels.filter((l) => !remove.includes(l)), ...add])];
        if (fail === 'sent-then-timeout') {
          this.failNext.delete(slug);
          throw new Error('ETIMEDOUT after the change (fake)');
        }
        return ok({ success: true, response_dict: { id: args.thread_id } });
      }
      case 'GOOGLECALENDAR_CREATE_EVENT': {
        const start = new Date(`${String(args.start_datetime)}${args.timezone === 'UTC' ? 'Z' : ''}`);
        const minutes = Number(args.event_duration_hour ?? 0) * 60 + Number(args.event_duration_minutes ?? 0);
        if (Number.isNaN(start.getTime()) || minutes <= 0 || Number(args.event_duration_minutes ?? 0) > 59) return { successful: false, data: {}, error: 'Invalid start or duration' };
        // Who is told about the event is one of three words; anything else is refused, as the real tool refuses it.
        if (!['all', 'externalOnly', 'none'].includes(args.send_updates as string)) return { successful: false, data: {}, error: 'Invalid send_updates' };
        const event = { id: newId('gev'), summary: String(args.summary ?? ''), start: start.toISOString(), end: new Date(start.getTime() + minutes * 60_000).toISOString(), attendees: (args.attendees as string[] | undefined) ?? [], invited: args.send_updates === 'all' };
        box.events.push(event);
        if (fail === 'sent-then-timeout') {
          this.failNext.delete(slug);
          throw new Error('ETIMEDOUT after the event was created (fake)');
        }
        return ok({ response_data: { id: event.id, summary: event.summary, start: { dateTime: event.start }, end: { dateTime: event.end } } });
      }
      case 'GOOGLECALENDAR_EVENTS_LIST':
        return ok({ items: box.events.map((e) => ({ id: e.id, summary: e.summary, start: { dateTime: e.start }, end: { dateTime: e.end }, attendees: e.attendees.map((email) => ({ email })) })), nextPageToken: null });
      /* ───── Outlook ───── */
      case 'OUTLOOK_GET_PROFILE':
        return ok({ id: 'user-1', mail: box.address, userPrincipalName: box.address, displayName: 'Stand-in person' });
      case 'OUTLOOK_GET_MAIL_FOLDER': {
        const name = String(args.mail_folder_id ?? '').toLowerCase();
        if (!['inbox', 'sentitems', 'drafts', 'archive', 'deleteditems', 'junkemail'].includes(name)) return { successful: false, data: {}, error: 'The specified folder could not be found' };
        return ok({ id: `fld-${name}`, displayName: name });
      }
      case 'OUTLOOK_LIST_MESSAGES': {
        const filter = String(args.filter ?? '');
        // Outlook refuses to sort a filtered list unless the filter starts with the property it sorts by.
        if (filter && !/^receivedDateTime /.test(filter)) return { successful: false, data: {}, error: 'InefficientFilter: the restriction or sort order is too complex for this operation' };
        const conversation = /conversationId eq '((?:[^']|'')*)'/.exec(filter)?.[1]?.replace(/''/g, "'");
        const since = args.received_date_time_ge ? new Date(String(args.received_date_time_ge)).getTime() : 0;
        if (Number.isNaN(since)) return { successful: false, data: {}, error: 'Invalid date' };
        const folder = String(args.folder ?? 'inbox').toLowerCase();
        const max = Number(args.top ?? 10);
        const start = Number(args.page_token ?? 0);
        let list = [...box.messages].sort((a, b) => b.at.getTime() - a.at.getTime()).filter((m) => m.at.getTime() >= since);
        if (conversation !== undefined) list = list.filter((m) => m.threadId === conversation);
        if (folder !== 'allfolders') list = list.filter((m) => this.graph(m).parentFolderId === `fld-${folder}`);
        const page = list.slice(start, start + max);
        return ok({ value: page.map((m) => this.graph(m)), ...(start + max < list.length ? { next_page_token: String(start + max) } : {}) });
      }
      case 'OUTLOOK_CREATE_DRAFT': {
        const msg: FakeMessage = { id: newId('om'), threadId: newId('conv'), from: box.address, to: ((args.to_recipients as string[] | undefined) ?? []).map(String), cc: ((args.cc_recipients as string[] | undefined) ?? []).map(String), subject: String(args.subject ?? ''), body: String(args.body ?? ''), at: new Date(), labels: ['DRAFT'] };
        box.messages.push(msg);
        return ok(this.graph(msg));
      }
      case 'OUTLOOK_CREATE_DRAFT_REPLY': {
        const original = box.messages.find((m) => m.id === args.message_id);
        if (!original) return { successful: false, data: {}, error: 'The specified object was not found in the store' };
        // Outlook addresses the reply itself, to whoever wrote the message, and quotes that message under a rule.
        const author = /<([^<>]+)>\s*$/.exec(original.from)?.[1] ?? original.from;
        const msg: FakeMessage = { id: newId('om'), threadId: original.threadId, from: box.address, to: [author], cc: [], subject: `Re: ${original.subject.replace(/^Re:\s*/i, '')}`, body: '', html: `<html><head></head><body><hr><div><b>From:</b> ${author}</div><div>${original.body}</div></body></html>`, at: new Date(), labels: ['DRAFT'] };
        box.messages.push(msg);
        return ok(this.graph(msg));
      }
      case 'OUTLOOK_UPDATE_EMAIL': {
        const m = box.messages.find((x) => x.id === args.message_id);
        if (!m) return { successful: false, data: {}, error: 'The specified object was not found in the store' };
        const list = (v: unknown) => (v as { address?: string }[]).map((r) => String(r.address ?? ''));
        if (args.to_recipients) m.to = list(args.to_recipients);
        if (args.cc_recipients) m.cc = list(args.cc_recipients);
        if (args.categories) m.categories = (args.categories as string[]).map(String);
        if (args.body) {
          const b = args.body as { contentType?: string; content?: string };
          if (String(b.contentType).toLowerCase() === 'html') {
            m.html = String(b.content ?? '');
            // What a reader sees above the rule: the reply itself, without the quoted message.
            m.body = htmlToText(m.html.split(/<hr\b/i)[0]!);
          } else m.body = String(b.content ?? '');
        }
        return ok(this.graph(m));
      }
      case 'OUTLOOK_SEND_DRAFT': {
        const m = box.messages.find((x) => x.id === args.message_id);
        if (!m || !m.labels.includes('DRAFT')) return { successful: false, data: {}, error: 'The message is not a draft' };
        if (!m.to.length) return { successful: false, data: {}, error: 'At least one recipient is required' };
        m.labels = ['SENT'];
        m.at = new Date();
        if (fail === 'sent-then-timeout') {
          this.failNext.delete(slug);
          throw new Error('ETIMEDOUT after send (fake)');
        }
        return ok({});
      }
      case 'OUTLOOK_BATCH_UPDATE_MESSAGES':
      case 'OUTLOOK_BATCH_MOVE_MESSAGES': {
        const move = slug === 'OUTLOOK_BATCH_MOVE_MESSAGES';
        const items = move ? ((args.message_ids as string[] | undefined) ?? []).map((id) => ({ message_id: id, patch: {} as { categories?: string[] } })) : ((args.updates as { message_id: string; patch: { categories?: string[] } }[] | undefined) ?? []);
        if (!items.length || items.length > 20) return { successful: false, data: {}, error: 'A batch takes between 1 and 20 messages' };
        const to = String(args.destination_id ?? '').toLowerCase();
        if (move && !['inbox', 'archive'].includes(to)) return { successful: false, data: {}, error: 'The destination folder could not be found' };
        // 'partial' applies the first change of the batch and refuses the rest, as a throttled mailbox does.
        const partial = fail === 'partial';
        if (partial) this.failNext.delete(slug);
        let done = 0;
        const results = items.map((it, i) => {
          const m = box.messages.find((x) => x.id === it.message_id);
          if (!m || (partial && i > 0)) return { message_id: it.message_id, success: false };
          if (move) m.labels = [...m.labels.filter((l) => l !== 'INBOX' && l !== 'ARCHIVE'), to === 'inbox' ? 'INBOX' : 'ARCHIVE'];
          else if (it.patch.categories) m.categories = it.patch.categories.map(String);
          done++;
          return { message_id: it.message_id, success: true };
        });
        if (fail === 'sent-then-timeout') {
          this.failNext.delete(slug);
          throw new Error('ETIMEDOUT after the change (fake)');
        }
        return ok({ results, total_requested: items.length, total_succeeded: done, total_failed: items.length - done });
      }
      /* ───── Google Drive ───── */
      case 'GOOGLEDRIVE_GET_ABOUT':
        return ok({ user: { emailAddress: box.address, displayName: 'Stand-in person' } });
      case 'GOOGLEDRIVE_FIND_FILE': {
        const q = String(args.q ?? '');
        const since = /modifiedTime > '([^']+)'/.exec(q)?.[1];
        const max = Number(args.pageSize ?? 100);
        const start = Number(args.pageToken ?? 0);
        let list = [...box.files].sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
        if (since) list = list.filter((f) => new Date(f.modifiedTime).getTime() > new Date(since).getTime());
        if (/trashed = false/.test(q)) list = list.filter((f) => !f.trashed);
        if (/mimeType != 'application\/vnd\.google-apps\.folder'/.test(q)) list = list.filter((f) => f.mimeType !== 'application/vnd.google-apps.folder');
        const page = list.slice(start, start + max);
        const wire = (f: FakeFile) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, createdTime: f.modifiedTime, trashed: !!f.trashed, webViewLink: f.link ?? `https://docs.google.com/document/d/${f.id}/edit`, shared: f.owner !== box.address, owners: [{ displayName: f.owner.split('@')[0], emailAddress: f.owner }] });
        // Like Drive itself, the stand-in returns only what `fields` names: without nextPageToken there, a long list just ends.
        const wantsToken = !args.fields || /(^|,)\s*nextPageToken\s*(,|$)/.test(String(args.fields));
        return ok({ files: page.map(wire), ...(wantsToken && start + max < list.length ? { nextPageToken: String(start + max) } : {}) });
      }
      case 'GOOGLEDRIVE_GET_DOCUMENT': {
        const f = box.files.find((x) => x.id === args.document_id && !x.trashed);
        if (!f || f.mimeType !== 'application/vnd.google-apps.document') return { successful: false, data: {}, error: 'Requested entity was not found' };
        // Google's own structure: paragraphs made of text runs, each ending in a line break.
        return ok({ documentId: f.id, title: f.name, body: { content: (f.text ?? '').split('\n').map((line) => ({ paragraph: { elements: [{ textRun: { content: `${line}\n` } }] } })) } });
      }
      case 'GOOGLEDRIVE_GET_SPREADSHEET_VALUES': {
        const f = box.files.find((x) => x.id === args.spreadsheet_id && !x.trashed);
        if (!f || f.mimeType !== 'application/vnd.google-apps.spreadsheet' || typeof args.range !== 'string') return { successful: false, data: {}, error: 'Requested entity was not found' };
        return ok({ range: `Sheet1!${args.range}`, majorDimension: 'ROWS', values: (f.rows ?? []).slice(0, 200) });
      }
      case 'GOOGLEDRIVE_GET_PRESENTATION': {
        const f = box.files.find((x) => x.id === args.presentation_id && !x.trashed);
        if (!f || f.mimeType !== 'application/vnd.google-apps.presentation') return { successful: false, data: {}, error: 'Requested entity was not found' };
        return ok({ title: f.name, slides: (f.text ?? '').split('\n\n').map((slide) => ({ pageElements: [{ shape: { text: { textElements: [{ textRun: { content: slide } }] } } }] })) });
      }
      default:
        return { successful: false, data: {}, error: `The fake provider has no tool called ${slug}` };
    }
  }

  /** Messages this account has sent, for assertions. */
  sent(connectedAccountId: string): FakeMessage[] {
    return (this.accounts.get(connectedAccountId)?.messages ?? []).filter((m) => m.labels.includes('SENT'));
  }
}

let provider: ComposioProvider | null = null;

export function composio(): ComposioProvider {
  if (!provider) {
    if (config.fakeProviders) provider = new FakeComposio();
    else if (config.composio.apiKey) provider = new RealComposio();
    else throw new Error('Composio is not configured: set COMPOSIO_API_KEY');
  }
  return provider;
}

export const composioReady = () => config.fakeProviders || !!config.composio.apiKey;

/** The fake, when the fake is in use. Tests drive mailboxes through it. */
export function fakeComposio(): FakeComposio | null {
  const p = composioReady() ? composio() : null;
  return p instanceof FakeComposio ? p : null;
}

export function setComposioForTests(p: ComposioProvider | null) {
  provider = p;
}
