/*
 * Every kind of block, as the "/" menu, "Turn into" and the block menu list
 * them, with what inserting one does.
 */
import type { Editor, JSONContent, Range } from '@tiptap/core';
import {
  ChevronRight,
  Code2,
  FileSpreadsheet,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  ImagePlus,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Lightbulb,
  Minus,
  Pilcrow,
  Quote,
  Sparkles,
  Table2,
  type LucideIcon,
} from 'lucide-react';
import { bid } from '../templates';
import { currentBlock, insertAfter, turnInto } from './extensions';

/** Things only the doc around the editor can do (pick a sheet, make a page). */
export interface EditorActions {
  pickSheet: (after: number | null) => void;
  pickFile: (after: number | null) => void;
  newPage: (after: number | null) => void;
  /** Timmy writes a summary of the page here, with its own cursor. */
  timmySummary: (after: number | null) => void;
}

export interface BlockKind {
  id: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  group: 'Basic blocks' | 'Media' | 'From Timmy';
  /** Words the "/" menu matches as well as the label. */
  keys: string;
  /** Shortcut to show beside it. */
  md?: string;
  /** For text blocks: the node and attributes "Turn into" uses. */
  node?: { type: string; attrs?: Record<string, unknown> };
  /** For everything else: what to insert. */
  insert?: (actions: EditorActions, after: number | null) => JSONContent | null;
}

export const KINDS: BlockKind[] = [
  { id: 'p', label: 'Text', hint: 'Just start writing', icon: Pilcrow, group: 'Basic blocks', keys: 'text paragraph plain', node: { type: 'paragraph' } },
  { id: 'h1', label: 'Heading 1', hint: 'Big section heading', icon: Heading1, group: 'Basic blocks', keys: 'h1 title heading large', md: '#', node: { type: 'heading', attrs: { level: 1 } } },
  { id: 'h2', label: 'Heading 2', hint: 'Medium section heading', icon: Heading2, group: 'Basic blocks', keys: 'h2 heading subtitle', md: '##', node: { type: 'heading', attrs: { level: 2 } } },
  { id: 'h3', label: 'Heading 3', hint: 'Small section heading', icon: Heading3, group: 'Basic blocks', keys: 'h3 heading small', md: '###', node: { type: 'heading', attrs: { level: 3 } } },
  { id: 'todo', label: 'To-do list', hint: 'Track tasks with a checkbox', icon: ListTodo, group: 'Basic blocks', keys: 'todo task checkbox check action', md: '[]', node: { type: 'todo', attrs: { checked: false } } },
  { id: 'bullet', label: 'Bulleted list', hint: 'A simple bulleted list', icon: List, group: 'Basic blocks', keys: 'bullet list unordered ul', md: '-', node: { type: 'bullet' } },
  { id: 'numbered', label: 'Numbered list', hint: 'A list with numbering', icon: ListOrdered, group: 'Basic blocks', keys: 'numbered ordered list ol 1.', md: '1.', node: { type: 'numbered' } },
  { id: 'toggle', label: 'Toggle list', hint: 'Hide and show what’s inside', icon: ChevronRight, group: 'Basic blocks', keys: 'toggle collapse fold details', md: '>', node: { type: 'toggle', attrs: { open: true } } },
  { id: 'quote', label: 'Quote', hint: 'Capture a quote', icon: Quote, group: 'Basic blocks', keys: 'quote blockquote citation', md: '"', node: { type: 'quote' } },
  { id: 'callout', label: 'Callout', hint: 'Make writing stand out', icon: Lightbulb, group: 'Basic blocks', keys: 'callout note tip info warning box', node: { type: 'callout', attrs: { icon: '💡' } } },
  { id: 'code', label: 'Code', hint: 'A block of code or plain text', icon: Code2, group: 'Basic blocks', keys: 'code snippet pre monospace', md: '```', node: { type: 'codeBlock' } },
  { id: 'divider', label: 'Divider', hint: 'Separate sections', icon: Minus, group: 'Basic blocks', keys: 'divider line separator hr rule', md: '---', insert: () => ({ type: 'horizontalRule' }) },
  { id: 'page', label: 'Page', hint: 'A page inside this page', icon: FileText, group: 'Basic blocks', keys: 'page subpage sub-page child doc', insert: (a, after) => (a.newPage(after), null) },
  { id: 'image', label: 'Image', hint: 'Upload a picture or embed a link', icon: ImagePlus, group: 'Media', keys: 'image picture photo upload img', insert: () => ({ type: 'image', attrs: { src: '' } }) },
  {
    id: 'table',
    label: 'Table',
    hint: 'A table you type into',
    icon: Table2,
    group: 'Media',
    keys: 'table grid columns rows',
    insert: () => ({ type: 'table', attrs: { columns: ['Topic', 'Owner', 'Notes'], rows: [['', '', ''], ['', '', '']] } }),
  },
  { id: 'summary', label: 'Summarize with Timmy', hint: 'Timmy writes a summary of this page', icon: Sparkles, group: 'From Timmy', keys: 'summary summarize timmy ai tldr recap', insert: (a, after) => (a.timmySummary(after), null) },
  { id: 'linked', label: 'Linked table', hint: 'Live figures from a sheet', icon: FileSpreadsheet, group: 'From Timmy', keys: 'linked sheet spreadsheet figures live table', insert: (a, after) => (a.pickSheet(after), null) },
  { id: 'file', label: 'Link a file', hint: 'A tracker, deck or contract', icon: Link2, group: 'From Timmy', keys: 'file link attach drive doc', insert: (a, after) => (a.pickFile(after), null) },
];

export const TURN_INTO = KINDS.filter((k) => k.node);

/** The kind a text block is now (for "Turn into" ticks). */
export function kindOfNode(type: string, attrs: Record<string, unknown>): string {
  if (type === 'heading') return `h${attrs.level ?? 2}`;
  if (type === 'paragraph') return 'p';
  if (type === 'codeBlock') return 'code';
  return type;
}

export function filterKinds(query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return KINDS;
  return KINDS.filter((k) => k.label.toLowerCase().includes(q) || k.keys.split(' ').some((w) => w.startsWith(q)) || (k.md && k.md === q));
}

/**
 * Run a "/" menu choice: an empty line turns into the block; otherwise the
 * block goes below the current one.
 */
export function runKind(editor: Editor, range: Range, kind: BlockKind, actions: EditorActions) {
  editor.chain().focus().deleteRange(range).run();
  const cur = currentBlock(editor);
  if (!cur) return;
  const empty = cur.node.isTextblock && cur.node.content.size === 0;
  if (kind.node) {
    if (empty || cur.node.type.name === kind.node.type) {
      if (empty) turnInto(editor, cur.pos, kind.node.type, kind.node.attrs);
      else insertAfter(editor, cur.index, [{ type: kind.node.type, attrs: { ...kind.node.attrs, bid: bid(), indent: cur.node.attrs.indent } }]);
    } else insertAfter(editor, cur.index, [{ type: kind.node.type, attrs: { ...kind.node.attrs, bid: bid(), indent: cur.node.attrs.indent } }]);
    return;
  }
  // An empty line the "/" was typed on gives way to what's inserted.
  let after: number | null = cur.index;
  if (empty && cur.node.type.name === 'paragraph') {
    if (editor.state.doc.childCount > 1) editor.view.dispatch(editor.state.tr.delete(cur.pos, cur.pos + cur.node.nodeSize));
    after = cur.index - 1;
  }
  const node = kind.insert?.(actions, after);
  if (node) insertAfter(editor, after, [{ ...node, attrs: { ...(node.attrs ?? {}), bid: bid(), indent: cur.node.attrs.indent } }]);
}
