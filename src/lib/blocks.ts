/*
 * Small helpers for doc blocks, shared by the editor, exports and Timmy's
 * readers (email summaries, Word export).
 */
import type { Block } from '../data/ws-types';

export type TextBlock = Extract<Block, { text: string }>;

export const hasText = (b: Block): b is TextBlock => 'text' in b && typeof (b as { text?: unknown }).text === 'string';

export const textOf = (b: Block) => (hasText(b) ? b.text : '');

const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii', 'xiii', 'xiv', 'xv', 'xvi', 'xvii', 'xviii', 'xix', 'xx'];
const alpha = (n: number): string => (n <= 26 ? String.fromCharCode(96 + n) : alpha(Math.floor((n - 1) / 26)) + alpha(((n - 1) % 26) + 1));

/** The marker for the nth item of a numbered list at a nesting level: 1. a. i. then again. */
export const numberLabel = (n: number, level: number) => {
  const k = level % 3;
  return k === 0 ? `${n}.` : k === 1 ? `${alpha(n)}.` : `${ROMAN[n - 1] ?? n}.`;
};

/**
 * Numbers for numbered-list blocks. Consecutive items at the same level count
 * up; deeper blocks don't break the count, and any other block at the same or
 * a shallower level starts it again.
 */
export function listNumbers(blocks: { type: string; indent?: number }[]): number[] {
  const counters: number[] = [];
  return blocks.map((b) => {
    const d = b.indent ?? 0;
    counters.length = Math.min(counters.length, d + 1);
    if (b.type === 'numbered') {
      counters[d] = (counters[d] ?? 0) + 1;
      return counters[d]!;
    }
    counters[d] = 0;
    return 0;
  });
}

/** Indices of blocks hidden inside a closed toggle. */
export function hiddenByToggles(blocks: { type: string; indent?: number; open?: boolean }[]): Set<number> {
  const hidden = new Set<number>();
  let closedAt: number | null = null;
  blocks.forEach((b, i) => {
    const d = b.indent ?? 0;
    if (closedAt !== null && d > closedAt) {
      hidden.add(i);
      return;
    }
    closedAt = b.type === 'toggle' && b.open === false ? d : null;
  });
  return hidden;
}
