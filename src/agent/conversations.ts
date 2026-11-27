/*
 * Conversations with Timmy: AG-UI messages per conversation, the work steps
 * shown for each answer, and the choices you made in widgets. Saved in this
 * browser (localStorage 'timmy-agent-v1'). `ask` runs the agent over AG-UI.
 *
 * On a real workspace whose server keeps conversations in CopilotKit Intelligence, the ones saved there are listed
 * too (savedConversations), so a conversation started on one device can be read and continued on another.
 */
import type { AbstractAgent } from '@ag-ui/client';
import type { Message } from '@ag-ui/core';
import { useSyncExternalStore } from 'react';
import { LIVE } from '../live/config';
import { bridge, COPILOTKIT_URL, createAgent, replaySaved, threadUuid } from './agent';
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
  /** Saved in CopilotKit Intelligence and not yet read into this browser: its messages are fetched when it is opened. */
  remote?: boolean;
  /** Started from a task ("Do it with Timmy"): every question in it is about that task, which the server is told. */
  task?: string;
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

const DEMO_KEY = 'timmy-agent-v1';
const MAX_CONVOS = 30;
/**
 * Where this browser keeps the conversations. The demo has one history. On a real workspace each person's
 * history for each workspace has its own key, so the next person to use this browser doesn't get it.
 */
let KEY = DEMO_KEY;
/** Whether the conversations saved in CopilotKit Intelligence were listed for this person and workspace yet. */
let synced = false;

/** The films (?intro, ?outro, ?film) run on demo data that is never saved, chats included. */
const EPHEMERAL = typeof window !== 'undefined' && /[?&](intro|outro|film)(=|&|$)/.test(window.location.search);

const load = (): Conversation[] => {
  if (EPHEMERAL) return [];
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
  if (next.convos && !EPHEMERAL) {
    try {
      localStorage.setItem(KEY, JSON.stringify(store.convos.slice(0, MAX_CONVOS)));
    } catch {
      /* storage full or unavailable */
    }
  }
  listeners.forEach((l) => l());
};

/** Live mode: from here on, read and write this person's history for this workspace only. */
export function scopeConversations(userId: string, workspaceId: string) {
  KEY = `${DEMO_KEY}:${userId}:${workspaceId}`;
  synced = false;
  store = { ...store, convos: load(), active: null, running: null, error: null };
  listeners.forEach((l) => l());
}

/** Live mode, on sign-out: conversations quote mail, so none are left in this browser. */
export function forgetConversations() {
  try {
    for (const k of Object.keys(localStorage)) if (k === DEMO_KEY || k.startsWith(`${DEMO_KEY}:`)) localStorage.removeItem(k);
  } catch {
    /* storage unavailable */
  }
  store = { ...store, convos: [], active: null };
}

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

/* ───────────── Conversations saved in CopilotKit Intelligence ───────────── */

/** A message as the runtime returns it, in AG-UI's shape. */
function toMessage(m: Record<string, unknown>): Message | null {
  const id = typeof m.id === 'string' ? m.id : null;
  const role = m.role;
  if (!id) return null;
  if (role === 'user') return { id, role, content: typeof m.content === 'string' ? m.content : '' };
  if (role === 'tool') return { id, role, content: typeof m.content === 'string' ? m.content : '', toolCallId: String(m.toolCallId ?? '') };
  if (role !== 'assistant') return null;
  const calls = Array.isArray(m.toolCalls) ? (m.toolCalls as Record<string, unknown>[]) : [];
  const toolCalls = calls.map((c) => {
    const fn = (c.function ?? {}) as { name?: string; arguments?: string };
    return { id: String(c.id ?? ''), type: 'function' as const, function: { name: String(fn.name ?? c.name ?? ''), arguments: String(fn.arguments ?? (typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}))) } };
  });
  return { id, role, ...(typeof m.content === 'string' ? { content: m.content } : {}), ...(toolCalls.length ? { toolCalls } : {}) };
}

/**
 * Lists the conversations this person has saved in CopilotKit Intelligence that this browser hasn't got, once per page.
 * Does nothing in the demo, or when the server keeps conversations in its own memory.
 */
export async function savedConversations(): Promise<void> {
  if (!LIVE || synced) return;
  synced = true;
  try {
    const info = (await (await fetch(`${COPILOTKIT_URL}/info`, { credentials: 'same-origin' })).json()) as { mode?: string };
    if (info.mode !== 'intelligence') return;
    const res = await fetch(`${COPILOTKIT_URL}/threads?agentId=timmy&limit=${MAX_CONVOS}`, { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = (await res.json()) as { threads?: { id: string; name?: string | null; updatedAt?: string; createdAt?: string }[] };
    const known = new Set(await Promise.all(store.convos.map((c) => threadUuid(c.id))));
    const add: Conversation[] = (data.threads ?? [])
      .filter((t) => t && typeof t.id === 'string' && !known.has(t.id))
      .map((t) => ({ id: t.id, title: (t.name || 'Conversation').slice(0, 60), updated: Date.parse(t.updatedAt ?? t.createdAt ?? '') || Date.now(), messages: [], steps: {}, chosen: {}, asked: {}, remote: true }));
    if (add.length) set({ convos: [...store.convos, ...add].sort((a, b) => b.updated - a.updated).slice(0, MAX_CONVOS) });
  } catch {
    synced = false;
  }
}

/**
 * Reads a saved conversation's messages from CopilotKit Intelligence when it is opened. Intelligence files a run's
 * messages a little after the run ends, so one that has just been had elsewhere may come back empty for a minute or
 * two: it is asked again, a few times, until it has them.
 */
async function readSaved(id: string, tries = 12) {
  try {
    // First as CopilotKit reconnects a conversation (replayed from its realtime channel, there at once), then from
    // the saved messages, which Intelligence files a little later.
    const replayed = replaySaved(id).catch(() => [] as Message[]);
    let messages = await Promise.race([replayed, new Promise<Message[]>((resolve) => window.setTimeout(() => resolve([]), 8000))]);
    if (!messages.some((m) => m.role === 'assistant')) {
      const res = await fetch(`${COPILOTKIT_URL}/threads/${encodeURIComponent(id)}/messages`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('That conversation couldn’t be loaded.');
      const data = (await res.json()) as { messages?: Record<string, unknown>[] };
      messages = (data.messages ?? []).map(toMessage).filter((m): m is Message => !!m);
    }
    if (!messages.length && tries > 1) {
      window.setTimeout(() => {
        if (store.convos.find((c) => c.id === id)?.remote) void readSaved(id, tries - 1);
      }, 10_000);
      return;
    }
    if (!messages.length) throw new Error('CopilotKit didn’t hand this conversation back. It is still in the browser it was had in.');
    agents.delete(id);
    patchConvo(id, (c) => ({ ...c, messages, remote: undefined }));
  } catch (e) {
    set({ error: e instanceof Error ? e.message : 'That conversation couldn’t be loaded.' });
  }
}

/** A conversation deleted here is deleted where CopilotKit Intelligence keeps it too (nothing to do when it doesn't). */
async function forgetSaved(ids: string[]) {
  if (!LIVE) return;
  for (const id of ids.slice(0, MAX_CONVOS)) {
    const thread = await threadUuid(id);
    await fetch(`${COPILOTKIT_URL}/threads/${encodeURIComponent(thread)}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'timmy' }) }).catch(() => undefined);
  }
}

export const assistant = {
  get: () => store,
  open: () => {
    set({ open: true });
    void savedConversations();
  },
  close: () => set({ open: false }),
  toggle: () => {
    set({ open: !store.open });
    if (store.open) void savedConversations();
  },
  isOpen: () => store.open,
  newChat: () => set({ active: null, error: null }),
  select: (id: string) => {
    set({ active: id, error: null });
    if (store.convos.find((c) => c.id === id)?.remote) void readSaved(id);
  },
  remove: (id: string) => {
    agents.delete(id);
    set({ convos: store.convos.filter((c) => c.id !== id), active: store.active === id ? null : store.active });
    void forgetSaved([id]);
  },
  clearAll: () => {
    const ids = store.convos.map((c) => c.id);
    agents.clear();
    set({ convos: [], active: null, running: null, error: null });
    void forgetSaved(ids);
  },
  choose: (convo: string, toolCallId: string, note: string) => patchConvo(convo, (c) => ({ ...c, chosen: { ...c.chosen, [toolCallId]: note } })),

  /**
   * Sends your message and runs the agent. `screen` is the label of what you have open. `task` starts a new
   * conversation about that task ("Do it with Timmy"); the server is told which task it is with every question in it.
   */
  async ask(text: string, screen?: string, opts: { task?: string } = {}) {
    const q = text.trim();
    if (!q || store.running) return;
    let convo = opts.task ? undefined : store.convos.find((c) => c.id === store.active);
    if (!convo) {
      convo = { id: newId('chat'), title: q.length > 60 ? `${q.slice(0, 57)}…` : q, updated: Date.now(), messages: [], steps: {}, chosen: {}, asked: {}, ...(opts.task ? { task: opts.task } : {}) };
      set({ convos: [convo, ...store.convos], active: convo.id });
    }
    const task = convo.task;
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
        { tools: TOOLS, context: screen ? [{ description: 'The screen the user has open in Timmy', value: screen }] : [], forwardedProps: { route: bridge.route(), ...(task ? { task } : {}) } },
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
