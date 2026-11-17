/**
 * Runs before every test file (vitest's setupFiles run once per file, even with isolation off).
 *
 * Every test file shares one database. Jobs that sweep "every connected mailbox" (the nightly checks, the files
 * pass, the calendar re-read) would otherwise also see the accounts earlier files left connected, and the
 * in-process runner stops a sweep after a fixed number of jobs. Each file starts with none connected and sees only
 * its own. Before the first file the tables may not exist yet; then there is nothing to disconnect.
 */
import { beforeAll } from 'vitest';
import { sysPool } from '../src/db/pool';

beforeAll(async () => {
  await sysPool
    .query(`update connection set status = 'disconnected', disconnected_at = now(), updated_at = now() where status in ('active', 'pending')`)
    .catch((e: { code?: string }) => {
      if (e.code !== '42P01') throw e;
    });
});
