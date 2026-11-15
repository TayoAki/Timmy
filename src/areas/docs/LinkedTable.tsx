/*
 * A doc's live view of a sheet. Values are read from the sheet every render,
 * so they change the moment the sheet does. Cells that changed since this doc
 * last showed them are highlighted once.
 */
import { ArrowUpRight, Link2, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Sheet, SheetColumn, WS } from '../../data/ws-types';
import { useStore } from '../../state/store';
import { fmtCell } from '../../state/ws';
import { resolvedRow } from './sheetMath';
import { openFile } from './shared';

/** What each doc last showed for a sheet, keyed by sheet id → "row:column". Lives for the session. */
const shown = new Map<string, Map<string, string>>();

export const sheetCells = (sheet: Sheet, columns: SheetColumn[]) =>
  sheet.rows.map((row) => {
    const full = resolvedRow(sheet, row);
    return columns.map((c) => fmtCell(full[c.key] ?? '', c));
  });

/** Remember the values a sheet has before you edit it, so linked docs can show what changed. */
export const rememberSheet = (sheet: Sheet) => {
  if (shown.has(sheet.id)) return;
  const map = new Map<string, string>();
  sheetCells(sheet, sheet.columns).forEach((r, i) => r.forEach((v, j) => map.set(`${i}:${sheet.columns[j]!.key}`, v)));
  shown.set(sheet.id, map);
};

export const linkedColumns = (sheet: Sheet, cols?: string[]) =>
  cols?.length ? sheet.columns.filter((c) => cols.includes(c.key) || cols.includes(c.name)) : sheet.columns;

export function LinkedTable({ ws, sheetId, columns, compact }: { ws: WS; sheetId: string; columns?: string[]; compact?: boolean }) {
  const { dispatch } = useStore();
  const sheet = ws.sheets[sheetId];
  const file = ws.files[sheetId];
  const cols = sheet ? linkedColumns(sheet, columns) : [];
  const cells = sheet ? sheetCells(sheet, cols) : [];
  const flat = cells.map((r, i) => r.map((v, j) => `${i}:${cols[j]!.key}=${v}`).join('|')).join('/');

  const diff = () => {
    const prev = shown.get(sheetId);
    const out = new Set<string>();
    if (prev) cells.forEach((r, i) => r.forEach((v, j) => prev.has(`${i}:${cols[j]!.key}`) && prev.get(`${i}:${cols[j]!.key}`) !== v && out.add(`${i}:${j}`)));
    return out;
  };
  // In the doc, highlight what changed since the doc last showed it. The compact
  // preview on the sheet shows, live, which cells the doc will pick up.
  const [onMount, setOnMount] = useState<Set<string>>(() => (compact ? new Set() : diff()));
  const fresh = compact ? diff() : onMount;

  useEffect(() => {
    if (compact) return;
    const map = shown.get(sheetId) ?? new Map<string, string>();
    cells.forEach((r, i) => r.forEach((v, j) => map.set(`${i}:${cols[j]!.key}`, v)));
    shown.set(sheetId, map);
  }, [flat, sheetId, compact]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (compact || !onMount.size) return;
    const t = window.setTimeout(() => setOnMount(new Set()), 8000);
    return () => window.clearTimeout(t);
  }, [onMount, compact]);

  if (!sheet || !file) {
    return (
      <div className="doc-linked">
        <p className="doc-linked-head">
          <Link2 size={14} aria-hidden />
          The linked sheet was removed.
        </p>
      </div>
    );
  }

  return (
    <div className={`doc-linked${compact ? ' compact' : ''}`}>
      <div className="doc-linked-head">
        <Link2 size={14} aria-hidden />
        <span className="doc-linked-text">
          Linked to <strong>{file.name}</strong>
          <span className="muted"> · refreshes from the sheet</span>
        </span>
        {fresh.size > 0 && (
          <span className="chip accent doc-linked-fresh">
            <RefreshCw size={12} aria-hidden />
            {compact ? 'Changes the doc will show' : 'Updated from the sheet'}
          </span>
        )}
        {!compact && (
          <button className="btn btn-xs" onClick={() => openFile(dispatch, sheetId)}>
            <ArrowUpRight size={13} aria-hidden />
            Open sheet
          </button>
        )}
      </div>
      <div className="doc-table-wrap">
        <table className="doc-table readonly">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.key} className={c.type === 'number' || c.type === 'currency' ? 'num' : undefined}>
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cells.map((r, i) => (
              <tr key={i}>
                {r.map((v, j) => (
                  <td
                    key={cols[j]!.key}
                    className={[cols[j]!.type === 'number' || cols[j]!.type === 'currency' ? 'num' : '', fresh.has(`${i}:${j}`) ? 'fresh' : ''].join(' ').trim() || undefined}
                  >
                    {v || <span className="muted">–</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
