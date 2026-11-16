/** The background work pages need: removing versions past their keeping time, and emptying the trash. */
import { sysPool } from '../db/pool';
import { defineJob, enqueueSoon } from '../jobs/jobs';
import { log } from '../lib/log';
import { emptyOldTrash, workspacesWithOldTrash } from './trash';
import { pruneVersions } from './versions';

export function registerPageJobs() {
  // Once an hour: versions older than the keeping days go, and so does anything beyond the newest copies of a page.
  defineJob(
    'page.versions.prune',
    async () => {
      const gone = await pruneVersions(sysPool);
      if (gone) log.info('removed page versions past their keeping time', { versions: gone });
    },
    '37 * * * *',
  );

  // Once an hour: each workspace holding a page that has been in the trash too long gets its own job, so one
  // workspace's failure never holds up another's.
  defineJob(
    'page.trash.sweep',
    async () => {
      for (const workspaceId of await workspacesWithOldTrash(sysPool)) enqueueSoon('page.trash.empty', { workspaceId }, { singletonKey: `trash:${workspaceId}` });
    },
    '53 * * * *',
  );

  defineJob('page.trash.empty', async (d) => {
    const gone = await emptyOldTrash(String(d.workspaceId));
    if (gone) log.info('deleted pages that had been in the trash too long', { workspaceId: d.workspaceId, pages: gone });
  });
}
