/**
 * Timmy's Ask, served through CopilotKit's runtime (@copilotkit/runtime, v2) at /api/copilotkit. The browser's chat
 * talks to it with CopilotKit's own client (src/agent/agent.ts), and the runtime runs Timmy's agent in this process:
 * the same run as the plain chat endpoint (runAsk in http/agent.ts), with the same person, workspace, role, budget,
 * tools and approval gateway. CopilotKit carries the conversation; it decides nothing.
 *
 * Two modes, chosen by the server's configuration:
 *   - Without CPK_INTELLIGENCE_API_KEY, conversations stay in this process (CopilotKit's in-memory runner), each
 *     belonging to the person whose request started it.
 *   - With it, CopilotKit Intelligence (CopilotKit's cloud) keeps each conversation, its messages and every tool call
 *     with its arguments and results, so it follows the person to another device and shows in CopilotKit's
 *     analytics. Threads are scoped per person by `identifyUser`. Memory and learned skills stay off: Timmy has its own
 *     memory (rules, projects, the map of people), and two would disagree.
 *
 * CopilotKit's own usage telemetry is switched off (lib/no-telemetry.ts and the Dockerfile).
 */
import '../lib/no-telemetry';
import { AbstractAgent, type RunAgentInput as AgUiRunInput } from '@ag-ui/client';
import type { BaseEvent } from '@ag-ui/core';
import { CopilotKitIntelligence, CopilotRuntime, createCopilotHonoHandler, type CopilotRuntimeUser } from '@copilotkit/runtime/v2';
import type { Hono } from 'hono';
import { Observable } from 'rxjs';
import { membership } from '../auth/members';
import { rulesFor } from '../auth/roles';
import { config } from '../config';
import { log } from '../lib/log';
import type { Ctx } from '../state/engine';
import { runAsk, type RunAgentInput } from './agent';
import { requireWorkspace, sessionOf, type Env } from './session';

export const COPILOTKIT_PATH = '/api/copilotkit';
export const AGENT_ID = 'timmy';

/** The person and workspace a request is from, as requireWorkspace finds them. Null when it is from nobody. */
async function ctxFor(request: Request): Promise<Ctx | null> {
  const s = await sessionOf(request.headers);
  if (!s?.activeWorkspaceId) return null;
  const role = await membership(s.user.id, s.activeWorkspaceId);
  if (!role) return null;
  return { user: s.user, workspaceId: s.activeWorkspaceId, role, rules: rulesFor(role) };
}

/** Timmy's agent as an AG-UI agent for one request: it runs Ask as the person the request is from. */
export class TimmyAgent extends AbstractAgent {
  constructor(private readonly ctx: Ctx | null) {
    super({ agentId: AGENT_ID, description: 'Timmy: your mail, files, projects and to-dos' });
  }

  run(input: AgUiRunInput): Observable<BaseEvent> {
    const ctx = this.ctx;
    return new Observable<BaseEvent>((sub) => {
      let open = true;
      const emit = (event: Record<string, unknown>) => {
        if (open) sub.next(event as unknown as BaseEvent);
      };
      (async () => {
        if (!ctx) {
          emit({ type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId });
          emit({ type: 'RUN_ERROR', message: 'Sign in first.' });
          return;
        }
        await runAsk(ctx, input as unknown as RunAgentInput, emit);
      })()
        .catch((e) => emit({ type: 'RUN_ERROR', message: (e as Error).message }))
        .finally(() => {
          if (open) sub.complete();
        });
      return () => {
        open = false;
      };
    });
  }

  /** The runtime clones the agent for each run; the clone runs as the same person. */
  clone(): TimmyAgent {
    const copy = new TimmyAgent(this.ctx);
    copy.threadId = this.threadId;
    copy.setMessages([...this.messages]);
    copy.setState(this.state);
    return copy;
  }
}

/** Whether conversations are kept in CopilotKit's cloud (Intelligence) on this server. */
export const intelligenceOn = () => !!config.copilotkit.intelligenceKey;

let handler: ReturnType<typeof createCopilotHonoHandler> | null = null;

function copilotHandler() {
  if (handler) return handler;
  const agents = async ({ request }: { request: Request }) => ({ [AGENT_ID]: new TimmyAgent(await ctxFor(request)) });
  // Each conversation belongs to the person whose request started it; nobody else can list, read or continue it.
  const identifyUser = async (request: Request): Promise<CopilotRuntimeUser> => {
    const s = await sessionOf(request.headers);
    if (!s) throw new Error('Sign in first.');
    // A person's conversations are theirs within one workspace: the same person in another workspace starts afresh.
    return { id: `${s.user.id}:${s.activeWorkspaceId ?? 'none'}`, name: s.user.name };
  };
  const runtime = intelligenceOn()
    ? new CopilotRuntime({
        agents,
        identifyUser,
        intelligence: new CopilotKitIntelligence({ apiKey: config.copilotkit.intelligenceKey }),
        // A conversation is named after the person's first question, with no model call.
        generateThreadNames: true,
        telemetryProperties: { product: 'timmy' },
      })
    : new CopilotRuntime({ agents, identifyUser, telemetryProperties: { product: 'timmy' } });
  handler = createCopilotHonoHandler({ runtime, basePath: COPILOTKIT_PATH, cors: { origin: config.publicUrl, credentials: true } });
  log.info('CopilotKit runtime ready', { intelligence: intelligenceOn() });
  return handler;
}

export function copilotKitRoutes(app: Hono<Env>) {
  // Signed in and in a workspace, like every other part of the app, before CopilotKit sees the request.
  app.all(`${COPILOTKIT_PATH}/*`, requireWorkspace, (c) => copilotHandler().fetch(c.req.raw));
  app.all(COPILOTKIT_PATH, requireWorkspace, (c) => copilotHandler().fetch(c.req.raw));
}

/** For tests: start again with the configuration as it now is. */
export function resetCopilotKit() {
  handler = null;
}
