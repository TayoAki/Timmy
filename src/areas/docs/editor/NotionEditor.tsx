/*
 * Timmy's block editor. Type "/" for blocks, select text to format it, hover a
 * block for its + and ⋮⋮ handle (drag to move, click for options). Edits save
 * 850 ms after you stop typing, as blocks Timmy can read.
 */
import { Highlight } from '@tiptap/extension-highlight';
import { CodeBlock } from '@tiptap/extension-code-block';
import { Heading } from '@tiptap/extension-heading';
import { HorizontalRule } from '@tiptap/extension-horizontal-rule';
import { Color, TextStyle } from '@tiptap/extension-text-style';
import { Placeholder } from '@tiptap/extensions';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { GripVertical, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { Block } from '../../../data/ws-types';
import { bid } from '../templates';
import type { EditorActions } from './catalog';
import { fromDoc, sameBlocks, toDoc } from './convert';
import { BlockAttrs, Blocks, Bullet, CALLOUT_ICON_EVENT, Callout, Numbered, Quote, Todo, Toggle, groupRange, indentOf, insertAfter, moveGroupTo, topBlocks } from './extensions';
import { BlockMenu, BubbleBar, SlashMenu } from './menus';
import { DocEditorContext, FileLinkNode, ImageNode, LinkedTableNode, PageLinkNode, TableNode } from './nodeviews';
import { EmojiPicker, anchorOf, type Anchor } from './Popover';
import { createSlashBus, SlashCommand } from './slash';
import { setSaveState } from './status';
import { joinRoom, RemoteCursors } from './presence';
import { timmyLines } from '../../../lib/blocks';
import { insertTimmyLines, timmyAdditions } from './timmy-lines';

const INDENT_PX = 26;
const SAVE_MS = 850;

const PLACEHOLDER: Record<string, string> = {
  heading: 'Heading',
  bullet: 'List',
  numbered: 'List',
  todo: 'To-do',
  toggle: 'Toggle',
  quote: 'Empty quote',
  callout: 'Type something…',
};

export interface EditorHandle {
  editor: Editor | null;
  /** Save now (before navigating away, or before changing blocks from outside). */
  flush: () => void;
}

/** What the block handle points at. */
interface Hover {
  index: number;
  top: number;
  left: number;
}

export function NotionEditor({
  docId,
  blocks,
  readOnly,
  onSave,
  actions,
  onOpenBlock,
  handle,
  toast,
  onRemoteBlocks,
}: {
  docId: string;
  blocks: Block[];
  readOnly: boolean;
  /** `base`: the lines Timmy added that the copy this save was made from had. One of them missing from the save was taken out on purpose. */
  onSave: (blocks: Block[], base: string[]) => void;
  actions: EditorActions;
  /** Blocks that point somewhere (files, sheets, pages) get an "Open" item. */
  onOpenBlock: (type: string, attrs: Record<string, unknown>) => { label: string; run: () => void } | undefined;
  handle: MutableRefObject<EditorHandle>;
  toast: (text: string) => void;
  /** This doc was saved in another tab. */
  onRemoteBlocks: (blocks: Block[]) => void;
}) {
  const bus = useMemo(createSlashBus, []);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const lastSaved = useRef(blocks);
  const timer = useRef<number | undefined>(undefined);
  const publish = useRef<(b: Block[]) => void>(() => undefined);
  const remoteRef = useRef(onRemoteBlocks);
  remoteRef.current = onRemoteBlocks;

  const editor = useEditor({
    editable: !readOnly,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        horizontalRule: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        dropcursor: false,
        trailingNode: false,
        link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } },
      }),
      Heading.extend({ addInputRules: () => [] }).configure({ levels: [1, 2, 3] }),
      CodeBlock.extend({ addInputRules: () => [] }),
      HorizontalRule,
      Bullet,
      Numbered,
      Quote,
      Todo,
      Toggle,
      Callout,
      ImageNode,
      TableNode,
      LinkedTableNode,
      FileLinkNode,
      PageLinkNode,
      BlockAttrs,
      Blocks,
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      Placeholder.configure({
        includeChildren: false,
        showOnlyCurrent: true,
        placeholder: ({ node, editor: e }) =>
          node.type.name === 'paragraph'
            ? e.state.doc.childCount === 1
              ? 'Write something, or press “/” for blocks…'
              : 'Press “/” for blocks'
            : node.type.name === 'heading'
              ? `Heading ${node.attrs.level}`
              : (PLACEHOLDER[node.type.name] ?? ''),
      }),
      SlashCommand.configure({ bus, actions: () => actionsRef.current }),
      RemoteCursors,
    ],
    content: toDoc(blocks),
    editorProps: {
      attributes: { class: 'nb-editor', 'aria-label': 'Page content', spellcheck: 'true' },
    },
    onUpdate: ({ transaction }) => {
      // setEditable() also reports an "update"; only real edits count.
      if (!transaction.docChanged) return;
      setSaveState(docId, 'saving');
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => flush(), SAVE_MS);
    },
  });

  const flush = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    if (!editor || editor.isDestroyed) return;
    const next = fromDoc(editor.getJSON());
    if (!sameBlocks(next, lastSaved.current)) {
      const base = timmyLines(lastSaved.current);
      lastSaved.current = next;
      saveRef.current(next, base);
      publish.current(next);
    }
    setSaveState(docId, 'saved');
  };
  handle.current = { editor, flush };

  // Save on the way out.
  useEffect(() => {
    const out = () => timer.current !== undefined && flush();
    window.addEventListener('pagehide', out);
    return () => {
      window.removeEventListener('pagehide', out);
      out();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // The same doc open in another tab: share cursors and saves.
  useEffect(() => {
    if (!editor || readOnly) return;
    const room = joinRoom(docId, editor, (b) => remoteRef.current(b));
    publish.current = room.publish;
    return () => {
      publish.current = () => undefined;
      room.leave();
    };
  }, [editor, docId, readOnly]);

  // Changes from outside (Timmy, undo, the 1:1 row button) replace what's shown.
  useEffect(() => {
    if (!editor || editor.isDestroyed || blocks === lastSaved.current) return;
    // On a real workspace this tab's own save comes back from the server as a new copy of the same blocks. That is
    // not a change from outside: replacing what is shown would throw away whatever was typed since the save went.
    const ownSave = sameBlocks(blocks, lastSaved.current);
    const cur = fromDoc(editor.getJSON());
    const before = lastSaved.current;
    lastSaved.current = blocks;
    if (ownSave || sameBlocks(cur, blocks)) return;
    // Only lines Timmy added (an automation's “Add to a doc”) while something typed here isn't saved yet: they go in
    // beside it, and the typing stays to be saved with them.
    const added = timer.current !== undefined ? timmyAdditions(before, blocks) : null;
    if (added) {
      insertTimmyLines(editor, added);
      return;
    }
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const { from } = editor.state.selection;
    editor.commands.setContent(toDoc(blocks), { emitUpdate: false });
    const max = editor.state.doc.content.size;
    editor.commands.setTextSelection(Math.max(1, Math.min(from, max - 1)));
    setSaveState(docId, 'saved');
  }, [blocks, editor, docId]);

  useEffect(() => {
    if (editor && editor.isEditable === readOnly) editor.setEditable(!readOnly, false);
  }, [editor, readOnly]);

  /* ── The handle: + and ⋮⋮ beside the hovered block ── */

  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [menu, setMenu] = useState<{ index: number; anchor: Anchor } | null>(null);
  const [drop, setDrop] = useState<{ top: number; left: number; target: number; indent: number } | null>(null);
  const dragging = useRef<number | null>(null);
  const [calloutPick, setCalloutPick] = useState<{ pos: number; anchor: Anchor } | null>(null);

  const visibleBlocks = () => {
    if (!editor) return [];
    return topBlocks(editor.state.doc)
      .map((b) => ({ ...b, dom: editor.view.nodeDOM(b.pos) as HTMLElement | null }))
      .filter((b): b is typeof b & { dom: HTMLElement } => !!b.dom && b.dom.nodeType === 1 && !b.dom.classList.contains('nb-hidden'));
  };

  const locate = (y: number) => {
    const list = visibleBlocks();
    if (!list.length) return null;
    let best = list[0]!;
    for (const b of list) {
      const r = b.dom.getBoundingClientRect();
      if (y >= r.top - 3) best = b;
      else break;
    }
    return best;
  };

  const onMove = (e: React.MouseEvent) => {
    if (!editor || readOnly || dragging.current !== null || menu) return;
    const w = wrap.current;
    if (!w) return;
    const b = locate(e.clientY);
    if (!b) return setHover(null);
    const wr = w.getBoundingClientRect();
    const r = b.dom.getBoundingClientRect();
    let top = r.top + 2;
    if (b.node.isTextblock) {
      const text = (b.dom.querySelector(':scope > .nb-content') as HTMLElement | null) ?? b.dom;
      const cs = getComputedStyle(text);
      const lh = parseFloat(cs.lineHeight) || 24;
      top = text.getBoundingClientRect().top + (parseFloat(cs.paddingTop) || 0) + lh / 2 - 12;
    }
    setHover({ index: b.index, top: top - wr.top, left: r.left - wr.left - 50 });
  };

  const addBelow = (index: number, above: boolean) => {
    if (!editor) return;
    const node = editor.state.doc.child(index);
    const attrs = { bid: bid(), indent: node.type.name === 'toggle' && node.attrs.open !== false && !above ? indentOf(node) + 1 : indentOf(node) };
    insertAfter(editor, above ? index - 1 : node.type.name === 'toggle' && node.attrs.open !== false ? index : groupRange(editor.state.doc, index).end - 1, [
      { type: 'paragraph', attrs, content: [{ type: 'text', text: '/' }] },
    ]);
    setHover(null);
  };

  const onDragOver = (e: React.DragEvent) => {
    if (dragging.current === null || !editor || !wrap.current) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const list = visibleBlocks();
    const wr = wrap.current.getBoundingClientRect();
    let target = editor.state.doc.childCount;
    let top = 0;
    let above: (typeof list)[number] | undefined;
    for (const b of list) {
      const r = b.dom.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        target = b.index;
        top = r.top - wr.top - 2;
        break;
      }
      above = b;
      top = r.bottom - wr.top + 1;
    }
    if (target === editor.state.doc.childCount && above) {
      // After the last visible block: skip past anything folded inside it.
      target = groupRange(editor.state.doc, above.index).end;
    }
    const g = groupRange(editor.state.doc, dragging.current);
    if (target >= g.start && target <= g.end) return setDrop(null);
    const indent = above ? indentOf(above.node) + (above.node.type.name === 'toggle' && above.node.attrs.open !== false ? 1 : 0) : 0;
    const left = (list[0]?.dom.getBoundingClientRect().left ?? wr.left) - wr.left + indent * INDENT_PX;
    setDrop({ top, left, target, indent });
  };

  const endDrag = () => {
    dragging.current = null;
    setDrop(null);
    wrap.current?.querySelectorAll('.nb-dragging').forEach((el) => el.classList.remove('nb-dragging'));
  };

  const onDrop = (e: React.DragEvent) => {
    if (dragging.current === null || !editor) return;
    e.preventDefault();
    e.stopPropagation();
    if (drop) moveGroupTo(editor, dragging.current, drop.target, drop.indent);
    endDrag();
  };

  const startDrag = (e: React.DragEvent) => {
    if (!editor || !hover) return;
    dragging.current = hover.index;
    setMenu(null);
    const g = groupRange(editor.state.doc, hover.index);
    const doms = visibleBlocks().filter((b) => b.index >= g.start && b.index < g.end);
    doms.forEach((b) => b.dom.classList.add('nb-dragging'));
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-timmy-block', String(hover.index));
    if (doms[0]) e.dataTransfer.setDragImage(doms[0].dom, 12, 12);
  };

  // A callout's emoji opens the picker.
  useEffect(() => {
    const dom = editor?.view.dom;
    if (!dom) return;
    const open = (e: Event) => {
      const d = (e as CustomEvent<{ pos: number; rect: DOMRect }>).detail;
      setCalloutPick({ pos: d.pos, anchor: anchorOf(d.rect) });
    };
    dom.addEventListener(CALLOUT_ICON_EVENT, open);
    return () => dom.removeEventListener(CALLOUT_ICON_EVENT, open);
  }, [editor]);

  // Mark the block whose menu is open.
  useEffect(() => {
    if (!editor || !menu) return;
    const b = visibleBlocks().find((x) => x.index === menu.index);
    b?.dom.classList.add('nb-picked');
    return () => b?.dom.classList.remove('nb-picked');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, editor]);

  const menuNode = menu && editor ? editor.state.doc.maybeChild(menu.index) : null;

  return (
    <DocEditorContext.Provider value={{ readOnly, toast }}>
      <div
        ref={wrap}
        className={`nb-wrap${readOnly ? ' readonly' : ''}`}
        onMouseMove={onMove}
        onMouseLeave={() => !menu && setHover(null)}
        onKeyDown={() => hover && setHover(null)}
        onDragOverCapture={onDragOver}
        onDropCapture={onDrop}
        onClick={(e) => {
          // A click in the empty space below the last block puts the cursor at the end
          // (on a new line if the page ends with a table, file or picture).
          if (e.target !== wrap.current || !editor || readOnly) return;
          const last = editor.state.doc.lastChild;
          if (last && !last.isTextblock) insertAfter(editor, null, [{ type: 'paragraph', attrs: { bid: bid() } }]);
          else editor.commands.focus('end');
        }}
      >
        <EditorContent editor={editor} />
        {hover && !readOnly && (
          <div className="nb-gutter" style={{ top: hover.top, left: hover.left }}>
            <button
              className="nb-gutter-btn"
              aria-label="Add a block below"
              title="Click to add below · Alt-click to add above"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => addBelow(hover.index, e.altKey)}
            >
              <Plus size={16} />
            </button>
            <button
              className="nb-gutter-btn grip"
              aria-label="Block options. Drag to move."
              title="Drag to move · Click for options"
              draggable
              onDragStart={startDrag}
              onDragEnd={endDrag}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => setMenu({ index: hover.index, anchor: anchorOf(e.currentTarget.getBoundingClientRect()) })}
            >
              <GripVertical size={16} />
            </button>
          </div>
        )}
        {drop && <div className="nb-drop-line" style={{ top: drop.top, left: drop.left }} aria-hidden />}
      </div>
      {editor && !readOnly && <BubbleBar editor={editor} />}
      <SlashMenu bus={bus} />
      {menu && editor && menuNode && (
        <BlockMenu
          editor={editor}
          index={menu.index}
          anchor={menu.anchor}
          onOpen={onOpenBlock(menuNode.type.name, menuNode.attrs)}
          onClose={() => {
            setMenu(null);
            setHover(null);
          }}
        />
      )}
      {calloutPick && editor && (
        <EmojiPicker
          anchor={calloutPick.anchor}
          onClose={() => setCalloutPick(null)}
          onPick={(emoji) => {
            editor.view.dispatch(editor.state.tr.setNodeAttribute(calloutPick.pos, 'icon', emoji));
            setCalloutPick(null);
          }}
        />
      )}
    </DocEditorContext.Provider>
  );
}
