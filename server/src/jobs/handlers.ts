import { config } from '../config';
import { sysPool } from '../db/pool';
import { dueEffects, executeEffect, expireStaleApprovals, onEffectApproved, onEffectSettled, reconcileEffect, staleExecuting } from '../gateway/gateway';
import { draftFor } from '../agent/draft';
import { dueWorkspaces, morningRun } from '../agent/morning';
import { needsReading, readThread } from '../agent/read';
import { deliverMail, undeliveredMail } from '../providers/email';
import { modelReady } from '../providers/model';
import { readState } from '../state/mutate';
import { abandonedRuns, resumeRun } from '../agent/loop';
import { log } from '../lib/log';
import { syncCalendar } from '../sync/calendar';
import { purgeDeletedWorkspaces } from '../db/purge';
import { forgetAbandonedUploads, removeWorkspaceFiles } from '../files/assets';
import { closeOrphanedConnections, purgeConnection, revokeAtProvider } from '../sync/connect';
import { removeFile, syncFiles } from '../sync/files';
import { backfillMail, ingestThread, reconcileMail } from '../sync/ingest';
import { MAIL_TOOLKITS } from '../sync/mailbox';
import { checkMailbox, checkWorkspaceMailboxes } from '../sync/mailbox-check';
import { noteItems, pruneOntology } from '../ontology/ontology';
import { projectPeople } from '../ontology/people';
import { registerChatJobs } from '../chat/jobs';
import { defineJob, enqueueSoon } from './jobs';
import { isAutomationEffect, registerAutomationJobs } from '../automations/jobs';
import { registerPageJobs } from '../pages/jobs';
import { registerFileJobs } from '../files/jobs';

/** Registers every job and connects the gateway to the queue. Call once at boot. */
/** Asks for the map to be brought up to date. One pass per workspace is queued at a time, however many items arrived. */
const learn = (workspaceId: string) => enqueueSoon('ontology.note', { workspaceId }, { singletonKey: `ontology:${workspaceId}` });

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
      // Account mail whose delivery job was lost is picked up again while its link is still good.
      for (const id of await undeliveredMail()) enqueueSoon('email.deliver', { id }, { singletonKey: `mail:${id}` });
    },
    '* * * * *',
  );

  // Timmy's own account mail. A failed delivery throws, so the queue tries it again.
  defineJob('email.deliver', async (d) => {
    await deliverMail(Number(d.id));
  });

  defineJob('effect.reconcile', async (d) => {
    await reconcileEffect(String(d.workspaceId), String(d.effectId));
  });

  defineJob('mail.backfill', async (d) => {
    const days = Number(d.days ?? config.backfillFastDays);
    const p = await backfillMail(String(d.workspaceId), String(d.connectionId), { days, maxPages: 20 });
    if (p.messages) learn(String(d.workspaceId));
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
    if (fresh) learn(workspaceId);
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
      const { rows } = await sysPool.query(`select id, workspace_id from connection where status = 'active' and toolkit = any($1::text[])`, [MAIL_TOOLKITS]);
      for (const c of rows) enqueueSoon('mail.reconcile', { workspaceId: c.workspace_id, connectionId: c.id }, { singletonKey: `recon:${c.id}` });
    },
    '41 2 * * *',
  );

  defineJob('mail.reconcile', async (d) => {
    const workspaceId = String(d.workspaceId);
    const found = await reconcileMail(workspaceId, String(d.connectionId));
    // The same night, what the person changed in the mailbox itself (archived, labelled, read, deleted) is picked up.
    await checkMailbox(workspaceId, String(d.connectionId)).catch((e) => log.warn('the nightly look at the mailbox for changes failed', { workspaceId, error: (e as Error).message }));
    if (found.fresh) learn(workspaceId);
    if (found.fresh) {
      log.info('the nightly check found mail the triggers missed', { workspaceId, ...found });
      if (modelReady()) await readNewest(workspaceId, 2, 20);
    }
  });

  // A look at a workspace's mailbox for what the person changed there. Queued when the app opens and while a tab
  // stays open (see sync/mailbox-check.ts): `gap` keeps several tabs from multiplying the looks, and `idle` stops
  // them for a tab that is only left open. A look that fails is not retried: the next one sees the same mailbox.
  defineJob('mail.changes', async (d) => {
    const workspaceId = String(d.workspaceId);
    await checkWorkspaceMailboxes(workspaceId, { minGapSeconds: Number(d.gap ?? 0), idleSeconds: Number(d.idle ?? 0) }).catch((e) => log.warn('the look at the mailbox for changes failed', { workspaceId, error: (e as Error).message }));
  });

  defineJob('mail.read', async (d) => {
    await readThread(String(d.workspaceId), String(d.threadId));
  });

  // Removing an account at the provider is retried until it works; the connection is already unused on our side.
  defineJob('connection.revoke', async (d) => {
    await revokeAtProvider((d.connectedAccountId as string | null) ?? null, (d.triggers as string[] | undefined) ?? []);
  });

  defineJob('draft.make', async (d) => {
    const workspaceId = String(d.workspaceId);
    const thread = (await readState(workspaceId)).state.threads.find((t) => t.id === String(d.threadId));
    if (!thread) return;
    const decided = d.decided && typeof d.decided === 'object' ? (d.decided as { question: string; answer: string }) : undefined;
    const out = await draftFor(workspaceId, thread, { note: d.note as string | undefined, userName: d.userName as string | undefined, ...(decided ? { decided } : {}) });
    if (!out.ok) log.warn('no draft written', { workspaceId, reason: out.reason });
  });

  // The map of people, companies, meetings and files: every stored item is looked at once, in batches, by plain code.
  defineJob('ontology.note', async (d) => {
    const workspaceId = String(d.workspaceId);
    const out = await noteItems(workspaceId);
    if (out.more) enqueueSoon('ontology.note', { workspaceId });
    else if (out.items) await projectPeople(workspaceId);
  });

  // Items whose pass was missed (a job lost, a server restarted) are picked up within the hour.
  defineJob(
    'ontology.sweep',
    async () => {
      const { rows } = await sysPool.query(`select distinct i.workspace_id from item i join connection c on c.id = i.connection_id where i.ontology_at is null and c.status = 'active' limit 500`);
      for (const r of rows) learn(r.workspace_id as string);
    },
    '23 * * * *',
  );

  defineJob('calendar.sync', async (d) => {
    const out = await syncCalendar(String(d.workspaceId), String(d.connectionId));
    if (out.events) learn(String(d.workspaceId));
    // An event the calendar no longer has left the store; what the map knew only from it goes too.
    if (out.dropped) {
      await pruneOntology(String(d.workspaceId));
      await projectPeople(String(d.workspaceId));
    }
  });

  // The list of Drive files: a pass that didn't finish carries on in a new job from where it stopped.
  defineJob('files.sync', async (d) => {
    const p = await syncFiles(String(d.workspaceId), String(d.connectionId));
    if (p.files) learn(String(d.workspaceId));
    if (!p.done) enqueueSoon('files.sync', d);
  });

  defineJob('files.remove', async (d) => {
    await removeFile(String(d.workspaceId), String(d.connectionId), String(d.fileId));
  });

  // Drive's triggers can be missed like any other; once a night every connected Drive is listed again from its last finished pass.
  defineJob(
    'files.sync.all',
    async () => {
      const { rows } = await sysPool.query(`select id, workspace_id from connection where status = 'active' and toolkit = 'googledrive'`);
      for (const c of rows) enqueueSoon('files.sync', { workspaceId: c.workspace_id, connectionId: c.id }, { singletonKey: `files:${c.id}` });
    },
    '17 3 * * *',
  );

  // The morning run: every five minutes, start it for each workspace whose chosen time has come in its own time zone.
  defineJob(
    'morning.tick',
    async () => {
      // The run itself claims the day, so a workspace listed twice before its run starts still runs once.
      for (const workspaceId of await dueWorkspaces(sysPool)) enqueueSoon('morning.run', { workspaceId }, { singletonKey: `morning:${workspaceId}` });
    },
    '*/5 * * * *',
  );

  defineJob('morning.run', async (d) => {
    await morningRun(String(d.workspaceId));
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

  // What a disconnected account synced is deleted: its messages, their bodies and its events.
  defineJob('connection.purge', async (d) => {
    const gone = await purgeConnection(String(d.workspaceId), String(d.connectionId));
    if (gone) log.info('deleted what a disconnected account had synced', { workspaceId: d.workspaceId, connectionId: d.connectionId, items: gone });
    // What Timmy had learned from that account goes with it: the map keeps only what a stored item still supports.
    await pruneOntology(String(d.workspaceId));
    await projectPeople(String(d.workspaceId));
  });

  // A deleted workspace's uploaded files leave the bucket right away. The purge clears the prefix again later, in case this was missed.
  defineJob('assets.remove', async (d) => {
    const gone = await removeWorkspaceFiles(String(d.workspaceId));
    if (gone) log.info('removed a deleted workspace’s uploaded files', { workspaceId: d.workspaceId, files: gone });
  });

  // A connection belongs to a member. If the membership ended some way the hooks did not see, it is closed here.
  defineJob(
    'connection.sweep',
    async () => {
      const closed = await closeOrphanedConnections(sysPool);
      if (closed) log.warn('closed connections whose person had left the workspace', { closed });
    },
    '*/10 * * * *',
  );

  defineJob(
    'webhook.cleanup',
    async () => {
      await sysPool.query(`delete from webhook_event where received_at < now() - interval '7 days'`);
      await sysPool.query(`delete from state_change where at < now() - interval '2 days'`);
      // Sign-in links and invitations that were written out are of no use after a week.
      await sysPool.query(`delete from email_outbox where created_at < now() - interval '7 days'`);
      // A command's stored answer is only needed for a retry or an undo, both long past after a month.
      await sysPool.query(`delete from command where at < now() - interval '30 days'`);
      // A finished run's transcript is only kept to resume it, which it never will be again.
      await sysPool.query(`delete from run_checkpoint c using run r where r.id = c.run_id and r.status in ('completed', 'failed', 'cancelled') and c.created_at < now() - interval '1 day'`);
      // An upload that was announced and never arrived is of no use to anyone.
      await forgetAbandonedUploads();
      const purged = await purgeDeletedWorkspaces(sysPool, config.mailRetentionDays, removeWorkspaceFiles);
      if (purged) log.info('removed the data of deleted workspaces', { workspaces: purged });
    },
    '17 3 * * *',
  );

  // The website chat: conversations past their retention period are deleted nightly.
  registerChatJobs();
  // Page versions past their keeping time, and pages too long in the trash.
  registerPageJobs();
  // Uploaded files nothing uses any more, and files kept before a virus scanner was set up.
  registerFileJobs();

  onEffectApproved((e) => enqueueSoon('effect.execute', { workspaceId: e.workspace_id, effectId: e.id }, { startAfter: e.hold_until ? new Date(e.hold_until) : 0 }));
  // [automations] The engine's own jobs (automations/jobs.ts).
  registerAutomationJobs();
  onEffectSettled((e) => {
    if (e.run_id) enqueueSoon('run.resume', { workspaceId: e.workspace_id, runId: e.run_id });
    // [automations] A step of an automation's run was waiting on this decision.
    else if (isAutomationEffect(e)) enqueueSoon('automation.effect', { workspaceId: e.workspace_id, effectId: e.id });
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
