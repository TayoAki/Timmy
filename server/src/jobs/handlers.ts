import { config } from '../config';
import { sysPool } from '../db/pool';
import { dueEffects, executeEffect, expireStaleApprovals, onEffectApproved, onEffectSettled, reconcileEffect, staleExecuting } from '../gateway/gateway';
import { draftReply } from '../agent/draft';
import { needsReading, readThread } from '../agent/read';
import { modelReady } from '../providers/model';
import { readState } from '../state/mutate';
import { abandonedRuns, resumeRun } from '../agent/loop';
import { log } from '../lib/log';
import { syncCalendar } from '../sync/calendar';
import { revokeAtProvider } from '../sync/connect';
import { backfillMail, ingestThread, reconcileMail } from '../sync/ingest';
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
      await expireStaleApprovals(sysPool);
      for (const e of await dueEffects(sysPool)) await executeEffect(e.workspace_id, e.id);
      for (const e of await staleExecuting(sysPool)) enqueueSoon('effect.reconcile', { workspaceId: e.workspace_id, effectId: e.id });
      // An unconfirmed send is checked against the Sent folder for half an hour; after that it stays unconfirmed for a person to look at.
      const { rows } = await sysPool.query(`select id, workspace_id from effect where status = 'uncertain' and updated_at < now() - interval '1 minute' and executing_at > now() - interval '30 minutes' limit 25`);
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
    else if (days < config.backfillFullDays) {
      enqueueSoon('mail.backfill', { ...d, days: config.backfillFullDays }, { startAfter: 60 });
      // So the first screen is useful: the model reads the newest threads people wrote. Older ones keep the plain-code sort.
      if (modelReady() && p.pages > 0) {
        await readNewest(String(d.workspaceId), config.firstReadDays, config.firstReadThreads);
      }
    }
    log.info('backfill pass', { workspaceId: d.workspaceId, days, ...p });
  });

  defineJob('mail.ingest', async (d) => {
    const workspaceId = String(d.workspaceId);
    const fresh = await ingestThread(workspaceId, String(d.connectionId), String(d.threadKey), 'sync', d.seed as Record<string, unknown> | undefined);
    // Plain code went first. What it couldn't settle (mail from a person) gets one read by the model.
    if (fresh && modelReady()) {
      const { state } = await readState(workspaceId);
      const t = state.threads.find((x) => x.ext?.threadKey === String(d.threadKey));
      if (t && needsReading(t)) enqueueSoon('mail.read', { workspaceId, threadId: t.id }, { singletonKey: `read:${workspaceId}:${t.id}` });
    }
  });

  // The safety net for mail: once a night every connected mailbox's last two days are checked against what is stored.
  defineJob(
    'mail.reconcile.all',
    async () => {
      const { rows } = await sysPool.query(`select id, workspace_id from connection where status = 'active' and toolkit = 'gmail'`);
      for (const c of rows) enqueueSoon('mail.reconcile', { workspaceId: c.workspace_id, connectionId: c.id }, { singletonKey: `recon:${c.id}` });
    },
    '41 2 * * *',
  );

  defineJob('mail.reconcile', async (d) => {
    const workspaceId = String(d.workspaceId);
    const found = await reconcileMail(workspaceId, String(d.connectionId));
    if (found.fresh) {
      log.info('the nightly check found mail the triggers missed', { workspaceId, ...found });
      if (modelReady()) await readNewest(workspaceId, 2, 20);
    }
  });

  defineJob('mail.read', async (d) => {
    await readThread(String(d.workspaceId), String(d.threadId));
  });

  // Removing an account at the provider is retried until it works; the connection is already unused on our side.
  defineJob('connection.revoke', async (d) => {
    await revokeAtProvider((d.connectedAccountId as string | null) ?? null, (d.triggers as string[] | undefined) ?? []);
  });

  defineJob('draft.make', async (d) => {
    const out = await draftReply(String(d.workspaceId), String(d.threadId), { note: d.note as string | undefined, userName: d.userName as string | undefined });
    if (!out.ok) log.warn('no draft written', { workspaceId: d.workspaceId, reason: out.reason });
  });

  defineJob('calendar.sync', async (d) => {
    await syncCalendar(String(d.workspaceId), String(d.connectionId));
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

/** Queues the model's first read for the newest threads a person wrote and Timmy hasn't read yet. */
async function readNewest(workspaceId: string, days: number, limit: number) {
  const { state } = await readState(workspaceId);
  const since = Date.now() - days * 86400_000;
  const lastAt = (t: (typeof state.threads)[number]) => new Date(t.messages[t.messages.length - 1]?.at ?? 0).getTime();
  const newest = state.threads
    .filter((t) => needsReading(t) && lastAt(t) >= since)
    .sort((a, b) => lastAt(b) - lastAt(a))
    .slice(0, limit);
  for (const t of newest) enqueueSoon('mail.read', { workspaceId, threadId: t.id }, { singletonKey: `read:${workspaceId}:${t.id}` });
}
