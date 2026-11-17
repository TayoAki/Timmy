/*
 * Lines Timmy adds to a page by itself (an automation's “Add to a doc”) can arrive while someone is typing on it.
 * They go in where they belong, beside what is being typed, so neither is lost and the cursor stays put.
 */
import type { Editor } from '@tiptap/react';
import type { Block } from '../../../data/ws-types';
import { isTimmyLine } from '../../../lib/blocks';
import { blockToNode, sameBlocks } from './convert';

export interface TimmyLine {
  block: Block;
  /** The block it follows on the page, or null when it comes first. Left out when it ends the page, as added lines do. */
  after?: string | null;
}

/** The lines Timmy added in `next` that `before` didn't have, when nothing else changed between the two. */
export function timmyAdditions(before: Block[], next: Block[]): TimmyLine[] | null {
  const had = new Set(before.map((b) => b.id));
  const isNew = (b: Block) => isTimmyLine(b.id) && !had.has(b.id);
  const added: TimmyLine[] = next.flatMap((block, i) => (isNew(block) ? [next.slice(i + 1).every(isNew) ? { block } : { block, after: next[i - 1]?.id ?? null }] : []));
  if (!added.length) return null;
  const others = next.filter((b) => !isNew(b));
  return sameBlocks(others, before) ? added : null;
}

/** Puts the lines into the editor where they belong. It isn't the person's own edit, so Undo skips it. */
export function insertTimmyLines(editor: Editor, lines: TimmyLine[]) {
  let tr = editor.state.tr;
  for (const { block, after } of lines) {
    let at = after === null ? 0 : tr.doc.content.size;
    if (after) {
      tr.doc.forEach((node, offset) => {
        if (node.attrs.bid === after) at = offset + node.nodeSize;
      });
    }
    tr = tr.insert(at, editor.schema.nodeFromJSON(blockToNode(block)));
  }
  editor.view.dispatch(tr.setMeta('addToHistory', false));
}
