import type pg from 'pg';

/**
 * Removes every row of workspaces that were deleted more than `afterDays` ago:
 * their state, synced mail, runs, effects, usage and audit log go with the
 * workspace row. A workspace is only ever picked up here after a person
 * deleted it; until then nothing in this file touches it.
 *
 * The audit log refuses deletes. This purge is the one exception, and it says
 * so to the database for the length of its own transaction (see migration 0003).
 */
export async function purgeDeletedWorkspaces(pool: pg.Pool, afterDays: number): Promise<number> {
  const { rows } = await pool.query(`select id from workspace where deleted_at is not null and deleted_at < now() - make_interval(days => $1::int)`, [afterDays]);
  for (const r of rows) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(`set local timmy.purge = 'on'`);
      await c.query('delete from workspace where id = $1 and deleted_at is not null', [r.id]);
      await c.query('commit');
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }
  return rows.length;
}
