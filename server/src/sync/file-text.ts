/**
 * Reading what synced files say, so Ask can find a file by a word inside it (Google Drive and OneDrive).
 *
 * After a pass over a file list, the files that are new or changed are read through their connection, and their
 * words are kept with them in item_body (at most MAX_FILE_TEXT characters each), where Postgres's full-text index
 * finds them. There is no model and no embedding: plain full-text search.
 *
 * The cost is bounded three ways: only files changed inside the sync window are read; at most `perPass` files are
 * read in one pass (the rest wait for the next); and a file larger than `maxBytes` is listed by name only. A file is
 * read once per version: the time it last changed is kept with its words, and it is read again only when the drive
 * reports a newer one. The words go when the file's item goes (deleted, thrown away, or its account disconnected),
 * because item_body rows cascade with their item.
 */
import { config } from '../config';
import { withWorkspace } from '../db/pool';
import { log } from '../lib/log';
import { MAX_FILE_TEXT, type ListedFile } from './file-kinds';
import { DRIVE_READABLE, canRead, readListed } from './files';
import { connectionById } from './tools';

export interface TextPass {
  /** Files whose words were read and kept. */
  read: number;
  /** Files that were tried and have no words to keep (refused, damaged, a kind that can't be opened); not tried again until they change. */
  skipped: number;
  /** Whether files are still waiting for a later pass. */
  more: boolean;
  /** Files asked of the app in this pass: one tool call each, and for OneDrive one download from Composio's store as well. */
  tried: number;
}

const OFFICE_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
];

/** The version of a file its words were read from: when it last changed, to the millisecond. */
const VERSION = `(extract(epoch from i.occurred_at) * 1000)::bigint::text`;

/** How many passes in a row a file may fail before it is set aside until it changes. */
export const TEXT_FAILURES_BEFORE_SETTING_ASIDE = 3;

/**
 * Which reader set a file aside. When the reader learns to read more (2: a Google Doc too long to come back whole is
 * read as exported plain text), a file an older one set aside gets its passes again, without waiting for it to change.
 */
export const TEXT_READER = '2';

export async function indexFileTexts(workspaceId: string, connectionId: string, opts: { max?: number } = {}): Promise<TextPass> {
  const out: TextPass = { read: 0, skipped: 0, more: false, tried: 0 };
  const conn = await connectionById(workspaceId, connectionId);
  if (!conn || conn.status !== 'active' || (conn.toolkit !== 'googledrive' && conn.toolkit !== 'one_drive')) return out;
  const max = Math.max(0, opts.max ?? config.fileText.perPass);
  const readable = conn.toolkit === 'googledrive' ? DRIVE_READABLE : OFFICE_TYPES;
  const due = await withWorkspace({ workspaceId }, async (tx) =>
    (
      await tx.query(
        `select i.id, i.external_id, i.subject, i.snippet, i.meta->>'mimeType' as mime, i.meta->>'driveId' as drive_id,
                case when i.meta->>'size' ~ '^[0-9]{1,15}$' then (i.meta->>'size')::bigint end as size, ${VERSION} as version
         from item i left join item_body b on b.item_id = i.id
         where i.workspace_id = $1 and i.connection_id = $2 and i.kind = 'file'
           and i.occurred_at > now() - make_interval(days => $3)
           and (i.meta->>'mimeType' = any($4::text[]) or ($6 and lower(i.subject) ~ '\\.(docx|xlsx|pptx)$'))
           and coalesce(case when i.meta->>'size' ~ '^[0-9]{1,15}$' then (i.meta->>'size')::bigint end, 0) <= $5
           and (b.item_id is null or b.version is distinct from ${VERSION}
                or (b.text = '' and i.meta ? 'textFailures' and coalesce(i.meta->>'textReader', '1') <> $8))
         order by i.occurred_at desc limit $7`,
        [workspaceId, connectionId, config.driveBackfillDays, readable, config.fileText.maxBytes, conn.toolkit === 'one_drive', max + 1, TEXT_READER],
      )
    ).rows,
  );
  out.more = due.length > max;
  for (const row of due.slice(0, max)) {
    const f: ListedFile = { connectionId, toolkit: conn.toolkit, id: row.external_id, name: row.subject ?? '', kind: row.snippet ?? 'File', mime: row.mime ?? '', size: row.size == null ? undefined : Number(row.size), driveId: row.drive_id ?? undefined };
    if (!canRead(f.toolkit, f.mime, f.name)) continue;
    out.tried++;
    let got;
    try {
      got = await readListed(workspaceId, f, 'sync');
    } catch (e) {
      const error = (e as Error).message;
      log.warn('file text could not be read', { workspaceId, connectionId, error });
      // A failure that may not be the file's own (the provider or the network) ends the pass, and the next one starts
      // again here. But a file that fails the same way three passes running is set aside until it changes, so one
      // file the provider won't hand over can't hold up every file after it.
      const failures = await withWorkspace({ workspaceId }, async (tx) =>
        Number(
          (
            await tx.query(
              `update item set meta = meta || jsonb_build_object('textFailedVersion', $3::text, 'textReader', $4::text, 'textFailures',
                 case when meta->>'textFailedVersion' = $3::text and coalesce(meta->>'textReader', '1') = $4::text then coalesce((meta->>'textFailures')::int, 0) + 1 else 1 end)
               where id = $1 and workspace_id = $2 returning (meta->>'textFailures')::int as n`,
              [row.id, workspaceId, row.version, TEXT_READER],
            )
          ).rows[0]?.n ?? 0,
        ),
      ).catch(() => 0);
      if (failures < TEXT_FAILURES_BEFORE_SETTING_ASIDE) {
        out.more = true;
        break;
      }
      got = { reason: `${f.toolkit === 'one_drive' ? 'OneDrive' : 'Drive'} would not hand over this file’s contents.` };
      log.warn('file text set aside', { workspaceId, connectionId, failures });
    }
    const text = 'text' in got ? got.text.replace(/\u0000/g, '').slice(0, MAX_FILE_TEXT) : '';
    const kept = await withWorkspace({ workspaceId }, async (tx) => {
      // Kept only while the file is still on the list and its account still connected.
      const { rowCount } = await tx.query(
        `insert into item_body (item_id, workspace_id, text, version, note)
         select i.id, i.workspace_id, $3, $4, $5 from item i join connection c on c.id = i.connection_id
         where i.id = $1 and i.workspace_id = $2 and c.status = 'active'
         on conflict (item_id) do update set text = excluded.text, version = excluded.version, note = excluded.note`,
        [row.id, workspaceId, text, row.version, 'reason' in got ? got.reason.slice(0, 300) : null],
      );
      return (rowCount ?? 0) > 0;
    }).catch(() => false);
    if (kept) {
      if ('text' in got) out.read++;
      else out.skipped++;
    }
  }
  return out;
}
