/**
 * The nightly re-read of every connected calendar.
 *
 * A calendar is read when it is connected, when the provider announces a change and after each of Timmy's own
 * writes. A quiet calendar announces nothing, yet the window Timmy keeps (two weeks back, two months ahead) moves
 * every day: events come into it at the far end and leave it at the near one. Once a night each active Google
 * Calendar and Outlook calendar connection is read again, like the nightly mail check, so Timmy's calendar keeps up.
 *
 * What it costs: one job per connection, and that job reads the window a page at a time, up to the listing's own
 * limit of pages (20; one page holds 250 Google events or 100 Outlook events, so a page or two is usual). Nothing is
 * asked per event. A calendar refused for lack of permission is left out, and so is one already waiting to be read:
 * the job shares its key with the reads that announcements queue.
 */
import { sysPool } from '../db/pool';
import { defineJob, enqueueSoon } from '../jobs/jobs';
import { CALENDAR_TOOLKITS } from './calendars';

/** Registers the nightly pass. Called once at boot, with the other jobs. */
export function registerCalendarJobs() {
  defineJob(
    'calendar.sync.all',
    async () => {
      // Oldest connection first, in the same order every night (without an order, Postgres returns rows as they lie).
      const { rows } = await sysPool.query(`select id, workspace_id from connection where status = 'active' and toolkit = any($1::text[]) and not (meta ? 'calendarRefused') order by created_at, id`, [CALENDAR_TOOLKITS]);
      for (const c of rows) enqueueSoon('calendar.sync', { workspaceId: c.workspace_id, connectionId: c.id, nightly: true }, { singletonKey: `cal:${c.id}` });
    },
    // After the mail check (2:41) and before Drive's (3:17), so the three passes do not start together.
    '53 2 * * *',
  );
}
