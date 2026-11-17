/**
 * One message from a visitor on a customer's website.
 *
 * Everything a visitor sends is treated as hostile. Their text is stored and shown as text, is matched against
 * the chat's own rules by plain code, and is never given to a model. The workspace comes from the site key and
 * the conversation from a signed token; nothing in the message can name either.
 *
 * In one locked transaction the message is stored, the rules decide what Timmy says back, and each reply is
 * proposed to the Action gateway, where the rule "the website chat is switched on" approves it. Only then, and
 * only through the gateway's executor, does a reply become visible to the visitor.
 */
import type { ChatConvo, ChatMsg, ChatWidget } from '../../../src/data/ws-types';
import type { Lead } from '../../../src/data/outbound-types';
import { followUpName, newTalk, respond, type Talk } from '../../../src/lib/chat-bot';
import type { State } from '../../../src/state/store';
import { EMAIL } from '../../../src/state/ws';
import { config } from '../config';
import { withWorkspace, type Tx } from '../db/pool';
import { executeEffect, propose } from '../gateway/gateway';
import { newId } from '../lib/ids';
import { log } from '../lib/log';
import type { Loaded } from '../state/docs';
import { mutate } from '../state/mutate';
import { announce, announceEverywhere, visibleSince, type VisitorMessage } from './hub';
import { TIMMY_REPLY } from './settings';
import { withActivity, withConversation } from './shown';
import type { Site } from './site';
import { conversationOf, issueToken, textMark } from './token';

export interface Incoming {
  /** The anonymous id the visitor's chat window made up and keeps. */
  visitor: string;
  /** The chat window's own id for this message: sending it twice stores it once. */
  clientId: string;
  text: string;
  /** Both present for a conversation that already exists; both absent for a first message. */
  conversation?: string;
  token?: string;
  page?: string;
  /** The place of the last message the chat window already has. */
  after?: number;
}

export type Said =
  | { ok: true; conversation: string; token: string; messages: VisitorMessage[] }
  /** Refused, with a plain sentence for the visitor. `reset` tells the chat window to forget its conversation. */
  | { ok: false; status: number; notice: string; reset?: boolean };

/** The same words whether the key is unknown, the chat is off, or it was switched off a moment ago. */
export const CLOSED: Said = { ok: false, status: 404, notice: 'This chat isn’t available right now.' };
/** The same words whether the token is forged, expired, for another conversation, or the conversation was deleted. */
export const ENDED: Said = { ok: false, status: 403, notice: 'This conversation has ended. Send your message again to start a new one.', reset: true };
export const TOO_FAST: Said = { ok: false, status: 429, notice: 'You’re sending messages quickly. Wait a moment and try again.' };
export const TOO_LONG: Said = { ok: false, status: 413, notice: `That message is too long. Keep it under ${config.chat.maxMessageChars.toLocaleString('en-US')} characters.` };
export const NOT_A_MESSAGE: Said = { ok: false, status: 400, notice: 'That message couldn’t be sent. Reload the page and try again.' };
const FULL: Said = { ok: false, status: 429, notice: 'This conversation has reached its limit. Please reach us another way, or start a new chat later.' };
const BUSY: Said = { ok: false, status: 429, notice: 'The chat is very busy today. Please try again tomorrow, or reach us another way.' };

/** Control characters other than a new line and a tab have no place in a chat message. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
export const cleanText = (raw: string) => raw.replace(/\r\n?/g, '\n').replace(CONTROL, '').trim();

const PAGE = /^\/[^\s\u0000-\u001F<>"'`\\]{0,199}$/;

interface ConversationRow {
  id: string;
  visitor_id: string;
  live: boolean;
  urgent: boolean;
  email: string | null;
  name: string | null;
  talk: Talk;
  lead_id: string | null;
  page: string | null;
  visitor_messages: number;
}

type Stored = { ok: true; conversationId: string; effects: string[] } | Extract<Said, { ok: false }>;

export async function visitorSays(site: Site, input: Incoming): Promise<Said> {
  const workspaceId = site.workspaceId;
  // A message for a conversation that exists has to carry that conversation's token, signed for this workspace.
  let conversationId: string | null = null;
  if (input.conversation !== undefined || input.token !== undefined) {
    conversationId = await conversationOf(input.token, workspaceId);
    if (!conversationId || conversationId !== input.conversation) return ENDED;
  }

  let stored: Stored;
  try {
    stored = await mutate<Stored>(workspaceId, 'chat', (tx, loaded) => store(tx, loaded.state, loaded, conversationId, input));
  } catch (e) {
    // Whatever went wrong, the visitor gets a plain sentence, and the log gets the error without their words.
    log.warn('a visitor’s message could not be taken', { error: (e as Error).message.slice(0, 200) });
    return CLOSED;
  }
  if (!stored.ok) return stored;
  // The visitor's other open windows show what they just wrote.
  announce(stored.conversationId);

  // The replies were approved by the rule inside the transaction. They are shown now; the queue's own copy of
  // the job finds them already done. If this process stops here, the queue shows them within the minute.
  for (const id of stored.effects) {
    await executeEffect(workspaceId, id).catch((e) => log.warn('a chat reply could not be shown yet', { effectId: id, error: (e as Error).message }));
  }
  const messages = await withWorkspace({ workspaceId }, (tx) => visibleSince(tx, workspaceId, stored.conversationId, input.after ?? 0));
  return { ok: true, conversation: stored.conversationId, token: await issueToken(workspaceId, stored.conversationId), messages };
}

async function store(tx: Tx, state0: State, loaded: Loaded, knownId: string | null, input: Incoming): Promise<{ state?: State; result: Stored }> {
  const workspaceId = loaded.workspace.id;
  const w = state0.ws.chat.site as ChatWidget | undefined;
  // Checked again under the lock: the chat may have been switched off since the site key was looked up.
  const on = (await tx.query('select 1 from chat_widget where workspace_id = $1 and is_on', [workspaceId])).rowCount;
  if (!w || !on || loaded.workspace.kill_switch) return { result: CLOSED as Stored };

  let conv: ConversationRow | undefined;
  if (knownId) {
    conv = (await tx.query('select * from chat_conversation where id = $1 and workspace_id = $2 for update', [knownId, workspaceId])).rows[0] as ConversationRow | undefined;
    if (!conv) return { result: ENDED as Stored };
  } else {
    // A first message sent twice (the answer to the first try was lost) is the same conversation, not a second one.
    conv = (
      await tx.query(
        `select c.* from chat_conversation c join chat_message m on m.conversation_id = c.id
         where c.workspace_id = $1 and c.visitor_id = $2 and m.client_id = $3 and m.sender = 'visitor' for update of c`,
        [workspaceId, input.visitor, input.clientId],
      )
    ).rows[0] as ConversationRow | undefined;
    if (conv) return { result: { ok: true, conversationId: conv.id, effects: [] } };
  }
  if (conv) {
    const again = (await tx.query(`select 1 from chat_message where conversation_id = $1 and client_id = $2 and sender = 'visitor'`, [conv.id, input.clientId])).rowCount;
    if (again) return { result: { ok: true, conversationId: conv.id, effects: [] } };
  }

  // The caps that hold whatever the visitor's address or id: per conversation, and per widget per day.
  const today = ((await tx.query('select conversations, messages from chat_counter where workspace_id = $1 and day = current_date', [workspaceId])).rows[0] as { conversations: number; messages: number } | undefined) ?? { conversations: 0, messages: 0 };
  if (today.messages >= config.chat.messagesPerDay) return { result: BUSY as Stored };
  if (!conv && today.conversations >= config.chat.conversationsPerDay) return { result: BUSY as Stored };
  if (conv && conv.visitor_messages >= config.chat.messagesPerConversation) return { result: FULL as Stored };

  const now = new Date();
  const fresh = !conv;
  if (!conv) {
    conv = { id: newId('cv'), visitor_id: input.visitor, live: false, urgent: false, email: null, name: null, talk: newTalk(), lead_id: null, page: input.page && PAGE.test(input.page) ? input.page : null, visitor_messages: 0 };
    await tx.query('insert into chat_conversation (id, workspace_id, visitor_id, talk, page) values ($1, $2, $3, $4::jsonb, $5)', [conv.id, workspaceId, conv.visitor_id, JSON.stringify(conv.talk), conv.page]);
  }
  await tx.query(
    `insert into chat_counter (workspace_id, day, conversations, messages) values ($1, current_date, $2, 1)
     on conflict (workspace_id, day) do update set conversations = chat_counter.conversations + excluded.conversations, messages = chat_counter.messages + 1`,
    [workspaceId, fresh ? 1 : 0],
  );

  // The visitor's own message is theirs to see at once; it takes the next place in the conversation.
  const visitorMessage: ChatMsg = { id: newId('cm'), from: 'visitor', text: input.text, at: now };
  const earlier = state0.ws.chats[conv.id] ? 0 : ((await tx.query('select count(*)::int as n from chat_message where conversation_id = $1', [conv.id])).rows[0].n as number);
  await tx.query(`insert into chat_message (id, workspace_id, conversation_id, sender, client_id, body, seq, sent_at) values ($1, $2, $3, 'visitor', $4, $5, nextval('chat_message_seq'), now())`, [
    visitorMessage.id,
    workspaceId,
    conv.id,
    input.clientId,
    input.text,
  ]);

  await announceEverywhere(tx, conv.id);

  let state = state0;
  let talk: Talk = { ...newTalk(), ...conv.talk };
  let urgent = conv.urgent;
  const said: ChatMsg[] = [];
  const effects: string[] = [];
  // Once a teammate has taken over, Timmy says nothing: the visitor's message waits for them.
  if (!conv.live) {
    // On a real website no times are offered, and the visitor is told the business will follow up, never a person's name.
    const out = respond(w, { ...talk, handedOff: false }, input.text, { owner: followUpName(w), booking: false });
    const asksForPerson = !!out.st.handedOff;
    talk = kept({ ...out.st, handedOff: !!talk.handedOff || asksForPerson });
    for (const [i, reply] of out.replies.entries()) {
      const id = newId('cm');
      const p = await propose(tx, loaded, state, null, {
        kind: 'chat.reply',
        // The record pins down which message and exactly which words, without holding the words (see token.ts).
        payload: { conversationId: conv.id, messageId: id, mark: await textMark(reply.text), sender: 'timmy' },
        preview: { lines: ['A reply from Timmy to a visitor in the website chat.'] },
        title: 'Reply in the website chat',
        why: 'The website chat is switched on, and this is what its settings say to answer.',
        target: `chat:${conv.id}`,
        idempotencyKey: `chat:${visitorMessage.id}:${i}`,
        source: 'rule',
        meta: { ...TIMMY_REPLY },
      });
      // Refused at the gateway: nothing is said. The visitor's message is kept for a person to answer.
      if (p.outcome === 'blocked' || !p.effect) break;
      // No rule covered it. Without one nothing Timmy writes may reach a stranger, so the whole message is turned away.
      if (p.outcome !== 'approved' || p.effect.approved_via !== 'rule') throw new Error('a chat reply was not covered by the rule');
      await tx.query(`insert into chat_message (id, workspace_id, conversation_id, sender, body, notice, effect_id) values ($1, $2, $3, 'timmy', $4, $5, $6)`, [id, workspaceId, conv.id, reply.text, reply.asksEmail && w.privacyUrl ? 'privacy' : null, p.effect.id]);
      state = p.state;
      effects.push(p.effect.id);
      said.push({ id, from: 'timmy', text: reply.text, at: new Date(now.getTime() + i + 1) });
    }
    if (asksForPerson && !urgent) {
      urgent = true;
      state = withActivity(state, 'task', 'A visitor on your website chat asked for a person. Open Website chat to take over.');
    }
  }

  // A visitor who leaves an email becomes a lead, once per conversation; their later answers go onto that lead.
  let leadId = conv.lead_id;
  if (talk.email && EMAIL.test(talk.email)) {
    const made = withLead(state, w, talk, leadId, now);
    if (made.created) state = withActivity(made.state, 'crm', `New lead from your website chat: ${talk.email}`);
    else state = made.state;
    leadId = made.leadId;
  }

  await tx.query(
    `update chat_conversation set talk = $3::jsonb, email = $4, name = $5, urgent = $6, lead_id = $7, visitor_messages = visitor_messages + 1, last_message_at = now() where id = $1 and workspace_id = $2`,
    [conv.id, workspaceId, JSON.stringify(talk), talk.email ?? null, talk.name ?? null, urgent, leadId],
  );

  const before = state.ws.chats[conv.id] as ChatConvo | undefined;
  const convo: ChatConvo = {
    ...(before ?? { id: conv.id, messages: [], live: conv.live, unread: true, ...(earlier ? { earlier } : {}) }),
    ...(talk.name ? { name: talk.name } : {}),
    ...(talk.email ? { email: talk.email } : {}),
    ...(Object.keys(talk.answers).length ? { answers: talk.answers } : {}),
    ...(conv.page ? { page: conv.page } : {}),
    messages: [...(before?.messages ?? []), visitorMessage, ...said],
    live: conv.live,
    unread: true,
    urgent,
  };
  return { state: withConversation(state, convo), result: { ok: true, conversationId: conv.id, effects } };
}

/** The address as it is kept: lower case, without the full stop that ended the visitor's sentence. */
const cleanEmail = (raw: string) => raw.toLowerCase().replace(/[.\-]+$/, '');

/** The longest answer kept with the conversation and the lead. The whole of what was typed stays in the transcript. */
const MAX_ANSWER = 500;

/**
 * What is kept of where the conversation is. A visitor chooses every character of these fields, so each has a
 * size: an "address" longer than any real one is not kept as one, a name is short, and an answer is cut.
 */
function kept(talk: Talk): Talk {
  const email = talk.email ? cleanEmail(talk.email) : undefined;
  const real = !!email && email.length <= 254;
  const answers: Record<string, string> = {};
  for (const [id, answer] of Object.entries(talk.answers)) answers[id] = answer.length > MAX_ANSWER ? `${answer.slice(0, MAX_ANSWER)}…` : answer;
  return { ...talk, email: real ? email : undefined, name: real && talk.name ? talk.name.slice(0, 60) : undefined, answers };
}

/** The answers under the questions' own words, as they show on the lead. */
function answersByQuestion(w: ChatWidget, answers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of w.questions) if (answers[q.id]) out[q.text.replace(/\?$/, '').slice(0, 120)] = answers[q.id]!;
  return out;
}

/**
 * Makes the visitor a lead, or adds their answers to the lead that already has their address.
 * Anyone can type any address into a chat, so what a visitor says never replaces what a lead from elsewhere
 * already holds: it only fills what is empty.
 */
function withLead(state: State, w: ChatWidget, talk: Talk, leadId: string | null, now: Date): { state: State; leadId: string; created: boolean } {
  const email = talk.email!;
  const answers = answersByQuestion(w, talk.answers);
  // This conversation already made its lead. If a teammate has removed that lead since, it stays removed.
  if (leadId && !state.out.leads[leadId]) return { state, leadId, created: false };
  const existing = (leadId ? state.out.leads[leadId] : undefined) ?? Object.values(state.out.leads).find((l) => l.email.toLowerCase() === email);
  if (existing) {
    const extra = existing.source === 'chat' ? { ...existing.extra, ...answers } : { ...answers, ...existing.extra };
    const same = JSON.stringify(extra) === JSON.stringify(existing.extra ?? {});
    return { state: same ? state : { ...state, out: { ...state.out, leads: { ...state.out.leads, [existing.id]: { ...existing, extra } } } }, leadId: existing.id, created: false };
  }
  const lead: Lead = { id: newId('lead'), first: talk.name ?? email.split('@')[0]!, last: '', email, company: '', source: 'chat', added: now, receivedAt: now, status: 'new', ...(Object.keys(answers).length ? { extra: answers } : {}) };
  return { state: { ...state, out: { ...state.out, leads: { ...state.out.leads, [lead.id]: lead } } }, leadId: lead.id, created: true };
}
