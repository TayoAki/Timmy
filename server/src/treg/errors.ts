import { log } from '../lib/log';

/** Treg said no, or couldn't be reached. `status` is what to answer the person with; `message` is for them. */
export class TregError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfter?: number,
    /** Treg's own error word, when it gave one. */
    public code?: string,
  ) {
    super(message);
  }
}

/** Refusals about the team's own account: logged for the people who run Timmy, never shown to a workspace. */
const TEAM_LEVEL = new Set(['insufficient_balance', 'platform_daily_cap_reached', 'funds_required', 'own_key_required', 'trial_allowance_reached', 'member_spend_cap_reached', 'payment_required']);
const PAUSED = 'Finding leads is paused for this server just now. The people who run Timmy have been told.';

/** Turns a refusal into words for the person. `treg` is whether Treg itself refused (X-Treg-Error: 1). */
export function tregRefusal(status: number, body: Record<string, unknown> | null, treg: boolean, retryAfterHeader: string | null): TregError {
  const code = typeof body?.error === 'string' ? body.error : undefined;
  const wait = Math.max(1, Math.round(Number(retryAfterHeader ?? body?.retry_after_s ?? 60)) || 60);
  if (status === 401 || (status === 403 && !treg)) {
    log.warn('treg refused the token', { status });
    return new TregError(502, 'Timmy’s connection to its lead data isn’t set up right. The people who run Timmy have been told.', undefined, code);
  }
  if (code && TEAM_LEVEL.has(code)) {
    log.warn('treg refused on the team account', { code });
    return new TregError(503, PAUSED, undefined, code);
  }
  if (code === 'tag_spend_cap_reached') return new TregError(429, 'This workspace has used today’s allowance for finding leads. It starts again tomorrow.', undefined, code);
  if (code === 'tag_blocked') return new TregError(403, 'Finding leads is switched off for this workspace.', undefined, code);
  if (code === 'route_max_cost') return new TregError(402, 'That lookup would cost more than Timmy allows for one search. Try asking for fewer.', undefined, code);
  // The same request is still being answered under its idempotency key: asking again later gets the stored answer.
  if (status === 409 || status === 429 || status === 503) return new TregError(429, `The lead data is busy. Try again in ${wait} second${wait === 1 ? '' : 's'}.`, wait, code);
  if (status === 422) return new TregError(400, 'Timmy couldn’t ask for that the way it was put. Try different words.', undefined, code);
  if (code === 'route_failed' || status >= 500) return new TregError(502, 'No data provider could answer just now. Try again in a moment.', undefined, code);
  return new TregError(502, 'The lead data had a problem with that. Try again in a moment.', undefined, code);
}
