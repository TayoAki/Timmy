/*
 * The editor's block model. Every block is one top-level node; nesting is an
 * `indent` attribute (list levels, a toggle's contents), so blocks map one to
 * one onto Timmy's stored blocks. This file holds the text block nodes, the
 * keyboard (Enter, Backspace, Tab, moving blocks), the markdown shortcuts and
 * the decorations that number lists and fold closed toggles.
 */
import { Extension, InputRule, Node, mergeAttributes, type Editor, type JSONContent } from '@tiptap/core';
import type { Node as PMNode, NodeType } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { numberLabel } from '../../../lib/blocks';
import { bid } from '../templates';

export const TEXT_NODES = ['paragraph', 'heading', 'bullet', 'numbered', 'todo', 'toggle', 'quote', 'callout'];
export const ATOM_NODES = ['horizontalRule', 'image', 'table', 'linkedTable', 'fileLink', 'pageLink'];
export const ALL_NODES = [...TEXT_NODES, 'codeBlock', ...ATOM_NODES];
const MAX_INDENT = 8;

/* ───────────── Shared attributes ───────────── */

export const BlockAttrs = Extension.create({
  name: 'blockAttrs',
  addGlobalAttributes() {
    return [
      {
        types: ALL_NODES,
        attributes: {
          bid: { default: null, rendered: false, keepOnSplit: false },
          indent: {
            default: 0,
            parseHTML: (el) => Number(el.getAttribute('data-indent')) || 0,
            renderHTML: (a) => (a.indent ? { 'data-indent': a.indent, style: `--indent:${a.indent}` } : {}),
          },
          color: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el) => el.getAttribute('data-color'),
            renderHTML: (a) => (a.color ? { 'data-color': a.color } : {}),
          },
        },
      },
    ];
  },
});

/** Mirror the shared attributes onto a hand-built node view. */
export function applyBlockAttrs(dom: HTMLElement, node: PMNode) {
  const i = Number(node.attrs.indent) || 0;
  if (i) {
    dom.setAttribute('data-indent', String(i));
    dom.style.setProperty('--indent', String(i));
  } else {
    dom.removeAttribute('data-indent');
    dom.style.removeProperty('--indent');
  }
  if (node.attrs.color) dom.setAttribute('data-color', node.attrs.color);
  else dom.removeAttribute('data-color');
}

/* ───────────── Text blocks ───────────── */

const simple = (name: 'bullet' | 'numbered' | 'quote', extraParse: { tag: string; priority?: number }[] = []) =>
  Node.create({
    name,
    group: 'block',
    content: 'inline*',
    defining: true,
    parseHTML() {
      return [{ tag: `div[data-type="${name}"]` }, ...extraParse];
    },
    renderHTML({ HTMLAttributes }) {
      return ['div', mergeAttributes(HTMLAttributes, { 'data-type': name, class: `nb nb-${name}` }), 0];
    },
  });

export const Bullet = simple('bullet');
export const Numbered = simple('numbered');
export const Quote = simple('quote', [{ tag: 'blockquote', priority: 40 }]);

const CHECK_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const CHEVRON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

/** A node view with a control on the left (checkbox, chevron, emoji) and the text beside it. */
function controlView(
  cls: string,
  make: (btn: HTMLButtonElement) => void,
  sync: (dom: HTMLElement, btn: HTMLButtonElement, node: PMNode, editable: boolean) => void,
  onClick: (node: PMNode, pos: number, editor: Editor, btn: HTMLButtonElement) => void,
) {
  return ({ node, getPos, editor }: { node: PMNode; getPos: () => number | undefined; editor: Editor }) => {
    let current = node;
    const dom = document.createElement('div');
    dom.className = `nb nb-${cls}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `nb-ctl nb-${cls}-ctl`;
    btn.contentEditable = 'false';
    make(btn);
    const content = document.createElement('div');
    content.className = 'nb-content';
    dom.append(btn, content);
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const pos = getPos();
      if (typeof pos === 'number') onClick(current, pos, editor, btn);
    });
    const refresh = (n: PMNode) => {
      current = n;
      applyBlockAttrs(dom, n);
      sync(dom, btn, n, editor.isEditable);
    };
    refresh(node);
    return {
      dom,
      contentDOM: content,
      update: (n: PMNode) => {
        if (n.type !== node.type) return false;
        refresh(n);
        return true;
      },
      ignoreMutation: (m: { target: globalThis.Node; type: string }) => btn.contains(m.target) || (m.type === 'attributes' && m.target === dom),
    };
  };
}

export const Todo = Node.create({
  name: 'todo',
  group: 'block',
  content: 'inline*',
  defining: true,
  addAttributes() {
    return {
      checked: {
        default: false,
        keepOnSplit: false,
        parseHTML: (el) => el.getAttribute('data-checked') === 'true',
        renderHTML: (a) => ({ 'data-checked': a.checked ? 'true' : 'false' }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="todo"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'todo', class: 'nb nb-todo' }), 0];
  },
  addNodeView() {
    return controlView(
      'todo',
      (btn) => btn.setAttribute('role', 'checkbox'),
      (dom, btn, n, editable) => {
        const on = !!n.attrs.checked;
        dom.classList.toggle('done', on);
        btn.setAttribute('aria-checked', String(on));
        btn.setAttribute('aria-label', on ? 'Mark not done' : 'Mark done');
        btn.innerHTML = on ? CHECK_SVG : '';
        btn.disabled = !editable;
      },
      (n, pos, editor) => editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'checked', !n.attrs.checked)),
    ) as never;
  },
});

export const Toggle = Node.create({
  name: 'toggle',
  group: 'block',
  content: 'inline*',
  defining: true,
  addAttributes() {
    return {
      open: {
        default: true,
        parseHTML: (el) => el.getAttribute('data-open') !== 'false',
        renderHTML: (a) => ({ 'data-open': a.open ? 'true' : 'false' }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="toggle"]' }, { tag: 'details', priority: 40 }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'toggle', class: 'nb nb-toggle' }), 0];
  },
  addNodeView() {
    return controlView(
      'toggle',
      (btn) => (btn.innerHTML = CHEVRON_SVG),
      (dom, btn, n) => {
        const open = n.attrs.open !== false;
        dom.classList.toggle('open', open);
        btn.setAttribute('aria-expanded', String(open));
        btn.setAttribute('aria-label', open ? 'Close toggle' : 'Open toggle');
      },
      (n, pos, editor) => editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'open', n.attrs.open === false)),
    ) as never;
  },
});

/** Ask the React layer to open the emoji picker for a callout. */
export const CALLOUT_ICON_EVENT = 'nb:callout-icon';

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'inline*',
  defining: true,
  addAttributes() {
    return {
      icon: { default: '💡', parseHTML: (el) => el.getAttribute('data-icon') || '💡', renderHTML: (a) => ({ 'data-icon': a.icon }) },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'callout', class: 'nb nb-callout' }), 0];
  },
  addNodeView() {
    return controlView(
      'callout',
      (btn) => btn.setAttribute('aria-label', 'Change the callout’s icon'),
      (_dom, btn, n, editable) => {
        btn.textContent = n.attrs.icon || '💡';
        btn.disabled = !editable;
      },
      (_n, pos, editor, btn) => editor.view.dom.dispatchEvent(new CustomEvent(CALLOUT_ICON_EVENT, { detail: { pos, rect: btn.getBoundingClientRect() } })),
    ) as never;
  },
});

/* ───────────── Reading the block list ───────────── */

export interface TopBlock {
  node: PMNode;
  pos: number;
  index: number;
}

export const topBlocks = (doc: PMNode): TopBlock[] => {
  const out: TopBlock[] = [];
  doc.forEach((node, pos, index) => out.push({ node, pos, index }));
  return out;
};

export const indentOf = (n: PMNode) => Number(n.attrs.indent) || 0;

/** The block at the cursor (or the selected block). */
export function currentBlock(editor: Editor): TopBlock | null {
  const { selection, doc } = editor.state;
  const $from = selection.$from;
  const index = $from.depth === 0 ? $from.index(0) : $from.index(0);
  if (index >= doc.childCount) return null;
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return { node: doc.child(index), pos, index };
}

/** A block and the blocks nested under it (deeper indent right after it): they move together. */
export function groupRange(doc: PMNode, index: number) {
  const blocks = topBlocks(doc);
  const head = blocks[index]!;
  const d = indentOf(head.node);
  let end = index + 1;
  while (end < blocks.length && indentOf(blocks[end]!.node) > d) end++;
  const last = blocks[end - 1]!;
  return { from: head.pos, to: last.pos + last.node.nodeSize, start: index, end };
}

/* ───────────── Commands ───────────── */

const baseAttrs = (n: PMNode) => ({ bid: n.attrs.bid, indent: n.attrs.indent, color: n.attrs.color });

/** Change a text block's type, keeping its text, id, indent and colour. */
export function turnInto(editor: Editor, pos: number, typeName: string, attrs: Record<string, unknown> = {}) {
  const { state } = editor;
  const node = state.doc.nodeAt(pos);
  const type = state.schema.nodes[typeName];
  if (!node || !type || !node.isTextblock) return false;
  const tr = state.tr.setBlockType(pos + 1, pos + 1, type, { ...baseAttrs(node), ...attrs });
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

export function setIndentRange(editor: Editor, delta: number) {
  const { state } = editor;
  const { from, to } = state.selection;
  const blocks = topBlocks(state.doc).filter((b) => b.pos + b.node.nodeSize > from && b.pos <= to);
  if (!blocks.length) return false;
  const first = blocks[0]!;
  const prev = first.index > 0 ? state.doc.child(first.index - 1) : null;
  const limit = prev ? indentOf(prev) + 1 : 0;
  const shift = delta > 0 ? Math.min(delta, limit - indentOf(first.node)) : Math.max(delta, -indentOf(first.node));
  if (shift === 0) return true;
  const tr = state.tr;
  for (const b of blocks) tr.setNodeAttribute(b.pos, 'indent', Math.max(0, Math.min(MAX_INDENT, indentOf(b.node) + shift)));
  editor.view.dispatch(tr);
  return true;
}

/** Move a block (with what's nested under it) above or below its neighbour. */
export function moveGroup(editor: Editor, index: number, dir: -1 | 1) {
  const { state } = editor;
  const doc = state.doc;
  const g = groupRange(doc, index);
  const slice = doc.slice(g.from, g.to);
  const selOffset = state.selection.from - g.from;
  let target: number;
  if (dir < 0) {
    if (g.start === 0) return false;
    // Jump over the previous block and anything nested under it.
    const d = indentOf(doc.child(g.start));
    let s = g.start - 1;
    while (s > 0 && indentOf(doc.child(s)) > d) s--;
    target = topBlocks(doc)[s]!.pos;
  } else {
    if (g.end >= doc.childCount) return false;
    const next = groupRange(doc, g.end);
    target = next.to;
  }
  const tr = state.tr.delete(g.from, g.to);
  const at = tr.mapping.map(target, dir < 0 ? -1 : 1);
  tr.insert(at, slice.content);
  const sel = Math.min(at + Math.max(1, selOffset), tr.doc.content.size - 1);
  tr.setSelection(TextSelection.near(tr.doc.resolve(sel)));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** Drop a block (and what's nested under it) before block `target`, at a new base indent. */
export function moveGroupTo(editor: Editor, index: number, target: number, baseIndent: number) {
  const { state } = editor;
  const doc = state.doc;
  const g = groupRange(doc, index);
  if (target >= g.start && target <= g.end) return false;
  const blocks = topBlocks(doc);
  const targetPos = target >= blocks.length ? doc.content.size : blocks[target]!.pos;
  const shift = baseIndent - indentOf(doc.child(index));
  const nodes: PMNode[] = [];
  for (let i = g.start; i < g.end; i++) {
    const n = doc.child(i);
    nodes.push(n.type.create({ ...n.attrs, indent: Math.max(0, Math.min(MAX_INDENT, indentOf(n) + shift)) }, n.content, n.marks));
  }
  const tr = state.tr;
  let at: number;
  if (targetPos > g.from) {
    tr.insert(targetPos, nodes);
    tr.delete(g.from, g.to);
    at = targetPos - (g.to - g.from);
  } else {
    tr.delete(g.from, g.to);
    tr.insert(targetPos, nodes);
    at = targetPos;
  }
  const first = nodes[0]!;
  tr.setSelection(first.isTextblock ? TextSelection.create(tr.doc, at + 1 + first.content.size) : TextSelection.near(tr.doc.resolve(at)));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

export function duplicateGroup(editor: Editor, index: number) {
  const { state } = editor;
  const g = groupRange(state.doc, index);
  const slice = state.doc.slice(g.from, g.to);
  const tr = state.tr.insert(g.to, slice.content);
  editor.view.dispatch(tr);
  return true;
}

export function deleteGroup(editor: Editor, index: number) {
  const { state } = editor;
  const g = groupRange(state.doc, index);
  const tr = state.tr.delete(g.from, g.to);
  if (tr.doc.childCount === 0) tr.insert(0, state.schema.nodes.paragraph!.create({ bid: bid() }));
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(g.from, tr.doc.content.size))));
  editor.view.dispatch(tr);
  return true;
}

/** Insert blocks after a block (null: at the end, -1: at the top) and put the cursor in the first. */
export function insertAfter(editor: Editor, index: number | null, nodes: JSONContent[], opts: { focus?: boolean } = {}) {
  const { state } = editor;
  const doc = state.doc;
  const at = index === null || index >= doc.childCount ? doc.content.size : index < 0 ? 0 : groupRange(doc, index).to;
  const content = nodes.map((n) => state.schema.nodeFromJSON(n));
  const tr = state.tr.insert(at, content);
  const first = content[0]!;
  if (first.isTextblock) tr.setSelection(TextSelection.create(tr.doc, at + 1 + first.content.size));
  else {
    // An atom: keep a line after it to type on.
    const after = at + content.reduce((s, n) => s + n.nodeSize, 0);
    if (after >= tr.doc.content.size || !tr.doc.resolve(after).nodeAfter?.isTextblock) tr.insert(after, state.schema.nodes.paragraph!.create({ bid: bid() }));
    tr.setSelection(TextSelection.create(tr.doc, after + 1));
  }
  editor.view.dispatch(tr.scrollIntoView());
  if (opts.focus !== false) editor.view.focus();
}

/* ───────────── Keyboard ───────────── */

const LISTISH = ['bullet', 'numbered', 'todo'];
const RESETS_ON_ENTER = ['heading', 'quote', 'callout'];

function handleEnter(editor: Editor) {
  const { state } = editor;
  const { $from, empty } = state.selection;
  if (!empty || $from.depth !== 1) return false;
  const node = $from.parent;
  const name = node.type.name;
  if (name === 'codeBlock') return false;
  const indent = indentOf(node);
  const atEnd = $from.parentOffset === node.content.size;
  const index = $from.index(0);

  // An empty list item, toggle, quote or callout: step out of it, like Notion.
  if (name !== 'paragraph' && name !== 'heading' && node.content.size === 0) {
    if (indent > 0 && name !== 'callout') return editor.commands.command(({ tr }) => (tr.setNodeAttribute($from.before(), 'indent', indent - 1), true));
    return turnInto(editor, $from.before(), 'paragraph');
  }
  if (!atEnd) {
    // Split; the new half keeps the type (a heading's tail becomes a heading too).
    return editor.chain().splitBlock().run();
  }

  const p = state.schema.nodes.paragraph!;
  let type: NodeType = node.type;
  let attrs: Record<string, unknown> = { indent };
  if (name === 'paragraph' || RESETS_ON_ENTER.includes(name)) type = p;
  if (name === 'toggle') {
    type = p;
    if (node.attrs.open !== false) attrs = { indent: indent + 1 };
    else {
      // Closed: the new line goes after what's folded inside it.
      const g = groupRange(state.doc, index);
      const tr = state.tr.insert(g.to, p.create({ bid: bid(), indent }));
      tr.setSelection(TextSelection.create(tr.doc, g.to + 1));
      editor.view.dispatch(tr.scrollIntoView());
      return true;
    }
  }
  if (LISTISH.includes(name)) attrs = { indent, ...(name === 'todo' ? { checked: false } : {}) };
  const at = $from.after();
  const tr = state.tr.insert(at, type.create({ ...attrs, bid: bid() }));
  tr.setSelection(TextSelection.create(tr.doc, at + 1));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

function handleBackspace(editor: Editor) {
  const { state } = editor;
  const { $from, empty } = state.selection;
  if (!empty || $from.depth !== 1 || $from.parentOffset !== 0) return false;
  const node = $from.parent;
  const name = node.type.name;
  if (name === 'codeBlock') return node.content.size === 0 ? turnInto(editor, $from.before(), 'paragraph') : false;
  if (name !== 'paragraph') return turnInto(editor, $from.before(), 'paragraph');
  if (indentOf(node) > 0) return editor.commands.command(({ tr }) => (tr.setNodeAttribute($from.before(), 'indent', indentOf(node) - 1), true));
  return false;
}

const TURN_KEYS: [string, string, Record<string, unknown>?][] = [
  ['Mod-Alt-0', 'paragraph'],
  ['Mod-Alt-1', 'heading', { level: 1 }],
  ['Mod-Alt-2', 'heading', { level: 2 }],
  ['Mod-Alt-3', 'heading', { level: 3 }],
  ['Mod-Alt-4', 'todo', { checked: false }],
  ['Mod-Alt-5', 'bullet'],
  ['Mod-Alt-6', 'numbered'],
  ['Mod-Alt-7', 'toggle', { open: true }],
  ['Mod-Alt-8', 'codeBlock'],
];

/* ───────────── Markdown shortcuts ───────────── */

function blockRule(find: RegExp, typeName: string, attrs: Record<string, unknown> = {}) {
  return new InputRule({
    find,
    handler: ({ state, range }) => {
      const $from = state.doc.resolve(range.from);
      const node = $from.parent;
      if ($from.depth !== 1 || node.type.name !== 'paragraph') return null;
      const type = state.schema.nodes[typeName];
      if (!type) return null;
      state.tr.delete(range.from, range.to).setBlockType(range.from, range.from, type, { ...baseAttrs(node), ...attrs });
    },
  });
}

/* ───────────── The extension ───────────── */

const decoKey = new PluginKey('nbDecorations');
const idKey = new PluginKey('nbIds');

function decorations(doc: PMNode) {
  const decos: Decoration[] = [];
  const counters: number[] = [];
  let closedAt: number | null = null;
  const blocks = topBlocks(doc);
  blocks.forEach(({ node, pos }, i) => {
    const d = indentOf(node);
    const end = pos + node.nodeSize;
    // Folded inside a closed toggle.
    if (closedAt !== null && d > closedAt) {
      decos.push(Decoration.node(pos, end, { class: 'nb-hidden' }));
      return;
    }
    closedAt = node.type.name === 'toggle' && node.attrs.open === false ? d : null;
    // List numbers.
    counters.length = Math.min(counters.length, d + 1);
    if (node.type.name === 'numbered') {
      counters[d] = (counters[d] ?? 0) + 1;
      decos.push(Decoration.node(pos, end, { 'data-n': numberLabel(counters[d]!, d) }));
    } else counters[d] = 0;
    // An open toggle with nothing inside it says how to add something.
    if (node.type.name === 'toggle' && node.attrs.open !== false) {
      const next = blocks[i + 1];
      if (!next || indentOf(next.node) <= d) decos.push(Decoration.node(pos, end, { 'data-empty-toggle': 'true' }));
    }
  });
  return DecorationSet.create(doc, decos);
}

export const Blocks = Extension.create({
  name: 'nbBlocks',
  priority: 1100,

  addKeyboardShortcuts() {
    const e = () => this.editor;
    const shortcuts: Record<string, () => boolean> = {
      Enter: () => handleEnter(e()),
      Backspace: () => handleBackspace(e()),
      Tab: () => {
        const b = currentBlock(e());
        if (b?.node.type.name === 'codeBlock') return e().commands.insertContent('  ');
        return setIndentRange(e(), 1);
      },
      'Shift-Tab': () => setIndentRange(e(), -1),
      'Mod-Shift-ArrowUp': () => {
        const b = currentBlock(e());
        return b ? moveGroup(e(), b.index, -1) : false;
      },
      'Mod-Shift-ArrowDown': () => {
        const b = currentBlock(e());
        return b ? moveGroup(e(), b.index, 1) : false;
      },
      'Mod-d': () => {
        const b = currentBlock(e());
        return b ? duplicateGroup(e(), b.index) : false;
      },
    };
    for (const [key, type, attrs] of TURN_KEYS)
      shortcuts[key] = () => {
        const b = currentBlock(e());
        return b ? turnInto(e(), b.pos, type, attrs) : false;
      };
    return shortcuts;
  },

  addInputRules() {
    return [
      blockRule(/^#\s$/, 'heading', { level: 1 }),
      blockRule(/^##\s$/, 'heading', { level: 2 }),
      blockRule(/^###\s$/, 'heading', { level: 3 }),
      blockRule(/^[-*+•]\s$/, 'bullet'),
      blockRule(/^\d+[.)]\s$/, 'numbered'),
      blockRule(/^\[ ?\]\s$/, 'todo', { checked: false }),
      blockRule(/^\[x\]\s$/i, 'todo', { checked: true }),
      blockRule(/^>\s$/, 'toggle', { open: true }),
      blockRule(/^["“]\s$/, 'quote'),
      blockRule(/^```$/, 'codeBlock'),
    ];
  },

  addProseMirrorPlugins() {
    return [
      // Every block keeps a unique id (splits and pastes copy attributes).
      new Plugin({
        key: idKey,
        appendTransaction: (trs, _old, state) => {
          if (!trs.some((t) => t.docChanged)) return null;
          const seen = new Set<string>();
          let tr = null as ReturnType<typeof state.tr.setNodeAttribute> | null;
          state.doc.forEach((node, pos) => {
            if (!('bid' in node.attrs)) return;
            const id = node.attrs.bid as string | null;
            if (!id || seen.has(id)) {
              tr = (tr ?? state.tr).setNodeAttribute(pos, 'bid', bid());
            } else seen.add(id);
          });
          return tr;
        },
      }),
      new Plugin({
        key: decoKey,
        state: {
          init: (_c, state) => decorations(state.doc),
          apply: (tr, old) => (tr.docChanged ? decorations(tr.doc) : old),
        },
        props: {
          decorations(state) {
            return decoKey.getState(state) as DecorationSet;
          },
        },
      }),
    ];
  },
});
