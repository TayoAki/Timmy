import type { RoleRules } from '../auth/roles';

/**
 * Every kind of outside write Timmy can make. A kind that isn't listed here
 * has no executor and is refused, so "the model invented a new action" fails closed.
 */
export const KINDS = {
  /** A new email from the user's mailbox. */
  'email.send': { domain: 'mail', outbound: true, hold: true, autoEligible: false, label: 'Send an email' },
  /** A reply in an existing thread. */
  'email.reply': { domain: 'mail', outbound: true, hold: true, autoEligible: false, label: 'Send a reply' },
  /** Labels and archive on the user's own mailbox. Nobody else sees it. */
  'mail.modify': { domain: 'mail', outbound: false, hold: false, autoEligible: true, label: 'Label or archive mail' },
  /** A calendar event; with guests it sends invitations. */
  'calendar.create': { domain: 'calendar', outbound: true, hold: true, autoEligible: false, label: 'Create a calendar event' },
  /** A change to a deal, contact or activity in the connected CRM. */
  'crm.write': { domain: 'crm', outbound: false, hold: false, autoEligible: false, label: 'Update the CRM' },
  /**
   * An automation's “Ask me first” step. It writes nothing anywhere: it is a question that waits in Approvals,
   * so that the yes or no goes through the same approve / decline path, the same check of who may decide,
   * and the same audit log as every other approval. The automation's run carries on, or stops, on the answer.
   */
  'automation.ask': { domain: 'decision', outbound: false, hold: false, autoEligible: false, label: 'An automation asks first' },
} as const;

export type EffectKind = keyof typeof KINDS;
export const isKind = (k: string): k is EffectKind => k in KINDS;

export type Route = 'user' | 'exec' | 'revops';

/* ───────────── The never-list ───────────── */

const NEVER_KIND = /^(money|payment|payout|transfer|sign|signature|account\.delete|security|credential|billing)\b/i;
/** Words in a tool's name that mark it as off limits, whoever asks. */
const NEVER_VERB =
  /\b(pay|payout|wire|transfer funds|send money|refund|charge card|purchase|buy|checkout|place order|sign|esign|docusign|delete account|close account|deactivate account|delete user|delete workspace|change password|reset password|disable 2fa|disable mfa|rotate key|create api key|grant admin|change owner)\b/;

/** "STRIPE_CREATE_PAYOUT" → "stripe create payout", so word boundaries work on tool names. */
const words = (tool: string) => tool.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const NEVER = 'Timmy never moves money, signs documents, deletes accounts or changes security settings.';

/**
 * Actions nobody can approve through Timmy: moving money, signing, deleting
 * accounts and changing security settings. Returns why, or null when allowed.
 */
export function neverAllowed(kind: string, payload: unknown): string | null {
  if (NEVER_KIND.test(kind)) return NEVER;
  if (!isKind(kind)) return `“${kind}” is not something Timmy can do.`;
  const tool = (payload as { tool?: unknown } | null)?.tool;
  if (typeof tool === 'string' && NEVER_VERB.test(words(tool))) return NEVER;
  return null;
}

/* ───────────── The outbound-verb guard ───────────── */

const OUTBOUND_VERB = /\b(send|reply|forward|post|publish|tweet|comment|invite|share|text|sms|call|dial|message|dm|email|notify|announce|submit|book)\b/;

/**
 * Whether an action reaches another person. Auto mode may never approve these:
 * they need a person, or a rule a person wrote.
 */
export function reachesSomeoneElse(kind: string, payload: unknown): boolean {
  if (!isKind(kind) || KINDS[kind].outbound) return true;
  const tool = (payload as { tool?: unknown } | null)?.tool;
  return typeof tool === 'string' && OUTBOUND_VERB.test(words(tool));
}

/* ───────────── Who approves ───────────── */

export interface Actor {
  userId: string;
  name: string;
  role: string;
  rules: RoleRules;
}

export interface CrmPolicy {
  approver: 'me' | 'revops';
}

/** Where an action goes for its OK when `actor` asks for it. `self` means the actor's own click is enough. */
export function approverFor(kind: EffectKind, actor: Actor, crm: CrmPolicy): { route: Route; self: boolean } {
  const k = KINDS[kind];
  if (k.domain === 'crm') {
    if (actor.rules.approveCrm) return { route: 'user', self: true };
    return crm.approver === 'revops' ? { route: 'revops', self: false } : { route: 'user', self: false };
  }
  // Filing mail (labels, archive) reaches nobody else. Anyone who may work the inbox may file it on their own say.
  if (k.domain === 'mail' && !k.outbound) return { route: 'user', self: actor.rules.work };
  if (actor.rules.approveSends) return { route: 'user', self: true };
  // A delegate works on the exec's behalf; the exec decides.
  if (actor.role.split(',').map((r) => r.trim()).includes('assistant')) return { route: 'exec', self: false };
  return { route: 'user', self: false };
}

/** Whether `actor` may decide an effect that was routed to `route`. */
export function mayDecide(route: Route, kind: EffectKind, actor: Actor, effect: { requested_by: string; on_behalf_of: string | null }): boolean {
  const k = KINDS[kind];
  const admin = actor.rules.policy;
  if (route === 'revops') return actor.rules.approveCrm;
  if (route === 'exec') return admin || (!!effect.on_behalf_of && effect.on_behalf_of === actor.userId);
  if (k.domain === 'crm') return actor.rules.approveCrm;
  // An automation's question is answered by an owner or admin, or by the person who switched the automation on.
  if (k.domain === 'decision') return admin || (actor.rules.approveSends && !!effect.on_behalf_of && effect.on_behalf_of === actor.userId);
  // Filing that Timmy proposed can be decided by anyone who may work the inbox.
  if (k.domain === 'mail' && !k.outbound) return actor.rules.work;
  if (!actor.rules.approveSends) return false;
  // Members approve what they asked for; owners and admins may approve anything in the workspace.
  return admin || effect.requested_by === actor.userId || effect.requested_by === 'agent' || effect.on_behalf_of === actor.userId;
}

/* ───────────── Rules a person set ───────────── */

export interface PolicyRow {
  id: string;
  kind: string;
  scope: Record<string, unknown>;
  enabled: boolean;
}

/**
 * A rule covers an action when the kinds match and every condition in the
 * rule's scope equals the same field of the action's `meta`. A rule with an
 * empty scope covers nothing: rules must say what they are for.
 */
export function ruleCovers(rule: PolicyRow, kind: string, meta: Record<string, unknown> | undefined): boolean {
  if (!rule.enabled || rule.kind !== kind) return false;
  const keys = Object.keys(rule.scope ?? {});
  if (!keys.length) return false;
  return keys.every((k) => meta !== undefined && JSON.stringify(meta[k]) === JSON.stringify(rule.scope[k]));
}
