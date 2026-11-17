/**
 * Composio's webhook signatures, shared by the real provider and the stand-in (testing/composio.ts): the stand-in
 * signs the events it sends exactly as Composio does, and both check them the same way.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ProviderEvent } from './composio';

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

export function eventFrom(id: string, rawBody: string): ProviderEvent {
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
