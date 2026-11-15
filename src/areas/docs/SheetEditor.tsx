/*
 * A sheet is one named table. Columns have a name and a type; a column can
 * hold a formula that refers to other columns by name ("[Seats] * [Price]"),
 * so every row, including new ones, is calculated the same way. Docs can show
 * the table as a linked table that refreshes from here.
 */
import { ArrowUpRight, CalendarDays, DollarSign, FileText, Hash, Link2, Plus, Sigma, Trash2, Type, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { DocIcon } from '../../components/DocBits';
import { Field, Modal, Segmented } from '../../components/kit';
import { NOW } from '../../data/mock';
import type { Sheet, SheetColumn, WFile } from '../../data/ws-types';
import { useStore, ws } from '../../state/store';
import { cellValue, evalFormula, fmtCell, patch } from '../../state/ws';
import { FilePick } from './FilePick';
import { LinkedTable, rememberSheet } from './LinkedTable';
import { NewDocDialog } from './NewDocDialog';
import { docsLinkingSheet, openFile } from './shared';
import { bid } from './templates';

const TYPE_ICON: Record<SheetColumn['type'], LucideIcon> = { text: Type, number: Hash, currency: DollarSign, date: CalendarDays };
const TYPE_LABEL: Record<SheetColumn['type'], string> = { text: 'Text', number: 'Number', currency: 'Currency', date: 'Date' };
const isNum = (c: SheetColumn) => c.type === 'number' || c.type === 'currency' || !!c.formula;

/** Column names a formula refers to that don't exist. */
const unknownRefs = (formula: string, columns: SheetColumn[]) =>
  [...formula.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]!.trim()).filter((n) => !columns.some((c) => c.name.toLowerCase() === n.toLowerCase()));

export function SheetEditor({ file, sheet }: { file: WFile; sheet: Sheet }) {
  const { state, dispatch } = useStore();
  const W = state.ws;
  const [colDialog, setColDialog] = useState<null | { edit?: SheetColumn }>(null);
  const [insertOpen, setInsertOpen] = useState(false);
  const [newDocOpen, setNewDocOpen] = useState(false);
  const linked = docsLinkingSheet(W, sheet.id);

  // Linked docs can then show which figures changed since they were last opened.
  useEffect(() => rememberSheet(sheet), [sheet]);

  const save = (change: Partial<Sheet>, opts?: { toast?: string; undo?: boolean }) =>
    dispatch(ws([patch('sheets', sheet.id, change), patch('files', file.id, { updated: NOW })], opts));

  const setCell = (i: number, col: SheetColumn, raw: string) => {
    const v: string | number = isNum(col) && raw.trim() !== '' && !Number.isNaN(Number(raw.replace(/[$,\s]/g, ''))) ? Number(raw.replace(/[$,\s]/g, '')) : raw;
    save({ rows: sheet.rows.map((r, k) => (k === i ? { ...r, [col.key]: v } : r)) });
  };

  const focusCell = (r: number, c: number) => {
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`[data-sheet="${sheet.id}"][data-r="${r}"][data-c="${c}"]`)?.focus());
  };

  const addRow = () => {
    save({ rows: [...sheet.rows, Object.fromEntries(sheet.columns.filter((c) => !c.formula).map((c) => [c.key, '']))] });
    const first = sheet.columns.findIndex((c) => !c.formula);
    focusCell(sheet.rows.length, Math.max(first, 0));
  };

  const removeRow = (i: number) => save({ rows: sheet.rows.filter((_, k) => k !== i) }, { toast: `Row ${i + 1} deleted`, undo: true });

  const onCellKey = (e: KeyboardEvent<HTMLInputElement>, r: number, c: number) => {
    const editable = (row: number) => row >= 0 && row < sheet.rows.length;
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (editable(r + 1)) focusCell(r + 1, c);
      else if (e.key === 'Enter') addRow();
    } else if (e.key === 'ArrowUp' && editable(r - 1)) {
      e.preventDefault();
      focusCell(r - 1, c);
    }
  };

  return (
    <div className="sheet-editor">
      <div className="doc-toolbar">
        <div className="doc-toolbar-info">
          <span className="chip">
            Table <strong className="sheet-table-name">{sheet.table}</strong>
          </span>
          <span className="muted sheet-count">
            {sheet.rows.length} rows · {sheet.columns.length} columns
          </span>
        </div>
        <div className="doc-toolbar-actions">
          <button className="btn btn-sm" onClick={addRow}>
            <Plus size={14} aria-hidden />
            Add row
          </button>
          <button className="btn btn-sm" onClick={() => setColDialog({})}>
            <Plus size={14} aria-hidden />
            Add column
          </button>
          <button className="btn btn-sm" onClick={() => setInsertOpen(true)}>
            <Link2 size={14} aria-hidden />
            Insert into a doc
          </button>
        </div>
      </div>

      <div className="sheet-wrap" role="region" aria-label={`${sheet.table} table`} tabIndex={-1}>
        <table className="sheet-grid">
          <thead>
            <tr>
              <th className="sheet-rownum" aria-label="Row" />
              {sheet.columns.map((c) => {
                const Icon = c.formula ? Sigma : TYPE_ICON[c.type];
                return (
                  <th key={c.key} className={isNum(c) ? 'num' : undefined}>
                    <button className="sheet-th" onClick={() => setColDialog({ edit: c })} title="Edit column">
                      <Icon size={13} aria-hidden className="sheet-th-icon" />
                      <span className="sheet-th-name">{c.name}</span>
                      <span className="sr-only">, {c.formula ? 'formula' : TYPE_LABEL[c.type]} column. Edit column</span>
                    </button>
                    {c.formula && <code className="sheet-formula">= {c.formula}</code>}
                  </th>
                );
              })}
              <th className="sheet-tools" aria-label="Row actions" />
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, i) => (
              <tr key={i}>
                <td className="sheet-rownum">{i + 1}</td>
                {sheet.columns.map((c, j) =>
                  c.formula ? (
                    <td key={c.key} className="num computed" title={`Calculated: ${c.formula}`}>
                      <output className="sheet-out">{fmtCell(cellValue(sheet, row, c), c) || <span className="muted">–</span>}</output>
                    </td>
                  ) : (
                    <td key={c.key} className={isNum(c) ? 'num' : undefined}>
                      <SheetCell sheetId={sheet.id} r={i} c={j} col={c} raw={row[c.key] ?? ''} onCommit={(v) => setCell(i, c, v)} onKey={onCellKey} />
                    </td>
                  ),
                )}
                <td className="sheet-tools">
                  <button className="icon-btn sm" aria-label={`Delete row ${i + 1}`} onClick={() => removeRow(i)}>
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="sheet-add-row" onClick={addRow}>
          <Plus size={14} aria-hidden />
          Add row
        </button>
      </div>

      <p className="timmy-line sheet-hint">
        <Sigma size={14} />
        <span>
          Formulas refer to columns by name, like <code className="code">[Seats] * [Price] * 12</code>, so every row you add is calculated too.
        </span>
      </p>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Linked in docs</h2>
          <span className="section-sub">{linked.length ? 'Each doc shows these figures and updates as you edit' : 'Not linked yet'}</span>
        </div>
        {linked.length === 0 ? (
          <div className="sheet-linked-empty">
            <p className="muted">Put these figures in a doc as a linked table. When the sheet changes, the doc changes with it.</p>
            <div className="sheet-linked-actions">
              <button className="btn btn-sm" onClick={() => setInsertOpen(true)}>
                <Link2 size={14} aria-hidden />
                Insert into a doc
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => setNewDocOpen(true)}>
                <FileText size={14} aria-hidden />
                New doc with this table
              </button>
            </div>
          </div>
        ) : (
          <div className="sheet-linked">
            {linked.map(({ file: d, blocks }) => (
              <div key={d.id} className="sheet-linked-doc">
                <div className="sheet-linked-head">
                  <DocIcon kind="doc" size={16} />
                  <strong>{d.name}</strong>
                  <button className="btn btn-xs" onClick={() => openFile(dispatch, d.id)}>
                    <ArrowUpRight size={13} aria-hidden />
                    Open doc
                  </button>
                </div>
                <LinkedTable ws={W} sheetId={sheet.id} columns={blocks[0]!.columns} compact />
              </div>
            ))}
          </div>
        )}
      </section>

      {colDialog && <ColumnDialog sheet={sheet} edit={colDialog.edit} onClose={() => setColDialog(null)} onSave={save} />}

      <FilePick
        open={insertOpen}
        onClose={() => setInsertOpen(false)}
        title="Insert into a doc as a linked table"
        description={`The doc shows the ${sheet.table} table and refreshes whenever this sheet changes.`}
        filter={(f) => f.kind === 'doc' && !!W.docs[f.id]}
        empty="No docs match."
        footer={
          <button
            className="btn"
            onClick={() => {
              setInsertOpen(false);
              setNewDocOpen(true);
            }}
          >
            <FileText size={14} aria-hidden />
            New doc with this table
          </button>
        }
        onPick={(d) => {
          setInsertOpen(false);
          const body = W.docs[d.id]!;
          dispatch(
            ws([patch('docs', d.id, { blocks: [...body.blocks, { id: bid(), type: 'linked-table', sheet: sheet.id }] }), patch('files', d.id, { updated: NOW })], {
              toast: `Linked table added to “${d.name}”`,
              undo: true,
            }),
          );
        }}
      />
      <NewDocDialog
        open={newDocOpen}
        onClose={() => setNewDocOpen(false)}
        initial={{ template: 'blank', project: file.project, folder: file.folder, blocks: [{ id: bid(), type: 'linked-table', sheet: sheet.id }] }}
      />
    </div>
  );
}

/** An input that shows the formatted value until you click into it. */
function SheetCell({
  sheetId,
  r,
  c,
  col,
  raw,
  onCommit,
  onKey,
}: {
  sheetId: string;
  r: number;
  c: number;
  col: SheetColumn;
  raw: string | number;
  onCommit: (v: string) => void;
  onKey: (e: KeyboardEvent<HTMLInputElement>, r: number, c: number) => void;
}) {
  const [focused, setFocused] = useState(false);
  // While typing, show exactly what was typed ("12." stays "12.") and save the parsed value.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = focused ? (draft ?? String(raw)) : fmtCell(raw, col);
  return (
    <input
      className="sheet-cell"
      data-sheet={sheetId}
      data-r={r}
      data-c={c}
      value={shown}
      inputMode={isNum(col) ? 'decimal' : undefined}
      placeholder={col.type === 'date' && focused ? 'yyyy-mm-dd' : undefined}
      aria-label={`${col.name}, row ${r + 1}`}
      onFocus={(e) => {
        setFocused(true);
        requestAnimationFrame(() => e.target.select());
      }}
      onBlur={() => {
        setFocused(false);
        setDraft(null);
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        onCommit(e.target.value);
      }}
      onKeyDown={(e) => onKey(e, r, c)}
    />
  );
}

/* ───────────── Add or edit a column ───────────── */

function ColumnDialog({
  sheet,
  edit,
  onClose,
  onSave,
}: {
  sheet: Sheet;
  edit?: SheetColumn;
  onClose: () => void;
  onSave: (change: Partial<Sheet>, opts?: { toast?: string; undo?: boolean }) => void;
}) {
  const [name, setName] = useState(edit?.name ?? '');
  const [type, setType] = useState<SheetColumn['type']>(edit?.type ?? 'number');
  const [formula, setFormula] = useState(edit?.formula ?? '');
  const formulaId = useId();
  const others = sheet.columns.filter((c) => c.key !== edit?.key);
  const trimmed = name.trim();
  const dup = others.some((c) => c.name.toLowerCase() === trimmed.toLowerCase());
  const unknown = formula.trim() ? unknownRefs(formula, others) : [];
  const badChars = formula.trim() && !/^[\d\s.+\-*/()]*$/.test(formula.replace(/\[[^\]]+\]/g, '1'));
  const sampleRow = sheet.rows[0];
  const draftCol: SheetColumn = { key: '__draft', name: trimmed || 'New column', type, formula: formula.trim() || undefined };
  const sample = formula.trim() && sampleRow && !unknown.length && !badChars ? evalFormula(formula, sampleRow, others) : '';
  const usedBy = edit ? sheet.columns.filter((c) => c.formula && c.key !== edit.key && new RegExp(`\\[\\s*${edit.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]`, 'i').test(c.formula)) : [];
  const valid = trimmed && !dup && !unknown.length && !badChars;

  const insertRef = (n: string) => setFormula((f) => `${f}${f && !/\s$/.test(f) ? ' ' : ''}[${n}]`);

  const submit = () => {
    if (!valid) return;
    if (edit) {
      // Renaming a column updates formulas that refer to it.
      const re = new RegExp(`\\[\\s*${edit.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]`, 'gi');
      const columns = sheet.columns.map((c) =>
        c.key === edit.key ? { ...c, name: trimmed, type, formula: formula.trim() || undefined } : c.formula && trimmed !== edit.name ? { ...c, formula: c.formula.replace(re, `[${trimmed}]`) } : c,
      );
      onSave({ columns }, { toast: `Column “${trimmed}” updated`, undo: true });
    } else {
      let key = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'col';
      while (sheet.columns.some((c) => c.key === key)) key += '-2';
      onSave({ columns: [...sheet.columns, { key, name: trimmed, type, formula: formula.trim() || undefined }] }, { toast: `Column “${trimmed}” added`, undo: true });
    }
    onClose();
  };

  const remove = () => {
    if (!edit) return;
    onSave({ columns: sheet.columns.filter((c) => c.key !== edit.key) }, { toast: `Column “${edit.name}” deleted`, undo: true });
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={edit ? `Edit column “${edit.name}”` : 'Add a column'}
      width={540}
      footer={
        <>
          {edit && (
            <button className="btn btn-ghost doc-foot-left" onClick={remove}>
              <Trash2 size={14} aria-hidden />
              Delete column
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!valid} onClick={submit}>
            {edit ? 'Save column' : 'Add column'}
          </button>
        </>
      }
    >
      <form
        className="doc-form-contents"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Name" hint={dup ? 'Another column already has this name.' : undefined}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Discount" />
        </Field>
      </form>
      <div className="field">
        <span className="field-label">Type</span>
        <Segmented
          label="Column type"
          value={type}
          onChange={setType}
          options={(['text', 'number', 'currency', 'date'] as const).map((t) => ({ id: t, label: TYPE_LABEL[t], icon: TYPE_ICON[t] }))}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor={formulaId}>
          Formula (optional)
        </label>
        <input
          id={formulaId}
          className="input code sheet-formula-input"
          value={formula}
          onChange={(e) => setFormula(e.target.value)}
          placeholder="[Seats] * [Price] * 12"
          spellCheck={false}
          aria-invalid={unknown.length > 0 || !!badChars}
        />
        <div className="sheet-ref-chips" role="group" aria-label="Insert a column reference">
          {others.map((c) => (
            <button key={c.key} type="button" className="doc-opt" onClick={() => insertRef(c.name)}>
              [{c.name}]
            </button>
          ))}
        </div>
        <span className={`field-hint${unknown.length || badChars ? ' sheet-error' : ''}`}>
          {unknown.length
            ? `No column named ${unknown.map((u) => `[${u}]`).join(', ')}. Use a name from the list.`
            : badChars
              ? 'Use column names in brackets, numbers and + - * / ( ).'
              : formula.trim()
                ? sample !== '' && sampleRow
                  ? `Row 1 comes to ${fmtCell(sample, draftCol)}. New rows use the same formula.`
                  : 'Row 1 has no value yet for one of these columns.'
                : 'Write [Column name] to use a column, e.g. [Seats] * [Price] * 12. Every row, including new ones, uses it.'}
        </span>
        {usedBy.length > 0 && <span className="field-hint">Used in {usedBy.map((c) => `“${c.name}”`).join(', ')}. Renaming updates those formulas.</span>}
      </div>
    </Modal>
  );
}
