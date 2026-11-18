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
import type { Ctx } from '../state/engine';
import { ctxOf, requireWorkspace, type Env } from './session';

interface AgUiMessage {
  id?: string;
  role: string;
  content?: unknown;
  toolCalls?: { id: string; function: { name: string; arguments: string } }[];
  toolCallId?: string;
}

export interface RunAgentInput {
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

/**
 * The browser sends the conversation and its widget list each time, and the server pays for every character of
 * them. So each is bounded here: how many messages, how long each may be, how much in total, and how many
 * widgets of what size. A real conversation in the app stays far inside these.
 */
const LIMITS = { messages: 40, perMessage: 8000, total: 60_000, toolCalls: 8, tools: 16, toolText: 3000 };

/** The conversation in the model's terms, newest kept when it has to be cut. */
export function history(messages: AgUiMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const cut = (v: unknown) => text(v).slice(0, LIMITS.perMessage);
  for (const m of messages.slice(-LIMITS.messages)) {
    if (m.role === 'user') out.push({ role: 'user', content: cut(m.content) });
    else if (m.role === 'assistant')
      out.push({ role: 'assistant', content: cut(m.content), toolCalls: (Array.isArray(m.toolCalls) ? m.toolCalls : []).slice(0, LIMITS.toolCalls).map((t) => ({ id: String(t.id).slice(0, 80), name: String(t.function?.name).slice(0, 80), arguments: String(t.function?.arguments ?? '').slice(0, LIMITS.perMessage) })) });
    else if (m.role === 'tool' && m.toolCallId) out.push({ role: 'tool', toolCallId: String(m.toolCallId).slice(0, 80), content: cut(m.content) });
  }
  // Oldest messages go first when the whole is too long; the question being asked is always kept.
  const size = (m: ChatMessage) => m.content.length + (m.toolCalls ?? []).reduce((n, t) => n + t.arguments.length, 0);
  let total = out.reduce((n, m) => n + size(m), 0);
  while (out.length > 1 && total > LIMITS.total) total -= size(out.shift()!);
  // A tool result is only valid right after the call it answers; drop any that lost theirs to the cuts above.
  const calls = new Set(out.flatMap((m) => m.toolCalls?.map((t) => t.id) ?? []));
  return out.filter((m) => m.role !== 'tool' || calls.has(m.toolCallId!));
}

/** The widgets the browser says it can draw: a bounded number, each with a plain name and a bounded description. */
export function displayToolsOf(tools: RunAgentInput['tools']): ToolDef[] {
  const out: ToolDef[] = [];
  for (const t of Array.isArray(tools) ? tools : []) {
    if (out.length >= LIMITS.tools) break;
    if (!t || typeof t.name !== 'string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(t.name)) continue;
    const parameters = t.parameters && typeof t.parameters === 'object' && JSON.stringify(t.parameters).length <= LIMITS.toolText ? t.parameters : { type: 'object', properties: {} };
    out.push({ name: t.name, description: String(t.description ?? '').slice(0, LIMITS.toolText), parameters });
  }
  return out;
}

/** The mail thread open in the app, from the route the browser reports. Auto mode may act on that thread only. */
function openThreadOf(route: unknown): string | undefined {
  const r = route as { view?: unknown; id?: unknown } | null | undefined;
  return r && r.view === 'thread' && typeof r.id === 'string' && r.id.length <= 200 ? r.id : undefined;
}

/** The line that introduces a prepared action in the chat: what it is and what happens next. */
function waitingLine(e: EffectRow): string {
  const mine = e.approver_route === 'user';
  if (e.kind === 'rule.save') return 'Here is the rule as I understood it. Nothing changes until you save it.';
  if (e.kind === 'mail.modify') {
    if (e.status !== 'intended') return e.approved_via === 'auto' ? 'You let Timmy decide routine filing, so it is filing this now.' : 'A rule you set covers this, so Timmy is filing it now.';
    return mine ? 'Here is the filing, ready for your OK. Nothing moves until you say so.' : 'This needs someone else’s OK. It is waiting in Approvals.';
  }
  if (e.status === 'approved') return 'A rule you set covers this, so it is going out.';
  return mine ? 'Here is the email, ready for your OK. Nothing is sent until you press Send.' : 'This needs someone else’s OK before it goes out. It is waiting in Approvals.';
}

function approvalWidget(e: EffectRow) {
  const p = e.preview;
  if (e.kind === 'rule.save') {
    return {
      preview: (p.lines ?? []).join('\n'),
      choices:
        e.status === 'intended'
          ? [
              { id: 'save', label: 'Save rule', primary: true, actions: [{ type: 'effect', id: e.id, approve: true }], after: 'Saved. Timmy sorts by it from now on; it is in Rules › Triage.' },
              { id: 'no', label: 'Not now', cancel: true, actions: [{ type: 'effect', id: e.id, approve: false }], after: 'Okay. Nothing was saved.' },
            ]
          : [],
    };
  }
  if (e.kind === 'mail.modify') {
    const undecided = e.status === 'intended' && e.approver_route === 'user';
    return {
      preview: (p.lines ?? []).join('\n'),
      choices: undecided
        ? [
            { id: 'file', label: 'File it', primary: true, actions: [{ type: 'effect', id: e.id, approve: true }], after: 'Filed, here and in your mailbox.' },
            { id: 'no', label: 'Leave it', cancel: true, actions: [{ type: 'effect', id: e.id, approve: false }], after: 'Okay. It stays where it is.' },
          ]
        : [],
    };
  }
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

/**
 * One Ask run, as AG-UI events: RUN_STARTED, steps, text as it is written, tool calls for the widgets the browser
 * draws, a prepared action with the buttons that decide it, then RUN_FINISHED or RUN_ERROR. The same run serves the
 * chat endpoint below and CopilotKit's runtime (http/copilotkit.ts); `emit` is where each event goes.
 */
export async function runAsk(ctx: Ctx, input: RunAgentInput, emit: (event: Record<string, unknown>) => Promise<unknown> | void): Promise<void> {
  const threadId = String(input.threadId ?? newId('chat'));
  const runId = String(input.runId ?? newId('agui'));
  await emit({ type: 'RUN_STARTED', threadId, runId });
  try {
    if (!ctx.rules.read) throw new Error('Your role can’t use Ask in this workspace.');
    if (!modelReady()) throw new Error('Timmy’s model isn’t configured on this server yet.');
    const messages = history(Array.isArray(input.messages) ? input.messages : []);
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user') throw new Error('Ask a question first.');
    // What changes per request rides with the question, so the cached prefix stays the same.
    // The judge is given the person's own words only, so they are taken before anything is added to the message.
    const userWords = messages.filter((m) => m.role === 'user').map((m) => m.content);
    // What is open on screen includes text other people wrote (an email's subject), so it travels as marked data.
    const screen = (Array.isArray(input.context) ? input.context : []).map((x) => `${x.description}: ${x.value}`).join('\n').slice(0, 600);
    const open = input.forwardedProps?.route ? `Open in the app: ${JSON.stringify(input.forwardedProps.route).slice(0, 300)}` : '';
    const onScreen = screen || open ? `\n${untrusted('screen', [screen, open].filter(Boolean).join('\n'))}` : '';
    last.content = `<context>\nNow: ${new Date().toISOString()}\nUser: ${ctx.user.name.replace(/[<>]/g, '')}\n</context>${onScreen}\n\n${last.content}`;
    const displayTools = displayToolsOf(input.tools);

    const ids = new Map<number, string>();
    const started = new Set<number>();
    const queue: Promise<unknown>[] = [];
    const push = (event: Record<string, unknown>) => queue.push(Promise.resolve(emit(event)));
    const waiting: EffectRow[] = [];

    const result = await startRun(
      ctx,
      { kind: 'ask', attended: true, threadId, system: ASK_SYSTEM, messages, userWords, displayTools, effort: 'low', openThreadId: openThreadOf(input.forwardedProps?.route) },
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
      await emit({ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' });
      await emit({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta: waitingLine(e) });
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
}

export function agentRoutes(app: Hono<Env>) {
  app.post('/api/v1/agent/runs', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    const input = (await c.req.json().catch(() => ({}))) as RunAgentInput;
    return streamSSE(c, async (stream) => {
      await runAsk(ctx, input, (event) => stream.writeSSE({ data: JSON.stringify(event) }));
    });
  });
}
