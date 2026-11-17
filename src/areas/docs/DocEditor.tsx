/*
 * A Timmy doc: the template and meeting chips, "Email the notes", and the
 * Notion-style block editor. Docs are saved as blocks, which Timmy reads for
 * drafts, summaries and exports.
 */
import { CalendarClock, CalendarPlus, Mail, Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { NOW, PEOPLE } from '../../data/mock';
import type { Block, DocBody, WFile, WS } from '../../data/ws-types';
import { FILING_FOLDER } from '../../data/ws-mock';
import { fmtDate } from '../../lib/format';
import { listNumbers, numberLabel, textOf, timmyLines } from '../../lib/blocks';
import { useStore, ws } from '../../state/store';
import { isoDay, patch, put, uid, type WsOptions } from '../../state/ws';
import { FilePick } from './FilePick';
import { markShown } from './LinkedTable';
import { DOC_KEYWORDS, parseName } from './naming';
import { eventsForDoc, fmtWhen, nextOccurrence, openFile } from './shared';
import { bid, TEMPLATE_LABEL, templateDef, keyFor } from './templates';
import { insertAfter } from './editor/extensions';
import { NotionEditor, type EditorHandle } from './editor/NotionEditor';
import { fromDoc } from './editor/convert';
import { timmyWrites } from './editor/presence';
import { summarize } from './summary';
import type { Written } from './editor/presence';
import { api } from '../../live/api';
import { isLive } from '../../live/clock';

export { BlockText } from './BlockText';

type TableBlockT = Extract<Block, { type: 'table' }>;

/* ───────────── Email the notes ───────────── */

const blockLines = (W: WS, b: Block, n = 0): string[] => {
  const pad = '  '.repeat(b.indent ?? 0);
  switch (b.type) {
    case 'todo':
      return b.text.trim() ? [`${pad}- ${b.checked ? '(done) ' : ''}${b.text.trim()}`] : [];
    case 'bullet':
    case 'toggle':
      return b.text.trim() ? [`${pad}- ${b.text.trim()}`] : [];
    case 'numbered':
      return b.text.trim() ? [`${pad}${numberLabel(n || 1, b.indent ?? 0)} ${b.text.trim()}`] : [];
    case 'quote':
      return b.text.trim() ? [`${pad}“${b.text.trim()}”`] : [];
    case 'table':
      return b.rows.filter((r) => r.some((c) => c.trim())).map((r) => `- ${r.filter((c) => c.trim()).join(' · ')}`);
    case 'file':
      return W.files[b.file] ? [`- ${W.files[b.file]!.name}`] : [];
    case 'page':
      return W.files[b.file] && !W.files[b.file]!.trashed ? [`- ${W.files[b.file]!.name}`] : [];
    case 'linked-table':
      return W.files[b.sheet] ? [`(Figures from ${W.files[b.sheet]!.name})`] : [];
    case 'divider':
    case 'image':
      return [];
    default:
      return textOf(b).trim() ? [pad + textOf(b).trim()] : [];
  }
};

const sectionsOf = (blocks: Block[]) => {
  const nums = listNumbers(blocks);
  const out: { title: string; items: { b: Block; n: number }[] }[] = [{ title: '', items: [] }];
  blocks.forEach((b, i) => {
    if (b.type === 'h1' || b.type === 'h2' || b.type === 'h3') out.push({ title: b.text.trim(), items: [] });
    else out[out.length - 1]!.items.push({ b, n: nums[i]! });
  });
  return out;
};

/** Outcome and action items first, then the details: the order busy readers need. */
export const summaryEmail = (W: WS, file: WFile, body: DocBody) => {
  const secs = sectionsOf(body.blocks);
  const find = (...names: string[]) => secs.find((s) => names.some((n) => s.title.toLowerCase() === n.toLowerCase()));
  const lines = (s?: { items: { b: Block; n: number }[] }) => (s ? s.items.flatMap(({ b, n }) => blockLines(W, b, n)) : []);
  const recap = body.template === 'project-recap' || !!find('What happened');
  const subject = parseName(file.name, DOC_KEYWORDS).subject || file.name;

  const outcomeSec = recap ? find('What happened', 'Outcome') : find('Decisions');
  const actionSec = find('Next steps', 'Action items');
  const outcome = lines(outcomeSec);
  const actions = actionSec ? lines(actionSec) : body.blocks.filter((b) => b.type === 'todo').flatMap((b) => blockLines(W, b));
  const skip = new Set([outcomeSec, actionSec]);
  const details = secs.filter((s) => !skip.has(s) && s.title !== 'Files' && s.title !== 'Files for this meeting' && lines(s).length);

  const parts = [
    'Hi all,',
    recap ? `Here’s the recap for ${subject}.` : `Notes from ${subject}.`,
    `${recap ? 'Outcome' : 'Decisions'}:\n${outcome.length ? outcome.join('\n') : '- (add the outcome)'}`,
    `Action items:\n${actions.length ? actions.join('\n') : '- None'}`,
    ...(details.length ? ['Details', ...details.map((s) => `${s.title ? `${s.title}\n` : ''}${lines(s).join('\n')}`)] : []),
    `The full ${recap ? 'recap' : 'notes'}: “${file.name}”`,
    `Thanks,\n${PEOPLE.me!.name.split(' ')[0]}`,
  ];
  return {
    to: [] as string[],
    subject: recap ? `Recap: ${subject}` : `Notes: ${subject}`,
    body: parts.join('\n\n'),
    project: file.project,
  };
};

/* ───────────── Editor ───────────── */

export function DocEditor({ file, body }: { file: WFile; body: DocBody }) {
  const { state, dispatch } = useStore();
  const W = state.ws;
  const blocks = body.blocks;
  const handle = useRef<EditorHandle>({ editor: null, flush: () => undefined });
  const [pick, setPick] = useState<null | { kind: 'sheet' | 'file'; after: number | null }>(null);
  const readOnly = !!file.trashed;

  /** `base`: the lines Timmy added that the copy of the page this save was made from had (see lib/blocks.ts). */
  const save = (next: Block[], opts?: WsOptions, base?: string[]) =>
    dispatch(ws([{ ...patch('docs', body.id, { blocks: next }), ...(base ? { base } : {}) }, patch('files', file.id, { updated: NOW })], opts));

  /** Change the blocks from outside the editor: save what's typed first. */
  const change = (f: (bs: Block[]) => Block[], opts?: WsOptions) => {
    handle.current.flush();
    const cur = (state.ws.docs[body.id] ?? body).blocks;
    save(f(cur), opts, timmyLines(cur));
  };

  const insertNode = (after: number | null, node: Record<string, unknown>) => {
    const ed = handle.current.editor;
    if (!ed) return;
    insertAfter(ed, after, [{ ...node, attrs: { ...(node.attrs as object), bid: bid() } }]);
  };

  /** A page inside this one: create it, link it here, then open it. */
  const newPage = (after: number | null) => {
    const ed = handle.current.editor;
    if (!ed) return;
    const id = uid('doc');
    const child: WFile = { id, name: 'Untitled', kind: 'doc', folder: file.folder, updated: NOW, owner: 'me', project: file.project, parent: file.id };
    dispatch(
      ws([put('files', child), put('docs', { id, template: 'blank', blocks: [{ id: bid(), type: 'p', text: '' }] })], {
        log: `Created a page inside “${file.name}”`,
      }),
    );
    insertAfter(ed, after, [{ type: 'pageLink', attrs: { file: id, bid: bid() } }]);
    handle.current.flush();
    dispatch({ type: 'navigate', route: { view: 'file', id } });
  };

  /** Timmy reads the page and types a summary where you asked for it. */
  const timmySummary = (after: number | null) => {
    const ed = handle.current.editor;
    if (!ed) return;
    const onPage = fromDoc(ed.getJSON());
    const nothing = () => dispatch({ type: 'toast', text: 'There’s nothing to summarize yet. Add some notes first.' });
    const type = (items: Written[]) => timmyWrites(ed, file.id, after, items, () => dispatch({ type: 'toast', text: 'Timmy added a summary. Ctrl+Z takes it out.' }));
    // Lines picked from the page itself: the preview's summary, and the stand-in when the model can't be reached.
    const picked = () => {
      const items = summarize(onPage, (id) => state.ws.files[id]?.name);
      if (items.length) type(items);
      else nothing();
    };
    if (!isLive()) return picked();
    // On a real workspace the model writes the summary from what is on screen, and the server keeps only lines the page backs.
    void api.summarizePage(file.id, onPage).then(
      (out) => {
        if (ed.isDestroyed) return;
        if (!out.lines.length) return picked();
        type([{ type: 'callout', attrs: { icon: '✨' }, text: 'Timmy’s summary, from what’s on this page' }, ...out.lines.map((l) => ({ type: 'bullet', attrs: { indent: 0 }, text: l.text }))]);
      },
      () => !ed.isDestroyed && picked(),
    );
  };

  const addTodayRow = () => {
    const today = fmtDate(NOW);
    const t = blocks.find((b): b is TableBlockT => b.type === 'table');
    if (!t) return;
    if (t.rows.some((r) => r[0]?.trim() === today)) {
      dispatch({ type: 'toast', text: 'Today’s row is already in the table' });
      return;
    }
    change((bs) => bs.map((b) => (b.id === t.id && b.type === 'table' ? { ...b, rows: [[today, ...b.columns.slice(1).map(() => '')], ...b.rows] } : b)), { toast: 'Added today’s row' });
  };

  const firstTable = blocks.find((b): b is TableBlockT => b.type === 'table');
  const events = eventsForDoc(W, file.id);
  const nextEv = events.map((e) => ({ e, n: nextOccurrence(e) })).find((x) => x.n);
  const canEmail = body.template === 'project-recap' || body.template === 'team-meeting' || blocks.some((b) => b.type === 'h2' && /what happened|decisions/i.test(b.text));
  const isRecap = body.template === 'project-recap' || blocks.some((b) => b.type === 'h2' && /what happened/i.test(b.text));
  const templateKey = keyFor(body.template);
  const TemplateIcon = templateDef(templateKey).icon;
  const hasChips = body.template !== 'blank' || nextEv;
  const hasActions = (body.template === 'one-on-one' && firstTable) || canEmail;

  return (
    <div className="doc-editor">
      {(hasChips || hasActions) && (
        <div className="doc-toolbar">
          <div className="doc-toolbar-info">
            {body.template !== 'blank' && (
              <span className="chip">
                <TemplateIcon size={12} aria-hidden />
                {TEMPLATE_LABEL[body.template]}
              </span>
            )}
            {nextEv && (
              <button
                className="chip doc-chip-btn"
                onClick={() => dispatch({ type: 'navigate', route: { view: 'calendar', tab: 'day', date: isoDay(nextEv.n!) } })}
                title="Open the meeting in the calendar"
              >
                <CalendarClock size={12} aria-hidden />
                Linked from {nextEv.e.title} · {fmtWhen(nextEv.n!)}
              </button>
            )}
          </div>
          <div className="doc-toolbar-actions">
            {body.template === 'one-on-one' && firstTable && !readOnly && (
              <button className="btn btn-sm" onClick={addTodayRow}>
                <CalendarPlus size={14} aria-hidden />
                Add today’s row
              </button>
            )}
            {canEmail && (
              <button
                className="btn btn-sm"
                onClick={() => {
                  handle.current.flush();
                  const latest = state.ws.docs[body.id] ?? body;
                  dispatch({ type: 'compose', draft: summaryEmail(W, file, latest) });
                }}
              >
                <Mail size={14} aria-hidden />
                {isRecap ? 'Email this recap' : 'Email the notes'}
              </button>
            )}
          </div>
        </div>
      )}

      <NotionEditor
        key={file.id}
        docId={file.id}
        blocks={blocks}
        readOnly={readOnly}
        handle={handle}
        onSave={(next, base) => save(next, undefined, base)}
        toast={(text) => dispatch({ type: 'toast', text })}
        actions={{
          pickSheet: (after) => setPick({ kind: 'sheet', after }),
          pickFile: (after) => setPick({ kind: 'file', after }),
          newPage,
          timmySummary,
        }}
        onRemoteBlocks={(next) => dispatch(ws([patch('docs', body.id, { blocks: next }), patch('files', file.id, { updated: NOW })]))}
        onOpenBlock={(type, attrs) =>
          type === 'fileLink'
            ? { label: 'Open file', run: () => openFile(dispatch, attrs.file as string) }
            : type === 'linkedTable'
              ? { label: 'Open sheet', run: () => openFile(dispatch, attrs.sheet as string) }
              : type === 'pageLink'
                ? { label: 'Open page', run: () => openFile(dispatch, attrs.file as string) }
                : undefined
        }
      />

      {!readOnly && (
        <div className="doc-tail">
          <button
            className="btn btn-xs btn-ghost"
            onClick={() => {
              const ed = handle.current.editor;
              if (ed) insertAfter(ed, null, [{ type: 'paragraph', attrs: { bid: bid() }, content: [{ type: 'text', text: '/' }] }]);
            }}
          >
            <Plus size={13} aria-hidden />
            Add block
          </button>
          <span className="muted doc-tail-hint">Type / for blocks. Select text to format it. Drag ⋮⋮ to move a block.</span>
        </div>
      )}

      <FilePick
        open={pick?.kind === 'sheet'}
        onClose={() => setPick(null)}
        title="Add a linked table"
        description="Shows the sheet’s current figures in this doc and refreshes whenever the sheet changes."
        filter={(f) => f.kind === 'sheet' && !!W.sheets[f.id]}
        empty="No sheets match."
        onPick={(f) => {
          const after = pick!.after;
          setPick(null);
          if (W.sheets[f.id]) markShown(W.sheets[f.id]!);
          insertNode(after, { type: 'linkedTable', attrs: { sheet: f.id } });
          dispatch({ type: 'toast', text: `Linked table from “${f.name}” added` });
        }}
      />
      <FilePick
        open={pick?.kind === 'file'}
        onClose={() => setPick(null)}
        title="Link a file"
        description="Link the files people will need next, like the tracker or the deck."
        filter={(f) => f.id !== file.id && f.folder !== FILING_FOLDER && !f.shortcutOf && !f.trashed}
        onPick={(f) => {
          const after = pick!.after;
          setPick(null);
          insertNode(after, { type: 'fileLink', attrs: { file: f.id } });
        }}
      />
    </div>
  );
}
