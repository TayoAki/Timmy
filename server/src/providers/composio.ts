import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Composio } from '@composio/core';
import { config } from '../config';
import { newId } from '../lib/ids';

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

class RealComposio implements ComposioProvider {
  private client = new Composio({ apiKey: config.composio.apiKey });
  private authConfigs = new Map<string, string>();

  /** The auth config for a toolkit: the id from config when set, else Composio's managed OAuth app. */
  private async authConfigFor(toolkit: string): Promise<string> {
    const configured = config.composio.authConfigs[toolkit];
    if (configured) return configured;
    const cached = this.authConfigs.get(toolkit);
    if (cached) return cached;
    const existing = await this.client.authConfigs.list({ toolkit, isComposioManaged: true });
    let id = existing.items?.[0]?.id;
    if (!id) {
      const created = await this.client.authConfigs.create(toolkit, { type: 'use_composio_managed_auth', name: `timmy-${toolkit}` });
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
    const res = await this.client.tools.execute(slug, { userId: who.userId, connectedAccountId: who.connectedAccountId, arguments: args, dangerouslySkipVersionCheck: true });
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
  labels: string[];
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
  failNext = new Map<string, 'error' | 'timeout' | 'sent-then-timeout'>();
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
    this.accounts.set(connectedAccountId, { address: this.nextAddress || `${userId.slice(0, 8)}@example.test`, status: 'INITIATED', toolkit, userId, messages: [], events: [], labels: new Map() });
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
    const trigger = [...this.triggers.entries()].find(([, t]) => t.connectedAccountId === connectedAccountId && t.slug === 'GMAIL_NEW_GMAIL_MESSAGE');
    const body = JSON.stringify({
      id: newId('evt'),
      type: 'composio.trigger.message',
      timestamp: new Date().toISOString(),
      metadata: { trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE', trigger_id: trigger?.[0] ?? '', connected_account_id: connectedAccountId, user_id: box.userId },
      data: { id: msg.id, message_id: msg.id, thread_id: msg.threadId, label_ids: msg.labels, sender: msg.from, to: msg.to.join(', '), subject: msg.subject, message_text: msg.body, message_timestamp: msg.at.toISOString() },
    });
    const id = newId('wh');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signWebhook(id, timestamp, body, this.secret) };
    return { message: msg, webhook: { headers, body }, hasTrigger: !!trigger };
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
        const event = { id: newId('gev'), summary: String(args.summary ?? ''), start: start.toISOString(), end: new Date(start.getTime() + minutes * 60_000).toISOString(), attendees: (args.attendees as string[] | undefined) ?? [], invited: args.send_updates === true };
        box.events.push(event);
        if (fail === 'sent-then-timeout') {
          this.failNext.delete(slug);
          throw new Error('ETIMEDOUT after the event was created (fake)');
        }
        return ok({ response_data: { id: event.id, summary: event.summary, start: { dateTime: event.start }, end: { dateTime: event.end } } });
      }
      case 'GOOGLECALENDAR_EVENTS_LIST':
        return ok({ items: box.events.map((e) => ({ id: e.id, summary: e.summary, start: { dateTime: e.start }, end: { dateTime: e.end }, attendees: e.attendees.map((email) => ({ email })) })), nextPageToken: null });
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
