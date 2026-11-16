/*
 * Conversations with Timmy: AG-UI messages per conversation, the work steps
 * shown for each answer, and the choices you made in widgets. Saved in this
 * browser (localStorage 'timmy-agent-v1'). `ask` runs the agent over AG-UI.
 */
import type { AbstractAgent } from '@ag-ui/client';
import type { Message } from '@ag-ui/core';
import { useSyncExternalStore } from 'react';
import { createAgent } from './agent';
import { TOOLS } from './tools';

export interface Conversation {
  id: string;
  title: string;
  updated: number;
  messages: Message[];
  /** Work steps shown for each answer, by assistant message id. */
  steps: Record<string, string[]>;
  /** Widget choices you made, by tool call id. */
  chosen: Record<string, string>;
  /** The screen each question was asked from, by user message id. */
  asked: Record<string, string>;
}

export interface RunProgress {
  convo: string;
  steps: { name: string; done: boolean }[];
}

interface Store {
  open: boolean;
  convos: Conversation[];
  active: string | null;
  running: RunProgress | null;
  error: string | null;
}

const KEY = 'timmy-agent-v1';
const MAX_CONVOS = 30;

const load = (): Conversation[] => {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Conversation[]) : [];
  } catch {
    return [];
  }
};

let store: Store = { open: false, convos: load(), active: null, running: null, error: null };
const listeners = new Set<() => void>();

const set = (next: Partial<Store>) => {
  store = { ...store, ...next };
  if (next.convos) {
    try {
      localStorage.setItem(KEY, JSON.stringify(store.convos.slice(0, MAX_CONVOS)));
    } catch {
      /* storage full or unavailable */
    }
  }
  listeners.forEach((l) => l());
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useAssistant = () => useSyncExternalStore(subscribe, () => store);

const patchConvo = (id: string, fn: (c: Conversation) => Conversation) =>
  set({ convos: store.convos.map((c) => (c.id === id ? fn(c) : c)).sort((a, b) => b.updated - a.updated) });

let seq = 0;
const newId = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

const agents = new Map<string, AbstractAgent>();
const agentFor = (c: Conversation) => {
  let a = agents.get(c.id);
  if (!a) {
    a = createAgent({ threadId: c.id, initialMessages: c.messages });
    agents.set(c.id, a);
  }
  return a;
};

export const assistant = {
  get: () => store,
  open: () => set({ open: true }),
  close: () => set({ open: false }),
  toggle: () => set({ open: !store.open }),
  isOpen: () => store.open,
  newChat: () => set({ active: null, error: null }),
  select: (id: string) => set({ active: id, error: null }),
  remove: (id: string) => {
    agents.delete(id);
    set({ convos: store.convos.filter((c) => c.id !== id), active: store.active === id ? null : store.active });
  },
  clearAll: () => {
    agents.clear();
    set({ convos: [], active: null, running: null, error: null });
  },
  choose: (convo: string, toolCallId: string, note: string) => patchConvo(convo, (c) => ({ ...c, chosen: { ...c.chosen, [toolCallId]: note } })),

  /** Sends your message and runs the agent. `screen` is the label of what you have open. */
  async ask(text: string, screen?: string) {
    const q = text.trim();
    if (!q || store.running) return;
    let convo = store.convos.find((c) => c.id === store.active);
    if (!convo) {
      convo = { id: newId('chat'), title: q.length > 60 ? `${q.slice(0, 57)}…` : q, updated: Date.now(), messages: [], steps: {}, chosen: {}, asked: {} };
      set({ convos: [convo, ...store.convos], active: convo.id });
    }
    const cid = convo.id;
    const agent = agentFor(convo);
    const user: Message = { id: newId('user'), role: 'user', content: q };
    agent.addMessage(user);
    patchConvo(cid, (c) => ({ ...c, updated: Date.now(), messages: [...agent.messages], asked: screen ? { ...c.asked, [user.id]: screen } : c.asked }));
    set({ running: { convo: cid, steps: [] }, error: null, open: true });

    const steps: { name: string; done: boolean }[] = [];
    const progress = () => set({ running: { convo: cid, steps: steps.map((x) => ({ ...x })) } });
    try {
      const result = await agent.runAgent(
        { tools: TOOLS, context: screen ? [{ description: 'The screen the user has open in Timmy', value: screen }] : [] },
        {
          onStepStartedEvent: ({ event }) => {
            steps.push({ name: event.stepName, done: false });
            progress();
          },
          onStepFinishedEvent: ({ event }) => {
            const st = steps.find((x) => x.name === event.stepName && !x.done);
            if (st) st.done = true;
            progress();
          },
          onMessagesChanged: ({ messages }) => patchConvo(cid, (c) => ({ ...c, messages: [...messages] })),
        },
      );
      // Widgets are shown, not answered by the agent: record that, so the next run's history is complete.
      const shown = (result.newMessages ?? []).flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []) : []));
      for (const call of shown) agent.addMessage({ id: newId('tool'), role: 'tool', toolCallId: call.id, content: 'Shown to the user.' });
      const answer = [...agent.messages].reverse().find((m) => m.role === 'assistant');
      patchConvo(cid, (c) => ({
        ...c,
        updated: Date.now(),
        messages: [...agent.messages],
        steps: answer ? { ...c.steps, [answer.id]: steps.map((x) => x.name) } : c.steps,
      }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Timmy couldn’t finish that.' });
    } finally {
      set({ running: null });
    }
  },
};
