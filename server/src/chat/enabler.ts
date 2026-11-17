/**
 * The website chat answers strangers on its own under a rule a person set: "the chat is switched on". Only an
 * owner or admin may set it, so the rule holds only while the person who switched the chat on is still one.
 * When they are not any more (their role was lowered, they were removed, or they left), the chat is switched off,
 * its rule ends, and the activity log tells the owners and admins why. Another owner or admin can switch it on
 * again, and it then runs under their name.
 *
 * Called from the auth hooks with the workspace and the person whose membership changed. The public routes also
 * treat the chat as off while its switcher lacks the role (site.ts), so it stays closed even if this never ran.
 */
import type { ChatWidget } from '../../../src/data/ws-types';
import { membership } from '../auth/members';
import { rulesFor } from '../auth/roles';
import { authPool } from '../db/pool';
import { audit } from '../gateway/gateway';
import { log } from '../lib/log';
import { mutate } from '../state/mutate';
import { withActivity } from './shown';

/**
 * Switches the chat off if `userId` switched it on and is no longer an owner or admin of the workspace.
 * Never throws: a membership change must not fail because of the chat.
 */
export async function chatEnablerChanged(workspaceId: string, userId: string): Promise<void> {
  try {
    if (rulesFor(await membership(userId, workspaceId)).policy) return;
    const who = ((await authPool.query('select name from "user" where id = $1', [userId])).rows[0]?.name as string | undefined)?.trim().slice(0, 80) || 'The person who switched it on';
    const off = await mutate(workspaceId, 'chat', async (tx, loaded) => {
      const row = (await tx.query('select is_on, switched_on_by from chat_widget where workspace_id = $1 for update', [workspaceId])).rows[0] as { is_on: boolean; switched_on_by: string | null } | undefined;
      if (!row?.is_on || row.switched_on_by !== userId) return { result: false };
      await tx.query('update chat_widget set is_on = false, updated_at = now() where workspace_id = $1', [workspaceId]);
      await tx.query(`update policy set enabled = false, updated_at = now() where workspace_id = $1 and kind = 'chat.reply' and enabled`, [workspaceId]);
      await audit(tx, workspaceId, { actor: 'system', action: 'chat.switched_off', detail: { reason: 'switched on by someone no longer an owner or admin', by: userId } });
      const w = loaded.state.ws.chat.site as ChatWidget | undefined;
      const state = w ? { ...loaded.state, ws: { ...loaded.state.ws, chat: { site: { ...w, on: false } } } } : loaded.state;
      return {
        state: withActivity(state, 'approval', `For owners and admins: the website chat is switched off. ${who} switched it on and is no longer an owner or admin here, so Timmy stopped answering visitors. An owner or admin can switch it on again in Outbound › Website chat.`),
        result: true,
      };
    });
    if (off) log.info('switched the website chat off: whoever switched it on lost the role', { workspaceId });
  } catch (e) {
    log.error('could not check the website chat after a membership change', { workspaceId, error: (e as Error).message });
  }
}
