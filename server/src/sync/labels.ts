/**
 * Where a thread sits in Timmy, written back to the mailbox. Follow Up, Waiting
 * and Read Through become Gmail labels and the thread stays in Gmail's inbox;
 * Archived takes it out of the inbox; back to the inbox clears Timmy's labels.
 * In Outlook the same three names are categories, and Archived is the Archive folder (see outlook.ts).
 *
 * This is a change to the person's own mailbox that nobody else sees. It still
 * goes through the Action gateway as a `mail.modify` effect, like every write.
 */
import type { Box, Thread } from '../../../src/data/types';
import type { Proposal } from '../gateway/gateway';
import { withWorkspace } from '../db/pool';
import { callTool, type ConnectionRow, type Phase } from './tools';

/** Gmail label names can't contain "/" or ",", so the three are plain names that sort together. */
export const LABEL_NAMES = { 'follow-up': 'Timmy Follow Up', waiting: 'Timmy Waiting', 'read-through': 'Timmy Read Through' } as const;
export type Labelled = keyof typeof LABEL_NAMES;
export type LabelIds = Record<Labelled, string>;

// Own keys only: with `in`, a word like "constructor" would pass as a place.
const isLabelled = (box: Box): box is Labelled => Object.hasOwn(LABEL_NAMES, box);

export const BOX_WORDS: Record<Box, string> = { inbox: 'back to the inbox', 'follow-up': 'under Follow Up', waiting: 'under Waiting', 'read-through': 'under Read Through', archived: 'to the archive' };
export const isBox = (v: unknown): v is Box => typeof v === 'string' && Object.hasOwn(BOX_WORDS, v);

/**
 * What the gateway is asked when a synced thread is filed in `box`, whether a person moved it or Timmy proposes to.
 * Null when the thread isn't in a connected mailbox, so there is nothing to write.
 */
export function filingProposal(t: Thread, box: Box): Pick<Proposal, 'kind' | 'payload' | 'preview' | 'title' | 'target'> | null {
  if (!t.ext?.threadKey || !t.ext.connectionId) return null;
  return {
    kind: 'mail.modify',
    payload: { connectionId: t.ext.connectionId, threadKey: t.ext.threadKey, box, threadId: t.id },
    preview: { lines: [`“${t.subject}” ${BOX_WORDS[box]}`] },
    title: `File “${t.subject}” ${BOX_WORDS[box]} in ${t.ext.app === 'outlook' ? 'Outlook' : 'Gmail'}`,
    target: t.ext.threadKey,
  };
}

/** Timmy's labels could not be found or made. Nothing was changed on any thread. */
export class LabelsUnavailable extends Error {}

/** The label changes that put a thread in `box`. Removing a label the thread doesn't have is harmless. */
export function labelPlan(box: Box, ids: LabelIds): { add: string[]; remove: string[] } {
  const timmy = Object.values(ids);
  if (box === 'archived') return { add: [], remove: ['INBOX', ...timmy] };
  if (isLabelled(box)) return { add: ['INBOX', ids[box]], remove: timmy.filter((id) => id !== ids[box]) };
  return { add: ['INBOX'], remove: timmy };
}

/**
 * The ids of Timmy's three labels in this mailbox, made on first use and
 * remembered on the connection. If a label was deleted in Gmail it is made again.
 */
export async function timmyLabels(workspaceId: string, conn: ConnectionRow, refresh = false): Promise<LabelIds> {
  const known = conn.meta.labels as Partial<LabelIds> | undefined;
  if (!refresh && known && Object.keys(LABEL_NAMES).every((k) => typeof known[k as Labelled] === 'string')) return known as LabelIds;

  const list = async () => {
    const listed = await callTool(workspaceId, conn.id, 'GMAIL_LIST_LABELS', {}, 'send');
    if (!listed.successful) throw new LabelsUnavailable(listed.error ?? 'could not list the mailbox’s labels');
    return new Map(((listed.data.labels ?? []) as { id: string; name: string }[]).map((l) => [l.name, l.id]));
  };
  let existing = await list();
  const ids = {} as LabelIds;
  for (const [box, name] of Object.entries(LABEL_NAMES) as [Labelled, string][]) {
    let id = existing.get(name);
    if (!id) {
      const made = await callTool(workspaceId, conn.id, 'GMAIL_CREATE_LABEL', { label_name: name, label_list_visibility: 'labelShow', message_list_visibility: 'show' }, 'send');
      id = ((made.data.response_data ?? made.data) as { id?: string }).id;
      if (!made.successful || !id) {
        // Two filings can reach a new mailbox together, and the other one may have just made this label: look again.
        existing = await list();
        id = existing.get(name);
      }
      if (!id) throw new LabelsUnavailable(made.error ?? `could not create the label ${name}`);
    }
    ids[box] = id;
  }
  await withWorkspace({ workspaceId }, (tx) => tx.query(`update connection set meta = meta || jsonb_build_object('labels', $2::jsonb), updated_at = now() where id = $1`, [conn.id, JSON.stringify(ids)]));
  return ids;
}

/**
 * The ids of whichever of Timmy's three labels exist in this mailbox, without making any: finding out what the
 * person did in Gmail must never write to Gmail. The ids Timmy remembered when it made the labels are used when
 * it has all three. Otherwise (a mailbox Timmy has not filed anything in since it was connected, which may still
 * carry the labels from an earlier connection) the mailbox's labels are listed, at most once a day, and what was
 * found is remembered beside them.
 */
export async function timmyLabelsIfAny(workspaceId: string, conn: ConnectionRow, phase: Phase): Promise<Partial<LabelIds>> {
  const known = conn.meta.labels as Partial<LabelIds> | undefined;
  if (known && Object.keys(LABEL_NAMES).every((k) => typeof known[k as Labelled] === 'string')) return known;
  const read = conn.meta.labelsRead as { at?: string; ids?: Partial<LabelIds> } | undefined;
  if (read?.at && read.ids && Date.now() - new Date(read.at).getTime() < 86400_000) return read.ids;
  const listed = await callTool(workspaceId, conn.id, 'GMAIL_LIST_LABELS', {}, phase);
  // Not knowing is not the same as there being none: a failed lookup is tried again at the next look.
  if (!listed.successful) return read?.ids ?? {};
  const byName = new Map(((listed.data.labels ?? []) as { id: string; name: string }[]).map((l) => [l.name, l.id]));
  const ids: Partial<LabelIds> = {};
  for (const [box, name] of Object.entries(LABEL_NAMES) as [Labelled, string][]) if (byName.has(name)) ids[box] = byName.get(name)!;
  await withWorkspace({ workspaceId }, (tx) => tx.query(`update connection set meta = meta || jsonb_build_object('labelsRead', $2::jsonb), updated_at = now() where id = $1`, [conn.id, JSON.stringify({ at: new Date().toISOString(), ids })]));
  return ids;
}
