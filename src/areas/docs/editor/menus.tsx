/*
 * The editor's menus: the "/" menu, the formatting bar that appears over a
 * selection, and the block menu behind each block's handle.
 */
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpRight,
  Baseline,
  Bold,
  Check,
  ChevronDown,
  ChevronRight,
  Code,
  Copy,
  Italic,
  Link2,
  Link2Off,
  Palette,
  Repeat2,
  Strikethrough,
  Trash2,
  Underline,
} from 'lucide-react';
import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { portalRoot, toRoot } from '../../../lib/portal';
import type { BlockColor } from '../../../data/ws-types';
import { KINDS, TURN_INTO, kindOfNode, type BlockKind } from './catalog';
import { currentBlock, deleteGroup, duplicateGroup, moveGroup, turnInto } from './extensions';
import { Popover, type Anchor } from './Popover';
import type { SlashBus } from './slash';

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
/** A shortcut in the platform's own words: ⌘D on a Mac, Ctrl+D elsewhere. */
export const keys = (k: string) => (MAC ? k : k.replace('⌘⇧', 'Ctrl+Shift+').replace('⌘', 'Ctrl+'));

/* ───────────── Colours ───────────── */

export const COLORS: { id: string; label: string }[] = [
  { id: 'gray', label: 'Gray' },
  { id: 'brown', label: 'Brown' },
  { id: 'orange', label: 'Orange' },
  { id: 'yellow', label: 'Yellow' },
  { id: 'green', label: 'Green' },
  { id: 'blue', label: 'Blue' },
  { id: 'purple', label: 'Purple' },
  { id: 'pink', label: 'Pink' },
  { id: 'red', label: 'Red' },
];

function ColorList({ value, onPick }: { value: string | null; onPick: (c: string | null) => void }) {
  const row = (id: string | null, label: string, bg: boolean) => (
    <button key={label} className="nb-menu-item" role="menuitemradio" aria-checked={value === id} onClick={() => onPick(id)}>
      <span className={`nb-swatch${bg ? ' bg' : ''}`} data-color={id ?? undefined} aria-hidden>
        A
      </span>
      <span className="nb-menu-label">{label}</span>
      {value === id && <Check size={14} aria-hidden className="nb-menu-tick" />}
    </button>
  );
  return (
    <div role="menu">
      <h4 className="nb-pop-title">Text colour</h4>
      {row(null, 'Default', false)}
      {COLORS.map((c) => row(c.id, c.label, false))}
      <h4 className="nb-pop-title">Background</h4>
      {COLORS.map((c) => row(`${c.id}-bg`, `${c.label} background`, true))}
    </div>
  );
}

/* ───────────── "/" menu ───────────── */

export function SlashMenu({ bus }: { bus: SlashBus }) {
  const s = useSyncExternalStore(bus.subscribe, bus.get);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [s.index]);
  if (!s.open || !s.rect) return null;
  const vh = window.innerHeight;
  const up = s.rect.bottom + 340 > vh && s.rect.top > 360;
  // In the film's camera, the menu is placed in the camera's own coordinates.
  const at = toRoot(Math.min(s.rect.left, window.innerWidth - 330), s.rect.top);
  const below = toRoot(s.rect.left, s.rect.bottom);
  let lastGroup = '';
  return createPortal(
    <div
      className="nb-pop nb-slash"
      role="listbox"
      aria-label="Blocks"
      style={{ left: at.x, ...(up ? { bottom: vh - at.y + 6 } : { top: below.y + 6 }) }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div ref={list} className="nb-slash-list">
        {s.items.length === 0 && <p className="nb-pop-empty">No blocks match “{s.query}”</p>}
        {s.items.map((k, i) => {
          const head = k.group !== lastGroup ? (lastGroup = k.group) : null;
          return (
            <Fragment key={k.id}>
              {head && <h4 className="nb-pop-title">{head}</h4>}
              <button
                className="nb-slash-item"
                role="option"
                aria-selected={i === s.index}
                onMouseEnter={() => bus.set({ index: i })}
                onClick={() => s.pick?.(k)}
              >
                <span className="nb-slash-icon" aria-hidden>
                  <k.icon size={18} />
                </span>
                <span className="nb-slash-text">
                  <span className="nb-slash-label">{k.label}</span>
                  <span className="nb-slash-hint">{k.hint}</span>
                </span>
                {k.md && <kbd className="nb-slash-md">{k.md}</kbd>}
              </button>
            </Fragment>
          );
        })}
      </div>
      <div className="nb-slash-foot">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> to choose
        </span>
        <span>
          <kbd>Enter</kbd> to add
        </span>
        <span>
          <kbd>Esc</kbd> to close
        </span>
      </div>
    </div>,
    portalRoot(),
  );
}

/* ───────────── Formatting bar ───────────── */

export function BubbleBar({ editor }: { editor: Editor }) {
  const [mode, setMode] = useState<'main' | 'link'>('main');
  const [href, setHref] = useState('');
  const [pop, setPop] = useState<null | { kind: 'turn' | 'color'; anchor: Anchor }>(null);
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const b = currentBlock(e);
      return {
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        underline: e.isActive('underline'),
        strike: e.isActive('strike'),
        code: e.isActive('code'),
        link: e.isActive('link'),
        href: (e.getAttributes('link').href as string | undefined) ?? '',
        color: (e.getAttributes('textStyle').color as string | undefined) ?? null,
        highlight: (e.getAttributes('highlight').color as string | undefined) ?? null,
        kind: b ? kindOfNode(b.node.type.name, b.node.attrs) : 'p',
      };
    },
  });
  const kind = KINDS.find((k) => k.id === st.kind);
  const colorId = st.highlight ? st.highlight.match(/--nb-([a-z]+-bg)/)?.[1] ?? null : st.color ? st.color.match(/--nb-([a-z]+)\)/)?.[1] ?? null : null;

  const applyLink = () => {
    const u = href.trim();
    if (!u) editor.chain().focus().extendMarkRange('link').unsetLink().run();
    else editor.chain().focus().extendMarkRange('link').setLink({ href: /^[a-z]+:/i.test(u) ? u : `https://${u}` }).run();
    setMode('main');
  };

  const btn = (on: boolean, label: string, Icon: typeof Bold, run: () => void, key?: string) => (
    <button className="nb-bb-btn" aria-pressed={on} aria-label={label} title={key ? `${label} (${keys(key)})` : label} onClick={run}>
      <Icon size={15} strokeWidth={on ? 2.6 : 2} />
    </button>
  );

  return (
    <BubbleMenu
      editor={editor}
      className="nb-bubble"
      options={{ placement: 'top', offset: 8, onHide: () => (setMode('main'), setPop(null)) }}
      shouldShow={({ editor: e, state, from, to }) => {
        if (!e.isEditable || from === to || !e.isFocused) return false;
        const $f = state.doc.resolve(from);
        if ($f.parent.type.name === 'codeBlock' || !$f.parent.isTextblock) return false;
        return state.doc.textBetween(from, to).trim().length > 0;
      }}
    >
      {mode === 'link' ? (
        <form
          className="nb-bb-link"
          onSubmit={(e) => {
            e.preventDefault();
            applyLink();
          }}
        >
          <Link2 size={14} aria-hidden />
          <input
            autoFocus
            className="nb-bb-input"
            placeholder="Paste a link"
            value={href}
            aria-label="Link address"
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), setMode('main'), editor.commands.focus())}
          />
          <button className="nb-bb-btn text" type="submit">
            {href.trim() ? 'Apply' : 'Remove'}
          </button>
        </form>
      ) : (
        <div className="nb-bb-row" onMouseDown={(e) => e.target instanceof HTMLInputElement || e.preventDefault()}>
          <button className="nb-bb-btn text" onClick={(e) => setPop({ kind: 'turn', anchor: e.currentTarget.getBoundingClientRect() })} aria-haspopup="menu" title="Turn into">
            {kind?.label ?? 'Text'}
            <ChevronDown size={13} aria-hidden />
          </button>
          <span className="nb-bb-sep" aria-hidden />
          {btn(st.bold, 'Bold', Bold, () => editor.chain().focus().toggleBold().run(), '⌘B')}
          {btn(st.italic, 'Italic', Italic, () => editor.chain().focus().toggleItalic().run(), '⌘I')}
          {btn(st.underline, 'Underline', Underline, () => editor.chain().focus().toggleUnderline().run(), '⌘U')}
          {btn(st.strike, 'Strikethrough', Strikethrough, () => editor.chain().focus().toggleStrike().run(), '⌘⇧S')}
          {btn(st.code, 'Inline code', Code, () => editor.chain().focus().toggleCode().run(), '⌘E')}
          <span className="nb-bb-sep" aria-hidden />
          {btn(st.link, st.link ? 'Edit link' : 'Add link', st.link ? Link2Off : Link2, () => {
            setHref(st.href);
            setMode('link');
          })}
          <button className="nb-bb-btn" aria-label="Colour" title="Colour" aria-haspopup="menu" onClick={(e) => setPop({ kind: 'color', anchor: e.currentTarget.getBoundingClientRect() })}>
            <Baseline size={15} style={colorId ? { color: `var(--nb-${colorId.replace('-bg', '')})` } : undefined} />
            <ChevronDown size={11} aria-hidden />
          </button>
        </div>
      )}
      {pop?.kind === 'turn' && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} className="nb-menu" label="Turn into" keepFocus>
          <TurnIntoList
            current={st.kind}
            onPick={(k) => {
              const b = currentBlock(editor);
              if (b && k.node) turnInto(editor, b.pos, k.node.type, k.node.attrs);
              setPop(null);
              editor.commands.focus();
            }}
          />
        </Popover>
      )}
      {pop?.kind === 'color' && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} className="nb-menu" label="Colour" keepFocus>
          <ColorList
            value={colorId}
            onPick={(c) => {
              const ch = editor.chain().focus().unsetColor().unsetHighlight();
              if (c?.endsWith('-bg')) ch.setHighlight({ color: `var(--nb-${c})` });
              else if (c) ch.setColor(`var(--nb-${c})`);
              ch.run();
              setPop(null);
            }}
          />
        </Popover>
      )}
    </BubbleMenu>
  );
}

function TurnIntoList({ current, onPick }: { current: string; onPick: (k: BlockKind) => void }) {
  return (
    <div role="menu">
      <h4 className="nb-pop-title">Turn into</h4>
      {TURN_INTO.map((k) => (
        <button key={k.id} className="nb-menu-item" role="menuitemradio" aria-checked={k.id === current} onClick={() => onPick(k)}>
          <k.icon size={15} aria-hidden />
          <span className="nb-menu-label">{k.label}</span>
          {k.id === current && <Check size={14} aria-hidden className="nb-menu-tick" />}
        </button>
      ))}
    </div>
  );
}

/* ───────────── Block menu (the ⋮⋮ handle) ───────────── */

export function BlockMenu({
  editor,
  index,
  anchor,
  onClose,
  onOpen,
}: {
  editor: Editor;
  index: number;
  anchor: Anchor;
  onClose: () => void;
  /** For blocks that point somewhere (a file, a sheet, a page). */
  onOpen?: { label: string; run: () => void };
}) {
  const [view, setView] = useState<'main' | 'turn' | 'color'>('main');
  const node = editor.state.doc.maybeChild(index);
  if (!node) return null;
  let pos = 0;
  for (let i = 0; i < index; i++) pos += editor.state.doc.child(i).nodeSize;
  const isText = node.isTextblock;
  const kind = kindOfNode(node.type.name, node.attrs);
  const label = KINDS.find((k) => k.id === kind)?.label ?? ({ horizontalRule: 'Divider', image: 'Image', table: 'Table', linkedTable: 'Linked table', fileLink: 'File link', pageLink: 'Page' } as Record<string, string>)[node.type.name] ?? 'Block';
  const done = (f: () => void) => () => {
    f();
    onClose();
    editor.commands.focus();
  };
  const item = (Icon: typeof Copy, text: string, run: () => void, opts: { kbd?: string; danger?: boolean; disabled?: boolean; more?: boolean } = {}) => (
    <button className={`nb-menu-item${opts.danger ? ' danger' : ''}`} role="menuitem" onClick={run} disabled={opts.disabled}>
      <Icon size={15} aria-hidden />
      <span className="nb-menu-label">{text}</span>
      {opts.kbd && <kbd className="nb-menu-kbd">{keys(opts.kbd)}</kbd>}
      {opts.more && <ChevronRight size={14} aria-hidden className="nb-menu-tick" />}
    </button>
  );

  return (
    <Popover anchor={anchor} onClose={onClose} className="nb-menu" label={`${label} options`}>
      {view === 'main' && (
        <div role="menu">
          <h4 className="nb-pop-title">{label}</h4>
          {onOpen && item(ArrowUpRight, onOpen.label, done(onOpen.run))}
          {isText && item(Repeat2, 'Turn into', () => setView('turn'), { more: true })}
          {isText && item(Palette, 'Colour', () => setView('color'), { more: true })}
          {item(Copy, 'Duplicate', done(() => duplicateGroup(editor, index)), { kbd: '⌘D' })}
          {item(ArrowUp, 'Move up', done(() => moveGroup(editor, index, -1)), { kbd: '⌘⇧↑', disabled: index === 0 })}
          {item(ArrowDown, 'Move down', done(() => moveGroup(editor, index, 1)), { kbd: '⌘⇧↓', disabled: index >= editor.state.doc.childCount - 1 })}
          <div className="nb-menu-sep" />
          {item(Trash2, 'Delete', done(() => deleteGroup(editor, index)), { kbd: 'Del', danger: true })}
        </div>
      )}
      {view !== 'main' && (
        <button className="nb-menu-back" onClick={() => setView('main')}>
          <ArrowLeft size={14} aria-hidden />
          Back
        </button>
      )}
      {view === 'turn' && <TurnIntoList current={kind} onPick={(k) => done(() => k.node && turnInto(editor, pos, k.node.type, k.node.attrs))()} />}
      {view === 'color' && (
        <ColorList
          value={(node.attrs.color as BlockColor | null) ?? null}
          onPick={(c) => done(() => editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'color', c)))()}
        />
      )}
    </Popover>
  );
}
