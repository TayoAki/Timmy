/** Stripe's refusals, in words for the person. Kept apart from the client so the stand-in can use them too. */
import { log } from '../lib/log';

/** Stripe said no, or couldn't be reached. `status` is what to answer the person with; `message` is for them. */
export class StripeError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Stripe's own error code, when it gave one. */
    public code?: string,
  ) {
    super(message);
  }
}

/** Refusals about Timmy's own platform account: logged for the people who run Timmy, never shown to a workspace. */
const PLATFORM_LEVEL = new Set(['platform_registration_required', 'connect_identity_not_verified', 'accounts_v2_access_blocked', 'account_creation_losses_collector_unavailable', 'platform_account_required', 'platform_api_key_expired', 'api_key_expired']);
const PAUSED = 'Card payments are paused on this server just now. The people who run Timmy have been told.';

export function stripeRefusal(status: number, body: Record<string, unknown> | null): StripeError {
  const err = (body?.error ?? null) as { code?: unknown; type?: unknown; message?: unknown } | null;
  const code = typeof err?.code === 'string' ? err.code : undefined;
  // What Stripe said is logged, never shown: it can name parameters, accounts and keys.
  const said = { status, code, type: typeof err?.type === 'string' ? err.type : undefined, message: typeof err?.message === 'string' ? err.message.slice(0, 300) : undefined };
  if (status === 401 || status === 403 || (code && PLATFORM_LEVEL.has(code))) {
    log.warn('stripe refused the platform', said);
    return new StripeError(503, PAUSED, code);
  }
  if (status === 429 || code === 'rate_limit' || code === 'lock_timeout') return new StripeError(503, 'Stripe is busy just now. Try again in a minute.', code);
  if (status === 404 || code === 'resource_missing' || code === 'account_invalid') {
    log.warn('stripe: not found', said);
    return new StripeError(409, 'That Stripe account is no longer connected to Timmy. Connect Stripe again in Business details.', code);
  }
  if (code === 'amount_too_small') return new StripeError(400, 'Stripe can’t take a card payment that small.', code);
  if (code === 'amount_too_large') return new StripeError(400, 'That is more than Stripe takes in one card payment for this account. Ask Stripe to raise the limit, or add your bank details for this one.', code);
  if (code && /country/.test(code)) return new StripeError(400, 'Stripe can’t open an account for a business in that country through Timmy.', code);
  if (code && /currency/.test(code)) return new StripeError(400, 'Stripe can’t take card payments in that currency for this account.', code);
  log.warn('stripe refused', said);
  if (status >= 500) return new StripeError(502, 'Stripe didn’t answer properly just now. Try again in a moment.', code);
  return new StripeError(400, 'Stripe refused that. The people who run Timmy can see why in the server’s log.', code);
}

