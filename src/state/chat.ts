/*
 * What a teammate can do to a visitor's conversation from the Chats screen: reply, take over (or hand back to
 * Timmy), star, mark as read, and delete.
 *
 * These are named actions rather than plain edits because, on a real workspace, the server acts on each one:
 * a reply has to reach the visitor through the Action gateway, taking over has to stop Timmy, and deleting has
 * to remove the stored copy too. This reducer only says what the screen shows.
 */
import { NOW } from '../data/mock';
import type { ChatConvo, ChatMsg } from '../data/ws-types';
import type { State, Toast } from './store';

export type ChatOp =
  /** A teammate's own reply. `message` is the id the new message gets, so the screen and the server agree on it. */
  | { op: 'reply'; id: string; text: string; message: string; by?: string }
  /** `on: true` takes the chat over (Timmy stops answering); `on: false` hands it back. */
  | { op: 'takeOver'; id: string; on: boolean }
  | { op: 'star'; id: string; on: boolean }
  | { op: 'read'; id: string }
  | { op: 'delete'; id: string };

export interface ChatHelpers {
  toast: (s: State, text: string) => Toast[];
}

export function chat(s: State, a: ChatOp, h: ChatHelpers): State {
  const c = s.ws.chats[a.id];
  if (!c) return s;
  const save = (change: Partial<ChatConvo>, toast?: string): State => ({ ...s, ws: { ...s.ws, chats: { ...s.ws.chats, [c.id]: { ...c, ...change } } }, toasts: toast ? h.toast(s, toast) : s.toasts });
  switch (a.op) {
    case 'reply': {
      const text = a.text.trim();
      if (!text || c.messages.some((m) => m.id === a.message)) return s;
      const message: ChatMsg = { id: a.message, from: 'you', text, at: new Date(NOW), ...(a.by ? { by: a.by } : {}) };
      return save({ messages: [...c.messages, message], urgent: false });
    }
    case 'takeOver':
      if (c.live === a.on) return s;
      // Taking over answers the visitor's wish for a person; handing back leaves the flag as it was.
      return save({ live: a.on, urgent: a.on ? false : c.urgent }, a.on ? 'You’re live. Timmy stops answering in this chat.' : 'Timmy is answering this chat again');
    case 'star':
      return save({ starred: a.on });
    case 'read':
      return c.unread ? save({ unread: false }) : s;
    case 'delete': {
      const chats = { ...s.ws.chats };
      delete chats[c.id];
      return { ...s, ws: { ...s.ws, chats }, toasts: h.toast(s, 'Chat deleted') };
    }
  }
}
