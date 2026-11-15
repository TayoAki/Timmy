/*
 * The doc editor. Each block is edited in place: Enter adds a block, Backspace
 * on an empty block removes it, and "- ", "[] ", "## " turn a line into a
 * bullet, a to-do or a heading. Tables are typed into; linked tables show a
 * sheet's live values; file blocks open the file they point to.
 */
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  CalendarClock,
  CalendarPlus,
  Check,
  Columns3,
  FileSpreadsheet,
  Heading2,
  Heading3,
  Link2,
  List,
  ListTodo,
  Mail,
  Pilcrow,
  Plus,
  Table2,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type TextareaHTMLAttributes } from 'react';
import { DocIcon } from '../../components/DocBits';
import { Menu, type MenuItem } from '../../components/kit';
import { NOW, PEOPLE } from '../../data/mock';
import type { Block, DocBody, WFile, WS } from '../../data/ws-types';
import { FILING_FOLDER } from '../../data/ws-mock';
import { fmtDate } from '../../lib/format';
import { useStore, ws, type Action } from '../../state/store';
import { isoDay, patch, type WsOptions } from '../../state/ws';
import { FilePick } from './FilePick';
import { LinkedTable } from './LinkedTable';
import { DOC_KEYWORDS, parseName } from './naming';
import { eventsForDoc, fmtWhen, nextOccurrence, openFile, shortPath } from './shared';
import { bid, TEMPLATE_LABEL, templateDef, keyFor } from './templates';

type TextType = 'h2' | 'h3' | 'p' | 'bullet' | 'todo';
type TextBlock = Extract<Block, { type: 'h2' | 'h3' | 'p' | 'bullet' }> | Extract<Block, { type: 'todo' }>;
type TableBlockT = Extract<Block, { type: 'table' }>;

const TEXT_TYPES: TextType[] = ['h2', 'h3', 'p', 'bullet', 'todo'];
const isText = (b: Block): b is TextBlock => (TEXT_TYPES as string[]).includes(b.type);

const TYPE_META: Record<TextType, { label: string; icon: LucideIcon; placeholder: string }> = {
  h2: { label: 'Heading', icon: Heading2, placeholder: 'Heading' },
  h3: { label: 'Subheading', icon: Heading3, placeholder: 'Subheading' },
  p: { label: 'Text', icon: Pilcrow, placeholder: 'Type, or start a line with - for a bullet, [] for a to-do, ## for a heading' },
  bullet: { label: 'Bullet', icon: List, placeholder: 'List item' },
  todo: { label: 'To-do', icon: ListTodo, placeholder: 'To-do' },
};

const convert = (b: TextBlock, type: TextType): Block =>
  type === 'todo' ? { id: b.id, type, text: b.text, checked: b.type === 'todo' ? b.checked : false } : { id: b.id, type, text: b.text };

const make = (type: TextType, text = ''): TextBlock => (type === 'todo' ? { id: bid(), type, text, checked: false } : { id: bid(), type, text });

/* ───────────── Autosizing textarea ───────────── */

export const BlockText = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function BlockText(props, ref) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const fit = () => {
    const el = inner.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(fit, [props.value]);
  useEffect(() => {
    const el = inner.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== w) {
        w = el.clientWidth;
        fit();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <textarea
      rows={1}
      spellCheck
      {...props}
      ref={(el) => {
        inner.current = el;
        if (typeof ref === 'function') ref(el);
        else if (ref) ref.current = el;
      }}
    />
  );
});

/* ───────────── Email the notes ───────────── */

const blockLines = (W: WS, b: Block): string[] => {
  switch (b.type) {
    case 'todo':
      return b.text.trim() ? [`- ${b.checked ? '(done) ' : ''}${b.text.trim()}`] : [];
    case 'bullet':
      return b.text.trim() ? [`- ${b.text.trim()}`] : [];
    case 'table':
      return b.rows.filter((r) => r.some((c) => c.trim())).map((r) => `- ${r.filter((c) => c.trim()).join(' · ')}`);
    case 'file':
      return W.files[b.file] ? [`- ${W.files[b.file]!.name}`] : [];
    case 'linked-table':
      return W.files[b.sheet] ? [`(Figures from ${W.files[b.sheet]!.name})`] : [];
    default:
      return b.text.trim() ? [b.text.trim()] : [];
  }
};

const sectionsOf = (blocks: Block[]) => {
  const out: { title: string; items: Block[] }[] = [{ title: '', items: [] }];
  for (const b of blocks) {
    if (b.type === 'h2' || b.type === 'h3') out.push({ title: b.text.trim(), items: [] });
    else out[out.length - 1]!.items.push(b);
  }
  return out;
};

/** Outcome and action items first, then the details: the order busy readers need. */
export const summaryEmail = (W: WS, file: WFile, body: DocBody) => {
  const secs = sectionsOf(body.blocks);
  const find = (...names: string[]) => secs.find((s) => names.some((n) => s.title.toLowerCase() === n.toLowerCase()));
  const lines = (s?: { items: Block[] }) => (s ? s.items.flatMap((b) => blockLines(W, b)) : []);
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
  const refs = useRef(new Map<string, HTMLTextAreaElement>());
  const pending = useRef<{ id: string; pos: number | 'end' } | null>(null);
  const lastFocus = useRef<string | null>(null);
  const [pick, setPick] = useState<null | { kind: 'sheet' | 'file'; where: 'cursor' | 'end' }>(null);

  useLayoutEffect(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    const el = refs.current.get(p.id);
    if (!el) return;
    el.focus();
    const pos = p.pos === 'end' ? el.value.length : p.pos;
    el.setSelectionRange(pos, pos);
  });

  const register = (key: string) => (el: HTMLTextAreaElement | null) => {
    if (el) refs.current.set(key, el);
    else refs.current.delete(key);
  };
  const focusLater = (id: string, pos: number | 'end') => (pending.current = { id, pos });
  const focusNow = (id: string, pos: number | 'end') => {
    const el = refs.current.get(id);
    if (!el) return;
    el.focus();
    const p = pos === 'end' ? el.value.length : pos;
    el.setSelectionRange(p, p);
  };

  const save = (next: Block[], opts?: WsOptions) => dispatch(ws([patch('docs', body.id, { blocks: next }), patch('files', file.id, { updated: NOW })], opts));
  const replace = (id: string, nb: Block) => blocks.map((b) => (b.id === id ? nb : b));
  const setBlock = (id: string, change: Partial<Block>) => save(blocks.map((b) => (b.id === id ? ({ ...b, ...change } as Block) : b)));

  const insert = (add: Block[], where: 'cursor' | 'end') => {
    const at = where === 'cursor' && lastFocus.current ? blocks.findIndex((b) => b.id === lastFocus.current) : -1;
    const next = [...blocks];
    const last = blocks[blocks.length - 1];
    // Fill an empty last line rather than leaving it behind.
    if (at < 0 && last && last.type === 'p' && !last.text && blocks.length > 1) next.pop();
    const tail = isText(add[add.length - 1]!) ? [] : [make('p')];
    next.splice(at >= 0 ? at + 1 : next.length, 0, ...add, ...(at < 0 ? tail : []));
    const first = add[0]!;
    if (isText(first)) focusLater(first.id, 0);
    else if (first.type === 'table') focusLater(`${first.id}:h:0`, 'end');
    save(next);
  };

  const addText = (type: TextType, where: 'cursor' | 'end') => insert([make(type)], where);
  const addTable = (where: 'cursor' | 'end') =>
    insert([{ id: bid(), type: 'table', columns: ['Topic', 'Owner', 'Notes'], rows: [['', '', ''], ['', '', '']] }], where);

  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[i], next[j]] = [next[j]!, next[i]!];
    save(next);
  };
  const removeBlock = (b: Block) => save(blocks.length > 1 ? blocks.filter((x) => x.id !== b.id) : [make('p')], { toast: 'Block removed', undo: true });

  /* ── text ── */

  const onText = (b: TextBlock, value: string) => {
    if (b.type === 'p') {
      const m = value.match(/^(- |\* |\[ ?\] |\[x\] |### |## |# )/i);
      if (m) {
        const tok = m[1]!.toLowerCase();
        const rest = value.slice(m[0].length);
        const nb: Block =
          tok === '- ' || tok === '* '
            ? { id: b.id, type: 'bullet', text: rest }
            : tok.startsWith('[x')
              ? { id: b.id, type: 'todo', text: rest, checked: true }
              : tok.startsWith('[')
                ? { id: b.id, type: 'todo', text: rest, checked: false }
                : tok === '### '
                  ? { id: b.id, type: 'h3', text: rest }
                  : { id: b.id, type: 'h2', text: rest };
        focusLater(b.id, 0);
        save(replace(b.id, nb));
        return;
      }
    }
    setBlock(b.id, { text: value });
  };

  const prevText = (i: number) => {
    for (let k = i - 1; k >= 0; k--) if (isText(blocks[k]!)) return blocks[k] as TextBlock;
    return undefined;
  };
  const nextText = (i: number) => {
    for (let k = i + 1; k < blocks.length; k++) if (isText(blocks[k]!)) return blocks[k] as TextBlock;
    return undefined;
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>, b: TextBlock, i: number) => {
    if (e.nativeEvent.isComposing) return;
    const el = e.currentTarget;
    const s = el.selectionStart;
    const en = el.selectionEnd;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if ((b.type === 'bullet' || b.type === 'todo') && b.text === '') {
        focusLater(b.id, 0);
        save(replace(b.id, convert(b, 'p')));
        return;
      }
      const type: TextType = b.type === 'bullet' || b.type === 'todo' ? b.type : 'p';
      const nb = make(type, b.text.slice(en));
      const next = [...blocks];
      next[i] = { ...b, text: b.text.slice(0, s) };
      next.splice(i + 1, 0, nb);
      focusLater(nb.id, 0);
      save(next);
      return;
    }
    if (e.key === 'Backspace' && s === 0 && en === 0) {
      if (b.type !== 'p') {
        e.preventDefault();
        focusLater(b.id, 0);
        save(replace(b.id, convert(b, 'p')));
        return;
      }
      const prev = blocks[i - 1];
      if (b.text === '' && blocks.length > 1) {
        e.preventDefault();
        const target = prevText(i) ?? nextText(i);
        if (target) focusLater(target.id, target === prevText(i) ? 'end' : 0);
        save(blocks.filter((x) => x.id !== b.id));
        return;
      }
      if (prev && isText(prev)) {
        e.preventDefault();
        focusLater(prev.id, prev.text.length);
        save(blocks.filter((x) => x.id !== b.id).map((x) => (x.id === prev.id ? ({ ...prev, text: prev.text + b.text } as Block) : x)));
      }
      return;
    }
    if (e.key === 'ArrowUp' && s === 0 && en === 0) {
      const p = prevText(i);
      if (p) {
        e.preventDefault();
        focusNow(p.id, 'end');
      }
    } else if (e.key === 'ArrowDown' && s === el.value.length) {
      const n = nextText(i);
      if (n) {
        e.preventDefault();
        focusNow(n.id, 0);
      }
    }
  };

  /* ── tables ── */

  const setTable = (b: TableBlockT, change: Partial<TableBlockT>) => setBlock(b.id, change);
  const datedTable = (b: TableBlockT) => b.columns[0]?.trim().toLowerCase() === 'date';

  const addTodayRow = (b: TableBlockT) => {
    const today = fmtDate(NOW);
    const at = b.rows.findIndex((r) => r[0]?.trim() === today);
    if (at >= 0) {
      dispatch({ type: 'toast', text: 'Today’s row is already in the table' });
      focusNow(`${b.id}:${at}:1`, 'end');
      return;
    }
    focusLater(`${b.id}:0:1`, 0);
    setTable(b, { rows: [[today, ...b.columns.slice(1).map(() => '')], ...b.rows] });
  };

  const addRow = (b: TableBlockT) => {
    if (datedTable(b)) return addTodayRow(b);
    focusLater(`${b.id}:${b.rows.length}:0`, 0);
    setTable(b, { rows: [...b.rows, b.columns.map(() => '')] });
  };

  const addColumn = (b: TableBlockT) => {
    focusLater(`${b.id}:h:${b.columns.length}`, 'end');
    setTable(b, { columns: [...b.columns, `Column ${b.columns.length + 1}`], rows: b.rows.map((r) => [...r, '']) });
  };

  const removeColumn = (b: TableBlockT, j: number) =>
    save(replace(b.id, { ...b, columns: b.columns.filter((_, k) => k !== j), rows: b.rows.map((r) => r.filter((_, k) => k !== j)) }), {
      toast: `Column “${b.columns[j]}” removed`,
      undo: true,
    });

  const firstTable = blocks.find((b): b is TableBlockT => b.type === 'table');
  const events = eventsForDoc(W, file.id);
  const nextEv = events.map((e) => ({ e, n: nextOccurrence(e) })).find((x) => x.n);
  const canEmail = body.template === 'project-recap' || body.template === 'team-meeting' || blocks.some((b) => b.type === 'h2' && /what happened|decisions/i.test(b.text));
  const isRecap = body.template === 'project-recap' || blocks.some((b) => b.type === 'h2' && /what happened/i.test(b.text));
  const templateKey = keyFor(body.template);
  const TemplateIcon = templateDef(templateKey).icon;

  const addMenu = (where: 'cursor' | 'end'): MenuItem[] => [
    ...(['h2', 'h3', 'p', 'bullet', 'todo'] as TextType[]).map((t) => ({ label: TYPE_META[t].label, icon: TYPE_META[t].icon, onSelect: () => addText(t, where) })),
    { label: 'Table', icon: Table2, onSelect: () => addTable(where) },
    { label: 'Linked table from a sheet', icon: FileSpreadsheet, onSelect: () => setPick({ kind: 'sheet', where }) },
    { label: 'Link a file', icon: Link2, onSelect: () => setPick({ kind: 'file', where }) },
  ];

  const blockMenu = (b: Block, i: number): MenuItem[] => {
    const moves: MenuItem[] = [
      { label: 'Move up', icon: ArrowUp, onSelect: () => move(i, -1), disabled: i === 0 },
      { label: 'Move down', icon: ArrowDown, onSelect: () => move(i, 1), disabled: i === blocks.length - 1 },
    ];
    if (isText(b)) {
      return [
        ...TEXT_TYPES.filter((t) => t !== b.type).map((t) => ({ label: `Turn into ${TYPE_META[t].label.toLowerCase()}`, icon: TYPE_META[t].icon, onSelect: () => save(replace(b.id, convert(b, t))) })),
        ...moves,
        { label: 'Delete', icon: Trash2, danger: true, onSelect: () => removeBlock(b) },
      ];
    }
    if (b.type === 'linked-table') return [{ label: 'Open sheet', icon: ArrowUpRight, onSelect: () => openFile(dispatch, b.sheet) }, ...moves, { label: 'Remove linked table', icon: Trash2, danger: true, onSelect: () => removeBlock(b) }];
    if (b.type === 'file') return [{ label: 'Open file', icon: ArrowUpRight, onSelect: () => openFile(dispatch, b.file) }, ...moves, { label: 'Remove link', icon: Trash2, danger: true, onSelect: () => removeBlock(b) }];
    return [
      { label: 'Add row', icon: Plus, onSelect: () => addRow(b as TableBlockT) },
      { label: 'Add column', icon: Columns3, onSelect: () => addColumn(b as TableBlockT) },
      ...moves,
      { label: 'Delete table', icon: Trash2, danger: true, onSelect: () => removeBlock(b) },
    ];
  };

  return (
    <div className="doc-editor">
      <div className="doc-toolbar">
        <div className="doc-toolbar-info">
          <span className="chip">
            <TemplateIcon size={12} aria-hidden />
            {TEMPLATE_LABEL[body.template]}
          </span>
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
          {body.template === 'one-on-one' && firstTable && (
            <button className="btn btn-sm" onClick={() => addTodayRow(firstTable)}>
              <CalendarPlus size={14} aria-hidden />
              Add today’s row
            </button>
          )}
          {canEmail && (
            <button className="btn btn-sm" onClick={() => dispatch({ type: 'compose', draft: summaryEmail(W, file, body) })}>
              <Mail size={14} aria-hidden />
              {isRecap ? 'Email this recap' : 'Email the notes'}
            </button>
          )}
          <div className="doc-add">
            <Menu label="Add block" items={addMenu('cursor')} trigger={<><Plus size={14} aria-hidden />Add block</>} />
          </div>
        </div>
      </div>

      <div className="doc-blocks">
        {blocks.map((b, i) => (
          <div key={b.id} className={`doc-block doc-block-${b.type}${b.type === 'todo' && b.checked ? ' done' : ''}`}>
            <div className="doc-gutter">
              <Menu label="Block options" items={blockMenu(b, i)} />
            </div>
            <div className="doc-block-body">
              {isText(b) && (
                <>
                  {b.type === 'bullet' && <span className="doc-dot" aria-hidden />}
                  {b.type === 'todo' && (
                    <button
                      className="doc-check"
                      role="checkbox"
                      aria-checked={b.checked}
                      aria-label={b.checked ? 'Mark not done' : 'Mark done'}
                      onClick={() => setBlock(b.id, { checked: !b.checked })}
                    >
                      {b.checked && <Check size={12} strokeWidth={3} aria-hidden />}
                    </button>
                  )}
                  <BlockText
                    ref={register(b.id)}
                    className={`doc-text doc-${b.type}${b.type === 'p' && blocks.length > 1 ? ' quiet' : ''}`}
                    value={b.text}
                    placeholder={TYPE_META[b.type].placeholder}
                    aria-label={TYPE_META[b.type].label}
                    onFocus={() => (lastFocus.current = b.id)}
                    onChange={(e) => onText(b, e.target.value)}
                    onKeyDown={(e) => onKey(e, b, i)}
                  />
                </>
              )}
              {b.type === 'table' && (
                <TableEditor
                  b={b}
                  register={register}
                  onFocus={() => (lastFocus.current = b.id)}
                  onChange={(change) => setTable(b, change)}
                  onAddRow={() => addRow(b)}
                  onAddColumn={() => addColumn(b)}
                  onRemoveColumn={(j) => removeColumn(b, j)}
                  dated={datedTable(b)}
                />
              )}
              {b.type === 'linked-table' && <LinkedTable ws={W} sheetId={b.sheet} columns={b.columns} />}
              {b.type === 'file' && <FileChip W={W} id={b.file} dispatch={dispatch} />}
            </div>
          </div>
        ))}
      </div>

      <div className="doc-tail">
        <div className="doc-add">
          <Menu label="Add block at the end" items={addMenu('end')} trigger={<><Plus size={14} aria-hidden />Add block</>} />
        </div>
        <span className="muted doc-tail-hint">Enter adds a line. Start a line with - for a bullet, [] for a to-do, ## for a heading.</span>
      </div>

      <FilePick
        open={pick?.kind === 'sheet'}
        onClose={() => setPick(null)}
        title="Add a linked table"
        description="Shows the sheet’s current figures in this doc and refreshes whenever the sheet changes."
        filter={(f) => f.kind === 'sheet' && !!W.sheets[f.id]}
        empty="No sheets match."
        onPick={(f) => {
          const where = pick!.where;
          setPick(null);
          insert([{ id: bid(), type: 'linked-table', sheet: f.id }], where);
          dispatch({ type: 'toast', text: `Linked table from “${f.name}” added` });
        }}
      />
      <FilePick
        open={pick?.kind === 'file'}
        onClose={() => setPick(null)}
        title="Link a file"
        description="Link the files people will need next, like the tracker or the deck."
        filter={(f) => f.id !== file.id && f.folder !== FILING_FOLDER && !f.shortcutOf}
        onPick={(f) => {
          const where = pick!.where;
          setPick(null);
          insert([{ id: bid(), type: 'file', file: f.id }], where);
        }}
      />
    </div>
  );
}

function FileChip({ W, id, dispatch }: { W: WS; id: string; dispatch: (a: Action) => void }) {
  const f = W.files[id];
  if (!f) return <span className="chip">Linked file was removed</span>;
  return (
    <button className="doc-file-chip" onClick={() => openFile(dispatch, id)}>
      <DocIcon kind={f.kind} size={18} />
      <span className="doc-file-text">
        <span className="doc-file-name">{f.name}</span>
        <span className="doc-file-sub">{shortPath(W, f.folder)}</span>
      </span>
      <ArrowUpRight size={15} aria-hidden className="doc-file-go" />
    </button>
  );
}

function TableEditor({
  b,
  register,
  onFocus,
  onChange,
  onAddRow,
  onAddColumn,
  onRemoveColumn,
  dated,
}: {
  b: TableBlockT;
  register: (key: string) => (el: HTMLTextAreaElement | null) => void;
  onFocus: () => void;
  onChange: (change: Partial<TableBlockT>) => void;
  onAddRow: () => void;
  onAddColumn: () => void;
  onRemoveColumn: (j: number) => void;
  dated: boolean;
}) {
  const setCell = (i: number, j: number, v: string) => onChange({ rows: b.rows.map((r, ri) => (ri === i ? r.map((c, ci) => (ci === j ? v : c)) : r)) });
  return (
    <div className="doc-table-block" onFocus={onFocus}>
      <div className="doc-table-wrap">
        <table className="doc-table">
          <thead>
            <tr>
              {b.columns.map((c, j) => (
                <th key={j} className={/^date$/i.test(c.trim()) ? 'doc-col-date' : undefined}>
                  <div className="doc-th">
                    <BlockText
                      ref={register(`${b.id}:h:${j}`)}
                      className="doc-cell doc-cell-head"
                      value={c}
                      aria-label={`Column ${j + 1} name`}
                      onChange={(e) => onChange({ columns: b.columns.map((x, k) => (k === j ? e.target.value : x)) })}
                    />
                    {b.columns.length > 1 && (
                      <button className="icon-btn sm doc-th-x" aria-label={`Remove column ${c || j + 1}`} onClick={() => onRemoveColumn(j)}>
                        <X size={13} />
                      </button>
                    )}
                  </div>
                </th>
              ))}
              <th className="doc-row-tools" aria-label="Row actions" />
            </tr>
          </thead>
          <tbody>
            {b.rows.map((r, i) => (
              <tr key={i}>
                {b.columns.map((_, j) => (
                  <td key={j}>
                    <BlockText
                      ref={register(`${b.id}:${i}:${j}`)}
                      className="doc-cell"
                      value={r[j] ?? ''}
                      aria-label={`${b.columns[j] || `Column ${j + 1}`}, row ${i + 1}`}
                      onChange={(e) => setCell(i, j, e.target.value)}
                    />
                  </td>
                ))}
                <td className="doc-row-tools">
                  <button className="icon-btn sm" aria-label={`Delete row ${i + 1}`} onClick={() => onChange({ rows: b.rows.filter((_, k) => k !== i) })}>
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="doc-table-actions">
        <button className="btn btn-xs btn-ghost" onClick={onAddRow}>
          {dated ? <CalendarPlus size={13} aria-hidden /> : <Plus size={13} aria-hidden />}
          {dated ? 'Add today’s row' : 'Add row'}
        </button>
        <button className="btn btn-xs btn-ghost" onClick={onAddColumn}>
          <Columns3 size={13} aria-hidden />
          Add column
        </button>
      </div>
    </div>
  );
}
