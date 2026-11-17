/**
 * The automation engine's background work: carrying a run forward, picking a run up again once a person
 * has decided, and a once-a-minute pass that starts scheduled automations and catches anything whose own
 * job was lost (and any automation still on whose owner or admin no longer is one).
 */
import { sysPool } from '../db/pool';
import { defineJob, enqueueSoon } from '../jobs/jobs';
import { log } from '../lib/log';
import { decidedWaits, effectSettled, readyRuns, runAutomation } from './runner';
import { switchOffWithoutOwner, workspacesWithoutOwner } from './roles';
import { dueSchedules, fireSchedule } from './triggers';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export { isAutomationEffect } from './keys';

export function registerAutomationJobs() {
  defineJob('automation.run', async (d) => {
    const workspaceId = String(d.workspaceId);
    const runId = String(d.runId);
    // A run is queued inside the transaction that noticed its event, and this job can be picked up before
    // that transaction has finished. A run that isn't there yet is looked for again, briefly; the sweep is the net under that.
    for (let i = 0; i < 4; i++) {
      if ((await runAutomation(workspaceId, runId)) !== 'missing') return;
      await pause(250);
    }
  });

  defineJob('automation.effect', async (d) => {
    // The same goes for a decision: the job can arrive before the decision's own transaction has finished.
    for (let i = 0; i < 4; i++) {
      if (await effectSettled(String(d.workspaceId), String(d.effectId))) return;
      await pause(250);
    }
  });

  defineJob(
    'automation.sweep',
    async () => {
      // First, so nothing below starts for it: an automation whose owner or admin lost that role in a way no hook saw
      // is switched off here (roles.ts).
      for (const workspaceId of await workspacesWithoutOwner(sysPool)) await switchOffWithoutOwner(workspaceId).catch((e) => log.error('could not switch off an automation whose owner or admin left', { workspaceId, error: (e as Error).message }));
      for (const s of await dueSchedules(sysPool)) await fireSchedule(s.workspace_id, s.automation_id);
      for (const r of await readyRuns(sysPool)) enqueueSoon('automation.run', { workspaceId: r.workspace_id, runId: r.id }, { singletonKey: `arun:${r.id}` });
      for (const w of await decidedWaits(sysPool)) enqueueSoon('automation.effect', { workspaceId: w.workspace_id, effectId: w.effect_id }, { singletonKey: `aeff:${w.effect_id}` });
    },
    '* * * * *',
  );
}
