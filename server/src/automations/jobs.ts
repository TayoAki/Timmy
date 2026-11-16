/**
 * The automation engine's background work: carrying a run forward, picking a run up again once a person
 * has decided, and a once-a-minute pass that starts scheduled automations and catches anything whose own
 * job was lost.
 */
import { sysPool } from '../db/pool';
import type { EffectRow } from '../gateway/gateway';
import { defineJob, enqueueSoon } from '../jobs/jobs';
import { decidedWaits, effectSettled, readyRuns, runAutomation } from './runner';
import { dueSchedules, fireSchedule } from './triggers';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether an effect was put forward by a step of an automation's run. Its key says so: "run:arun_…:node:…". */
export const isAutomationEffect = (e: Pick<EffectRow, 'idempotency_key'>) => /^run:arun_[^:]+:node:/.test(e.idempotency_key);

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
      for (const s of await dueSchedules(sysPool)) await fireSchedule(s.workspace_id, s.automation_id);
      for (const r of await readyRuns(sysPool)) enqueueSoon('automation.run', { workspaceId: r.workspace_id, runId: r.id }, { singletonKey: `arun:${r.id}` });
      for (const w of await decidedWaits(sysPool)) enqueueSoon('automation.effect', { workspaceId: w.workspace_id, effectId: w.effect_id }, { singletonKey: `aeff:${w.effect_id}` });
    },
    '* * * * *',
  );
}
