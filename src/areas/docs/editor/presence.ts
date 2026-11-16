/*
 * Who else is on this page, and where their cursor is. Two real sources, no
 * pretend collaborators: Timmy while it writes into the page, and this doc
 * open in another tab of this browser (kept in sync through a
 * BroadcastChannel). Other people join once there's a server to relay them.
 */
import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { useSyncExternalStore } from 'react';
import type { Block } from '../../../data/ws-types';
import { LIVE } from '../../../live/config';

export interface RemoteCursor {
  id: string;
  name: string;
  color: string;
  from: number;
  to: number;
  /** Keep the name tag showing (Timmy while it writes); otherwise it shows on hover. */
  tag?: boolean;
}

type Meta = { set: RemoteCursor } | { remove: string };

const cursorKey = new PluginKey<RemoteCursor[]>('remoteCursors');

function caret(c: RemoteCursor) {
  const el = document.createElement('span');
  el.className = `nb-caret${c.tag ? ' tagged' : ''}`;
  el.style.setProperty('--c', c.color);
  el.setAttribute('aria-hidden', 'true');
  const tag = document.createElement('span');
  tag.className = 'nb-caret-tag';
  tag.textContent = c.name;
  el.append(tag);
  return el;
}

export const RemoteCursors = Extension.create({
  name: 'remoteCursors',
  addProseMirrorPlugins() {
    return [
      new Plugin<RemoteCursor[]>({
        key: cursorKey,
        state: {
          init: () => [],
          apply(tr, list) {
            const meta = tr.getMeta(cursorKey) as Meta | undefined;
            let next = tr.docChanged ? list.map((c) => ({ ...c, from: tr.mapping.map(c.from), to: tr.mapping.map(c.to) })) : list;
            if (meta && 'set' in meta) next = [...next.filter((c) => c.id !== meta.set.id), meta.set];
            if (meta && 'remove' in meta) next = next.filter((c) => c.id !== meta.remove);
            return next;
          },
        },
        props: {
          decorations(state) {
            const list = cursorKey.getState(state) ?? [];
            const size = state.doc.content.size;
            const decos: Decoration[] = [];
            for (const c of list) {
              const from = Math.max(0, Math.min(c.from, size));
              const to = Math.max(0, Math.min(c.to, size));
              if (to > from) decos.push(Decoration.inline(from, to, { class: 'nb-remote-sel', style: `--c:${c.color}` }));
              decos.push(Decoration.widget(to, () => caret(c), { key: `${c.id}:${c.name}:${c.tag ? 1 : 0}`, side: 1 }));
            }
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});

export const setCursor = (editor: Editor, c: RemoteCursor) => editor.view.dispatch(editor.state.tr.setMeta(cursorKey, { set: c } satisfies Meta).setMeta('addToHistory', false));
export const removeCursor = (editor: Editor, id: string) =>
  !editor.isDestroyed && editor.view.dispatch(editor.state.tr.setMeta(cursorKey, { remove: id } satisfies Meta).setMeta('addToHistory', false));

/* ───────────── Who's here (for the avatar stack) ───────────── */

export interface Peer {
  id: string;
  kind: 'timmy' | 'tab';
  name: string;
  color: string;
}

const peers = new Map<string, Map<string, Peer>>();
const subs = new Set<() => void>();
const EMPTY: Peer[] = [];
const cache = new Map<string, Peer[]>();
const notify = (doc: string) => {
  cache.set(doc, [...(peers.get(doc)?.values() ?? [])]);
  subs.forEach((f) => f());
};
export const setPeer = (doc: string, p: Peer) => {
  if (!peers.has(doc)) peers.set(doc, new Map());
  peers.get(doc)!.set(p.id, p);
  notify(doc);
};
export const dropPeer = (doc: string, id: string) => {
  if (peers.get(doc)?.delete(id)) notify(doc);
};
export const usePeers = (doc: string) =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => cache.get(doc) ?? EMPTY,
  );

/* ───────────── The same doc in another tab ───────────── */

const TAB = Math.random().toString(36).slice(2, 8);
const TAB_COLORS = ['#d9730d', '#2f8a5b', '#8c55c4', '#c14c8a', '#2f6fb5'];
const colorFor = (id: string) => TAB_COLORS[[...id].reduce((s, ch) => s + ch.charCodeAt(0), 0) % TAB_COLORS.length]!;

type Msg =
  | { t: 'here'; tab: string; doc: string; from: number; to: number }
  | { t: 'bye'; tab: string; doc: string }
  | { t: 'blocks'; tab: string; doc: string; blocks: Block[] };

/**
 * Join a doc's room: share this tab's cursor and saves, show other tabs'.
 * Returns `publish(blocks)` for saves and a cleanup function.
 */
export function joinRoom(doc: string, editor: Editor, onBlocks: (blocks: Block[]) => void) {
  if (typeof BroadcastChannel === 'undefined') return { publish: () => undefined, leave: () => undefined };
  const ch = new BroadcastChannel('timmy-docs');
  const seen = new Map<string, number>();
  const post = (m: Msg) => ch.postMessage(m);
  const here = () => {
    if (editor.isDestroyed) return;
    const { from, to } = editor.state.selection;
    post({ t: 'here', tab: TAB, doc, from, to });
  };
  let pending = 0;
  const onSel = () => {
    window.clearTimeout(pending);
    pending = window.setTimeout(here, 60);
  };
  ch.onmessage = (e: MessageEvent<Msg>) => {
    const m = e.data;
    if (!m || m.doc !== doc || m.tab === TAB) return;
    const id = `tab:${m.tab}`;
    if (m.t === 'bye') {
      seen.delete(m.tab);
      dropPeer(doc, id);
      removeCursor(editor, id);
      return;
    }
    if (m.t === 'blocks') {
      // In the live app the server's stream already brings every tab the saved doc.
      if (!LIVE) onBlocks(m.blocks);
      return;
    }
    const isNew = !seen.has(m.tab);
    seen.set(m.tab, Date.now());
    const color = colorFor(m.tab);
    setPeer(doc, { id, kind: 'tab', name: 'You, in another tab', color });
    if (!editor.isDestroyed) setCursor(editor, { id, name: 'You · other tab', color, from: m.from, to: m.to });
    if (isNew) here(); // Let the newcomer see this tab too.
  };
  editor.on('selectionUpdate', onSel);
  here();
  const beat = window.setInterval(() => {
    here();
    const now = Date.now();
    for (const [tab, at] of seen)
      if (now - at > 12000) {
        seen.delete(tab);
        dropPeer(doc, `tab:${tab}`);
        removeCursor(editor, `tab:${tab}`);
      }
  }, 4000);
  const bye = () => post({ t: 'bye', tab: TAB, doc });
  window.addEventListener('pagehide', bye);
  return {
    publish: (blocks: Block[]) => (LIVE ? undefined : post({ t: 'blocks', tab: TAB, doc, blocks })),
    leave: () => {
      bye();
      window.removeEventListener('pagehide', bye);
      window.clearInterval(beat);
      window.clearTimeout(pending);
      editor.off('selectionUpdate', onSel);
      for (const tab of seen.keys()) dropPeer(doc, `tab:${tab}`);
      ch.close();
    },
  };
}

/* ───────────── Timmy writing into the page ───────────── */

export const TIMMY_COLOR = '#3f51d9';

export interface Written {
  type: string;
  attrs?: Record<string, unknown>;
  text: string;
}

/**
 * Timmy types blocks in after block `after`, with its own cursor and name tag.
 * The typing lands in one undo step.
 */
export function timmyWrites(editor: Editor, doc: string, after: number | null, blocks: Written[], done?: () => void) {
  const id = 'timmy';
  setPeer(doc, { id, kind: 'timmy', name: 'Timmy is writing', color: TIMMY_COLOR });
  const schema = editor.state.schema;
  let at =
    after === null || after >= editor.state.doc.childCount
      ? editor.state.doc.content.size
      : (() => {
          let pos = 0;
          for (let i = 0; i <= after; i++) pos += editor.state.doc.child(i).nodeSize;
          return pos;
        })();
  const ids: string[] = [];
  // Empty blocks first, then the words appear in them.
  const tr = editor.state.tr;
  for (const b of blocks) {
    const bid = `b-timmy-${Math.random().toString(36).slice(2, 9)}`;
    ids.push(bid);
    tr.insert(at, schema.nodes[b.type]!.create({ ...(b.attrs ?? {}), bid }));
    at = tr.mapping.map(at) + 0;
    at = findEnd(tr.doc, bid) + 1;
  }
  editor.view.dispatch(tr);

  let bi = 0;
  let ci = 0;
  const step = () => {
    if (editor.isDestroyed) return;
    if (bi >= blocks.length) {
      removeCursor(editor, id);
      dropPeer(doc, id);
      done?.();
      return;
    }
    const text = blocks[bi]!.text;
    const end = findEnd(editor.state.doc, ids[bi]!);
    if (end < 0) {
      bi++;
      ci = 0;
      return window.setTimeout(step, 0);
    }
    const chunk = text.slice(ci, ci + 3);
    const t = editor.state.tr;
    if (chunk) t.insertText(chunk, end);
    ci += 3;
    const caretAt = end + chunk.length;
    t.setMeta(cursorKey, { set: { id, name: 'Timmy', color: TIMMY_COLOR, from: caretAt, to: caretAt, tag: true } } satisfies Meta);
    // The words ride on the step that added the blocks: one undo removes it all.
    t.setMeta('addToHistory', false);
    editor.view.dispatch(t);
    if (ci >= text.length) {
      bi++;
      ci = 0;
    }
    window.setTimeout(step, chunk ? 22 : 80);
  };
  window.setTimeout(step, 120);
}

/** End of the text inside the top-level block with this id, or -1. */
function findEnd(doc: import('@tiptap/pm/model').Node, bid: string) {
  let out = -1;
  doc.forEach((node, pos) => {
    if (node.attrs.bid === bid) out = pos + 1 + node.content.size;
  });
  return out;
}
