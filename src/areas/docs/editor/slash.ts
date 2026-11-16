/* The "/" menu: a suggestion plugin that hands its state to a React menu. */
import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';
import { filterKinds, runKind, type BlockKind, type EditorActions } from './catalog';

export interface SlashState {
  open: boolean;
  items: BlockKind[];
  index: number;
  query: string;
  rect: DOMRect | null;
  pick: ((k: BlockKind) => void) | null;
}

const CLOSED: SlashState = { open: false, items: [], index: 0, query: '', rect: null, pick: null };

export function createSlashBus() {
  let state = CLOSED;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set: (s: Partial<SlashState>) => {
      state = { ...state, ...s };
      subs.forEach((f) => f());
    },
    close: () => {
      state = CLOSED;
      subs.forEach((f) => f());
    },
    subscribe: (f: () => void) => {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}
export type SlashBus = ReturnType<typeof createSlashBus>;

export const SlashCommand = Extension.create<{ bus: SlashBus | null; actions: () => EditorActions }>({
  name: 'slashCommand',
  priority: 2000,
  addOptions() {
    return { bus: null, actions: () => ({ pickSheet: () => undefined, pickFile: () => undefined, newPage: () => undefined, timmySummary: () => undefined }) };
  },
  addProseMirrorPlugins() {
    const bus = this.options.bus;
    const actions = this.options.actions;
    if (!bus) return [];
    return [
      Suggestion<BlockKind, BlockKind>({
        editor: this.editor,
        char: '/',
        pluginKey: new PluginKey('slash'),
        startOfLine: false,
        allowSpaces: false,
        allow: ({ state, range }) => state.doc.resolve(range.from).parent.type.name !== 'codeBlock',
        items: ({ query }) => filterKinds(query),
        command: ({ editor, range, props }) => {
          bus.close();
          runKind(editor, range, props, actions());
        },
        render: () => ({
          onStart: (p) => bus.set({ open: true, items: p.items, index: 0, query: p.query, rect: p.clientRect?.() ?? null, pick: p.command }),
          onUpdate: (p) => bus.set({ open: true, items: p.items, index: 0, query: p.query, rect: p.clientRect?.() ?? null, pick: p.command }),
          onKeyDown: ({ event }) => {
            const s = bus.get();
            if (!s.open) return false;
            const n = s.items.length;
            if (event.key === 'ArrowDown') {
              if (n) bus.set({ index: (s.index + 1) % n });
              return true;
            }
            if (event.key === 'ArrowUp') {
              if (n) bus.set({ index: (s.index - 1 + n) % n });
              return true;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              const k = s.items[s.index];
              if (k && s.pick) {
                s.pick(k);
                return true;
              }
              bus.close();
              return false;
            }
            if (event.key === 'Escape') {
              bus.close();
              return true;
            }
            return false;
          },
          onExit: () => bus.close(),
        }),
      }),
    ];
  },
});
