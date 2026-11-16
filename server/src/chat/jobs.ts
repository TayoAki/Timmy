/**
 * Keeping visitors' conversations only as long as the workspace chose (12 months unless it set otherwise).
 * Once a night every conversation whose last message is older than that is deleted: the stored copy, and the
 * copy on the Chats screen.
 */
import { sysPool } from '../db/pool';
import { audit } from '../gateway/gateway';
import { defineJob } from '../jobs/jobs';
import { log } from '../lib/log';
import { mutate } from '../state/mutate';
import { deleteConversations } from './commands';
import { DEFAULT_RETENTION_MONTHS } from './settings';
import { withoutConversations } from './shown';

const BATCH = 500;

/** Deletes one workspace's conversations that are past its retention period. Returns how many went. */
export async function removeExpiredChats(workspaceId: string): Promise<number> {
  let total = 0;
  for (;;) {
    const gone = await mutate(workspaceId, 'chat', async (tx, loaded) => {
      const months = ((await tx.query('select retention_months from chat_widget where workspace_id = $1', [workspaceId])).rows[0]?.retention_months as number | undefined) ?? DEFAULT_RETENTION_MONTHS;
      const old = (await tx.query(`select id from chat_conversation where workspace_id = $1 and last_message_at < now() - make_interval(months => $2::int) order by last_message_at limit $3`, [workspaceId, months, BATCH])).rows.map((r) => r.id as string);
      if (!old.length) return { result: 0 };
      const removed = await deleteConversations(tx, workspaceId, old);
      await audit(tx, workspaceId, { actor: 'system', action: 'chat.retention', detail: { conversations: removed.length, months } });
      return { state: withoutConversations(loaded.state, old), result: removed.length };
    });
    total += gone;
    if (gone < BATCH) return total;
  }
}

export function registerChatJobs() {
  defineJob(
    'chat.retention',
    async () => {
      // Which workspaces have a chat at all is the system's to list; each one's conversations are then deleted inside that workspace.
      const { rows } = await sysPool.query('select workspace_id from chat_widget');
      let total = 0;
      for (const r of rows) total += await removeExpiredChats(r.workspace_id as string).catch((e) => (log.warn('could not remove a workspace’s old chats', { workspaceId: r.workspace_id, error: (e as Error).message }), 0));
      // The daily counters are only needed for the day they count.
      await sysPool.query(`delete from chat_counter where day < current_date - 7`);
      if (total) log.info('removed website chats past their retention period', { conversations: total });
    },
    '23 4 * * *',
  );
}
