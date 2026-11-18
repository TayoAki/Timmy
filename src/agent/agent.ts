/*
 * Timmy as an AG-UI agent (https://docs.ag-ui.com). The page talks to it only
 * through the protocol: it sends RunAgentInput (messages, the screen you're on
 * as context, and the widget tools) and renders the events that come back:
 * RUN_STARTED, STEP_STARTED/FINISHED for the work, TEXT_MESSAGE_* for the
 * answer, TOOL_CALL_* for widgets, RUN_FINISHED.
 *
 * This preview runs the agent in the browser over the sample data. Set
 * VITE_TIMMY_AGENT_URL to an AG-UI endpoint (LangGraph, Mastra, CrewAI,
 * Pydantic AI, or your own) and the same UI talks to that agent instead.
 */
import { LIVE } from '../live/config';
import { AbstractAgent, HttpAgent, type AgentConfig } from '@ag-ui/client';
import { EventType, type BaseEvent, type Message, type RunAgentInput } from '@ag-ui/core';
import { Observable } from 'rxjs';
import type { Action, Route, State } from '../state/store';
import { plan } from './plan';

/** What the local agent can see and do in the app (set by the page). */
export const bridge: { state: () => State; route: () => Route | null; dispatch: (a: Action) => void } = {
  state: () => {
    throw new Error('Timmy agent used before the app started');
  },
  route: () => null,
  dispatch: () => undefined,
};

let seq = 0;
const id = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

/** Splits text into small pieces, as a model streams it. */
const pieces = (text: string) => text.match(/\S+\s*/g) ?? [];

export class LocalTimmyAgent extends AbstractAgent {
  constructor(config?: AgentConfig) {
    super({ agentId: 'timmy', description: 'Timmy, the inbox and workspace assistant', ...config });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((sub) => {
      const timers: number[] = [];
      let t = 0;
      const later = (ms: number, fn: () => void) => {
        t += ms;
        timers.push(window.setTimeout(fn, t));
      };
      const emit = (e: Record<string, unknown>) => sub.next(e as unknown as BaseEvent);

      const last = [...input.messages].reverse().find((m) => m.role === 'user');
      const text = typeof last?.content === 'string' ? last.content : '';
      let p;
      try {
        p = plan(bridge.state(), text, bridge.route());
      } catch (err) {
        emit({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
        emit({ type: EventType.RUN_ERROR, message: err instanceof Error ? err.message : String(err) });
        sub.complete();
        return () => undefined;
      }

      emit({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
      for (const step of p.steps) {
        later(140, () => emit({ type: EventType.STEP_STARTED, stepName: step }));
        later(380, () => emit({ type: EventType.STEP_FINISHED, stepName: step }));
      }
      if (p.effects?.length) later(0, () => p.effects!.forEach((a) => bridge.dispatch(a)));

      const messageId = id('msg');
      later(60, () => emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' }));
      for (const piece of pieces(p.text)) later(22, () => emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: piece }));
      later(20, () => emit({ type: EventType.TEXT_MESSAGE_END, messageId }));

      for (const call of p.calls) {
        const toolCallId = id('call');
        later(90, () => {
          emit({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName: call.name, parentMessageId: messageId });
          emit({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(call.args) });
          emit({ type: EventType.TOOL_CALL_END, toolCallId });
        });
      }
      later(40, () => {
        emit({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId });
        sub.complete();
      });
      return () => timers.forEach((x) => window.clearTimeout(x));
    });
  }
}

/** Where Timmy's API serves Ask through CopilotKit's runtime (server/src/http/copilotkit.ts). */
export const COPILOTKIT_URL = '/api/copilotkit';

/**
 * Timmy through CopilotKit, on a real workspace. CopilotKit's client (@copilotkit/core) is loaded when the first
 * question is asked, so the demo never downloads it. It asks the runtime how conversations are kept: in the server's
 * memory, or in CopilotKit Intelligence, where a run's events come back over CopilotKit's realtime connection. Either
 * way this agent hands back the same AG-UI events the chat already draws.
 */
export class CopilotKitTimmyAgent extends AbstractAgent {
  private inner?: Promise<AbstractAgent>;

  constructor(config?: AgentConfig) {
    super({ agentId: 'timmy', description: 'Timmy, the inbox and workspace assistant', ...config });
  }

  private load(): Promise<AbstractAgent> {
    this.inner ??= import('@copilotkit/core').then(
      ({ ProxiedCopilotRuntimeAgent }) => new ProxiedCopilotRuntimeAgent({ runtimeUrl: COPILOTKIT_URL, agentId: 'timmy', credentials: 'same-origin', threadId: this.threadId }) as unknown as AbstractAgent,
    );
    return this.inner;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((sub) => {
      let inner: { unsubscribe(): void } | undefined;
      let gone = false;
      Promise.all([this.load(), threadUuid(input.threadId)])
        .then(([agent, threadId]) => {
          if (gone) return;
          agent.threadId = threadId;
          // The runtime's agent takes the run as it is: the messages, the widgets, the screen, the route.
          inner = (agent as unknown as { run(i: RunAgentInput): Observable<BaseEvent> }).run({ ...input, threadId }).subscribe(sub);
        })
        .catch((e) => sub.error(e));
      return () => {
        gone = true;
        inner?.unsubscribe();
      };
    });
  }
}

/**
 * A conversation saved in CopilotKit Intelligence, read back the way CopilotKit reconnects one: the runtime hands the
 * browser a pass to the conversation's realtime channel, and what was said is replayed from there.
 */
export async function replaySaved(threadId: string): Promise<Message[]> {
  const { ProxiedCopilotRuntimeAgent } = await import('@copilotkit/core');
  const agent = new ProxiedCopilotRuntimeAgent({ runtimeUrl: COPILOTKIT_URL, agentId: 'timmy', credentials: 'same-origin', threadId }) as unknown as AbstractAgent;
  await agent.connectAgent();
  return [...agent.messages];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * CopilotKit Intelligence names a conversation by a UUID. A conversation's own id ("chat-…") is turned into one the
 * same way every time, so the same conversation always reaches the same thread.
 */
export async function threadUuid(id: string): Promise<string> {
  if (UUID.test(id)) return id.toLowerCase();
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`timmy-thread:${id}`))).slice(0, 16);
  hash[6] = (hash[6]! & 0x0f) | 0x50; // version 5 style: derived from a name
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = [...hash].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The agent for one conversation: Timmy through CopilotKit on a real workspace, a configured server, or the local one. */
export function createAgent(config: AgentConfig): AbstractAgent {
  // On a real workspace the chat talks to Timmy's own API, on the same origin, so the sign-in cookie goes with it.
  if (LIVE) return new CopilotKitTimmyAgent(config);
  const url = import.meta.env.VITE_TIMMY_AGENT_URL as string | undefined;
  return url ? new HttpAgent({ url, ...config }) : new LocalTimmyAgent(config);
}

export const AGENT_KIND: 'copilotkit' | 'server' | 'local' = LIVE ? 'copilotkit' : import.meta.env.VITE_TIMMY_AGENT_URL ? 'server' : 'local';
