/**
 * Switching the website chat on, and what may change while it is on.
 *
 * Once the chat is on, Timmy answers strangers on its own from the settings: the greeting, the questions and
 * the help desk answers. Nobody approves each reply. What stands in for that approval is a rule a person set:
 * "the website chat is switched on". So only an owner or admin may switch it on, and while it is on only they
 * may change what it says. This file enforces that, keeps the row the public routes read in step with the
 * settings, and keeps the rule the Action gateway checks before any reply goes out.
 *
 * It looks at what a command did to the settings, not at which command it was, so nothing changes them
 * around it (an undo included).
 */
import type { ChatConvo, ChatWidget } from '../../../src/data/ws-types';
import { toWire } from '../../../src/live/patches';
import type { State } from '../../../src/state/store';
import type { Tx } from '../db/pool';
import { audit } from '../gateway/gateway';
import { newId } from '../lib/ids';
import type { Loaded } from '../state/docs';
import type { Ctx } from '../state/engine';
import { newSiteKey } from './token';

/** What a reply from Timmy must match to be covered by the rule. */
export const TIMMY_REPLY = { chat: 'site', sender: 'timmy' } as const;
export const DEFAULT_RETENTION_MONTHS = 12;

const same = (a: unknown, b: unknown) => a === b || toWire(a) === toWire(b);

/**
 * Checks a change to the chat's settings and records it. Returns the state to save (with the site key filled
 * in), or why the change is refused. Call inside the command's transaction, after the reducer has run.
 */
export type ChatChecked = { state: State; toast?: string; reject?: undefined } | { reject: string };

export async function chatSettingsChanged(tx: Tx, loaded: Loaded, ctx: Ctx, next: State): Promise<ChatChecked> {
  const before = loaded.state.ws.chat.site as ChatWidget | undefined;
  const after = next.ws.chat.site as ChatWidget | undefined;
  if (before === after || same(before, after)) return { state: next };
  if (!after || Object.keys(next.ws.chat).length !== 1) return { reject: 'A workspace has one website chat, and its settings can’t be removed.' };
  const workspaceId = loaded.workspace.id;
  const row = (await tx.query('select site_key, is_on from chat_widget where workspace_id = $1 for update', [workspaceId])).rows[0] as { site_key: string; is_on: boolean } | undefined;

  // The key in the snippet is the server's to make. A screen can't set one or swap it for another workspace's.
  // (A change that leaves it out, as an undo of the first save does, gets it filled in again below.)
  if (after.siteKey !== undefined && after.siteKey !== row?.site_key) return { reject: 'The key in the code snippet is made by Timmy and can’t be changed.' };

  const wasOn = !!before?.on || !!row?.is_on;
  if ((wasOn || after.on) && !ctx.rules.policy) return { reject: 'Only an owner or admin can switch the website chat on or off, or change it while it is on.' };
  if ((!same(before?.privacyUrl, after.privacyUrl) || !same(before?.retentionMonths, after.retentionMonths)) && !ctx.rules.policy) return { reject: 'Only an owner or admin can change the chat’s privacy settings.' };
  if (after.on && !after.domain) return { reject: 'Set your website first. The chat only shows on the website you name.' };

  // Until a website is named there is nothing for a key to be tied to.
  if (!row && !after.domain) return { state: next };
  const siteKey = row?.site_key ?? newSiteKey();
  const retention = after.retentionMonths ?? DEFAULT_RETENTION_MONTHS;
  await tx.query(
    `insert into chat_widget (workspace_id, site_key, domain, is_on, retention_months, switched_on_by) values ($1, $2, $3, $4, $5, $6)
     on conflict (workspace_id) do update set domain = excluded.domain, is_on = excluded.is_on, retention_months = excluded.retention_months,
       switched_on_by = case when excluded.is_on and not chat_widget.is_on then excluded.switched_on_by else chat_widget.switched_on_by end, updated_at = now()`,
    [workspaceId, siteKey, after.domain.toLowerCase(), after.on, retention, after.on ? ctx.user.id : null],
  );

  const isOn = !!row?.is_on;
  let toast: string | undefined;
  if (after.on && !isOn) {
    // The rule that covers Timmy's replies from now on. It names the person who switched the chat on.
    await tx.query(`update policy set enabled = false, updated_at = now() where workspace_id = $1 and kind = 'chat.reply' and enabled`, [workspaceId]);
    const policyId = newId('pol');
    await tx.query('insert into policy (id, workspace_id, kind, scope, enabled, label, created_by) values ($1, $2, $3, $4::jsonb, true, $5, $6)', [
      policyId,
      workspaceId,
      'chat.reply',
      JSON.stringify(TIMMY_REPLY),
      'The website chat is switched on: Timmy answers visitors from the help desk answers and questions set up for it.',
      ctx.user.id,
    ]);
    await audit(tx, workspaceId, { actor: ctx.user.id, action: 'chat.switched_on', detail: { domain: after.domain, rule: policyId } });
    toast = `The chat is on for ${after.domain}. It shows there once the code snippet is on the website.`;
  } else if (!after.on && isOn) {
    await tx.query(`update policy set enabled = false, updated_at = now() where workspace_id = $1 and kind = 'chat.reply' and enabled`, [workspaceId]);
    await audit(tx, workspaceId, { actor: ctx.user.id, action: 'chat.switched_off', detail: {} });
    toast = 'The chat is off. Visitors no longer see it.';
  } else if (after.on) {
    // What visitors are told changed while the chat was live. The log says which settings, not their contents.
    const changed = (Object.keys({ ...before, ...after }) as (keyof ChatWidget)[]).filter((k) => !same(before?.[k], after[k]));
    await audit(tx, workspaceId, { actor: ctx.user.id, action: 'chat.settings_changed', detail: { changed } });
  }

  if (after.siteKey === siteKey) return { state: next, toast };
  return { state: { ...next, ws: { ...next.ws, chat: { site: { ...after, siteKey } } } }, toast };
}

const FLAGS = new Set(['unread', 'starred']);

/**
 * Whether anything in visitors' conversations differs between two states beyond the two flags a member may
 * flip. The chat's own commands and the visitor routes are the only writers of everything else.
 */
export function conversationsRewritten(prev: State, next: State): boolean {
  const a = prev.ws.chats as Record<string, ChatConvo>;
  const b = next.ws.chats as Record<string, ChatConvo>;
  if (a === b) return false;
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const id of ids) {
    // Own entries only: an id such as "constructor" names something every object has, and is not a conversation.
    const x = (Object.hasOwn(a, id) ? a[id] : undefined) as unknown as Record<string, unknown> | undefined;
    const y = (Object.hasOwn(b, id) ? b[id] : undefined) as unknown as Record<string, unknown> | undefined;
    if (x === y) continue;
    if (!x || !y) return true;
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if (!FLAGS.has(k) && !same(x[k], y[k])) return true;
  }
  return false;
}

/**
 * Run on every command's result before it is saved. A conversation changed by anything but a chat command is
 * refused; a change to the chat's settings is checked and recorded.
 */
export async function chatChecked(tx: Tx, loaded: Loaded, ctx: Ctx, action: { type?: unknown } | null | undefined, next: State): Promise<ChatChecked> {
  if (action?.type !== 'chat' && conversationsRewritten(loaded.state, next)) return { reject: 'A visitor’s conversation can’t be changed that way.' };
  return chatSettingsChanged(tx, loaded, ctx, next);
}
