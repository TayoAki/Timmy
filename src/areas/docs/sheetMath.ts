/*
 * Sheet values for display. Formula columns can refer to other formula
 * columns ("[Annual] / 12"), so formulas are worked out in passes until every
 * value settles, then formatted with the shared helpers.
 */
import type { Sheet, SheetColumn } from '../../data/ws-types';
import { evalFormula } from '../../state/ws';

type Row = Sheet['rows'][number];

/** evalFormula, but an unfinished formula ("[Annual] /") gives an empty cell instead of an error. */
export const safeEval = (formula: string, row: Row, columns: SheetColumn[]): number | '' => {
  try {
    return evalFormula(formula, row, columns);
  } catch {
    return '';
  }
};

/** Why a formula can't be used yet, or null if it can. */
export const formulaProblem = (formula: string, columns: SheetColumn[]): string | null => {
  const f = formula.trim();
  if (!f) return null;
  const unknown = [...f.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]!.trim()).filter((n) => !columns.some((c) => c.name.toLowerCase() === n.toLowerCase()));
  if (unknown.length) return `No column named ${unknown.map((u) => `[${u}]`).join(', ')}. Use a name from the list.`;
  const expr = f.replace(/\[[^\]]+\]/g, '1');
  if (!/^[\d\s.+\-*/()]+$/.test(expr)) return 'Use column names in brackets, numbers and + - * / ( ).';
  try {
    // Only digits and arithmetic operators reach this point.
    Function(`"use strict"; return (${expr});`);
  } catch {
    return 'The formula isn’t finished yet.';
  }
  return null;
};

/** The row with every formula column filled in. */
export const resolvedRow = (sheet: Pick<Sheet, 'columns'>, row: Row): Row => {
  const out: Row = { ...row };
  const formulas = sheet.columns.filter((c) => c.formula);
  for (let pass = 0; pass <= formulas.length; pass++) {
    let changed = false;
    for (const c of formulas) {
      const v = safeEval(c.formula!, out, sheet.columns);
      if (out[c.key] !== v) {
        out[c.key] = v;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
};

/** A cell's value, with formulas worked out. */
export const valueOf = (sheet: Pick<Sheet, 'columns'>, row: Row, col: SheetColumn): string | number =>
  col.formula ? (resolvedRow(sheet, row)[col.key] ?? '') : (row[col.key] ?? '');
