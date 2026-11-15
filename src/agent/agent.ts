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
import { AbstractAgent, HttpAgent, type AgentConfig } from '@ag-ui/client';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
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

/** The agent for one conversation: a server agent when configured, otherwise the local one. */
export function createAgent(config: AgentConfig): AbstractAgent {
  const url = import.meta.env.VITE_TIMMY_AGENT_URL as string | undefined;
  return url ? new HttpAgent({ url, ...config }) : new LocalTimmyAgent(config);
}

export const AGENT_KIND = import.meta.env.VITE_TIMMY_AGENT_URL ? 'server' : 'local';
