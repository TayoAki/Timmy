/** Background work for the kinds Timmy tracks: reading recent mail for a kind someone just accepted. */
import { defineJob } from '../jobs/jobs';
import { rereadForKind } from './reread';

export function registerTrackingJobs() {
  defineJob('tracking.reread', async (d) => {
    await rereadForKind(String(d.workspaceId), String(d.typeId));
  });
}
