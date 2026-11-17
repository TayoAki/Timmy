/**
 * The names of the files on received mail, for a mailbox whose listing does not give them.
 *
 * Gmail's listing names each message's files. Outlook's only says whether a message has any (`hasAttachments`), so
 * the names are asked for apart, one call per message. To keep that bounded:
 *   - only a message that has files is asked about (Outlook leaves pictures placed inside the body out of the flag);
 *   - only a message Timmy has not stored yet: the names are kept with the stored copy, so a thread fetched again
 *     when a reply arrives asks nothing about the messages it already had;
 *   - at most MAX_ASKED messages per batch of mail. Beyond that a message is stored without names, as before.
 * A message whose names could not be had is stored without them; it is not asked about again.
 */
import { withWorkspace } from '../db/pool';
import { log } from '../lib/log';
import type { Mailbox } from './mailbox';
import type { MailMessage } from './message';
import type { ConnectionRow, Phase } from './tools';

/** The most messages whose files are asked about for one batch of mail (a page of the first read, or one thread). */
export const MAX_ASKED = 25;

export async function withAttachmentNames(workspaceId: string, conn: ConnectionRow, box: Mailbox, list: MailMessage[], phase: Phase): Promise<MailMessage[]> {
  if (!box.attachmentNames) return list;
  const wanted = list.filter((m) => m.hasAttachments && !m.attachments.length && !m.labels.includes('DRAFT'));
  if (!wanted.length) return list;
  const stored = await withWorkspace({ workspaceId }, async (tx) => (await tx.query(`select external_id from item where workspace_id = $1 and connection_id = $2 and kind = 'message' and external_id = any($3::text[])`, [workspaceId, conn.id, wanted.map((m) => m.id)])).rows.map((r) => r.external_id as string));
  const known = new Set(stored);
  const ask = wanted.filter((m) => !known.has(m.id)).slice(0, MAX_ASKED);
  const names = new Map<string, string[]>();
  for (const m of ask) {
    const got = await box.attachmentNames(workspaceId, conn, m.id, phase).catch((e: Error) => {
      log.warn('could not list the files on a message', { workspaceId, connectionId: conn.id, error: e.message });
      return null;
    });
    // Two files of the same name are shown once: the names are only there to say what came.
    if (got?.length) names.set(m.id, [...new Set(got)]);
  }
  return names.size ? list.map((m) => (names.has(m.id) ? { ...m, attachments: names.get(m.id)! } : m)) : list;
}
