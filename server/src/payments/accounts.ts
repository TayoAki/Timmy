/**
 * The Stripe account a business is paid into (Stripe Connect, Accounts v2).
 *
 *   Connect Stripe (owner or admin) → Timmy makes the business's own Stripe account, once, prefilled with the business
 *   name and billing email → Stripe's own onboarding page, where the business fills in who it is and its bank →
 *   back to Timmy, which asks Stripe whether card payments are on.
 *
 * Only an owner or admin connects or disconnects it: money from invoices goes into this account, so nobody else can
 * point it somewhere else. The account id is kept on the server (payment_account), never in the workspace's state.
 */
import { config } from '../config';
import { withWorkspace } from '../db/pool';
import { audit } from '../gateway/gateway';
import { log } from '../lib/log';
import { loadState } from '../state/docs';
import type { Ctx } from '../state/engine';
import { defaultBilling } from '../../../src/state/invoices';
import { StripeError, stripe } from './stripe';

export interface AccountRow {
  workspace_id: string;
  account_id: string;
  ready: boolean;
  submitted: boolean;
  country: string | null;
  connected_by: string;
  created_at: Date;
  updated_at: Date;
  disconnected_at: Date | null;
}

/** What the screens are told: whether card payments are possible on this server, and where this business stands. */
export interface PaymentsStatus {
  /** Stripe is set up on this server. */
  on: boolean;
  /** none: never connected or disconnected; started: Stripe still wants details; checking: Stripe is reviewing them; ready: card payments on. */
  stripe: 'none' | 'started' | 'checking' | 'ready';
  country?: string;
  /** Whether this person may connect or disconnect it. */
  canConnect: boolean;
}

/** Countries a business can be in, offered when connecting (Stripe's own form confirms it). */
export const COUNTRIES: Record<string, string> = { US: 'United States', CA: 'Canada', GB: 'United Kingdom', IE: 'Ireland', AU: 'Australia', NZ: 'New Zealand', DE: 'Germany', FR: 'France', ES: 'Spain', IT: 'Italy', NL: 'Netherlands' };

export async function accountRow(workspaceId: string): Promise<AccountRow | null> {
  return withWorkspace({ workspaceId }, async (tx) => ((await tx.query('select * from payment_account where workspace_id = $1', [workspaceId])).rows[0] as AccountRow | undefined) ?? null);
}

/** The account links can be made on: connected, not disconnected, card payments on. */
export async function readyAccount(workspaceId: string): Promise<AccountRow | null> {
  const row = await accountRow(workspaceId);
  return row && !row.disconnected_at && row.ready ? row : null;
}

const stateOf = (row: AccountRow | null): PaymentsStatus['stripe'] => (!row || row.disconnected_at ? 'none' : row.ready ? 'ready' : row.submitted ? 'checking' : 'started');

export async function paymentsStatus(ctx: Ctx): Promise<PaymentsStatus> {
  const row = await accountRow(ctx.workspaceId);
  return { on: !!stripe(), stripe: stateOf(row), ...(row?.country ? { country: row.country } : {}), canConnect: ctx.rules.policy };
}

const returnUrl = () => `${config.publicUrl}/api/v1/payments/stripe/return`;
const refreshUrl = () => `${config.publicUrl}/api/v1/payments/stripe/refresh`;

/**
 * Starts (or carries on) connecting: makes the business's Stripe account if there isn't one, and returns the address
 * of Stripe's onboarding page for this person to open. The page's address is used once and only by them.
 */
export async function connectStripe(ctx: Ctx, country: string): Promise<{ ok: true; url: string } | { ok: false; status: number; error: string }> {
  const s = stripe();
  if (!s) return { ok: false, status: 503, error: 'Card payments aren’t set up on this server yet.' };
  if (!ctx.rules.policy) return { ok: false, status: 403, error: 'Only an owner or admin can connect where payments go.' };
  const code = country.toUpperCase();
  let row = await accountRow(ctx.workspaceId);
  if (!row && !COUNTRIES[code]) return { ok: false, status: 400, error: 'Pick the country your business is registered in.' };
  try {
    if (!row) {
      const { name, email } = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => {
        const loaded = await loadState(tx, ctx.workspaceId);
        const b = loaded.state.ws.billing?.settings ?? defaultBilling(loaded.workspace.name, loaded.workspace.owner_email ?? undefined);
        return { name: (b.business || loaded.workspace.name || 'My business').trim(), email: b.email?.trim() || undefined };
      });
      // One account per workspace: the key is the workspace, so pressing twice (or a retry) makes one.
      const made = await s.createAccount({ name, email, country: code }, `timmy-account-${ctx.workspaceId}`);
      row = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => {
        const r = await tx.query(
          `insert into payment_account (workspace_id, account_id, country, connected_by) values ($1, $2, $3, $4)
           on conflict (workspace_id) do update set updated_at = now() returning *`,
          [ctx.workspaceId, made.id, code, ctx.user.id],
        );
        await audit(tx, ctx.workspaceId, { actor: ctx.user.id, action: 'payments.account_created', detail: { provider: 'stripe', country: code } });
        return r.rows[0] as AccountRow;
      });
    } else if (row.disconnected_at) {
      // Connecting again picks the same Stripe account back up: it is the business's, with its history.
      await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => {
        await tx.query('update payment_account set disconnected_at = null, connected_by = $2, updated_at = now() where workspace_id = $1', [ctx.workspaceId, ctx.user.id]);
        await audit(tx, ctx.workspaceId, { actor: ctx.user.id, action: 'payments.reconnected', detail: { provider: 'stripe' } });
      });
    }
    const link = await s.onboardingLink(row.account_id, returnUrl(), refreshUrl());
    return { ok: true, url: link.url };
  } catch (e) {
    if (e instanceof StripeError) return { ok: false, status: e.status, error: e.message };
    throw e;
  }
}

/** Asks Stripe where the account stands and keeps the answer. Used on the way back from Stripe and on its events. */
export async function refreshAccount(workspaceId: string): Promise<AccountRow | null> {
  const s = stripe();
  const row = await accountRow(workspaceId);
  if (!s || !row) return row;
  try {
    const a = await s.account(row.account_id);
    return await withWorkspace({ workspaceId }, async (tx) => {
      const r = await tx.query('update payment_account set ready = $2, submitted = $3, country = coalesce($4, country), updated_at = now() where workspace_id = $1 returning *', [workspaceId, a.ready, a.submitted, a.country ?? null]);
      if (a.ready && !row.ready) await audit(tx, workspaceId, { actor: 'system', action: 'payments.ready', detail: { provider: 'stripe' } });
      return r.rows[0] as AccountRow;
    });
  } catch (e) {
    log.warn('could not read the stripe account', { error: (e as Error).message });
    return row;
  }
}

/** Stripe's onboarding page has expired or was opened twice: a fresh one, for the same person. */
export async function freshOnboardingLink(ctx: Ctx): Promise<string | null> {
  const s = stripe();
  const row = await accountRow(ctx.workspaceId);
  if (!s || !row || row.disconnected_at || !ctx.rules.policy) return null;
  try {
    return (await s.onboardingLink(row.account_id, returnUrl(), refreshUrl())).url;
  } catch {
    return null;
  }
}

/**
 * Stops making payment links on this account. The account stays the business's on Stripe (they close it there if
 * they want), and links already in clients' hands are still matched to their invoices when they are paid.
 */
export async function disconnectStripe(ctx: Ctx): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!ctx.rules.policy) return { ok: false, status: 403, error: 'Only an owner or admin can change where payments go.' };
  await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => {
    const r = await tx.query('update payment_account set disconnected_at = now(), updated_at = now() where workspace_id = $1 and disconnected_at is null returning workspace_id', [ctx.workspaceId]);
    if (r.rows[0]) await audit(tx, ctx.workspaceId, { actor: ctx.user.id, action: 'payments.disconnected', detail: { provider: 'stripe' } });
  });
  return { ok: true };
}
