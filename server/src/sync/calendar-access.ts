/**
 * A calendar Timmy was not allowed to read.
 *
 * Until Nov 17 Outlook was connected for mail only, so an Outlook account connected before then has no permission
 * for its calendar, and every calendar call on it is refused. Asking again changes nothing until the person connects
 * the account again and allows the calendar. So the first refusal is recorded on the connection, nothing more is
 * asked of that calendar, and the Connections screen says what to do. Connecting again makes a new connection,
 * which starts without the mark.
 */
import { log } from '../lib/log';
import { mutate } from '../state/mutate';
import type { ConnectionRow } from './tools';

/** Thrown by a calendar's listing when the provider refused it for lack of permission, not for any passing reason. */
export class CalendarRefused extends Error {}

/**
 * Whether a provider's refusal says the account may not use the calendar at all. Microsoft Graph answers 403 with
 * ErrorAccessDenied ("Access is denied. Check credentials and try again."); Composio may also stop a call itself
 * when the account lacks the permission the tool needs. A missing event, a bad request or a busy server is not this.
 */
export const refusedForPermission = (error: string | null | undefined): boolean =>
  /ErrorAccessDenied|Access is denied|\b403\b|\bForbidden\b|Authorization_RequestDenied|insufficient (privileges|permissions?|scopes?)|missing (required )?(permissions?|scopes?)/i.test(error ?? '');

/** Whether Timmy has already found that this connection may not read its calendar. */
export const calendarRefused = (conn: Pick<ConnectionRow, 'meta'>): boolean => typeof conn.meta?.calendarRefused === 'string';

/**
 * Records that a connection's calendar was refused: on the connection, so it is not asked again, and on the
 * Connections screen's copy of the app, so its card can say to connect it again. Mail through the same account
 * is untouched.
 */
export async function markCalendarRefused(workspaceId: string, conn: ConnectionRow, error: string): Promise<void> {
  log.warn('the calendar was refused for lack of permission; it will not be read again until the account is connected again', { workspaceId, connectionId: conn.id });
  await mutate(workspaceId, 'calendar', async (tx, loaded) => {
    const { rowCount } = await tx.query(
      `update connection set meta = meta || jsonb_build_object('calendarRefused', now()::text), updated_at = now()
       where id = $1 and workspace_id = $2 and status = 'active' and not (meta ? 'calendarRefused')`,
      [conn.id, workspaceId],
    );
    if (!rowCount) return { state: loaded.state, result: null };
    // Only the start of the provider's words is kept: enough to tell what it said, nothing of the account.
    // Written here rather than through the gateway's helper, which this module must not import (the gateway reaches the calendars).
    await tx.query(`insert into audit_log (workspace_id, actor, action, detail) values ($1, 'system', 'connection.calendar_refused', $2::jsonb)`, [workspaceId, JSON.stringify({ app: conn.app_id, connectionId: conn.id, error: error.slice(0, 200) })]);
    const s = loaded.state;
    const app = s.conn.apps[conn.app_id];
    if (!app?.connected) return { state: s, result: null };
    return { state: { ...s, conn: { ...s.conn, apps: { ...s.conn.apps, [conn.app_id]: { ...app, calendarRefused: true } } } }, result: null };
  });
}
