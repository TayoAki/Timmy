/* Small helpers shared by the Docs screens and editors. */
import type { ReactNode } from 'react';
import { NOW } from '../../data/mock';
import type { Block, DocBody, Folder, WEvent, WFile, WS } from '../../data/ws-types';
import { FILING_FOLDER } from '../../data/ws-mock';
import { fmtDate, fmtTime, dayDiff } from '../../lib/format';
import type { Action } from '../../state/store';
import { childFolders, folderLabel, pathOf } from '../../state/ws';

/** Right-panel section, the same look as the rest of the context panel. */
export function RpSection({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rp-section">
      <header className="rp-head">
        <h2 className="rp-title">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

export const openFile = (dispatch: (a: Action) => void, id: string) => dispatch({ type: 'navigate', route: { view: 'file', id } });

/** Files the Docs screens list: docs, sheets and slides that have a body, not shortcuts or attachments waiting to be filed. */
export const editableFiles = (ws: WS) =>
  Object.values(ws.files).filter(
    (f) => (f.kind === 'doc' || f.kind === 'sheet' || f.kind === 'slides') && !f.shortcutOf && f.folder !== FILING_FOLDER,
  );

export const byUpdated = (a: WFile, b: WFile) => b.updated.getTime() - a.updated.getTime();

/** Folder tree in display order, with depth for indenting. */
export const folderTree = (ws: WS) => {
  const out: { folder: Folder; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const f of childFolders(ws, parent)) {
      out.push({ folder: f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
};

export function FolderSelect({ ws, value, onChange, id }: { ws: WS; value: string; onChange: (id: string) => void; id?: string }) {
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {folderTree(ws).map(({ folder, depth }) => (
        <option key={folder.id} value={folder.id}>
          {'   '.repeat(depth)}
          {folderLabel(folder)}
        </option>
      ))}
    </select>
  );
}

/** Short location: the last two folders, e.g. "[02] Work › [10] Acme". */
export const shortPath = (ws: WS, folder: string) => {
  const p = pathOf(ws, folder);
  return (p.length > 2 ? p.slice(-2) : p).join(' › ');
};

/** The next time a meeting happens on or after now, following weekly repeats. */
export const nextOccurrence = (e: WEvent): Date | null => {
  if (e.end.getTime() >= NOW.getTime()) return e.start;
  if (e.recurring !== 'weekly') return null;
  const week = 7 * 24 * 60 * 60 * 1000;
  let t = e.start.getTime();
  while (t + (e.end.getTime() - e.start.getTime()) < NOW.getTime()) t += week;
  return new Date(t);
};

export const fmtWhen = (d: Date) => {
  const diff = dayDiff(d);
  const day = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return `${day}, ${fmtTime(d)}`;
};

/** Events a doc is the notes for: the doc names the event, or the invite links the doc. */
export const eventsForDoc = (ws: WS, docId: string) => {
  const body = ws.docs[docId];
  return Object.values(ws.events)
    .filter((e) => e.notesDoc === docId || body?.event === e.id)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
};

export interface MeetingDoc {
  file: WFile;
  body?: DocBody;
  events: WEvent[];
  next: Date | null;
  nextEvent?: WEvent;
}

/** Docs tied to calendar events, soonest next meeting first. */
export const meetingDocs = (ws: WS): MeetingDoc[] => {
  const ids = new Set<string>();
  for (const e of Object.values(ws.events)) if (e.notesDoc) ids.add(e.notesDoc);
  for (const d of Object.values(ws.docs)) if (d.event) ids.add(d.id);
  return [...ids]
    .map((id) => ws.files[id])
    .filter((f): f is WFile => !!f)
    .map((file) => {
      const events = eventsForDoc(ws, file.id);
      let next: Date | null = null;
      let nextEvent: WEvent | undefined;
      for (const e of events) {
        const n = nextOccurrence(e);
        if (n && (!next || n < next)) {
          next = n;
          nextEvent = e;
        }
      }
      return { file, body: ws.docs[file.id], events, next, nextEvent };
    })
    .sort((a, b) => (a.next?.getTime() ?? Infinity) - (b.next?.getTime() ?? Infinity));
};

/** Upcoming meetings you could link notes to. */
export const upcomingMeetings = (ws: WS) =>
  Object.values(ws.events)
    .filter((e) => e.kind === 'meeting' || e.kind === 'review')
    .filter((e) => nextOccurrence(e))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

export const eventLabel = (e: WEvent) => {
  const n = nextOccurrence(e) ?? e.start;
  return `${e.title} · ${fmtDate(n)}, ${fmtTime(n)}${e.recurring ? ' · weekly' : ''}`;
};

/** Docs whose linked tables read from this sheet. */
export const docsLinkingSheet = (ws: WS, sheetId: string) =>
  Object.values(ws.docs)
    .map((d) => ({ body: d, file: ws.files[d.id], blocks: d.blocks.filter((b): b is Extract<Block, { type: 'linked-table' }> => b.type === 'linked-table' && b.sheet === sheetId) }))
    .filter((x): x is { body: DocBody; file: WFile; blocks: Extract<Block, { type: 'linked-table' }>[] } => !!x.file && x.blocks.length > 0);

/** Docs that link to this file with a file chip. */
export const docsLinkingFile = (ws: WS, fileId: string) =>
  Object.values(ws.docs)
    .filter((d) => d.id !== fileId && d.blocks.some((b) => b.type === 'file' && b.file === fileId))
    .map((d) => ws.files[d.id])
    .filter((f): f is WFile => !!f);

/** "6–9", "3, 5–7": slide numbers as short ranges. */
export const ranges = (nums: number[]) => {
  const sorted = [...nums].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : `${sorted[i]}`);
    i = j + 1;
  }
  return parts.join(', ');
};
