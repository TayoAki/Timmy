/** The background work uploaded files need: deleting the ones nothing uses any more, and scanning ones kept before a scanner was set up. */
import { defineJob } from '../jobs/jobs';
import { log } from '../lib/log';
import { cleanUpUnusedFiles, scanBacklog } from './cleanup';

export function registerFileJobs() {
  // Four times a day: a file must be found unused on every pass for the whole grace period before it goes.
  defineJob(
    'files.unused.sweep',
    async () => {
      const removed = await cleanUpUnusedFiles();
      if (removed) log.info('deleted uploaded files that nothing used', { files: removed });
    },
    '29 */6 * * *',
  );

  // Every ten minutes, and only on a server that scans: files kept before the scanner was set up are scanned.
  defineJob(
    'files.scan.backlog',
    async () => {
      const out = await scanBacklog();
      if (out.scanned) log.info('scanned files kept before the virus scanner was set up', out);
    },
    '*/10 * * * *',
  );
}
