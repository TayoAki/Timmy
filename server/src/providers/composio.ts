import { createHash } from 'node:crypto';
import { Composio } from '@composio/core';
import { config } from '../config';
import { FakeComposio } from '../testing/composio';
import { fetchFileBytes } from './composio-download';
import { eventFrom, verifyWebhookSignature } from './composio-webhook';

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

/**
 * The SDK reports a failed call as "Error executing the tool X" and keeps why (Composio's HTTP status and message, or
 * a timeout) in `cause`. The reason is added to the message, so a log line says what went wrong. It carries no
 * credential: the SDK's error holds the response's status and body, not the request's headers.
 */
export function withCause(e: unknown): unknown {
  if (!(e instanceof Error) || !(e.cause instanceof Error)) return e;
  const cause = e.cause as Error & { status?: number };
  const status = cause.status && !cause.message.startsWith(String(cause.status)) ? `${cause.status} ` : '';
  const why = `${status}${cause.message}`.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!why || e.message.includes(why)) return e;
  return new Error(`${e.message}: ${why}`, { cause: e });
}

/**
 * A file handed to Composio for one tool call. A tool's file argument (an email's `attachment`) takes this
 * reference, never the bytes: the file is first put in Composio's own store, under a key made for that tool.
 */
export interface StagedFile {
  name: string;
  mimetype: string;
  s3key: string;
}

export interface ComposioProvider {
  /**
   * Puts a file in Composio's store for one tool's file argument, as its client's `files.upload` does, and
   * returns the reference to pass to that tool. Throws when the file could not be handed over.
   */
  stageFile(input: { toolSlug: string; toolkit: string; name: string; type: string; bytes: Uint8Array }): Promise<StagedFile>;
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
  /**
   * The bytes of a file a tool handed back as an address (OneDrive's download). Throws DownloadRefused when the
   * address is not one Timmy fetches from or the file is larger than `maxBytes`.
   */
  download(url: string, maxBytes: number): Promise<Uint8Array>;
}

/* ───────────── Webhook signatures (shared by the real and the stand-in provider) ───────────── */

// They live in composio-webhook.ts, which the stand-in uses too; callers keep finding them here.
export { signWebhook, verifyWebhookSignature } from './composio-webhook';

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
  // Files are never fetched or written to disk by the client on its own: a tool's file comes back as an address,
  // which `download` checks before fetching (OneDrive's reader depends on this; it is the client's default too).
  private client = new Composio({ apiKey: config.composio.apiKey, toolkitVersions: config.composio.toolkitVersions, dangerouslyAllowAutoUploadDownloadFiles: false });
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
    try {
      const res = await this.client.tools.execute(slug, { userId: who.userId, connectedAccountId: who.connectedAccountId, arguments: args });
      return { successful: !!res.successful, data: (res.data ?? {}) as Record<string, unknown>, error: res.error ?? null };
    } catch (e) {
      throw withCause(e);
    }
  }

  async stageFile(input: { toolSlug: string; toolkit: string; name: string; type: string; bytes: Uint8Array }): Promise<StagedFile> {
    // The client is given the bytes as a File, never a path or an address, so it reads nothing from this
    // server's disk and fetches nothing. It asks Composio for a one-time upload address and puts the bytes there.
    const file = new File([input.bytes as BlobPart], input.name, { type: input.type });
    const out = await this.client.files.upload({ file, toolSlug: input.toolSlug, toolkitSlug: input.toolkit });
    if (!out?.s3key) throw new Error('Composio returned no reference for the file');
    return { name: out.name, mimetype: out.mimetype, s3key: out.s3key };
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

  async download(url: string, maxBytes: number): Promise<Uint8Array> {
    return fetchFileBytes(url, maxBytes, config.composio.fileHosts);
  }
}

/* ───────────── Which one this server uses ───────────── */

let provider: ComposioProvider | null = null;

/** The real provider, or the stand-in (testing/composio.ts) when the stand-in providers are switched on. */
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
