/**
 * What the Chats screen holds of visitors' conversations.
 *
 * The whole of every conversation is kept in the chat tables. The workspace's state, which every open tab
 * receives, holds a bounded copy: the most recent conversations, and for each one its newest messages. A stranger
 * can type as much as the limits allow; this keeps what they type from growing the state every member loads.
 */
import type { ChatConvo, ChatMsg } from '../../../src/data/ws-types';
import type { State } from '../../../src/state/store';
import { config } from '../config';

/** The newest messages that fit the screen's limits, and how many older ones were left out. */
export function newestMessages(all: ChatMsg[]): { messages: ChatMsg[]; dropped: number } {
  let chars = 0;
  let keep = 0;
  for (let i = all.length - 1; i >= 0 && keep < config.chat.shownMessages; i--) {
    chars += all[i]!.text.length;
    // The newest message is always kept, however long it is.
    if (keep > 0 && chars > config.chat.shownChars) break;
    keep++;
  }
  return { messages: keep === all.length ? all : all.slice(all.length - keep), dropped: all.length - keep };
}

const lastAt = (c: ChatConvo) => c.messages.at(-1)?.at.getTime() ?? 0;

/** Puts a conversation into the state, trimmed to the screen's limits, and drops the oldest ones past the cap. */
export function withConversation(state: State, convo: ChatConvo): State {
  const { messages, dropped } = newestMessages(convo.messages);
  const earlier = (convo.earlier ?? 0) + dropped;
  const chats: Record<string, ChatConvo> = { ...state.ws.chats, [convo.id]: { ...convo, messages, ...(earlier ? { earlier } : {}) } };
  const over = Object.keys(chats).length - config.chat.shownConversations;
  if (over > 0) {
    // Conversations a teammate starred or took over are the last to go; among the rest, the ones nobody has written in for longest.
    const kept = (c: ChatConvo) => Number(!!c.starred || c.live);
    const oldest = Object.values(chats)
      .filter((c) => c.id !== convo.id)
      .sort((a, b) => kept(a) - kept(b) || lastAt(a) - lastAt(b))
      .slice(0, over);
    for (const c of oldest) delete chats[c.id];
  }
  return { ...state, ws: { ...state.ws, chats } };
}

/** Takes conversations out of the state (they were deleted, or their retention period ended). */
export function withoutConversations(state: State, ids: string[]): State {
  if (!ids.some((id) => Object.hasOwn(state.ws.chats, id))) return state;
  const chats = { ...state.ws.chats };
  for (const id of ids) delete chats[id];
  return { ...state, ws: { ...state.ws, chats } };
}

/** Changes one message of a conversation in the state, if it is still listed there. */
export function withMessage(state: State, conversationId: string, messageId: string, change: Partial<ChatMsg>): State {
  const c = Object.hasOwn(state.ws.chats, conversationId) ? state.ws.chats[conversationId] : undefined;
  if (!c || !c.messages.some((m) => m.id === messageId)) return state;
  return { ...state, ws: { ...state.ws, chats: { ...state.ws.chats, [c.id]: { ...c, messages: c.messages.map((m) => (m.id === messageId ? { ...m, ...change } : m)) } } } };
}

/** One more line in the activity log members read. */
export function withActivity(state: State, kind: State['activity'][number]['kind'], text: string): State {
  const id = `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return { ...state, activity: [{ id, at: new Date(), kind, text }, ...state.activity] };
}
