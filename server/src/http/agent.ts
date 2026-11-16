/**
 * The chat endpoint. It speaks AG-UI over server-sent events, which is what
 * the frontend's chat already understands: run started, steps, text as it is
 * written, tool calls for the widgets the browser draws, run finished.
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { ASK_SYSTEM } from '../agent/prompts';
import { startRun } from '../agent/loop';
import { config } from '../config';
import type { EffectRow } from '../gateway/gateway';
import { newId } from '../lib/ids';
import { log } from '../lib/log';
import { modelReady, type ChatMessage, type ToolCall, type ToolDef } from '../providers/model';
import { safeChatAction } from '../../../src/live/chat-actions';
import { untrusted } from '../agent/prompts';
import { ctxOf, requireWorkspace, type Env } from './session';

interface AgUiMessage {
  id?: string;
  role: string;
  content?: unknown;
  toolCalls?: { id: string; function: { name: string; arguments: string } }[];
  toolCallId?: string;
}

interface RunAgentInput {
  threadId?: string;
  runId?: string;
  messages?: AgUiMessage[];
  tools?: { name: string; description?: string; parameters?: Record<string, unknown> }[];
  context?: { description: string; value: string }[];
  forwardedProps?: Record<string, unknown>;
}

const text = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

/**
 * Buttons in an answer are written by the model, which may have been steered by mail it read.
 * A button that would do more than open something or start a draft is removed before it reaches the browser.
 */
export function sanitizeDisplayCall(call: ToolCall): ToolCall {
  if (call.name !== 'show_answer') return call;
  try {
    const args = JSON.parse(call.arguments || '{}') as { choices?: { actions?: unknown[] }[] };
    if (!Array.isArray(args.choices)) return call;
    args.choices = args.choices.filter((c) => !!c && typeof c === 'object' && (!Array.isArray(c.actions) || c.actions.every(safeChatAction)));
    return { ...call, arguments: JSON.stringify(args) };
  } catch {
    return { ...call, arguments: '{}' };
  }
}

/** The browser sends the whole conversation each time; this is it in the model's terms. */
function history(messages: AgUiMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages.slice(-40)) {
    if (m.role === 'user') out.push({ role: 'user', content: text(m.content).slice(0, 8000) });
    else if (m.role === 'assistant') out.push({ role: 'assistant', content: text(m.content), toolCalls: m.toolCalls?.map((t) => ({ id: t.id, name: t.function.name, arguments: t.function.arguments })) });
    else if (m.role === 'tool' && m.toolCallId) out.push({ role: 'tool', toolCallId: m.toolCallId, content: text(m.content) });
  }
  // A tool result is only valid right after the call it answers; drop any that lost theirs to the cut above.
  const calls = new Set(out.flatMap((m) => m.toolCalls?.map((t) => t.id) ?? []));
  return out.filter((m) => m.role !== 'tool' || calls.has(m.toolCallId!));
}

function approvalWidget(e: EffectRow) {
  const p = e.preview;
  const preview = [...(p.from ? [`From: ${p.from}`] : []), `To: ${(p.to ?? []).join(', ')}`, ...(p.cc?.length ? [`Cc: ${p.cc.join(', ')}`] : []), `Subject: ${p.subject ?? ''}`, '', p.body ?? ''].join('\n');
  const mine = e.approver_route === 'user';
  return {
    preview,
    choices: mine
      ? [
          { id: 'send', label: 'Send', primary: true, actions: [{ type: 'effect', id: e.id, approve: true }], after: `Approved. It goes out in ${config.sendHoldSeconds} seconds; Undo is in Approvals until then.`, open: 'approvals' },
          { id: 'no', label: 'Don’t send', cancel: true, actions: [{ type: 'effect', id: e.id, approve: false }], after: 'Okay. Nothing was sent.' },
        ]
      : [],
  };
}

export function agentRoutes(app: Hono<Env>) {
  app.post('/api/v1/agent/runs', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    const input = (await c.req.json().catch(() => ({}))) as RunAgentInput;
    const threadId = String(input.threadId ?? newId('chat'));
    const runId = String(input.runId ?? newId('agui'));

    return streamSSE(c, async (stream) => {
      const emit = (event: Record<string, unknown>) => stream.writeSSE({ data: JSON.stringify(event) });
      await emit({ type: 'RUN_STARTED', threadId, runId });
      try {
        if (!ctx.rules.read) throw new Error('Your role can’t use Ask in this workspace.');
        if (!modelReady()) throw new Error('Timmy’s model isn’t configured on this server yet.');
        const messages = history(input.messages ?? []);
        const last = messages[messages.length - 1];
        if (!last || last.role !== 'user') throw new Error('Ask a question first.');
        // What changes per request rides with the question, so the cached prefix stays the same.
        // The judge is given the person's own words only, so they are taken before anything is added to the message.
        const userWords = messages.filter((m) => m.role === 'user').map((m) => m.content);
        // What is open on screen includes text other people wrote (an email's subject), so it travels as marked data.
        const screen = (input.context ?? []).map((x) => `${x.description}: ${x.value}`).join('\n').slice(0, 600);
        const open = input.forwardedProps?.route ? `Open in the app: ${JSON.stringify(input.forwardedProps.route).slice(0, 300)}` : '';
        const onScreen = screen || open ? `\n${untrusted('screen', [screen, open].filter(Boolean).join('\n'))}` : '';
        last.content = `<context>\nNow: ${new Date().toISOString()}\nUser: ${ctx.user.name.replace(/[<>]/g, '')}\n</context>${onScreen}\n\n${last.content}`;
        const displayTools: ToolDef[] = (input.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? '', parameters: t.parameters ?? { type: 'object', properties: {} } }));

        const ids = new Map<number, string>();
        const started = new Set<number>();
        const queue: Promise<unknown>[] = [];
        const push = (event: Record<string, unknown>) => queue.push(emit(event));
        const waiting: EffectRow[] = [];

        const result = await startRun(
          ctx,
          { kind: 'ask', attended: true, threadId, system: ASK_SYSTEM, messages, userWords, displayTools, effort: 'low' },
          {
            step: (name, done) => push({ type: done ? 'STEP_FINISHED' : 'STEP_STARTED', stepName: name }),
            text: (turn, delta) => {
              if (!delta) return;
              if (!ids.has(turn)) ids.set(turn, newId('msg'));
              if (!started.has(turn)) {
                started.add(turn);
                push({ type: 'TEXT_MESSAGE_START', messageId: ids.get(turn), role: 'assistant' });
              }
              push({ type: 'TEXT_MESSAGE_CONTENT', messageId: ids.get(turn), delta });
            },
            turn: (turn, _text, display) => {
              const messageId = ids.get(turn);
              if (started.has(turn)) push({ type: 'TEXT_MESSAGE_END', messageId });
              for (const call of display.map(sanitizeDisplayCall)) {
                push({ type: 'TOOL_CALL_START', toolCallId: call.id, toolCallName: call.name, ...(started.has(turn) ? { parentMessageId: messageId } : {}) });
                push({ type: 'TOOL_CALL_ARGS', toolCallId: call.id, delta: call.arguments || '{}' });
                push({ type: 'TOOL_CALL_END', toolCallId: call.id });
              }
            },
            waiting: (e) => waiting.push(e),
          },
        );
        await Promise.all(queue);

        // A prepared send is shown exactly as it will go out, with the buttons that decide it.
        for (const e of waiting) {
          const messageId = newId('msg');
          const mine = e.approver_route === 'user';
          await emit({ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' });
          await emit({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta: e.status === 'approved' ? 'A rule you set covers this, so it is going out.' : mine ? 'Here is the email, ready for your OK. Nothing is sent until you press Send.' : 'This needs someone else’s OK before it goes out. It is waiting in Approvals.' });
          await emit({ type: 'TEXT_MESSAGE_END', messageId });
          const callId = newId('call');
          await emit({ type: 'TOOL_CALL_START', toolCallId: callId, toolCallName: 'show_answer', parentMessageId: messageId });
          await emit({ type: 'TOOL_CALL_ARGS', toolCallId: callId, delta: JSON.stringify(approvalWidget(e)) });
          await emit({ type: 'TOOL_CALL_END', toolCallId: callId });
        }
        if (result.status === 'failed') throw new Error(result.error ?? 'Timmy couldn’t finish that.');
        await emit({ type: 'RUN_FINISHED', threadId, runId });
      } catch (e) {
        log.warn('chat run failed', { error: (e as Error).message });
        await emit({ type: 'RUN_ERROR', message: (e as Error).message });
      }
    });
  });
}
