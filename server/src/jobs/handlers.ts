import { config } from '../config';
import { sysPool } from '../db/pool';
import { dueEffects, executeEffect, onEffectApproved, onEffectSettled, reconcileEffect, staleExecuting } from '../gateway/gateway';
import { abandonedRuns, resumeRun } from '../agent/loop';
import { log } from '../lib/log';
import { backfillMail, ingestThread } from '../sync/ingest';
import { defineJob, enqueueSoon } from './jobs';

/** Registers every job and connects the gateway to the queue. Call once at boot. */
export function registerJobs() {
  defineJob('effect.execute', async (d) => {
    await executeEffect(String(d.workspaceId), String(d.effectId));
  });

  // The safety net: anything approved and past its hold runs, even if its own job was lost.
  defineJob(
    'effect.sweep',
    async () => {
      for (const e of await dueEffects(sysPool)) await executeEffect(e.workspace_id, e.id);
      for (const e of await staleExecuting(sysPool)) enqueueSoon('effect.reconcile', { workspaceId: e.workspace_id, effectId: e.id });
      const { rows } = await sysPool.query(`select id, workspace_id from effect where status = 'uncertain' and updated_at < now() - interval '1 minute' limit 25`);
      for (const e of rows) enqueueSoon('effect.reconcile', { workspaceId: e.workspace_id, effectId: e.id }, { singletonKey: `rec:${e.id}` });
    },
    '* * * * *',
  );

  defineJob('effect.reconcile', async (d) => {
    await reconcileEffect(String(d.workspaceId), String(d.effectId));
  });

  defineJob('mail.backfill', async (d) => {
    const days = Number(d.days ?? config.backfillFastDays);
    const p = await backfillMail(String(d.workspaceId), String(d.connectionId), { days, maxPages: 20 });
    if (!p.done) enqueueSoon('mail.backfill', d);
    // The first pass covers the recent weeks so the first brief is quick; the rest follows.
    else if (days < config.backfillFullDays) enqueueSoon('mail.backfill', { ...d, days: config.backfillFullDays }, { startAfter: 60 });
    log.info('backfill pass', { workspaceId: d.workspaceId, days, ...p });
  });

  defineJob('mail.ingest', async (d) => {
    await ingestThread(String(d.workspaceId), String(d.connectionId), String(d.threadKey), 'sync', d.seed as Record<string, unknown> | undefined);
  });

  defineJob('run.resume', async (d) => {
    await resumeRun(String(d.workspaceId), String(d.runId));
  });

  // Runs whose worker died are picked up again from their last checkpoint.
  defineJob(
    'run.sweep',
    async () => {
      for (const r of await abandonedRuns(sysPool)) enqueueSoon('run.resume', { workspaceId: r.workspace_id, runId: r.id }, { singletonKey: `run:${r.id}` });
    },
    '* * * * *',
  );

  defineJob(
    'webhook.cleanup',
    async () => {
      await sysPool.query(`delete from webhook_event where received_at < now() - interval '7 days'`);
      await sysPool.query(`delete from state_change where at < now() - interval '2 days'`);
    },
    '17 3 * * *',
  );

  onEffectApproved((e) => enqueueSoon('effect.execute', { workspaceId: e.workspace_id, effectId: e.id }, { startAfter: e.hold_until ? new Date(e.hold_until) : 0 }));
  onEffectSettled((e) => {
    if (e.run_id) enqueueSoon('run.resume', { workspaceId: e.workspace_id, runId: e.run_id });
  });
}
